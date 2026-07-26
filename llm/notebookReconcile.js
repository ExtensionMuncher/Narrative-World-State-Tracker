/* eslint-disable */
// =============================================================================
// NWST Notebook Reconciliation (Tier 3) — llm/notebookReconcile.js
// =============================================================================
// A SEPARATE pass from the cadence scan. It reviews the accumulated ledger
// fields and emits explicit operations to tidy them: merge near-duplicates,
// edit phrasing for clarity, remove dead entries, and promote a resolved
// unresolvedDetail into establishedFacts.
//
// Design principles (hard-won from this project):
//   • OPERATION-BASED, not blob-rewrite. The LLM returns discrete ops, each
//     validated against existing bullets before applying. A hallucinated
//     reference skips that one op instead of corrupting the field.
//   • CONSERVATIVE. A fact and an unresolved question that share a topic are
//     SUPPOSED to coexist (e.g. "her signature reads as ancient" is a fact;
//     "what her signature actually is" is an open mystery held across arcs).
//     The prompt forbids collapsing these. Promote ONLY when the prose has
//     genuinely answered the question.
//   • AUTO-APPLIED but fully UNDOABLE. Every op records to the notebook history
//     so the user can selectively undo per field.
//   • TARGETED. Only establishedFacts, unresolvedDetail, doNotForget — the
//     fields where real duplication accumulates. State fields (whereabouts,
//     tone, pressure) are handled by keyed-replace and are left alone.
// =============================================================================

import { resolveProfile, generateWithProfile } from './connections.js';
import { LLM_TOKEN_BUDGETS } from './tokenBudgets.js';
import {
    getCoreField, getMysteryField, replaceCoreField, replaceMysteryField
} from '../data/notebook.js';
import { beginMutationBatch, recordMutation, commitMutationBatch } from '../data/notebookHistory.js';
import { getChatId, nwstToast } from '../index.js';
import { dlog } from '../lib/debug.js';

// Field → bucket map for the three reconcilable ledger fields.
const RECONCILE_FIELDS = {
    establishedFacts: 'mystery',
    unresolvedDetail: 'core',
    doNotForget: 'core'
};

const RECONCILE_SYSTEM_PROMPT = `You tidy a roleplay's notebook ledgers. You are given the current bullets in three fields and must return ONLY a JSON object of operations to clean them up. Be CONSERVATIVE — when unsure, do nothing.

THE THREE FIELDS:
- establishedFacts: confirmed truths in the story world.
- unresolvedDetail: open threads, unanswered questions, dangling mysteries.
- doNotForget: specific important details to retain.

OPERATIONS YOU MAY EMIT:
- merge: combine 2+ near-duplicate bullets in the SAME field into one tighter bullet. Use when bullets restate the same information.
- edit: reword a single bullet for clarity. Use SPARINGLY — only when rewording meaningfully sharpens it (e.g. to clarify that a fact and a separate mystery are distinct).
- remove: delete a bullet that is now obsolete, fully superseded, or meaningless.
- promote: move a bullet from unresolvedDetail to establishedFacts. ONLY when the prose has GENUINELY ANSWERED that open question and it is now a confirmed fact.

CRITICAL RULES — READ CAREFULLY:
- A FACT and a MYSTERY about the same topic are SUPPOSED to coexist. Example: "Her signature reads as ancient/dimensional" (established fact) and "What her signature actually IS remains unknown" (unresolved) are NOT duplicates — one is observed, one is an open question deliberately held for many chapters. DO NOT merge or promote these. If anything, EDIT them so the distinction is clearer.
- NEVER promote an unresolved detail just because it shares a topic with a fact. Promote ONLY if the underlying question is now answered in the story.
- When in doubt, leave a bullet alone. Under-tidying is far better than destroying a deliberate narrative thread.
- Preserve specific names, dates, and concrete details when merging or editing. Do not generalize away specifics.
- Preserve explicitly stated motives. Do NOT rewrite fear, desperation, panic, confusion, impulsiveness, self-preservation, or reactive behavior as confidence, strategy, dominance, bravery, or calculated control unless the existing bullet itself establishes that interpretation.
- Do not make characters more competent, composed, sinister, romantic, strategic, or "badass" while tidying phrasing.
- Do not touch any field other than these three.

OUTPUT FORMAT (JSON only, no markdown fences, no commentary):
{
  "operations": [
    { "action": "merge", "field": "establishedFacts", "bullets": ["exact bullet text 1", "exact bullet text 2"], "into": "the new combined bullet text" },
    { "action": "edit", "field": "unresolvedDetail", "from": "exact existing bullet text", "to": "reworded bullet text" },
    { "action": "remove", "field": "doNotForget", "bullet": "exact existing bullet text" },
    { "action": "promote", "field": "unresolvedDetail", "bullet": "exact existing bullet text", "asFact": "the confirmed fact text to add to establishedFacts" }
  ]
}

If nothing needs tidying, return { "operations": [] }.`;

