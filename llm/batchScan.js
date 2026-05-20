/* eslint-disable */
import { generateWithProfile } from './connections.js';
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
//   4. Generate: Current Day, initial events, world conditions,
//      notebook fields, community groupings
//   5. Then seed the 7-day forecast and moon phases via Day Advancement LLM
//   6. Does NOT overwrite any field that already contains data
//   7. Runs once — non-compounding
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';;
import { chatHasData } from '../data/storage.js';
import { getWorldState, saveSnapshot, getSettingContext, getCalendarConfig } from '../data/worldState.js';
import { getAllEvents } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { resolveProfile } from './connections.js';
import { regenerateForecast } from './dayAdvancement.js';

// ── Date computation helper ─────────────────────────────────────────────────

/**
 * Compute day-of-year from a date string like "Monday, April 15th, 2024".
 * Used as a client-side fallback when the LLM doesn't provide dayCount.
 * @param {string} dateStr
 * @returns {number|null} Day of year (1-366), or null if unparseable
 */
function computeDayOfYearFromDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december'];
    const monthMap = {};
    monthNames.forEach((name, i) => { monthMap[name] = i; });

    // Strip ordinal suffixes (st, nd, rd, th) so "15th" becomes "15"
    const cleaned = dateStr.replace(/(\d+)(st|nd|rd|th)/gi, '$1');

    // Match "Month Day, Year" pattern — e.g. "April 15, 2024" or "April 15 2024"
    const dateMatch = cleaned.match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})/);
    if (dateMatch) {
        const monthName = dateMatch[1].toLowerCase();
        const day = parseInt(dateMatch[2], 10);
        const year = parseInt(dateMatch[3], 10);
        const month = monthMap[monthName];
        if (month !== undefined && day >= 1 && day <= 31 && year >= 1) {
            const date = new Date(year, month, day);
            const startOfYear = new Date(year, 0, 0); // Dec 31 of previous year
            const diff = date - startOfYear;
            const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
            if (dayOfYear >= 1 && dayOfYear <= 366) {
                console.log(`[NWST BatchScan] Computed dayCount ${dayOfYear} from date "${dateStr}"`);
                return dayOfYear;
            }
        }
    }

    // Also try ISO format: "2024-04-15"
    const isoMatch = cleaned.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
        const year = parseInt(isoMatch[1], 10);
        const month = parseInt(isoMatch[2], 10) - 1; // JS months are 0-indexed
        const day = parseInt(isoMatch[3], 10);
        if (year >= 1 && month >= 0 && month <= 11 && day >= 1 && day <= 31) {
            const date = new Date(year, month, day);
            const startOfYear = new Date(year, 0, 0);
            const diff = date - startOfYear;
            const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
            if (dayOfYear >= 1 && dayOfYear <= 366) {
                console.log(`[NWST BatchScan] Computed dayCount ${dayOfYear} from ISO date "${dateStr}"`);
                return dayOfYear;
            }
        }
    }

    return null;
}

// ── Internal prompts ───────────────────────────────────────────────────────

// Chunk analysis prompt — used for each chunk pass
const BATCH_CHUNK_PROMPT = `You are analyzing a segment of a roleplay chat history to build a world state. Read carefully and extract:

1. Any explicit or implied date, time, season, or era information
2. Setting details — location, climate, atmosphere, cultural context
3. Upcoming events mentioned by characters or implied by the world
4. World conditions — political tensions, social dynamics, spiritual/supernatural elements, environmental state
5. Key facts, unresolved threads, planted details, character whereabouts
6. Character social groupings and dynamics
7. World-level context separately — what the SETTING, CONDITIONS, SEASON, and WORLD imply for upcoming events (distinct from chat-detected events). Note seasonal shifts, political undercurrents, environmental changes that could generate events even if no one in the chat mentioned them.

Accumulate your findings. If this is not the final chunk, do not produce final output yet — just summarize what you found in plain text for later synthesis.`;

