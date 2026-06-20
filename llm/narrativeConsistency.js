/* eslint-disable */
// =============================================================================
// NWST Narrative Consistency — llm/narrativeConsistency.js
// =============================================================================
// NARRATIVE CONSISTENCY CHECK (scan-cadence, REQUIRES API call):
//    - Runs every N messages on the scanner cadence
//    - Uses the Narrative Consistency LLM connection profile
//    - Reviews recent chat for knowledge violations:
//      * Did any whoDoesNotKnow character act on secret info?
//      * Were any reveal conditions met?
//      * Is any character's behavior inconsistent with their knowledge state?
//    - Writes flags to the Inconsistencies notebook field
//    - Does NOT intervene in the story — only flags
//
// NOTE: Per-message secret INJECTION is no longer handled here. It moved to
// the prose-based scoring engine in secretsScoring.js + secretsInjection.js
// (the v2 secrets refactor). This file is now purely the violation auditor.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { getAllSecrets, addMysteryBullet } from '../data/notebook.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { isEnabled, isPaused } from '../settings.js';
import { dlog } from "../lib/debug.js";
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
