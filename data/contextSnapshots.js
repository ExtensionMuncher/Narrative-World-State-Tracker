/* eslint-disable */
// =============================================================================
// NWST Context/Profile Snapshots — data/contextSnapshots.js
// =============================================================================
// Separate undo history for manual Setting Context / Weather Profile changes.
// These snapshots NEVER participate in Previous Day / story-date rewind logic.
// =============================================================================

import { getChatData, setChatData } from './storage.js';

const CONTEXT_SNAPSHOT_LIMIT = 30;

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function newSnapshotId() {
    return `ctxsnap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getContextSnapshots(chatId) {
    const raw = getChatData(chatId, 'contextSnapshots');
    const list = Array.isArray(raw) ? raw : [];
    return list
        .filter(s => s && typeof s === 'object')
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function saveContextSnapshot(chatId, snapshot = {}) {
    const list = getContextSnapshots(chatId);
    const entry = {
        id: snapshot.id || newSnapshotId(),
        type: snapshot.type || 'profile_change',
        label: String(snapshot.label || 'Context/Profile change'),
        createdAt: Number(snapshot.createdAt) || Date.now(),
        details: String(snapshot.details || ''),
        refreshOptions: snapshot.refreshOptions ? clone(snapshot.refreshOptions) : null,
        payload: clone(snapshot.payload || {})
    };

    // getContextSnapshots() is newest-first. Prepend and keep an independent,
    // bounded history so these never consume the normal day-snapshot budget.
    const next = [entry, ...list.filter(s => s.id !== entry.id)]
        .slice(0, CONTEXT_SNAPSHOT_LIMIT);
    await setChatData(chatId, 'contextSnapshots', next);
    return clone(entry);
}

export async function deleteContextSnapshot(chatId, snapshotId) {
    const next = getContextSnapshots(chatId).filter(s => s.id !== snapshotId);
    await setChatData(chatId, 'contextSnapshots', next);
    return next;
}

export async function clearContextSnapshots(chatId) {
    await setChatData(chatId, 'contextSnapshots', []);
}

export function getContextSnapshot(chatId, snapshotId) {
    return getContextSnapshots(chatId).find(s => s.id === snapshotId) || null;
}
