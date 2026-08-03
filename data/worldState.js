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
    DEFAULT_SEASON_CONFIG,
    DEFAULT_CALENDAR_CONFIG
} from './storage.js';
import { getMaxSnapshotCount } from '../settings.js';
import { dlog } from "../lib/debug.js";
import { normalizeDateSub } from "../utils.js";

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
    let normalized = worldState;
    const currentDay = worldState?.currentDay;
    if (currentDay && Object.prototype.hasOwnProperty.call(currentDay, 'dateSub')) {
        const cleanDateSub = normalizeDateSub(currentDay.dateSub);
        if (cleanDateSub !== currentDay.dateSub) {
            normalized = {
                ...worldState,
                currentDay: { ...currentDay, dateSub: cleanDateSub }
            };
        }
    }
    await setChatData(chatId, 'worldState', normalized);
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

/**
 * Get the extra-moon states (every configured moon beyond the first).
 * The primary moon keeps the legacy lunarAngle/moonPhases fields untouched.
 * @param {string} chatId
 * @returns {Array<{id:string, name:string, cycleDays:number, angle:number, phases:object[]}>}
 */
export function getExtraMoons(chatId) {
    const ws = getWorldState(chatId);
    return Array.isArray(ws.extraMoons) ? ws.extraMoons : [];
}

/**
 * Replace the extra-moon states.
 * @param {string} chatId
 * @param {Array} extraMoons
 */
