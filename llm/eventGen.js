import { isNarrativeChatMessage } from './detectedEventValidation.js';
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
import { getTrackedEvents, getActivePersistentEvents, MAX_ACTIVE_PERSISTENT_EVENTS } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { getHiddenIntentions } from '../data/hiddenIntentions.js';
import { buildAliasRegistry } from '../data/aliasRegistry.js';
import { eventSemanticallyRepresentsIntention } from './hiddenIntentionsInjection.js';
import { getHiddenIntentionsConfig } from '../settings.js';
import { getAllCommunities } from '../data/communities.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { LLM_TOKEN_BUDGETS } from './tokenBudgets.js';
import { dlog } from "../lib/debug.js";
import { completeEventParticipants } from './eventParticipants.js';
import { getChatData, setAllChatData } from '../data/storage.js';
import { filterForwardNovelEvents } from './eventNovelty.js';

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
- Active Hidden Intentions (private agency pressure; never treat a plan as an accomplished fact)
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
  - MOON PHASE CAVEAT: Moon phases are timing context only. Do NOT create events whose titles or primary subject is a moon phase (e.g. "Full Moon Patrol", "Waning Gibbous Ceremony"). A "Patrol under the full moon" describes timing — "Full Moon Patrol" treats the moon phase as the event subject. Exception: if the setting context explicitly describes moon-based cultural traditions or festivals, culturally appropriate moon-referenced events are allowed.

---

TIERS:
  - immediate: happening today or tomorrow
  - week: happening within the rolling seven-day horizon after the immediate window
  - month: happening later in the current calendar month
  - persistent: a durable ongoing pressure/state that should remain active until a SPECIFIC textual resolution condition is explicitly shown in the narrative. Persistent is NOT a vague catch-all and is never date-aged.

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
    "tier": "immediate" | "week" | "month" | "persistent",
    "isNPC": true | false,
    "npcOrigin": "generated",
    "scheduledDate": "REQUIRED for timed tiers when timing is clear. ALWAYS null/omitted for persistent.",
    "resolutionCondition": "REQUIRED only for persistent: one explicit, observable narrative condition whose occurrence means this ongoing event is finished. Never use vague language such as until things settle down.",
    "participants": ["REQUIRED participant names; NPC events must be non-empty"],
    "sourceIntentionIds": ["only Hidden Intention IDs supplied below when the event directly expresses that intention"]
  }
]

PARTICIPANT REQUIREMENTS — MANDATORY:
- Every event MUST include a participants array.
- NPC events MUST include at least one named participant. Exhaust the supplied cast and community context. If none can be responsibly resolved, return the event with [] so NWST can flag it for review; never invent a name and never omit the event solely for this field.
- Non-NPC events must still include named participants when specific characters directly attend, organize, perform, review, inspect, or carry responsibility for the event.
- Institutional meetings, reviews, assignments, hearings, inspections, visits, and scheduled obligations are not participant-free merely because isNPC is false.
- Use [] only for genuinely ambient world events with no direct named character involvement.
- Use exact character names from the supplied chat/community context. Never invent names.

Generate events per category limits: max 2 WORLD events, max 3 GENERATED NPC events per tier. DETECTED NPC events (explicitly stated plans) have no cap — capture all of them. Quality over quantity. If a tier genuinely has nothing plausible, leave it out rather than forcing a weak entry. Return [] only if no events whatsoever can be plausibly generated.

