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

import { getChatId, nwstToast } from '../utils.js';
import { chatHasData } from '../data/storage.js';
import { getWorldState, saveSnapshot, getSettingContext, getCalendarConfig, getSeasonConfig } from '../data/worldState.js';
import { getAllEvents } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { resolveProfile } from './connections.js';
import { regenerateForecast, computeSeason } from './dayAdvancement.js';
import { dlog } from "../lib/debug.js";

// ── Date computation helper ─────────────────────────────────────────────────

/** Map of written number words → numeric values (for ordinals like "Eleventh") */
const NUMBER_WORDS = {
    'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5,
    'sixth': 6, 'seventh': 7, 'eighth': 8, 'ninth': 9, 'tenth': 10,
    'eleventh': 11, 'twelfth': 12, 'thirteenth': 13, 'fourteenth': 14, 'fifteenth': 15,
    'sixteenth': 16, 'seventeenth': 17, 'eighteenth': 18, 'nineteenth': 19, 'twentieth': 20,
    'twenty-first': 21, 'twenty-second': 22, 'twenty-third': 23, 'twenty-fourth': 24, 'twenty-fifth': 25,
    'twenty-sixth': 26, 'twenty-seventh': 27, 'twenty-eighth': 28, 'twenty-ninth': 29, 'thirtieth': 30,
    'thirty-first': 31,
    // Also map the cardinal forms in case they appear without ordinal suffix
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
    'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
    'thirty': 30, 'thirtyone': 31,
    // Ordinal month names (non-numeric)
    'first month': 1, 'second month': 2, 'third month': 3, 'fourth month': 4,
    'fifth month': 5, 'sixth month': 6, 'seventh month': 7, 'eighth month': 8,
    'ninth month': 9, 'tenth month': 10, 'eleventh month': 11, 'twelfth month': 12,
};

/**
 * Try to extract a numeric value from a written ordinal in text.
 * Handles patterns like "the Eleventh Month" → 11, "Seventh Day" → 7.
 * @param {string} text - The text to search within
 * @param {string} keyword - The keyword after the number ("month" or "day")
 * @returns {number|null} The numeric value, or null
 */
function extractOrdinalValue(text, keyword) {
    if (!text) return null;
    const lower = text.toLowerCase();

    // Pattern 1: "the Nth Keyword" — "the Eleventh Month"
    const regex1 = new RegExp(`the\\s+([a-z-]+(?:st|nd|rd|th)?)\\s+${keyword}`, 'i');
    const m1 = lower.match(regex1);
    if (m1) {
        const word = m1[1].replace(/[^a-z-]/g, '');
        if (NUMBER_WORDS[word] !== undefined) return NUMBER_WORDS[word];
    }

    // Pattern 2: "Nth Keyword" — "Seventh Day"
    const regex2 = new RegExp(`([a-z-]+(?:st|nd|rd|th)?)\\s+${keyword}`, 'i');
    const m2 = lower.match(regex2);
    if (m2) {
        const word = m2[1].replace(/[^a-z-]/g, '');
        if (NUMBER_WORDS[word] !== undefined) return NUMBER_WORDS[word];
    }

    // Pattern 3: "Keyword N" — "Month 11" or "Day 7"
    const regex3 = new RegExp(`${keyword}\\s+(\\d{1,2})`, 'i');
    const m3 = lower.match(regex3);
    if (m3) {
        const val = parseInt(m3[1], 10);
        if (val >= 1 && val <= 31) return val;
    }

    return null;
}

/**
 * Build a month-name → index map from both English month names and an optional
 * calendar config. Calendar config month names take priority so custom names
 * (e.g. "Haru" for spring) can be matched.
 * Also maps written ordinal month patterns like "eleventh month" → 11.
 * @param {object|null} calendarConfig
 * @returns {object} monthName → index (0=jan) mapping
 */
function buildMonthMap(calendarConfig) {
    // English base names
    const englishNames = ['january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december'];
    const map = {};
    englishNames.forEach((name, i) => { map[name] = i; });

    // Add custom month names from calendar config
    if (calendarConfig && Array.isArray(calendarConfig.monthNames)) {
        calendarConfig.monthNames.forEach((customName, i) => {
            if (customName && typeof customName === 'string') {
                const raw = customName.toLowerCase().trim();
                if (raw) {
                    // Map the custom name to its index (0-based)
                    map[raw] = Math.min(i, 11);
                }
            }
        });
    }

    // Also add ordinal month pattern entries: "eleventh month" → 10 (0-based)
    for (let i = 1; i <= 12; i++) {
        // Find the ordinal word for this number
        const entry = Object.entries(NUMBER_WORDS).find(([word, val]) => val === i && word.includes('month'));
        if (entry) {
            const monthWord = entry[0].replace(/\s+month$/, '');
            map[monthWord] = i - 1; // 0-based
        }
    }

    return map;
}

/**
 * Compute day-of-year from a date string like "Monday, April 15th, 2024".
 * Also accepts an optional calendar config for custom month name support.
 * Handles written ordinals: "the Eleventh Month · Seventh Day" → day-of-year.
 * Used as a client-side fallback when the LLM doesn't provide dayCount.
 * @param {string} dateStr
 * @param {object} [calendarConfig] - Optional calendar config with custom monthNames
 * @returns {number|null} Day of year (1-366), or null if unparseable
 */
