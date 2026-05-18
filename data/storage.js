/* eslint-disable */
// =============================================================================
// NWST Storage Layer — data/storage.js
// =============================================================================
// This is the SINGLE POINT OF CONTACT for all NWST data persistence.
// Every read and write to extension data flows through this module.
//
// Storage architecture:
//   - Global settings (user preferences): extensionSettings.nwst (via context)
//   - Per-chat data (narrative state): extensionSettings.nwst.chatData[chatId][dataType]
//
// Key pattern: extensionSettings.nwst.chatData["char_5"]["worldState"]
// This ensures COMPLETE data isolation between chats. Zero crossover.
//
// All other NWST modules (worldState.js, events.js, notebook.js, communities.js)
// call into this module. They never touch extensionSettings directly.
//
// IMPORTANT: All ST APIs accessed via SillyTavern.getContext() — NOT direct
// imports from script.js. This is the stable API that won't break with ST updates.
// =============================================================================

// ── Context accessors ─────────────────────────────────────────────────────
// These replace direct imports from script.js/extensions.js.
// Using SillyTavern.getContext() as recommended by ST docs.

/**
 * Get the extensionSettings object from ST context.
 * This is a live reference — mutations to it persist.
 * @returns {object} The extensionSettings object
 */
function getExtSettings() {
    return SillyTavern.getContext().extensionSettings;
}

/**
 * Persist extension settings to ST's storage using debounced save.
 */
function persistSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// ── Module name (must match index.js) ─────────────────────────────────────
const MODULE_NAME = 'nwst';

// ── Default data structures (empty/initial state for each data type) ──────

/**
 * Default (empty) world state object. Returned when a chat has no world state yet.
 * Matches the data structure defined in the NWST specification.
 */
const DEFAULT_WORLD_STATE = {
    currentDay: {
        dateDisplay: '',          // e.g. "Chrysanthemum Month · Seventh Day of the Waxing Moon"
        dateSub: '',              // e.g. "Heian Era · Kankō Era · 1125 CE"
        season: '',
        weatherToday: '',
        flora: '',
        fauna: '',
        spiritualClimate: '',     // Only populated if Spiritual/Supernatural condition is enabled
        lunarAngle: 0,            // Absolute angle (0-360) in the lunar cycle; 0 = New Moon
        dayCount: 0               // Absolute elapsed days since epoch start; increments +1 per day advancement
    },
    forecast: [],                 // 7 forecast entries (see worldState.js for structure)
    moonPhases: [],               // 7 moon phase entries
    conditions: {
        political:     { enabled: true, content: '' },
        social:        { enabled: true, content: '' },
        spiritual:     { enabled: true, content: '' },
        environmental: { enabled: true, content: '' }
    }
};

/**
 * Default (empty) events array.
 */
const DEFAULT_EVENTS = [];

/**
 * Default (empty) notebook object.
 * Matches the Core + Mystery + Secrets structure from the specification.
 */
const DEFAULT_NOTEBOOK = {
    core: {
        unresolvedDetail: [],
        promiseThreatDeadline: [],
        offscreenPressure: [],
        doNotForget: []
    },
    mystery: {
        establishedFacts: [],
        plantedDetails: [],
        characterWhereabouts: [],
        inconsistenciesFlagged: [],
        currentToneAtmosphere: []
    },
    secrets: []
};

/**
 * Default (empty) communities array.
 */
const DEFAULT_COMMUNITIES = [];

/**
 * Default (empty) setting context string.
 * NOTE: settingContext is per-chat, not global — it describes the world for a specific RP.
 */
const DEFAULT_SETTING_CONTEXT = '';

/**
 * Default season configuration (per-chat).
 * mode: 'auto' | 'static' | 'disabled'
 *   - auto:     seasons cycle based on dayCount and the configured season map
 *   - static:   always the first season in the list (for timeless settings)
 *   - disabled: seasons are entirely LLM-controlled (legacy behavior)
 * yearLength: total days in a full seasonal cycle (typically 365 for Earth-like)
 * seasons: array of { name, startDay, endDay } defining the seasonal bands
 */
const DEFAULT_SEASON_CONFIG = {
    mode: 'auto',
    yearLength: 365,
    seasons: [
        { name: 'Spring', startDay: 0,   endDay: 91   },
        { name: 'Summer', startDay: 92,  endDay: 185  },
        { name: 'Autumn', startDay: 186, endDay: 275  },
        { name: 'Winter', startDay: 276, endDay: 364  }
    ]
};

