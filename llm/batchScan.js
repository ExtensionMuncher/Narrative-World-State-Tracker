/* eslint-disable */
// =============================================================================
// NWST Batch Scan — llm/batchScan.js
// =============================================================================
// Scans the FULL chat history to generate an initial world state.
//
// KEY EXCEPTION: Batch scan is the ONLY process that reads ALL messages
// regardless of ST's visibility flags. Every other process respects them.
//
// Process:
//   1. Chunk the full chat history into context-window-safe segments
//   2. Process chunks sequentially through the Planning LLM
//   3. Show ST native toast notifications at each stage
//   4. Generate: Current Day, forecast/moon phases, initial events,
//      world conditions, notebook fields, community groupings
//   5. Does NOT overwrite any field that already contains data
//   6. Runs once — non-compounding
// =============================================================================

import { getChatId, nwstToast } from '../index.js';
import { chatHasData } from '../data/storage.js';
import { getWorldState, saveSnapshot } from '../data/worldState.js';
import { getAllEvents } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { resolveProfile } from './connections.js';
import { getContext, getMaxContextSize } from '../../../../../script.js';

// ── Internal prompt (NOT user-editable) ───────────────────────────────────

const BATCH_SCAN_SYSTEM_PROMPT = `You are a narrative world state generator. You are reading the FULL history of a roleplay chat and must generate a complete initial world state from it.

You will receive the chat history in chunks. Process each chunk and accumulate your understanding. After the final chunk, generate:

1. CURRENT DAY BLOCK: The current date, season, weather, flora, fauna, and spiritual climate (if applicable)
2. INITIAL EVENTS: Upcoming events across all tiers (immediate, this week, this month, undetermined) that are implied or explicitly mentioned
3. WORLD CONDITIONS: Political, social, spiritual/supernatural, and environmental conditions
4. NOTEBOOK SEEDING: Unresolved details, promises/threats/deadlines, offscreen pressures, important facts, planted details, character whereabouts, current tone/atmosphere
5. COMMUNITY GROUPINGS: Character clusters and their dynamics

RULES:
- Only use information explicitly found in the chat history. Do NOT invent.
- If a field has no relevant information, leave it empty.
- Write with atmospheric, narrative detail.
- Flag any inconsistencies you detect in the chat history.
- Do NOT mark any events as auto-committed. All events are proposed for review.`;

// ── Execute Batch Scan ────────────────────────────────────────────────────

/**
 * Run a full batch scan on the current chat.
 * This is the only function that reads ALL messages regardless of visibility.
 *
 * Toast notification sequence (per spec):
 *   1. "Narrative World State Tracker: Batch scan started — analyzing chat history..."
 *   2. "Narrative World State Tracker: Processing messages [X]–[Y]..." (per chunk)
 *   3. "Narrative World State Tracker: [Component] complete." (per component)
 *   4. "Narrative World State Tracker: Batch scan complete."
 *   5. On error: "Narrative World State Tracker: Batch scan failed at [stage]. Check console for details."
 *
 * @returns {Promise<boolean>} True on success
 */
export async function runBatchScan() {
    const chatId = getChatId();
    if (!chatId) {
        nwstToast('No active chat detected.', 'error');
        return false;
    }

    // Check if batch scan has already been run for this chat
    if (chatHasData(chatId)) {
        nwstToast('Batch scan has already been run for this chat. Existing data will not be overwritten.', 'warning');
        return false;
    }

    nwstToast('Batch scan started — analyzing chat history...', 'info');
    showBatchScanLoading(true);

    try {
        const profile = resolveProfile('planningLLM');
        if (!profile) {
            throw new Error('No Planning LLM connection profile configured. Set one in Settings > Connection Profiles.');
        }

        // Get the full chat history — ALL messages, regardless of visibility flags
        // This is the DOCUMENTED EXCEPTION to the visibility rule
        const allMessages = getAllMessagesUnfiltered();
        if (allMessages.length === 0) {
            nwstToast('No chat messages found to scan.', 'warning');
            showBatchScanLoading(false);
            return false;
        }

        // Calculate chunk size based on context window
        const maxContext = getMaxContextSize();
        const chunkSize = Math.floor(maxContext * 0.6); // 60% for input, 40% for output
        const chunks = chunkMessages(allMessages, chunkSize);

        console.log(`[NWST BatchScan] Processing ${allMessages.length} messages in ${chunks.length} chunks...`);
        console.log(`[NWST BatchScan] Max context: ${maxContext}, Chunk size: ~${chunkSize} tokens`);

        // Process each chunk sequentially through the Planning LLM
        let accumulatedContext = '';
        for (let i = 0; i < chunks.length; i++) {
            const messagesPerChunk = Math.ceil(allMessages.length / chunks.length);
            const startMsg = i * messagesPerChunk + 1;
            const endMsg = Math.min((i + 1) * messagesPerChunk, allMessages.length);

            nwstToast(`Processing messages ${startMsg}–${endMsg}...`, 'info');

            const chunkText = formatChunkForLLM(chunks[i], i + 1, chunks.length, startMsg, endMsg);

            // Call Planning LLM for this chunk
            const { generateRaw } = await import('../../../../../script.js');
            const messages = [
                { role: 'system', content: BATCH_SCAN_SYSTEM_PROMPT },
                { role: 'user', content: chunkText }
            ];

            const response = await generateRaw(messages, null, profile.id, null, false, false);
            if (response) {
                accumulatedContext += `\n--- Chunk ${i + 1}/${chunks.length} Analysis ---\n${response}\n`;
            }
        }

        // After all chunks processed, synthesize final structured results
        nwstToast('Synthesizing world state from full analysis...', 'info');
        await synthesizeBatchResults(chatId, profile, accumulatedContext, allMessages);

        nwstToast('Batch scan complete.', 'success');
        return true;

    } catch (err) {
        console.error('[NWST BatchScan] Failed:', err);
        nwstToast(`Batch scan failed at processing stage. Check console for details.`, 'error');
        return false;
    } finally {
        showBatchScanLoading(false);
    }
}

