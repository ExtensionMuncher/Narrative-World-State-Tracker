/* eslint-disable */
// =============================================================================
// NWST Settings Module — settings.js
// =============================================================================
// Handles loading and saving of GLOBAL extension settings.
// NOTE: settingContext is stored PER-CHAT (see data/worldState.js).
//
// Global settings (stored in extension_settings.nwst):
//   • enabled, scanPaused, debugMode
//   • connections (planningLLM, dayAdvancementLLM, narrativeConsistencyLLM, secretsSidecarLLM)
//   • scanFrequency
//   • injection settings
//   • plannerPrompt
//
// Import/Export:
//   • "Export All" = global settings + the CURRENT chat's data (one bundle)
//   • "Import All" = restore global settings + current chat's data from a bundle
//   • "Export Chat Data" = just the current chat's narrative data
//   • "Import Chat Data" = just narrative data into current chat
//   • "Export Global Settings" = settings only
//   • "Import Global Settings" = settings only
// =============================================================================

import {
    getSetting,
    setSetting
} from './index.js';

import {
    getAllChatData,
    setAllChatData
} from './data/storage.js';

// A handful of NWST runtime records intentionally live as standalone metadata
// rather than in storage.js's typed narrative bundle. Full Export All / Import
// All must still carry them or a restore can silently lose pending proposals,
// notebook history, or scanner cadence state.
const STANDALONE_CHAT_META_KEYS = [
    'nwst:notebookHistory',
    'nwst:pendingEvents',
    'nwst:scannerState',
    'nwst:scansSinceReconcile'
];

function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getActiveChatContext(expectedChatId, operation = 'operate on chat data') {
    try {
        const ctx = SillyTavern.getContext();
        const activeChatId = String(ctx?.chatId || '');
        if (!expectedChatId || activeChatId !== String(expectedChatId)) {
            console.warn(`[NWST Settings] Refused to ${operation}: active chat changed.`);
            return null;
        }
        return ctx;
    } catch (e) {
        console.warn(`[NWST Settings] Could not ${operation}:`, e);
        return null;
    }
}

function getStandaloneChatMeta(chatId) {
    try {
        const ctx = getActiveChatContext(chatId, 'export standalone chat metadata');
        if (!ctx) return {};
        const meta = ctx.chatMetadata || {};
        const out = {};
        for (const key of STANDALONE_CHAT_META_KEYS) {
            if (Object.prototype.hasOwnProperty.call(meta, key)) out[key] = cloneJson(meta[key]);
        }
        return out;
    } catch (e) {
        console.warn('[NWST Settings] Could not read standalone chat metadata for export:', e);
        return {};
    }
}

async function restoreStandaloneChatMeta(chatId, snapshot = {}) {
    const ctx = getActiveChatContext(chatId, 'restore standalone chat metadata');
    if (!ctx) return false;
    const meta = ctx.chatMetadata || {};
    // Full import is overwrite semantics. Clear current standalone NWST state
    // first so an older bundle that lacks these fields cannot leave unrelated
    // pending/scanner data from the destination chat behind.
    for (const key of STANDALONE_CHAT_META_KEYS) delete meta[key];
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        for (const key of STANDALONE_CHAT_META_KEYS) {
            if (Object.prototype.hasOwnProperty.call(snapshot, key)) meta[key] = cloneJson(snapshot[key]);
        }
    }
    if (!getActiveChatContext(chatId, 'finish restoring standalone chat metadata')) return false;
    await ctx.saveMetadata();
    return true;
}

// ── Core toggles ──────────────────────────────────────────────────────────

/** Check if the extension is enabled. @returns {boolean} */
export function isEnabled() { return getSetting('enabled'); }

/** Enable or disable the extension. @param {boolean} value */
export function setEnabled(value) { setSetting('enabled', value); }

/** Check if scanning is paused. @returns {boolean} */
export function isPaused() { return getSetting('scanPaused'); }

/** Pause or resume scanning. @param {boolean} value */
export function setPaused(value) { setSetting('scanPaused', value); }

/** Check if debug mode is on. @returns {boolean} */
export function isDebugMode() { return getSetting('debugMode'); }

/** Set debug mode. @param {boolean} value */
export function setDebugMode(value) { setSetting('debugMode', value); }

// ── Connection profiles ───────────────────────────────────────────────────

/**
 * Get all connection profile IDs.
 * @returns {{ planningLLM: string, dayAdvancementLLM: string, narrativeConsistencyLLM: string, secretsSidecarLLM: string }}
 */
export function getConnectionProfiles() {
    return getSetting('connections');
}

