/* eslint-disable */
// =============================================================================
// NWST Event Generation — llm/eventGen.js
// =============================================================================
// Handles event generation and NPC event detection via the Planning LLM.
//
// Four event types:
//   NPC DETECTED   — scanner finds explicit character plans in chat
//   NPC GENERATED  — Planning LLM extrapolates plausible NPC activity
//   WORLD DETECTED — scanner finds world happenings in chat text
//   WORLD GENERATED — Planning LLM uses setting context + world conditions
//
// KEY DISTINCTION:
//   Events are FORWARD-FACING. They describe what is coming, not what happened.
//   Things that already happened belong in the Notebook, not here.
//
// All generated events pass a plausibility check against notebook facts,
// world conditions, and active events before being proposed.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { getCurrentDay, getEnabledConditions, getSettingContext, getMoonPhases, getForecast, getCalendarConfig } from '../data/worldState.js';
import { getAllEvents, addEvent, getActiveEvents } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { getAllCommunities } from '../data/communities.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { getMaxActiveEvents } from '../settings.js';

// ── Internal prompts ──────────────────────────────────────────────────────

const EVENT_GEN_SYSTEM_PROMPT = `You are a narrative event planner for an ongoing roleplay. Your sole job is to invent plausible UPCOMING events — things that have not happened yet but could or will happen given the current world state, season, and character dynamics.

CRITICAL RULE: Events are FORWARD-FACING only. Do NOT log things that already happened. Do NOT summarize recent chat. Do NOT restate what characters have already done. If something already occurred, it belongs in the notebook, not the event horizon. If you find yourself writing about something in the past tense, stop — that is not an event.

You will receive:
- The current date, season, and weather (including moon phase)
- Active world conditions (political, social, spiritual, environmental)
- The setting context (world description, climate, location, culture)
- Flora and fauna state
- Current notebook (established facts, planted details, character whereabouts)
- Currently active events (DO NOT duplicate these)
- Community summaries (social dynamics, faction pressures)
- Recent chat messages — these exist only to understand current character dynamics and detect explicitly stated plans

MANDATORY: You MUST generate events across BOTH categories. At minimum, generate 1-2 WORLD EVENTS and 1-2 NPC EVENTS per tier (where plausible).

---

NPC EVENTS — things specific characters will plausibly do:
  - Routine activities driven by character role (e.g. a monk performing evening sutras, a chef preparing seasonal dishes)
  - Meetings, visits, encounters that follow from established character dynamics
  - Social tensions playing out (rivalries, alliances, romantic tensions)
  - Character-driven complications that follow naturally from current tensions
  - Grounded in character behavior and role, NOT in what chat text explicitly states

WORLD EVENTS — ambient happenings that exist in the world independent of any character:
  - SEASONAL: Festivals, harvests, migrations, solstice/equinox observances, planting seasons, monsoons, cultural holidays tied to the current date
  - POLITICAL: Tribute deliveries, tax collection, noble visits, messenger arrivals, council meetings, border patrols, diplomatic envoys
  - ENVIRONMENTAL: Weather shifts, wildlife patterns, blooming/flowering seasons, river flooding, wildfire seasons, earthquake seasons
  - CULTURAL: Market days, temple ceremonies, coming-of-age rites, mourning periods, victory celebrations, anniversary commemorations
  - These are EXTRAPOLATED from world context and setting — they should feel like organic world rhythms, NOT textual extractions
  - MOON PHASE CAVEAT: Moon phases are timing context only. Do NOT create events whose titles or primary subject is a moon phase (e.g. "Full Moon Patrol", "Waning Gibbous Ceremony"). A "Patrol under the full moon" describes timing — "Full Moon Patrol" treats the moon phase as the event subject. Exception: if the setting context explicitly describes moon-based cultural traditions (e.g. Heian-era tsukimi), culturally-appropriate moon-referenced events are allowed.

---

TIERS:
  - immediate: happening today or within the next day or two
  - week: happening within the next week
  - month: happening within the next month

PLAUSIBILITY RULES:
  - Cross-reference the notebook's "Established Facts" — do not contradict them
  - Cross-reference active events — do not duplicate them
  - Cross-reference character whereabouts — do not place characters somewhere they can't be
  - Cross-reference world conditions — do not generate events that contradict the current world state
  - Seasonal/cultural events must match the current season, date, and setting context

EVENT COUNT LIMITS — STRICTLY ENFORCED PER CATEGORY:
  - WORLD EVENTS: maximum 2 per tier per regen call. These are background texture — less is more.
  - GENERATED NPC EVENTS (npcOrigin: "generated"): maximum 3 per tier per regen call.
  - DETECTED NPC EVENTS (npcOrigin: "detected"): NO CAP — if a character explicitly stated it, capture it.
  - Fewer is better. 2 strong world events beat 4 weak ones.
  - If a tier genuinely cannot support the maximum, generate fewer rather than padding.

STYLE:
  - Write event descriptions with atmospheric, narrative detail
  - NPC events should feel character-specific and grounded in personality
  - World events should feel like organic living-world rhythms — things that would happen whether or not the characters engage with them
  - Descriptions should be 1-3 sentences, evocative but concise

EXAMPLES OF GOOD WORLD EVENTS (for reference — do not copy, extrapolate your own):
  - "Chrysanthemum Festival preparations begin in the nearby village — the first shipments of sake and decorative flowers arrive today"
  - "Scheduled tribute delivery from the western provinces — the escort caravan is expected by midday"
  - "The great bell at the temple is struck at dusk — a storm is brewing and the monks call the faithful to prayer"
  - "Harvest season begins in the valley — farmers will be occupied for the next two weeks, reducing local market availability"
  - "Evening sutras in the main hall — Monk Jien performs the dusk service as he does every day"

Respond with a JSON array:
[
  {
    "title": "Brief event title — a forward-facing label, not a past-tense summary",
    "description": "Atmospheric, forward-facing description of what is coming",
    "tier": "immediate" | "week" | "month",
    "isNPC": true | false,
    "npcOrigin": "generated",
    "scheduledDate": "REQUIRED when timing is clear — reference the story day above. Format: \"Day #\" (relative story days, e.g. \"Day 4\") or \"Month/Date\" (absolute calendar, e.g. \"3/15\"). OMIT for vague/uncertain timing — not all events need a pinned date."
  }
]

Generate events per category limits: max 2 WORLD events, max 3 GENERATED NPC events per tier. DETECTED NPC events (explicitly stated plans) have no cap — capture all of them. Quality over quantity. If a tier genuinely has nothing plausible, leave it out rather than forcing a weak entry. Return [] only if no events whatsoever can be plausibly generated.

REMEMBER: World events should feel like a living world. The characters may or may not engage with them, but they exist regardless. NPC events should feel like natural character behavior, not scripted plot points.`;