// Final synthesis system prompt — used for the structured JSON pass
const BATCH_SYNTHESIS_SYSTEM_PROMPT = `You are synthesizing a complete initial world state for a narrative roleplay tracking extension. You have already analyzed the full chat history. Now produce a structured JSON object.

=== DATE RESOLUTION — READ THIS FIRST ===
Determining the current in-game date is your most important task. Follow this priority order STRICTLY:

PRIORITY 1: Setting context (authoritative).
If the setting context provided below includes a start date, use it as your temporal anchor. Advance from that date based on how many in-story days appear to have passed in the chat. The setting context date format and calendar system define how the date should be written.

PRIORITY 2: Explicit in-chat date.
If a specific date was mentioned in the chat, use it.

PRIORITY 3: Reasoned construction.
If neither is available, construct the best possible date from the available season, time period, and setting context. Use the setting's era and naming conventions. Write it in the appropriate format for the world — a feudal Japanese date looks nothing like a modern one.

NEVER produce:
- "Unknown era" or "Unknown date"
- Vague approximations like "approximately late afternoon"
- Generic descriptions divorced from the setting's calendar system
- A blank or placeholder date

If you must estimate, write it as a plausible specific date and note it as an estimate in the dateSub field (e.g. "Estimated — no explicit date in chat").

=== CURRENT DAY BLOCK — CHARACTER PROHIBITION ===
The Current Day block is injected into EVERY message the main AI receives. It must describe the WORLD, not the characters. Any character reference in the Current Day block will contaminate every future generation.

DO NOT include:
- Named characters in any field
- What characters are doing, feeling, or planning
- Specific character actions or states
- Story events or plot recaps

The Current Day fields (season, weatherToday, flora, fauna, spiritualClimate) describe ambient world conditions only — what the world looks like, smells like, feels like at this moment.

=== WORLD CONDITIONS — CHARACTER PROHIBITION ===
World conditions describe macro-level states — the political atmosphere, social climate, spiritual texture. Characters and factions MAY be named when they define the condition (e.g. 'the syndicate's surveillance network'). What should NOT appear is specific character actions or personal states that belong in the chat log. Write as a perceptive observer describing forces at work, not events that occurred.

=== COMMUNITY SUMMARIES — ANALYTICAL DEPTH ===
Community summaries are not plot recaps. They are analytical portraits of social groupings — the power dynamics, unspoken tensions, what characters are maneuvering around, what is really happening beneath the surface. Write them with insight and specificity. Reference specific moments that reveal something meaningful. Avoid generic observations.

=== EVENTS — FORWARD FACING PROJECTIONS ONLY ===
Events describe what is COMING NEXT in the story, NOT what has already happened.

CRITICAL RULE — DO NOT put past-tense summaries of chat content into events:
WRONG (past — what already happened): "Satoru presented cinnamon toothpicks to trigger memory"
RIGHT (future — what happens next): "Satoru may escalate his memory-triggering attempts with more direct methods"

WRONG (past — what already happened): "The cursed energy in the room became disturbed"
RIGHT (future — what happens next): "The disturbed cursed energy may attract attention or escalate further"

Past events belong in the notebook (established facts, planted details). If something already occurred in the chat, do NOT put it in the events array.

Every event MUST answer the question: "What is coming next because of this?" If the answer is "it already happened," delete that event.

=== EVENT SCHEDULED DATES ===
Use the dayCount you compute below as a temporal reference. An event happening "tomorrow" would be scheduledDate "Day N+1" (relative to dayCount), "next week" = "Day N+7", etc. Calendar dates like "3/15" also accepted.

CRITICAL RULES:
- Seasonal events (spring festival, harvest festival, migration, seasonal ritual) ALWAYS get a scheduledDate — approximate relative to the current dayCount (e.g. "Day 14" for something happening in ~2 weeks).
- Relative timing events ("in the coming weeks", "next month", "a few days from now") — ESTIMATE a dayCount-based date. Rough is fine. "Day N+7" for next week, "Day N+14" for two weeks.
- Named/explicit dates from chat — use as-given.
- Genuinely vague events (background rumors, distant threats, ongoing pressures): set scheduledDate to null (field only — keep the event). Not every event needs a pinned date.
- scheduledDate appears in the event header in the UI for immediate temporal context.`;

// ── Execute Batch Scan ────────────────────────────────────────────────────

/**
 * Run a full batch scan on the current chat.
 * This is the only function that reads ALL messages regardless of visibility.
 *
 * @returns {Promise<boolean>} True on success
 */