/**
 * Get a specific connection profile ID.
 * @param {string} profileKey - 'planningLLM' | 'dayAdvancementLLM' | 'narrativeConsistencyLLM' | 'secretsSidecarLLM'
 * @returns {string} The profile ID (empty string if not set)
 */
export function getConnectionProfile(profileKey) {
    const conns = getConnectionProfiles();
    return conns[profileKey] || '';
}

/**
 * Set a specific connection profile ID.
 * @param {string} profileKey - 'planningLLM' | 'dayAdvancementLLM' | 'narrativeConsistencyLLM' | 'secretsSidecarLLM'
 * @param {string} profileId - The connection profile ID from ST's connection manager
 */
export function setConnectionProfile(profileKey, profileId) {
    const conns = JSON.parse(JSON.stringify(getConnectionProfiles()));
    conns[profileKey] = profileId;
    setSetting('connections', conns);
}

// ── Scanner ───────────────────────────────────────────────────────────────

/** Get the scan frequency (messages between scans). @returns {number} */
export function getScanFrequency() { return getSetting('scanFrequency'); }

/** Set the scan frequency. @param {number} value */
export function setScanFrequency(value) { setSetting('scanFrequency', value); }

/** Get the minimum messages before the first scan fires (warmup floor). @returns {number} */
export function getScanMinimumMessages() { return getSetting('scanMinimumMessages'); }

/** Set the minimum messages floor. @param {number} value */
export function setScanMinimumMessages(value) { setSetting('scanMinimumMessages', Math.max(1, parseInt(value) || 10)); }

/** Get the snapshot retention target per chat. Protected landmarks are never pruned. @returns {number} */
export function getMaxSnapshotCount() { return getSetting('maxSnapshotCount') || 30; }

/** Set the snapshot retention target. @param {number} value */
export function setMaxSnapshotCount(value) { setSetting('maxSnapshotCount', Math.max(1, parseInt(value) || 30)); }

// ── Injection settings ────────────────────────────────────────────────────

/** Get all injection settings. @returns {object} */
export function getInjectionSettings() { return getSetting('injection'); }

/** Check if Current Day injection is enabled. @returns {boolean} */
export function isInjectCurrentDay() { return getSetting('injection').injectCurrentDay; }

/** Check if Events injection is enabled. @returns {boolean} */
export function isInjectEvents() { return getSetting('injection').injectEvents; }

/** Check if World Conditions injection is enabled. @returns {boolean} */
export function isInjectWorldConditions() { return getSetting('injection').injectWorldConditions; }

/** Get injection placement. @returns {string} 'before_main' | 'after_main' | 'top_an' | 'bottom_an' | 'at_depth' */
export function getInjectionPlacement() { return getSetting('injection').placement; }

/** Get injection depth (only used when placement is 'at_depth'). @returns {number} */
export function getInjectionDepth() { return getSetting('injection').depth; }

/** Get injection depth role. @returns {string} 'system' | 'user' | 'assistant' */
export function getInjectionDepthRole() { return getSetting('injection').depthRole; }

/** Get the current output density mode. @returns {'token-budget'|'combined'|'atmospheric'} */
export function getDensityMode() { return getSetting('injection').densityMode || 'combined'; }

/** Get maximum active events pool size. @returns {number} */
export function getMaxActiveEvents() { return getSetting('injection').maxActiveEvents ?? 12; }

/** Get the secret injection token budget cap. @returns {number} */
export function getSecretBudgetTokens() { return getSetting('injection').secretBudgetTokens ?? 600; }

/** Max number of secrets injected at once (hard count cap). @returns {number} */
export function getMaxSecretsInjected() { return getSetting('injection').maxSecretsInjected ?? 4; }

/** Secrets engine config object (cadence, threshold, weights). @returns {object} */
export function getSecretsConfig() {
    const s = getSetting('secrets') || {};
    return {
        sidecarCadence: s.sidecarCadence ?? 10,
        sidecarScanRange: s.sidecarScanRange ?? 5,
        injectionThreshold: s.injectionThreshold ?? 50,
        decayThreshold: s.decayThreshold ?? 250,
        reconcileCadence: s.reconcileCadence ?? 0,
        weights: s.weights ?? {}
    };
}

/** Sidecar cadence in messages. @returns {number} */
export function getSidecarCadence() { return getSecretsConfig().sidecarCadence; }

/** Number of recent prose messages the secrets sidecar and JS scanner inspect. @returns {number} */
export function getSidecarScanRange() { return getSecretsConfig().sidecarScanRange; }

/** Score threshold for injection eligibility. @returns {number} */
export function getInjectionThreshold() { return getSecretsConfig().injectionThreshold; }

/** Messages-since-injection before a secret is flagged dormant (0 = off). @returns {number} */
export function getSecretDecayThreshold() { const s = getSetting('secrets') || {}; return s.decayThreshold ?? 250; }

