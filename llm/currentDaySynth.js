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

import { getChatId, nwstToast } from '../index.js';
import {
    getCurrentDay, updateCurrentDay, getForecast, getMoonPhases,
    getEnabledConditions, getSettingContext
} from '../data/worldState.js';
import { getActiveEvents } from '../data/events.js';
import { getPlannerPrompt } from '../settings.js';
import { resolveProfile, generateWithProfile } from './connections.js';

// ── Internal prompt (NOT user-editable) ───────────────────────────────────

const CURRENT_DAY_SYNTH_PROMPT = `You are a narrative world state writer for an ongoing roleplay. Your job is to write the "Current Day" block — a concise, atmospheric description of the present moment in the game world.

You will receive:
- The current date
- Today's weather forecast
- Active world conditions (political, social, spiritual/supernatural, environmental)
- Any active events happening today
- The current season and setting context

Write a Current Day block with these sections. Use a bullet-point format with strong labels:

**Season** — the current season with atmospheric detail
**Weather today** — today's specific weather, written narratively
**Flora** — what's blooming, growing, or changing in the natural world
**Fauna** — animal activity and presence
**Spiritual Climate** — (include ONLY if the Spiritual/Supernatural condition is enabled) the metaphysical atmosphere

Rules:
- Write with atmospheric, narrative detail. This is a living document, not a spreadsheet.
- Keep each section to 1-2 sentences.
- Ground everything in the setting context and world conditions provided.
- Do not invent events. Reference active events only if they're happening today.
- The Spiritual Climate section must be omitted entirely if spiritual conditions are disabled.`;

// ── Synthesize Current Day ────────────────────────────────────────────────

/**
 * Synthesize the Current Day narrative block using the Planning LLM.
 * Called after day advancement or when the user clicks regen on the Current Day.
 *
 * @param {string} chatId - The current chat ID
 * @param {object} [profileOverride] - Optional profile to use (passed from dayAdvancement.js)
 * @returns {Promise<boolean>} True on success
 */