// ── Message access (BATCH SCAN EXCEPTION — reads ALL messages) ────────────

function getAllMessagesUnfiltered() {
    try {
        const ctx = getContext();
        return ctx.chat || [];
    } catch (e) {
        console.error('[NWST BatchScan] Error accessing chat:', e);
        return [];
    }
}

/**
 * Chunk messages into context-window-safe segments.
 * Uses approximate token counting (1 token ≈ 4 characters).
 *
 * @param {object[]} messages - Full message array
 * @param {number} approxTokensPerChunk - Approximate max tokens per chunk
 * @returns {object[][]} Array of message chunks
 */
function chunkMessages(messages, approxTokensPerChunk) {
    const charsPerChunk = approxTokensPerChunk * 4;
    const chunks = [];
    let currentChunk = [];
    let currentChars = 0;

    for (const msg of messages) {
        const msgText = `[${msg.name || (msg.is_user ? 'User' : 'Character')}]: ${msg.mes || ''}`;
        const msgChars = msgText.length;

        // If adding this message would exceed chunk size and chunk isn't empty,
        // finalize current chunk and start a new one
        if (currentChars + msgChars > charsPerChunk && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentChars = 0;
        }

        currentChunk.push(msg);
        currentChars += msgChars;
    }

    // Don't forget the last chunk
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

function formatChunkForLLM(chunk, chunkNum, totalChunks, startMsg, endMsg) {
    let text = `CHUNK ${chunkNum}/${totalChunks} — Messages ${startMsg}–${endMsg}\n`;
    text += `This is chunk ${chunkNum} of ${totalChunks}. `;

    if (chunkNum === 1) {
        text += `This is the BEGINNING of the chat history. Pay attention to setting details, character introductions, and initial world state clues.\n\n`;
    } else if (chunkNum === totalChunks) {
        text += `This is the FINAL chunk — the most recent messages. Pay closest attention to the current state of the world.\n\n`;
    } else {
        text += `Continue building your understanding of the narrative.\n\n`;
    }

    for (const msg of chunk) {
        const sender = msg.name || (msg.is_user ? 'User' : 'Character');
        text += `[${sender}]: ${msg.mes}\n`;
    }

    text += `\n(End of chunk ${chunkNum}/${totalChunks})`;

    return text;
}

// ── Final Synthesis ───────────────────────────────────────────────────────

async function synthesizeBatchResults(chatId, profile, accumulatedContext, allMessages) {
    // Build a final synthesis prompt asking for structured JSON output
    const synthesisPrompt = `You have now read the full ${allMessages.length}-message chat history. Below is your accumulated analysis from each chunk.

${accumulatedContext}

Now synthesize the COMPLETE initial world state as a single JSON object. Use this EXACT structure:

{
  "currentDay": {
    "dateDisplay": "string — the current in-game date, written narratively",
    "dateSub": "string — era, year, or sub-date context",
    "season": "string — current season with atmospheric detail",
    "weatherToday": "string — today's weather, written narratively",
    "flora": "string — current flora state",
    "fauna": "string — current fauna state",
    "spiritualClimate": "string — metaphysical climate (omit if no spiritual elements exist)"
  },
  "events": [
    {
      "title": "string",
      "description": "string",
      "tier": "immediate|week|month|undetermined",
      "isNPC": false
    }
  ],
  "conditions": {
    "political": "string or empty",
    "social": "string or empty",
    "spiritual": "string or empty",
    "environmental": "string or empty"
  },
  "notebook": {
    "core": {
      "unresolvedDetail": ["string", ...],
      "promiseThreatDeadline": ["string", ...],
      "offscreenPressure": ["string", ...],
      "doNotForget": ["string", ...]
    },
    "mystery": {
      "establishedFacts": ["string", ...],
      "plantedDetails": ["string", ...],
      "characterWhereabouts": ["string", ...],
      "inconsistenciesFlagged": ["string", ...],
      "currentToneAtmosphere": ["string", ...]
    }
  },
  "communities": [
    {
      "name": "string",
      "members": "string — comma-separated names",
      "summary": "string — social dynamics description"
    }
  ]
}

Respond with valid JSON ONLY. No markdown, no explanation outside the JSON.`;

    const { generateRaw } = await import('../../../../../script.js');
    const messages = [
        { role: 'system', content: BATCH_SCAN_SYSTEM_PROMPT },
        { role: 'user', content: synthesisPrompt }
    ];

    const response = await generateRaw(messages, null, profile.id, null, false, false);

    if (!response) {
        nwstToast('Synthesis completed but no structured data was returned. Try running again.', 'warning');
        return;
    }

    // Parse and apply the synthesis results
    const result = parseBatchSynthesis(response);
    if (result) {
        await applyBatchResults(chatId, result);
    } else {
        nwstToast('Could not parse batch scan results. The LLM may have returned an invalid format.', 'error');
    }
}

// ── Parse LLM response ────────────────────────────────────────────────────

function parseBatchSynthesis(response) {
    if (!response || typeof response !== 'string') return null;

    let jsonStr = response.trim();

    // Remove markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Find outermost JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];

    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        console.warn('[NWST BatchScan] Could not parse synthesis JSON:', e);
        console.log('Raw response (first 500 chars):', response.substring(0, 500));
        return null;
    }
}

