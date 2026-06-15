/* eslint-disable */
// =============================================================================
// NWST Narrative Consistency — llm/narrativeConsistency.js
// =============================================================================
// TWO SEPARATE MECHANISMS (do not confuse them):
//
// 1. SELECTIVE SECRET INJECTION (per-message, instant, NO API call):
//    - Runs on EVERY message via getSelectiveSecretInjection()
//    - Checks which characters are in the current scene (from message metadata)
//    - Cross-references against all secret whoKnows lists
//    - Injects only secrets whose whoKnows characters are scene-present
//    - Takes milliseconds — no API call needed
//    - If a secret-knowing character appears mid-interval (e.g., message 15
//      of a 20-message scan interval), their secrets are injected starting
//      from that very message. No delay.
//
// 2. NARRATIVE CONSISTENCY CHECK (scan-cadence, REQUIRES API call):
//    - Runs every N messages on the scanner cadence
//    - Uses the Narrative Consistency LLM connection profile
//    - Reviews recent chat for knowledge violations:
//      * Did any whoDoesNotKnow character act on secret info?
//      * Were any reveal conditions met?
//      * Is any character's behavior inconsistent with their knowledge state?
//    - Writes flags to "Consistency flags" notebook field
//    - Does NOT intervene in the story — only flags
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { getNotebook, getAllSecrets, addMysteryBullet, getMysteryField } from '../data/notebook.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { isEnabled, isPaused, getSecretBudgetTokens } from '../settings.js';
import { dlog } from "../lib/debug.js";

// ── Internal prompt (NOT user-editable) ───────────────────────────────────

const CONSISTENCY_SYSTEM_PROMPT = `You are a narrative consistency monitor for an ongoing roleplay. Your job is to check whether any character has acted on knowledge they should NOT possess according to the secrets and hidden knowledge tracker.

You will receive:
- Recent chat messages
- A list of secrets with their whoKnows and whoDoesNotKnow lists
- The current scene's active characters

For EACH secret, check:
1. Did any character in whoDoesNotKnow act on or reference the secret information? This is a VIOLATION.
2. Did any character in whoDoesNotKnow behave as if they know the secret? This is a POTENTIAL VIOLATION.
3. Has any reveal condition been met (even partially)?
4. Is any character's behavior inconsistent with their knowledge state?

IMPORTANT RULES:
- Only FLAG violations. Do NOT generate narrative content or make decisions.
- Be precise — cite the specific message and character.
- A character merely being in the same room as secret-related activity is NOT a violation.
- The character must actively demonstrate knowledge they should not have.
- Messages labeled as just "User" (no character name) are from the real-world person at the keyboard — the OOC author, not a narrative participant. Do not flag "User" messages as knowledge violations.
- If you find no issues, report "No consistency violations detected."

Output format:
If violations found:
  "VIOLATION: [Character] appears to know [secret title] — [specific evidence from chat]"
If no violations:
  "No consistency violations detected."`;

// ═══════════════════════════════════════════════════════════════════════════
// MECHANISM 1: Selective Secret Injection (per-message, NO API call)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get secret blocks for selective injection into the main prompt.
 * Called on EVERY message by promptInjector.js — no API call, instant.
 *
 * Flow:
 *   1. Get all secrets for this chat
 *   2. Detect characters present in the current scene (from recent messages)
 *   3. For each secret, check if any whoKnows character is scene-present
 *   4. If yes → include that secret as a constrained block
 *   5. Secrets whose whoKnows characters are NOT present → excluded
 *
 * This means if a secret-bearing character appears in message 15 of a
 * 20-message scan interval, their secrets start injecting at message 15.
 * The Narrative Consistency LLM scan at message 20 is a separate concern.
 *
 * @param {string} chatId
 * @returns {string} Injection text for active secrets, or empty string
 */
/**
 * Score a secret for relevance in the current scene context.
 * All criteria are pure JS — no LLM calls.
 *
 * @param {object} secret - Secret object
 * @param {string[]} sceneCharacters - Character names in current scene
 * @param {string[]} recentMessageTexts - Raw text of recent messages
 * @param {number} currentMsgIndex - Current message index (chat.length)
 * @returns {number} Relevance score (0 = skip; higher = more relevant)
 */