export async function synthesizeCurrentDay(chatId, profileOverride) {
    if (!chatId) chatId = getChatId();
    if (!chatId) return false;

    // Show loading on the Current Day block
    const currentDayBlock = document.getElementById('nwst-currentday-view');
    if (currentDayBlock) currentDayBlock.classList.add('nwst-loading');

    try {
        // Resolve the Planning LLM profile
        const profile = profileOverride || resolveProfile('planningLLM');
        if (!profile) {
            throw new Error('No Planning LLM connection profile configured.');
        }

        // Gather context
        const currentDay = getCurrentDay(chatId);
        const forecast = getForecast(chatId);
        const todayForecast = forecast.length > 0 ? forecast[0] : null;
        const conditions = getEnabledConditions(chatId);
        const activeEvents = getActiveEvents(chatId);
        const settingContext = getSettingContext(chatId);
        const todayEvents = activeEvents.filter(e => e.tier === 'immediate');

        // Build the prompt
        const userPrompt = buildSynthesisPrompt(currentDay, todayForecast, conditions, todayEvents, settingContext);

        // Call the Planning LLM
        const response = await callPlanningLLM(profile, CURRENT_DAY_SYNTH_PROMPT, userPrompt);

        // Parse the response into Current Day fields
        const parsed = parseSynthesisResponse(response);
        if (!parsed) {
            throw new Error('Failed to parse Current Day synthesis response.');
        }

        // Update the Current Day block
        updateCurrentDay(chatId, {
            season: parsed.season || currentDay.season,
            weatherToday: parsed.weatherToday || currentDay.weatherToday,
            flora: parsed.flora || currentDay.flora,
            fauna: parsed.fauna || currentDay.fauna,
            spiritualClimate: parsed.spiritualClimate || currentDay.spiritualClimate
        });

        console.log('[NWST CurrentDaySynth] Current Day block updated successfully.');
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

function buildSynthesisPrompt(currentDay, todayForecast, conditions, todayEvents, settingContext) {
    let prompt = '';

    prompt += `Current Date: ${currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Season: ${currentDay.season || '(not set)'}\n\n`;

    if (todayForecast) {
        prompt += `Today's Weather Forecast:\n`;
        prompt += `  Description: ${todayForecast.description || ''}\n`;
        prompt += `  High: ${todayForecast.highF}°F / ${todayForecast.highC}°C\n`;
        prompt += `  Low: ${todayForecast.lowF}°F / ${todayForecast.lowC}°C\n`;
        prompt += `  Precipitation chance: ${todayForecast.precipChance}%\n\n`;
    }

    if (settingContext) {
        prompt += `Setting Context (world description):\n${settingContext}\n\n`;
    }

    if (Object.keys(conditions).length > 0) {
        prompt += `Active World Conditions:\n`;
        for (const [name, condition] of Object.entries(conditions)) {
            if (condition.content) {
                prompt += `  ${name.toUpperCase()}: ${condition.content}\n`;
            }
        }
        prompt += '\n';
    }

    if (todayEvents.length > 0) {
        prompt += `Active Events Today:\n`;
        for (const event of todayEvents) {
            prompt += `  - ${event.title}: ${event.description}\n`;
        }
        prompt += '\n';
    }

    // Check if spiritual condition is enabled
    const spiritualEnabled = conditions.spiritual?.enabled !== false;
    if (!spiritualEnabled) {
        prompt += `NOTE: The Spiritual/Supernatural condition is DISABLED. Do NOT include a "Spiritual Climate" section.\n\n`;
    }

    prompt += `Please write the Current Day block now.`;

    return prompt;
}

// ── LLM call ──────────────────────────────────────────────────────────────

async function callPlanningLLM(profile, systemPrompt, userPrompt) {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];

    const result = await generateWithProfile(profile, messages);

    return result || '';
}

// ── Response parsing ──────────────────────────────────────────────────────

function parseSynthesisResponse(response) {
    if (!response || typeof response !== 'string') return null;

    const text = response.trim();
    const result = {};

    // Parse markdown-style bullet sections
    // Looking for patterns like:
    // **Season** — Late Autumn
    // **Weather today** — Overcast with light rain
    // **Flora** — Chrysanthemums blooming
    // **Fauna** — Crickets quieting
    // **Spiritual Climate** — The veil thins

    const patterns = [
        { regex: /\*\*Season\*\*\s*[—–-]\s*(.+?)(?=\n\*\*|\n*$)/is, key: 'season' },
        { regex: /\*\*Weather today\*\*\s*[—–-]\s*(.+?)(?=\n\*\*|\n*$)/is, key: 'weatherToday' },
        { regex: /\*\*Flora\*\*\s*[—–-]\s*(.+?)(?=\n\*\*|\n*$)/is, key: 'flora' },
        { regex: /\*\*Fauna\*\*\s*[—–-]\s*(.+?)(?=\n\*\*|\n*$)/is, key: 'fauna' },
        { regex: /\*\*Spiritual Climate\*\*\s*[—–-]\s*(.+?)(?=\n\*\*|\n*$)/is, key: 'spiritualClimate' }
    ];

    for (const { regex, key } of patterns) {
        const match = text.match(regex);
        if (match) {
            result[key] = match[1].trim();
        }
    }

    // Fallback: try "Label: value" format
    if (!result.season) {
        const lines = text.split('\n');
        for (const line of lines) {
            const colonMatch = line.match(/^(Season|Weather today|Flora|Fauna|Spiritual Climate)\s*:\s*(.+)/i);
            if (colonMatch) {
                const label = colonMatch[1].toLowerCase();
                const value = colonMatch[2].trim();
                if (label === 'season') result.season = value;
                else if (label === 'weather today') result.weatherToday = value;
                else if (label === 'flora') result.flora = value;
                else if (label === 'fauna') result.fauna = value;
                else if (label === 'spiritual climate') result.spiritualClimate = value;
            }
        }
    }

    // If we got at least season or weatherToday, consider it a success
    if (result.season || result.weatherToday) {
        return result;
    }

    // Last resort: use the entire response as weatherToday
    console.warn('[NWST CurrentDaySynth] Could not parse structured response — using raw text.');
    return { weatherToday: text };
}
