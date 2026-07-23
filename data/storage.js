/* eslint-disable */
// =============================================================================
// NWST Storage Layer — data/storage.js
// =============================================================================
// This is the SINGLE POINT OF CONTACT for all NWST data persistence.
// Every read and write to extension data flows through this module.
//
// ── STORAGE ARCHITECTURE ──────────────────────────────────────────────────
//
//   GLOBAL SETTINGS (extensionSettings.nwst):
//     User preferences — connection profiles, scan frequency, injection
//     settings, internal planner prompt, enable/pause state.
//     Written via saveSettingsDebounced(). Shared across all chats.
//
//   PER-CHAT NARRATIVE DATA (chatMetadata):
//     World state, events, notebook, communities, snapshots, settingContext.
//     Written via saveMetadata() (async). Scoped to the active chat by ST.
//     Switching chats automatically changes chatMetadata — zero crossover.
//
//   WHY chatMetadata AND NOT extensionSettings:
//     - extensionSettings is a single global file. Storing per-chat narrative
//       data there causes it to bloat with every new RP — every save writes
//       the entire file. For users with many long chats this becomes painful.
//     - chatMetadata is saved per-chat. Only the active chat's data is
//       touched on each write. ST handles file management automatically.
//     - chatMetadata is the ST-documented mechanism for per-chat data.
//
// ── CRITICAL: chatMetadata reference changes on chat switch ───────────────
//   Never cache a reference to chatMetadata between operations.
//   Always call SillyTavern.getContext().chatMetadata fresh — it returns
//   the current chat's metadata object, which changes when the user switches
//   chats. Cached references will silently read/write the wrong chat's data.
//
// ── KEY PATTERN ───────────────────────────────────────────────────────────
//   chatMetadata["nwst:worldState"]
//   chatMetadata["nwst:events"]
//   chatMetadata["nwst:notebook"]
//   chatMetadata["nwst:communities"]
//   chatMetadata["nwst:settingContext"]
//   chatMetadata["nwst:snapshots"]
import { dlog } from "../lib/debug.js";
//   chatMetadata["nwst:seasonConfig"]
//   chatMetadata["nwst:calendarConfig"]
//
// ── ONE-TIME MIGRATION ────────────────────────────────────────────────────
//   On first load after this update, migrateLegacyData() checks whether the
//   current chat has data in the old extensionSettings.nwst.chatData[chatId]
//   location. If found, it copies it to chatMetadata and removes the old entry.
//   This preserves existing data for users who ran the earlier build.
// =============================================================================

const MODULE_NAME = 'nwst';

// ── Default data structures ───────────────────────────────────────────────

const DEFAULT_WORLD_STATE = {
    currentDay: {
        dateDisplay: '',
        dateSub: '',
        season: '',
        weatherToday: '',
        flora: '',
        fauna: '',
        spiritualClimate: '',
        lunarAngle: 0,
        dayCount: 0,
        elapsedStoryDays: 0
    },
    forecast: [],
    moonPhases: [],
    conditions: {
        political:     { enabled: true, content: '' },
        social:        { enabled: true, content: '' },
        spiritual:     { enabled: true, content: '' },
        environmental: { enabled: true, content: '' }
    }
};

const DEFAULT_EVENTS = [];

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

const DEFAULT_COMMUNITIES = [];
const DEFAULT_SETTING_CONTEXT = '';

const DEFAULT_SEASON_CONFIG = {
    mode: 'auto',
    yearLength: 365,
    seasons: [
        { name: 'Spring', startDay: 1,   endDay: 91  },
        { name: 'Summer', startDay: 92,  endDay: 185 },
        { name: 'Autumn', startDay: 186, endDay: 275 },
        { name: 'Winter', startDay: 276, endDay: 365 }
    ]
};

const DEFAULT_MOON_CONFIG = {
    enableMoons: true,
    enableMoonPhenomena: true,
    moonCycleDays: 29.53,
    moons: [
        { id: 'primary', name: 'The Moon', cycleDays: 29.53, enabled: true }
    ]
};

const DEFAULT_MOON_PHENOMENON_OVERRIDES = [];

