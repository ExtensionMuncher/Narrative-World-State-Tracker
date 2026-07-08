/* eslint-disable */
// =============================================================================
// NWST Narrative Consistency — llm/narrativeConsistency.js
// =============================================================================
// NARRATIVE CONSISTENCY CHECK (scan-cadence, REQUIRES API call):
//    - Runs every N messages on the scanner cadence, and on demand via the
//      "Consistency scan" debug button (visible messages only).
//    - Uses the Narrative Consistency LLM connection profile.
//    - Reviews recent chat against every secret and returns STRUCTURED findings
//      that actually update the secrets:
//        * knowledge_change — a character learned a secret → they are moved
//          from whoDoesNotKnow to whoKnows automatically (with a toast).
//        * revealed — a secret was fully revealed on-screen → flagged into the
//          existing pending-archive review queue (player approves/rejects).
//        * contradiction — the prose contradicts the secret's content → noted
//          in the Inconsistencies field (secret text is never auto-rewritten).
//
// The old version only wrote free-text notes and never touched secrets. It was
// also broken: it referenced a system prompt constant that no longer existed,
// so every run crashed silently inside its try/catch.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import {
    getAllSecrets, addMysteryBullet, updateSecret,
    flagSecretForArchive, getSecretStatus
} from '../data/notebook.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { isEnabled, isPaused } from '../settings.js';
import { dlog } from "../lib/debug.js";

const CONSISTENCY_SYSTEM_PROMPT = `You audit a roleplay's hidden-knowledge state. You are given the recent messages and the full list of tracked secrets (each with who knows it and who must not know it). Compare the prose against the knowledge state and report ONLY genuine findings as JSON.

FINDING TYPES:
- "knowledge_change": a character who was in "Who Does NOT Know" has now LEARNED the secret in the prose (they were told, they discovered evidence and understood it, they witnessed it). Name exactly who learned it.
- "revealed": the secret is now fully out in the open — revealed on-screen to the key unaware parties, no longer functioning as a secret.
- "contradiction": the recent prose states something that CONTRADICTS the secret's recorded content (e.g. the secret says X but the story now establishes not-X).

RULES:
- Be conservative. A character SUSPECTING something is NOT a knowledge_change. A near-miss or partial glimpse is NOT a reveal. Only report what the prose clearly establishes.
- A character acting oddly is not evidence they know. Require an actual on-page moment of learning.
- Use each secret's EXACT title as given, so it can be matched.
- If there are no genuine findings, return an empty array.

OUTPUT (JSON only, no markdown fences, no commentary):
{
  "findings": [
    { "type": "knowledge_change", "secretTitle": "exact title", "charactersWhoLearned": ["Name"], "detail": "one sentence: how they learned it" },
    { "type": "revealed", "secretTitle": "exact title", "detail": "one sentence: how it was revealed" },
    { "type": "contradiction", "secretTitle": "exact title", "detail": "one sentence: what contradicts what" }
  ]
}`;

/**
 * Run the narrative consistency check via the Narrative Consistency LLM.
 * Called by the scanner on its cadence, and manually by the debug button.
 *
 * @param {object} [options]
 * @param {boolean} [options.visibleOnly=false] - Only read messages currently
 *        visible in the chat (excludes /hide-hidden and system messages).
 * @param {boolean} [options.manual=false] - Manual run: always toasts a result
 *        summary, even when nothing was found.
 * @returns {Promise<{ran:boolean, knowledgeChanges:number, reveals:number, contradictions:number}>}
 */
