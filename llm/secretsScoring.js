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
import { getAllSecrets, getInjectableSecrets } from '../data/notebook.js';
import { getSceneContext } from './secretsSidecar.js';
import {
    getScoringWeights, getInjectionThreshold,
    getSecretBudgetTokens, getMaxSecretsInjected
} from '../settings.js';


// Build a Set of whole words present in a normalized text block, for
// word-boundary anchor matching (so "venue" does not match inside "avenues").
function buildWordSet(normalizedText) {
    const set = new Set();
    for (const w of (normalizedText.match(/\b[a-z0-9][a-z0-9-]{2,}\b/g) || [])) {
        set.add(w);
    }
    return set;
}

// Generic words that are too common to be meaningful secret anchors. These
// appear constantly in prose and in-world documents and cause false anchor
// matches. Kept separate from STOPWORDS so anchor filtering can be stricter
// than reveal-condition filtering.
const ANCHOR_GENERIC = new Set([
    'entry','friend','friends','prior','appears','appear','venue','venues',
    'contact','typical','civilian','awareness','knowledge','evidence','level',
    'query','entry','years','close','element','elements','exceed','finds',
    'discovers','expose','betrayed','pressured','confrontation','communication',
    'database','dossier','preliminary','settlement','role','status','update',
    'information','detail','details','report','reports','record','records',
    'subject','target','person','people','someone','somebody','thing','things',
    'morning','night','today','yesterday','later','around','behind','toward',
    'also','already','cause','because','something','someone','anything','everything',
    'threatening','revealed','reveal','reveals','revealing','discover','discovered',
    'unusual','behavior','behaviour','conflict','conversation','stress','digital',
    'direct','indirect','workplace','public','private','social','online','account',
    'making','during','before','after','through','toward','within','without','being',
    'getting','having','number','various','several','certain','particular','general'
]);

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
    // Returns two separate sets:
    //   explicit — anchors the user/creation-LLM declared for THIS secret. These
    //              are the reliable, intentional signal. A match here means the
    //              scene is genuinely about this secret's subject.
    //   inferred — words scraped from the secret's prose. Noisy fallback only,
    //              used for old secrets without explicit anchors. A match here is
    //              treated as a weak signal, never the strong distinctive bonus.
    const explicit = new Set();
    const inferred = new Set();

    // EXPLICIT anchors (declared) — the intentional signal.
    if (secret.triggerAnchors) {
        const ta = secret.triggerAnchors;
        for (const arr of [ta.concepts, ta.objects, ta.locations, ta.organizations,
                           ta.groups, ta.phrases, ta.emotions, ta.characters, ta.aliases]) {
            for (const item of (arr || [])) {
                if (typeof item === 'string' && item.trim().length >= 3) {
                    const norm = normalizeAnchorText(item);
                    if (norm.length >= 3) explicit.add(norm);
                }
            }
        }
    }

    // INFERRED anchors (scraped) — noisy fallback. Only meaningful when a secret
    // has no explicit anchors. Kept conservative.
    const sources = [
        secret.title, secret.secret, secret.pressureRisk, secret.revealConditions, secret.evidenceShown
    ];
    for (const src of sources) {
        if (typeof src !== 'string') continue;
        const words = (normalizeAnchorText(src).match(/\b[a-z0-9][a-z0-9-]{5,}\b/g) || [])
            .filter(w => !ANCHOR_GENERIC.has(w) && !STOPWORDS.has(w) && !COMMON_FILLER.has(w));
        for (const w of words) inferred.add(w);
    }
    for (const kw of splitKeywordString(secret.relevanceKeywords)) {
        if (typeof kw === 'string' && kw.trim().length >= 3) {
            const norm = normalizeAnchorText(kw);
            if (norm.length >= 3 && !STOPWORDS.has(norm) && !COMMON_FILLER.has(norm)) inferred.add(norm);
        }
    }

    // hasExplicit lets scoring decide how much to trust anchor matches.
    return { explicit, inferred, hasExplicit: explicit.size > 0,
             // back-compat: `phrases` = union, used by computeSharedAnchors
             phrases: new Set([...explicit, ...inferred]) };
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
export function scoreSecret(secret, sceneContext, weights, sharedAnchors = new Set()) {
    let score = 0;
    const reasons = [];
    const registry = sceneContext.registry;
    const present = new Set(sceneContext.charactersPresent); // canonical IDs
    const text = normalizeAnchorText(sceneContext.recentText || '');
    const sceneWords = buildWordSet(text);  // for word-boundary anchor matching

    // Set of all character-name tokens in the registry. Anchor and reveal-
    // condition matching must EXCLUDE these, because character presence is
    // already scored separately. Without this, every secret matches on shared
    // character names ("mira", "rowan") that appear in both the secret's
    // text and nearly every scene — inflating scores indiscriminately.
    const nameTokens = new Set();
    if (registry.allAliasStrings) {
        for (const alias of registry.allAliasStrings()) {
            for (const tok of alias.split(' ')) {
                if (tok.length >= 3) nameTokens.add(tok);
            }
        }
    }

    // ── Subject relevance (computed early; used by presence scoring) ──
    // A secret's SUBJECT is referenced when a non-name anchor/concept from the
    // secret appears in the scene. This gates the big "both present" bonus so a
    // secret doesn't fire +40 just because a knower and an unaware party happen
    // to share a scene that has nothing to do with the secret's actual subject.
    const _anchors = getSecretAnchors(secret);
    // Match anchors against the scene. EXPLICIT anchors (declared for this
    // secret) are the strong, reliable signal — a match means the scene is
    // genuinely about this secret's subject. INFERRED anchors (scraped from
    // prose) are a weak fallback for secrets without declared anchors, and a
    // match there never counts as true subject relevance.
    const matchAnchor = (phrase) => {
        if (!phrase || phrase.length < 4) return false;
        if (nameTokens.has(phrase)) return false;     // names handled by presence
        return phrase.includes(' ') ? text.includes(phrase) : sceneWords.has(phrase);
    };

    let explicitAnchorHit = false, explicitAnchorWord = null;
    for (const phrase of _anchors.explicit) {
        if (matchAnchor(phrase)) { explicitAnchorHit = true; explicitAnchorWord = phrase; break; }
    }

    let inferredAnchorHit = false, inferredAnchorWord = null;
    if (!explicitAnchorHit) {
        for (const phrase of _anchors.inferred) {
            if (sharedAnchors.has(phrase)) continue;  // shared themes don't count even as inferred
            if (matchAnchor(phrase)) { inferredAnchorHit = true; inferredAnchorWord = phrase; break; }
        }
    }

    // Distinctive (true subject) relevance comes ONLY from an explicit anchor
    // match, OR from inferred matches on secrets that have NO explicit anchors
    // (so old un-migrated secrets still function, just less precisely).
    const distinctiveAnchorHit = explicitAnchorHit || (!_anchors.hasExplicit && inferredAnchorHit);
    const distinctiveAnchorWord = explicitAnchorWord || inferredAnchorWord;
    const anchorHit = explicitAnchorHit || inferredAnchorHit;
    const anchorHitWord = explicitAnchorWord || inferredAnchorWord;

    // Also treat an active-pressure match as subject relevance (computed below
    // sets pressureReferenced). For now, subjectReferenced starts from anchorHit.

    // Resolve the secret's knowers/unaware to canonical IDs
    const knowers = (secret.whoKnows || []).map(n => registry.resolve(n)).filter(Boolean);
    const unaware = (secret.whoDoesNotKnow || []).map(n => registry.resolve(n)).filter(Boolean);

    const knowerPresent  = knowers.some(c => present.has(c));
    const unawarePresent = unaware.some(c => present.has(c));

    // ── Pressure relevance (also counts as subject relevance) ──
    const secretPressureTextEarly = normalizeAnchorText(`${secret.title || ''} ${secret.secret || ''} ${secret.pressureRisk || ''}`);
    let pressureReferenced = false;
    for (const pressure of (sceneContext.activePressures || [])) {
        const p = normalizeAnchorText(pressure);
        if (p.length >= 3 && secretPressureTextEarly.includes(p)) { pressureReferenced = true; break; }
    }

    // The secret's subject is referenced if a DISTINCTIVE anchor matched (a word
    // unique to this secret, not a shared theme), OR a pressure tied to the
    // secret is active, OR a knower who is the secret's subject is present.
    // A shared-theme-only match (e.g. "syndicate" appearing because some other
    // secret is in play) does NOT count as this secret's subject being referenced.
    const subjectReferenced = distinctiveAnchorHit || pressureReferenced;

    // ── Presence signals ───────────────────────────────────────
    // "Both present" only earns the full bonus when the secret's SUBJECT is
    // actually referenced in the scene. A knower and an unaware party merely
    // sharing a scene that has nothing to do with the secret earns only the
    // smaller, tunable co-presence signal instead.
    if (knowerPresent && unawarePresent) {
        if (subjectReferenced) {
            score += weights.bothPresent;
            reasons.push(`both knower & unaware present, subject referenced (+${weights.bothPresent})`);
        } else {
            score += (weights.coPresenceOnly ?? 10);
            reasons.push(`knower & unaware co-present, subject NOT referenced (+${weights.coPresenceOnly ?? 10})`);
        }
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
    // anchorHit was computed early (used for subject relevance). Award its
    // score here so the weight remains independently tunable.
    if (explicitAnchorHit) {
        score += weights.anchorMatch;
        reasons.push(`explicit anchor "${explicitAnchorWord}" (+${weights.anchorMatch})`);
    } else if (distinctiveAnchorHit) {
        // Inferred match on a secret with no explicit anchors — moderate signal
        score += weights.anchorMatch;
        reasons.push(`inferred anchor "${distinctiveAnchorWord}" (+${weights.anchorMatch})`);
    } else if (inferredAnchorHit) {
        // Inferred match but the secret HAS explicit anchors (this wasn't one) —
        // weak signal only, tunable via sharedThemeMatch
        const sharedW = weights.sharedThemeMatch ?? 5;
        score += sharedW;
        reasons.push(`weak inferred match "${inferredAnchorWord}" (+${sharedW})`);
    }

    // ── Reveal condition referenced in prose ───────────────────
    // Exclude character names and stopwords. A reveal condition only counts as
    // "referenced" if at least 2 DISTINCTIVE non-name words from it appear in
    // the scene — otherwise shared character names alone falsely satisfy it.
    if (secret.revealConditions && typeof secret.revealConditions === 'string') {
        const revealWords = normalizeAnchorText(secret.revealConditions).match(/\b[a-z0-9][a-z0-9-]{4,}\b/g) || [];
        const meaningful = revealWords.filter(w =>
            !STOPWORDS.has(w) && !nameTokens.has(w) && !ANCHOR_GENERIC.has(w) && w.length >= 5
        );
        // Whole-word matching against the scene word set
        const distinctHits = new Set(meaningful.filter(w => sceneWords.has(w)));
        // Require at least 2 DISTINCT distinctive words to appear
        if (distinctHits.size >= 2) {
            score += weights.revealConditionMatch;
            reasons.push(`reveal condition referenced [${Array.from(distinctHits).slice(0,3).join(', ')}] (+${weights.revealConditionMatch})`);
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
/**
 * Compute the set of anchor words that appear in MORE THAN ONE secret. These
 * are shared themes (e.g. "syndicate", "surveillance" across several syndicate
 * secrets) rather than subject-distinctive words. Shared anchors are weak
 * signals — they shouldn't make a secret inject when its actual subject is
 * absent. Computed from the actual secret set, so it self-tunes; no hardcoded
 * theme list to maintain.
 * @param {object[]} secrets
 * @returns {Set<string>} anchor words appearing in 2+ secrets
 */
function computeSharedAnchors(secrets) {
    const counts = new Map();
    for (const secret of secrets) {
        const { phrases } = getSecretAnchors(secret);
        const seen = new Set();
        for (const p of phrases) {
            if (seen.has(p)) continue;     // count each word once per secret
            seen.add(p);
            counts.set(p, (counts.get(p) || 0) + 1);
        }
    }
    const shared = new Set();
    for (const [word, count] of counts) {
        if (count >= 2) shared.add(word);
    }
    return shared;
}

export function rankSecrets(chatId) {
    if (!chatId) chatId = getChatId();

    const secrets = getInjectableSecrets(chatId) || [];  // excludes archived
    if (secrets.length === 0) return [];

    const sceneContext = getSceneContext(chatId);
    const weights = getScoringWeights();
    const sharedAnchors = computeSharedAnchors(secrets);

    const scored = secrets.map(secret => {
        const { score, reasons } = scoreSecret(secret, sceneContext, weights, sharedAnchors);
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