function buildReconcileUserPrompt(fields) {
    let p = 'Current notebook ledger fields:\n\n';
    for (const [field, bullets] of Object.entries(fields)) {
        p += `${field}:\n`;
        if (bullets.length === 0) {
            p += '  (empty)\n';
        } else {
            for (const b of bullets) p += `  - ${b}\n`;
        }
        p += '\n';
    }
    p += 'Return the JSON operations object. Be conservative.';
    return p;
}

function parseReconcileResponse(response) {
    if (!response || typeof response !== 'string') return null;
    let s = response.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const obj = s.match(/\{[\s\S]*\}/);
    if (obj) s = obj[0];
    try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed.operations) ? parsed.operations : [];
    } catch (e) {
        dlog('[NWST Reconcile] Failed to parse response:', e, response.slice(0, 400));
        return null;
    }
}

// Apply a single validated operation to the working field arrays.
// Returns the per-field mutations { field: { removed:[], added:[] } } so they
// can be recorded to undo history. Returns null if the op was invalid/skipped.
function applyOperation(op, working) {
    const exists = (field, text) => working[field] && working[field].includes(text);

    if (op.action === 'merge') {
        if (op.field !== 'establishedFacts' && op.field !== 'unresolvedDetail' && op.field !== 'doNotForget') return null;
        if (!Array.isArray(op.bullets) || op.bullets.length < 2 || typeof op.into !== 'string' || !op.into.trim()) return null;
        // All source bullets must exist
        if (!op.bullets.every(b => exists(op.field, b))) return null;
        working[op.field] = working[op.field].filter(b => !op.bullets.includes(b));
        working[op.field].push(op.into.trim());
        return { [op.field]: { removed: op.bullets.slice(), added: [op.into.trim()] } };
    }

    if (op.action === 'edit') {
        if (!RECONCILE_FIELDS[op.field]) return null;
        if (typeof op.from !== 'string' || typeof op.to !== 'string' || !op.to.trim()) return null;
        if (!exists(op.field, op.from)) return null;
        if (op.from === op.to.trim()) return null;
        working[op.field] = working[op.field].map(b => (b === op.from ? op.to.trim() : b));
        return { [op.field]: { removed: [op.from], added: [op.to.trim()] } };
    }

    if (op.action === 'remove') {
        if (!RECONCILE_FIELDS[op.field]) return null;
        if (typeof op.bullet !== 'string') return null;
        if (!exists(op.field, op.bullet)) return null;
        working[op.field] = working[op.field].filter(b => b !== op.bullet);
        return { [op.field]: { removed: [op.bullet], added: [] } };
    }

    if (op.action === 'promote') {
        if (op.field !== 'unresolvedDetail') return null;
        if (typeof op.bullet !== 'string' || typeof op.asFact !== 'string' || !op.asFact.trim()) return null;
        if (!exists('unresolvedDetail', op.bullet)) return null;
        working.unresolvedDetail = working.unresolvedDetail.filter(b => b !== op.bullet);
        if (!working.establishedFacts.includes(op.asFact.trim())) {
            working.establishedFacts.push(op.asFact.trim());
        }
        return {
            unresolvedDetail: { removed: [op.bullet], added: [] },
            establishedFacts: { removed: [], added: [op.asFact.trim()] }
        };
    }

    return null; // unknown action
}