const NPC_DETECTION_PROMPT = `You are scanning a roleplay chat for explicit future plans made by or involving characters. Your job is to identify things characters have EXPLICITLY stated will happen — scheduled meetings, promises, arrangements, stated intentions for the near future.

ONLY flag events that are directly stated or clearly implied by a character's words or actions in the chat. Do NOT invent or extrapolate. Do NOT include things that have already happened.

For each detected event, extract:
- What will happen
- Who is involved
- When (if stated)
- The tier (immediate = next 1-2 days, week = this week, month = this month, undetermined = timing unclear)

Respond with a JSON array:
[
  {
    "title": "Brief label for the planned event",
    "description": "What was stated or clearly implied, with context",
    "tier": "immediate" | "week" | "month" | "undetermined",
    "isNPC": true,
    "npcOrigin": "detected",
    "detectedFrom": "brief quote or reference from the chat that confirms this",
    "scheduledDate": "OPTIONAL — only when a SPECIFIC date was mentioned. Format as stated by the character (e.g. 'Day 3', 'the 15th'). Omit if no date was given — uncertainty is fine."
  }
]

Return [] if no explicit future plans are found.`;

// ── Regenerate events for a specific tier ─────────────────────────────────

/**
 * Regenerate events for a specific tier (Immediate, Week, Month).
 * Undetermined events are NEVER regenerated.
 *
 * @param {string} tier - 'immediate' | 'week' | 'month'
 * @returns {Promise<number>} Number of new events generated
 */