function scoreSecretRelevance(secret, sceneCharacters, recentMessageTexts, currentMsgIndex) {
    const SCORE = {
        BASELINE_PRESENCE:        1,
        ACTIVE_RISK:              3,
        KEYWORD_MATCH:            4,
        REVEAL_CONDITIONS_ACTIVE: 2,
        COOLDOWN_PENALTY:        -5,
        STALE_BONUS:              2,
    };

    const priority = secret.injectionPriority || 'normal';

    // Low priority: never inject
    if (priority === 'low') return 0;

    // Must have at least one whoKnows character present (baseline)
    if (!secret.whoKnows || secret.whoKnows.length === 0) return 0;
    const knowsPresent = secret.whoKnows.some(name =>
        sceneCharacters.some(sc => sc.toLowerCase() === name.toLowerCase())
    );
    if (!knowsPresent) return 0;

    let score = SCORE.BASELINE_PRESENCE;

    // High priority: boost baseline so it usually wins over normal
    if (priority === 'high') {
        score += 2;
    }

    // Active risk: whoDoesNotKnow character is ALSO present
    if (secret.whoDoesNotKnow && secret.whoDoesNotKnow.length > 0) {
        const unknowingPresent = secret.whoDoesNotKnow.some(name =>
            sceneCharacters.some(sc => sc.toLowerCase() === name.toLowerCase())
        );
        if (unknowingPresent) {
            score += SCORE.ACTIVE_RISK;
        }
    }

    // Reveal conditions populated — secret is designed to be actionable
    if (secret.revealConditions && secret.revealConditions.trim().length > 0) {
        score += SCORE.REVEAL_CONDITIONS_ACTIVE;
    }

    // Keyword matching against recent messages
    if (secret.relevanceKeywords && recentMessageTexts.length > 0) {
        const keywords = secret.relevanceKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        if (keywords.length > 0) {
            const combinedText = recentMessageTexts.join(' ').toLowerCase();
            let matchCount = 0;
            for (const keyword of keywords) {
                if (combinedText.includes(keyword)) {
                    matchCount++;
                }
            }
            // Cap keyword bonus to prevent runaway scoring from common words
            score += Math.min(matchCount, 3) * SCORE.KEYWORD_MATCH;
        }
    }

    // Cooldown: penalize if injected recently
    if (secret.lastInjectionMsgIndex >= 0) {
        const messagesSinceLastInjection = currentMsgIndex - secret.lastInjectionMsgIndex;
        if (messagesSinceLastInjection <= 5) {
            score += SCORE.COOLDOWN_PENALTY;
        } else if (messagesSinceLastInjection >= 20) {
            // Stale bonus: hasn't been injected in a while
            score += SCORE.STALE_BONUS;
        }
    } else {
        // Never injected before — stale bonus applies
        score += SCORE.STALE_BONUS;
    }

    return Math.max(0, score);
}

/**
 * Estimate the token count of a formatted secret block.
 * Rough approximation: ~0.25 tokens per character for English text.
 * @param {object} secret
 * @returns {number} Estimated token count
 */
function estimateSecretTokens(secret) {
    let text = `📜 "${secret.title || ''}" (${secret.type || ''})\n`;
    text += `   Known by: ${(secret.whoKnows || []).join(', ')}\n`;
    text += `   NOT known by: ${(secret.whoDoesNotKnow || []).join(', ')}\n`;
    if (secret.secret) {
        text += `   Details: ${secret.secret}\n`;
    }
    if (secret.revealConditions) {
        text += `   Reveal conditions: ${secret.revealConditions}\n`;
    }
    // Rough token estimate: ~4 chars per token for English
    return Math.ceil(text.length / 4);
}