const DEFAULT_CALENDAR_CONFIG = {
    enabled: false,
    months: 12,
    monthNames: ['January','February','March','April','May','June','July','August','September','October','November','December'],
    monthDays: [31,28,31,30,31,30,31,31,30,31,30,31],
    weekDays: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
    // Optional era label for CUSTOM calendars (e.g. "Third Age" or "Third Age {year}").
    // Substituted into the dateSub line by the deterministic date engine.
    eraName: '',
    // Leap-year toggle for the default (Gregorian) calendar — adds Feb 29 in
    // leap years so real-world dates stay true. Ignored by custom calendars.
    leapYears: true
};

// Player-pinned era label for REAL-WORLD calendars (e.g. "Meiji 12"). Set from
// Settings when the LLM read the era wrong or had nothing to read. Seeds the
// sub-date immediately; day advancement treats the era line as player-verified
// from then on (maintaining era-relative year numbers at rollovers). Custom
// calendars ignore this — their era comes from calendarConfig.eraName.
const DEFAULT_ERA_PIN = '';

// Starting Date is the elapsed-story-duration baseline. elapsedStoryDays is 0
// on this date and counts upward only as canonical story days pass. Legacy
// anchorDayCount/anchorDate fields are retained for backward compatibility with
// older exports and the Adopt Computed Dates debug tool; they do not drive the
// cyclical calendar. source 'scan' entries remain correctable, while a confirmed
// player entry locks.
const DEFAULT_START_DATE = null;

const DEFAULT_SNAPSHOTS = {};
const DEFAULT_ALIAS_REGISTRY = [];
const DEFAULT_SECRETS_SIDECAR_STATE = null;
const DEFAULT_SECRETS_META = {
    userCharacterName: '',
    userCharacterAliases: ''
};

const DEFAULTS = {
    worldState:     DEFAULT_WORLD_STATE,
    events:         DEFAULT_EVENTS,
    notebook:       DEFAULT_NOTEBOOK,
    communities:    DEFAULT_COMMUNITIES,
    settingContext: DEFAULT_SETTING_CONTEXT,
    seasonConfig:   DEFAULT_SEASON_CONFIG,
    calendarConfig: DEFAULT_CALENDAR_CONFIG,
    moonConfig:     DEFAULT_MOON_CONFIG,
    moonPhenomenonOverrides: DEFAULT_MOON_PHENOMENON_OVERRIDES,
    startDate:      DEFAULT_START_DATE,
    eraPin:         DEFAULT_ERA_PIN,
    snapshots:      DEFAULT_SNAPSHOTS,
    aliasRegistry:  DEFAULT_ALIAS_REGISTRY,
    secretsSidecarState: DEFAULT_SECRETS_SIDECAR_STATE,
    secretsMeta:    DEFAULT_SECRETS_META
};

// ── Internal helpers ──────────────────────────────────────────────────────

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Build the chatMetadata key for a given data type.
 * All NWST keys are prefixed with "nwst:" to avoid conflicts with other extensions.
 * @param {string} dataType
 * @returns {string}
 */
function metaKey(dataType) {
    return `${MODULE_NAME}:${dataType}`;
}

/**
 * Get the current chat's chatMetadata object from ST context.
 *
 * IMPORTANT: This must be called fresh on every operation.
 * The reference returned by getContext().chatMetadata changes when the
 * user switches chats. Never cache this reference between calls.
 *
 * @returns {object|null} The chatMetadata object, or null if unavailable
 */
function getChatMeta() {
    try {
        const { chatMetadata } = SillyTavern.getContext();
        return chatMetadata || null;
    } catch (e) {
        console.error('[NWST Storage] Could not access chatMetadata:', e);
        return null;
    }
}

/**
 * Persist the current chat's metadata to disk.
 * Must be called after every write to chatMetadata.
 * saveMetadata() is async — always await it.
 *
 * @returns {Promise<void>}
 */
async function persistMeta() {
    try {
        await SillyTavern.getContext().saveMetadata();
    } catch (e) {
        console.error('[NWST Storage] saveMetadata() failed:', e);
    }
}

// ── Public API ────────────────────────────────────────────────────────────
// The public signature (chatId, dataType) is preserved for compatibility
// with all callers in worldState.js, events.js, notebook.js, communities.js.
// The chatId parameter is accepted but no longer used as a storage key —
// chatMetadata is already scoped to the current chat by ST. The parameter
// is retained so calling code does not need to change.

