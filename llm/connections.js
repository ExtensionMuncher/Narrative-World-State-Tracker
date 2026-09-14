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
//      (planningLLM, dayAdvancementLLM, narrativeConsistencyLLM, hiddenIntentionsLLM)
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
import { nwstToast } from '../utils.js';
import { dlog } from "../lib/debug.js";

// ── Per-session warning tracker ───────────────────────────────────────────
// Track which roles we've already warned about this session so we don't
// spam the user with the same toast on every scanner tick.
const warnedRoles = new Set();
const identicalRequestsInFlight = new Map();

function requestFingerprint(profileId, messages, maxTokens, softOn, hardOn) {
    const source = `${profileId}|${maxTokens || ''}|${softOn ? 1 : 0}|${hardOn ? 1 : 0}|${JSON.stringify(messages)}`;
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `${profileId}:${source.length}:${hash >>> 0}`;
}

// ── Connection profile availability ──────────────────────────────────────

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
 * @param {string} profileKey - 'planningLLM' | 'dayAdvancementLLM' | 'narrativeConsistencyLLM' | 'secretsSidecarLLM' | 'hiddenIntentionsLLM'
 * @returns {object|null} The resolved profile object, or null if unavailable
 */
export function resolveProfile(profileKey) {
    const roleLabel = getRoleLabel(profileKey);
    const configuredId = getConnectionProfile(profileKey);

    // Hidden Intentions can deliberately inherit the Planning profile so the
    // feature does not force a fifth connection unless the user wants one.
    if (profileKey === 'hiddenIntentionsLLM' && configuredId === '__planning__') {
        const inherited = resolveProfile('planningLLM');
        if (inherited) dlog(`[NWST Connections] hiddenIntentionsLLM: inheriting Planning profile "${inherited.name}" (${inherited.id})`);
        return inherited;
    }

    // No profile configured for this role at all
    if (!configuredId) {
        if (!warnedRoles.has(`unconfigured:${profileKey}`)) {
            warnedRoles.add(`unconfigured:${profileKey}`);
            dlog(`[NWST Connections] ${profileKey}: no profile configured.`);
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
            dlog(`[NWST Connections] ${profileKey}: configured profile "${configuredId}" no longer exists.`);
            nwstToast(
                `NWST: The ${roleLabel} profile "${configuredId}" no longer exists. ` +
                `This feature will be skipped until you update it in Settings → Connection Profiles.`,
                'warning'
            );
        }
        return null;
    }

    // Profile found and valid
    dlog(`[NWST Connections] ${profileKey}: using profile "${profile.name}" (${profile.id})`);
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
        case 'secretsSidecarLLM':       return 'Secrets Sidecar LLM';
        case 'hiddenIntentionsLLM':      return 'Hidden Intentions LLM';
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
function flattenConnectionText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.map(item => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return '';
            return flattenConnectionText(item.text ?? item.content ?? item.output_text ?? item.value);
        }).filter(Boolean).join('');
    }
    if (value && typeof value === 'object') {
        return flattenConnectionText(value.text ?? value.content ?? value.output_text ?? value.value);
    }
    return '';
}

function extractConnectionResponseText(response) {
    if (typeof response === 'string') return response;
    if (!response || typeof response !== 'object') return '';

    const direct = [
        response.content,
        response.text,
        response.response,
        response.output_text,
        response.generated_text,
        response.message?.content,
        response.data?.content,
        response.data?.text,
        response.data?.response,
        response.result?.content,
        response.result?.text,
        response.result?.response,
        response.choices?.[0]?.message?.content,
        response.choices?.[0]?.text,
        response.data?.choices?.[0]?.message?.content,
        response.data?.choices?.[0]?.text,
    ];
    for (const value of direct) {
        const text = flattenConnectionText(value);
        if (text.length) return text;
    }
    return '';
}

function firstNonEmptyString(values = []) {
    for (const value of values) {
        const text = flattenConnectionText(value);
        if (text.trim()) return text;
    }
    return '';
}

