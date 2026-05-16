/* eslint-disable */
// =============================================================================
// NWST Day Advancement LLM — llm/dayAdvancement.js
// =============================================================================
// Handles the "Next Day" process:
//   1. Calls Day Advancement LLM with current date + setting context + forecast + moon phase
//   2. Receives updated date strings, new 7-day forecast, updated 7-day moon phases
//   3. Saves results to storage
//   4. Then triggers currentDaySynth.js to rewrite the Current Day narrative block
//   5. Rolls event horizon forward
//   6. Saves a per-day snapshot for Previous Day restoration
//
// Previous Day: NO API calls — restores saved snapshot exactly.
// =============================================================================

import { getChatId, nwstToast } from '../index.js';
import { getSettingContext, getCurrentDay, replaceCurrentDay, updateCurrentDay,
         getForecast, replaceForecast, getMoonPhases, replaceMoonPhases,
         saveSnapshot, getLatestSnapshot, getWorldState } from '../data/worldState.js';
import { getAllEvents, saveAllEvents, getActiveEvents, rollEventHorizon } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { resolveProfile } from './connections.js';
import { getPlannerPrompt, getScanFrequency } from '../settings.js';

// ── ST API imports (used by generateRaw) ──────────────────────────────────
// Note: generateRaw and related utilities are imported at call time to avoid
// circular dependency issues with index.js.
async function getSTAPI() {
    const scriptJS = await import('../../../../../script.js');
    const extJS = await import('../../../../extensions.js');
    return {
        generateRaw: scriptJS.generateRaw,
        getContext: scriptJS.getContext,
        extension_prompt_roles: scriptJS.extension_prompt_roles,
        extension_prompt_types: scriptJS.extension_prompt_types
    };
}

// ── Internal prompts (NOT user-editable) ──────────────────────────────────

const DAY_ADVANCEMENT_SYSTEM_PROMPT = `You are a day advancement assistant for a narrative roleplay. Your job is to advance the in-game date by ONE day and generate updated weather and moon phase forecasts.

You will receive:
- The current date display and sub-date
- The setting context (world climate/geography description)
- The current 7-day forecast
- The current 7-day moon phase positions

Respond with a JSON object containing:
{
  "dateDisplay": "the new date display string (advance by one day)",
  "dateSub": "the sub-date string (era/year, unchanged unless a year boundary is crossed)",
  "season": "the current season (update if the day advancement crosses a seasonal boundary)",
  "forecast": [
    {
      "label": "Today",
      "icon": "emoji for weather",
      "description": "short weather description",
      "highF": number,
      "lowF": number,
      "highC": number,
      "lowC": number,
      "precipChance": number (0-100)
    },
    ... 7 entries total, shifted forward by one day
  ],
  "moonPhases": [
    {
      "label": "Today",
      "icon": "emoji for moon phase",
      "phaseName": "name of moon phase"
    },
    ... 7 entries total, shifted forward by one day
  ]
}

IMPORTANT: Write the date display and weather with atmospheric, narrative-appropriate detail. The forecast must be grounded in the setting context provided.`;

// ── Next Day ──────────────────────────────────────────────────────────────

/**
 * Advance the world by one day.
 * Calls Day Advancement LLM → saves results → triggers Current Day synthesis.
 *
 * @returns {Promise<boolean>} True on success, false on failure
 */
