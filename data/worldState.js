/* eslint-disable */
// =============================================================================
// NWST World State Data Module — data/worldState.js
// =============================================================================
// Typed CRUD operations for the world state data structure.
// All storage goes through storage.js — this module never touches
// extension_settings directly.
//
// Data structure (per chat):
// {
//   currentDay: {
//     dateDisplay, dateSub, season, weatherToday, flora, fauna, spiritualClimate
//   },
//   forecast: [ 7 entries: { label, icon, description, highF, lowF, highC, lowC, precipChance } ],
//   moonPhases: [ 7 entries: { label, icon, phaseName } ],
//   conditions: {
//     political:    { enabled, content },
//     social:       { enabled, content },
//     spiritual:    { enabled, content },
//     environmental:{ enabled, content }
//   }
// }
// =============================================================================

import {
    getChatData,
    setChatData,
    deleteChatData,
    DEFAULT_WORLD_STATE
} from './storage.js';

// ── Current Day ───────────────────────────────────────────────────────────

/**
 * Get the full world state for a chat.
 * @param {string} chatId
 * @returns {object} World state object (deep cloned)
 */
export function getWorldState(chatId) {
    return getChatData(chatId, 'worldState');
}

/**
 * Save the full world state for a chat.
 * @param {string} chatId
 * @param {object} worldState - Complete world state object
 */
export function saveWorldState(chatId, worldState) {
    setChatData(chatId, 'worldState', worldState);
}

/**
 * Get only the Current Day block.
 * @param {string} chatId
 * @returns {object} The currentDay object
 */
export function getCurrentDay(chatId) {
    const ws = getWorldState(chatId);
    return ws.currentDay;
}

/**
 * Update the Current Day block. Merges the provided fields into the existing
 * currentDay object — any fields not provided remain unchanged.
 * @param {string} chatId
 * @param {object} dayData - Partial currentDay fields to update
 */
export function updateCurrentDay(chatId, dayData) {
    const ws = getWorldState(chatId);
    ws.currentDay = { ...ws.currentDay, ...dayData };
    saveWorldState(chatId, ws);
}

/**
 * Replace the entire Current Day block (e.g., after day advancement LLM returns new data).
 * @param {string} chatId
 * @param {object} newCurrentDay - Complete new currentDay object
 */
export function replaceCurrentDay(chatId, newCurrentDay) {
    const ws = getWorldState(chatId);
    ws.currentDay = newCurrentDay;
    saveWorldState(chatId, ws);
}

// ── Forecast ──────────────────────────────────────────────────────────────

/**
 * Get the 7-day forecast array.
 * @param {string} chatId
 * @returns {object[]} Array of 7 forecast entries
 */
export function getForecast(chatId) {
    const ws = getWorldState(chatId);
    return ws.forecast;
}

/**
 * Replace the entire 7-day forecast (e.g., after day advancement LLM).
 * @param {string} chatId
 * @param {object[]} forecast - Array of 7 forecast entries
 */
export function replaceForecast(chatId, forecast) {
    const ws = getWorldState(chatId);
    ws.forecast = forecast;
    saveWorldState(chatId, ws);
}

// ── Moon Phases ───────────────────────────────────────────────────────────

/**
 * Get the 7-day moon phase array.
 * @param {string} chatId
 * @returns {object[]} Array of 7 moon phase entries
 */
export function getMoonPhases(chatId) {
    const ws = getWorldState(chatId);
    return ws.moonPhases;
}

/**
 * Replace the entire 7-day moon phase array.
 * @param {string} chatId
 * @param {object[]} moonPhases - Array of 7 moon phase entries
 */
export function replaceMoonPhases(chatId, moonPhases) {
    const ws = getWorldState(chatId);
    ws.moonPhases = moonPhases;
    saveWorldState(chatId, ws);
}

// ── World Conditions ──────────────────────────────────────────────────────

/**
 * Get all world conditions.
 * @param {string} chatId
 * @returns {object} The conditions object with political, social, spiritual, environmental keys
 */
export function getConditions(chatId) {
    const ws = getWorldState(chatId);
    return ws.conditions;
}

/**
 * Get a single world condition by name.
 * @param {string} chatId
 * @param {string} conditionName - 'political' | 'social' | 'spiritual' | 'environmental'
 * @returns {object} The condition object { enabled, content }
 */
export function getCondition(chatId, conditionName) {
    const ws = getWorldState(chatId);
    return ws.conditions[conditionName] || { enabled: false, content: '' };
}

