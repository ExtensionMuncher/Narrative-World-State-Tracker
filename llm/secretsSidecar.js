/* eslint-disable */
// =============================================================================
// NWST Secrets Sidecar — llm/secretsSidecar.js
// =============================================================================
// The comprehension layer for the prose-based secrets engine.
//
// WHAT IT DOES:
//   Runs on its own cadence (default every 10 messages) via a cheap, dedicated
//   connection profile (Mistral-Nemo, Haiku, a local 8B — NOT the heavy
//   Narrative Consistency model). It reads recent prose and returns a small
//   structured object describing the scene, which the JS scoring engine then
//   consumes to decide which secrets to inject.
//
// WHY IT EXISTS:
//   Pure JS prose-scanning (via aliasRegistry.scanProse) reliably detects
//   characters NAMED in the prose. It cannot resolve pronouns ("he watched
//   for six paragraphs"), recognize scene TYPE (cutaway vs player-present),
//   or detect active narrative PRESSURE (is this a surveillance scene?).
//   Those are semantic judgments only an LLM can make. The sidecar fills
//   exactly that gap — nothing more.
//
// WHAT IT RETURNS (cached in chatMetadata, consumed by the scoring engine):
//   {
//     charactersPresent: ["sukuna", "satoru"],   // canonical IDs, pronouns resolved
//     sceneType: "npc_cutaway",                   // player_present|npc_cutaway|surveillance|faction|mixed
//     activePressures: ["satoru_surveillance"],   // free-text pressure tags
//     sceneSummary: "Satoru and Suguru observe...", // one-line Qvink-style
//     analyzedAtMessageIndex: 142                  // for staleness tracking
//   }
//
// IT DOES NOT decide injection. It only produces scene comprehension.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { isEnabled, isPaused, getSidecarScanRange } from '../settings.js';
import { getAllSecrets } from '../data/notebook.js';
import { buildAliasRegistry } from '../data/aliasRegistry.js';
import { getUserCharacterIdentity } from '../data/secretsMeta.js';
import { dlog } from '../lib/debug.js';

const SIDECAR_STATE_KEY = 'nwst:secretsSidecarState';

// ── Sidecar system prompt ─────────────────────────────────────────────────

const SIDECAR_SYSTEM_PROMPT = `You are a scene analyzer for a roleplay's hidden-knowledge tracking system. You read recent prose and produce a compact structured analysis. You do NOT write story or make decisions — you only describe what the scene IS.

You will receive:
- Recent prose messages
- A roster of known character canonical IDs and their display names
- A short list of the narrative pressures being tracked (from secrets)

Produce a JSON object with these fields:
{
  "charactersPresent": [],   // canonical IDs of characters ACTUALLY present and acting in the scene, including those referred to only by pronoun. Resolve pronouns to the character they refer to. Use ONLY canonical IDs from the provided roster.
  "sceneType": "",            // one of: "player_present" (the user's character is in the scene), "npc_cutaway" (scene among NPCs with the user's character absent), "surveillance" (someone is watching/monitoring another), "faction" (group/organization politics or planning), "mixed"
  "activePressures": [],      // short free-text tags for narrative pressures live in THIS scene, drawn from the tracked-pressures list when they apply (e.g. "surveillance", "jealousy", "stalking", "faction_scheming"). Only include pressures actually active in the prose.
  "sceneSummary": ""          // ONE sentence, Qvink-style: who is doing what to whom. Factual, terse, no flourish.
}

RULES:
- charactersPresent must use canonical IDs from the roster exactly. If a character acts in the prose but isn't in the roster, omit them.
- Resolve pronouns: if "he" clearly refers to a rostered character acting across several lines, include that character.
- A character merely MENTIONED but not present (e.g. "she thought about Sukuna") is NOT present. Only include characters actually in the scene.
- sceneType: if the user's character (provided separately) is absent and only NPCs act, it's "npc_cutaway" (or "surveillance"/"faction" if those fit better).
- Output ONLY the JSON object. No markdown fences, no explanation.`;

// ── Build the sidecar user prompt ─────────────────────────────────────────