export function computeDayOfYearFromDate(dateStr, calendarConfig) {
    if (!dateStr || typeof dateStr !== 'string') return null;

    const monthMap = buildMonthMap(calendarConfig);

    // Get monthDays from calendar config or use defaults
    const monthDays = (calendarConfig && Array.isArray(calendarConfig.monthDays) && calendarConfig.monthDays.length >= 12)
        ? calendarConfig.monthDays
        : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    // Strip numeric ordinal suffixes (st, nd, rd, th) so "15th" becomes "15"
    const cleaned = dateStr.replace(/(\d+)(st|nd|rd|th)/gi, '$1');

    // ── Helper: compute day-of-year from monthIndex (0-based) and day (1-based) ──
    function computeFromMonthDay(monthIndex, day) {
        if (monthIndex === undefined || monthIndex < 0 || monthIndex >= 12) return null;
        if (day < 1 || day > monthDays[monthIndex]) return null;
        let dayOfYear = day;
        for (let i = 0; i < monthIndex; i++) {
            dayOfYear += monthDays[i];
        }
        return dayOfYear;
    }

    // ── Helper: extract year (4-digit number) from anywhere in the string ──
    function extractYear(str) {
        const m = str.match(/\b(\d{4})\b/);
        return m ? parseInt(m[1], 10) : null;
    }

    // ── Helper: Unicode-aware word pattern ──
    // Matches any contiguous non-whitespace, non-digit, non-punctuation token.
    // This handles Unicode month names like Jūgatsu, Shimotsuki, Märzen, etc.
    const WORD = '[^\\s\\d,;:|•·\\-–—=\\/\\\\(){}\\[\\]<>]+';

    // ── Method 1: "Month Day, Year" — e.g. "April 15, 2024" or "Jūgatsu 17, 2024"
    const m1Regex = new RegExp('(' + WORD + ')\\s+(\\d{1,2}),?\\s*(\\d{4})');
    const monthDayYearMatch = cleaned.match(m1Regex);
    if (monthDayYearMatch) {
        const monthName = monthDayYearMatch[1].toLowerCase();
        const day = parseInt(monthDayYearMatch[2], 10);
        const year = parseInt(monthDayYearMatch[3], 10);
        const monthIndex = monthMap[monthName];
        if (monthIndex !== undefined && day >= 1 && year >= 1) {
            // With a year, use Date object for accurate day-of-year (handles leap years)
            const date = new Date(year, monthIndex, day);
            const startOfYear = new Date(year, 0, 0);
            const diff = date - startOfYear;
            const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
            if (dayOfYear >= 1 && dayOfYear <= 366) {
                dlog(`[NWST BatchScan] Computed dayCount ${dayOfYear} from date "${dateStr}"`);
                return dayOfYear;
            }
        }
    }

    // ── Method 2: ISO format "2024-04-15"
    const isoMatch = cleaned.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
        const year = parseInt(isoMatch[1], 10);
        const month = parseInt(isoMatch[2], 10) - 1;
        const day = parseInt(isoMatch[3], 10);
        if (year >= 1 && month >= 0 && month <= 11 && day >= 1 && day <= 31) {
            const date = new Date(year, month, day);
            const startOfYear = new Date(year, 0, 0);
            const diff = date - startOfYear;
            const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
            if (dayOfYear >= 1 && dayOfYear <= 366) {
                dlog(`[NWST BatchScan] Computed dayCount ${dayOfYear} from ISO date "${dateStr}"`);
                return dayOfYear;
            }
        }
    }

    // ── Method 3: "Month Day" without year — e.g. "April 15" or "Jūgatsu 17"
    const m3Regex = new RegExp('(' + WORD + ')\\s+(\\d{1,2})(?:,?\\s*\\d{4})?\\s*$');
    const monthDayMatch = cleaned.match(m3Regex);
    if (monthDayMatch) {
        const monthName = monthDayMatch[1].toLowerCase();
        const day = parseInt(monthDayMatch[2], 10);
        const monthIndex = monthMap[monthName];
        const result = computeFromMonthDay(monthIndex, day);
        if (result !== null) {
            dlog(`[NWST BatchScan] Computed dayCount ${result} from month+day "${dateStr}"`);
            return result;
        }
    }

    // ── Method 4: Written ordinals — "the Eleventh Month · Seventh Day"
    // Handles formats like "Kin'yōbi, Shimotsuki, the Eleventh Month · Seventh Day"
    // where month and day are written as words rather than digits.
    //
    // Strategy: Find the month index by looking for:
    //   a) A custom month name from calendar config (e.g. "Shimotsuki")
    //   b) An ordinal month pattern (e.g. "the Eleventh Month" → 11)
    // Then find the day from ordinal day pattern (e.g. "Seventh Day" → 7)

    let monthIndex = undefined;
    let monthSource = '';

    // 4a. Try custom month name match first (most specific)
    //     Uses a Unicode-safe regex that does NOT strip non-ASCII characters
    //     from the name, unlike the previous implementation.
    const allMonthNames = Object.keys(monthMap).sort((a, b) => b.length - a.length); // longest first
    for (const name of allMonthNames) {
        // Escape regex special chars while preserving Unicode letters
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Use flexible boundary matching: the name must be surrounded by
        // whitespace, punctuation, or string edges (works with Unicode)
        const regex = new RegExp('(?:^|[\\s,;:.!?·•\'"\\-|])' + escaped + '(?=[\\s,;:.!?·•\'"\\-|]|$)', 'i');
        if (regex.test(dateStr)) {
            monthIndex = monthMap[name];
            monthSource = `custom month "${name}"`;
            break;
        }
    }

    // 4b. If no custom month name found, try ordinal pattern "the Nth Month"
    if (monthIndex === undefined) {
        const ordinalMonth = extractOrdinalValue(dateStr, 'month');
        if (ordinalMonth !== null) {
            monthIndex = ordinalMonth - 1; // 0-based
            monthSource = `ordinal "Month ${ordinalMonth}"`;
        }
    }

    // 4c. If still no month, try numeric "Month N" pattern
    if (monthIndex === undefined) {
        const numMonth = dateStr.match(/\bMonth\s*(\d{1,2})\b/i);
        if (numMonth) {
            const m = parseInt(numMonth[1], 10);
            if (m >= 1 && m <= 12) {
                monthIndex = m - 1;
                monthSource = `numeric "Month ${m}"`;
            }
        }
    }

    // Extract day from ordinal pattern "Nth Day"
    let day = undefined;
    const ordinalDay = extractOrdinalValue(dateStr, 'day');
    if (ordinalDay !== null) {
        day = ordinalDay;
    }

    // Also try numeric "Day N" pattern
    if (day === undefined) {
        const numDay = dateStr.match(/\bDay\s*(\d{1,2})\b/i);
        if (numDay) {
            const d = parseInt(numDay[1], 10);
            if (d >= 1 && d <= 31) {
                day = d;
            }
        }
    }

    if (monthIndex !== undefined && day !== undefined) {
        const result = computeFromMonthDay(monthIndex, day);
        if (result !== null) {
            dlog(`[NWST BatchScan] Computed dayCount ${result} from ordinals "${dateStr}" (${monthSource}, day=${day})`);
            return result;
        }
    }

    // ── Method 5: Flexible word+number scan (Unicode month name fallback) ──
    // When Methods 1-4 all fail (e.g. Unicode month names not in calendar config),
    // scan the entire string for any word token followed immediately by 1-2 digits.
    // Check if that word is in the month map, then compute day-of-year.
    // Also attempts to extract a 4-digit year from anywhere for leap-year handling.
    const m5Regex = new RegExp('(' + WORD + ')\\s+(\\d{1,2})');
    const wordNumberMatch = cleaned.match(m5Regex);
    if (wordNumberMatch) {
        const monthName = wordNumberMatch[1].toLowerCase();
        const candidateDay = parseInt(wordNumberMatch[2], 10);
        const candidateMonthIndex = monthMap[monthName];
        if (candidateMonthIndex !== undefined && candidateDay >= 1 && candidateDay <= 31) {
            const year = extractYear(cleaned);
            if (year) {
                const date = new Date(year, candidateMonthIndex, candidateDay);
                const startOfYear = new Date(year, 0, 0);
                const diff = date - startOfYear;
                const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
                if (dayOfYear >= 1 && dayOfYear <= 366) {
                    dlog(`[NWST BatchScan] Computed dayCount ${dayOfYear} from flexible scan "${dateStr}"`);
                    return dayOfYear;
                }
            }
            // No year found — use monthDays array
            const result = computeFromMonthDay(candidateMonthIndex, candidateDay);
            if (result !== null) {
                dlog(`[NWST BatchScan] Computed dayCount ${result} from flexible scan (no year) "${dateStr}"`);
                return result;
            }
        }
    }

    // ── Method 6: Slash/hyphen/dot delimited date — "11/7/1125", "10/17/24" ──
    // Catches token-efficient date formats where month, day, and year are
    // all numeric and separated by / - or . (US convention: month/day/year).
    // Only fires when Methods 1-5 all failed (no word-based month found).
    // This prevents bug reports from users trying to shave tokens.
    const delimRegex = /\b(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})\s*[\/\-\.]\s*(\d{2,4})\b/;
    const delimMatch = cleaned.match(delimRegex);
    if (delimMatch) {
        const month = parseInt(delimMatch[1], 10);
        const day = parseInt(delimMatch[2], 10);
        let year = parseInt(delimMatch[3], 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            // Normalize 2-digit years: "24" → 2024, "99" → 1999
            if (year >= 0 && year < 100) {
                year += year < 50 ? 2000 : 1900;
            }
            if (year >= 1000 && year <= 9999) {
                const date = new Date(year, month - 1, day);
                const startOfYear = new Date(year, 0, 0);
                const diff = date - startOfYear;
                const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
                if (dayOfYear >= 1 && dayOfYear <= 366) {
                    dlog(`[NWST BatchScan] Computed dayCount ${dayOfYear} from delimited date "${dateStr}"`);
                    return dayOfYear;
                }
            }
        }
    }

    return null;
}