/**
 * Get a specific data type for the current chat.
 * Returns a deep clone — mutations won't affect stored data.
 * Returns the appropriate default if no data exists yet.
 *
 * @param {string} chatId - Accepted for API compatibility; chatMetadata is already chat-scoped
 * @param {string} dataType - 'worldState' | 'events' | 'notebook' | 'communities' | 'settingContext' | 'snapshots' | 'seasonConfig' | 'calendarConfig'
 * @returns {*} The data (deep cloned), or default if not found
 */
function getChatData(chatId, dataType) {
    const meta = getChatMeta();
    if (!meta) return deepClone(DEFAULTS[dataType] ?? null);

    const stored = meta[metaKey(dataType)];
    if (stored === undefined || stored === null) {
        return deepClone(DEFAULTS[dataType] ?? null);
    }

    return deepClone(stored);
}

/**
 * Set (save) a specific data type for the current chat.
 * Deep clones the value before storing.
 * Automatically persists to disk via saveMetadata().
 *
 * @param {string} chatId - Accepted for API compatibility
 * @param {string} dataType
 * @param {*} value - JSON-serializable value to store
 * @returns {Promise<void>}
 */
async function setChatData(chatId, dataType, value) {
    const meta = getChatMeta();
    if (!meta) {
        console.error(`[NWST Storage] setChatData("${dataType}"): chatMetadata unavailable`);
        return;
    }

    meta[metaKey(dataType)] = deepClone(value);
    await persistMeta();
}

/**
 * Delete a specific data type for the current chat.
 * After deletion, getChatData returns the default value.
 *
 * @param {string} chatId - Accepted for API compatibility
 * @param {string} dataType
 * @returns {Promise<void>}
 */
async function deleteChatData(chatId, dataType) {
    const meta = getChatMeta();
    if (!meta) return;

    delete meta[metaKey(dataType)];
    await persistMeta();
}

/**
 * Check whether data exists for a given data type in the current chat.
 *
 * @param {string} chatId - Accepted for API compatibility
 * @param {string} dataType
 * @returns {boolean}
 */
function chatDataExists(chatId, dataType) {
    const meta = getChatMeta();
    if (!meta) return false;
    return meta[metaKey(dataType)] !== undefined;
}

/**
 * Get ALL data types for the current chat as a single bundle.
 * Used for export and snapshot operations.
 *
 * @param {string} chatId - Accepted for API compatibility
 * @returns {object}
 */
function getAllChatData(chatId) {
    const result = {};
    for (const dataType of Object.keys(DEFAULTS)) {
        result[dataType] = getChatData(chatId, dataType);
    }
    return result;
}

/**
 * Set ALL data types for the current chat at once.
 * Used for import operations and snapshot restoration.
 * Performs a single saveMetadata() call after all writes.
 *
 * @param {string} chatId - Accepted for API compatibility
 * @param {object} dataBundle - Object with data types as keys
 * @returns {Promise<void>}
 */
async function setAllChatData(chatId, dataBundle) {
    if (!dataBundle) return;

    const meta = getChatMeta();
    if (!meta) {
        console.error('[NWST Storage] setAllChatData: chatMetadata unavailable');
        return;
    }

    for (const [dataType, value] of Object.entries(dataBundle)) {
        if (DEFAULTS[dataType] !== undefined) {
            meta[metaKey(dataType)] = deepClone(value);
        }
    }

    await persistMeta();
}

/**
 * Delete ALL NWST data for the current chat.
 * Removes all nwst: prefixed keys from chatMetadata.
 *
 * @param {string} chatId - Accepted for API compatibility
 * @returns {Promise<void>}
 */
async function deleteAllChatData(chatId) {
    const meta = getChatMeta();
    if (!meta) return;

    for (const dataType of Object.keys(DEFAULTS)) {
        delete meta[metaKey(dataType)];
    }

    // Also clear standalone NWST metadata keys that aren't part of DEFAULTS.
    // Without this, clear-all would leave orphaned state — e.g. the notebook
    // undo history would still reference now-deleted bullets, and pressing Undo
    // could resurrect cleared data.
    const STANDALONE_KEYS = [
        'nwst:notebookHistory',
        'nwst:pendingEvents',
        'nwst:scannerState',
        'nwst:scansSinceReconcile'
    ];
    for (const key of STANDALONE_KEYS) {
        delete meta[key];
    }

    await persistMeta();
}