function extractConnectionResponseMetadata(response, content = '') {
    if (!response || typeof response !== 'object') {
        return {
            reasoning: '',
            finishReason: '',
            completionTokens: null,
            reasoningTokens: null,
            reasoningExhausted: false
        };
    }

    const reasoning = firstNonEmptyString([
        response.reasoning_content,
        response.reasoning,
        response.message?.reasoning_content,
        response.message?.reasoning,
        response.data?.reasoning_content,
        response.data?.reasoning,
        response.result?.reasoning_content,
        response.result?.reasoning,
        response.choices?.[0]?.message?.reasoning_content,
        response.choices?.[0]?.message?.reasoning,
        response.data?.choices?.[0]?.message?.reasoning_content,
        response.data?.choices?.[0]?.message?.reasoning,
    ]);
    const finishReason = firstNonEmptyString([
        response.finish_reason,
        response.finishReason,
        response.stop_reason,
        response.stopReason,
        response.choices?.[0]?.finish_reason,
        response.choices?.[0]?.stop_reason,
        response.data?.choices?.[0]?.finish_reason,
        response.data?.choices?.[0]?.stop_reason,
    ]);
    const usage = response.usage || response.data?.usage || response.result?.usage || {};
    const completionTokens = Number.isFinite(Number(usage.completion_tokens ?? usage.output_tokens))
        ? Number(usage.completion_tokens ?? usage.output_tokens)
        : null;
    const reasoningTokens = Number.isFinite(Number(
        usage.reasoning_tokens
        ?? usage.completion_tokens_details?.reasoning_tokens
        ?? usage.output_tokens_details?.reasoning_tokens
    ))
        ? Number(
            usage.reasoning_tokens
            ?? usage.completion_tokens_details?.reasoning_tokens
            ?? usage.output_tokens_details?.reasoning_tokens
        )
        : null;
    const stoppedForLength = /(?:length|max[_\s-]?(?:tokens?|output)|token[_\s-]?limit)/i.test(finishReason);
    const reasoningExhausted = !String(content || '').trim() && !!reasoning.trim() && stoppedForLength;
    return { reasoning, finishReason, completionTokens, reasoningTokens, reasoningExhausted };
}

function connectionResponseDiagnostic(response, metadata = {}) {
    if (response == null) return 'no response object';
    if (typeof response === 'string') return `string response (${response.length} chars)`;
    if (typeof response !== 'object') return `${typeof response} response`;
    const keys = Object.keys(response).slice(0, 16);
    const status = response.status ?? response.statusCode ?? response.code ?? response.data?.status ?? '';
    const errorValue = response.error?.message ?? response.error ?? response.data?.error?.message ?? response.data?.error ?? '';
    const message = typeof response.message === 'string' ? response.message : '';
    const parts = [`object keys=[${keys.join(', ')}]`];
    if (status !== '') parts.push(`status=${String(status).slice(0, 120)}`);
    if (errorValue) parts.push(`error=${String(errorValue).slice(0, 350)}`);
    if (message) parts.push(`message=${message.slice(0, 350)}`);
    if (metadata.finishReason) parts.push(`finish_reason=${metadata.finishReason.slice(0, 120)}`);
    if (metadata.reasoning) parts.push(`reasoning=${metadata.reasoning.length} chars`);
    if (metadata.completionTokens != null) parts.push(`completion_tokens=${metadata.completionTokens}`);
    if (metadata.reasoningTokens != null) parts.push(`reasoning_tokens=${metadata.reasoningTokens}`);
    if (metadata.reasoningExhausted) parts.push('reasoning_exhausted=true');
    return parts.join('; ');
}

/**
 * Detailed variant used by long-running migrations that need to distinguish a
 * real empty model answer from a transport/provider failure. Existing callers
 * can continue using generateWithProfile(), which returns only the text.
 */
