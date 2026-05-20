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
    DEFAULT_WORLD_STATE,
    DEFAULT_SEASON_CONFIG,
    DEFAULT_CALENDAR_CONFIG
} from './storage.js';
import { getMaxSnapshotCount } from '../settings.js';

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
export async function saveWorldState(chatId, worldState) {
    await setChatData(chatId, 'worldState', worldState);
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
export async function updateCurrentDay(chatId, dayData) {
    const ws = getWorldState(chatId);
    ws.currentDay = { ...ws.currentDay, ...dayData };
    await saveWorldState(chatId, ws);
}

/**
 * Replace the entire Current Day block (e.g., after day advancement LLM returns new data).
 * @param {string} chatId
 * @param {object} newCurrentDay - Complete new currentDay object
 */
export async function replaceCurrentDay(chatId, newCurrentDay) {
    const ws = getWorldState(chatId);
    ws.currentDay = newCurrentDay;
    await saveWorldState(chatId, ws);
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
export async function replaceForecast(chatId, forecast) {
    const ws = getWorldState(chatId);
    ws.forecast = forecast;
    await saveWorldState(chatId, ws);
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
export async function replaceMoonPhases(chatId, moonPhases) {
    const ws = getWorldState(chatId);
    ws.moonPhases = moonPhases;
    await saveWorldState(chatId, ws);
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
export async function updateCondition(chatId, conditionName, conditionData) {
    const ws = getWorldState(chatId);
    if (ws.conditions[conditionName]) {
        ws.conditions[conditionName] = { ...ws.conditions[conditionName], ...conditionData };
        await saveWorldState(chatId, ws);
    }
}

/**
 * Toggle a world condition's enabled state (eye icon on/off).
 * Returns the new enabled state.
 * @param {string} chatId
 * @param {string} conditionName
 * @returns {boolean} The new enabled state
 */
export async function toggleConditionEnabled(chatId, conditionName) {
    const ws = getWorldState(chatId);
    if (ws.conditions[conditionName]) {
        ws.conditions[conditionName].enabled = !ws.conditions[conditionName].enabled;
        await saveWorldState(chatId, ws);
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
export async function updateConditionContent(chatId, conditionName, content) {
    await updateCondition(chatId, conditionName, { content });
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
export async function saveSettingContext(chatId, context) {
    await setChatData(chatId, 'settingContext', context);
}

// ── Season Configuration (per-chat) ───────────────────────────────────────

/**
 * Get the season configuration for a chat.
 * NOTE: seasonConfig is stored per-chat, not globally.
 * @param {string} chatId
 * @returns {object} Season config object { mode, yearLength, seasons }
 */
export function getSeasonConfig(chatId) {
    const stored = getChatData(chatId, 'seasonConfig');
    if (stored && typeof stored === 'object') {
        // Ensure fallback structure if partially saved
        return {
            mode: stored.mode || 'auto',
            yearLength: stored.yearLength || 365,
            seasons: Array.isArray(stored.seasons) && stored.seasons.length > 0
                ? stored.seasons
                : DEFAULT_SEASON_CONFIG.seasons
        };
    }
    return { ...DEFAULT_SEASON_CONFIG, seasons: [...DEFAULT_SEASON_CONFIG.seasons] };
}

/**
 * Save the season configuration for a chat.
 * @param {string} chatId
 * @param {object} config - Season config object { mode, yearLength, seasons }
 */
export async function saveSeasonConfig(chatId, config) {
    await setChatData(chatId, 'seasonConfig', config);
}

// ── Calendar Configuration ────────────────────────────────────────────────

/**
 * Get the calendar configuration for a chat.
 * Controls custom month names and day counts per month (Experimental).
 * @param {string} chatId
 * @returns {object} Calendar config { enabled, months, monthNames, monthDays }
 */
export function getCalendarConfig(chatId) {
    const stored = getChatData(chatId, 'calendarConfig');
    if (stored && typeof stored === 'object') {
        return {
            enabled: stored.enabled || false,
            months: stored.months || 12,
            monthNames: Array.isArray(stored.monthNames) && stored.monthNames.length > 0
                ? stored.monthNames
                : [...DEFAULT_CALENDAR_CONFIG.monthNames],
            monthDays: Array.isArray(stored.monthDays) && stored.monthDays.length > 0
                ? stored.monthDays
                : [...DEFAULT_CALENDAR_CONFIG.monthDays],
            weekDays: Array.isArray(stored.weekDays) && stored.weekDays.length > 0
                ? stored.weekDays
                : [...DEFAULT_CALENDAR_CONFIG.weekDays]
        };
    }
    return { ...DEFAULT_CALENDAR_CONFIG, monthNames: [...DEFAULT_CALENDAR_CONFIG.monthNames], monthDays: [...DEFAULT_CALENDAR_CONFIG.monthDays], weekDays: [...DEFAULT_CALENDAR_CONFIG.weekDays] };
}

/**
 * Save the calendar configuration for a chat.
 * @param {string} chatId
 * @param {object} config - Calendar config object { enabled, months, monthNames, monthDays }
 */
export async function saveCalendarConfig(chatId, config) {
    await setChatData(chatId, 'calendarConfig', config);
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
export async function saveSnapshot(chatId, rangeKey, worldStateSnapshot, eventsSnapshot, notebookSnapshot) {
    const snapshots = getSnapshots(chatId);

    // Handle both range keys ("123-456") and non-range keys ("day_1234567890", "batch_scan")
    const parts = rangeKey.split('-');
    const parsedStart = parts.length >= 2 ? parseInt(parts[0], 10) : NaN;
    const parsedEnd   = parts.length >= 2 ? parseInt(parts[1], 10) : NaN;

    snapshots[rangeKey] = {
        // For non-range keys, use Date.now() as sortable fallback so getLatestSnapshot() works correctly
        messageRangeStart: isNaN(parsedStart) ? 0 : parsedStart,
        messageRangeEnd:   isNaN(parsedEnd)   ? Date.now() : parsedEnd,
        worldStateSnapshot,
        eventsSnapshot,
        notebookSnapshot,
        savedAt: Date.now()
    };

    // ── Prune oldest snapshots if over the cap ────────────────────────────
    // Keeps the per-chat file size bounded. Oldest snapshots are pruned first
    // since they represent the most distant past and are least likely to be needed.
    // batch_scan and pre_skip snapshots are always preserved — they are landmarks,
    // not regular cadence snapshots, and are explicitly meaningful to the user.
    const maxCount = getMaxSnapshotCount();
    const allKeys = Object.keys(snapshots);

    if (allKeys.length > maxCount) {
        // Separate protected snapshots from pruneable ones
        const protected_keys = allKeys.filter(k =>
            k.startsWith('batch_scan') || k.startsWith('pre_skip')
        );
        const pruneable = allKeys
            .filter(k => !k.startsWith('batch_scan') && !k.startsWith('pre_skip'))
            .sort((a, b) => {
                // Sort ascending by messageRangeEnd (oldest first = lowest end)
                const endA = snapshots[a]?.messageRangeEnd ?? 0;
                const endB = snapshots[b]?.messageRangeEnd ?? 0;
                return endA - endB;
            });

        // Prune oldest pruneable snapshots until we're within the limit
        const totalProtected = protected_keys.length;
        const allowedPruneable = Math.max(0, maxCount - totalProtected);
        const toPrune = pruneable.slice(0, pruneable.length - allowedPruneable);

        for (const k of toPrune) {
            delete snapshots[k];
        }

        if (toPrune.length > 0) {
            console.log(`[NWST Storage] Pruned ${toPrune.length} old snapshot(s) — kept ${Object.keys(snapshots).length}/${maxCount} (${protected_keys.length} protected).`);
        }
    }

    await setChatData(chatId, 'snapshots', snapshots);
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

    // Sort by messageRangeEnd descending, handling NaN values safely
    // Non-range keys (e.g. "day_1234567890") store Date.now() as messageRangeEnd,
    // so they sort correctly. This protects against any legacy snapshots with NaN.
    keys.sort((a, b) => {
        const endA = snapshots[a].messageRangeEnd;
        const endB = snapshots[b].messageRangeEnd;
        const validA = typeof endA === 'number' && !isNaN(endA);
        const validB = typeof endB === 'number' && !isNaN(endB);
        if (!validA && !validB) return 0;
        if (!validA) return 1;  // NaN sorts after valid numbers
        if (!validB) return -1;
        return endB - endA;
    });
    return snapshots[keys[0]];
}

/**
 * Get all day-boundary snapshots (excluding batch_scan and pre_skip landmarks),
 * sorted newest-first, with extracted metadata for display.
 *
 * Each returned entry includes:
 *   { key, savedAt, dayCount (extracted from worldState), dateDisplay }
 *
 * Used by the Previous Day UI to let users browse and pick which day to restore.
 * @param {string} chatId
 * @returns {object[]} Sorted array of day-boundary snapshot metadata entries
 */
export function getDayBoundarySnapshots(chatId) {
    const snapshots = getSnapshots(chatId);
    const keys = Object.keys(snapshots);

    return keys
        .filter(k => k.startsWith('day_'))
        .map(k => {
            const s = snapshots[k];
            const ws = s?.worldStateSnapshot;
            const currentDay = ws?.currentDay || {};
            return {
                key: k,
                savedAt: s?.savedAt || 0,
                dayCount: currentDay.dayCount || '?',
                dateDisplay: currentDay.dateDisplay || '(unknown)',
                dateSub: currentDay.dateSub || '',
                season: currentDay.season || '',
                worldStateSnapshot: s?.worldStateSnapshot,
                eventsSnapshot: s?.eventsSnapshot,
                notebookSnapshot: s?.notebookSnapshot
            };
        })
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}
