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
    getCurrentDay, updateCurrentDay, getForecast,
    getEnabledConditions, getSettingContext, getCalendarConfig
} from '../data/worldState.js';
import { getActiveEvents } from '../data/events.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { LLM_TOKEN_BUDGETS } from './tokenBudgets.js';
import { getComputedSeason } from './dayAdvancement.js';
import { getSevereWeatherConstraint, getWeatherProfileForecastContext } from '../data/severeWeather.js';
import { dlog } from "../lib/debug.js";

// ── Internal prompt (NOT user-editable) ───────────────────────────────────

const CURRENT_DAY_SYNTH_PROMPT_BASE = `You are a narrative atmosphere writer for an ongoing roleplay. Your job is to write the "Current Day" block — an evocative, sensory description of the world as it exists right now.

WHAT THE CURRENT DAY BLOCK IS:
A description of the ambient world — the season, the weather, and the natural environment. It is injected into the main AI's prompt on every message as stable background context.

WHAT THE CURRENT DAY BLOCK IS NOT:
- A summary of recent events
- A description of what characters are doing or where they are
- A mention of specific named characters
- A scene description or narrative recap

CRITICAL RULE — NO CHARACTERS:
Do NOT mention any named characters. Do NOT describe character actions, feelings, states, or presence. Do NOT reference what happened in the story. The Current Day block describes the WORLD, not the people in it. Characters are alive and moving — their states change message to message. The Current Day block is static ambient context. Any character reference will contaminate the main AI's generations by anchoring it to a past moment.

WRONG (character contamination):
"A named character's arrival has left the station unusually tense."
"The shop is quiet because the protagonist is expected before sundown."

RIGHT (world-only):
"Cold rain needles the station awnings, and runoff gathers in the seams of the platform concrete."
"The shopping street has thinned toward dusk, shutters rattling in the wind while bicycle tires hiss over wet pavement."

WHAT TO WRITE:
Write these sections using the format exactly as shown. Keep each to 1-3 sentences. Write with sensory specificity — what can be seen, smelled, felt, heard. Ground every detail in the setting context and season provided.

**Season** — The current season with atmospheric and sensory detail. What does this time of year feel like in this specific setting?
**Weather today** — Today's specific weather, written as a physical experience. Not just "raining" but what the rain does to the air, the light, the ground.
**Flora** — What is growing, blooming, wilting, or transforming in the natural world right now. Make it specific to the season and setting.
**Fauna** — What animal life is present, active, quiet, or notable. What does their behavior signal about the current conditions?

STYLE GUIDANCE:
- Write like a perceptive narrator who notices the world, not a journalist who records events
- Use specific, concrete sensory details over vague atmospheric adjectives
- Let the world carry subtext — autumn doesn't just mean "leaves falling," it means something about transience, preparation, the approach of cold
- Aim for 1-3 sentences per section, dense and evocative rather than long and descriptive`;

const CURRENT_DAY_SPIRITUAL_INSTRUCTION = `
**Spiritual Climate** — The metaphysical texture of the current moment — what the spiritually sensitive would perceive, without naming any character as perceiving it.`;

export function buildCurrentDaySystemPrompt(spiritualEnabled) {
    return spiritualEnabled
        ? `${CURRENT_DAY_SYNTH_PROMPT_BASE}${CURRENT_DAY_SPIRITUAL_INSTRUCTION}`
        : CURRENT_DAY_SYNTH_PROMPT_BASE;
}

// ── Synthesize Current Day ────────────────────────────────────────────────

/**
 * Synthesize the Current Day narrative block using the Planning LLM.
 * Called after day advancement or when the user regens the Current Day block.
 *
 * @param {string} chatId - The current chat ID
 * @param {object} [profileOverride] - Optional profile override
 * @returns {Promise<boolean>} True on success
 */