function buildSidecarPrompt(recentMessages, registry, secrets, userIdentity) {
    let prompt = '';

    // Roster of canonical entities
    prompt += '=== CHARACTER ROSTER (canonical ID → display name) ===\n';
    const entities = registry.allEntities();
    for (const e of entities) {
        prompt += `  ${e.canonical} → ${e.display}\n`;
    }
    prompt += '\n';

    // Tracked pressures from secret titles/pressureRisk
    prompt += '=== TRACKED NARRATIVE PRESSURES (from secrets) ===\n';
    for (const s of secrets) {
        const tag = s.title || '(untitled)';
        const risk = s.pressureRisk ? ` — ${s.pressureRisk}` : '';
        prompt += `  • ${tag}${risk}\n`;
    }
    prompt += '\n';

    // Recent prose
    prompt += '=== RECENT PROSE ===\n';
    for (const msg of recentMessages) {
        // We deliberately do NOT label by msg.name (it's the card title and
        // misleading). We pass raw prose so the analyzer judges from content.
        const speaker = msg.is_user ? '[USER/PC]' : '[NARRATION]';
        prompt += `${speaker}: ${msg.mes}\n\n`;
    }

    prompt += 'Analyze the scene and output the JSON object.';
    return prompt;
}

// ── Get recent messages (prose only, visibility-respecting) ───────────────

function getRecentProseMessages(count = 5) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const out = [];
        for (let i = chat.length - 1; i >= 0 && out.length < count; i--) {
            const msg = chat[i];
            if (msg.is_system && msg.extra?.hidden) continue;
            if (msg.extra?.display === 'none') continue;
            if (msg.mes) out.unshift(msg);
        }
        return out;
    } catch (e) {
        return [];
    }
}

// ── Parse sidecar JSON response ───────────────────────────────────────────

function parseSidecarResponse(response, registry) {
    if (!response) return null;
    try {
        // Strip markdown fences if the model added them despite instructions
        let cleaned = response.trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        const parsed = JSON.parse(cleaned);

        // Validate and canonicalize charactersPresent against the registry
        const validChars = [];
        if (Array.isArray(parsed.charactersPresent)) {
            for (const c of parsed.charactersPresent) {
                const resolved = registry.resolve(c);
                if (resolved) validChars.push(resolved);
            }
        }

        return {
            charactersPresent: Array.from(new Set(validChars)),
            sceneType: typeof parsed.sceneType === 'string' ? parsed.sceneType : 'mixed',
            activePressures: Array.isArray(parsed.activePressures)
                ? parsed.activePressures.filter(p => typeof p === 'string') : [],
            sceneSummary: typeof parsed.sceneSummary === 'string' ? parsed.sceneSummary : ''
        };
    } catch (e) {
        dlog('[NWST SecretsSidecar] Failed to parse response as JSON:', e);
        return null;
    }
}

// ── State persistence (the latest scene read) ─────────────────────────────

export function getSidecarState(chatId) {
    if (!chatId) chatId = getChatId();
    if (!chatId) return null;
    try {
        const { chatMetadata } = SillyTavern.getContext();
        return chatMetadata?.[SIDECAR_STATE_KEY] || null;
    } catch (e) {
        return null;
    }
}

async function saveSidecarState(chatId, state) {
    if (!chatId) chatId = getChatId();
    if (!chatId) return;
    try {
        const ctx = SillyTavern.getContext();
        ctx.chatMetadata[SIDECAR_STATE_KEY] = state;
        await ctx.saveMetadata();
    } catch (e) {
        dlog('[NWST SecretsSidecar] Failed to save state:', e);
    }
}

// ── Main sidecar run ──────────────────────────────────────────────────────

/**
 * Run the secrets sidecar: analyze the current scene and cache the result.
 * Called on the sidecar cadence by the scanner. Requires the secretsSidecarLLM
 * profile. Skips silently (cheap) if no secrets exist or no profile is set.
 *
 * @returns {Promise<object|null>} The scene analysis, or null if skipped/failed
 */