export async function advanceToNextDay() {
    const chatId = getChatId();
    if (!chatId) {
        nwstToast('No active chat detected.', 'error');
        return false;
    }

    // Show loading indicators
    showLoading(true);
    nwstToast('Generating forecast and moon phases...', 'info');

    try {
        // 1. Resolve the Day Advancement LLM profile
        const profile = resolveProfile('dayAdvancementLLM');
        if (!profile) {
            throw new Error('No Day Advancement LLM connection profile configured. Set one in Settings.');
        }

        // 2. Gather current data
        const currentDay = getCurrentDay(chatId);
        const settingContext = getSettingContext(chatId);
        const currentForecast = getForecast(chatId);
        const currentMoonPhases = getMoonPhases(chatId);

        // 3. Build the LLM prompt
        const userPrompt = buildDayAdvancementPrompt(currentDay, settingContext, currentForecast, currentMoonPhases);

        // 4. Call the Day Advancement LLM
        const response = await callLLM(profile, DAY_ADVANCEMENT_SYSTEM_PROMPT, userPrompt);

        // 5. Parse the JSON response
        const result = parseDayAdvancementResponse(response);
        if (!result) {
            throw new Error('Failed to parse Day Advancement LLM response.');
        }

        // 6. Save the results
        updateCurrentDay(chatId, {
            dateDisplay: result.dateDisplay,
            dateSub: result.dateSub,
            season: result.season
        });
        replaceForecast(chatId, result.forecast);
        replaceMoonPhases(chatId, result.moonPhases);

        nwstToast('Forecast and moon phases updated.', 'success');

        // 7. Trigger Current Day synthesis (via Planning LLM)
        nwstToast('Updating current day...', 'info');
        try {
            const { synthesizeCurrentDay } = await import('./currentDaySynth.js');
            await synthesizeCurrentDay(chatId, profile);
        } catch (synthErr) {
            console.warn('[NWST DayAdvancement] Current Day synthesis failed (non-fatal):', synthErr);
        }

        // 8. Roll event horizon forward (mark missed, adjust tiers)
        rollEventHorizonForward(chatId);

        // 9. Save a snapshot at this day boundary
        saveDayBoundarySnapshot(chatId);

        nwstToast('Day advanced successfully.', 'success');
        return true;

    } catch (err) {
        console.error('[NWST DayAdvancement] Failed:', err);
        nwstToast(`Day advancement failed: ${err.message}`, 'error');
        return false;
    } finally {
        showLoading(false);
    }
}

// ── Previous Day ──────────────────────────────────────────────────────────

/**
 * Restore the previous day's state from the most recent snapshot.
 * NO API calls are made — this is a pure data restoration.
 *
 * @returns {Promise<boolean>} True on success
 */
export async function restorePreviousDay() {
    const chatId = getChatId();
    if (!chatId) {
        nwstToast('No active chat detected.', 'error');
        return false;
    }

    const snapshot = getLatestSnapshot(chatId);
    if (!snapshot) {
        nwstToast('No previous day snapshot found. Nothing to restore.', 'warning');
        return false;
    }

    try {
        // Restore world state
        if (snapshot.worldStateSnapshot) {
            const wsModule = await import('../data/worldState.js');
            wsModule.saveWorldState(chatId, snapshot.worldStateSnapshot);
        }

        // Restore events
        if (snapshot.eventsSnapshot) {
            saveAllEvents(chatId, snapshot.eventsSnapshot);
        }

        // Restore notebook
        if (snapshot.notebookSnapshot) {
            const nbModule = await import('../data/notebook.js');
            nbModule.saveNotebook(chatId, snapshot.notebookSnapshot);
        }

        nwstToast('Previous day restored from snapshot.', 'info');
        return true;
    } catch (err) {
        console.error('[NWST DayAdvancement] Previous day restore failed:', err);
        nwstToast('Failed to restore previous day.', 'error');
        return false;
    }
}

// ── Prompt building ───────────────────────────────────────────────────────

function buildDayAdvancementPrompt(currentDay, settingContext, forecast, moonPhases) {
    let prompt = '';

    prompt += `Current Date Display: ${currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Sub-Date: ${currentDay.dateSub || '(not set)'}\n`;
    prompt += `Current Season: ${currentDay.season || '(not set)'}\n\n`;

    if (settingContext) {
        prompt += `Setting Context (world climate/geography):\n${settingContext}\n\n`;
    }

    prompt += `Current 7-Day Forecast:\n`;
    if (forecast.length > 0) {
        for (const day of forecast) {
            prompt += `  ${day.label}: ${day.description || ''} | High: ${day.highF}°F / ${day.highC}°C | Low: ${day.lowF}°F / ${day.lowC}°C | Precip: ${day.precipChance}% | Icon: ${day.icon}\n`;
        }
    } else {
        prompt += `  (no forecast data)\n`;
    }

    prompt += `\nCurrent Moon Phases:\n`;
    if (moonPhases.length > 0) {
        for (const moon of moonPhases) {
            prompt += `  ${moon.label}: ${moon.phaseName} ${moon.icon}\n`;
        }
    } else {
        prompt += `  (no moon phase data)\n`;
    }

    prompt += `\nAdvance the date by ONE day and generate the updated forecast and moon phases. Respond with valid JSON only.`;

    return prompt;
}

