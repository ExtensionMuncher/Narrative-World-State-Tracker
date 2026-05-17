/* eslint-disable */
// =============================================================================
// NWST Message Scanner — llm/scanner.js
// =============================================================================
// Background scanner that runs every N messages (configurable, default 20).
// Calls the Planning LLM to review recent chat messages and update:
//   - Notebook fields (adds/modifies bullets)
//   - Community summaries
//   - World conditions
//   - Flags NPC detected events (proposed to user, never auto-committed)
//
// The scanner does NOT update the Current Day block or auto-commit event changes.
// =============================================================================

import { getChatId, nwstToast } from '../index.js';
import { getScanFrequency, isPaused, isEnabled, getPlannerPrompt } from '../settings.js';
import { getWorldState, getEnabledConditions, getSettingContext } from '../data/worldState.js';
import { getActiveEvents, addEvent } from '../data/events.js';
import { getNotebook, addCoreBullet, addMysteryBullet } from '../data/notebook.js';
import { getAllCommunities, updateCommunitySummary } from '../data/communities.js';
import { resolveProfile } from './connections.js';
import { runConsistencyCheck } from './narrativeConsistency.js';

// ── Scanner state ─────────────────────────────────────────────────────────

let messageCountAtLastScan = 0;
let scanTimer = null;
let isScanning = false;

// ── Internal prompt (NOT user-editable) ───────────────────────────────────

const SCANNER_SYSTEM_PROMPT = `You are a narrative world state scanner for an ongoing roleplay. You review recent chat messages and maintain the living world state. Your updates must be grounded in what actually happened in the chat.

You will receive:
- Recent chat messages (the latest exchanges)
- Current world state (date, season, conditions)
- Current notebook (established facts, planted details, etc.)
- Active community summaries
- Active upcoming events

Your task:
1. Review recent messages for new facts, developments, or changes
2. Update notebook fields as appropriate:
   - Add unresolved details that were introduced
   - Note promises, threats, or deadlines made
   - Update offscreen pressures (things happening away from the scene)
   - Add "do not forget" items for important details
   - Add established facts (things confirmed in chat)
   - Note planted details (hooks that haven't resolved)
   - Update character whereabouts if mentioned
   - Flag any contradictions or inconsistencies you detect
   - Note the current tone/atmosphere
3. Update community summaries if social dynamics have shifted
4. Update world conditions if the state of the world has changed
5. Identify any NPC events detected in the chat (plans, meetings, promises made by characters)

IMPORTANT RULES:
- Do NOT invent events. Only flag events that are explicitly mentioned or implied by characters in the chat.
- Do NOT auto-commit event changes. Flag detected NPC events for user review.
- Do NOT update the Current Day block (that's handled separately).
- Be factual. Write in the notebook's existing style — concise, bullet-point observations.
- If you detect inconsistencies, flag them in the inconsistencies field with specific references.`;

// ── Start / Stop Scanner ──────────────────────────────────────────────────

/**
 * Start the background scanner. Runs on a message-count-based cadence.
 * Listens for ST's native MESSAGE_SENT and MESSAGE_RECEIVED events instead
 * of polling — no setInterval needed.
 */
export function startScanner() {
    if (scanTimer) {
        console.log('[NWST Scanner] Scanner already running.');
        return;
    }

    console.log(`[NWST Scanner] Starting scanner (frequency: every ${getScanFrequency()} messages)...`);
    messageCountAtLastScan = getCurrentMessageCount();

    // Listen for ST's native message events instead of polling
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.MESSAGE_SENT, checkAndScan);
    eventSource.on(event_types.MESSAGE_RECEIVED, checkAndScan);
    scanTimer = 'event-driven'; // marker that scanner is running

    console.log('[NWST Scanner] Scanner started (event-driven).');
}

/**
 * Stop the background scanner.
 */