export async function runConsistencyCheck(options = {}) {
    const summary = { ran: false, knowledgeChanges: 0, reveals: 0, contradictions: 0 };
    if (!isEnabled() || isPaused()) return summary;
    const chatId = getChatId();
    if (!chatId) return summary;

    try {
        const profile = resolveProfile('narrativeConsistencyLLM');
        if (!profile) {
            dlog('[NWST NarrativeConsistency] No Narrative Consistency profile configured — skipping check.');
            if (options.manual) nwstToast('No Narrative Consistency profile set — cannot scan.', 'warning');
            return summary;
        }

        const secrets = getAllSecrets(chatId).filter(s => getSecretStatus(s) !== 'archived');
        if (secrets.length === 0) {
            if (options.manual) nwstToast('No active secrets to check.', 'info');
            return summary;
        }

        const recentMessages = getRecentSceneMessages(!!options.visibleOnly, !!options.deepScan);
        if (recentMessages.length === 0) {
            if (options.manual) nwstToast('No messages in range to scan.', 'info');
            return summary;
        }
        const sceneCharacters = detectSceneCharactersFromMessages(recentMessages);
        const userPrompt = buildConsistencyPrompt(secrets, recentMessages, sceneCharacters);

        const messages = [
            { role: 'system', content: CONSISTENCY_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        dlog('[NWST NarrativeConsistency] Running consistency check...');
        const response = await generateWithProfile(profile, messages);
        if (!response) {
            if (options.manual) nwstToast('Consistency scan got no response from the LLM.', 'warning');
            return summary;
        }

        const findings = parseFindings(response);
        if (findings === null) {
            // Unparseable response — keep the old note-only behavior as a fallback
            // so a chatty model still leaves a trace instead of vanishing.
            await addMysteryBullet(chatId, 'inconsistenciesFlagged',
                `[Narrative Consistency] Unstructured report: ${response.trim().substring(0, 200)}`);
            if (options.manual) nwstToast('Consistency scan returned an unreadable response — raw note saved to Inconsistencies.', 'warning');
            return summary;
        }

        summary.ran = true;
        const currentMsgIndex = getCurrentMessageCount();

        for (const f of findings) {
            if (!f || typeof f.secretTitle !== 'string') continue;
            const secret = matchSecretByTitle(secrets, f.secretTitle);
            if (!secret) {
                dlog(`[NWST NarrativeConsistency] Finding references unknown secret: "${f.secretTitle}" — skipped.`);
                continue;
            }

            if (f.type === 'knowledge_change' && Array.isArray(f.charactersWhoLearned)) {
                const applied = await applyKnowledgeChange(chatId, secret, f.charactersWhoLearned);
                if (applied > 0) {
                    summary.knowledgeChanges += applied;
                    await addMysteryBullet(chatId, 'inconsistenciesFlagged',
                        `[Consistency] ${f.charactersWhoLearned.join(', ')} learned "${secret.title}" — whoKnows updated. ${f.detail || ''}`.trim());
                }
            } else if (f.type === 'revealed') {
                if (getSecretStatus(secret) === 'active') {
                    await flagSecretForArchive(chatId, secret.id, 'revealed', currentMsgIndex);
                    summary.reveals++;
                }
            } else if (f.type === 'contradiction') {
                await addMysteryBullet(chatId, 'inconsistenciesFlagged',
                    `[Consistency] Contradiction vs "${secret.title}": ${f.detail || '(no detail)'}`);
                summary.contradictions++;
            }
        }

        // Player-facing result
        const parts = [];
        if (summary.knowledgeChanges) parts.push(`${summary.knowledgeChanges} knowledge update(s) applied`);
        if (summary.reveals) parts.push(`${summary.reveals} secret(s) flagged for archive review`);
        if (summary.contradictions) parts.push(`${summary.contradictions} contradiction(s) noted`);
        if (parts.length > 0) {
            nwstToast(`Consistency scan: ${parts.join('; ')}.`, 'warning');
            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('notebook');
        } else if (options.manual) {
            nwstToast('Consistency scan complete — no violations found.', 'success');
        }
        dlog('[NWST NarrativeConsistency] Scan complete:', summary);
        return summary;

    } catch (err) {
        console.error('[NWST NarrativeConsistency] Check failed:', err);
        if (options.manual) nwstToast(`Consistency scan failed: ${err.message}`, 'error');
        return summary;
    }
}

/**
 * Manual visible-message consistency scan (debug button entry point).
 * @returns {Promise<object>} summary
 */
export async function runVisibleConsistencyScan() {
    // Deep scan: reads ALL visible messages, not just the recent window.
    // The automatic cadence check keeps its small window; this button is the
    // thorough retrospective sweep.
    return runConsistencyCheck({ visibleOnly: true, manual: true, deepScan: true });
}

// ── Findings application ────────────────────────────────────────────────────

/** Case-insensitive exact title match. */
function matchSecretByTitle(secrets, title) {
    const t = title.toLowerCase().trim();
    return secrets.find(s => (s.title || '').toLowerCase().trim() === t) || null;
}

/**
 * Move learners from whoDoesNotKnow to whoKnows on a secret.
 * Only characters actually listed in whoDoesNotKnow (or absent from whoKnows)
 * are moved/added; unknown names are matched loosely (case-insensitive,
 * substring both ways) against the whoDoesNotKnow list so "Mira" matches
 * "Mira Halden".
 * @returns {Promise<number>} how many characters were updated
 */
async function applyKnowledgeChange(chatId, secret, learners) {
    const whoKnows = (secret.whoKnows || []).slice();
    let whoDoesNotKnow = (secret.whoDoesNotKnow || []).slice();
    let applied = 0;

    for (const learner of learners) {
        if (typeof learner !== 'string' || !learner.trim()) continue;
        const l = learner.trim().toLowerCase();

        // Find the matching entry in whoDoesNotKnow (loose match)
        const matchIdx = whoDoesNotKnow.findIndex(n => {
            const nl = (n || '').toLowerCase();
            return nl === l || nl.includes(l) || l.includes(nl);
        });

        if (matchIdx !== -1) {
            const [moved] = whoDoesNotKnow.splice(matchIdx, 1);
            if (!whoKnows.some(k => k.toLowerCase() === moved.toLowerCase())) {
                whoKnows.push(moved);
            }
            applied++;
        }
        // If the learner isn't in whoDoesNotKnow at all, do nothing — we don't
        // add arbitrary names the model invented.
    }

    if (applied > 0) {
        await updateSecret(chatId, secret.id, { whoKnows, whoDoesNotKnow });
        dlog(`[NWST NarrativeConsistency] "${secret.title}": moved ${applied} character(s) to whoKnows.`);
    }
    return applied;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Parse the structured findings JSON. Returns null if unparseable. */
function parseFindings(response) {
    let s = response.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const obj = s.match(/\{[\s\S]*\}/);
    if (obj) s = obj[0];
    try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed.findings) ? parsed.findings : [];
    } catch (e) {
        dlog('[NWST NarrativeConsistency] Failed to parse findings JSON:', e);
        return null;
    }
}

// ── Message + prompt helpers ────────────────────────────────────────────────

function getCurrentMessageCount() {
    try {
        const ctx = SillyTavern.getContext();
        return (ctx.chat || []).length;
    } catch (e) { return -1; }
}

/**
 * Recent messages for the check.
 * @param {boolean} visibleOnly - When true, exclude ALL system/hidden messages
 *        (what /hide hides); when false, use the standard scanner filter.
 */
function getRecentSceneMessages(visibleOnly = false, deepScan = false) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const RANGE = 20;
        const filtered = chat.filter(msg => {
            if (!msg || !msg.mes) return false;
            if (visibleOnly) {
                if (msg.is_system) return false;              // hidden via /hide, or system
            } else {
                if (msg.is_system && msg.extra?.hidden) return false;
            }
            return true;
        });
        // Deep scan (the manual button) reads the ENTIRE visible history so
        // discoveries from earlier scenes are never missed. The automatic
        // cadence check keeps the small recent window.
        return deepScan ? filtered : filtered.slice(-RANGE);
    } catch (e) {
        return [];
    }
}

