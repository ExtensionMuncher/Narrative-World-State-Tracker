/* eslint-disable */
// =============================================================================
// NWST Connection Profiles — llm/connections.js
// =============================================================================
// Provides helpers for reading ST's connection profile system and calling
// LLMs via the correct profile.
//
// All LLM modules use resolveProfile() to determine which profile to use.
//
// PROFILE RESOLUTION PRIORITY:
//   1. The specific NWST profile configured in Settings for this role
//      (planningLLM, dayAdvancementLLM, narrativeConsistencyLLM)
//   2. If not configured OR if the saved profile no longer exists:
//      → WARN the user via toast (once per session per role)
//      → Fall back to the current chat's active connection profile
//
// WHY WE WARN EXPLICITLY:
//   Silent fallback to the main chat profile means scanner calls and
//   day advancement calls quietly hit the user's main model without them
//   knowing. In a long session this burns tokens unexpectedly. The warning
//   ensures the user knows to configure profiles in Settings.
// =============================================================================

import { getConnectionProfile } from '../settings.js';
import { nwstToast } from '../utils.js';;

// ── Per-session warning tracker ───────────────────────────────────────────
// Track which roles we've already warned about this session so we don't
// spam the user with the same toast on every scanner tick.
const warnedRoles = new Set();

// ── Connection profile availability ──────────────────────────────────────

/**
 * Check whether ST's connection-manager extension is active and has profiles.
 * @returns {boolean}
 */
export function areConnectionProfilesAvailable() {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx?.extensionSettings) return false;
        const disabled = ctx.extensionSettings.disabledExtensions || [];
        if (disabled.includes('connection-manager')) return false;
        return !!(ctx.extensionSettings.connectionManager?.profiles?.length);
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
        return SillyTavern.getContext().extensionSettings?.connectionManager?.profiles || [];
    } catch (e) {
        console.error('[NWST Connections] Error getting profiles:', e);
        return [];
    }
}

/**
 * Get a specific connection profile by ID or name.
 * @param {string} profileId
 * @returns {object|null}
 */
export function getProfileById(profileId) {
    if (!profileId) return null;
    const profiles = getAllProfiles();
    return profiles.find(p => p.id === profileId || p.name === profileId) || null;
}

/**
 * Get the ID of the current chat's active connection profile.
 * This is the profile ST is using for normal chat messages.
 * @returns {string|null}
 */
export function getCurrentChatProfileId() {
    try {
        return SillyTavern.getContext().extensionSettings?.connectionManager?.selectedProfile || null;
    } catch (e) {
        return null;
    }
}

/**
 * Check if a profile ID is still valid (not deleted since it was saved).
 * @param {string} profileId
 * @returns {boolean}
 */
export function isProfileValid(profileId) {
    if (!profileId) return false;
    return !!getProfileById(profileId);
}

// ── Profile resolution ────────────────────────────────────────────────────

/**
 * Resolve which connection profile to use for a given LLM role.
 *
 * Priority:
 *   1. The NWST-configured profile for this role (from Settings)
 *   2. Fallback to the current chat profile, WITH a warning toast
 *
 * The warning toast fires once per role per session. After the first warning,
 * subsequent calls for that role fall back silently to avoid spam.
 *
 * Returns null only if NO profiles exist at all (connection-manager disabled
 * or no profiles configured). Callers must handle null by skipping the LLM call.
 *
 * @param {string} profileKey - 'planningLLM' | 'dayAdvancementLLM' | 'narrativeConsistencyLLM'
 * @returns {object|null} The resolved profile object, or null if unavailable
 */
export function resolveProfile(profileKey) {
    const roleLabel = getRoleLabel(profileKey);
    const configuredId = getConnectionProfile(profileKey);

    // No profile configured for this role at all
    if (!configuredId) {
        if (!warnedRoles.has(`unconfigured:${profileKey}`)) {
            warnedRoles.add(`unconfigured:${profileKey}`);
            console.warn(`[NWST Connections] ${profileKey}: no profile configured.`);
            nwstToast(
                `NWST: No ${roleLabel} profile is configured. ` +
                `This feature will be skipped until you set one in Settings → Connection Profiles.`,
                'warning'
            );
        }
        return null;
    }

    // Profile is configured but no longer exists (was deleted in ST)
    const profile = getProfileById(configuredId);
    if (!profile) {
        if (!warnedRoles.has(`missing:${profileKey}`)) {
            warnedRoles.add(`missing:${profileKey}`);
            console.warn(`[NWST Connections] ${profileKey}: configured profile "${configuredId}" no longer exists.`);
            nwstToast(
                `NWST: The ${roleLabel} profile "${configuredId}" no longer exists. ` +
                `This feature will be skipped until you update it in Settings → Connection Profiles.`,
                'warning'
            );
        }
        return null;
    }

    // Profile found and valid
    console.log(`[NWST Connections] ${profileKey}: using profile "${profile.name}" (${profile.id})`);
    return profile;
}

/**
 * Get a human-readable label for a profile role key.
 * Used in warning messages.
 * @param {string} profileKey
 * @returns {string}
 */
function getRoleLabel(profileKey) {
    switch (profileKey) {
        case 'planningLLM':             return 'Planning LLM';
        case 'dayAdvancementLLM':       return 'Day Advancement LLM';
        case 'narrativeConsistencyLLM': return 'Narrative Consistency LLM';
        default:                        return profileKey;
    }
}

/**
 * Reset the per-session warning tracker.
 * Call this on chat change so warnings re-fire if profiles are still missing
 * in the new chat's context.
 */
export function resetProfileWarnings() {
    warnedRoles.clear();
}

// ── LLM call via connection profile ──────────────────────────────────────

/**
 * Call an LLM using a specific connection profile via ST's native
 * ConnectionManagerRequestService.
 *
 * This is the only correct way to call a different LLM profile than the
 * chat's currently active one. It does NOT modify any global ST state —
 * settings, API, model, preset are all governed by the profile itself.
 *
 * @param {object} profile - Connection profile object (from resolveProfile)
 * @param {Array<{role: string, content: string}>} messages - Message array
 * @param {object} [options]
 * @param {number} [options.maxTokens] - Max response tokens
 * @returns {Promise<string>} LLM response text, or '' on failure
 */
export async function generateWithProfile(profile, messages, options = {}) {
    if (!profile?.id) {
        console.error('[NWST Connections] generateWithProfile: invalid or null profile');
        return '';
    }

    if (!messages?.length) {
        console.error('[NWST Connections] generateWithProfile: no messages provided');
        return '';
    }

    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.ConnectionManagerRequestService) {
            console.error(
                '[NWST Connections] ConnectionManagerRequestService not available. ' +
                'Is the connection-manager extension enabled?'
            );
            nwstToast(
                'NWST: Cannot call LLM — connection-manager extension is required. ' +
                'Please enable it in ST Extensions.',
                'error'
            );
            return '';
        }

        console.log(`[NWST Connections] Calling LLM: profile="${profile.name || profile.id}" api="${profile.api || 'unknown'}"`);

        const response = await ctx.ConnectionManagerRequestService.sendRequest(
            profile.id,
            messages,
            options.maxTokens,
            { extractData: true, includePreset: true, stream: false }
        );

        const result = response?.content || '';
        console.log(`[NWST Connections] Response received (${result.length} chars)`);
        return result;

    } catch (err) {
        console.error('[NWST Connections] LLM call failed:', err);
        return '';
    }
}
