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
        const ctx = SillyTavern.getContext();
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
        const ctx = SillyTavern.getContext();
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
        const ctx = SillyTavern.getContext();
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
        const ctx = SillyTavern.getContext();
        return ctx.extensionSettings?.connectionManager?.selectedProfile || null;
    } catch (e) {
        return null;
    }
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

// ── LLM call via connection profile ────────────────────────────────────────

/**
 * Call an LLM using a specific connection profile.
 *
 * Uses ST's ConnectionManagerRequestService.sendRequest() which handles ALL
 * profile-specific settings (endpoint, API key, model, preset, etc.) WITHOUT
 * modifying any global ST state. This is the correct way to call a different
 * LLM profile than the chat's currently active profile.
 *
 * Previously, NWST called generateRaw() with positional arguments, which broke
 * when ST refactored generateRaw to use a single options object. Additionally,
 * generateRaw() with api=null falls back to main_api (the chat's active profile),
 * ignoring the NWST-configured profile entirely.
 *
 * This helper fixes both issues by using the connection-manager's dedicated
 * profile-aware request service.
 *
 * @param {object} profile - Connection profile object (from resolveProfile)
 * @param {Array<{role:string, content:string}>} messages - Message array for the LLM
 * @param {object} [options] - Optional settings
 * @param {number} [options.maxTokens] - Max response tokens (undefined = let API decide its default)
 * @returns {Promise<string>} The LLM response text, or empty string on failure
 */
export async function generateWithProfile(profile, messages, options = {}) {
    const { maxTokens } = options;

    if (!profile || !profile.id) {
        console.error('[NWST Connections] generateWithProfile: invalid profile', profile);
        return '';
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        console.error('[NWST Connections] generateWithProfile: no messages provided');
        return '';
    }

    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.ConnectionManagerRequestService) {
            console.error('[NWST Connections] ConnectionManagerRequestService not available — is connection-manager disabled?');
            return '';
        }

        console.log(`[NWST Connections] Calling LLM with profile: ${profile.name || profile.id} (${profile.api || 'unknown API'})`);

        const response = await ctx.ConnectionManagerRequestService.sendRequest(
            profile.id,
            messages,
            maxTokens,
            { extractData: true, includePreset: true, stream: false },
        );

        const result = response?.content || '';
        console.log(`[NWST Connections] LLM response received (${result.length} chars)`);
        return result;

    } catch (err) {
        console.error('[NWST Connections] LLM call failed:', err);
        return '';
    }
}

