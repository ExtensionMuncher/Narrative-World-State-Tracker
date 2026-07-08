/* eslint-disable */
// =============================================================================
// NWST Secrets Anchor Backfill — llm/secretsAnchorBackfill.js
// =============================================================================
// One-shot maintenance action: generate explicit triggerAnchors for existing
// secrets that don't have them. Secrets created before the explicit-anchor
// system, or imported from older data, lean on noisy inferred anchors. This
// runs the Planning LLM over each anchor-less secret and assigns it a small set
// of distinctive, low-collision anchor words/phrases.
//
// Triggered manually from Settings → Debug. Non-destructive: only fills in
// triggerAnchors where missing; never overwrites anchors a user already set.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { getAllSecrets, updateSecret } from '../data/notebook.js';
import { dlog } from '../lib/debug.js';

const ANCHOR_SYSTEM_PROMPT = `You assign trigger anchors to a roleplay secret. Trigger anchors are 3-7 distinctive words or short phrases that, if they appear in scene prose, signal the scene is genuinely about THIS secret.

RULES:
- Anchors must be DISTINCTIVE to this secret. Prefer the secret's subject name and specific concepts/objects/places tied uniquely to it.
- Prefer MULTI-WORD phrases over single common words. "courier work" and "ravenshade affiliate" are good; "tattoo" and "syndicate" alone are bad because they collide with innocent uses and shared themes.
- AVOID generic words (information, situation, behavior) and AVOID broad themes likely shared with other secrets.
- Output ONLY a JSON array of strings. No prose, no markdown fences. Example: ["harborline affiliate", "ravenshade courier", "debt settlement", "informant role"]`;

/**
 * Generate anchors for a single secret via the Planning LLM.
 * @param {object} secret
 * @param {object} profile
 * @returns {Promise<string[]|null>}
 */
async function generateAnchorsForSecret(secret, profile) {
    const userPrompt =
        `Secret title: ${secret.title || '(none)'}\n` +
        `Secret: ${secret.secret || '(none)'}\n` +
        `Who knows: ${(secret.whoKnows || []).join(', ') || '(none)'}\n` +
        `Who does not know: ${(secret.whoDoesNotKnow || []).join(', ') || '(none)'}\n` +
        `Pressure/risk: ${secret.pressureRisk || '(none)'}\n` +
        `Reveal conditions: ${secret.revealConditions || '(none)'}\n\n` +
        `Output the JSON array of 3-7 distinctive trigger anchors.`;

    const messages = [
        { role: 'system', content: ANCHOR_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
    ];

    const response = await generateWithProfile(profile, messages);
    if (!response) return null;

    try {
        let cleaned = response.trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
            const anchors = parsed
                .filter(a => typeof a === 'string' && a.trim().length >= 3)
                .map(a => a.trim());
            return anchors.length ? anchors : null;
        }
    } catch (e) {
        dlog('[NWST AnchorBackfill] Failed to parse anchors:', e, response);
    }
    return null;
}

/**
 * Backfill anchors for all secrets that lack them.
 * @param {string} chatId
 * @param {object} [options]
 * @param {boolean} [options.overwrite=false] - also regenerate secrets that already have anchors
 * @returns {Promise<{filled:number, skipped:number, failed:number}>}
 */
export async function backfillSecretAnchors(chatId, options = {}) {
    if (!chatId) chatId = getChatId();
    const result = { filled: 0, skipped: 0, failed: 0 };
    if (!chatId) return result;

    const secrets = getAllSecrets(chatId) || [];
    if (secrets.length === 0) {
        nwstToast('No secrets to process.', 'info');
        return result;
    }

    const profile = resolveProfile('planningLLM');
    if (!profile) {
        nwstToast('No Planning LLM profile configured — cannot generate anchors.', 'warning');
        return result;
    }

    const overwrite = !!options.overwrite;

    for (const secret of secrets) {
        const hasAnchors = secret.triggerAnchors &&
            Object.values(secret.triggerAnchors).some(arr => Array.isArray(arr) && arr.length > 0);

        if (hasAnchors && !overwrite) {
            result.skipped++;
            continue;
        }

        try {
            const anchors = await generateAnchorsForSecret(secret, profile);
            if (anchors && anchors.length) {
                await updateSecret(chatId, secret.id, { triggerAnchors: { phrases: anchors } });
                result.filled++;
                dlog(`[NWST AnchorBackfill] "${secret.title}" → [${anchors.join(', ')}]`);
            } else {
                result.failed++;
            }
        } catch (e) {
            console.error('[NWST AnchorBackfill] Failed for secret:', secret.title, e);
            result.failed++;
        }
    }

    return result;
}
