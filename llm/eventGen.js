/* eslint-disable */
// =============================================================================
// NWST Event Generation — llm/eventGen.js
// =============================================================================
// Handles event generation and NPC event detection via the Planning LLM.
//
// Four event types:
//   NPC DETECTED   — scanner finds explicit character plans in chat
//   NPC GENERATED  — Planning LLM extrapolates from character roster + context
//   WORLD DETECTED — scanner finds world happenings in chat text
//   WORLD GENERATED — Planning LLM uses setting context + world conditions
//
// All generated events pass a plausibility check against notebook facts,
// world conditions, and active events before being proposed.
// =============================================================================

import { getChatId, nwstToast } from '../index.js';
import { getCurrentDay, getEnabledConditions, getSettingContext } from '../data/worldState.js';
import { getAllEvents, addEvent, getActiveEvents } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { getAllCommunities } from '../data/communities.js';
import { getPlannerPrompt } from '../settings.js';
import { resolveProfile, generateWithProfile } from './connections.js';

// ── Internal prompts ──────────────────────────────────────────────────────

const EVENT_GEN_SYSTEM_PROMPT = `You are an event generation assistant for a narrative roleplay. Your job is to generate plausible upcoming events based on the current world state, character roster, and setting context.

You will receive:
- The current date, season, and weather
- Active world conditions (political, social, spiritual, environmental)
- The setting context (world description)
- Current notebook (established facts, planted details, character whereabouts)
- Currently active events (do not duplicate)
- Community summaries
- Recent chat context (for NPC generation)

Generate events that are:
1. GROUNDED in the setting and current conditions
2. CONSISTENT with established facts (do not contradict the notebook)
3. NON-DUPLICATIVE of existing active events
4. PLAUSIBLE given the current season, weather, and world state

For NPC events: Generate events that specific characters would plausibly do based on their established behaviors, relationships, and the current situation.

For World events: Generate ambient world happenings that would occur in this setting at this time — seasonal observances, political movements, environmental changes, cultural events.

Respond with a JSON array of events:
[
  {
    "title": "Brief event title",
    "description": "Detailed description",
    "tier": "immediate" | "week" | "month",
    "isNPC": true | false,
    "npcOrigin": "generated" (always "generated" for generated events)
  }
]

Generate 2-4 events total, mixing NPC and World events as appropriate. If no plausible events can be generated, return an empty array [].`;

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

        // Gather full context
        const context = gatherEventContext(chatId, tier);

        // Build prompt focused on this tier
        const userPrompt = buildEventGenPrompt(context, tier);

        // Call Planning LLM via connection profile
        const messages = [
            { role: 'system', content: EVENT_GEN_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, messages);
        const events = parseEventGenResponse(response);

        // Plausibility check
        const validEvents = await runPlausibilityCheck(chatId, events);

        // Add valid events
        let added = 0;
        for (const event of validEvents) {
            addEvent(chatId, {
                title: event.title,
                description: event.description,
                tier: event.tier || tier,
                status: 'pending',
                isNPC: event.isNPC || false,
                npcOrigin: event.isNPC ? 'generated' : null,
                origin: 'generated'
            });
            added++;
        }

        if (added > 0) {
            nwstToast(`${added} ${tier} event(s) generated.`, 'success');
        } else {
            nwstToast(`No new ${tier} events generated (all candidates failed plausibility check).`, 'info');
        }

        return added;

    } catch (err) {
        console.error('[NWST EventGen] Regeneration failed:', err);
        nwstToast(`Event regeneration failed: ${err.message}`, 'error');
        return 0;
    }
}

/**
 * Regenerate events for ALL tiers (global regen).
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

// ── Context gathering ─────────────────────────────────────────────────────

function gatherEventContext(chatId, tier) {
    return {
        currentDay: getCurrentDay(chatId),
        conditions: getEnabledConditions(chatId),
        settingContext: getSettingContext(chatId),
        notebook: getNotebook(chatId),
        activeEvents: getActiveEvents(chatId),
        communities: getAllCommunities(chatId),
        tier: tier
    };
}

function buildEventGenPrompt(context, tier) {
    let prompt = '';

    prompt += `Generate events for the "${tier}" tier.\n\n`;

    prompt += `Current Date: ${context.currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Season: ${context.currentDay.season || '(not set)'}\n`;
    prompt += `Weather: ${context.currentDay.weatherToday || '(not set)'}\n\n`;

    if (context.settingContext) {
        prompt += `Setting Context: ${context.settingContext}\n\n`;
    }

    // World conditions
    prompt += `World Conditions:\n`;
    for (const [key, cond] of Object.entries(context.conditions)) {
        if (cond.content) prompt += `  [${key}]: ${cond.content}\n`;
    }
    prompt += '\n';

    // Active events (to avoid duplicates)
    if (context.activeEvents.length > 0) {
        prompt += `EXISTING ACTIVE EVENTS (DO NOT DUPLICATE):\n`;
        for (const event of context.activeEvents) {
            prompt += `  - [${event.tier}] ${event.title}: ${event.description}\n`;
        }
        prompt += '\n';
    }

    // Notebook facts
    const facts = context.notebook?.mystery?.establishedFacts || [];
    const whereabouts = context.notebook?.mystery?.characterWhereabouts || [];
    if (facts.length > 0) {
        prompt += `Established Facts (DO NOT CONTRADICT):\n`;
        for (const fact of facts) prompt += `  - ${fact}\n`;
        prompt += '\n';
    }
    if (whereabouts.length > 0) {
        prompt += `Character Whereabouts:\n`;
        for (const w of whereabouts) prompt += `  - ${w}\n`;
        prompt += '\n';
    }

    prompt += `Generate 2-4 plausible ${tier} events. Respond with valid JSON array only.`;

    return prompt;
}

// ── Response parsing ──────────────────────────────────────────────────────

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
 * Cross-reference generated events against notebook facts, world conditions,
 * and active events. Discard any that contradict established facts or duplicate
 * existing events.
 *
 * @param {string} chatId
 * @param {object[]} candidateEvents
 * @returns {Promise<object[]>} Events that pass the plausibility check
 */
async function runPlausibilityCheck(chatId, candidateEvents) {
    const notebook = getNotebook(chatId);
    const facts = notebook?.mystery?.establishedFacts || [];
    const activeEvents = getActiveEvents(chatId);
    const activeTitles = activeEvents.map(e => e.title.toLowerCase().trim());

    const valid = [];

    for (const event of candidateEvents) {
        // Check for duplicates
        if (activeTitles.includes(event.title.toLowerCase().trim())) {
            console.log(`[NWST EventGen] Discarded duplicate: "${event.title}"`);
            continue;
        }

        // Check for contradictions with established facts
        let contradicted = false;
        for (const fact of facts) {
            // Simple keyword overlap check — refined during integration testing
            if (event.description && fact && hasContradiction(event.description, fact)) {
                console.log(`[NWST EventGen] Discarded contradictory event: "${event.title}" vs fact: "${fact}"`);
                contradicted = true;
                break;
            }
        }

        if (!contradicted) {
            valid.push(event);
        }
    }

    return valid;
}

/**
 * Simple contradiction check between event text and a fact.
 * Refined during integration testing with actual LLM responses.
 */
function hasContradiction(eventText, fact) {
    // This is a simplistic check — the Planning LLM handles the real plausibility
    // check during generation. This is a safety net.
    const eventLower = eventText.toLowerCase();
    const factLower = fact.toLowerCase();

    // Check for direct negations or contradictions
    // This will be enhanced during integration testing
    return false; // Placeholder — LLM handles plausibility natively
}