export async function regenerateTierEvents(tier) {
    if (tier === 'undetermined') {
        nwstToast('Undetermined events are never regenerated — their timing is intentional.', 'warning');
        return 0;
    }

    const chatId = getChatId();
    if (!chatId) return 0;

    nwstToast(`Regenerating ${tier} events...`, 'info');

    try {
        const profile = resolveProfile('planningLLM');
        if (!profile) throw new Error('No Planning LLM profile configured.');

        // Gather full context — the LLM needs all of this to generate well
        const context = await gatherEventContext(chatId, tier);

        // Build the generation prompt
        const userPrompt = buildEventGenPrompt(context, tier);

        const messages = [
            { role: 'system', content: EVENT_GEN_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, messages);
        const events = parseEventGenResponse(response);

        // Category-aware caps (applied before plausibility check):
        //   Detected NPC events  — no cap (facts extracted from chat)
        //   Generated NPC events — max 3 per tier
        //   World events         — max 2 per tier
        const categoryCounts = { detected_npc: 0, generated_npc: 0, world: 0 };
        const cappedEvents = events.filter(event => {
            if (event.isNPC && event.npcOrigin === 'detected') {
                // No cap on detected NPC events
                return true;
            } else if (event.isNPC) {
                // Generated NPC — max 3
                if (categoryCounts.generated_npc >= 3) return false;
                categoryCounts.generated_npc++;
                return true;
            } else {
                // World event — max 2
                if (categoryCounts.world >= 2) return false;
                categoryCounts.world++;
                return true;
            }
        });

        // Plausibility check against notebook and active events
        const validEvents = runPlausibilityCheck(chatId, cappedEvents);

        // Check active pool cap before committing events.
        // EXCEPTION: detected NPC events (explicit plans from chat) always bypass the cap —
        // they are facts, not generated content, and should never be silently dropped.
        const poolCap = getMaxActiveEvents();
        const currentActive = getAllEvents(chatId).filter(e =>
            e.status === 'pending' || e.status === 'inprogress'
        ).length;
        const slotsAvailable = Math.max(0, poolCap - currentActive);

        // Separate detected (cap-exempt) from generated (cap-subject)
        const detectedEvents = validEvents.filter(e => e.isNPC && e.npcOrigin === 'detected');
        const generatedEvents = validEvents.filter(e => !(e.isNPC && e.npcOrigin === 'detected'));

        if (slotsAvailable === 0 && generatedEvents.length > 0) {
            nwstToast(`Event pool is full (${poolCap} active events). Resolve or dismiss existing events to make room.`, 'warning');
        }

        // Commit detected events unconditionally
        // Commit generated events only up to available slots
        const generatedToAdd = generatedEvents.slice(0, slotsAvailable);
        const eventsToAdd = [...detectedEvents, ...generatedToAdd];

        let added = 0;
        for (const event of eventsToAdd) {
            await addEvent(chatId, {
                title: event.title,
                description: event.description,
                tier: event.tier || tier,
                status: 'pending',
                isNPC: event.isNPC || false,
                npcOrigin: event.isNPC ? (event.npcOrigin || 'generated') : null,
                origin: event.npcOrigin === 'detected' ? 'detected' : 'generated',
                scheduledDate: event.scheduledDate || null
            });
            added++;
        }

        if (added > 0) {
            nwstToast(`${added} ${tier} event(s) generated.`, 'success');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'events');
        } else {
            nwstToast(`No new ${tier} events generated — all candidates failed plausibility check or LLM returned none.`, 'info');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'events');
        }

        return added;

    } catch (err) {
        console.error('[NWST EventGen] Regeneration failed:', err);
        nwstToast(`Event regeneration failed: ${err.message}`, 'error');
        return 0;
    }
}

/**
 * Regenerate events for ALL tiers.
 * @returns {Promise<number>} Total events generated
 */
export async function regenerateAllEvents() {
    const tiers = ['immediate', 'week', 'month'];
    let total = 0;
    for (const tier of tiers) {
        const count = await regenerateTierEvents(tier);
        total += count;
    }
    return total;
}

/**
 * Detect NPC events from recent chat — explicit plans, arrangements, promises.
 * Runs as part of the scanner. Returns proposed events for user review.
 *
 * @param {string} chatId
 * @param {object[]} recentMessages
 * @returns {Promise<object[]>} Detected NPC events (proposed, not committed)
 */