export async function synthesizeCurrentDay(chatId, profileOverride, options = {}) {
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
        const conditions = options.ignoreConditions ? {} : getEnabledConditions(chatId);
        const spiritualEnabled = Object.prototype.hasOwnProperty.call(conditions, 'spiritual');
        const activeEvents = options.ignoreEvents ? [] : getActiveEvents(chatId);
        const settingContext = getSettingContext(chatId);
        const todayEvents = options.ignoreEvents ? [] : activeEvents.filter(e => e.tier === 'immediate');

        // Compute the system-determined season for this dayCount so the
        // synthesis LLM writes evocative prose *about* the correct season.
        const computedSeason = getComputedSeason(chatId);
        const weatherProfileContext = getWeatherProfileForecastContext(chatId);
        const weatherConstraint = getSevereWeatherConstraint(chatId, currentDay?.elapsedStoryDays || 0);

        const userPrompt = buildSynthesisPrompt(currentDay, todayForecast, conditions, todayEvents, settingContext, computedSeason, weatherProfileContext, weatherConstraint, spiritualEnabled);

        const messages = [
            { role: 'system', content: buildCurrentDaySystemPrompt(spiritualEnabled) },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, messages, { maxTokens: LLM_TOKEN_BUDGETS.MEDIUM });
        if (getChatId() !== chatId) {
            dlog('[NWST CurrentDaySynth] Active chat changed during synthesis; discarding stale result.');
            return false;
        }
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
            spiritualClimate: spiritualEnabled ? (parsed.spiritualClimate || currentDay.spiritualClimate) : ''
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

export function buildSynthesisPrompt(currentDay, todayForecast, conditions, todayEvents, settingContext, computedSeason, weatherProfileContext = '', weatherConstraint = '', spiritualEnabled = false) {
    let prompt = '';

    // Setting context goes FIRST so the LLM grounds itself in the world before
    // reading weather data — prevents generic descriptions divorced from the setting
    if (settingContext) {
        prompt += `=== SETTING CONTEXT (read this first — ground all descriptions in this world) ===\n${settingContext}\n\n`;
    }
    if (weatherProfileContext) {
        prompt += `${weatherProfileContext}\n\n`;
    }
    if (weatherConstraint) {
        prompt += `${weatherConstraint}\n\n`;
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
    prompt += `Stored Season: ${currentDay.season || '(not set)'}\n`;
    if (computedSeason) {
        prompt += `System-computed climatic season: ${computedSeason}\n`;
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

    if (spiritualEnabled) {
        prompt += `Write the Current Day block now. Describe the world's ambient texture — season, weather, environment, and metaphysical climate. Faction names are fine when they define world texture. Individual character actions and personal states should not appear. No story event recaps.`;
    } else {
        prompt += `Write the Current Day block now. Describe the world's ambient texture — season, weather, and environment. Faction names are fine when they define world texture. Individual character actions and personal states should not appear. No story event recaps.`;
    }

    return prompt;
}

// ── Response parsing ──────────────────────────────────────────────────────

export function parseSynthesisResponse(response) {
    if (!response || typeof response !== 'string') return null;

    const text = response.trim();
    if (!text) return null;

    const fieldMap = {
        season: 'season',
        weather: 'weatherToday',
        weathertoday: 'weatherToday',
        flora: 'flora',
        fauna: 'fauna',
        spiritualclimate: 'spiritualClimate'
    };

    const normalizeKey = (value) => fieldMap[String(value || '')
        .toLowerCase()
        .replace(/[^a-z]/g, '')] || null;

    const cleanValue = (value) => String(value ?? '')
        .replace(/^\s*(?:[:：]|[—–-])\s*/, '')
        .replace(/^\s*(?:\*\*|__)\s*/, '')
        .replace(/\s*(?:\*\*|__)\s*$/, '')
        .trim();

    // JSON first. Smaller instruction-tuned models frequently prefer JSON even
    // when the system prompt demonstrates markdown. Accept both the flat shape
    // and a harmless { currentDay: {...} } wrapper, but never treat arbitrary
    // raw output as one of the fields.
    try {
        let jsonStr = text;
        const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();
        const objMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (objMatch) {
            const parsed = JSON.parse(objMatch[0]);
            const source = (parsed?.currentDay && typeof parsed.currentDay === 'object')
                ? parsed.currentDay
                : (parsed?.current_day && typeof parsed.current_day === 'object')
                    ? parsed.current_day
                    : parsed;
            const jsonResult = {};
            for (const [rawKey, rawValue] of Object.entries(source || {})) {
                const key = normalizeKey(rawKey);
                if (!key || typeof rawValue !== 'string') continue;
                const value = cleanValue(rawValue);
                if (value) jsonResult[key] = value;
            }
            if (Object.keys(jsonResult).length > 0) {
                dlog('[NWST CurrentDaySynth] Parsed JSON response successfully.');
                return jsonResult;
            }
        }
    } catch (e) {
        dlog('[NWST CurrentDaySynth] JSON parse path did not match:', e.message);
    }

    // Flexible section parser. Handles the formats that commonly vary between
    // GLM/Gemma-class models, including:
    //   **Season** — value
    //   - **Season:** value
    //   ### Season\nvalue
    //   Weather today: value
    // and multiline prose continuations until the next recognized label.
    const result = {};
    let currentKey = null;
    let buffer = [];

    const flush = () => {
        if (!currentKey) return;
        const value = cleanValue(buffer.join('\n').trim());
        if (value) result[currentKey] = value;
        currentKey = null;
        buffer = [];
    };

    const labelPattern = /^\s*(?:[-*+]\s+)?(?:#{1,6}\s*)?(?:\*\*|__)?\s*(Season|Weather(?:\s+today)?|Flora|Fauna|Spiritual\s+Climate)\s*(?:(?:\*\*|__)\s*)?(?:(?:[:：]|[—–-])\s*)?(?:(?:\*\*|__)\s*)?(.*)$/i;

    const stripped = text
        .replace(/^```(?:markdown|md|text)?\s*/i, '')
        .replace(/\s*```$/, '');

    for (const rawLine of stripped.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        const match = line.match(labelPattern);
        if (match) {
            flush();
            currentKey = normalizeKey(match[1]);
            const inlineValue = cleanValue(match[2]);
            buffer = inlineValue ? [inlineValue] : [];
            continue;
        }

        if (currentKey) {
            // Preserve paragraph breaks inside a section, but ignore leading
            // blank lines before its prose starts.
            if (line.trim() || buffer.length > 0) buffer.push(line.trim());
        }
    }
    flush();

    if (Object.keys(result).length > 0) return result;

    // Fail closed. The previous implementation assigned the entire unparsed
    // response to weatherToday, so one formatting variation could embed every
    // Current Day section inside Weather and make repeated day advances look as
    // if the card were piling copies of itself. Keeping the prior fields is much
    // safer than corrupting a single field with a multi-section blob.
    console.warn('[NWST CurrentDaySynth] Could not parse a structured Current Day response; existing fields were preserved.');
    return null;
}