/**
 * Run the reconciliation pass. Auto-applies operations, each recorded to the
 * undo history. Returns a summary.
 * @param {string} [chatId]
 * @returns {Promise<{applied:number, skipped:number, ran:boolean}>}
 */
export async function runNotebookReconcile(chatId) {
    if (!chatId) chatId = getChatId();
    const summary = { applied: 0, skipped: 0, ran: false };
    if (!chatId) return summary;

    const profile = resolveProfile('planningLLM');
    if (!profile) {
        nwstToast('No Planning LLM profile set — cannot reconcile notebook.', 'warning');
        return summary;
    }

    // Snapshot the three fields
    const fields = {
        establishedFacts: getMysteryField(chatId, 'establishedFacts').slice(),
        unresolvedDetail: getCoreField(chatId, 'unresolvedDetail').slice(),
        doNotForget: getCoreField(chatId, 'doNotForget').slice()
    };

    // Nothing to do if all three are tiny
    const total = fields.establishedFacts.length + fields.unresolvedDetail.length + fields.doNotForget.length;
    if (total < 2) return summary;

    const messages = [
        { role: 'system', content: RECONCILE_SYSTEM_PROMPT },
        { role: 'user', content: buildReconcileUserPrompt(fields) }
    ];

    let response;
    try {
        response = await generateWithProfile(profile, messages, { maxTokens: LLM_TOKEN_BUDGETS.MEDIUM });
        if (getChatId() !== chatId) {
            dlog('[NWST Reconcile] Active chat changed during reconciliation; discarding stale result.');
            return summary;
        }
    } catch (e) {
        console.error('[NWST Reconcile] LLM call failed:', e);
        nwstToast('Notebook reconciliation failed — see console.', 'error');
        return summary;
    }

    const operations = parseReconcileResponse(response);
    if (operations === null) {
        nwstToast('Notebook reconciliation returned an unreadable response.', 'warning');
        return summary;
    }
    summary.ran = true;
    if (operations.length === 0) {
        nwstToast('Notebook is already tidy — no changes needed.', 'info');
        return summary;
    }

    // Apply ops against a working copy, collecting per-field mutations.
    const working = {
        establishedFacts: fields.establishedFacts.slice(),
        unresolvedDetail: fields.unresolvedDetail.slice(),
        doNotForget: fields.doNotForget.slice()
    };
    const fieldMutations = {}; // field -> { removed:[], added:[] }

    for (const op of operations) {
        const result = applyOperation(op, working);
        if (!result) { summary.skipped++; continue; }
        summary.applied++;
        for (const [field, diff] of Object.entries(result)) {
            if (!fieldMutations[field]) fieldMutations[field] = { removed: [], added: [] };
            fieldMutations[field].removed.push(...diff.removed);
            fieldMutations[field].added.push(...diff.added);
        }
    }

    if (summary.applied === 0) {
        nwstToast(`Reconciliation proposed ${summary.skipped} change(s) but none were valid.`, 'info');
        return summary;
    }

    // Persist the working fields and record one undoable batch.
    beginMutationBatch('Notebook reconciliation');
    for (const [field, diff] of Object.entries(fieldMutations)) {
        const scope = RECONCILE_FIELDS[field];
        if (scope === 'core') {
            await replaceCoreField(chatId, field, working[field]);
        } else {
            await replaceMysteryField(chatId, field, working[field]);
        }
        recordMutation(scope, field, diff.removed, diff.added);
    }
    await commitMutationBatch();

    nwstToast(
        `Notebook reconciled: ${summary.applied} change(s) applied${summary.skipped ? `, ${summary.skipped} skipped` : ''}. Undo available in the Notebook tab.`,
        'success'
    );
    dlog(`[NWST Reconcile] Applied ${summary.applied}, skipped ${summary.skipped}`);
    return summary;
}