export async function detectNPCEventsFromChat(chatId, recentMessages) {
    if (!recentMessages || recentMessages.length === 0) return [];

    try {
        const profile = resolveProfile('planningLLM');
        if (!profile) return [];

        const chatText = recentMessages.map(msg => {
            const sender = msg.name || (msg.is_user ? 'User' : 'Character');
            return `[${sender}]: ${msg.mes}`;
        }).join('\n');

        const activeEvents = getActiveEvents(chatId);
        const activeTitles = activeEvents.map(e => e.title.toLowerCase());

        // Also filter against pending events to avoid duplicates with scanner-proposed events
        const chatMetadata = SillyTavern.getContext().chatMetadata;
        const pendingEvents = chatMetadata?.['nwst:pendingEvents'] || [];
        const pendingTitles = pendingEvents.map(e => e.title.toLowerCase());

        const userPrompt = `Recent chat messages to scan for explicit future plans:\n\n${chatText}\n\n` +
            `Currently active events (do not duplicate):\n${activeTitles.map(t => `- ${t}`).join('\n') || '(none)'}`;

        const messages = [
            { role: 'system', content: NPC_DETECTION_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, messages);
        const detected = parseEventGenResponse(response);

        // Filter duplicates against active events and pending events
        return detected.filter(e => {
            const title = e.title.toLowerCase().trim();
            return !activeTitles.includes(title) && !pendingTitles.includes(title);
        });

    } catch (err) {
        console.error('[NWST EventGen] NPC detection failed:', err);
        return [];
    }
}

// ── Context gathering ─────────────────────────────────────────────────────

async function gatherEventContext(chatId, tier) {
    // Get recent chat messages for character behavior context
    let recentMessages = [];
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        // Provide last 30 messages for character context without overloading the prompt
        const start = Math.max(0, chat.length - 30);
        recentMessages = chat.slice(start)
            .filter(msg => !(msg.is_system && msg.extra?.hidden))
            .map(msg => ({
                sender: msg.name || (msg.is_user ? 'User' : 'Character'),
                text: msg.mes
            }));
    } catch (e) {
        // Non-fatal — event gen can run without recent messages
    }

    return {
        currentDay: getCurrentDay(chatId),
        conditions: getEnabledConditions(chatId),
        settingContext: getSettingContext(chatId),
        notebook: getNotebook(chatId),
        activeEvents: getActiveEvents(chatId),
        communities: getAllCommunities(chatId),
        moonPhases: getMoonPhases(chatId),
        forecast: getForecast(chatId),
        recentMessages,
        tier
    };
}

