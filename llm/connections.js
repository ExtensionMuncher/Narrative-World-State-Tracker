/* eslint-disable */
// =============================================================================
// NWST Connection Profiles — llm/connections.js
// =============================================================================
// Provides helpers for reading ST's connection profile system.
// All other LLM modules use this to resolve which API/profile to call.
//
// ST's connection manager stores profiles in:
//   extension_settings.connectionManager.profiles[]
//
// Each profile has: { id, name, api, mode, preset, ... }
// =============================================================================

import { getContext } from '../../../../../script.js';
import { getConnectionProfile } from '../settings.js';
import { nwstToast } from '../index.js';

// ── Check if connection profiles are available ────────────────────────────

/**
 * Check whether ST's connection-manager extension is active.
 * Connection profiles are only available if this extension is enabled.
 * @returns {boolean}
 */
export function areConnectionProfilesAvailable() {
    try {
        const ctx = getContext();
        if (!ctx || !ctx.extensionSettings) return false;
        const disabledExtensions = ctx.extensionSettings.disabledExtensions || [];
        if (disabledExtensions.includes('connection-manager')) return false;
        return !!(ctx.extensionSettings.connectionManager?.profiles);
    } catch (e) {
        console.warn('[NWST Connections] Could not check connection profiles:', e);
        return false;
    }
}

/**
 * Get all available connection profiles from ST.
 * @returns {object[]} Array of profile objects { id, name, api, mode, ... }
 */
export function getAllProfiles() {
    try {
        const ctx = getContext();
        return ctx.extensionSettings?.connectionManager?.profiles || [];
    } catch (e) {
        console.error('[NWST Connections] Error getting profiles:', e);
        return [];
    }
}

/**
 * Get a specific connection profile by ID.
 * @param {string} profileId
 * @returns {object|null} The profile object, or null if not found
 */
export function getProfileById(profileId) {
    if (!profileId) return null;
    const profiles = getAllProfiles();
    return profiles.find(p => p.id === profileId || p.name === profileId) || null;
}

/**
 * Resolve which connection profile to use for a given LLM role.
 * Falls back to the current chat profile if the specified profile is not set
 * or not available.
 *
 * @param {string} profileKey - 'planningLLM' | 'dayAdvancementLLM' | 'narrativeConsistencyLLM'
 * @returns {object|null} The resolved profile, or null if no profile is available
 */
export function resolveProfile(profileKey) {
    const profileId = getConnectionProfile(profileKey);

    // If a specific profile is set and valid, use it
    if (profileId) {
        const profile = getProfileById(profileId);
        if (profile) {
            console.log(`[NWST Connections] Using ${profileKey} profile: ${profile.name} (${profile.id})`);
            return profile;
        }
        console.warn(`[NWST Connections] ${profileKey} profile "${profileId}" not found — falling back to current chat profile.`);
    }

    // Fall back to the currently selected chat profile
    try {
        const ctx = getContext();
        const currentProfileId = ctx.extensionSettings?.connectionManager?.selectedProfile;
        if (currentProfileId) {
            const fallbackProfile = getProfileById(currentProfileId);
            if (fallbackProfile) {
                console.log(`[NWST Connections] Using current chat profile for ${profileKey}: ${fallbackProfile.name}`);
                return fallbackProfile;
            }
        }
    } catch (e) {
        // Fallback failed, return null
    }

    console.error(`[NWST Connections] No connection profile available for ${profileKey}.`);
    return null;
}

/**
 * Get the current chat's selected profile ID (the one used for normal chat).
 * @returns {string|null}
 */
export function getCurrentChatProfileId() {
    try {
        const ctx = getContext();
        return ctx.extensionSettings?.connectionManager?.selectedProfile || null;
    } catch (e) {
        return null;
    }
}

/**
 * Get the list of profile names for dropdown display.
 * @returns {string[]} Array of profile names
 */
export function getProfileNames() {
    return getAllProfiles().map(p => p.name);
}

/**
 * Validate that a profile ID is still valid (hasn't been deleted since saved).
 * @param {string} profileId
 * @returns {boolean}
 */
export function isProfileValid(profileId) {
    if (!profileId) return false;
    return !!getProfileById(profileId);
}

/**
 * Get the API type string for a profile (e.g., 'openai', 'textgenerationwebui', 'kobold').
 * @param {object} profile - The profile object
 * @returns {string} API type identifier
 */
export function getProfileApiType(profile) {
    if (!profile) return 'unknown';
    return profile.api || profile.mode || 'unknown';
}