export async function runBatchScan() {
    const chatId = getChatId();
    console.log(`[NWST BatchScan] runBatchScan called with chatId="${chatId}"`);
    if (!chatId) {
        nwstToast('No active chat detected.', 'error');
        return false;
    }

    const hasData = chatHasData(chatId);
    // DIAGNOSTIC: Log what chatHasData found
    try {
        const { listCurrentChatKeys } = await import('../data/storage.js');
        const keys = listCurrentChatKeys();
        console.log(`[NWST BatchScan] DIAG: chatHasData=${hasData}, current chat NWST keys: [${keys.join(', ') || '(none)'}]`);
    } catch (e) {
        console.warn('[NWST BatchScan] DIAG logging failed:', e);
    }

    if (hasData) {
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

        // Get ALL messages — documented exception to visibility rule
        const allMessages = getAllMessagesUnfiltered();
        if (allMessages.length === 0) {
            nwstToast('No chat messages found to scan.', 'warning');
            showBatchScanLoading(false);
            return false;
        }

        // Get setting context — the authoritative source for date and world info
        const settingContext = getSettingContext(chatId);

        const maxContext = SillyTavern.getContext().maxContext || 8000;
        const chunkSize = Math.floor(maxContext * 0.6);
        const chunks = chunkMessages(allMessages, chunkSize);

        console.log(`[NWST BatchScan] Processing ${allMessages.length} messages in ${chunks.length} chunks...`);

        // Process each chunk sequentially
        let accumulatedContext = '';

        // Include setting context in the accumulated context so the synthesis
        // pass always has it regardless of what was extracted from chunks
        if (settingContext) {
            accumulatedContext += `=== SETTING CONTEXT (authoritative — use for date anchor and world details) ===\n${settingContext}\n\n`;
        }

        for (let i = 0; i < chunks.length; i++) {
            const messagesPerChunk = Math.ceil(allMessages.length / chunks.length);
            const startMsg = i * messagesPerChunk + 1;
            const endMsg = Math.min((i + 1) * messagesPerChunk, allMessages.length);

            nwstToast(`Processing messages ${startMsg}–${endMsg}...`, 'info');

            const chunkText = formatChunkForLLM(chunks[i], i + 1, chunks.length, startMsg, endMsg, settingContext);

            const messages = [
                { role: 'system', content: BATCH_CHUNK_PROMPT },
                { role: 'user', content: chunkText }
            ];

            const response = await generateWithProfile(profile, messages);
            if (response) {
                accumulatedContext += `\n--- Chunk ${i + 1}/${chunks.length} Analysis ---\n${response}\n`;
            }
        }

        // Synthesize final structured results
        nwstToast('Synthesizing world state from full analysis...', 'info');
        await synthesizeBatchResults(chatId, profile, accumulatedContext, allMessages, settingContext);

        nwstToast('Batch scan complete.', 'success');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'events', 'world', 'notebook');

        // Run a dedicated secrets scan to pick up anything the synthesis pass missed.
        try {
            const { scanForSecrets } = await import('./secretScan.js');
            const secretsAdded = await scanForSecrets(chatId);
            if (secretsAdded > 0) {
                console.log(`[NWST BatchScan] Secrets scan added ${secretsAdded} new secret(s).`);
            }
        } catch (e) {
            console.warn('[NWST BatchScan] Secrets scan failed (non-fatal):', e);
        }

        // Notify the scanner that batch scan is done.
        // If the scanner is in warmup phase, this transitions it to cadence
        // immediately without requiring the warmup floor to be reached first.
        try {
            const { notifyBatchScanComplete } = await import('./scanner.js');
            notifyBatchScanComplete();
        } catch (e) { /* non-fatal — scanner may not be running */ }

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
        return SillyTavern.getContext().chat || [];
    } catch (e) {
        console.error('[NWST BatchScan] Error accessing chat:', e);
        return [];
    }
}

function chunkMessages(messages, approxTokensPerChunk) {
    const charsPerChunk = approxTokensPerChunk * 4;
    const chunks = [];
    let currentChunk = [];
    let currentChars = 0;

    for (const msg of messages) {
        const msgText = `[${msg.name || (msg.is_user ? 'User' : 'Character')}]: ${msg.mes || ''}`;
        const msgChars = msgText.length;

        if (currentChars + msgChars > charsPerChunk && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentChars = 0;
        }

        currentChunk.push(msg);
        currentChars += msgChars;
    }

    if (currentChunk.length > 0) chunks.push(currentChunk);
    return chunks;
}