REMEMBER: World events should feel like a living world. The characters may or may not engage with them, but they exist regardless. NPC events should feel like natural character behavior, not scripted plot points.`;



function classifyHiddenIntentionForEvents(item) {
    if (!item || ['parked','resolved','abandoned','stale','pending_review','blocked'].includes(item.status)) return 'exclude';
    if (item.type === 'emerging_interest') return 'exclude';
    if (item.type === 'contingency') return item.status === 'ready' ? 'direct' : 'background';
    if (item.type === 'active_plan' || item.type === 'commitment') return 'direct';
    if (item.type === 'objective' || item.type === 'ongoing_priority') return 'background';
    return 'background';
}

// ── Generate event proposals for a specific tier ──────────────────────────

/**
 * Generate event proposals for a specific tier (Immediate, Week, Month).
 * Undetermined events are NEVER generated by this action.
 *
 * @param {string} tier - 'immediate' | 'week' | 'month' | 'persistent'
 * @returns {Promise<number>} Number of new events generated
 */
let generationInFlight = false;
const MAX_PENDING_EVENT_PROPOSALS = 100;

async function regenerateTierEventsInternal(tier, options = {}) {
    if (tier === 'undetermined') {
        nwstToast('Narratively Timed events are never generated by this action — their timing is left to the roleplaying model.', 'warning');
        return 0;
    }

    const chatId = getChatId();
    if (!chatId) return 0;

    // Background callers (notably day-advance event top-up) may belong to a
    // specific chat even though they run asynchronously. Never let a delayed
    // task retarget itself to whatever chat happens to be active when it starts.
    if (options.expectedChatId && chatId !== options.expectedChatId) {
        dlog(`[NWST EventGen] Refusing stale ${tier} generation: expected chat ${options.expectedChatId}, active chat is ${chatId}.`);
        return 0;
    }

    if (tier === 'persistent') {
        const activePersistent = getActivePersistentEvents(chatId).length;
        if (activePersistent >= MAX_ACTIVE_PERSISTENT_EVENTS) {
            nwstToast(`Persistent event cap is full (${MAX_ACTIVE_PERSISTENT_EVENTS}). Resolve, replace, or remove one first.`, 'warning');
            return 0;
        }
    }

    nwstToast(`Generating ${tier} event proposals...`, 'info');

    try {
        const profile = resolveProfile('planningLLM');
        if (!profile) throw new Error('No Planning LLM profile configured.');

        // Gather full context — the LLM needs all of this to generate well
        const context = await gatherEventContext(chatId, tier);

        // Build the generation prompt
        const userPrompt = buildEventGenPrompt(context, tier, options);

        const messages = [
            { role: 'system', content: EVENT_GEN_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, messages, { maxTokens: LLM_TOKEN_BUDGETS.MEDIUM });
        if (getChatId() !== chatId) {
            dlog('[NWST EventGen] Active chat changed during event generation; discarding stale proposals.');
            return 0;
        }
        const parsedEvents = parseEventGenResponse(response);
        const allowedIntentionIds = new Set((context.hiddenIntentions || []).filter(item => item.eventRole === 'direct').map(item => item.id));
        const normalizedEvents = parsedEvents.map(event => ({
            ...event,
            tier: tier === 'persistent' ? 'persistent' : event.tier,
            scheduledDate: tier === 'persistent' ? null : (event.scheduledDate || null),
            resolutionCondition: tier === 'persistent' ? String(event.resolutionCondition || '').replace(/\s+/g, ' ').trim().slice(0, 600) : null,
            participants: Array.isArray(event.participants) ? event.participants.map(x => String(x || '').trim()).filter(Boolean).slice(0, 12) : [],
            sourceIntentionIds: Array.isArray(event.sourceIntentionIds)
                ? Array.from(new Set(event.sourceIntentionIds.filter(id => allowedIntentionIds.has(id))))
                : []
        })).filter(event => tier !== 'persistent' || event.resolutionCondition);
        const participantResult = await completeEventParticipants(chatId, normalizedEvents, {
            profile,
            communities: context.communities,
            notebook: context.notebook,
            // Generation already requires participant lists. Only spend a
            // repair call on proposals that actually came back empty.
            reviewAll: false
        });
        if (getChatId() !== chatId) {
            dlog('[NWST EventGen] Active chat changed during participant completion; discarding stale proposals.');
            return 0;
        }
        if (participantResult.invalidNPC.length) {
            for (const unresolved of participantResult.invalidNPC) {
                console.warn('[NWST EventGen] Preserving NPC event that still needs participant review:', unresolved);
            }
        }
        // Providers occasionally omit sourceIntentionIds even when they clearly
        // turned one supplied Active Plan/Commitment into an Event. Repair that
        // provenance deterministically after participant completion so prompt
        // injection can suppress the duplicate private-plan path. This applies
        // to both NPC-labelled and mixed/social Events; event.isNPC is not a
        // reliable proxy for whether an NPC intention drove the occurrence.
        const registry = buildAliasRegistry(chatId);
        const directIntentions = (context.hiddenIntentions || []).filter(item => item.eventRole === 'direct');
        const provenanceRepairedEvents = participantResult.events.map(event => {
            const linked = new Set(Array.isArray(event.sourceIntentionIds) ? event.sourceIntentionIds : []);
            for (const intention of directIntentions) {
                if (linked.has(intention.id)) continue;
                if (eventSemanticallyRepresentsIntention(intention, event, registry)) linked.add(intention.id);
            }
            return { ...event, sourceIntentionIds: Array.from(linked).filter(id => allowedIntentionIds.has(id)) };
        });
        const events = options.worldOnly ? provenanceRepairedEvents.filter(event => !event.isNPC) : provenanceRepairedEvents;

        // Category-aware caps (applied before plausibility check):
        //   Detected NPC events  — no cap (facts extracted from chat)
        //   Generated NPC events — max 3 per tier
        //   World events         — max 2 per tier
        const categoryCounts = { detected_npc: 0, generated_npc: 0, world: 0, persistent: 0 };
        const availablePersistentSlots = Math.max(0, MAX_ACTIVE_PERSISTENT_EVENTS - getActivePersistentEvents(chatId).length);
        const cappedEvents = events.filter(event => {
            if (tier === 'persistent') {
                // Persistent has an independent global cap. Keep generation
                // conservative: at most two proposals in one pass, and never
                // more proposals than the number of active slots available.
                const proposalCap = Math.min(2, availablePersistentSlots);
                if (categoryCounts.persistent >= proposalCap) return false;
                categoryCounts.persistent++;
                return true;
            }
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
        const validEvents = runPlausibilityCheck(chatId, cappedEvents, options);

        // Generated events use the same approval staging area as scanner-detected
        // events. Clicking Generate Events requests proposals; it does not commit
        // them to the active event horizon until the player approves them.
        const pending = getChatData(chatId, 'pendingEvents') || [];
        const expectedPending = JSON.parse(JSON.stringify(pending));
        const existingTitles = new Set(pending.map(e => e.title?.toLowerCase().trim()).filter(Boolean));

        let proposed = 0;
        let unresolvedProposed = 0;
        for (const event of validEvents) {
            const titleKey = event.title?.toLowerCase().trim();
            if (!titleKey || existingTitles.has(titleKey)) continue;
            pending.push({
                title: event.title,
                description: event.description,
                tier: event.tier || tier,
                status: 'pending',
                isNPC: Boolean(event.isNPC),
                npcOrigin: event.isNPC ? (event.npcOrigin || 'generated') : null,
                origin: event.npcOrigin === 'detected' ? 'detected' : 'generated',
                scheduledDate: event.tier === 'persistent' ? null : (event.scheduledDate || null),
                resolutionCondition: event.tier === 'persistent' ? (event.resolutionCondition || null) : null,
                participants: Array.isArray(event.participants) ? event.participants : [],
                sourceIntentionIds: Array.isArray(event.sourceIntentionIds) ? event.sourceIntentionIds : [],
                id: `pending_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                proposedAt: Date.now()
            });
            existingTitles.add(titleKey);
            proposed++;
            if (event.isNPC && (!Array.isArray(event.participants) || event.participants.length === 0)) unresolvedProposed++;
        }

        if (proposed > 0) {
            if (pending.length > MAX_PENDING_EVENT_PROPOSALS) {
                pending.splice(0, pending.length - MAX_PENDING_EVENT_PROPOSALS);
            }
            await setAllChatData(chatId, { pendingEvents: pending }, { pendingEvents: expectedPending });
            if (unresolvedProposed > 0) {
                nwstToast(`${proposed} ${tier} event proposal(s) ready. ${unresolvedProposed} NPC event(s) failed to generate with a named participant and should be reviewed.`, 'warning');
            } else {
                nwstToast(`${proposed} ${tier} event proposal(s) ready for review in Events.`, 'success');
            }
            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'events');
        } else {
            nwstToast(`No new ${tier} event proposals — all candidates were duplicates, failed plausibility checks, or the LLM returned none.`, 'info');
        }

        return proposed;

    } catch (err) {
        console.error('[NWST EventGen] Event generation failed:', err);
        nwstToast(`Event generation failed: ${err.message}`, 'error');
        return 0;
    }
}