export function getSelectiveSecretInjection(chatId) {
    // Respect pause/disable state — secrets are sensitive info
    if (!isEnabled()) return '';
    if (isPaused()) return '';

    if (!chatId) chatId = getChatId();
    if (!chatId) return '';

    const secrets = getAllSecrets(chatId);
    if (!secrets || secrets.length === 0) return '';

    // Detect characters in the current scene from recent message metadata
    const sceneCharacters = detectSceneCharacters();

    // Get current message index for cooldown/stale tracking
    let currentMsgIndex = 0;
    try {
        const ctx = SillyTavern.getContext();
        currentMsgIndex = (ctx.chat || []).length;
    } catch (e) {
        // Fallback: just use 0 if context unavailable
    }

    // Get recent message texts for keyword matching
    const recentMessageTexts = getRecentMessageTexts();

    // ── Score all non-low secrets ──────────────────────────────────────
    const scored = [];
    for (const secret of secrets) {
        const score = scoreSecretRelevance(secret, sceneCharacters, recentMessageTexts, currentMsgIndex);
        if (score > 0) {
            scored.push({ secret, score });
        }
    }

    if (scored.length === 0) return '';

    // Sort by score descending (highest relevance first)
    scored.sort((a, b) => b.score - a.score);

    // ── Budget cap ────────────────────────────────────────────────────
    // Use the setting's token budget. Default 600.
    const budgetTokens = getSecretBudgetTokens();

    const injectedSecrets = [];
    let usedTokens = 0;
    const OVERHEAD_TOKENS = 30; // Account for wrapper text: [ACTIVE SECRETS...] + [/ACTIVE SECRETS]

    for (const { secret } of scored) {
        const secretTokens = estimateSecretTokens(secret);
        if (usedTokens + secretTokens + OVERHEAD_TOKENS > budgetTokens) {
            continue; // Skip — would exceed budget
        }
        injectedSecrets.push(secret);
        usedTokens += secretTokens;
    }

    if (injectedSecrets.length === 0) return '';

    // ── Build formatted block ─────────────────────────────────────────
    let block = '\n# ACTIVE SECRETS (FOR INTERNAL USE ONLY)\n';
    block += 'The following secrets are known by characters present in the current scene. ';
    block += 'Characters who do NOT know these secrets must not act on this information:\n';

    for (const secret of injectedSecrets) {
        block += `\n📜 "${secret.title}" (${secret.type})\n`;
        block += `   Known by: ${secret.whoKnows.join(', ')}\n`;
        block += `   NOT known by: ${secret.whoDoesNotKnow.join(', ')}\n`;
        if (secret.secret) {
            block += `   Details: ${secret.secret}\n`;
        }
        if (secret.revealConditions) {
            block += `   Reveal conditions: ${secret.revealConditions}\n`;
        }
    }


    // ── Update lastInjectionMsgIndex (fire-and-forget) ────────────────
    // Save the message index so next invocation can apply cooldown/stale bonuses.
    // Fire-and-forget to avoid blocking prompt injection.
    if (currentMsgIndex > 0) {
        setTimeout(async () => {
            try {
                const { updateSecret } = await import('../data/notebook.js');
                for (const secret of injectedSecrets) {
                    if (secret.lastInjectionMsgIndex !== currentMsgIndex) {
                        await updateSecret(chatId, secret.id, { lastInjectionMsgIndex: currentMsgIndex });
                        secret.lastInjectionMsgIndex = currentMsgIndex; // Update in-memory copy
                    }
                }
            } catch (e) {
                // Silently fail — injection already happened
            }
        }, 0);
    }

    return block;
}

/**
 * Get raw text from recent messages for keyword matching.
 * @returns {string[]} Array of message text strings (last 10 non-system messages)
 */
function getRecentMessageTexts() {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        // Look at last 10 messages (skip system/hidden)
        const texts = [];
        for (let i = chat.length - 1; i >= 0 && texts.length < 10; i--) {
            const msg = chat[i];
            if (msg.is_system && msg.extra?.hidden) continue;
            if (msg.extra?.display === 'none') continue;
            if (msg.mes) {
                texts.push(msg.mes);
            }
        }
        return texts;
    } catch (e) {
        return [];
    }
}

/**
 * Detect which characters are present in the current scene.
 * Uses recent message metadata (character names) from ST's chat context.
 * This runs PER-MESSAGE with no API call — it's a fast local lookup.
 *
 * @returns {string[]} Array of character names detected in recent messages
 */
function detectSceneCharacters() {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const recentCount = Math.min(15, chat.length);
        const recentMessages = chat.slice(-recentCount);

        // Build a lookup of known character names from ST's character registry
        const knownNames = buildKnownNameSet();

        const characters = new Set();
        for (const msg of recentMessages) {
            // Direct speaker detection (unchanged)
            if (msg.name && !msg.is_user) {
                characters.add(msg.name);
            }

            // ── Narrator-name parsing ────────────────────────────────
            // For narration/system messages, scan the prose text for
            // mentions of known character names.  This catches
            // characters who are described acting but haven't spoken
            // (e.g. "Lysander watches from the shadows" in a GM message).
            if (msg.mes && knownNames.size > 0) {
                const msgText = msg.mes.toLowerCase();
                for (const knownName of knownNames) {
                    if (msgText.includes(knownName.toLowerCase())) {
                        characters.add(knownName);
                    }
                }
            }
        }
        return Array.from(characters);
    } catch (e) {
        console.warn('[NWST NarrativeConsistency] Error detecting scene characters:', e);
        return [];
    }
}

/**
 * Build a set of known character names from ST's character registry.
 * Combines character card names with any names seen in chat messages.
 * @returns {Set<string>} Lowercase character names
 */
function buildKnownNameSet() {
    const names = new Set();
    try {
        const ctx = SillyTavern.getContext();
        // From ST's character array (character cards)
        if (Array.isArray(ctx.characters)) {
            for (const char of ctx.characters) {
                if (char?.name) names.add(char.name);
            }
        }
        // From chat messages (catches group members, NPC aliases, etc.)
        const chat = ctx.chat || [];
        for (const msg of chat) {
            if (msg.name && !msg.is_user) {
                names.add(msg.name);
            }
        }
    } catch (e) {
        // Fallback: empty set — narrator parsing won't run but direct
        // speaker detection still works
    }
    return names;
}

