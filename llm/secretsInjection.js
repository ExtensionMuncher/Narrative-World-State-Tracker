/* eslint-disable */
// =============================================================================
// NWST Secrets Injection — llm/secretsInjection.js
// =============================================================================
// Layer 4: builds the narrator-guidance injection block from the secrets the
// scoring engine selected. This replaces the old getSelectiveSecretInjection
// in narrativeConsistency.js.
//
// Format (per your spec) — narrator guidance with explicit knowledge boundaries:
//
//   [SECRET CONTINUITY — Narrator Guidance Only]
//   Secret: <secret text>
//   Known by: <display names>
//   Unknown to: <display names>
//   Use: Maintain dramatic irony. Do not let unaware characters know this
//        unless the scene naturally reveals evidence.
//   Current relevance: <why this fired — matched reasons in plain language>
//
// The scoring/selection logic lives in secretsScoring.js. This module only
// formats the winners and tracks last-injection bookkeeping.
// =============================================================================

import { getChatId } from '../utils.js';
import { isEnabled, isPaused } from '../settings.js';
import { selectSecretsForInjection } from './secretsScoring.js';
import { buildAliasRegistry } from '../data/aliasRegistry.js';
import { getSceneContext } from './secretsSidecar.js';
import { dlog } from '../lib/debug.js';

/**
 * Build the secrets injection block for the current scene.
 * Pure JS, instant, called on every message by the prompt injector.
 *
 * @param {string} chatId
 * @returns {string} The injection block, or '' if nothing to inject
 */
export function buildSecretsInjection(chatId) {
    if (!isEnabled() || isPaused()) return '';
    if (!chatId) chatId = getChatId();
    if (!chatId) return '';

    const selected = selectSecretsForInjection(chatId);
    if (!selected || selected.length === 0) return '';

    const registry = buildAliasRegistry(chatId);

    let block = '\n[SECRET CONTINUITY — Narrator Guidance Only]\n';

    for (const { secret, reasons } of selected) {
        const knownBy = (secret.whoKnows || [])
            .map(n => registry.getDisplay(registry.resolve(n) || n) || n);
        const unknownTo = (secret.whoDoesNotKnow || [])
            .map(n => registry.getDisplay(registry.resolve(n) || n) || n);

        block += `\nSecret: ${secret.secret || secret.title || '(unspecified)'}\n`;
        if (knownBy.length)   block += `Known by: ${knownBy.join(', ')}.\n`;
        if (unknownTo.length) block += `Unknown to: ${unknownTo.join(', ')}.\n`;

        // "Use" guidance — tailored slightly by whether unaware parties exist
        if (unknownTo.length) {
            block += `Use: Maintain dramatic irony and the pressure around this secret. `;
            block += `Do not let unaware characters learn this unless the scene naturally reveals evidence.\n`;
        } else {
            block += `Use: Keep this hidden-state consistent. Let it inform behavior without stating it outright.\n`;
        }

        // Current relevance — translate scoring reasons into plain narrator cue
        const relevance = describeRelevance(reasons, secret);
        if (relevance) block += `Current relevance: ${relevance}\n`;
    }

    // Bookkeeping: stamp lastInjectionMsgIndex on injected secrets (fire-and-forget)
    stampInjection(chatId, selected.map(s => s.secret));

    return block;
}

/**
 * Translate scoring reasons into a short plain-language relevance cue for the
 * narrator. Keeps the most meaningful signal rather than dumping the raw math.
 */
function describeRelevance(reasons, secret) {
    if (!reasons || reasons.length === 0) return '';

    // Prefer the most narratively meaningful reasons
    const cues = [];
    for (const r of reasons) {
        if (r.includes('both knower & unaware'))     cues.push('a knowing and an unaware character share the scene');
        else if (r.includes('cutaway') || r.includes('surveillance') || r.includes('faction'))
            cues.push('this is a scene where the secret-holder is active away from the unaware party');
        else if (r.includes('active pressure'))      cues.push('the scene is touching this secret\'s pressure directly');
        else if (r.includes('reveal condition'))     cues.push('the prose is approaching this secret\'s reveal conditions');
        else if (r.includes('knower present'))        cues.push('a character who knows this is present');
        else if (r.includes('unaware party present')) cues.push('a character who must not know is present');
        else if (r.includes('anchor'))                cues.push('the scene references this secret\'s subject matter');
    }
    // Dedupe and keep up to 2 cues
    const unique = Array.from(new Set(cues)).slice(0, 2);
    return unique.join('; ') + '.';
}

/**
 * Fire-and-forget update of lastInjectionMsgIndex for cooldown/stale tracking.
 */
function stampInjection(chatId, secrets) {
    let currentMsgIndex = 0;
    try {
        const ctx = SillyTavern.getContext();
        currentMsgIndex = (ctx.chat || []).length;
    } catch (e) { return; }
    if (currentMsgIndex <= 0) return;

    setTimeout(async () => {
        try {
            const { updateSecret } = await import('../data/notebook.js');
            for (const secret of secrets) {
                if (secret.id) {
                    await updateSecret(chatId, secret.id, { lastInjectionMsgIndex: currentMsgIndex });
                }
            }
        } catch (e) {
            dlog('[NWST SecretsInjection] Failed to stamp injection index:', e);
        }
    }, 0);
}