export async function regenerateTierEvents(tier, options = {}) {
    if (generationInFlight) {
        nwstToast('Event generation is already running.', 'info');
        return 0;
    }
    generationInFlight = true;
    try {
        return await regenerateTierEventsInternal(tier, options);
    } finally {
        generationInFlight = false;
    }
}

/**
 * Generate event proposals for ALL visible timed tiers.
 * @returns {Promise<number>} Total events generated
 */
export async function regenerateAllEvents() {
    if (generationInFlight) {
        nwstToast('Event generation is already running.', 'info');
        return 0;
    }
    generationInFlight = true;
    const expectedChatId = getChatId();
    const tiers = ['immediate', 'week', 'month', 'persistent'];
    let total = 0;
    try {
        for (const tier of tiers) {
            if (!expectedChatId || getChatId() !== expectedChatId) break;
            const count = await regenerateTierEventsInternal(tier);
            total += count;
        }
        return total;
    } finally {
        generationInFlight = false;
    }
}

/**
 * Generate only non-NPC/world event proposals after a Setting Context switch.
 * NPC continuity is intentionally left alone. The settingRefresh flag tells the
 * prompt to rely on the new Setting Context + date/season rather than stale
 * location-specific weather/conditions from the previous setting.
 */
export async function regenerateAllWorldEvents(options = {}) {
    if (generationInFlight) {
        nwstToast('Event generation is already running.', 'info');
        return 0;
    }
    generationInFlight = true;
    const expectedChatId = getChatId();
    const tiers = ['immediate', 'week', 'month'];
    let total = 0;
    try {
        for (const tier of tiers) {
            if (!expectedChatId || getChatId() !== expectedChatId) break;
            const count = await regenerateTierEventsInternal(tier, {
                ...options,
                worldOnly: true,
                settingRefresh: options.settingRefresh !== false,
            });
            total += count;
        }
        return total;
    } finally {
        generationInFlight = false;
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
        recentMessages = chat.filter(isNarrativeChatMessage).slice(-30)
            .map(msg => ({
                sender: msg.is_user ? 'USER/PC' : 'NARRATION',
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
        activeEvents: getTrackedEvents(chatId),
        communities: getAllCommunities(chatId),
        hiddenIntentions: getHiddenIntentionsConfig().enabled
            ? getHiddenIntentions(chatId)
                .map(item => ({ ...item, eventRole: classifyHiddenIntentionForEvents(item) }))
                .filter(item => item.eventRole !== 'exclude')
            : [],
        moonPhases: getMoonPhases(chatId),
        forecast: getForecast(chatId),
        recentMessages,
        tier
    };
}

function buildEventGenPrompt(context, tier, options = {}) {
    let prompt = '';

    prompt += `Generate upcoming events for the "${tier}" tier.\n\n`;

    // ── WORLD STATE (primary event source) ───────────────────────
    prompt += `=== CURRENT DATE & CONDITIONS ===\n`;
    prompt += `Date: ${context.currentDay.dateDisplay || '(not set)'}\n`;
    if (context.currentDay.dateSub) prompt += `Sub-date: ${context.currentDay.dateSub}\n`;
    prompt += `Calendar day-of-year: ${typeof context.currentDay.dayCount === 'number' ? `Day ${context.currentDay.dayCount}` : '(not set)'}\n`;
    prompt += `Season: ${context.currentDay.season || '(not set)'}\n`;
    if (!options.settingRefresh) {
        prompt += `Weather: ${context.currentDay.weatherToday || '(not set)'}\n`;
        if (context.currentDay.flora) prompt += `Flora: ${context.currentDay.flora}\n`;
        if (context.currentDay.fauna) prompt += `Fauna: ${context.currentDay.fauna}\n`;
    } else {
        prompt += `(Location-specific weather/flora/fauna omitted because the Setting Context just changed.)\n`;
    }
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
    const condEntries = options.settingRefresh ? [] : Object.entries(context.conditions);
    if (condEntries.length === 0 || condEntries.every(([, c]) => !c.content)) {
        prompt += options.settingRefresh
            ? `(old-setting World Conditions intentionally omitted — use the active Setting Context and season)\n`
            : `(no conditions set — use setting context and season to generate world events)\n`;
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

    // ── HIDDEN INTENTIONS (private agency pressure, not accomplished fact) ──
    if (!options.worldOnly && context.hiddenIntentions?.length > 0) {
        const direct = context.hiddenIntentions.filter(item => item.eventRole === 'direct').slice(0, 10);
        const background = context.hiddenIntentions.filter(item => item.eventRole === 'background').slice(0, 8);
        if (direct.length) {
            prompt += `=== EVENT-ELIGIBLE HIDDEN INTENTIONS ===\n`;
            prompt += `(Active Plans and Commitments may directly inspire NPC event proposals. A Contingency is direct only when its status is ready. These are not proof of action or success. Include sourceIntentionIds only when directly derived.)\n`;
            for (const item of direct) {
                prompt += `- ID ${item.id} | ${item.actor} | type=${item.type} | domain=${item.domain} | ${item.status}/${item.progressStage}\n`;
                prompt += `  Objective: ${item.objective || '(blank)'}\n`;
                if (item.strategy) prompt += `  Strategy: ${item.strategy}\n`;
                if (item.nextAction) prompt += `  Next action: ${item.nextAction}\n`;
                if (item.triggerConditions?.length) prompt += `  Trigger: ${item.triggerConditions.join('; ')}\n`;
                if (item.constraints?.length) prompt += `  Constraints: ${item.constraints.join('; ')}\n`;
            }
            prompt += '\n';
        }
        if (background.length) {
            prompt += `=== BACKGROUND NPC PRIORITIES (context only) ===\n`;
            prompt += `(Objectives, Ongoing Priorities, and untriggered Contingencies may shape plausibility, but should not become standalone events merely because they exist. Do not cite them in sourceIntentionIds.)\n`;
            for (const item of background) prompt += `- ${item.actor} | ${item.type}/${item.domain}: ${item.objective}\n`;
            prompt += '\n';
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
    // During a Setting Context refresh, active LLM-generated world events from
    // the old setting are candidates for replacement. Keep them stored until
    // replacement generation succeeds, but do not feed them back as context.
    const relevantActiveEvents = options.settingRefresh
        ? context.activeEvents.filter(event => !isReplaceableGeneratedWorldEvent(event))
        : context.activeEvents;
    if (relevantActiveEvents.length > 0) {
        prompt += `=== EXISTING ACTIVE EVENTS (DO NOT DUPLICATE) ===\n`;
        for (const event of relevantActiveEvents) {
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
    if (options.worldOnly) {
        prompt += `  0. SETTING REFRESH MODE: Generate WORLD / non-NPC events ONLY. Every returned event must use "isNPC": false. Do not propose character plans or NPC activity.\n`;
    }
    prompt += tier === 'persistent'
        ? `  1. PERSISTENT CAP: return at most 2 proposals in this call; NWST enforces 3 active Persistent events total.\n`
        : options.worldOnly
            ? `  1. CATEGORY CAP: max 2 WORLD events per tier. Do not return NPC events.\n`
            : `  1. CATEGORY CAPS: max 2 WORLD events, max 3 GENERATED NPC events per tier. Detected NPC events (explicitly stated) have no cap.\n`;
    prompt += tier === 'persistent'
        ? `  2. One strong Persistent proposal is better than two weak ones. Return [] if no durable pressure qualifies.\n`
        : options.worldOnly
            ? `  2. At minimum 1 WORLD EVENT where plausible; zero NPC events.\n`
            : `  2. At minimum 1 WORLD EVENT and 1 NPC EVENT (where plausible)\n`;
    prompt += `  3. World events should feel like organic world rhythms, not extractions from chat text\n`;
    prompt += `  4. Consider: seasonal festivals, cultural practices, environmental shifts, political rhythms\n`;
    prompt += tier === 'persistent'
        ? `  5. Persistent events NEVER use scheduledDate; their lifetime is controlled only by resolutionCondition.\n`
        : `  5. scheduledDate — Use the cyclical calendar day shown above as reference. Events with clear timing MUST include the actual target "Day #" within the configured year or a configured month/date. Wrap across New Year; never output arithmetic placeholders. Omit for vague/uncertain timing.\n`;
    prompt += `  6. PARTICIPANTS ARE REQUIRED DATA: every event must include participants. NPC events require at least one named participant. Non-NPC meetings, reviews, inspections, assignments, visits, and obligations must include their direct named actors. Use [] only for truly ambient world events.\n`;
    prompt += `  7. Forward-facing only. Respond with valid JSON array only.\n`;
    prompt += `  8. CRITICAL — USER CHARACTER BOUNDARY: NEVER create events about the USER CHARACTER's personal or mundane actions (getting coffee, leaving their desk, daily routines, etc.) unless the story narrative explicitly establishes them as plot-relevant. Events must describe what the WORLD and NPCs are doing, what natural/societal forces are unfolding, and what plot hooks exist — NOT what the user character will do.\n`;

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

/** @param {object} event @returns {boolean} */
function isReplaceableGeneratedWorldEvent(event) {
    const active = event?.status === 'pending' || event?.status === 'inprogress';
    const specialDay = Boolean(event?.sourceSpecialDayId) || event?.origin === 'special_day';
    return active && event?.isNPC === false && event?.origin === 'generated' && !specialDay;
}

/**
 * Filter generated events against notebook facts and active events.
 * The LLM does the heavy lifting; this is a safety net for obvious duplicates.
 * @param {string} chatId
 * @param {object[]} candidateEvents
 * @param {object} [options]
 * @returns {object[]} Events that pass the check
 */
function runPlausibilityCheck(chatId, candidateEvents, options = {}) {
    const activeEvents = getTrackedEvents(chatId);
    const duplicateReferenceEvents = options.settingRefresh
        ? activeEvents.filter(event => !isReplaceableGeneratedWorldEvent(event))
        : activeEvents;

    return filterForwardNovelEvents(candidateEvents, duplicateReferenceEvents, {
        currentDay: getCurrentDay(chatId),
        calendarConfig: getCalendarConfig(chatId),
        onReject: (event, reason) => {
            if (reason === 'duplicate') dlog(`[NWST EventGen] Discarded duplicate/near-duplicate: "${event?.title || '(untitled)'}"`);
            else if (reason === 'past_schedule') dlog(`[NWST EventGen] Discarded generated event scheduled behind Current Day: "${event?.title || '(untitled)'}"`);
            else if (reason === 'retrospective') dlog(`[NWST EventGen] Discarded retrospective event (belongs in Notebook/history): "${event?.title || '(untitled)'}"`);
        }
    });
}