/**
 * Check if the current chat has ANY meaningful NWST content.
 * Used to determine whether batch scan has been run.
 * Ignores auxiliary keys (settingContext, snapshots) — only checks
 * content keys that batch scan actually populates.
 *
 * @param {string} chatId - Accepted for API compatibility
 * @returns {boolean}
 */
function chatHasData(chatId) {
    const meta = getChatMeta();
    if (!meta) {
        dlog('[NWST Storage] chatHasData: chatMetadata unavailable, returning false');
        return false;
    }

    const contentKeys = ['worldState', 'events', 'notebook', 'communities'];
    const found = contentKeys.filter(k => meta[metaKey(k)] !== undefined);

    dlog(`[NWST Storage] chatHasData: content keys found: ${found.join(', ') || 'none'}`);
    return found.length > 0;
}

/**
 * List all NWST data type keys present in the current chat's metadata.
 * Useful for diagnostics.
 *
 * @returns {string[]} Array of data type names (without the nwst: prefix)
 */
function listCurrentChatKeys() {
    const meta = getChatMeta();
    if (!meta) return [];

    const prefix = `${MODULE_NAME}:`;
    return Object.keys(meta)
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length));
}

// ── One-time migration from extensionSettings → chatMetadata ──────────────

/**
 * Migrate any existing per-chat data from the old extensionSettings storage
 * to the new chatMetadata storage. Runs once per chat per session, only if
 * old data is found. Safe to call repeatedly — it checks before acting.
 *
 * After migration, the old data is removed from extensionSettings to prevent
 * the settings file from continuing to bloat.
 *
 * @param {string} chatId - The current chat ID
 * @returns {Promise<boolean>} True if migration was performed
 */
async function migrateLegacyData(chatId) {
    if (!chatId) return false;

    try {
        const ctx = SillyTavern.getContext();
        const legacyBucket = ctx.extensionSettings?.[MODULE_NAME]?.chatData?.[chatId];

        if (!legacyBucket || Object.keys(legacyBucket).length === 0) {
            return false; // Nothing to migrate
        }

        dlog(`[NWST Storage] Migrating legacy data for chatId="${chatId}" from extensionSettings → chatMetadata...`);

        // Only migrate if the new location is empty (don't overwrite newer data)
        if (chatHasData(chatId)) {
            dlog('[NWST Storage] New storage already has data — skipping migration to avoid overwrite.');
            return false;
        }

        // Copy each data type to the new location
        await setAllChatData(chatId, legacyBucket);

        // Remove the old data from extensionSettings to stop settings file bloat
        delete ctx.extensionSettings[MODULE_NAME].chatData[chatId];

        // Clean up empty chatData container if nothing left
        if (Object.keys(ctx.extensionSettings[MODULE_NAME].chatData || {}).length === 0) {
            delete ctx.extensionSettings[MODULE_NAME].chatData;
        }

        ctx.saveSettingsDebounced();

        dlog(`[NWST Storage] Migration complete for chatId="${chatId}". Old data removed from extensionSettings.`);
        return true;

    } catch (e) {
        console.error('[NWST Storage] Migration failed (non-fatal):', e);
        return false;
    }
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
    listCurrentChatKeys,
    chatHasData,

    // Migration
    migrateLegacyData,

    // Defaults
    DEFAULT_WORLD_STATE,
    DEFAULT_EVENTS,
    DEFAULT_NOTEBOOK,
    DEFAULT_COMMUNITIES,
    DEFAULT_SETTING_CONTEXT,
    DEFAULT_SEASON_CONFIG,
    DEFAULT_CALENDAR_CONFIG,
    DEFAULT_MOON_CONFIG,
    DEFAULT_MOON_PHENOMENON_OVERRIDES,
    DEFAULT_START_DATE,
    DEFAULT_ERA_PIN,
    DEFAULT_SNAPSHOTS,
    DEFAULT_ALIAS_REGISTRY,
    DEFAULT_SECRETS_SIDECAR_STATE,
    DEFAULT_SECRETS_META,
    DEFAULTS
};