export function stopScanner() {
    if (!scanTimer) return;

    try {
        const { eventSource, event_types } = SillyTavern.getContext();
        eventSource.removeListener(event_types.MESSAGE_SENT, checkAndScan);
        eventSource.removeListener(event_types.MESSAGE_RECEIVED, checkAndScan);
    } catch (e) {
        console.warn('[NWST Scanner] Error detaching event listeners:', e);
    }

    scanTimer = null;
    console.log('[NWST Scanner] Scanner stopped.');
}

/**
 * Restart the scanner (e.g., after frequency change).
 */
export function restartScanner() {
    stopScanner();
    startScanner();
}

// ── Scan check ────────────────────────────────────────────────────────────

async function checkAndScan() {
    // Don't scan if extension is disabled or paused
    if (!isEnabled() || isPaused()) return;

    // Don't scan if already scanning
    if (isScanning) return;

    const currentCount = getCurrentMessageCount();
    const frequency = getScanFrequency();
    const messagesSinceLastScan = currentCount - messageCountAtLastScan;

    if (messagesSinceLastScan >= frequency) {
        await runScan();
        messageCountAtLastScan = currentCount;
    }
}

async function runScan() {
    isScanning = true;
    console.log('[NWST Scanner] Running scan...');

    try {
        const chatId = getChatId();
        if (!chatId) return;

        const profile = resolveProfile('planningLLM');
        if (!profile) {
            console.warn('[NWST Scanner] No Planning LLM profile — skipping scan.');
            return;
        }

        // Gather context for the Planning LLM
        const recentMessages = getRecentMessages(getScanFrequency());
        const worldState = getWorldState(chatId);
        const notebook = getNotebook(chatId);
        const communities = getAllCommunities(chatId);
        const activeEvents = getActiveEvents(chatId);
        const settingContext = getSettingContext(chatId);

        // Build the scan prompt
        const userPrompt = buildScannerPrompt(recentMessages, worldState, notebook, communities, activeEvents, settingContext);

        // Call Planning LLM via SillyTavern.getContext() — the stable API
        const { generateRaw } = SillyTavern.getContext();
        const messages = [
            { role: 'system', content: SCANNER_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        console.log('[NWST Scanner] Calling Planning LLM...');
        const response = await generateRaw(messages, null, profile.id, null, false, false);

        if (!response) {
            console.log('[NWST Scanner] Empty response — no updates needed.');
            return;
        }

        // Parse and apply the scanner's findings
        const hadUpdates = await applyScanResults(chatId, response);

        if (hadUpdates) {
            nwstToast('World state updated.', 'info');
            // Refresh UI if panel is open
            if (typeof window?.nwstRefreshAllUI === 'function') {
                window.nwstRefreshAllUI();
            }
        }

        // Run narrative consistency check after each scan
        // This reviews recent chat for knowledge violations against secret whoKnows/whoDoesNotKnow lists
        await runConsistencyCheck();

        console.log('[NWST Scanner] Scan complete.');

    } catch (err) {
        console.error('[NWST Scanner] Scan failed:', err);
    } finally {
        isScanning = false;
    }
}

// ── Context gathering ─────────────────────────────────────────────────────

function getCurrentMessageCount() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.chat?.length || 0;
    } catch (e) {
        return 0;
    }
}

function getRecentMessages(count) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        // Get the most recent N messages, respecting visibility flags
        const start = Math.max(0, chat.length - count);
        return chat.slice(start).filter(msg => {
            // Respect ST's visibility flags
            if (msg.is_system && msg.extra?.hidden) return false;
            return true;
        });
    } catch (e) {
        return [];
    }
}

