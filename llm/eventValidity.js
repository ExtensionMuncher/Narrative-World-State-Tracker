/* eslint-disable */
// =============================================================================
// NWST Day-Advance Event Review — llm/eventValidity.js
// =============================================================================
// Runs on day advancement (after the structural event-horizon roll). One
// Planning LLM call performs four narrow review jobs:
//
//   1. VALIDITY — has the story made an active event's premise impossible or
//      moot? Findings only FLAG events for the player's Keep / Mark-resolved / Mark-missed
//      decision in the Events tab — nothing is removed automatically.
//   2. TIER PLACEMENT — for active events WITHOUT a parseable scheduled date
//      (which the structural roll cannot move), suggest the tier that matches
//      the story's current urgency. Applied directly; tiers are low-stakes and
//      remain editable in the Events tab.
//   3. TIMING CRYSTALLIZATION — undetermined events are deliberately timeless
//      and never auto-re-tiered, but when the story has FIXED one's timing
//      (a stated date, a countdown, a scheduled confrontation), the review
//      proposes a placement. Proposals are QUEUED as cards; only the player's
//      Accept moves the event out of undetermined. Dismissed proposals are
//      not re-raised for ~7 story days.
//   4. PROMOTION CANDIDATES — among concluded (resolved/missed) events, flag
//      those whose outcome constitutes CONCEALED KNOWLEDGE — information some
//      characters hold that others don't. Candidates are QUEUED in the Events
//      tab for the player's Promote / Don't-promote decision; either choice
//      removes the concluded event and keeps a summary in the notebook.
//
// Design rules (motivated by a real invalidation case):
//   • Temporary setbacks do NOT invalidate. A character being arrested (bail
//     likely), injured, or out of town does not kill an event built on their
//     behavior — they have free will and stories bend. Only flag when the
//     premise is clearly IMPOSSIBLE or MOOT going forward.
//   • The player decides anything destructive. Validity flags and promotion
//     candidates both render as review cards; only tier placement (freely
//     reversible) is applied without asking.
//   • No work, no call. If there is nothing reviewable or the toggle is off,
//     no API call happens.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { getAllEvents, getActiveEvents, updateEvent, getStructuralTierForScheduledDate } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { getCurrentDay } from '../data/worldState.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { LLM_TOKEN_BUDGETS } from './tokenBudgets.js';
import { getSetting } from '../index.js';
import { dlog } from '../lib/debug.js';