/** Auto-reconcile cadence in scans (0 = manual only). @returns {number} */
export function getReconcileCadence() { const s = getSetting('secrets') || {}; return s.reconcileCadence ?? 0; }

/** Scoring weights object. @returns {object} */
export function getScoringWeights() {
    const defaults = {
        knowerPresent: 30, unawarePresent: 20, bothPresent: 40, coPresenceOnly: 5, sharedThemeMatch: 5,
        npcCutawayHolder: 35, groupMatch: 25, anchorMatch: 20,
        revealConditionMatch: 35, pressureMatch: 25, continuityRisk: 45,
        priorityLow: -15, priorityNormal: 0, priorityHigh: 20, priorityCritical: 50
    };
    return { ...defaults, ...(getSecretsConfig().weights || {}) };
}

/** Update a single scoring weight. @param {string} key @param {number} value */
export function setScoringWeight(key, value) {
    const s = getSetting('secrets') || {};
    if (!s.weights) s.weights = {};
    s.weights[key] = value;
    setSetting('secrets', s);
}

/** Update a secrets config scalar (sidecarCadence, injectionThreshold). */
export function setSecretsConfigValue(key, value) {
    const s = getSetting('secrets') || {};
    s[key] = value;
    setSetting('secrets', s);
}

/** Set the secret injection token budget cap. @param {number} value */
export function setSecretBudgetTokens(value) { setInjectionSetting('secretBudgetTokens', Math.max(100, parseInt(value) || 600)); }

/**
 * Set a single injection setting.
 * @param {string} key - The injection sub-key
 * @param {*} value
 */
export function setInjectionSetting(key, value) {
    const inj = JSON.parse(JSON.stringify(getInjectionSettings()));
    inj[key] = value;
    setSetting('injection', inj);
}

// ── Planner prompt ────────────────────────────────────────────────────────

/**
 * Get the planner prompt. Read-only by design — the planner's job is too
 * broad for user edits to be safe, so no setter, reset, or UI exists and the
 * prompt is deliberately excluded from settings export/import.
 * @returns {string}
 */
export function getPlannerPrompt() { return getSetting('plannerPrompt'); }

// ── Import / Export — Global Settings Only ────────────────────────────────

/**
 * Export global settings as a JSON string.
 * These are user preferences, not narrative data.
 * @returns {string} JSON string
 */
export function exportGlobalSettings() {
    const settings = {
        enabled: isEnabled(),
        scanPaused: isPaused(),
        debugMode: isDebugMode(),
        connections: getConnectionProfiles(),
        scanFrequency: getScanFrequency(),
        injection: getInjectionSettings(),
        secrets: getSecretsConfig(),
        noThink: getSetting('noThink'),
        noThinkHard: getSetting('noThinkHard'),
        noThinkProfiles: getSetting('noThinkProfiles'),
        noThinkHardProfiles: getSetting('noThinkHardProfiles'),
        scanMinimumMessages: getScanMinimumMessages(),
        maxSnapshotCount: getMaxSnapshotCount(),
        eventCompactionThreshold: getSetting('eventCompactionThreshold'),
        autoPromoteEvents: getSetting('autoPromoteEvents'),
        eventValidityReview: getSetting('eventValidityReview'),
        moonCycleDays: getSetting('moonCycleDays'),
        enableMoons: getSetting('enableMoons'),
        moons: getSetting('moons'),
        enableMoonPhenomena: getSetting('enableMoonPhenomena')
    };
    return JSON.stringify(settings, null, 2);
}

/**
 * Import global settings from a JSON string.
 * Merges with existing — only overwrites keys present in the import.
 * @param {string} jsonString
 * @returns {boolean} True on success, false on parse error
 */