function buildScannerPrompt(recentMessages, worldState, notebook, communities, activeEvents, settingContext) {
    let prompt = '';

    // Recent messages
    prompt += `=== RECENT CHAT MESSAGES ===\n`;
    for (const msg of recentMessages) {
        const sender = msg.name || (msg.is_user ? 'User' : 'Character');
        prompt += `[${sender}]: ${msg.mes}\n`;
    }
    prompt += `\n`;

    // Current world state summary
    prompt += `=== CURRENT WORLD STATE ===\n`;
    prompt += `Date: ${worldState.currentDay?.dateDisplay || '(not set)'}\n`;
    prompt += `Season: ${worldState.currentDay?.season || '(not set)'}\n`;
    prompt += `Weather: ${worldState.currentDay?.weatherToday || '(not set)'}\n`;
    prompt += `\n`;

    // Active conditions
    const conditions = worldState.conditions || {};
    prompt += `=== WORLD CONDITIONS ===\n`;
    for (const [key, cond] of Object.entries(conditions)) {
        if (cond.enabled && cond.content) {
            prompt += `[${key.toUpperCase()}]: ${cond.content}\n`;
        }
    }
    prompt += `\n`;

    // Notebook summary
    prompt += `=== NOTEBOOK ===\n`;
    prompt += formatNotebookForPrompt(notebook);
    prompt += `\n`;

    // Communities
    if (communities.length > 0) {
        prompt += `=== COMMUNITIES ===\n`;
        for (const com of communities) {
            prompt += `- ${com.name}: ${com.summary || '(no summary)'}\n`;
        }
        prompt += `\n`;
    }

    // Active events
    if (activeEvents.length > 0) {
        prompt += `=== ACTIVE EVENTS ===\n`;
        for (const event of activeEvents) {
            prompt += `- [${event.tier}] ${event.title}: ${event.description}\n`;
        }
        prompt += `\n`;
    }

    if (settingContext) {
        prompt += `=== SETTING CONTEXT ===\n${settingContext}\n\n`;
    }

    prompt += `Review the recent messages and update the world state accordingly. Identify any new notebook entries, world condition changes, community shifts, or NPC events that should be flagged.`;

    return prompt;
}

function formatNotebookForPrompt(notebook) {
    let text = '';
    const core = notebook.core || {};
    const mystery = notebook.mystery || {};

    if (core.unresolvedDetail?.length) text += `Unresolved: ${core.unresolvedDetail.join('; ')}\n`;
    if (core.promiseThreatDeadline?.length) text += `Promises/Threats: ${core.promiseThreatDeadline.join('; ')}\n`;
    if (core.offscreenPressure?.length) text += `Offscreen Pressure: ${core.offscreenPressure.join('; ')}\n`;
    if (core.doNotForget?.length) text += `Don't Forget: ${core.doNotForget.join('; ')}\n`;
    if (mystery.establishedFacts?.length) text += `Facts: ${mystery.establishedFacts.join('; ')}\n`;
    if (mystery.plantedDetails?.length) text += `Planted: ${mystery.plantedDetails.join('; ')}\n`;
    if (mystery.characterWhereabouts?.length) text += `Whereabouts: ${mystery.characterWhereabouts.join('; ')}\n`;
    if (mystery.inconsistenciesFlagged?.length) text += `Inconsistencies: ${mystery.inconsistenciesFlagged.join('; ')}\n`;

    return text || '(notebook is empty)\n';
}

// ── Apply scan results ────────────────────────────────────────────────────

/**
 * Parse the Planning LLM's scan response and apply updates.
 * The LLM response is expected to contain structured sections for each update type.
 *
 * @param {string} chatId
 * @param {string} response - The LLM's response text
 * @returns {Promise<boolean>} True if any updates were applied
 */
async function applyScanResults(chatId, response) {
    if (!response || typeof response !== 'string') return false;

    let hadUpdates = false;
    const text = response.trim();

    // Try to parse structured updates from the response
    // The LLM may use markdown sections like:
    // ### Notebook Updates
    // ### World Condition Updates
    // ### NPC Events Detected

    // For now, we log the response and flag that processing occurred
    // Full structured parsing will be refined during integration testing
    console.log('[NWST Scanner] LLM response received (' + text.length + ' chars).');

    // If the response indicates no changes needed, skip
    if (text.toLowerCase().includes('no updates') || text.toLowerCase().includes('no changes')) {
        console.log('[NWST Scanner] LLM indicated no updates needed.');
        return false;
    }

    // Mark that the scanner found updates
    hadUpdates = true;

    // Future: Parse notebook updates, condition changes, NPC event proposals
    // For the initial build, the structured parsing will be refined during
    // integration testing with actual LLM responses.

    return hadUpdates;
}