function formatChunkForLLM(chunk, chunkNum, totalChunks, startMsg, endMsg, settingContext) {
    let text = `CHUNK ${chunkNum}/${totalChunks} — Messages ${startMsg}–${endMsg}\n`;

    if (chunkNum === 1) {
        text += `This is the BEGINNING of the chat history. Pay special attention to setting details, calendar system, date references, era, and character introductions.\n\n`;
        // Include setting context on first chunk so LLM is grounded immediately
        if (settingContext) {
            text += `SETTING CONTEXT (authoritative — use this for date anchor):\n${settingContext}\n\n`;
        }
    } else if (chunkNum === totalChunks) {
        text += `This is the FINAL chunk — the most recent messages. This defines the CURRENT world state.\n\n`;
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

async function synthesizeBatchResults(chatId, profile, accumulatedContext, allMessages, settingContext) {
    const synthesisPrompt = buildSynthesisPrompt(accumulatedContext, allMessages.length, settingContext);

    const messages = [
        { role: 'system', content: BATCH_SYNTHESIS_SYSTEM_PROMPT },
        { role: 'user', content: synthesisPrompt }
    ];

    const response = await generateWithProfile(profile, messages);

    if (!response) {
        nwstToast('Synthesis completed but no structured data was returned. Try running again.', 'warning');
        return;
    }

    const result = parseBatchSynthesis(response);
    if (result) {
        await applyBatchResults(chatId, result);
    } else {
        nwstToast('Could not parse batch scan results. The LLM may have returned an invalid format.', 'error');
    }
}

function buildSynthesisPrompt(accumulatedContext, messageCount, settingContext) {
    let prompt = `You have analyzed the full ${messageCount}-message chat history. Here is your accumulated analysis:\n\n`;
    prompt += accumulatedContext;
    prompt += `\n\nNow synthesize the COMPLETE initial world state as a single JSON object.\n\n`;

    // Reiterate the date priority inline in the user prompt so it's impossible to miss
    prompt += `REMINDER — DATE RESOLUTION PRIORITY:\n`;
    if (settingContext) {
        prompt += `Your setting context (already included above) contains the authoritative date anchor. `;
        prompt += `Use it. Do NOT produce "unknown era" or vague dates. `;
        prompt += `Advance from the setting context start date based on story time elapsed.\n\n`;
    } else {
        prompt += `No setting context was provided. Construct the most specific date possible from seasonal `;
        prompt += `and contextual clues. Use the world's own calendar system and era naming conventions.\n\n`;
    }

    // Inject calendar month names if configured
    const calConfig = getCalendarConfig(getChatId());
    if (calConfig.enabled) {
        const monthList = calConfig.monthNames.map((name, i) =>
            `${name} (${calConfig.monthDays[i]} days)`
        ).join(', ');
        const dayList = calConfig.weekDays.join(', ');
        prompt += `CALENDAR SYSTEM:\n  Months (${calConfig.months} total): ${monthList}\n  Days of the week (${calConfig.weekDays.length} total): ${dayList}\n  Use these month and day names when generating dates.\n\n`;
    }

    prompt += `CRITICAL DATE FORMAT RULES — READ BEFORE GENERATING:\n`;
    prompt += `  1. dateDisplay MUST start with the day of the week (e.g. "${calConfig.enabled && calConfig.weekDays.length > 0 ? calConfig.weekDays[0] : 'Monday'}", "${calConfig.enabled && calConfig.weekDays.length > 1 ? calConfig.weekDays[1] : 'Thursday'}", "Kin'yōbi")\n`;
    prompt += `  2. dateDisplay MUST NOT contain a pipe | character — that belongs in dateSub\n`;
    prompt += `  3. Use dateSub for era/calendar context ONLY (e.g. "Reiwa 6", "Heian Era · 1125 CE")\n`;
    prompt += `  4. dayCount = day-of-year (1-366). If date is "October 17, 2024", dayCount = 291 (leap year) or 290.\n`;
    prompt += `  5. FAILURE TO FOLLOW THESE RULES WILL CORRUPT THE DATE DISPLAY IN THE UI.\n\n`;

    prompt += `CRITICAL — EVENTS MUST BE COMPLETE IN A SINGLE PASS:\n`;
    prompt += `  - Generate ALL events here. This is the ONLY event generation call.\n`;
    prompt += `  - You MUST produce TWO DISTINCT KINDS of events:\n\n`;
    prompt += `  KIND A — Chat-Detected Events (from conversation/context analysis):\n`;
    prompt += `    * Events that the CHAT CONTEXT suggests will happen NEXT\n`;
    prompt += `    * Character plans, rumors, threats discussed by characters\n`;
    prompt += `    * Example: "The merchant caravan is expected to arrive next week"\n`;
    prompt += `    * Example: "Bandit raids have been increasing along the eastern road"\n\n`;
    prompt += `  WRONG — DO NOT summarize past chat as events. These are WRONG:\n`;
    prompt += `    ✗ "Satoru presented cinnamon toothpicks to trigger Sachiko's memory" — this ALREADY HAPPENED in chat\n`;
    prompt += `    ✗ "The cursed energy in the room became disturbed" — this ALREADY HAPPENED in chat\n`;
    prompt += `    ✗ "Memory trigger attempt by Satoru" — this ALREADY HAPPENED in chat\n\n`;
    prompt += `  RIGHT — Turn past events into future projections. Convert the above to:\n`;
    prompt += `    ✓ "Satoru may escalate memory-triggering tactics as the memory block resists" — what COMES NEXT\n`;
    prompt += `    ✓ "The cursed energy disturbance could attract unwanted attention" — what COMES NEXT\n`;
    prompt += `    ✓ "Sachiko's buried memories may surface under continued pressure" — what COMES NEXT\n\n`;
    prompt += `  KIND B — World-Level Events (from setting, conditions, season, context):\n`;
    prompt += `    * Events that the WORLD itself is generating — natural, political, societal, seasonal\n`;
    prompt += `    * NOT mentioned in chat, but driven by the setting context and world conditions\n`;
    prompt += `    * Example (political): "Noble houses are maneuvering for position ahead of the succession council"\n`;
    prompt += `    * Example (seasonal): "The autumn harvest festival preparations are underway across the region"\n`;
    prompt += `    * Example (environmental): "The river's rise threatens low-lying farmlands as spring melt accelerates"\n`;
    prompt += `    * Example (supernatural): "Strange lights have been reported along the ley line convergence"\n\n`;
    prompt += `  EVENT COUNT LIMITS PER CATEGORY: max 5 WORLD events per tier, max 5 GENERATED NPC events per tier. DETECTED NPC events (explicitly stated plans) have NO cap.\n`;
    prompt += `  scheduledDate — REQUIRED for seasonal/relative-timing events (spring festival → current season date, "coming weeks" → Day N+14). Omit only for genuinely vague events. Use dayCount above as reference.\n\n`;
    prompt += `  CRITICAL — SEED GENEROUSLY: This is the INITIAL batch scan. The tracker should start with a robust set of events so the world feels alive. Aim for roughly 12-20 events total across all tiers and categories. Distribute world events across multiple tiers — immediate (happening now/soon), week (this week), month (this month/season), undetermined (someday).\n\n`;
    prompt += `  CRITICAL — USER CHARACTER BOUNDARY: NEVER create events about the user character's personal/mundane actions.\n`;
    prompt += `  Events must describe what the WORLD, NPCs, and natural/societal forces are doing — not what the user character will do.\n\n`;

    prompt += `=== SECRETS ===\n`;
    prompt += `Extract any notable secrets, hidden knowledge, or information asymmetries present in the chat history.\n`;
    prompt += `  - A secret must have clear narrative support in the messages — do not invent unrelated secrets.\n`;
    prompt += `  - When a secret involves the {{user}} character (the PC), use type "user_pc" — NOT "character".\n`;
    prompt += `  - Quality over quantity — 2-5 well-developed secrets are better than 10 shallow ones.\n`;
    prompt += `  - If no secrets are present, return an empty array [].\n`;
    prompt += `  - Set injectionPriority based on narrative urgency:\n`;
    prompt += `    "high" — secrets whose revelation would cause immediate, major consequences (active ticking bomb, imminent betrayal)\n`;
    prompt += `    "normal" — standard secrets with clear dramatic potential (default)\n`;
    prompt += `    "low" — minor secrets, background details, or secrets with low immediate impact\n\n`;

    prompt += `Use this EXACT JSON structure:\n\n`;
    prompt += `{
  "currentDay": {
    "dateDisplay": "MUST start with day-of-week followed by ', Month Date, Year'. No pipe characters. Modern: 'Monday, April 15th, 2024'. Historical: 'Kin'yōbi, Chrysanthemum Month · Sixth Day of the Waxing Moon'.",
    "dateSub": "Era context only — e.g. 'Reiwa 6', 'Heian Era · 1125 CE', '21st Century'. Leave empty if no applicable era.",
    "season": "Current season — evocative, sensory, grounded in the setting. Faction names fine if relevant; individual character actions should not appear.",
    "weatherToday": "Today's weather as a physical experience. Faction names fine if relevant; individual character actions should not appear.",
    "flora": "What is growing or changing in the natural world. Faction names fine if relevant; individual character actions should not appear.",
    "fauna": "Animal activity and presence. Faction names fine if relevant; individual character actions should not appear.",
    "spiritualClimate": "Metaphysical atmosphere if applicable. Faction names fine if relevant; individual character actions should not appear. Omit if no spiritual elements.",
    "dayCount": "DAYS SINCE STORY START (integer). CRITICAL: If a concrete date is present (e.g. 'April 15th, 2024'), compute the day-of-year. Example: April 15 in a leap year = Jan(31) + Feb(29) + Mar(31) + Apr(15) = day 106. If no date exists, estimate from story progression or default to 1."
  },
  "events": [
    {
      "title": "FORWARD-FACING only. Ask: did this already happen in chat? If YES → DELETE it.",
      "description": "What is PROJECTED to happen NEXT. Future tense. NEVER a past-tense recap of chat content.",
      "tier": "immediate|week|month|undetermined",
      "isNPC": false,
      "scheduledDate": "REQUIRED when timing is clear — reference the dayCount above. Format: relative 'Day N+1' (story days) or absolute 'Month/Date' (calendar). OMIT for vague/uncertain timing — not all events need a pinned date."
    }
  ],
  "conditions": {
    "political": "Atmospheric narrative of the political climate. Characters and factions may be named when they shape the condition. Describe macro mood, tensions, movements — not specific character actions or personal states.",
    "social": "Atmospheric narrative of the social climate. Characters may be named when relevant. Describe dynamics, hierarchies, undercurrents — not what specific characters did or felt.",
    "spiritual": "Metaphysical texture and atmosphere. Describe what the spiritually sensitive would perceive. Characters may be named if their presence defines the spiritual climate.",
    "environmental": "Physical world state — landscape, season, climate conditions. Focus on the world itself rather than character actions within it."
  },
  "notebook": {
    "core": {
      "unresolvedDetail": ["string", "..."],
      "promiseThreatDeadline": ["string", "..."],
      "offscreenPressure": ["string", "..."],
      "doNotForget": ["string", "..."]
    },
    "mystery": {
      "establishedFacts": ["string", "..."],
      "plantedDetails": ["string", "..."],
      "characterWhereabouts": ["string", "..."],
      "inconsistenciesFlagged": ["string", "..."],
      "currentToneAtmosphere": ["string", "..."]
    }
  },
  "secrets": [
    {
      "title": "Short descriptive label for this secret",
      "type": "character|user_pc|world|dramatic_irony|unconfirmed_suspicion",
      "secret": "Detailed explanation of what the secret IS. 1-3 sentences.",
      "whoKnows": ["Character name who knows this secret"],
      "whoDoesNotKnow": ["Character name who does NOT know this secret"],
      "evidenceShown": "What evidence has been shown in the chat so far (if any)",
      "pressureRisk": "What pressure or risk would be created if this secret were revealed",
      "revealConditions": "Under what circumstances this secret might be revealed",
      "injectionPriority": "high|normal|low"
    }
  ],
  "communities": [
    {
      "name": "Community or faction name — CRITICAL: Check the existing communities list above. If this community already exists under a different name, MERGE into the existing entry instead. Do NOT create duplicates.",
      "members": "Comma-separated character names",
      "summary": "Analytical portrait of power dynamics and unspoken tensions — not a plot recap. Use bullet points (•) for observations, each a specific concrete observation. Do not pad — output only as many bullets as the community genuinely warrants. An optional 1-2 sentence overview paragraph may precede the bullets."
    }
  ]
}

Respond with valid JSON ONLY. No markdown fences. No explanation outside the JSON.`;

    return prompt;
}

// ── Parse LLM response ────────────────────────────────────────────────────

function parseBatchSynthesis(response) {
    if (!response || typeof response !== 'string') return null;

    let jsonStr = response.trim();

    // Strip markdown fences
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
    // ── Process secrets first (before notebook saves, since secrets live in notebook) ──
    if (result.secrets && Array.isArray(result.secrets) && result.secrets.length > 0) {
        const { addSecret } = await import('../data/notebook.js');
        let addedCount = 0;
        for (const secret of result.secrets) {
            try {
                await addSecret(chatId, {
                    title: secret.title || 'Untitled secret',
                    type: secret.type || 'character',
                    secret: secret.secret || '',
                    whoKnows: Array.isArray(secret.whoKnows) ? secret.whoKnows : [],
                    whoDoesNotKnow: Array.isArray(secret.whoDoesNotKnow) ? secret.whoDoesNotKnow : [],
                    evidenceShown: secret.evidenceShown || '',
                    pressureRisk: secret.pressureRisk || '',
                    revealConditions: secret.revealConditions || '',
                    injectionPriority: secret.injectionPriority || 'normal'
                });
                addedCount++;
            } catch (err) {
                console.warn('[NWST BatchScan] Failed to add secret from synthesis:', err, secret);
            }
        }
        if (addedCount > 0) {
            console.log(`[NWST BatchScan] Seeded ${addedCount} secret(s) from synthesis.`);
        }
    }

    if (result.currentDay) {
        const { replaceCurrentDay } = await import('../data/worldState.js');

        // ── Post-process dateDisplay ──────────────────────────────
        // If the LLM put era/region info after a pipe (e.g. "October 17, 2024 | Modern day Japan"),
        // split it into dateDisplay and dateSub. Also ensure day-of-week is present.
        if (result.currentDay.dateDisplay && typeof result.currentDay.dateDisplay === 'string') {
            const pipeIdx = result.currentDay.dateDisplay.indexOf('|');
            if (pipeIdx !== -1) {
                const before = result.currentDay.dateDisplay.substring(0, pipeIdx).trim();
                const after = result.currentDay.dateDisplay.substring(pipeIdx + 1).trim();
                result.currentDay.dateDisplay = before;
                if (!result.currentDay.dateSub || result.currentDay.dateSub.trim() === '') {
                    result.currentDay.dateSub = after;
                    console.log(`[NWST BatchScan] Extracted dateSub from dateDisplay pipe: "${result.currentDay.dateSub}"`);
                }
            }
        }

        // ── dayCount computation (CRITICAL — ALWAYS override from dateDisplay) ──
        // computeDayOfYearFromDate() parses a Gregorian month-day-year from
        // dateDisplay (even with day-of-week prefix like "Thursday, October 17th, 2024").
        // When a parseable date exists, the computed day-of-year is ALWAYS more
        // reliable than whatever the LLM guessed. Override unconditionally.
        const computedDayCount = computeDayOfYearFromDate(result.currentDay.dateDisplay);
        if (computedDayCount && computedDayCount > 0) {
            const oldVal = result.currentDay.dayCount;
            result.currentDay.dayCount = computedDayCount;
            console.log(`[NWST BatchScan] dayCount SET from dateDisplay: ${oldVal ?? 'none'} → ${computedDayCount} (from "${result.currentDay.dateDisplay}")`);
        } else {
            // Normalize dayCount to integer (LLM may output string, null, etc.)
            const rawDayCount = result.currentDay.dayCount;
            let parsedDayCount = (typeof rawDayCount === 'number' && !Number.isNaN(rawDayCount))
                ? Math.floor(rawDayCount)
                : (typeof rawDayCount === 'string' ? parseInt(rawDayCount, 10) : NaN);
            if (Number.isNaN(parsedDayCount) || parsedDayCount <= 0) {
                // No parseable date and no valid dayCount from LLM — fallback to existing storage or default
                const { getCurrentDay } = await import('../data/worldState.js');
                const existingDay = getCurrentDay(chatId);
                if (existingDay?.dayCount && existingDay.dayCount > 0) {
                    result.currentDay.dayCount = existingDay.dayCount;
                    console.log(`[NWST BatchScan] Preserved existing dayCount: ${result.currentDay.dayCount}`);
                } else {
                    result.currentDay.dayCount = 1;
                    console.log(`[NWST BatchScan] Set default dayCount: 1`);
                }
            }
            // else: keep LLM's dayCount since it's a plausible positive integer and no date to compute from
        }

        // ── Normalize season ──────────────────────────────────────
        // Strip verbose descriptions (e.g. "Spring — the chill of autumn lingers") to prevent
        // substring matching in getMoonPhenomena() which does season.includes('autumn').
        if (result.currentDay.season && typeof result.currentDay.season === 'string') {
            const seasonText = result.currentDay.season.trim();
            if (seasonText.split(' ').length > 3 || /[,;.—]/.test(seasonText)) {
                const seasonWords = ['spring', 'summer', 'autumn', 'fall', 'winter'];
                const lower = seasonText.toLowerCase();
                const foundSeason = seasonWords.find(sw => {
                    const regex = new RegExp(`\\b${sw}\\b`, 'i');
                    return regex.test(lower);
                });
                if (foundSeason) {
                    result.currentDay.season = foundSeason.charAt(0).toUpperCase() + foundSeason.slice(1);
                    console.log(`[NWST BatchScan] Normalized season from verbose description to "${result.currentDay.season}"`);
                } else {
                    const firstSentence = seasonText.split(/[.\n;]/)[0].trim();
                    result.currentDay.season = firstSentence;
                    console.log(`[NWST BatchScan] Trimmed season to first segment: "${result.currentDay.season.substring(0, 60)}"`);
                }
            }
        }
        if (result.currentDay.season && typeof result.currentDay.season === 'string') {
            const seasonText = result.currentDay.season.trim();
            // If more than 3 words or contains punctuation that suggests multiple clauses
            if (seasonText.split(' ').length > 3 || /[,;.—]/.test(seasonText)) {
                // Extract first recognized season word if present, otherwise take first sentence
                const seasonWords = ['spring', 'summer', 'autumn', 'fall', 'winter'];
                const lower = seasonText.toLowerCase();
                const foundSeason = seasonWords.find(sw => {
                    // Match as whole word, not substring
                    const regex = new RegExp(`\\b${sw}\\b`, 'i');
                    return regex.test(lower);
                });
                if (foundSeason) {
                    result.currentDay.season = foundSeason.charAt(0).toUpperCase() + foundSeason.slice(1);
                    console.log(`[NWST BatchScan] Normalized season from verbose description to "${result.currentDay.season}"`);
                } else {
                    // No recognized season word — take just first sentence
                    const firstSentence = seasonText.split(/[.\n;]/)[0].trim();
                    result.currentDay.season = firstSentence;
                    console.log(`[NWST BatchScan] Trimmed season to first segment: "${result.currentDay.season.substring(0, 60)}"`);
                }
            }
        }
        await replaceCurrentDay(chatId, result.currentDay);
        nwstToast('Current Day block generated.', 'info');
    }

    if (result.events && Array.isArray(result.events)) {
        const { addEvent } = await import('../data/events.js');
        // Category-aware caps per tier (generous for initial seed):
        //   Detected NPC events  — no cap (facts from chat)
        //   Generated NPC events — max 5 per tier
        //   World events         — max 5 per tier
        const batchCounts = {};
        const cappedEvents = result.events.filter(ev => {
            const tier = ev.tier || 'undetermined';
            if (!batchCounts[tier]) batchCounts[tier] = { detected_npc: 0, generated_npc: 0, world: 0 };
            const tc = batchCounts[tier];

            if (ev.isNPC && ev.npcOrigin === 'detected') {
                // No cap on detected NPC events
                return true;
            } else if (ev.isNPC) {
                if (tc.generated_npc >= 5) return false;
                tc.generated_npc++;
                return true;
            } else {
                if (tc.world >= 5) return false;
                tc.world++;
                return true;
            }
        });
        // Respect active pool cap for generated events.
        // EXCEPTION: detected NPC events (explicit plans from chat) always bypass the cap.
        const { getMaxActiveEvents } = await import('../settings.js');
        const poolCap = getMaxActiveEvents();
        let poolUsed = 0;

        for (const event of cappedEvents) {
            const isDetected = event.isNPC && event.npcOrigin === 'detected';

            // Detected NPC events bypass the pool cap — they are facts, not generated content
            if (!isDetected && poolUsed >= poolCap) {
                console.log(`[NWST BatchScan] Event pool cap (${poolCap}) reached — skipping generated event: "${event.title}"`);
                continue;
            }

            await addEvent(chatId, {
                ...event,
                status: 'pending',
                origin: isDetected ? 'detected' : 'generated',
                isNPC: event.isNPC || false,
                npcOrigin: event.isNPC ? (event.npcOrigin || 'generated') : null
            });

            if (!isDetected) poolUsed++;
        }
        nwstToast('Events complete.', 'info');
    }

    if (result.conditions) {
        const { updateConditionContent } = await import('../data/worldState.js');
        for (const [key, content] of Object.entries(result.conditions)) {
            if (content && typeof content === 'string' && content.trim()) {
                await updateConditionContent(chatId, key, content.trim());
            }
        }
        nwstToast('World conditions complete.', 'info');
    }

    if (result.notebook) {
        // DIAGNOSTIC: Log notebook structure before save
        console.log(`[NWST BatchScan] DIAG: result.notebook has keys: [${Object.keys(result.notebook).join(', ')}], has secrets: ${'secrets' in result.notebook}`);
        // Check whether secrets from result.secrets were already added to metadata
        try {
            const { getNotebook } = await import('../data/notebook.js');
            const existingBeforeOverwrite = getNotebook(chatId);
            console.log(`[NWST BatchScan] DIAG: existing notebook before saveNotebook — secrets count: ${existingBeforeOverwrite.secrets?.length ?? 'N/A'}`);
            console.log(`[NWST BatchScan] DIAG: existing core.unresolvedDetail count: ${existingBeforeOverwrite.core?.unresolvedDetail?.length ?? 'N/A'}`);
        } catch (e) { /* non-fatal */ }

        // ── Validate & normalize notebook fields: ensure string[] fields are arrays, not raw strings ──
        // LLMs sometimes return "currentToneAtmosphere": "string" instead of ["string"],
        // which causes bullet rendering to iterate characters instead of array items.
        const ARRAY_FIELDS = ['unresolvedDetail', 'promiseThreatDeadline', 'offscreenPressure', 'doNotForget',
            'establishedFacts', 'plantedDetails', 'characterWhereabouts', 'inconsistenciesFlagged', 'currentToneAtmosphere'];
        let normalized = 0;
        for (const section of ['core', 'mystery']) {
            if (result.notebook[section]) {
                for (const field of ARRAY_FIELDS) {
                    const val = result.notebook[section][field];
                    if (typeof val === 'string') {
                        result.notebook[section][field] = [val];
                        normalized++;
                    }
                }
            }
        }
        if (normalized > 0) {
            console.log(`[NWST BatchScan] Normalized ${normalized} string fields to arrays in notebook`);
        }

        const { saveNotebook } = await import('../data/notebook.js');
        console.log(`[NWST BatchScan] DIAG: About to saveNotebook — result.notebook has secrets? ${'secrets' in result.notebook}, core keys: ${Object.keys(result.notebook.core || {}).join(', ')}`);
        await saveNotebook(chatId, result.notebook);
        // Verify after save
        try {
            const afterOverwrite = getNotebook(chatId);
            console.log(`[NWST BatchScan] DIAG: after saveNotebook — secrets count: ${afterOverwrite.secrets?.length ?? 'N/A'}, core.unresolvedDetail count: ${afterOverwrite.core?.unresolvedDetail?.length ?? 'N/A'}`);
        } catch (e) { /* non-fatal */ }
        nwstToast('Notebook seeded.', 'info');
    }

    if (result.communities && Array.isArray(result.communities)) {
        const { addCommunity } = await import('../data/communities.js');
        for (const com of result.communities) {
            if (com.name) await addCommunity(chatId, com);
        }
        nwstToast('Communities complete.', 'info');
    }

    // Save a post-batch-scan snapshot
    try {
        const { getWorldState: getWS, saveSnapshot: saveSnap } = await import('../data/worldState.js');
        const { getAllEvents: getEvts } = await import('../data/events.js');
        const { getNotebook: getNb } = await import('../data/notebook.js');
        await saveSnap(chatId, 'batch_scan', getWS(chatId), getEvts(chatId), getNb(chatId));
    } catch (e) {
        console.warn('[NWST BatchScan] Post-scan snapshot failed (non-fatal):', e);
    }

    // Seed the 7-day forecast via Day Advancement LLM
    nwstToast('Generating initial 7-day forecast...', 'info');
    try {
        await regenerateForecast();
        nwstToast('7-day forecast complete.', 'info');
    } catch (forecastErr) {
        console.warn('[NWST BatchScan] Forecast generation failed (non-fatal):', forecastErr);
        nwstToast('Forecast generation skipped. Use the Regen button on the Home tab to try again.', 'warning');
    }

    // Events are already complete — the batch synthesis prompt above was instructed to generate
    // BOTH detected events (from chat analysis) AND world-level events (from setting/conditions/season)
    // in a SINGLE pass. No separate world event generation call is needed.
    console.log('[NWST BatchScan] Events generated in single synthesis pass (no separate world event call).');
}

// ── Loading UI ─────────────────────────────────────────────────────────────

function showBatchScanLoading(show) {
    const spinner = document.getElementById('nwst-batchScan-spinner');
    const btn = document.getElementById('nwst-setting-batchScan');
    if (spinner) spinner.style.display = show ? 'inline-block' : 'none';
    if (btn) {
        btn.disabled = show;
        btn.textContent = show ? 'Scanning...' : 'Run batch scan';
    }
}