function detectSceneCharactersFromMessages(messages) {
    const characters = new Set();
    for (const msg of messages) {
        if (msg.name && !msg.is_user) {
            characters.add(msg.name);
        }
    }
    return Array.from(characters);
}

function buildConsistencyPrompt(secrets, recentMessages, sceneCharacters) {
    let prompt = '';

    prompt += `=== SCENE CHARACTERS PRESENT ===\n`;
    prompt += sceneCharacters.join(', ') || '(unknown)';
    prompt += '\n\n';

    prompt += `=== RECENT MESSAGES ===\n`;
    for (const msg of recentMessages) {
        const sender = msg.name || (msg.is_user ? 'User' : 'Character');
        prompt += `[${sender}]: ${msg.mes}\n`;
    }
    prompt += '\n';

    prompt += `=== ALL SECRETS (${secrets.length}) ===\n`;
    for (const secret of secrets) {
        prompt += `---\n`;
        prompt += `Title: ${secret.title}\n`;
        prompt += `Type: ${secret.type}\n`;
        prompt += `Secret: ${secret.secret}\n`;
        prompt += `Who Knows: ${secret.whoKnows?.join(', ') || '(none)'}\n`;
        prompt += `Who Does NOT Know: ${secret.whoDoesNotKnow?.join(', ') || '(none)'}\n`;
        prompt += `Evidence Shown: ${secret.evidenceShown || '(none)'}\n`;
        prompt += `Reveal Conditions: ${secret.revealConditions || '(none)'}\n`;
    }
    prompt += '\n';

    prompt += `Compare the recent messages against each secret's knowledge state and return the findings JSON.`;

    return prompt;
}