const REVIEW_SYSTEM_PROMPT = `You review a roleplay's tracked events after the story advanced to a new day. You have exactly four jobs. Return JSON only.

JOB 1 — VALIDITY (active events): identify events whose premise has become IMPOSSIBLE or MOOT because of what happened in the story.
WHAT COUNTS AS INVALIDATED (flag it):
- The event depends on a character who is now permanently unavailable (dead, permanently imprisoned with no prospect of release, left the story for good).
- The event's premise already happened or was definitively prevented (the meeting it predicts occurred; the threat it tracks was neutralized for good).
- The event is now logically impossible (the location was destroyed, the deadline it references was resolved on-screen).
WHAT DOES NOT COUNT (do NOT flag):
- Temporary setbacks. A character arrested but likely to make bail, injured, traveling, or lying low can still drive their events. When their return is plausible, the event stands.
- Uncertainty. If you cannot tell from the story state whether the premise still holds, leave it alone.
- Tone shifts, delays, or the event merely becoming less likely. Less likely is not moot.
Characters have free will and stories bend around obstacles. Flag ONLY clear structural impossibility. An empty findings array is the expected result most days.

JOB 2 — TIER PLACEMENT (only the events listed under UNDATED EVENTS): these have no parseable scheduled date, so the calendar cannot place them. Based on the story's current pressure, suggest the tier that fits: "immediate" (happening today or tomorrow), "week" (before the current weekday cycle ends), or "month" (later in the current calendar month). Only suggest a change when the story makes the urgency clear — if unsure, leave the event alone. Events in the "undetermined" tier are deliberately timeless and are not shown to you here — never suggest "undetermined" as a tier, and never expect to move events out of it.
STALENESS RULE: each event lists how long it has sat in its current tier. An undated event stuck in the "week" tier for more than 7 story days, or in the "month" tier for more than 30, is overdue — adjudicate it: re-tier it to match the story's current pressure, or, if its moment has clearly already passed or can no longer happen, report it under Job 1 findings instead so the player decides. Do not leave a stale event untouched unless the story genuinely gives no signal either way.

JOB 3 — TIMING CRYSTALLIZATION (only the events listed under UNDETERMINED EVENTS): these are deliberately timeless — do NOT re-tier them yourself and do NOT include them in Job 2. But if the story has now FIXED when one will occur — a stated date, a countdown, a scheduled meeting or confrontation — propose its placement: the tier that fits ("immediate", "week", or "month") and, when computable from the story, the day in "Day N" format (otherwise null). Only propose when the story explicitly establishes timing; vague momentum or rising tension is NOT timing. An empty array is the expected result most days.

JOB 4 — PROMOTION CANDIDATES (only the events listed under CONCLUDED EVENTS): these are already resolved or missed. Flag the ones whose outcome constitutes CONCEALED KNOWLEDGE — information some characters now hold that others don't: a hidden resolution, a private deal, a covert act, an outcome deliberately kept from someone. Do NOT flag events whose outcome is public or common knowledge among the cast. For each candidate give one sentence naming what is concealed and from whom.

OUTPUT (JSON only, no markdown fences, no commentary — all four arrays required, empty when nothing qualifies):
{
  "findings": [
    { "eventTitle": "exact event title as given", "reason": "one sentence: what makes this premise impossible or moot now" }
  ],
  "tierSuggestions": [
    { "eventTitle": "exact event title as given", "tier": "immediate" }
  ],
  "timingProposals": [
    { "eventTitle": "exact event title as given", "tier": "week", "scheduledDate": "Day 14", "reason": "one sentence: what in the story fixed this timing" }
  ],
  "secretCandidates": [
    { "eventTitle": "exact event title as given", "reason": "one sentence: what is concealed and from whom" }
  ]
}`;

function describeEvent(ev, elapsedStoryDays) {
    let p = `---\n`;
    p += `Title: ${ev.title}\n`;
    if (ev.description) p += `Description: ${ev.description}\n`;
    if (ev.participants && ev.participants.length) p += `Participants: ${ev.participants.join(', ')}\n`;
    if (ev.scheduledDate) p += `Scheduled: ${ev.scheduledDate}\n`;
    p += `Status: ${ev.status} | Tier: ${ev.tier}\n`;
    // In-tier age gives the reviewer a staleness signal for undated events.
    if (typeof ev.tierSetElapsedDay === 'number' && typeof elapsedStoryDays === 'number' && elapsedStoryDays >= ev.tierSetElapsedDay) {
        p += `In current tier for ${elapsedStoryDays - ev.tierSetElapsedDay} story day(s)\n`;
    }
    return p;
}

function buildReviewPrompt(active, undated, undetermined, concluded, notebook, recentMessages, dayLabel, elapsedStoryDays) {
    let p = `The story has just advanced to: ${dayLabel || 'a new day'}.\n\n`;

    p += `=== ACTIVE EVENTS TO REVIEW FOR VALIDITY (${active.length}) ===\n`;
    for (const ev of active) p += describeEvent(ev, elapsedStoryDays);
    p += '\n';

    if (undated.length > 0) {
        p += `=== UNDATED EVENTS — SUGGEST TIER PLACEMENT (${undated.length}) ===\n`;
        p += `(these have no scheduled date; place them by narrative urgency)\n`;
        for (const ev of undated) p += describeEvent(ev, elapsedStoryDays);
        p += '\n';
    }

    if (undetermined.length > 0) {
        p += `=== UNDETERMINED EVENTS — TIMING CRYSTALLIZATION ONLY (${undetermined.length}) ===\n`;
        p += `(deliberately timeless; propose a placement ONLY if the story has explicitly fixed when one occurs)\n`;
        for (const ev of undetermined) p += describeEvent(ev, elapsedStoryDays);
        p += '\n';
    }

    if (concluded.length > 0) {
        p += `=== CONCLUDED EVENTS — ASSESS FOR CONCEALED KNOWLEDGE (${concluded.length}) ===\n`;
        for (const ev of concluded) p += describeEvent(ev, elapsedStoryDays);
        p += '\n';
    }

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

    p += `Perform all four review jobs against the story state. Return the JSON.`;
    return p;
}

