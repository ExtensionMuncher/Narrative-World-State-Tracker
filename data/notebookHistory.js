/* eslint-disable */
// =============================================================================
// NWST Notebook Mutation History — data/notebookHistory.js
// =============================================================================
// Records destructive notebook mutations (removals/replacements made by the
// scanner) so they can be undone and redone. This protects against the LLM
// occasionally removing or replacing something it shouldn't.
//
// Model: a bounded list of mutation records plus a cursor. Undo moves the
// cursor back and inverts that mutation; redo moves forward and replays it.
// Navigating back then making a NEW mutation truncates the redo tail (standard
// undo/redo semantics).
//
// Only SCANNER/LLM mutations are recorded — manual user edits are intentional
// and stay out of this stack.
//
// Storage: chatMetadata['nwst:notebookHistory'] = { entries: [...], cursor: N }
// Each entry: { id, ts, ops: [ { scope:'core'|'mystery', field, removed:[], added:[] } ], label }
// =============================================================================

import { getNotebook, saveNotebook } from './notebook.js';

const HISTORY_KEY = 'nwst:notebookHistory';
const MAX_HISTORY = 15;  // last N scanner mutations are undoable

function getCtx() {
    try { return SillyTavern.getContext(); } catch (e) { return null; }
}

function loadHistory() {
    const ctx = getCtx();
    if (!ctx || !ctx.chatMetadata) return { entries: [], cursor: 0 };
    const h = ctx.chatMetadata[HISTORY_KEY];
    if (!h || !Array.isArray(h.entries)) return { entries: [], cursor: 0 };
    return { entries: h.entries, cursor: typeof h.cursor === 'number' ? h.cursor : h.entries.length };
}

async function saveHistory(history) {
    const ctx = getCtx();
    if (!ctx || !ctx.chatMetadata) return;
    ctx.chatMetadata[HISTORY_KEY] = history;
    if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
}

// ── Mutation collection ─────────────────────────────────────────────────────
// A scan opens a batch, individual destructive ops are appended, then the batch
// is committed as one undoable entry (so one "Undo" reverts a whole scan).

let _pendingOps = null;
let _pendingLabel = '';

/** Begin collecting destructive ops for the current scan. */
export function beginMutationBatch(label) {
    _pendingOps = [];
    _pendingLabel = label || 'Scan update';
}

/**
 * Record one destructive op (a removal or replacement) within the current batch.
 * @param {'core'|'mystery'} scope
 * @param {string} field
 * @param {string[]} removed - bullets that were removed
 * @param {string[]} added - bullets that were added in their place
 */
export function recordMutation(scope, field, removed, added) {
    if (!_pendingOps) return; // no batch open — not recording
    if ((!removed || removed.length === 0) && (!added || added.length === 0)) return;
    _pendingOps.push({
        scope,
        field,
        removed: (removed || []).slice(),
        added: (added || []).slice()
    });
}

/** Commit the collected ops as one undoable history entry (if any destructive ops occurred). */
export async function commitMutationBatch() {
    if (!_pendingOps || _pendingOps.length === 0) {
        _pendingOps = null;
        return;
    }
    const history = loadHistory();

    // Truncate any redo tail (we're creating a new branch from the cursor)
    history.entries = history.entries.slice(0, history.cursor);

    history.entries.push({
        id: `mut_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        ts: Date.now(),
        ops: _pendingOps,
        label: _pendingLabel
    });

    // Bound the buffer
    if (history.entries.length > MAX_HISTORY) {
        history.entries = history.entries.slice(history.entries.length - MAX_HISTORY);
    }
    history.cursor = history.entries.length;

    await saveHistory(history);
    _pendingOps = null;
}

// ── Undo / Redo ─────────────────────────────────────────────────────────────

export function canUndo() {
    const h = loadHistory();
    return h.cursor > 0;
}

export function canRedo() {
    const h = loadHistory();
    return h.cursor < h.entries.length;
}

/** Human-readable description of what undo/redo would do next. */
export function getHistoryStatus() {
    const h = loadHistory();
    const undoEntry = h.cursor > 0 ? h.entries[h.cursor - 1] : null;
    const redoEntry = h.cursor < h.entries.length ? h.entries[h.cursor] : null;
    return {
        canUndo: h.cursor > 0,
        canRedo: h.cursor < h.entries.length,
        undoLabel: undoEntry ? describeEntry(undoEntry) : null,
        redoLabel: redoEntry ? describeEntry(redoEntry) : null,
        position: h.cursor,
        total: h.entries.length
    };
}

function describeEntry(entry) {
    const removedCount = entry.ops.reduce((n, o) => n + o.removed.length, 0);
    const addedCount = entry.ops.reduce((n, o) => n + o.added.length, 0);
    const fields = Array.from(new Set(entry.ops.map(o => o.field)));
    const when = new Date(entry.ts).toLocaleTimeString();
    return `${entry.label} (${when}) — ${removedCount} removed, ${addedCount} added in ${fields.join(', ')}`;
}

// Apply the inverse of an op (undo): re-add removed, remove added.
function applyInverse(nb, op) {
    const arr = (op.scope === 'core' ? nb.core : nb.mystery)[op.field];
    if (!Array.isArray(arr)) return;
    // Remove the bullets this op added
    let next = arr.filter(b => !op.added.includes(b));
    // Re-add the bullets this op removed (avoid dupes)
    for (const r of op.removed) if (!next.includes(r)) next.push(r);
    (op.scope === 'core' ? nb.core : nb.mystery)[op.field] = next;
}

// Apply an op forward (redo): remove removed, add added.
function applyForward(nb, op) {
    const arr = (op.scope === 'core' ? nb.core : nb.mystery)[op.field];
    if (!Array.isArray(arr)) return;
    let next = arr.filter(b => !op.removed.includes(b));
    for (const a of op.added) if (!next.includes(a)) next.push(a);
    (op.scope === 'core' ? nb.core : nb.mystery)[op.field] = next;
}

/**
 * Undo the most recent scanner mutation. Best-effort: if the notebook changed
 * underneath, this still re-adds removed entries rather than failing.
 * @param {string} chatId
 * @returns {Promise<boolean>} true if something was undone
 */
export async function undoLastMutation(chatId) {
    const history = loadHistory();
    if (history.cursor <= 0) return false;
    const entry = history.entries[history.cursor - 1];
    const nb = getNotebook(chatId);
    // Apply inverses in reverse op order
    for (let i = entry.ops.length - 1; i >= 0; i--) applyInverse(nb, entry.ops[i]);
    await saveNotebook(chatId, nb);
    history.cursor -= 1;
    await saveHistory(history);
    return true;
}

/**
 * Redo the next mutation (after an undo).
 * @param {string} chatId
 * @returns {Promise<boolean>} true if something was redone
 */
export async function redoNextMutation(chatId) {
    const history = loadHistory();
    if (history.cursor >= history.entries.length) return false;
    const entry = history.entries[history.cursor];
    const nb = getNotebook(chatId);
    for (const op of entry.ops) applyForward(nb, op);
    await saveNotebook(chatId, nb);
    history.cursor += 1;
    await saveHistory(history);
    return true;
}