// ── LLM call ──────────────────────────────────────────────────────────────

async function callLLM(profile, systemPrompt, userPrompt) {
    const { generateRaw, getContext, extension_prompt_roles } = await getSTAPI();

    // Build a minimal message array for the LLM call
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];

    // Use ST's generateRaw to call the LLM
    // This uses the connection profile's API, preset, and settings
    const result = await generateRaw(
        messages,
        null,           // No preset override — use profile's preset
        profile.id,     // Use the specified connection profile
        null,           // No image
        false,          // Not quiet
        false           // No quiet toasts
    );

    return result || '';
}

// ── Response parsing ──────────────────────────────────────────────────────

function parseDayAdvancementResponse(response) {
    if (!response || typeof response !== 'string') return null;

    // Try to extract JSON from the response (may be wrapped in markdown or text)
    let jsonStr = response.trim();

    // Remove markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
    }

    // Try to find a JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
        jsonStr = objMatch[0];
    }

    try {
        const parsed = JSON.parse(jsonStr);

        // Validate required fields
        if (!parsed.dateDisplay) {
            console.warn('[NWST DayAdvancement] Response missing dateDisplay');
            return null;
        }

        return {
            dateDisplay: parsed.dateDisplay,
            dateSub: parsed.dateSub || '',
            season: parsed.season || '',
            forecast: Array.isArray(parsed.forecast) ? parsed.forecast.slice(0, 7) : [],
            moonPhases: Array.isArray(parsed.moonPhases) ? parsed.moonPhases.slice(0, 7) : []
        };
    } catch (e) {
        console.error('[NWST DayAdvancement] JSON parse error:', e);
        console.log('Raw response:', response);
        return null;
    }
}

// ── Event horizon roll ────────────────────────────────────────────────────

function rollEventHorizonForward(chatId) {
    // Mark immediate past-due events as missed, shift other tiers as needed
    // This is a structural roll — the Planning LLM may override during next scan
    const events = getAllEvents(chatId);
    const changes = {};

    for (const event of events) {
        if (event.tier === 'immediate' && event.status === 'pending') {
            // Move pending immediate events to missed (they didn't happen today)
            changes[event.id] = 'missed';
        }
        // Future: The Planning LLM handles more nuanced tier shifting during scan
    }

    if (Object.keys(changes).length > 0) {
        rollEventHorizon(chatId, changes);
    }
}

// ── Snapshot ──────────────────────────────────────────────────────────────

function saveDayBoundarySnapshot(chatId) {
    try {
        const worldState = getWorldState(chatId);
        const events = getAllEvents(chatId);
        const notebook = getNotebook(chatId);

        // Use a simple timestamp-based key for day boundary snapshots
        const rangeKey = `day_${Date.now()}`;
        saveSnapshot(chatId, rangeKey, worldState, events, notebook);
        console.log('[NWST DayAdvancement] Day boundary snapshot saved.');
    } catch (e) {
        console.warn('[NWST DayAdvancement] Failed to save snapshot:', e);
    }
}

// ── Loading UI helpers ────────────────────────────────────────────────────

function showLoading(show) {
    // Update forecast and moon phase strips with spinner
    const forecastStrip = document.getElementById('nwst-forecast-strip');
    const moonStrip = document.getElementById('nwst-moon-strip');

    if (show) {
        if (forecastStrip) forecastStrip.classList.add('nwst-loading');
        if (moonStrip) moonStrip.classList.add('nwst-loading');
    } else {
        if (forecastStrip) forecastStrip.classList.remove('nwst-loading');
        if (moonStrip) moonStrip.classList.remove('nwst-loading');
    }
}