function buildEventGenPrompt(context, tier) {
    let prompt = '';

    prompt += `Generate upcoming events for the "${tier}" tier.\n\n`;

    // ── WORLD STATE (primary event source) ───────────────────────
    prompt += `=== CURRENT DATE & CONDITIONS ===\n`;
    prompt += `Date: ${context.currentDay.dateDisplay || '(not set)'}\n`;
    if (context.currentDay.dateSub) prompt += `Sub-date: ${context.currentDay.dateSub}\n`;
    prompt += `Story day: ${typeof context.currentDay.dayCount === 'number' ? `Day ${context.currentDay.dayCount}` : '(not set)'}\n`;
    prompt += `Season: ${context.currentDay.season || '(not set)'}\n`;
    prompt += `Weather: ${context.currentDay.weatherToday || '(not set)'}\n`;
    if (context.currentDay.flora) prompt += `Flora: ${context.currentDay.flora}\n`;
    if (context.currentDay.fauna) prompt += `Fauna: ${context.currentDay.fauna}\n`;
    prompt += '\n';

    // ── SETTING CONTEXT (world-building foundation — PRIMARY driver for world events) ──
    if (context.settingContext) {
        prompt += `=== SETTING CONTEXT (use this for world events) ===\n${context.settingContext}\n\n`;
    }

    // ── MOON PHASE (timing context only — NOT event subjects) ──
    if (context.moonPhases && context.moonPhases.length > 0) {
        prompt += `=== MOON PHASES (timing context only) ===\n`;
        prompt += `(Moon phases tell you WHEN events occur, not WHAT events to create. Do NOT create events titled after or themed around a moon phase.\n`;
        prompt += ` Exception: if the setting context above describes moon-based cultural traditions, you may reference them appropriately.)\n`;
        for (const mp of context.moonPhases) {
            prompt += `  ${mp.label}: ${mp.icon} ${mp.phaseName}\n`;
        }
        prompt += '\n';
    }

    if (context.forecast && context.forecast.length > 0) {
        prompt += `=== WEATHER FORECAST (this week) ===\n`;
        for (const fc of context.forecast) {
            prompt += `  ${fc.label}: ${fc.weather || '(not set)'}\n`;
        }
        prompt += '\n';
    }

    // ── CALENDAR SYSTEM (date format reference) ─────────────────
    const chatIdForCal = getChatId();
    const calConfig = getCalendarConfig(chatIdForCal);
    if (calConfig.enabled) {
        const monthList = calConfig.monthNames.map((name, i) =>
            `${name} (${calConfig.monthDays[i]} days)`
        ).join(', ');
        const dayList = calConfig.weekDays.join(', ');
        prompt += `=== CALENDAR SYSTEM ===\n`;
        prompt += `  Months (${calConfig.months} total): ${monthList}\n`;
        prompt += `  Days of the week (${calConfig.weekDays.length} total): ${dayList}\n`;
        prompt += `  Use these month and day names when generating scheduledDate values.\n\n`;
    }

    // ── WORLD CONDITIONS ─────────────────────────────────────────
    prompt += `=== WORLD CONDITIONS (use these for world events) ===\n`;
    const condEntries = Object.entries(context.conditions);
    if (condEntries.length === 0 || condEntries.every(([, c]) => !c.content)) {
        prompt += `(no conditions set — use setting context and season to generate world events)\n`;
    } else {
        for (const [key, cond] of condEntries) {
            if (cond.content) prompt += `[${key.toUpperCase()}]: ${cond.content}\n`;
        }
    }
    prompt += '\n';

    // ── COMMUNITY DYNAMICS ──────────────────────────────────────
    if (context.communities.length > 0) {
        prompt += `=== COMMUNITY DYNAMICS (NPC behavior reference) ===\n`;
        for (const com of context.communities) {
            prompt += `${com.name} (${com.members || 'members unknown'}):\n${com.summary || '(no summary)'}\n\n`;
        }
    }

    // ── NOTEBOOK (plausibility constraints) ─────────────────────
    const nb = context.notebook;
    const hasNotebookContent =
        (nb?.core?.doNotForget?.length > 0) ||
        (nb?.core?.offscreenPressure?.length > 0) ||
        (nb?.mystery?.establishedFacts?.length > 0) ||
        (nb?.mystery?.plantedDetails?.length > 0) ||
        (nb?.mystery?.characterWhereabouts?.length > 0);

    if (hasNotebookContent) {
        prompt += `=== NOTEBOOK (plausibility reference) ===\n`;
        if (nb.core?.doNotForget?.length) prompt += `Do Not Forget:\n${nb.core.doNotForget.map(b => `  - ${b}`).join('\n')}\n`;
        if (nb.core?.offscreenPressure?.length) prompt += `Offscreen Pressure:\n${nb.core.offscreenPressure.map(b => `  - ${b}`).join('\n')}\n`;
        if (nb.mystery?.establishedFacts?.length) prompt += `Established Facts (DO NOT CONTRADICT):\n${nb.mystery.establishedFacts.map(b => `  - ${b}`).join('\n')}\n`;
        if (nb.mystery?.plantedDetails?.length) prompt += `Planted Details (hooks to consider):\n${nb.mystery.plantedDetails.map(b => `  - ${b}`).join('\n')}\n`;
        if (nb.mystery?.characterWhereabouts?.length) prompt += `Character Whereabouts:\n${nb.mystery.characterWhereabouts.map(b => `  - ${b}`).join('\n')}\n`;
        prompt += '\n';
    }

    // ── ACTIVE EVENTS (anti-duplication + temporal reference) ──
    if (context.activeEvents.length > 0) {
        prompt += `=== EXISTING ACTIVE EVENTS (DO NOT DUPLICATE) ===\n`;
        for (const event of context.activeEvents) {
            const dateStr = event.scheduledDate ? ` [${event.scheduledDate}]` : '';
            prompt += `  - [${event.tier}]${dateStr} ${event.title}\n`;
        }
        prompt += '\n';
    }

    // ── RECENT CHAT (secondary reference — do not over-focus) ──
    if (context.recentMessages.length > 0) {
        prompt += `=== RECENT CHAT (secondary reference — only for character dynamics) ===\n`;
        prompt += `(Use this to understand current character dynamics and detect any explicitly stated future plans.\n`;
        prompt += `Do NOT let this dominate your event generation. World events come from the setting, conditions, and season above, not from chat text.)\n`;
        // Only include last 8 messages instead of 15 to reduce chat dominance
        for (const msg of context.recentMessages.slice(-8)) {
            prompt += `[${msg.sender}]: ${msg.text}\n`;
        }
        prompt += '\n';
    }

    prompt += `Generate ${tier} events. Remember:\n`;
    prompt += `  1. CATEGORY CAPS: max 2 WORLD events, max 3 GENERATED NPC events per tier. Detected NPC events (explicitly stated) have no cap.\n`;
    prompt += `  2. At minimum 1 WORLD EVENT and 1 NPC EVENT (where plausible)\n`;
    prompt += `  3. World events should feel like organic world rhythms, not extractions from chat text\n`;
    prompt += `  4. Consider: seasonal festivals, cultural practices, environmental shifts, political rhythms\n`;
    prompt += `  5. scheduledDate — Use the story day shown above as reference. Events with clear timing MUST include it (e.g. "Day 4" for tomorrow, "Day 7" for next week). Omit for vague/uncertain timing.\n`;
    prompt += `  6. Forward-facing only. Respond with valid JSON array only.\n`;
    prompt += `  7. CRITICAL — USER CHARACTER BOUNDARY: NEVER create events about the USER CHARACTER's personal or mundane actions (getting coffee, leaving their desk, daily routines, etc.) unless the story narrative explicitly establishes them as plot-relevant. Events must describe what the WORLD and NPCs are doing, what natural/societal forces are unfolding, and what plot hooks exist — NOT what the user character will do.\n`;

    return prompt;
}

