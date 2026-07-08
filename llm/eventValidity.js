/* eslint-disable */
// =============================================================================
// NWST Event Validity Review — llm/eventValidity.js
// =============================================================================
// Runs on day advancement. Asks the Planning LLM one narrow question about
// each active event: "has the story made this event's premise impossible or
// moot?" Findings only FLAG events for the player's decision in the Events tab
// — nothing is ever removed automatically.
//
// Design rules (from the Taro case that motivated this):
//   • Temporary setbacks do NOT invalidate. A character being arrested (bail
//     likely), injured, or out of town does not kill an event built on their
//     behavior — they have free will and stories bend. Only flag when the
//     premise is clearly IMPOSSIBLE or MOOT going forward.
//   • The player decides. A flag renders in the Events tab with the reason and
//     Keep / Mark missed buttons. "Keep" clears the flag; "Mark missed" uses
//     the existing missed→compaction lifecycle, so nothing is deleted.
//   • No work, no call. If there are no active events or the toggle is off,
//     no API call happens.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { getActiveEvents, updateEvent } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { getCurrentDay } from '../data/worldState.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { getSetting } from '../index.js';
import { dlog } from '../lib/debug.js';

const VALIDITY_SYSTEM_PROMPT = `You review a roleplay's upcoming/ongoing events after the story advanced to a new day. Your ONLY job: identify events whose premise has become IMPOSSIBLE or MOOT because of what happened in the story. Return JSON only.

WHAT COUNTS AS INVALIDATED (flag it):
- The event depends on a character who is now permanently unavailable (dead, permanently imprisoned with no prospect of release, left the story for good).
- The event's premise already happened or was definitively prevented (the meeting it predicts occurred; the threat it tracks was neutralized for good).
- The event is now logically impossible (the location was destroyed, the deadline it references was resolved on-screen).

WHAT DOES NOT COUNT (do NOT flag):
- Temporary setbacks. A character arrested but likely to make bail, injured, traveling, or lying low can still drive their events. When their return is plausible, the event stands.
- Uncertainty. If you cannot tell from the story state whether the premise still holds, leave it alone.
- Tone shifts, delays, or the event merely becoming less likely. Less likely is not moot.

Characters have free will and stories bend around obstacles. Flag ONLY clear structural impossibility. An empty findings array is the expected result most days.

OUTPUT (JSON only, no markdown fences, no commentary):
{
  "findings": [
    { "eventTitle": "exact event title as given", "reason": "one sentence: what makes this premise impossible or moot now" }
  ]
}`;

function buildValidityPrompt(events, notebook, recentMessages, dayLabel) {
    let p = `The story has just advanced to: ${dayLabel || 'a new day'}.\n\n`;

    p += `=== ACTIVE EVENTS TO REVIEW (${events.length}) ===\n`;
    for (const ev of events) {
        p += `---\n`;
        p += `Title: ${ev.title}\n`;
        if (ev.description) p += `Description: ${ev.description}\n`;
        if (ev.participants && ev.participants.length) p += `Participants: ${ev.participants.join(', ')}\n`;
        if (ev.scheduledDate) p += `Scheduled: ${ev.scheduledDate}\n`;
        p += `Status: ${ev.status} | Tier: ${ev.tier}\n`;
    }
    p += '\n';

    const core = notebook?.core || {};
    const mystery = notebook?.mystery || {};
    p += `=== CURRENT STORY STATE (from the notebook) ===\n`;
    const sections = [
        ['Established facts', mystery.establishedFacts],
        ['Character whereabouts', mystery.characterWhereabouts],
        ['Offscreen pressures', core.offscreenPressure],
        ['Unresolved threads', core.unresolvedDetail]
    ];
    for (const [label, bullets] of sections) {
        if (Array.isArray(bullets) && bullets.length > 0) {
            p += `${label}:\n`;
            for (const b of bullets) p += `  - ${b}\n`;
        }
    }
    p += '\n';

    if (recentMessages.length > 0) {
        p += `=== MOST RECENT MESSAGES (for freshness) ===\n`;
        for (const msg of recentMessages) {
            const sender = msg.name || (msg.is_user ? 'User' : 'Character');
            p += `[${sender}]: ${msg.mes}\n`;
        }
        p += '\n';
    }

    p += `Review each event against the story state. Flag ONLY clear structural impossibility. Return the findings JSON.`;
    return p;
}

function parseValidityFindings(response) {
    let s = (response || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const obj = s.match(/\{[\s\S]*\}/);
    if (obj) s = obj[0];
    try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed.findings) ? parsed.findings : [];
    } catch (e) {
        dlog('[NWST EventValidity] Unparseable response — skipping review this cycle.');
        return null;
    }
}

function getRecentVisibleMessages(limit = 10) {
    try {
        const ctx = SillyTavern.getContext();
        return (ctx.chat || [])
            .filter(m => m && m.mes && !m.is_system)
            .slice(-limit);
    } catch (e) { return []; }
}

/**
 * Review active events for narrative validity after a day advancement.
 * Flags invalidated events for player review; never removes anything.
 * @param {string} chatId
 * @returns {Promise<number>} how many events were flagged
 */
export async function runEventValidityReview(chatId) {
    if (!chatId) chatId = getChatId();
    if (!chatId) return 0;

    // Toggle (default ON) — and no work means no API call.
    if (getSetting('eventValidityReview') === false) return 0;

    try {
        // Only pending/inprogress events can be meaningfully invalidated.
        const active = getActiveEvents(chatId).filter(
            ev => ev.status === 'pending' || ev.status === 'inprogress'
        );
        if (active.length === 0) return 0;

        const profile = resolveProfile('planningLLM');
        if (!profile) {
            dlog('[NWST EventValidity] No Planning LLM profile — skipping review.');
            return 0;
        }

        const notebook = getNotebook(chatId);
        const recent = getRecentVisibleMessages(10);
        const day = getCurrentDay(chatId);
        const dayLabel = day?.dateDisplay || `Day ${day?.dayCount ?? '?'}`;

        const messages = [
            { role: 'system', content: VALIDITY_SYSTEM_PROMPT },
            { role: 'user', content: buildValidityPrompt(active, notebook, recent, dayLabel) }
        ];

        dlog(`[NWST EventValidity] Reviewing ${active.length} active event(s)...`);
        const response = await generateWithProfile(profile, messages);
        const findings = parseValidityFindings(response);
        if (!findings || findings.length === 0) {
            dlog('[NWST EventValidity] No invalidated events.');
            return 0;
        }

        let flagged = 0;
        for (const f of findings) {
            if (!f || typeof f.eventTitle !== 'string' || !f.reason) continue;
            const t = f.eventTitle.toLowerCase().trim();
            const ev = active.find(e => (e.title || '').toLowerCase().trim() === t);
            if (!ev) {
                dlog(`[NWST EventValidity] Finding references unknown event "${f.eventTitle}" — skipped.`);
                continue;
            }
            if (ev.validityFlag) continue; // already awaiting the player's decision
            await updateEvent(chatId, ev.id, {
                validityFlag: {
                    reason: String(f.reason).slice(0, 300),
                    flaggedOn: dayLabel,
                    ts: Date.now()
                }
            });
            flagged++;
        }

        if (flagged > 0) {
            nwstToast(
                `Day advance: ${flagged} event(s) may no longer make sense — review them in the Events tab.`,
                'warning'
            );
            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('events');
        }
        return flagged;

    } catch (err) {
        console.error('[NWST EventValidity] Review failed:', err);
        return 0;
    }
}