// ── Apply batch results to storage ────────────────────────────────────────

async function applyBatchResults(chatId, result) {
    // Apply Current Day
    if (result.currentDay) {
        const { replaceCurrentDay } = await import('../data/worldState.js');
        replaceCurrentDay(chatId, result.currentDay);
        nwstToast('Current Day block generated.', 'info');
    }

    // Apply events
    if (result.events && Array.isArray(result.events)) {
        const { addEvent } = await import('../data/events.js');
        for (const event of result.events) {
            addEvent(chatId, {
                ...event,
                status: 'pending',
                origin: 'detected',
                isNPC: event.isNPC || false,
                npcOrigin: event.isNPC ? 'detected' : null
            });
        }
        nwstToast('Events complete.', 'info');
    }

    // Apply conditions
    if (result.conditions) {
        const { updateConditionContent } = await import('../data/worldState.js');
        for (const [key, content] of Object.entries(result.conditions)) {
            if (content && typeof content === 'string' && content.trim()) {
                updateConditionContent(chatId, key, content);
            }
        }
        nwstToast('World conditions complete.', 'info');
    }

    // Apply notebook (merge with defaults to avoid missing fields)
    if (result.notebook) {
        const { getNotebook: getNb, saveNotebook } = await import('../data/notebook.js');
        saveNotebook(chatId, result.notebook);
        nwstToast('Notebook seeded.', 'info');
    }

    // Apply communities
    if (result.communities && Array.isArray(result.communities)) {
        const { addCommunity } = await import('../data/communities.js');
        for (const com of result.communities) {
            if (com.name) {
                addCommunity(chatId, com);
            }
        }
    }

    // Save a post-batch-scan snapshot
    const { getWorldState, saveSnapshot: saveSnap } = await import('../data/worldState.js');
    const { getAllEvents: getEvents } = await import('../data/events.js');
    const { getNotebook: getNb } = await import('../data/notebook.js');
    saveSnap(chatId, 'batch_scan', getWorldState(chatId), getEvents(chatId), getNb(chatId));
}

// ── Loading UI ────────────────────────────────────────────────────────────

function showBatchScanLoading(show) {
    const spinner = document.getElementById('nwst-batchScan-spinner');
    const btn = document.getElementById('nwst-setting-batchScan');

    if (spinner) spinner.style.display = show ? 'inline-block' : 'none';
    if (btn) {
        btn.disabled = show;
        btn.textContent = show ? 'Scanning...' : 'Run batch scan';
    }
}