function parseReviewResponse(response) {
    let s = (response || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const obj = s.match(/\{[\s\S]*\}/);
    if (obj) s = obj[0];
    try {
        const parsed = JSON.parse(s);
        return {
            findings: Array.isArray(parsed.findings) ? parsed.findings : [],
            tierSuggestions: Array.isArray(parsed.tierSuggestions) ? parsed.tierSuggestions : [],
            timingProposals: Array.isArray(parsed.timingProposals) ? parsed.timingProposals : [],
            secretCandidates: Array.isArray(parsed.secretCandidates) ? parsed.secretCandidates : []
        };
    } catch (e) {
        dlog('[NWST EventReview] Unparseable response — skipping review this cycle.');
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

// Matches dayAdvancement's structural-roll parsing closely enough to decide
// whether an event's date is machine-placeable: "Day 12", "Day 10-14", or a
// numbered literal date. Undated (or unparseable) events go to the LLM.
function hasParseableDate(ev) {
    const sd = ev.scheduledDate;
    if (!sd || typeof sd !== 'string') return false;
    if (/Day\s*\d+/i.test(sd)) return true;
    if (/\d/.test(sd)) return true; // literal calendar dates carry a day number
    return false;
}

const VALID_SUGGESTED_TIERS = ['immediate', 'week', 'month'];

/**
 * Review events after a day advancement: validity flags (queued), tier
 * placement for undated events (applied), and concealed-knowledge promotion
 * candidates among concluded events (queued). One Planning LLM call total;
 * skipped entirely when there is nothing to review.
 * @param {string} chatId
 * @returns {Promise<number>} how many events were flagged or adjusted
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
        // Undated actives are the tier-placement candidates (unflagged only).
        // The undetermined tier is excluded by design: those events are
        // deliberately timeless and are never re-tiered by automation.
        const undated = active.filter(ev => !hasParseableDate(ev) && ev.tier !== 'undetermined' && !ev.validityFlag && !ev.promotionFlag && !ev.timingFlag);
        // Undetermined actives are timing-crystallization candidates — one
        // pending card per event, and dismissals rest for ~7 story days.
        const elapsedNow = (() => { const d = getCurrentDay(chatId); return (d && Number.isInteger(d.elapsedStoryDays)) ? d.elapsedStoryDays : 0; })();
        const undeterminedCandidates = active.filter(ev =>
            ev.tier === 'undetermined'
            && !ev.validityFlag && !ev.promotionFlag && !ev.timingFlag
            && !(typeof ev.timingDismissedElapsedDay === 'number' && (elapsedNow - ev.timingDismissedElapsedDay) < 7));
        // Concluded, unpromoted, undecided events are the promotion candidates.
        // Gated by the autoPromoteEvents toggle (repurposed from the old silent
        // auto-promotion path into this queued, player-decided review).
        const promotionAssessmentOn = getSetting('autoPromoteEvents') !== false;
        const concluded = promotionAssessmentOn
            ? getAllEvents(chatId).filter(ev =>
                (ev.status === 'resolved' || ev.status === 'missed')
                && !ev.promotedSecretId
                && !ev.promotionFlag)
            : [];

        if (active.length === 0 && concluded.length === 0) return 0;

        const profile = resolveProfile('planningLLM');
        if (!profile) {
            dlog('[NWST EventReview] No Planning LLM profile — skipping review.');
            return 0;
        }

        const notebook = getNotebook(chatId);
        const recent = getRecentVisibleMessages(10);
        const day = getCurrentDay(chatId);
        const dayLabel = day?.dateDisplay || `Day ${day?.dayCount ?? '?'}`;

        const messages = [
            { role: 'system', content: REVIEW_SYSTEM_PROMPT },
            { role: 'user', content: buildReviewPrompt(active, undated, undeterminedCandidates, concluded, notebook, recent, dayLabel, (Number.isInteger(day?.elapsedStoryDays) ? day.elapsedStoryDays : 0)) }
        ];

        dlog(`[NWST EventReview] Reviewing ${active.length} active, ${undated.length} undated, ${concluded.length} concluded event(s)...`);
        const response = await generateWithProfile(profile, messages, { maxTokens: LLM_TOKEN_BUDGETS.MEDIUM });
        if (getChatId() !== chatId) {
            dlog('[NWST EventReview] Discarded stale review result because the active chat changed.');
            return 0;
        }
        const parsed = parseReviewResponse(response);
        if (!parsed) return 0;

        const byTitle = (list, title) => {
            const t = String(title || '').toLowerCase().trim();
            return list.find(e => (e.title || '').toLowerCase().trim() === t) || null;
        };

        // ── Job 1: validity flags (queued for Keep / Mark resolved / Mark missed) ──────────
        let flagged = 0;
        for (const f of parsed.findings) {
            if (!f || typeof f.eventTitle !== 'string' || !f.reason) continue;
            const ev = byTitle(active, f.eventTitle);
            if (!ev) {
                dlog(`[NWST EventReview] Validity finding references unknown event "${f.eventTitle}" — skipped.`);
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

        // ── Job 2: tier placement for undated events (applied directly) ────
        let retiered = 0;
        for (const t of parsed.tierSuggestions) {
            if (!t || typeof t.eventTitle !== 'string') continue;
            if (!VALID_SUGGESTED_TIERS.includes(t.tier)) continue;
            const ev = byTitle(undated, t.eventTitle);
            if (!ev || ev.tier === t.tier) continue;
            await updateEvent(chatId, ev.id, { tier: t.tier });
            dlog(`[NWST EventReview] Undated event "${ev.title}" placed in tier: ${t.tier}`);
            retiered++;
        }

        // ── Job 3: timing proposals (queued for Accept / Dismiss) ──────────
        const VALID_TIMING_TIERS = ['immediate', 'week', 'month'];
        let timingQueued = 0;
        for (const t of parsed.timingProposals) {
            if (!t || typeof t.eventTitle !== 'string' || !t.reason) continue;
            if (!VALID_TIMING_TIERS.includes(t.tier)) continue;
            const ev = byTitle(undeterminedCandidates, t.eventTitle);
            if (!ev) {
                dlog(`[NWST EventReview] Timing proposal references unknown event "${t.eventTitle}" — skipped.`);
                continue;
            }
            const scheduledDate = (typeof t.scheduledDate === 'string' && t.scheduledDate.trim()) ? t.scheduledDate.trim().slice(0, 60) : null;
            let proposedTier = t.tier;
            if (scheduledDate) {
                const structural = getStructuralTierForScheduledDate(chatId, scheduledDate);
                if (structural.tier && structural.tier !== 'missed') proposedTier = structural.tier;
            }
            await updateEvent(chatId, ev.id, {
                timingFlag: {
                    tier: proposedTier,
                    scheduledDate,
                    reason: String(t.reason).slice(0, 300),
                    flaggedOn: dayLabel,
                    ts: Date.now()
                }
            });
            timingQueued++;
        }

        // ── Job 4: promotion candidates (queued for Promote / Don't) ───────
        let queued = 0;
        for (const c of parsed.secretCandidates) {
            if (!c || typeof c.eventTitle !== 'string' || !c.reason) continue;
            const ev = byTitle(concluded, c.eventTitle);
            if (!ev) {
                dlog(`[NWST EventReview] Promotion candidate references unknown event "${c.eventTitle}" — skipped.`);
                continue;
            }
            await updateEvent(chatId, ev.id, {
                promotionFlag: {
                    reason: String(c.reason).slice(0, 300),
                    flaggedOn: dayLabel,
                    ts: Date.now()
                }
            });
            queued++;
        }

        const total = flagged + retiered + queued + timingQueued;
        if (flagged > 0 || queued > 0 || timingQueued > 0) {
            const parts = [];
            if (flagged > 0) parts.push(`${flagged} event(s) may no longer make sense`);
            if (timingQueued > 0) parts.push(`${timingQueued} undetermined event(s) may have found their timing`);
            if (queued > 0) parts.push(`${queued} concluded event(s) may hold concealed knowledge`);
            nwstToast(`Day advance: ${parts.join('; ')} — review them in the Events tab.`, 'warning');
        }
        if (total > 0 && typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('events');
        return total;

    } catch (err) {
        console.error('[NWST EventReview] Review failed:', err);
        return 0;
    }
}