/**
 * Default calendar configuration (per-chat).
 * months: number of months in the year
 * monthNames: display names for each month
 * monthDays: number of days in each month (must sum to yearLength from season config)
 * enabled: whether the calendar config is active (Experimental)
 */
const DEFAULT_CALENDAR_CONFIG = {
    enabled: false,
    months: 12,
    monthNames: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    monthDays: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
    weekDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
};

/**
 * Default (empty) snapshots object.
 * Snapshots are keyed by message range (e.g., "1-20", "21-40").
 */
const DEFAULT_SNAPSHOTS = {};

// ── Default lookup table ──────────────────────────────────────────────────

const DEFAULTS = {
    worldState: DEFAULT_WORLD_STATE,
    events: DEFAULT_EVENTS,
    notebook: DEFAULT_NOTEBOOK,
    communities: DEFAULT_COMMUNITIES,
    settingContext: DEFAULT_SETTING_CONTEXT,
    seasonConfig: DEFAULT_SEASON_CONFIG,
    calendarConfig: DEFAULT_CALENDAR_CONFIG,
    snapshots: DEFAULT_SNAPSHOTS
};

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Ensure the NWST extensionSettings structure exists.
 * Called automatically on every storage operation — safe to call repeatedly.
 */
function ensureNWSTStorage() {
    const ext = getExtSettings();
    if (!ext[MODULE_NAME]) {
        console.warn('[NWST Storage] extensionSettings.nwst not found. Initializing...');
        ext[MODULE_NAME] = {};
    }
    if (!ext[MODULE_NAME].chatData) {
        ext[MODULE_NAME].chatData = {};
    }
}

/**
 * Get the chat data bucket for a specific chat ID.
 * Creates the bucket if it doesn't exist yet.
 * @param {string} chatId - The chat ID (e.g., "char_5", "group_abc123")
 * @returns {object} The chat's data bucket
 */
function getChatBucket(chatId) {
    ensureNWSTStorage();
    const ext = getExtSettings();
    const isNew = !ext[MODULE_NAME].chatData[chatId];
    if (isNew) {
        console.log(`[NWST Storage] getChatBucket: Creating new empty bucket for chatId="${chatId}"`);
        ext[MODULE_NAME].chatData[chatId] = {};
    }
    return ext[MODULE_NAME].chatData[chatId];
}

/**
 * Deep clone an object using JSON serialization.
 * Ensures callers can't accidentally mutate stored data.
 * @param {*} obj - The object to clone
 * @returns {*} A deep copy
 */
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Get a specific data type for a specific chat.
 * Returns a DEEP CLONE — mutations won't affect stored data.
 * Returns the appropriate default if no data exists yet.
 *
 * @param {string} chatId - The chat ID
 * @param {string} dataType - One of: 'worldState', 'events', 'notebook', 'communities', 'settingContext', 'snapshots'
 * @returns {*} The data (deep cloned), or default if not found
 */
function getChatData(chatId, dataType) {
    if (!chatId) {
        console.error('[NWST Storage] getChatData called with empty chatId');
        return deepClone(DEFAULTS[dataType] || null);
    }

    const bucket = getChatBucket(chatId);
    const defaultVal = DEFAULTS[dataType];

    if (bucket[dataType] === undefined) {
        // No data exists yet — return a fresh copy of the default
        return deepClone(defaultVal);
    }

    return deepClone(bucket[dataType]);
}

/**
 * Set (save) a specific data type for a specific chat.
 * Performs a deep clone before storing so later mutations to the passed
 * object don't corrupt stored data.
 * Persists to ST's settings automatically.
 *
 * @param {string} chatId - The chat ID
 * @param {string} dataType - One of: 'worldState', 'events', 'notebook', 'communities', 'settingContext', 'snapshots'
 * @param {*} value - The data to store
 */
function setChatData(chatId, dataType, value) {
    if (!chatId) {
        console.error('[NWST Storage] setChatData called with empty chatId');
        return;
    }

    const bucket = getChatBucket(chatId);
    bucket[dataType] = deepClone(value);
    persistSettings();
}

/**
 * Delete a specific data type for a specific chat.
 * After deletion, getChatData will return the default value.
 *
 * @param {string} chatId - The chat ID
 * @param {string} dataType - The data type to delete
 */
function deleteChatData(chatId, dataType) {
    if (!chatId) return;

    const bucket = getChatBucket(chatId);
    delete bucket[dataType];
    persistSettings();
}