/**
 * Update a single world condition.
 * @param {string} chatId
 * @param {string} conditionName - 'political' | 'social' | 'spiritual' | 'environmental'
 * @param {object} conditionData - Partial condition fields { enabled?, content? }
 */
export function updateCondition(chatId, conditionName, conditionData) {
    const ws = getWorldState(chatId);
    if (ws.conditions[conditionName]) {
        ws.conditions[conditionName] = { ...ws.conditions[conditionName], ...conditionData };
        saveWorldState(chatId, ws);
    }
}

/**
 * Toggle a world condition's enabled state (eye icon on/off).
 * Returns the new enabled state.
 * @param {string} chatId
 * @param {string} conditionName
 * @returns {boolean} The new enabled state
 */
export function toggleConditionEnabled(chatId, conditionName) {
    const ws = getWorldState(chatId);
    if (ws.conditions[conditionName]) {
        ws.conditions[conditionName].enabled = !ws.conditions[conditionName].enabled;
        saveWorldState(chatId, ws);
        return ws.conditions[conditionName].enabled;
    }
    return false;
}

/**
 * Update the content of a single world condition.
 * @param {string} chatId
 * @param {string} conditionName
 * @param {string} content - The new condition text
 */
export function updateConditionContent(chatId, conditionName, content) {
    updateCondition(chatId, conditionName, { content });
}

/**
 * Get only the ENABLED conditions (eye-on only).
 * Used for prompt injection — only active conditions are injected.
 * @param {string} chatId
 * @returns {object} Object containing only enabled conditions
 */
export function getEnabledConditions(chatId) {
    const conditions = getConditions(chatId);
    const enabled = {};
    for (const [name, condition] of Object.entries(conditions)) {
        if (condition.enabled) {
            enabled[name] = condition;
        }
    }
    return enabled;
}

// ── Setting Context (per-chat) ────────────────────────────────────────────

/**
 * Get the setting context for a chat (world climate/geography description).
 * NOTE: settingContext is stored per-chat, not globally.
 * @param {string} chatId
 * @returns {string} The setting context text
 */
export function getSettingContext(chatId) {
    return getChatData(chatId, 'settingContext');
}

/**
 * Save the setting context for a chat.
 * @param {string} chatId
 * @param {string} context - The setting context text
 */
export function saveSettingContext(chatId, context) {
    setChatData(chatId, 'settingContext', context);
}

// ── Snapshots ─────────────────────────────────────────────────────────────

/**
 * Get all snapshots for a chat.
 * Snapshots are keyed by message range string (e.g., "1-20").
 * @param {string} chatId
 * @returns {object} Snapshots object { "1-20": { worldStateSnapshot, eventsSnapshot, notebookSnapshot }, ... }
 */
export function getSnapshots(chatId) {
    return getChatData(chatId, 'snapshots');
}

/**
 * Save a snapshot at a specific message range boundary.
 * Each snapshot contains a full copy of world state, events, and notebook at that point.
 * @param {string} chatId
 * @param {string} rangeKey - e.g., "1-20", "21-40"
 * @param {object} worldStateSnapshot - Full world state at this boundary
 * @param {object[]} eventsSnapshot - Full events array at this boundary
 * @param {object} notebookSnapshot - Full notebook at this boundary
 */
export function saveSnapshot(chatId, rangeKey, worldStateSnapshot, eventsSnapshot, notebookSnapshot) {
    const snapshots = getSnapshots(chatId);
    snapshots[rangeKey] = {
        messageRangeStart: parseInt(rangeKey.split('-')[0], 10),
        messageRangeEnd: parseInt(rangeKey.split('-')[1], 10),
        worldStateSnapshot,
        eventsSnapshot,
        notebookSnapshot
    };
    setChatData(chatId, 'snapshots', snapshots);
}

/**
 * Get the most recent snapshot (highest message range end).
 * Used by the Previous Day button to restore the prior day's state.
 * @param {string} chatId
 * @returns {object|null} The most recent snapshot, or null if none exist
 */
export function getLatestSnapshot(chatId) {
    const snapshots = getSnapshots(chatId);
    const keys = Object.keys(snapshots);
    if (keys.length === 0) return null;

    // Sort by messageRangeEnd descending
    keys.sort((a, b) => snapshots[b].messageRangeEnd - snapshots[a].messageRangeEnd);
    return snapshots[keys[0]];
}

