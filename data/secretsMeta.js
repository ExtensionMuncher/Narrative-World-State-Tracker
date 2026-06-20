/* eslint-disable */
// =============================================================================
// NWST Secrets Metadata — data/secretsMeta.js
// =============================================================================
// Per-chat, non-destructive configuration for the prose-based secrets engine.
// This stores the configured user/PC identity separately from global settings
// so different chats can have different protagonists without cross-contamination.
// =============================================================================

import { getChatData, setChatData } from './storage.js';
import { getChatId } from '../utils.js';

const DEFAULT_META = {
    userCharacterName: '',
    userCharacterAliases: ''
};

export function getSecretsMeta(chatId) {
    if (!chatId) chatId = getChatId();
    const meta = getChatData(chatId, 'secretsMeta') || {};
    return { ...DEFAULT_META, ...meta };
}

export async function setSecretsMeta(chatId, updates) {
    if (!chatId) chatId = getChatId();
    const current = getSecretsMeta(chatId);
    const next = { ...current, ...(updates || {}) };
    await setChatData(chatId, 'secretsMeta', next);
    return next;
}

export function getUserCharacterIdentity(chatId) {
    const meta = getSecretsMeta(chatId);
    const name = (meta.userCharacterName || '').trim();
    const aliases = (meta.userCharacterAliases || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    if (name && !aliases.includes(name)) aliases.unshift(name);
    return { name, aliases };
}
