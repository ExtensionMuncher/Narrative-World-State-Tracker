/* eslint-disable */
// =============================================================================
// NWST Current Day Synthesis — llm/currentDaySynth.js
// =============================================================================
// Called after Day Advancement completes. Uses the Planning LLM to rewrite
// the Current Day narrative block using the updated forecast, active events,
// and world conditions.
//
// This transforms raw date/weather data into an atmospheric, narrative block.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import {
    getCurrentDay, updateCurrentDay, getForecast, getMoonPhases,
    getEnabledConditions, getSettingContext, getCalendarConfig
} from '../data/worldState.js';
import { getActiveEvents } from '../data/events.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { LLM_TOKEN_BUDGETS } from './tokenBudgets.js';
import { getComputedSeason } from './dayAdvancement.js';
import { dlog } from "../lib/debug.js";

// ── Internal prompt (NOT user-editable) ───────────────────────────────────

const CURRENT_DAY_SYNTH_PROMPT = `You are a narrative atmosphere writer for an ongoing roleplay. Your job is to write the "Current Day" block — an evocative, sensory description of the world as it exists right now.

WHAT THE CURRENT DAY BLOCK IS:
A description of the ambient world — the season, the weather, the natural environment, and the metaphysical climate. It is injected into the main AI's prompt on every message as stable background context.

WHAT THE CURRENT DAY BLOCK IS NOT:
- A summary of recent events
- A description of what characters are doing or where they are
- A mention of specific named characters
- A scene description or narrative recap

CRITICAL RULE — NO CHARACTERS:
Do NOT mention any named characters. Do NOT describe character actions, feelings, states, or presence. Do NOT reference what happened in the story. The Current Day block describes the WORLD, not the people in it. Characters are alive and moving — their states change message to message. The Current Day block is static ambient context. Any character reference will contaminate the main AI's generations by anchoring it to a past moment.

WRONG (character contamination):
"A failed ward has left the room charged with an uneasy magical pressure."
"The shrine is quiet — the character is expected to arrive before sundown."

RIGHT (world-only):
"The air in the building carries an unusual charge — a faint acidity beneath the smell of old wood and chalk dust, the kind of atmospheric disturbance that practitioners learn to recognize without naming."
"The shrine road is quiet in the way that sacred spaces sometimes are before dusk — held breath, waiting."

WHAT TO WRITE:
Write these sections using the format exactly as shown. Keep each to 1-3 sentences. Write with sensory specificity — what can be seen, smelled, felt, heard. Ground every detail in the setting context and season provided.

**Season** — The current season with atmospheric and sensory detail. What does this time of year feel like in this specific setting?
**Weather today** — Today's specific weather, written as a physical experience. Not just "raining" but what the rain does to the air, the light, the ground.
**Flora** — What is growing, blooming, wilting, or transforming in the natural world right now. Make it specific to the season and setting.
**Fauna** — What animal life is present, active, quiet, or notable. What does their behavior signal about the current conditions?
**Spiritual Climate** — (ONLY include this section if Spiritual/Supernatural conditions are enabled) The metaphysical texture of the current moment — what the spiritually sensitive would perceive, without naming any character as perceiving it.

STYLE GUIDANCE:
- Write like a perceptive narrator who notices the world, not a journalist who records events
- Use specific, concrete sensory details over vague atmospheric adjectives
- Let the world carry subtext — autumn doesn't just mean "leaves falling," it means something about transience, preparation, the approach of cold
- Aim for 1-3 sentences per section, dense and evocative rather than long and descriptive`;

// ── Synthesize Current Day ────────────────────────────────────────────────

/**
 * Synthesize the Current Day narrative block using the Planning LLM.
 * Called after day advancement or when the user regens the Current Day block.
 *
 * @param {string} chatId - The current chat ID
 * @param {object} [profileOverride] - Optional profile override
 * @returns {Promise<boolean>} True on success
 */