// ── Internal prompts ───────────────────────────────────────────────────────

// Chunk analysis prompt — used for each chunk pass
const BATCH_CHUNK_PROMPT = `You are analyzing a segment of a roleplay chat history to build a world state. Read carefully and extract structured scene-level information.

=== SCENE STRUCTURE ===
Break this chunk into narrative scenes. A new scene begins when:
- The primary speaking character changes
- A time skip or location change is implied
- Explicit break markers appear (---, ***, ===)
- A new topic or situation begins after a pause

For EACH scene detected, extract:
1. SCENE N — Characters present in this scene (list names)
2. LOCATION — Where this scene takes place (if implied)
3. MOOD — The emotional/narrative tone of the scene
4. TIME CLUES — Any date, time, season, or era references in this scene
5. KEY EVENTS — What happens in this scene (bullet points)

=== CROSS-SCENE ANALYSIS ===
After listing scenes, provide:
6. SETTING CONTEXT — Cumulative location, climate, atmosphere, cultural context
7. UPCOMING EVENTS — Events mentioned by characters or implied by the world
8. WORLD CONDITIONS — Political tensions, social dynamics, spiritual/supernatural elements, environmental state (aggregated across all scenes in this chunk)
9. KEY FACTS — Unresolved threads, planted details, character whereabouts (aggregated)
10. CHARACTER GROUPINGS — Social groupings and dynamics observed

=== WORLD-LEVEL NOTE ===
Distinguish between chat-detected events (things characters are actively discussing/planning) and world-level context (seasonal shifts, political undercurrents, environmental changes that could generate events even if no one mentioned them).

OUTPUT FORMAT:
Scenes:
- Scene 1: [Characters] at [Location] — [Mood]
  • [Key events/observations]
- Scene 2: [Characters] at [Location] — [Mood]
  • [Key events/observations]

Accumulated Analysis:
[Then your cross-scene aggregated findings in plain text for later synthesis]`;

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
    dlog(`[NWST BatchScan] runBatchScan called with chatId="${chatId}"`);
    if (!chatId) {
        nwstToast('No active chat detected.', 'error');
        return false;
    }

    const hasData = chatHasData(chatId);
    // DIAGNOSTIC: Log what chatHasData found
    try {
        const { listCurrentChatKeys } = await import('../data/storage.js');
        const keys = listCurrentChatKeys();
        dlog(`[NWST BatchScan] DIAG: chatHasData=${hasData}, current chat NWST keys: [${keys.join(', ') || '(none)'}]`);
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

        dlog(`[NWST BatchScan] Processing ${allMessages.length} messages in ${chunks.length} chunks...`);

        // ── Progressive structured state accumulation ──────────────
        // Instead of raw concatenation, we build a structured accumulation
        // that organizes findings by scene, with progressive state aggregation.
        // The synthesis pass receives this structured context rather than raw text.
        let accumulatedContext = '';

        // Include setting context FIRST as authoritative anchor
        if (settingContext) {
            accumulatedContext += `=== SETTING CONTEXT (authoritative — use for date anchor and world details) ===\n${settingContext}\n\n`;
        }

        // Progressive state accumulation — tracks narrative elements across chunks
        // so each chunk's LLM can build on the previous chunk's findings.
        // State is extracted via simple heuristics from each chunk's LLM response
        // and passed as prior context to subsequent chunks.
        const stateAccumulator = {
            dateTimeClues: [],
            knownCharacters: new Set(),
            locationsMentioned: new Set(),
            worldConditions: [],
            activeThreads: []
        };

        for (let i = 0; i < chunks.length; i++) {
            // Compute actual message indices from the chunk content
            const chunk = chunks[i];
            const firstMsgIndex = allMessages.indexOf(chunk[0]);
            const lastMsgIndex = allMessages.indexOf(chunk[chunk.length - 1]);
            const startMsg = firstMsgIndex >= 0 ? firstMsgIndex + 1 : 1;
            const endMsg = lastMsgIndex >= 0 ? lastMsgIndex + 1 : allMessages.length;

            nwstToast(`Processing messages ${startMsg}–${endMsg}...`, 'info');

            // Build progressive context for this chunk — includes what was
            // found in PRIOR chunks so the LLM can refine rather than restart
            let chunkContext = '';
            if (i > 0) {
                chunkContext += `== PRIOR STATE (from earlier chunks) ==\n`;
                if (stateAccumulator.dateTimeClues.length > 0) {
                    chunkContext += `Date/time clues so far: ${stateAccumulator.dateTimeClues.join('; ')}\n`;
                }
                if (stateAccumulator.knownCharacters.size > 0) {
                    chunkContext += `Characters encountered: ${[...stateAccumulator.knownCharacters].join(', ')}\n`;
                }
                if (stateAccumulator.locationsMentioned.size > 0) {
                    chunkContext += `Locations mentioned: ${[...stateAccumulator.locationsMentioned].join(', ')}\n`;
                }
                if (stateAccumulator.activeThreads.length > 0) {
                    chunkContext += `Active threads: ${stateAccumulator.activeThreads.join('; ')}\n`;
                }
                chunkContext += `\nAnalyze this NEW chunk below, extending or revising the state above as needed.\n\n`;
            }

            const chunkText = formatChunkForLLM(chunk, i + 1, chunks.length, startMsg, endMsg, settingContext);
            const fullUserPrompt = chunkContext + chunkText;

            const messages = [
                { role: 'system', content: BATCH_CHUNK_PROMPT },
                { role: 'user', content: fullUserPrompt }
            ];

            const response = await generateWithProfile(profile, messages);
            if (response) {
                // Accumulate with structured scene headers
                const sceneCount = detectChunkScenes(chunk).length;
                accumulatedContext += `\n=== Chunk ${i + 1}/${chunks.length} (Messages ${startMsg}–${endMsg}, ~${sceneCount} scene(s)) ===\n${response}\n`;

                // Extract and accumulate key state from response for next chunk's prior state
                // Use simple heuristics: lines containing "Characters:", "Location:", "Date:", "Time:", "Thread:", "Condition:"
                const lines = response.split('\n');
                for (const line of lines) {
                    const lower = line.trim().toLowerCase();
                    if (lower.startsWith('characters:')) {
                        const names = line.replace(/^Characters?:\s*/i, '').split(',').map(n => n.trim()).filter(Boolean);
                        names.forEach(n => stateAccumulator.knownCharacters.add(n));
                    }
                    if (lower.startsWith('location:')) {
                        const loc = line.replace(/^Location:\s*/i, '').trim();
                        if (loc) stateAccumulator.locationsMentioned.add(loc);
                    }
                    if (lower.startsWith('date:') || lower.startsWith('time:')) {
                        const clue = line.replace(/^(Date|Time):\s*/i, '').trim();
                        if (clue && !stateAccumulator.dateTimeClues.includes(clue)) {
                            stateAccumulator.dateTimeClues.push(clue);
                        }
                    }
                    if (lower.startsWith('thread:')) {
                        const thread = line.replace(/^Thread:\s*/i, '').trim();
                        if (thread && !stateAccumulator.activeThreads.includes(thread)) {
                            stateAccumulator.activeThreads.push(thread);
                        }
                    }
                    if (lower.startsWith('condition:')) {
                        const cond = line.replace(/^Condition:\s*/i, '').trim();
                        if (cond && !stateAccumulator.worldConditions.includes(cond)) {
                            stateAccumulator.worldConditions.push(cond);
                        }
                    }
                }
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
                dlog(`[NWST BatchScan] Secrets scan added ${secretsAdded} new secret(s).`);
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

// ── Scene boundary detection ─────────────────────────────────────────────

/** Regex patterns that indicate a scene break in narrative text.
 *  NOTE: No `g` flag — `test()` with `g` maintains `lastIndex` state
 *  across calls, causing incorrect results for repeated invocations. */
const SCENE_BREAK_PATTERNS = [
    /^-{3,}$/m,        // ---
    /^\*{3,}$/m,       // ***
    /^={3,}$/m,        // ===
    /\b(the next day|meanwhile|later that|some time later|the following)\b/i,
    /\b(a few (hours|days|weeks) later)\b/i,
    /\b(elsewhere|simultaneously|back at|meanwhile,)\b/i,
];

/**
 * Check if a message text contains scene break indicators.
 * @param {string} text - The message text to check
 * @returns {boolean} True if scene break detected
 */
function hasSceneBreak(text) {
    if (!text) return false;
    for (const pattern of SCENE_BREAK_PATTERNS) {
        if (pattern.test(text)) return true;
    }
    return false;
}

/**
 * Detect if there's a speaker change between consecutive messages.
 * @param {object} prev - Previous message
 * @param {object} curr - Current message
 * @returns {boolean} True if speaker changed
 */
function isSpeakerChange(prev, curr) {
    if (!prev || !curr) return false;
    const prevName = prev.name || (prev.is_user ? 'User' : 'Character');
    const currName = curr.name || (curr.is_user ? 'User' : 'Character');
    return prevName !== currName;
}

/**
 * Detect scene boundaries within a set of messages and return scene break indices.
 * @param {object[]} messages - Array of message objects
 * @param {number} startIdx - Index to start scanning from
 * @param {number} endIdx - Index to stop scanning at
 * @returns {number[]} Array of message indices where scenes break
 */
function detectSceneBreaks(messages, startIdx, endIdx) {
    const breaks = [];
    for (let i = startIdx + 1; i <= endIdx; i++) {
        const msg = messages[i];
        const prev = messages[i - 1];
        // Check for explicit break markers in message text
        if (msg.mes && hasSceneBreak(msg.mes)) {
            breaks.push(i);
            continue;
        }
        // Check for speaker change (scene transition signal)
        if (isSpeakerChange(prev, msg)) {
            breaks.push(i);
            continue;
        }
        // Check for system messages interleaved (OOC notes, narration)
        if (msg.is_system && prev && !prev.is_system) {
            breaks.push(i);
        }
    }
    return breaks;
}

/**
 * Chunk messages with scene-awareness.
 * Prefers splitting at scene boundaries (speaker changes, break markers)
 * but still respects the approximate token limit to ensure each chunk fits
 * in the LLM context window.
 *
 * @param {object[]} messages - Array of message objects from the chat
 * @param {number} approxTokensPerChunk - Approximate token budget per chunk
 * @returns {object[][]} Array of message chunks (each chunk is an array of message objects)
 */
function chunkMessages(messages, approxTokensPerChunk) {
    const charsPerChunk = approxTokensPerChunk * 4;
    const minChunkChars = Math.floor(charsPerChunk * 0.4); // Don't split finer than 40% of budget
    const chunks = [];
    let chunkStart = 0;

    while (chunkStart < messages.length) {
        // Count characters in the window starting from chunkStart
        let runningChars = 0;
        let lastBreakWithinBudget = -1;
        let endIdx = chunkStart;

        for (let i = chunkStart; i < messages.length; i++) {
            const msg = messages[i];
            const msgText = `[${msg.name || (msg.is_user ? 'User' : 'Character')}]: ${msg.mes || ''}`;
            const msgChars = msgText.length;

            // If adding this message would exceed budget and we already have content
            if (runningChars + msgChars > charsPerChunk && endIdx > chunkStart) {
                // Check for scene breaks within the current accumulated range
                const breaks = detectSceneBreaks(messages, chunkStart, i - 1);
                // Find the last scene break that is within a reasonable range
                for (const b of breaks) {
                    const breakChars = messages.slice(chunkStart, b).reduce((sum, m) => {
                        return sum + (`[${m.name || (m.is_user ? 'User' : 'Character')}]: ${m.mes || ''}`.length);
                    }, 0);
                    if (breakChars >= minChunkChars && breakChars <= charsPerChunk) {
                        lastBreakWithinBudget = b;
                    }
                }

                if (lastBreakWithinBudget > chunkStart) {
                    // Split at the best scene boundary within budget
                    chunks.push(messages.slice(chunkStart, lastBreakWithinBudget));
                    chunkStart = lastBreakWithinBudget;
                } else {
                    // No good scene boundary found — split at current position
                    chunks.push(messages.slice(chunkStart, i));
                    chunkStart = i;
                }
                runningChars = 0;
                lastBreakWithinBudget = -1;
                endIdx = chunkStart;
                break;
            }

            runningChars += msgChars;
            endIdx = i + 1;
        }

        // If we consumed all remaining messages without hitting the budget
        if (endIdx > chunkStart) {
            chunks.push(messages.slice(chunkStart, endIdx));
            chunkStart = endIdx;
        }
    }

    return chunks;
}

/**
 * Detect scene transitions within a chunk and return annotations.
 * A scene boundary is created when there's an explicit break marker,
 * or when a speaker change occurs after we've seen at least 2 characters
 * in the current scene.
 * @param {object[]} chunk - Array of message objects
 * @returns {Array} Scene annotations [{ startIndex, endIndex, label, characters }]
 */
function detectChunkScenes(chunk) {
    const scenes = [];
    let currentScene = { startIndex: 0, label: 'Scene 1', characters: new Set() };
    if (chunk.length > 0) {
        const firstMsg = chunk[0];
        currentScene.characters.add(firstMsg.name || (firstMsg.is_user ? 'User' : 'Character'));
    }

    for (let i = 1; i < chunk.length; i++) {
        const msg = chunk[i];
        const prev = chunk[i - 1];
        const sender = msg.name || (msg.is_user ? 'User' : 'Character');
        const prevSender = prev.name || (prev.is_user ? 'User' : 'Character');

        // Check for scene break
        const explicitBreak = msg.mes && hasSceneBreak(msg.mes);
        const speakerChange = sender !== prevSender;

        if (explicitBreak || (speakerChange && currentScene.characters.size >= 2)) {
            // Close current scene
            scenes.push({
                startIndex: currentScene.startIndex,
                endIndex: i - 1,
                label: currentScene.label,
                characters: [...currentScene.characters]
            });
            // Open new scene
            const sceneNum = scenes.length + 1;
            currentScene = {
                startIndex: i,
                label: `Scene ${sceneNum}`,
                characters: new Set([sender])
            };
        } else {
            currentScene.characters.add(sender);
        }
    }

    // Final scene
    scenes.push({
        startIndex: currentScene.startIndex,
        endIndex: chunk.length - 1,
        label: currentScene.label,
        characters: [...currentScene.characters]
    });

    return scenes;
}

/**
 * Format a message chunk for LLM consumption, with scene-aware annotations.
 * Inserts scene break markers between detected narrative segments to help
 * the LLM identify distinct scenes and their character compositions.
 *
 * @param {object[]} chunk - Array of message objects for this chunk
 * @param {number} chunkNum - 1-based chunk index
 * @param {number} totalChunks - Total number of chunks
 * @param {number} startMsg - 1-based start message number (overall)
 * @param {number} endMsg - 1-based end message number (overall)
 * @param {string|null} settingContext - Optional setting context string
 * @returns {string} Formatted chunk text with scene annotations
 */
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

    // Detect scenes within this chunk for annotation
    const scenes = detectChunkScenes(chunk);
    let sceneIdx = 0;

    for (let i = 0; i < chunk.length; i++) {
        const msg = chunk[i];
        const sender = msg.name || (msg.is_user ? 'User' : 'Character');

        // Insert scene break annotation when we cross into a new scene
        if (sceneIdx < scenes.length && i === scenes[sceneIdx].startIndex) {
            const scene = scenes[sceneIdx];
            const charList = scene.characters.join(', ');
            text += `\n--- ${scene.label}: Characters [${charList}] ---\n`;
            sceneIdx++;
        }

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
    // ── Synthesis Budget ────────────────────────────────────────────
    // Scale output quantity based on chat volume to prevent bloated or
    // sparse initial world states. Longer chats produce more material.
    const budgetScale = messageCount <= 20 ? 'compact' :
        messageCount <= 80 ? 'moderate' :
        messageCount <= 200 ? 'generous' : 'comprehensive';

    const eventTargetMin = messageCount <= 20 ? 6 :
        messageCount <= 80 ? 10 :
        messageCount <= 200 ? 14 : 18;
    const eventTargetMax = messageCount <= 20 ? 12 :
        messageCount <= 80 ? 18 :
        messageCount <= 200 ? 24 : 30;
    const secretTargetMax = messageCount <= 20 ? 2 :
        messageCount <= 80 ? 4 :
        messageCount <= 200 ? 6 : 8;
    const notebookFieldTarget = messageCount <= 20 ? 2 :
        messageCount <= 80 ? 3 :
        messageCount <= 200 ? 5 : 7;
    const communityTarget = messageCount <= 20 ? 2 :
        messageCount <= 80 ? 4 :
        messageCount <= 200 ? 6 : 8;

    // ── Build structured prompt ─────────────────────────────────────

    // Extract structured overview from the accumulated context headers
    const chunkMatches = accumulatedContext.match(/=== Chunk \d+\/\d+ \(Messages \d+–\d+, ~\d+ scene\(s\)\) ===/g) || [];
    const totalChunks = chunkMatches.length;

    let prompt = `You have analyzed the full ${messageCount}-message chat history across ${totalChunks} chunk(s).\n\n`;

    // ── Accumulated Analysis (scene-structured) ─────────────────────
    prompt += `=== ACCUMULATED SCENE-LEVEL ANALYSIS ===\n`;
    prompt += accumulatedContext;
    prompt += `\n\n`;
    prompt += `=== SYNTHESIS INSTRUCTIONS ===\n`;
    prompt += `Now synthesize the COMPLETE initial world state as a single JSON object.\n`;

    // ── Synthesis Budget Guidance ───────────────────────────────────
    prompt += `\n─── SYNTHESIS BUDGET (${budgetScale}) ───\n`;
    prompt += `Based on the chat volume (${messageCount} messages), use these output targets:\n`;
    prompt += `  Events: ${eventTargetMin}–${eventTargetMax} total (across all tiers and categories)\n`;
    prompt += `    - Distribute: ~40% immediate/week, ~30% month, ~30% undetermined\n`;
    prompt += `    - World events per tier: max ${Math.min(5, Math.ceil(eventTargetMax / 4))}\n`;
    prompt += `    - Generated NPC events per tier: max ${Math.min(5, Math.ceil(eventTargetMax / 4))}\n`;
    prompt += `    - Detected NPC events: no cap (facts from chat)\n`;
    prompt += `  Secrets: 0–${secretTargetMax} (quality over quantity)\n`;
    prompt += `  Notebook fields: aim for ${notebookFieldTarget}–${notebookFieldTarget + 2} bullets per applicable field\n`;
    prompt += `  Communities: ${communityTarget} max (merge related factions)\n`;
    prompt += `\nThese are GUIDELINES, not hard limits. A chat with rich material should exceed the minimum; a sparse chat should not pad.\n\n`;

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
      "isNPC": "true if NPC-driven (character struggles, relationships, backstory, decisions — NPC name appears in title/description), false if world/player-facing (factions, festivals, environment, rumors)",
      "scheduledDate": "REQUIRED when timing is clear — reference the dayCount above. Format: relative 'Day N+1' (story days) or absolute 'Month/Date' (calendar). OMIT for vague/uncertain timing — not all events need a pinned date.",
      "participants": ["CharacterName1", "CharacterName2"],
      "participants_instructions": "List ALL characters involved in this event. Use the character names EXACTLY as they appear in chat. If a character is mentioned in relation to this event, include them. NPC events MUST include the NPC character. Use empty array [] only for world events with no direct character involvement (e.g. weather, natural disaster, festival with unspecified participants)."
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
        dlog('Raw response (first 500 chars):', response.substring(0, 500));
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
            dlog(`[NWST BatchScan] Seeded ${addedCount} secret(s) from synthesis.`);
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
                    dlog(`[NWST BatchScan] Extracted dateSub from dateDisplay pipe: "${result.currentDay.dateSub}"`);
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
            dlog(`[NWST BatchScan] dayCount SET from dateDisplay: ${oldVal ?? 'none'} → ${computedDayCount} (from "${result.currentDay.dateDisplay}")`);
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
                    dlog(`[NWST BatchScan] Preserved existing dayCount: ${result.currentDay.dayCount}`);
                } else {
                    result.currentDay.dayCount = 1;
                    dlog(`[NWST BatchScan] Set default dayCount: 1`);
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
                    dlog(`[NWST BatchScan] Normalized season from verbose description to "${result.currentDay.season}"`);
                } else {
                    const firstSentence = seasonText.split(/[.\n;]/)[0].trim();
                    result.currentDay.season = firstSentence;
                    dlog(`[NWST BatchScan] Trimmed season to first segment: "${result.currentDay.season.substring(0, 60)}"`);
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
                    dlog(`[NWST BatchScan] Normalized season from verbose description to "${result.currentDay.season}"`);
                } else {
                    // No recognized season word — take just first sentence
                    const firstSentence = seasonText.split(/[.\n;]/)[0].trim();
                    result.currentDay.season = firstSentence;
                    dlog(`[NWST BatchScan] Trimmed season to first segment: "${result.currentDay.season.substring(0, 60)}"`);
                }
            }
        }

        // ── Override season with configured value ────────────────────
        // When the seasonal engine is active (mode 'auto' or 'static'), the
        // computed season OVERRIDES whatever the LLM wrote for the season field
        // (after basic normalization). The LLM writes evocative prose *about*
        // that season — the engine is the authority. This ensures custom season
        // names (e.g. "Haru 春") appear in the Current Day display instead of
        // the LLM's default English name (e.g. "Spring").
        if (result.currentDay.dayCount > 0) {
            const seasonConfig = getSeasonConfig(chatId);
            const computedSeason = computeSeason(result.currentDay.dayCount, seasonConfig);
            if (computedSeason !== null && computedSeason !== undefined) {
                result.currentDay.season = computedSeason;
                dlog(`[NWST BatchScan] Overrode season with configured value: "${computedSeason}"`);
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
                dlog(`[NWST BatchScan] Event pool cap (${poolCap}) reached — skipping generated event: "${event.title}"`);
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
        dlog(`[NWST BatchScan] DIAG: result.notebook has keys: [${Object.keys(result.notebook).join(', ')}], has secrets: ${'secrets' in result.notebook}`);
        // Check whether secrets from result.secrets were already added to metadata
        try {
            const { getNotebook } = await import('../data/notebook.js');
            const existingBeforeOverwrite = getNotebook(chatId);
            dlog(`[NWST BatchScan] DIAG: existing notebook before saveNotebook — secrets count: ${existingBeforeOverwrite.secrets?.length ?? 'N/A'}`);
            dlog(`[NWST BatchScan] DIAG: existing core.unresolvedDetail count: ${existingBeforeOverwrite.core?.unresolvedDetail?.length ?? 'N/A'}`);
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
            dlog(`[NWST BatchScan] Normalized ${normalized} string fields to arrays in notebook`);
        }

        const { saveNotebook } = await import('../data/notebook.js');
        dlog(`[NWST BatchScan] DIAG: About to saveNotebook — result.notebook has secrets? ${'secrets' in result.notebook}, core keys: ${Object.keys(result.notebook.core || {}).join(', ')}`);
        await saveNotebook(chatId, result.notebook);
        // Verify after save
        try {
            const afterOverwrite = getNotebook(chatId);
            dlog(`[NWST BatchScan] DIAG: after saveNotebook — secrets count: ${afterOverwrite.secrets?.length ?? 'N/A'}, core.unresolvedDetail count: ${afterOverwrite.core?.unresolvedDetail?.length ?? 'N/A'}`);
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
    dlog('[NWST BatchScan] Events generated in single synthesis pass (no separate world event call).');
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

// ── Event Participant Review (LLM-powered) ─────────────────────────────────

/**
 * Use the Planning LLM to review all events and add participants where missing.
 * Called by the debug button in the Events tab.
 *
 * For each event that has an empty or missing participants array, the LLM
 * analyzes the event title and description and determines which characters
 * are involved, then updates the event in-place.
 *
 * @param {string} chatId
 * @returns {Promise<{reviewed: number, updated: number}>}
 */
export async function reviewEventParticipants(chatId) {
    const { getAllEvents, updateEvent, saveAllEvents } = await import('../data/events.js');

    const events = getAllEvents(chatId);
    if (!events || events.length === 0) {
        return { reviewed: 0, updated: 0 };
    }

    // Only review events that need participants
    const needsReview = events.filter(e =>
        !Array.isArray(e.participants) || e.participants.length === 0
    );

    if (needsReview.length === 0) {
        return { reviewed: events.length, updated: 0 };
    }

    const profile = resolveProfile('planningLLM');
    if (!profile) {
        throw new Error('No Planning LLM profile configured. Please set one in NWST Settings.');
    }

    const systemMessage = {
        role: 'system',
        content: 'You are an event analysis assistant. Given a list of narrative events, determine which characters are participants in each event. Return ONLY valid JSON — no markdown, no code fences, no extra text.'
    };

    let updated = 0;

    // Process in batches of 10 to stay within context limits
    const BATCH_SIZE = 10;
    for (let i = 0; i < needsReview.length; i += BATCH_SIZE) {
        const batch = needsReview.slice(i, i + BATCH_SIZE);

        const eventList = batch.map((ev, idx) =>
            `[${idx + 1}] Title: "${ev.title}"\n` +
            `    Description: ${ev.description || '(none)'}\n` +
            `    Tier: ${ev.tier || 'undetermined'}\n` +
            `    Type: ${ev.isNPC ? 'NPC event' : 'World event'}`
        ).join('\n\n');

        const userMessage = {
            role: 'user',
            content: [
                'Review these events and add participants (character names involved):',
                '',
                eventList,
                '',
                'For each event, list the character names that are participants.',
                'Use exact character names as they appear in the event title/description.',
                'If an event has no clear character participants (e.g. a weather event or festival',
                'with no specific characters), return an empty array.',
                '',
                'Return ONLY this JSON structure (no markdown, no code fences):',
                '{',
                '  "events": [',
                '    { "index": 1, "participants": ["Name1", "Name2"] },',
                '    { "index": 2, "participants": [] }',
                '  ]',
                '}'
            ].join('\n')
        };

        try {
            const { generateWithProfile } = await import('./connections.js');
            const response = await generateWithProfile(profile, [systemMessage, userMessage], {
                maxTokens: 500
            });

            if (!response) continue;

            // Parse JSON
            let jsonStr = response.trim();
            const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (fenceMatch) jsonStr = fenceMatch[1].trim();

            const result = JSON.parse(jsonStr);
            if (!result.events || !Array.isArray(result.events)) continue;

            for (const entry of result.events) {
                const evIdx = entry.index - 1;
                if (evIdx < 0 || evIdx >= batch.length) continue;
                if (!Array.isArray(entry.participants)) continue;

                const event = batch[evIdx];
                event.participants = entry.participants;
                updated++;
            }
        } catch (e) {
            console.warn('[NWST BatchScan] Failed to review participant batch:', e);
        }
    }

    // Save all updated events
    if (updated > 0) {
        await saveAllEvents(chatId, events);
    }

    return { reviewed: needsReview.length, updated };
}
