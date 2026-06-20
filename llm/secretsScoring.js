/* eslint-disable */
// =============================================================================
// NWST Secrets Scoring Engine — llm/secretsScoring.js
// =============================================================================
// Replaces the old presence-gate logic with a relevance scoring system.
//
// THE SHIFT:
//   Old: one yes/no gate per secret ("is a knower present? is an at-risk party
//        present?"). One failed condition → secret silent. Cutaway-blind.
//   New: every secret accumulates a score from many independent signals. No
//        single missing signal kills it. A secret can score high on cutaway +
//        pressure alone, even with the at-risk party absent — which is exactly
//        how dramatic irony works in cutaway-heavy writing.
//
// INPUTS:
//   • sceneContext from secretsSidecar.getSceneContext() — characters present
//     (canonical), scene type, active pressures, recent prose text
//   • each secret's data + inferred trigger anchors
//   • editable scoring weights from settings
//
// OUTPUT:
//   • a ranked list of {secret, score, reasons} sorted high→low
//   • the injection selector then fills from the top until EITHER the token
//     budget OR the max-count cap is hit, whichever comes first
//
// All scoring is pure JS. Zero API calls. The semantic inputs (scene type,
// pressures) come pre-computed from the sidecar's cached read.
// =============================================================================

import { getChatId } from '../utils.js';
import { getAllSecrets } from '../data/notebook.js';
import { getSceneContext } from './secretsSidecar.js';
import {
    getScoringWeights, getInjectionThreshold,
    getSecretBudgetTokens, getMaxSecretsInjected
} from '../settings.js';

function normalizeAnchorText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitKeywordString(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',');
    return [];
}

// ── Trigger anchor inference ──────────────────────────────────────────────
// v2 secrets may have an explicit triggerAnchors object. Older secrets don't.
// For those, infer anchors from the secret's existing text fields so the
// scoring engine has something to match against without forcing a manual rebuild.

/**
 * Build the set of lowercase keyword anchors for a secret.
 * Uses explicit triggerAnchors if present; otherwise infers from text fields.
 * @param {object} secret
 * @returns {object} { phrases:Set, concepts:Set }
 */
function getSecretAnchors(secret) {
    const phrases = new Set();

    // Explicit v2 anchors take precedence
    if (secret.triggerAnchors) {
        const ta = secret.triggerAnchors;
        for (const arr of [ta.concepts, ta.objects, ta.locations, ta.organizations, ta.groups, ta.phrases, ta.emotions]) {
            for (const item of (arr || [])) {
                if (typeof item === 'string' && item.trim().length >= 3) {
                    const norm = normalizeAnchorText(item);
                    if (norm.length >= 3) phrases.add(norm);
                }
            }
        }
    }

    // Infer from text fields (always, to supplement explicit anchors).
    // Tightened: require 5+ char words, skip an expanded stopword list, and
    // skip very common narrative-filler words. This makes inferred anchors
    // distinctive enough to be a real signal rather than matching everything.
    const sources = [
        secret.title, secret.secret, secret.pressureRisk, secret.revealConditions, secret.evidenceShown
    ];
    for (const src of sources) {
        if (typeof src !== 'string') continue;
        const words = normalizeAnchorText(src).match(/\b[a-z0-9][a-z0-9-]{3,}\b/g) || [];
        for (const w of words) {
            if (!STOPWORDS.has(w) && !COMMON_FILLER.has(w)) phrases.add(w);
        }
    }

    // relevanceKeywords (v1 field) if present. Older exports often store this
    // as a comma-separated string, so accept both arrays and strings.
    for (const kw of splitKeywordString(secret.relevanceKeywords)) {
        if (typeof kw === 'string' && kw.trim().length >= 3) {
            const norm = normalizeAnchorText(kw);
            if (norm.length >= 3 && !STOPWORDS.has(norm) && !COMMON_FILLER.has(norm)) phrases.add(norm);
        }
    }

    return { phrases };
}

const STOPWORDS = new Set([
    'this','that','with','from','they','them','their','there','where','when',
    'what','which','would','could','should','about','into','over','under',
    'been','have','will','still','some','more','very','than','then','only',
    'know','knows','known','knowing','does','doesnt','dont','cant','wont',
    'because','while','being','these','those','such','must','might','many',
    'character','scene','secret','people','person','someone','something',
    'anyone','anything','everyone','nothing','keeps','keep','make','makes',
    'feel','feels','feeling','remain','remains','present','others'
]);