export async function synthesizeCurrentDay(chatId, profileOverride) {
    if (!chatId) chatId = getChatId();
    if (!chatId) return false;

    const currentDayBlock = document.getElementById('nwst-currentday-view');
    if (currentDayBlock) currentDayBlock.classList.add('nwst-loading');

    try {
        const profile = profileOverride || resolveProfile('planningLLM');
        if (!profile) throw new Error('No Planning LLM connection profile configured.');

        const currentDay = getCurrentDay(chatId);
        const forecast = getForecast(chatId);
        const todayForecast = forecast.length > 0 ? forecast[0] : null;
        const conditions = getEnabledConditions(chatId);
        const activeEvents = getActiveEvents(chatId);
        const settingContext = getSettingContext(chatId);
        const todayEvents = activeEvents.filter(e => e.tier === 'immediate');

        // Compute the system-determined season for this dayCount so the
        // synthesis LLM writes evocative prose *about* the correct season.
        const computedSeason = getComputedSeason(chatId);

        const userPrompt = buildSynthesisPrompt(currentDay, todayForecast, conditions, todayEvents, settingContext, computedSeason);

        const messages = [
            { role: 'system', content: CURRENT_DAY_SYNTH_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, messages, { maxTokens: LLM_TOKEN_BUDGETS.MEDIUM });
        const parsed = parseSynthesisResponse(response);

        if (!parsed) throw new Error('Failed to parse Current Day synthesis response.');

        // When the seasonal engine is active, the computed season OVERRIDES
        // whatever the LLM wrote — the engine is the authority.
        const finalSeason = computedSeason !== null ? computedSeason : (parsed.season || currentDay.season);

        await updateCurrentDay(chatId, {
            season:          finalSeason,
            weatherToday:    parsed.weatherToday    || currentDay.weatherToday,
            flora:           parsed.flora           || currentDay.flora,
            fauna:           parsed.fauna           || currentDay.fauna,
            spiritualClimate: parsed.spiritualClimate || currentDay.spiritualClimate
        });

        dlog('[NWST CurrentDaySynth] Current Day block updated.');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
        return true;

    } catch (err) {
        console.error('[NWST CurrentDaySynth] Synthesis failed:', err);
        nwstToast(`Current Day update failed: ${err.message}`, 'error');
        return false;
    } finally {
        if (currentDayBlock) currentDayBlock.classList.remove('nwst-loading');
    }
}

// ── Prompt building ───────────────────────────────────────────────────────

function buildSynthesisPrompt(currentDay, todayForecast, conditions, todayEvents, settingContext, computedSeason) {
    let prompt = '';

    // Setting context goes FIRST so the LLM grounds itself in the world before
    // reading weather data — prevents generic descriptions divorced from the setting
    if (settingContext) {
        prompt += `=== SETTING CONTEXT (read this first — ground all descriptions in this world) ===\n${settingContext}\n\n`;
    }

    // Inject calendar config (months + week days) if configured
    const calConfig = getCalendarConfig(getChatId());
    if (calConfig.enabled) {
        const monthList = calConfig.monthNames.map((name, i) =>
            `${name} (${calConfig.monthDays[i]} days)`
        ).join(', ');
        const dayList = calConfig.weekDays.join(', ');
        prompt += `=== CALENDAR SYSTEM ===\n  Months (${calConfig.months} total): ${monthList}\n  Days of the week (${calConfig.weekDays.length} total): ${dayList}\n  Use these month and day names when writing date or seasonal descriptions.\n\n`;
    }

    prompt += `=== CURRENT DATE ===\n`;
    prompt += `Date: ${currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Season: ${currentDay.season || '(not set)'}\n`;
    if (computedSeason) {
        prompt += `System-computed current season: ${computedSeason}\n`;
    }
    prompt += '\n';

    if (todayForecast) {
        prompt += `=== TODAY'S WEATHER DATA ===\n`;
        prompt += `Conditions: ${todayForecast.description || ''}\n`;
        prompt += `High: ${todayForecast.highF}°F / ${todayForecast.highC}°C\n`;
        prompt += `Low: ${todayForecast.lowF}°F / ${todayForecast.lowC}°C\n`;
        prompt += `Precipitation: ${todayForecast.precipChance}%\n\n`;
    }

    // World conditions inform the atmosphere — include them for context
    const condEntries = Object.entries(conditions).filter(([, c]) => c.content);
    if (condEntries.length > 0) {
        prompt += `=== WORLD CONDITIONS (for atmospheric context only — do not summarize these) ===\n`;
        for (const [name, cond] of condEntries) {
            prompt += `${name.toUpperCase()}: ${cond.content}\n`;
        }
        prompt += '\n';
    }

    // Today's events — only mention if happening today, and ONLY as world-level
    // context (e.g. a festival means more foot traffic, not that a character attends)
    if (todayEvents.length > 0) {
        prompt += `=== EVENTS HAPPENING TODAY (world-level context only — do not reference character actions or attendance) ===\n`;
        for (const ev of todayEvents) {
            if (!ev.isNPC) {
                // Only mention non-NPC world events — NPC events are character-specific
                prompt += `- ${ev.title}: ${ev.description}\n`;
            }
        }
        prompt += '\n';
    }

    // Spiritual enabled check
    const spiritualEnabled = conditions.spiritual !== undefined;
    if (!spiritualEnabled) {
        prompt += `NOTE: Spiritual/Supernatural condition is DISABLED. Do NOT include a "Spiritual Climate" section.\n\n`;
    }

    prompt += `Write the Current Day block now. Describe the world's ambient texture — season, weather, environment, metaphysical climate. Faction names are fine when they define world texture. Individual character actions and personal states should not appear. No story event recaps.`;

    return prompt;
}

// ── Response parsing ──────────────────────────────────────────────────────

function parseSynthesisResponse(response) {
    if (!response || typeof response !== 'string') return null;

    const text = response.trim();
    const result = {};

    // Primary: parse **Label** — value markdown format
    const patterns = [
        { regex: /\*\*Season\*\*\s*[—–-]\s*(.+?)(?=\n\*\*|\n*$)/is,           key: 'season' },
        { regex: /\*\*Weather today\*\*\s*[—–-]\s*(.+?)(?=\n\*\*|\n*$)/is,     key: 'weatherToday' },
        { regex: /\*\*Flora\*\*\s*[—–-]\s*(.+?)(?=\n\*\*|\n*$)/is,             key: 'flora' },
        { regex: /\*\*Fauna\*\*\s*[—–-]\s*(.+?)(?=\n\*\*|\n*$)/is,             key: 'fauna' },
        { regex: /\*\*Spiritual Climate\*\*\s*[—–-]\s*(.+?)(?=\n\*\*|\n*$)/is, key: 'spiritualClimate' }
    ];

    for (const { regex, key } of patterns) {
        const match = text.match(regex);
        if (match) result[key] = match[1].trim();
    }

    // Fallback: "Label: value" format
    if (!result.season) {
        for (const line of text.split('\n')) {
            const colonMatch = line.match(/^[-*]?\s*(Season|Weather today|Flora|Fauna|Spiritual Climate)\s*:\s*(.+)/i);
            if (colonMatch) {
                const label = colonMatch[1].toLowerCase().replace(' ', '');
                const value = colonMatch[2].trim();
                if (label === 'season') result.season = value;
                else if (label === 'weathertoday') result.weatherToday = value;
                else if (label === 'flora') result.flora = value;
                else if (label === 'fauna') result.fauna = value;
                else if (label === 'spiritualclimate') result.spiritualClimate = value;
            }
        }
    }

    if (result.season || result.weatherToday) return result;

    // JSON fallback: many instruction-tuned models (gemma, etc.) output JSON
    // with keys like {"season": "...", "weatherToday": "...", etc.}
    try {
        let jsonStr = text;
        // Strip markdown fences
        const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();
        // Find outermost JSON object
        const objMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (objMatch) {
            const parsed = JSON.parse(objMatch[0]);
            const jsonResult = {};
            const fieldMap = {
                season: 'season',
                weatherToday: 'weatherToday',
                weather_today: 'weatherToday',
                flora: 'flora',
                fauna: 'fauna',
                spiritualClimate: 'spiritualClimate',
                spiritual_climate: 'spiritualClimate'
            };
            for (const [jsonKey, resultKey] of Object.entries(fieldMap)) {
                if (parsed[jsonKey] && typeof parsed[jsonKey] === 'string') {
                    jsonResult[resultKey] = parsed[jsonKey].trim();
                }
            }
            if (jsonResult.season || jsonResult.weatherToday) {
                dlog('[NWST CurrentDaySynth] Parsed JSON response successfully.');
                return jsonResult;
            }
        }
    } catch (e) {
        // JSON parsing failed — fall through to raw text fallback
        console.debug('[NWST CurrentDaySynth] JSON fallback parse failed:', e.message);
    }

    // Last resort: use full response as weatherToday
    console.warn('[NWST CurrentDaySynth] Could not parse structured response — using raw text.');
    return { weatherToday: text };
}