export async function generateWithProfileDetailed(profile, messages, options = {}) {
    const requestChars = (messages || []).reduce((sum, item) => sum + String(item?.content || '').length, 0);
    if (!profile?.id) {
        const error = new Error('Invalid or null connection profile.');
        console.error('[NWST Connections] generateWithProfileDetailed:', error.message);
        return { content: '', error, empty: true, requestChars, diagnostic: error.message };
    }

    if (!messages?.length) {
        const error = new Error('No messages were provided to the connection request.');
        console.error('[NWST Connections] generateWithProfileDetailed:', error.message);
        return { content: '', error, empty: true, requestChars, diagnostic: error.message };
    }

    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.ConnectionManagerRequestService) {
            const error = new Error('ConnectionManagerRequestService is unavailable.');
            console.error('[NWST Connections]', error.message);
            nwstToast(
                'NWST: Cannot call LLM — connection-manager extension is required. ' +
                'Please enable it in ST Extensions.',
                'error'
            );
            return { content: '', error, empty: true, requestChars, diagnostic: error.message };
        }

        dlog(`[NWST Connections] Calling LLM: profile="${profile.name || profile.id}" api="${profile.api || 'unknown'}" request=${requestChars} chars`);

        const s = ctx.extensionSettings?.nwst || {};
        const softMap = (s.noThinkProfiles && typeof s.noThinkProfiles === 'object') ? s.noThinkProfiles : null;
        const hardMap = (s.noThinkHardProfiles && typeof s.noThinkHardProfiles === 'object') ? s.noThinkHardProfiles : null;
        const forceNoThink = options.forceNoThink === true;
        const softOn = forceNoThink || (softMap ? !!softMap[profile.id] : !!s.noThink);
        const hardOn = forceNoThink || (hardMap ? !!hardMap[profile.id] : !!s.noThinkHard);

        let outMessages = messages;
        try {
            if (softOn) {
                outMessages = messages.map(m => ({ ...m }));
                let idx = -1;
                for (let i = outMessages.length - 1; i >= 0; i--) {
                    if (outMessages[i].role === 'user') { idx = i; break; }
                }
                if (idx >= 0) outMessages[idx].content = (outMessages[idx].content || '') + '\n\n/no_think';
                else outMessages.push({ role: 'user', content: '/no_think' });
            }
        } catch (e) { dlog('[NWST] no_think injection skipped:', e); }

        const overridePayload = {};
        if (hardOn) {
            overridePayload.think = false;
            overridePayload.enable_thinking = false;
            overridePayload.chat_template_kwargs = { enable_thinking: false };
        }

        const __nwstSend = () => ctx.ConnectionManagerRequestService.sendRequest(
            profile.id,
            outMessages,
            options.maxTokens,
            { extractData: true, includePreset: true, stream: false },
            overridePayload
        );
        const fingerprint = requestFingerprint(profile.id, outMessages, options.maxTokens, softOn, hardOn);
        let requestPromise = identicalRequestsInFlight.get(fingerprint);
        if (!requestPromise) {
            requestPromise = Promise.resolve(__nwstSend());
            identicalRequestsInFlight.set(fingerprint, requestPromise);
            requestPromise.finally(() => {
                if (identicalRequestsInFlight.get(fingerprint) === requestPromise) identicalRequestsInFlight.delete(fingerprint);
            }).catch(() => undefined);
        } else {
            dlog('[NWST Connections] Coalesced an identical in-flight request to prevent duplicate model charges.');
        }
        const response = await requestPromise;

        const content = extractConnectionResponseText(response);
        const metadata = extractConnectionResponseMetadata(response, content);
        const diagnostic = connectionResponseDiagnostic(response, metadata);
        dlog(`[NWST Connections] Response received (${content.length} chars); ${diagnostic}`);
        if (!content.trim()) {
            const reason = metadata.reasoningExhausted
                ? 'Model exhausted its completion budget in reasoning before emitting visible text'
                : 'Connection returned no model text';
            const error = new Error(`${reason} (${diagnostic}).`);
            return {
                content: '',
                error,
                empty: true,
                requestChars,
                diagnostic,
                rawResponse: response,
                ...metadata
            };
        }
        return { content, error: null, empty: false, requestChars, diagnostic, rawResponse: response, ...metadata };
    } catch (err) {
        console.error('[NWST Connections] LLM call failed:', err);
        return {
            content: '',
            error: err instanceof Error ? err : new Error(String(err)),
            empty: true,
            requestChars,
            diagnostic: String(err?.message || err || 'Unknown connection failure').slice(0, 500)
        };
    }
}

export async function generateWithProfile(profile, messages, options = {}) {
    const result = await generateWithProfileDetailed(profile, messages, options);
    return result.content || '';
}