export async function saveExtraMoons(chatId, extraMoons) {
    const ws = getWorldState(chatId);
    ws.extraMoons = Array.isArray(extraMoons) ? extraMoons : [];
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

function _newSettingProfileId() {
    return `setting_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Get the saved Setting Context profile library for this chat.
 * Legacy chats that only have the old settingContext string are exposed as a
 * virtual "Default Setting" profile until the next save, preserving backwards
 * compatibility without requiring a migration pass during every prompt read.
 */
export function getSettingContextProfiles(chatId) {
    const stored = getChatData(chatId, 'settingContextProfiles');
    const profiles = (Array.isArray(stored?.profiles) ? stored.profiles : [])
        .filter(p => p && typeof p === 'object' && !Array.isArray(p))
        .map((p, index) => ({
            id: String(p.id || `setting_profile_${index + 1}`),
            name: String(p.name || 'Untitled Setting').trim() || 'Untitled Setting',
            content: String(p.content || '')
        }));
    let activeProfileId = stored?.activeProfileId || null;

    if (profiles.length > 0) {
        if (!profiles.some(p => p.id === activeProfileId)) activeProfileId = profiles[0].id;
        return { activeProfileId, profiles };
    }

    const legacy = getChatData(chatId, 'settingContext') || '';
    if (String(legacy).trim()) {
        const profile = { id: 'setting_legacy_default', name: 'Default Setting', content: String(legacy) };
        return { activeProfileId: profile.id, profiles: [profile], virtualLegacy: true };
    }

    return { activeProfileId: null, profiles: [] };
}

export async function saveSettingContextProfiles(chatId, library) {
    const normalized = {
        activeProfileId: library?.activeProfileId || null,
        profiles: Array.isArray(library?.profiles)
            ? library.profiles
                .filter(p => p && typeof p === 'object' && !Array.isArray(p))
                .map(p => ({
                    id: p.id || _newSettingProfileId(),
                    name: String(p.name || 'Untitled Setting').trim() || 'Untitled Setting',
                    content: String(p.content || '')
                }))
            : []
    };
    if (normalized.activeProfileId && !normalized.profiles.some(p => p.id === normalized.activeProfileId)) {
        normalized.activeProfileId = normalized.profiles[0]?.id || null;
    }
    await setChatData(chatId, 'settingContextProfiles', normalized);
    const active = normalized.profiles.find(p => p.id === normalized.activeProfileId);
    // Keep the legacy key mirrored because older NWST exports/builds and some
    // third-party tools still expect a simple settingContext string.
    await setChatData(chatId, 'settingContext', active?.content || '');
    return normalized;
}

export async function ensureSettingContextProfiles(chatId) {
    const library = getSettingContextProfiles(chatId);
    if (!library.virtualLegacy) return library;
    const persisted = { activeProfileId: library.activeProfileId, profiles: library.profiles };
    await saveSettingContextProfiles(chatId, persisted);
    return persisted;
}

/** Get the currently active setting-context text. */
export function getSettingContext(chatId) {
    const library = getSettingContextProfiles(chatId);
    const active = library.profiles.find(p => p.id === library.activeProfileId);
    if (active) return active.content || '';
    return getChatData(chatId, 'settingContext') || '';
}

/**
 * Save the active setting context. If the chat has never used profiles before,
 * this transparently creates its first profile rather than discarding the
 * existing simple-text workflow.
 */
export async function saveSettingContext(chatId, context) {
    let library = getSettingContextProfiles(chatId);
    if (library.virtualLegacy) library = { activeProfileId: library.activeProfileId, profiles: library.profiles };
    let active = library.profiles.find(p => p.id === library.activeProfileId);
    if (!active) {
        active = { id: _newSettingProfileId(), name: 'Default Setting', content: '' };
        library.profiles.push(active);
        library.activeProfileId = active.id;
    }
    active.content = String(context || '');
    await saveSettingContextProfiles(chatId, library);
}

export async function createSettingContextProfile(chatId, name = 'New Setting', content = '', activate = true) {
    let library = getSettingContextProfiles(chatId);
    if (library.virtualLegacy) library = { activeProfileId: library.activeProfileId, profiles: library.profiles };
    const profile = { id: _newSettingProfileId(), name: String(name || 'New Setting').trim() || 'New Setting', content: String(content || '') };
    library.profiles.push(profile);
    if (activate) library.activeProfileId = profile.id;
    await saveSettingContextProfiles(chatId, library);
    return profile;
}

export async function setActiveSettingContextProfile(chatId, profileId) {
    let library = getSettingContextProfiles(chatId);
    if (library.virtualLegacy) library = { activeProfileId: library.activeProfileId, profiles: library.profiles };
    if (!library.profiles.some(p => p.id === profileId)) return false;
    library.activeProfileId = profileId;
    await saveSettingContextProfiles(chatId, library);
    return true;
}

export async function deleteSettingContextProfile(chatId, profileId) {
    let library = getSettingContextProfiles(chatId);
    if (library.virtualLegacy) library = { activeProfileId: library.activeProfileId, profiles: library.profiles };
    library.profiles = library.profiles.filter(p => p.id !== profileId);
    if (library.activeProfileId === profileId) library.activeProfileId = library.profiles[0]?.id || null;
    await saveSettingContextProfiles(chatId, library);
    return library;
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
        const storedNager = stored.nagerDate && typeof stored.nagerDate === 'object' ? stored.nagerDate : {};
        const allowedHolidayTypes = ['Public', 'Bank', 'School', 'Authorities', 'Optional', 'Observance'];
        const holidayTypes = Array.isArray(storedNager.holidayTypes)
            ? storedNager.holidayTypes.filter(type => allowedHolidayTypes.includes(type))
            : ['Public'];
        const upcomingDaysRaw = Number(storedNager.upcomingDays);
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
                : [...DEFAULT_CALENDAR_CONFIG.weekDays],
            // Which weekday (1-based index into weekDays) story Day 1 fell on.
            // Defaults to 1 so existing chats keep "Day 1 = first weekday".
            startWeekday: (Number.isInteger(stored.startWeekday) && stored.startWeekday >= 1)
                ? stored.startWeekday
                : 1,
            // Player-defined recurring calendar days (see data/specialDays.js).
            specialDays: Array.isArray(stored.specialDays) ? stored.specialDays : [],
            // Optional era label for custom calendars ("Third Age {year}").
            eraName: typeof stored.eraName === 'string' ? stored.eraName : '',
            // Calendar engine. Existing chats default to standard/static month
            // lengths; lunisolar mode dynamically supplies 29/30-day months and
            // intercalary months while preserving the configured display names.
            calendarSystem: stored.calendarSystem === 'lunisolar' ? 'lunisolar' : 'standard',
            lunisolar: {
                engine: 'east_asian',
                leapMonthLabel: (typeof stored.lunisolar?.leapMonthLabel === 'string' && stored.lunisolar.leapMonthLabel.trim())
                    ? stored.lunisolar.leapMonthLabel.trim()
                    : 'Intercalary {month}'
            },
            // Gregorian leap-year toggle. Defaults ON so real-world dates stay
            // true; renamed Gregorian-compatible custom calendars honor it too.
            leapYears: stored.leapYears !== false,
            nagerDate: {
                enabled: storedNager.enabled === true,
                countryCode: typeof storedNager.countryCode === 'string' ? storedNager.countryCode.trim().toUpperCase() : '',
                subdivisionCode: typeof storedNager.subdivisionCode === 'string' ? storedNager.subdivisionCode.trim().toUpperCase() : '',
                holidayTypes: holidayTypes.length > 0 ? holidayTypes : ['Public'],
                showOnCalendar: storedNager.showOnCalendar !== false,
                includeInPrompt: storedNager.includeInPrompt !== false,
                upcomingDays: Number.isInteger(upcomingDaysRaw) ? Math.max(0, Math.min(30, upcomingDaysRaw)) : 7,
                cache: storedNager.cache && typeof storedNager.cache === 'object' ? storedNager.cache : {}
            }
        };
    }
    return {
        ...DEFAULT_CALENDAR_CONFIG,
        monthNames: [...DEFAULT_CALENDAR_CONFIG.monthNames],
        monthDays: [...DEFAULT_CALENDAR_CONFIG.monthDays],
        weekDays: [...DEFAULT_CALENDAR_CONFIG.weekDays],
        startWeekday: 1,
        specialDays: [],
        eraName: '',
        calendarSystem: 'standard',
        lunisolar: {
            ...DEFAULT_CALENDAR_CONFIG.lunisolar
        },
        leapYears: true,
        nagerDate: {
            ...DEFAULT_CALENDAR_CONFIG.nagerDate,
            holidayTypes: [...DEFAULT_CALENDAR_CONFIG.nagerDate.holidayTypes],
            cache: {}
        }
    };
}

/**
 * Save the calendar configuration for a chat.
 * @param {string} chatId
 * @param {object} config - Calendar config object { enabled, months, monthNames, monthDays }
 */
export async function saveCalendarConfig(chatId, config) {
    await setChatData(chatId, 'calendarConfig', config);
}

// ── Starting Date / elapsed-story baseline ───────────────────────────────

/**
 * Get the Starting Date used as elapsedStoryDays = 0 for this chat.
 * @param {string} chatId
 * @returns {object|null} { year, month, day, anchorDayCount, source, locked } or null
 */
export function getStartDate(chatId) {
    const stored = getChatData(chatId, 'startDate');
    if (stored && typeof stored === 'object'
        && Number.isInteger(stored.year) && stored.year !== 0
        && Number.isInteger(stored.month) && stored.month >= 1
        && Number.isInteger(stored.day) && stored.day >= 1) {
        return {
            year: stored.year,
            month: stored.month,
            day: stored.day,
            // Legacy compatibility field from the older anchor-driven date engine.
            anchorDayCount: Number.isInteger(stored.anchorDayCount) ? stored.anchorDayCount : null,
            source: stored.source === 'user' ? 'user' : 'scan',
            locked: stored.locked === true,
            // Legacy compatibility field set by Adopt Computed Dates. The
            // cyclical calendar no longer advances from this anchor.
            anchorDate: (stored.anchorDate && typeof stored.anchorDate === 'object'
                && Number.isInteger(stored.anchorDate.year) && stored.anchorDate.year !== 0
                && Number.isInteger(stored.anchorDate.month) && stored.anchorDate.month >= 1
                && Number.isInteger(stored.anchorDate.day) && stored.anchorDate.day >= 1)
                ? { year: stored.anchorDate.year, month: stored.anchorDate.month, day: stored.anchorDate.day }
                : null
        };
    }
    return null;
}

/**
 * Save the Starting Date / elapsed-story baseline.
 * @param {string} chatId
 * @param {object|null} anchor
 */
export async function saveStartDate(chatId, anchor) {
    await setChatData(chatId, 'startDate', anchor);
}

/**
 * Get the player-pinned era label (real-world calendars only).
 * @param {string} chatId
 * @returns {string} '' when unset
 */
export function getEraPin(chatId) {
    const stored = getChatData(chatId, 'eraPin');
    return typeof stored === 'string' ? stored.trim() : '';
}

/**
 * Save (or clear, with '') the player-pinned era label.
 * @param {string} chatId
 * @param {string} pin
 */
export async function saveEraPin(chatId, pin) {
    await setChatData(chatId, 'eraPin', typeof pin === 'string' ? pin.trim() : '');
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
        activeSettingContextProfileId: getSettingContextProfiles(chatId)?.activeProfileId || null,
        activeWeatherProfileId: getChatData(chatId, 'weatherProfiles')?.activeProfileId || null,
        weatherSimulationSnapshot: (() => {
            const weather = getChatData(chatId, 'weatherProfiles');
            return {
                activeProfileId: weather?.activeProfileId || null,
                profileStates: Array.isArray(weather?.profiles) ? weather.profiles.map(p => ({
                    id: p.id,
                    activeSystem: p.activeSystem || null,
                    history: Array.isArray(p.history) ? p.history : []
                })) : []
            };
        })(),
        savedAt: Date.now()
    };

    // ── Prune oldest snapshots if over the cap ────────────────────────────
    // Keeps regular snapshot history bounded. Oldest pruneable snapshots are removed
    // first. batch_scan and pre_skip snapshots are protected landmarks and are never
    // pruned; if protected landmarks alone exceed the configured target, the stored
    // total can exceed that target.
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
            dlog(`[NWST Storage] Pruned ${toPrune.length} old snapshot(s) — kept ${Object.keys(snapshots).length}/${maxCount} (${protected_keys.length} protected).`);
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