export async function runSecretsSidecar() {
    if (!isEnabled() || isPaused()) return null;

    const chatId = getChatId();
    if (!chatId) return null;

    // No secrets → nothing to analyze, don't spend an API call
    const secrets = getAllSecrets(chatId);
    if (!secrets || secrets.length === 0) {
        dlog('[NWST SecretsSidecar] No secrets — skipping sidecar.');
        return null;
    }

    const profile = resolveProfile('secretsSidecarLLM');
    if (!profile) {
        dlog('[NWST SecretsSidecar] No Secrets Sidecar profile configured — skipping.');
        return null;
    }

    try {
        const registry = buildAliasRegistry(chatId);
        const scanRange = Math.max(1, parseInt(getSidecarScanRange(), 10) || 5);
        const recentMessages = getRecentProseMessages(scanRange);
        if (recentMessages.length === 0) return null;

        const userPrompt = buildSidecarPrompt(recentMessages, registry, secrets, getUserCharacterIdentity(chatId));
        const messages = [
            { role: 'system', content: SIDECAR_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        dlog(`[NWST SecretsSidecar] Running scene analysis on last ${recentMessages.length}/${scanRange} prose messages...`);
        const response = await generateWithProfile(profile, messages);
        if (!response) return null;

        const analysis = parseSidecarResponse(response, registry);
        if (!analysis) return null;

        // Stamp with the current message index for staleness tracking
        const ctx = SillyTavern.getContext();
        analysis.analyzedAtMessageIndex = (ctx.chat || []).length;
        analysis.scanRange = scanRange;
        analysis.messagesAnalyzed = recentMessages.length;
        analysis.messageRangeStart = Math.max(1, analysis.analyzedAtMessageIndex - recentMessages.length + 1);
        analysis.messageRangeEnd = analysis.analyzedAtMessageIndex;

        await saveSidecarState(chatId, analysis);
        dlog('[NWST SecretsSidecar] Scene analysis complete:', analysis);

        return analysis;
    } catch (err) {
        console.error('[NWST SecretsSidecar] Sidecar failed:', err);
        return null;
    }
}

/**
 * Get the best-available scene context for scoring.
 * Combines the cached sidecar analysis (semantic layer) with a fresh pure-JS
 * prose scan (reliable named-entity layer). If the sidecar has never run, the
 * JS scan alone still provides character presence — degraded but functional.
 *
 * @param {string} chatId
 * @returns {object} sceneContext
 */
export function getSceneContext(chatId) {
    if (!chatId) chatId = getChatId();

    const registry = buildAliasRegistry(chatId);
    const scanRange = Math.max(1, parseInt(getSidecarScanRange(), 10) || 5);
    const userIdentity = getUserCharacterIdentity(chatId);
    const userCanonical = userIdentity.name ? registry.resolve(userIdentity.name) : null;

    // Always run the cheap JS prose scan on the most recent messages.
    // User/PC identity is the only non-prose exception: if a recent user message
    // exists and a PC identity is configured, add it explicitly so first-person
    // user prose still counts as the PC being present.
    const recentMessages = getRecentProseMessages(scanRange);
    const jsDetected = new Set();
    let userMessagePresent = false;
    for (const msg of recentMessages) {
        if (msg.is_user) userMessagePresent = true;
        for (const c of registry.scanProse(msg.mes || '')) {
            jsDetected.add(c);
        }
    }
    if (userMessagePresent && userCanonical) jsDetected.add(userCanonical);

    // Layer the cached sidecar analysis on top (if present)
    const sidecar = getSidecarState(chatId);

    let charactersPresent = Array.from(jsDetected);
    let sceneType = 'unknown';
    let activePressures = [];
    let sceneSummary = '';
    let sidecarFresh = false;

    if (sidecar) {
        // Staleness: only trust semantic sidecar output while it is fresh.
        // Stale sceneType/pressures/characters can otherwise haunt later scenes.
        try {
            const ctx = SillyTavern.getContext();
            const currentIdx = (ctx.chat || []).length;
            const age = currentIdx - (sidecar.analyzedAtMessageIndex || 0);
            // Keep semantic sidecar data only while it still overlaps the
            // configured prose window. Cadence decides when the LLM runs;
            // scan range decides how far its cached scene read may reach.
            const freshnessWindow = Math.max(1, parseInt(getSidecarScanRange(), 10) || 5);
            sidecarFresh = age <= freshnessWindow;
        } catch (e) { /* default false */ }

        if (sidecarFresh) {
            // Merge sidecar's pronoun-resolved characters with JS-detected ones
            const merged = new Set([...charactersPresent, ...(sidecar.charactersPresent || [])]);
            charactersPresent = Array.from(merged);
            sceneType = sidecar.sceneType || 'unknown';
            activePressures = sidecar.activePressures || [];
            sceneSummary = sidecar.sceneSummary || '';
        }
    }

    return {
        charactersPresent,        // canonical IDs
        groupsPresent: charactersPresent.filter(c => registry.isGroup?.(c)),
        userCharacter: userCanonical,
        isPlayerPresent: !!(userCanonical && charactersPresent.includes(userCanonical)),
        sceneType,
        activePressures,
        sceneSummary,
        sidecarFresh,             // if false, scoring uses only fresh JS signals
        sidecarAge: sidecar?.analyzedAtMessageIndex ? Math.max(0, ((SillyTavern.getContext().chat || []).length) - sidecar.analyzedAtMessageIndex) : null,
        sidecarScanRange: Math.max(1, parseInt(getSidecarScanRange(), 10) || 5),
        recentMessageCount: recentMessages.length,
        recentText: recentMessages.map(m => m.mes || '').join('\\n'),
        registry                  // pass through so scoring can resolve names
    };
}