export function importGlobalSettings(jsonString) {
    try {
        const imported = JSON.parse(jsonString);
        if (typeof imported !== 'object' || imported === null) return false;

        if (imported.enabled !== undefined) setEnabled(imported.enabled);
        if (imported.scanPaused !== undefined) setPaused(imported.scanPaused);
        if (imported.debugMode !== undefined) setDebugMode(imported.debugMode);
        if (imported.connections) setSetting('connections', imported.connections);
        if (imported.scanFrequency !== undefined) setScanFrequency(imported.scanFrequency);
        if (imported.injection) setSetting('injection', imported.injection);
        if (imported.secrets) setSetting('secrets', imported.secrets);
        if (imported.noThink !== undefined) setSetting('noThink', imported.noThink);
        if (imported.noThinkHard !== undefined) setSetting('noThinkHard', imported.noThinkHard);
        if (imported.noThinkProfiles !== undefined) setSetting('noThinkProfiles', imported.noThinkProfiles);
        if (imported.noThinkHardProfiles !== undefined) setSetting('noThinkHardProfiles', imported.noThinkHardProfiles);
        if (imported.scanMinimumMessages !== undefined) setScanMinimumMessages(imported.scanMinimumMessages);
        if (imported.maxSnapshotCount !== undefined) setMaxSnapshotCount(imported.maxSnapshotCount);
        if (imported.eventCompactionThreshold !== undefined) setSetting('eventCompactionThreshold', imported.eventCompactionThreshold);
        if (imported.autoPromoteEvents !== undefined) setSetting('autoPromoteEvents', imported.autoPromoteEvents);
        if (imported.eventValidityReview !== undefined) setSetting('eventValidityReview', imported.eventValidityReview);
        if (imported.moonCycleDays !== undefined) setSetting('moonCycleDays', imported.moonCycleDays);
        if (imported.enableMoons !== undefined) setSetting('enableMoons', imported.enableMoons);
        if (imported.moons !== undefined) setSetting('moons', imported.moons);
        if (imported.enableMoonPhenomena !== undefined) setSetting('enableMoonPhenomena', imported.enableMoonPhenomena);

        return true;
    } catch (e) {
        console.error('[NWST Settings] Import global settings failed:', e);
        return false;
    }
}

// ── Import / Export — Chat Data Only ──────────────────────────────────────

/**
 * Export the CURRENT chat's narrative data as a JSON string.
 * Includes: worldState, events, notebook, communities, settingContext, snapshots.
 * @param {string} chatId - The current chat ID
 * @returns {string} JSON string
 */
export function exportChatData(chatId) {
    const data = getAllChatData(chatId);
    return JSON.stringify(data, null, 2);
}

/**
 * Import narrative data for the CURRENT chat from a JSON string.
 * OVERWRITES existing data for this chat.
 * @param {string} chatId
 * @param {string} jsonString
 * @returns {boolean} True on success
 */
export async function importChatData(chatId, jsonString) {
    try {
        if (!getActiveChatContext(chatId, 'import chat data')) return false;
        const data = JSON.parse(jsonString);
        if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
        await setAllChatData(chatId, data);
        if (!getActiveChatContext(chatId, 'finish importing chat data')) return false;
        return true;
    } catch (e) {
        console.error('[NWST Settings] Import chat data failed:', e);
        return false;
    }
}

// ── Import / Export — All (Global + Current Chat) ─────────────────────────

/**
 * Export ALL relevant data as a single JSON bundle.
 * Contains: global settings + the CURRENT chat's narrative data.
 * This is a complete snapshot of the extension state for this chat.
 *
 * @param {string} chatId - The current chat ID
 * @returns {string} JSON string
 */
export function exportAll(chatId) {
    try {
        if (!getActiveChatContext(chatId, 'export all data')) return null;
        const bundle = {
            version: '1.0.2',
            exportedAt: new Date().toISOString(),
            globalSettings: JSON.parse(exportGlobalSettings()),
            chatData: getAllChatData(chatId),
            standaloneChatMeta: getStandaloneChatMeta(chatId)
        };
        return JSON.stringify(bundle, null, 2);
    } catch (e) {
        console.error('[NWST Settings] Export all failed:', e);
        return null;
    }
}

/**
 * Import a full bundle (global settings + current chat data).
 * Restores global settings AND overwrites the current chat's narrative data.
 *
 * @param {string} chatId - The current chat ID
 * @param {string} jsonString - The bundle JSON string
 * @returns {boolean} True on success
 */
export async function importAll(chatId, jsonString) {
    try {
        if (!getActiveChatContext(chatId, 'import all data')) return false;
        const bundle = JSON.parse(jsonString);
        if (typeof bundle !== 'object' || bundle === null) {
            console.error('[NWST Settings] Import all: parsed bundle is not an object');
            return false;
        }

        // Restore global settings
        if (bundle.globalSettings) {
            importGlobalSettings(JSON.stringify(bundle.globalSettings));
        }

        // Restore chat data — MUST await the async write or the success toast
        // fires before data is actually persisted (and failures stay silent).
        if (bundle.chatData) {
            await setAllChatData(chatId, bundle.chatData);
            if (!getActiveChatContext(chatId, 'continue importing all data')) return false;
            const restoredMeta = await restoreStandaloneChatMeta(chatId, bundle.standaloneChatMeta || {});
            if (!restoredMeta) return false;
        }

        return Boolean(getActiveChatContext(chatId, 'finish importing all data'));
    } catch (e) {
        console.error('[NWST Settings] Import all failed:', e);
        return false;
    }
}