// ═══════════════════════════════════════════════════════════════════════════
// MECHANISM 2: Narrative Consistency Check (scan-cadence, REQUIRES API call)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the narrative consistency check via the Narrative Consistency LLM.
 * Called by the scanner on its cadence (every N messages).
 * This REQUIRES an API call — it's the heavier retrospective analysis.
 *
 * @returns {Promise<boolean>} True if violations were found and flagged
 */
export async function runConsistencyCheck() {
    if (!isEnabled() || isPaused()) return false;
    const chatId = getChatId();
    if (!chatId) return false;

    try {
        const profile = resolveProfile('narrativeConsistencyLLM');
        if (!profile) {
            dlog('[NWST NarrativeConsistency] No Narrative Consistency profile configured — skipping check.');
            return false;
        }

        const secrets = getAllSecrets(chatId);
        if (secrets.length === 0) {
            return false; // No secrets to monitor
        }

        // Gather recent messages and scene context
        const recentMessages = getRecentSceneMessages();
        const sceneCharacters = detectSceneCharactersFromMessages(recentMessages);

        // Build the prompt
        const userPrompt = buildConsistencyPrompt(secrets, recentMessages, sceneCharacters);

        // Call the Narrative Consistency LLM via connection profile
        const messages = [
            { role: 'system', content: CONSISTENCY_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        dlog('[NWST NarrativeConsistency] Running consistency check...');
        const response = await generateWithProfile(profile, messages);

        if (!response) return false;

        // Check if violations were found
        const responseLower = response.toLowerCase();
        const hasViolations = responseLower.includes('violation');
        const hasNoIssues = responseLower.includes('no consistency violations');

        if (hasViolations && !hasNoIssues) {
            flagViolations(chatId, response);
            nwstToast('Narrative consistency violations flagged — check the Notebook.', 'warning');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('notebook');
            return true;
        }

        dlog('[NWST NarrativeConsistency] No violations detected.');
        return false;

    } catch (err) {
        console.error('[NWST NarrativeConsistency] Check failed:', err);
        return false;
    }
}

// ── Context gathering for consistency check ───────────────────────────────

function getRecentSceneMessages() {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        // Get last 15 messages for the consistency check
        const start = Math.max(0, chat.length - 15);
        return chat.slice(start).filter(msg => {
            if (msg.is_system && msg.extra?.hidden) return false;
            if (msg.extra?.display === 'none') return false;
            return true;
        });
    } catch (e) {
        return [];
    }
}

function detectSceneCharactersFromMessages(messages) {
    const characters = new Set();
    for (const msg of messages) {
        if (msg.name && !msg.is_user) {
            characters.add(msg.name);
        }
    }
    return Array.from(characters);
}

function buildConsistencyPrompt(secrets, recentMessages, sceneCharacters) {
    let prompt = '';

    prompt += `=== SCENE CHARACTERS PRESENT ===\n`;
    prompt += sceneCharacters.join(', ') || '(unknown)';
    prompt += '\n\n';

    prompt += `=== RECENT MESSAGES ===\n`;
    for (const msg of recentMessages) {
        const sender = msg.name || (msg.is_user ? 'User' : 'Character');
        prompt += `[${sender}]: ${msg.mes}\n`;
    }
    prompt += '\n';

    prompt += `=== ALL SECRETS (${secrets.length}) ===\n`;
    for (const secret of secrets) {
        prompt += `---\n`;
        prompt += `Title: ${secret.title}\n`;
        prompt += `Type: ${secret.type}\n`;
        prompt += `Secret: ${secret.secret}\n`;
        prompt += `Who Knows: ${secret.whoKnows?.join(', ') || '(none)'}\n`;
        prompt += `Who Does NOT Know: ${secret.whoDoesNotKnow?.join(', ') || '(none)'}\n`;
        prompt += `Evidence Shown: ${secret.evidenceShown || '(none)'}\n`;
        prompt += `Reveal Conditions: ${secret.revealConditions || '(none)'}\n`;
    }
    prompt += '\n';

    prompt += `Check each secret for knowledge violations in the recent messages.`;

    return prompt;
}

// ── Flag violations in notebook ───────────────────────────────────────────

async function flagViolations(chatId, response) {
    // Parse violation lines from the response
    const lines = response.split('\n').filter(line =>
        line.trim().toLowerCase().startsWith('violation')
    );

    for (const line of lines) {
        const flagText = `[Narrative Consistency] ${line.trim()}`;
        await addMysteryBullet(chatId, 'inconsistenciesFlagged', flagText);
    }

    // If we couldn't parse specific lines, add the whole response as one flag
    if (lines.length === 0 && response.trim()) {
        await addMysteryBullet(chatId, 'inconsistenciesFlagged',
            `[Narrative Consistency] ${response.trim().substring(0, 200)}`);
    }
}
