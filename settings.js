/* eslint-disable */
// =============================================================================
// NWST Settings Module — settings.js
// =============================================================================
// Handles loading and saving of GLOBAL extension settings.
// NOTE: settingContext is stored PER-CHAT (see data/worldState.js).
//
// Global settings (stored in extension_settings.nwst):
//   • enabled, scanPaused, debugMode
//   • connections (planningLLM, dayAdvancementLLM, narrativeConsistencyLLM)
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
    setSetting,
    defaultSettings
} from './index.js';

import {
    getAllChatData,
    setAllChatData,
    chatHasData
} from './data/storage.js';

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
 * @returns {{ planningLLM: string, dayAdvancementLLM: string, narrativeConsistencyLLM: string }}
 */
export function getConnectionProfiles() {
    return getSetting('connections');
}

/**
 * Get a specific connection profile ID.
 * @param {string} profileKey - 'planningLLM' | 'dayAdvancementLLM' | 'narrativeConsistencyLLM'
 * @returns {string} The profile ID (empty string if not set)
 */
export function getConnectionProfile(profileKey) {
    const conns = getConnectionProfiles();
    return conns[profileKey] || '';
}

/**
 * Set a specific connection profile ID.
 * @param {string} profileKey - 'planningLLM' | 'dayAdvancementLLM' | 'narrativeConsistencyLLM'
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

/** Get the planner prompt (the ONLY user-editable LLM prompt). @returns {string} */
export function getPlannerPrompt() { return getSetting('plannerPrompt'); }

/** Set the planner prompt. @param {string} prompt */
export function setPlannerPrompt(prompt) { setSetting('plannerPrompt', prompt); }

/** Reset the planner prompt to its default value. */
export function resetPlannerPrompt() {
    setSetting('plannerPrompt', defaultSettings.plannerPrompt);
}

/** Get the default planner prompt (for comparison / Reset button). @returns {string} */
export function getDefaultPlannerPrompt() { return defaultSettings.plannerPrompt; }

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
        plannerPrompt: getPlannerPrompt()
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
        if (imported.plannerPrompt !== undefined) setPlannerPrompt(imported.plannerPrompt);

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
export function importChatData(chatId, jsonString) {
    try {
        const data = JSON.parse(jsonString);
        if (typeof data !== 'object' || data === null) return false;
        setAllChatData(chatId, data);
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
    const bundle = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        globalSettings: JSON.parse(exportGlobalSettings()),
        chatData: getAllChatData(chatId)
    };
    return JSON.stringify(bundle, null, 2);
}

/**
 * Import a full bundle (global settings + current chat data).
 * Restores global settings AND overwrites the current chat's narrative data.
 *
 * @param {string} chatId - The current chat ID
 * @param {string} jsonString - The bundle JSON string
 * @returns {boolean} True on success
 */
export function importAll(chatId, jsonString) {
    try {
        const bundle = JSON.parse(jsonString);
        if (typeof bundle !== 'object' || bundle === null) return false;

        // Restore global settings
        if (bundle.globalSettings) {
            importGlobalSettings(JSON.stringify(bundle.globalSettings));
        }

        // Restore chat data
        if (bundle.chatData) {
            setAllChatData(chatId, bundle.chatData);
        }

        return true;
    } catch (e) {
        console.error('[NWST Settings] Import all failed:', e);
        return false;
    }
}