/**
 * Check whether data exists for a chat+type combination.
 * Use this before batch scan to determine if data has already been generated.
 *
 * @param {string} chatId - The chat ID
 * @param {string} dataType - The data type to check
 * @returns {boolean} True if data exists (even if empty), false otherwise
 */
function chatDataExists(chatId, dataType) {
    if (!chatId) return false;
    ensureNWSTStorage();
    const chatData = getExtSettings()[MODULE_NAME].chatData;
    return !!(chatData[chatId] && chatData[chatId][dataType] !== undefined);
}

/**
 * Get ALL data types for a specific chat as a single object.
 * Useful for import/export and snapshot operations.
 *
 * @param {string} chatId - The chat ID
 * @returns {object} Object with all data types as keys
 */
function getAllChatData(chatId) {
    const result = {};
    for (const dataType of Object.keys(DEFAULTS)) {
        result[dataType] = getChatData(chatId, dataType);
    }
    return result;
}

/**
 * Set ALL data types for a specific chat at once.
 * Used for import operations and snapshot restoration.
 *
 * @param {string} chatId - The chat ID
 * @param {object} dataBundle - Object with data types as keys
 */
function setAllChatData(chatId, dataBundle) {
    if (!chatId || !dataBundle) return;

    const bucket = getChatBucket(chatId);
    for (const [dataType, value] of Object.entries(dataBundle)) {
        if (DEFAULTS[dataType] !== undefined) {
            bucket[dataType] = deepClone(value);
        }
    }
    persistSettings();
}

/**
 * Delete ALL data for a specific chat.
 * This is a full cleanup — removes the entire chat bucket.
 * Use with caution (e.g., when a chat is deleted).
 *
 * @param {string} chatId - The chat ID
 */
function deleteAllChatData(chatId) {
    if (!chatId) return;
    ensureNWSTStorage();
    delete getExtSettings()[MODULE_NAME].chatData[chatId];
    persistSettings();
}

/**
 * List all chat IDs that have NWST data stored.
 * Useful for diagnostics and data management.
 *
 * @returns {string[]} Array of chat IDs
 */
function listAllChats() {
    ensureNWSTStorage();
    return Object.keys(getExtSettings()[MODULE_NAME].chatData);
}

/**
 * Check if a chat has ANY NWST data stored.
 * Used to determine if batch scan has been run for this chat.
 *
 * @param {string} chatId - The chat ID
 * @returns {boolean} True if at least one data type exists
 */
function chatHasData(chatId) {
    if (!chatId) {
        console.log(`[NWST Storage] chatHasData: chatId is falsy, returning false`);
        return false;
    }
    ensureNWSTStorage();
    const chatData = getExtSettings()[MODULE_NAME].chatData;
    const bucket = chatData[chatId];
    if (!bucket) {
        console.log(`[NWST Storage] chatHasData: No bucket for chatId="${chatId}", returning false`);
        return false;
    }
    const keys = Object.keys(bucket);
    console.log(`[NWST Storage] chatHasData: chatId="${chatId}" bucket keys:`, keys, `(count=${keys.length})`);
    // Only count meaningful content keys — settingContext and snapshots are
    // auxiliary metadata that should NOT gate the batch scan check.
    const contentKeys = ['worldState', 'events', 'notebook', 'communities'];
    const hasContent = contentKeys.some(k => bucket[k] !== undefined);
    console.log(`[NWST Storage] chatHasData: returning ${hasContent} (content keys found: ${contentKeys.filter(k => bucket[k] !== undefined).join(', ') || 'none'})`);
    return hasContent;
}

// ── Exports ───────────────────────────────────────────────────────────────

export {
    // Core CRUD
    getChatData,
    setChatData,
    deleteChatData,
    chatDataExists,

    // Bulk operations
    getAllChatData,
    setAllChatData,
    deleteAllChatData,

    // Utilities
    listAllChats,
    chatHasData,

    // Defaults (exported so data modules can reference them)
    DEFAULT_WORLD_STATE,
    DEFAULT_EVENTS,
    DEFAULT_NOTEBOOK,
    DEFAULT_COMMUNITIES,
    DEFAULT_SETTING_CONTEXT,
    DEFAULT_SEASON_CONFIG,
    DEFAULT_CALENDAR_CONFIG,
    DEFAULT_SNAPSHOTS,
    DEFAULTS
};