// Common narrative-filler words that appear in many secrets and would make
// anchor matching fire indiscriminately. These are too generic to be a signal.
const COMMON_FILLER = new Set([
    'around','before','after','during','through','toward','towards','without',
    'between','against','behind','beyond','within','across','along','among',
    'might','could','would','should','seems','seemed','appear','appears',
    'becomes','become','became','begins','began','start','starts','started',
    'going','comes','coming','takes','taking','taken','gives','given','giving',
    'wants','wanted','needs','needed','tries','trying','tried','looks','looking',
    'looked','seeing','watched','watching','moment','moments','little','almost',
    'enough','really','always','never','often','sometimes','usually','perhaps',
    'maybe','possibly','likely','clearly','simply','quietly','slowly','quickly',
    'though','although','despite','however','instead','rather','behavior',
    'situation','presence','position','attention','reaction','response','action',
    'thought','thoughts','sense','manner','degree','level','state','status'
]);

// ── Token estimation ──────────────────────────────────────────────────────

function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4); // ~4 chars/token heuristic
}

// ── Score a single secret against the scene ───────────────────────────────

/**
 * Score one secret against the current scene context.
 * @param {object} secret
 * @param {object} sceneContext - from getSceneContext()
 * @param {object} weights - from getScoringWeights()
 * @returns {object} { score, reasons }
 */
export function scoreSecret(secret, sceneContext, weights) {
    let score = 0;
    const reasons = [];
    const registry = sceneContext.registry;
    const present = new Set(sceneContext.charactersPresent); // canonical IDs
    const text = normalizeAnchorText(sceneContext.recentText || '');

    // Resolve the secret's knowers/unaware to canonical IDs
    const knowers = (secret.whoKnows || []).map(n => registry.resolve(n)).filter(Boolean);
    const unaware = (secret.whoDoesNotKnow || []).map(n => registry.resolve(n)).filter(Boolean);

    const knowerPresent  = knowers.some(c => present.has(c));
    const unawarePresent = unaware.some(c => present.has(c));

    // ── Presence signals ───────────────────────────────────────
    if (knowerPresent && unawarePresent) {
        score += weights.bothPresent;
        reasons.push(`both knower & unaware present (+${weights.bothPresent})`);
    } else {
        if (knowerPresent) {
            score += weights.knowerPresent;
            reasons.push(`knower present (+${weights.knowerPresent})`);
        }
        if (unawarePresent) {
            score += weights.unawarePresent;
            reasons.push(`unaware party present (+${weights.unawarePresent})`);
        }
    }

    // ── NPC cutaway involving the holder ───────────────────────
    // If the scene is a cutaway/surveillance/faction scene AND a knower
    // (the schemer/holder) is present, this secret's pressure is live even
    // though the at-risk party is absent. This is the core cutaway fix.
    const cutawayTypes = ['npc_cutaway', 'surveillance', 'faction'];
    if (cutawayTypes.includes(sceneContext.sceneType) && knowerPresent) {
        score += weights.npcCutawayHolder;
        reasons.push(`${sceneContext.sceneType} involving holder (+${weights.npcCutawayHolder})`);
    }

    // ── Group/faction/entity match ─────────────────────────────
    // Groups are entities too. If a detected group/organization is explicitly
    // tied to the secret through knowers/unaware/anchors/text, award groupMatch.
    const secretEntityText = normalizeAnchorText(`${secret.title || ''} ${secret.secret || ''} ${secret.evidenceShown || ''} ${secret.pressureRisk || ''} ${secret.revealConditions || ''} ${(secret.whoKnows || []).join(' ')} ${(secret.whoDoesNotKnow || []).join(' ')}`);
    const groupsPresent = sceneContext.groupsPresent || [];
    const groupHit = groupsPresent.some(g => {
        const display = normalizeAnchorText(registry.getDisplay?.(g) || g);
        return (g && secretEntityText.includes(g)) || (display.length >= 3 && secretEntityText.includes(display));
    });
    if (groupHit) {
        score += weights.groupMatch;
        reasons.push(`group/faction match (+${weights.groupMatch})`);
    }

    // ── Active pressure match ──────────────────────────────────
    // The sidecar's activePressures are free-text tags. Match them against
    // the secret's title and pressureRisk. getSceneContext only passes these
    // through while the sidecar read is fresh.
    const secretPressureText = normalizeAnchorText(`${secret.title || ''} ${secret.secret || ''} ${secret.pressureRisk || ''}`);
    for (const pressure of (sceneContext.activePressures || [])) {
        const p = normalizeAnchorText(pressure);
        if (p.length >= 3 && secretPressureText.includes(p)) {
            score += weights.pressureMatch;
            reasons.push(`active pressure "${pressure}" (+${weights.pressureMatch})`);
            break; // count pressure match once
        }
    }

    // ── Anchor / concept match in prose ────────────────────────
    const { phrases } = getSecretAnchors(secret);
    let anchorHit = false;
    for (const phrase of phrases) {
        if (phrase.length < 4) continue;
        if (text.includes(phrase)) { anchorHit = true; break; }
    }
    if (anchorHit) {
        score += weights.anchorMatch;
        reasons.push(`anchor/concept match (+${weights.anchorMatch})`);
    }

    // ── Reveal condition referenced in prose ───────────────────
    if (secret.revealConditions && typeof secret.revealConditions === 'string') {
        const revealWords = normalizeAnchorText(secret.revealConditions).match(/\b[a-z0-9][a-z0-9-]{3,}\b/g) || [];
        const meaningful = revealWords.filter(w => !STOPWORDS.has(w));
        const hits = meaningful.filter(w => text.includes(w)).length;
        // Require at least 2 meaningful reveal-condition words to appear
        if (hits >= 2) {
            score += weights.revealConditionMatch;
            reasons.push(`reveal condition referenced (+${weights.revealConditionMatch})`);
        }
    }

    // ── Priority modifier ──────────────────────────────────────
    const priority = (secret.injectionPriority || 'normal').toLowerCase();
    const priorityKey = 'priority' + priority.charAt(0).toUpperCase() + priority.slice(1);
    if (weights[priorityKey] !== undefined) {
        score += weights[priorityKey];
        if (weights[priorityKey] !== 0) {
            reasons.push(`priority ${priority} (${weights[priorityKey] > 0 ? '+' : ''}${weights[priorityKey]})`);
        }
    }

    // ── Continuity risk (Critical priority secrets that haven't injected) ──
    // If a Critical secret is even mildly relevant, push it hard.
    if (priority === 'critical' && (knowerPresent || anchorHit)) {
        score += weights.continuityRisk;
        reasons.push(`continuity risk — critical secret relevant (+${weights.continuityRisk})`);
    }

    return { score, reasons };
}

