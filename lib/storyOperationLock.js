/* eslint-disable */
// =============================================================================
// NWST Foreground Story Operation Lock
// =============================================================================
// Day Advancement, Time Skip and manual rewind mutate overlapping world-state
// domains. Keep exactly one foreground timeline mutation active per chat so UI,
// slash-command and extension entry points cannot race each other.
// =============================================================================

const activeByChat = new Map();

export function acquireStoryOperation(chatId, kind) {
    const id = String(chatId || '');
    if (!id) return { ok: false, active: null };
    const active = activeByChat.get(id) || null;
    if (active) return { ok: false, active: { ...active } };
    const entry = { kind: String(kind || 'timeline operation'), startedAt: Date.now() };
    activeByChat.set(id, entry);
    return { ok: true, active: { ...entry } };
}

export function releaseStoryOperation(chatId, kind = null) {
    const id = String(chatId || '');
    const active = activeByChat.get(id);
    if (!active) return false;
    if (kind && active.kind !== kind) return false;
    activeByChat.delete(id);
    return true;
}

export function getActiveStoryOperation(chatId) {
    const active = activeByChat.get(String(chatId || '')) || null;
    return active ? { ...active } : null;
}