// ── Response parsing ───────────────────────────────────────────────────────

function parseEventGenResponse(response) {
    if (!response || typeof response !== 'string') return [];
    let jsonStr = response.trim();

    // Remove markdown code fences
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Find JSON array
    const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrMatch) jsonStr = arrMatch[0];

    try {
        const events = JSON.parse(jsonStr);
        if (!Array.isArray(events)) return [];
        return events.filter(e => e.title && e.description);
    } catch (e) {
        console.warn('[NWST EventGen] Could not parse LLM response as JSON:', e);
        return [];
    }
}

// ── Plausibility check ────────────────────────────────────────────────────

/**
 * Filter generated events against notebook facts and active events.
 * The LLM does the heavy lifting; this is a safety net for obvious duplicates.
 *
 * @param {string} chatId
 * @param {object[]} candidateEvents
 * @returns {object[]} Events that pass the check
 */
function runPlausibilityCheck(chatId, candidateEvents) {
    const activeEvents = getActiveEvents(chatId);
    const activeTitles = activeEvents.map(e => e.title.toLowerCase().trim());

    return candidateEvents.filter(event => {
        // Remove duplicates by title
        if (activeTitles.includes(event.title.toLowerCase().trim())) {
            console.log(`[NWST EventGen] Discarded duplicate: "${event.title}"`);
            return false;
        }
        // Remove events that are written in past tense (LLM failure to follow instructions)
        const desc = (event.description || '').trim();
        const pastTenseMarkers = [' has ', ' have ', ' had ', ' was ', ' were ', ' did ', ' occurred', ' happened', ' departed', ' left ', ' arrived', ' found ', ' discovered '];
        const firstSentence = desc.split('.')[0].toLowerCase();
        const isPastTense = pastTenseMarkers.some(m => firstSentence.includes(m));
        if (isPastTense) {
            console.log(`[NWST EventGen] Discarded past-tense event (should be in notebook): "${event.title}"`);
            return false;
        }
        return true;
    });
}