// ── Rank all secrets ──────────────────────────────────────────────────────

/**
 * Score and rank all secrets for the current scene.
 * @param {string} chatId
 * @returns {object[]} [{ secret, score, reasons }] sorted high→low
 */
export function rankSecrets(chatId) {
    if (!chatId) chatId = getChatId();

    const secrets = getAllSecrets(chatId) || [];
    if (secrets.length === 0) return [];

    const sceneContext = getSceneContext(chatId);
    const weights = getScoringWeights();

    const scored = secrets.map(secret => {
        const { score, reasons } = scoreSecret(secret, sceneContext, weights);
        return { secret, score, reasons };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
}

// ── Select secrets for injection ──────────────────────────────────────────

/**
 * Produce the final list of secrets to inject, respecting BOTH the token
 * budget and the max-count cap. Whichever limit is hit first wins.
 *
 * @param {string} chatId
 * @returns {object[]} [{ secret, score, reasons }] selected for injection
 */
export function selectSecretsForInjection(chatId) {
    if (!chatId) chatId = getChatId();

    const ranked = rankSecrets(chatId);
    const threshold = getInjectionThreshold();
    const budget = getSecretBudgetTokens();
    const maxCount = getMaxSecretsInjected();

    const selected = [];
    let usedTokens = 0;

    for (const entry of ranked) {
        if (entry.score < threshold) break;          // below threshold — stop (list is sorted)
        if (selected.length >= maxCount) break;       // hit count cap
        const secretTokens = estimateTokens(formatSecretForEstimate(entry.secret));
        if (usedTokens + secretTokens > budget) continue; // would blow budget — skip, try next smaller
        selected.push(entry);
        usedTokens += secretTokens;
    }

    return selected;
}

function formatSecretForEstimate(secret) {
    // Mirror roughly what the injection format will produce, for token estimation
    return `${secret.title || ''} ${secret.secret || ''} ${(secret.whoKnows||[]).join(', ')} ${(secret.whoDoesNotKnow||[]).join(', ')} ${secret.pressureRisk || ''}`;
}
