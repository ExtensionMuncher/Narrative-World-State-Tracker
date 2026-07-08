/* eslint-disable */
// =============================================================================
// NWST Secrets Debug — llm/secretsDebug.js
// =============================================================================
// Visibility into the scoring engine. When a secret doesn't inject and you
// want to know why, this shows the full decision: detected entities, scene
// type, every secret's score, the reasons behind each score, and whether it
// was injected or skipped (and why).
//
// Exposed two ways:
//   • buildSecretsDebugReport(chatId) → formatted string for a popup
//   • validateSecrets(chatId) → array of validation warnings
// =============================================================================

import { getChatId } from '../utils.js';
import { getAllSecrets } from '../data/notebook.js';
import { rankSecrets } from './secretsScoring.js';
import { getSceneContext, getSidecarState } from './secretsSidecar.js';
import { buildAliasRegistry } from '../data/aliasRegistry.js';
import {
    getInjectionThreshold, getSecretBudgetTokens,
    getMaxSecretsInjected, getScoringWeights, getSidecarScanRange
} from '../settings.js';

/**
 * Build a full human-readable debug report of the current secrets scoring state.
 * @param {string} chatId
 * @returns {string}
 */
export function buildSecretsDebugReport(chatId) {
    if (!chatId) chatId = getChatId();
    if (!chatId) return 'No active chat.';

    const secrets = getAllSecrets(chatId) || [];
    if (secrets.length === 0) return 'No secrets in this chat.';

    const scene = getSceneContext(chatId);
    const sidecar = getSidecarState(chatId);
    const registry = buildAliasRegistry(chatId);
    const threshold = getInjectionThreshold();
    const budget = getSecretBudgetTokens();
    const maxCount = getMaxSecretsInjected();

    let out = '═══ NWST SECRETS DEBUG ═══\n\n';

    // ── Scene context ──────────────────────────────────────────
    out += '── SCENE CONTEXT ──\n';
    out += `Characters present: ${scene.charactersPresent.map(c => registry.getDisplay(c)).join(', ') || '(none detected)'}\n`;
    out += `Scene type: ${scene.sceneType}\n`;
    out += `Active pressures: ${scene.activePressures.join(', ') || '(none)'}\n`;
    out += `Configured scan range: last ${getSidecarScanRange()} prose message(s)\n`;
    out += `Fresh JS scan used: ${scene.recentMessageCount ?? '?'} message(s)\n`;
    out += `Sidecar fresh: ${scene.sidecarFresh ? 'yes' : 'no (stale or never run)'}\n`;
    if (sidecar) {
        out += `Sidecar summary: ${sidecar.sceneSummary || '(none)'}\n`;
        out += `Sidecar last ran at message: ${sidecar.analyzedAtMessageIndex ?? '?'}\n`;
        out += `Sidecar age: ${scene.sidecarAge ?? '?'} message(s)\n`;
        out += `Sidecar read range: ${sidecar.messagesAnalyzed ?? '?'} message(s)`;
        if (sidecar.messageRangeStart && sidecar.messageRangeEnd) {
            out += ` (messages ${sidecar.messageRangeStart}–${sidecar.messageRangeEnd})`;
        }
        out += `\n`;
    } else {
        out += `Sidecar: has not run yet (using pure-JS entity detection only)\n`;
    }
    out += '\n';

    // ── Caps ───────────────────────────────────────────────────
    out += '── LIMITS ──\n';
    out += `Injection threshold: ${threshold} (secrets must score ≥ this)\n`;
    out += `Token budget: ${budget}\n`;
    out += `Max secrets injected: ${maxCount}\n\n`;

    // ── Per-secret scoring ─────────────────────────────────────
    out += '── SECRET SCORES (ranked) ──\n';
    const ranked = rankSecrets(chatId);

    let injectedSoFar = 0;
    let tokensSoFar = 0;
    for (const { secret, score, reasons } of ranked) {
        const meets = score >= threshold;
        let status;
        if (!meets) {
            status = 'SKIP (below threshold)';
        } else if (injectedSoFar >= maxCount) {
            status = 'SKIP (max count reached)';
        } else {
            const est = Math.ceil(
                `${secret.title||''} ${secret.secret||''} ${(secret.whoKnows||[]).join(', ')} ${(secret.whoDoesNotKnow||[]).join(', ')} ${secret.pressureRisk||''}`.length / 4
            );
            if (tokensSoFar + est > budget) {
                status = 'SKIP (would exceed token budget)';
            } else {
                status = 'INJECT';
                injectedSoFar++;
                tokensSoFar += est;
            }
        }

        out += `\n[${status}] score ${score} — "${(secret.title || '(untitled)').slice(0, 50)}" [${secret.injectionPriority || 'normal'}]\n`;
        if (reasons.length) {
            out += `    reasons: ${reasons.join('; ')}\n`;
        } else {
            out += `    reasons: (no signals matched)\n`;
        }
    }

    // ── Validation warnings ────────────────────────────────────
    const warnings = validateSecrets(chatId);
    if (warnings.length) {
        out += '\n── VALIDATION WARNINGS ──\n';
        for (const w of warnings) {
            out += `  ⚠ ${w}\n`;
        }
    }

    return out;
}

/**
 * Validate secrets for common configuration problems.
 * @param {string} chatId
 * @returns {string[]} warning strings
 */
export function validateSecrets(chatId) {
    if (!chatId) chatId = getChatId();
    const secrets = getAllSecrets(chatId) || [];
    const warnings = [];
    const registry = buildAliasRegistry(chatId);

    for (const secret of secrets) {
        const title = (secret.title || '(untitled)').slice(0, 40);

        // Empty whoKnows
        if (!secret.whoKnows || secret.whoKnows.length === 0) {
            warnings.push(`"${title}": no one is listed in Who Knows — secret can't trigger on knower presence.`);
        }

        // Empty whoDoesNotKnow on a knowledge-boundary secret
        if ((!secret.whoDoesNotKnow || secret.whoDoesNotKnow.length === 0) &&
            secret.type !== 'world' && secret.type !== 'dramatic_irony') {
            warnings.push(`"${title}": no one in Who Does NOT Know — dramatic irony can't be tracked.`);
        }

        // Generic-only title
        const t = (secret.title || '').toLowerCase().trim();
        if (t === 'new secret' || t === '' || t === 'untitled secret') {
            warnings.push(`"${title}": title is generic — give it a descriptive name for better anchor matching.`);
        }

        // Names that don't resolve in the registry
        for (const name of (secret.whoKnows || [])) {
            if (!registry.resolve(name)) {
                warnings.push(`"${title}": knower "${name}" doesn't resolve to a known entity — check spelling or add an alias.`);
            }
        }

        // No pressureRisk and no revealConditions → weak anchor inference
        if (!secret.pressureRisk && !secret.revealConditions && !secret.triggerAnchors) {
            warnings.push(`"${title}": no pressure/risk, reveal conditions, or anchors — only presence signals will fire for it.`);
        }
    }

    return warnings;
}
