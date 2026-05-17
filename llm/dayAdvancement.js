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

import { getChatId, nwstToast, getSetting } from '../index.js';
import { getSettingContext, getCurrentDay, replaceCurrentDay, updateCurrentDay,
         getForecast, replaceForecast, getMoonPhases, replaceMoonPhases,
         saveSnapshot, getLatestSnapshot, getWorldState } from '../data/worldState.js';
import { getAllEvents, saveAllEvents, getActiveEvents, rollEventHorizon } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { getPlannerPrompt, getScanFrequency } from '../settings.js';


// ── Moon phase calculation (programmatic — no LLM involvement) ────────────

/**
 * The 8 standard moon phases with their angle ranges and icons.
 * Phase angle is measured from New Moon (0°) through each octant.
 * @constant
 */
const MOON_PHASES = [
    { name: 'New Moon',        icon: '🌑', minAngle: 0,      maxAngle: 22.5 },
    { name: 'Waxing Crescent', icon: '🌒', minAngle: 22.5,   maxAngle: 67.5 },
    { name: 'First Quarter',   icon: '🌓', minAngle: 67.5,   maxAngle: 112.5 },
    { name: 'Waxing Gibbous',  icon: '🌔', minAngle: 112.5,  maxAngle: 157.5 },
    { name: 'Full Moon',       icon: '🌕', minAngle: 157.5,  maxAngle: 202.5 },
    { name: 'Waning Gibbous',  icon: '🌖', minAngle: 202.5,  maxAngle: 247.5 },
    { name: 'Last Quarter',    icon: '🌗', minAngle: 247.5,  maxAngle: 292.5 },
    { name: 'Waning Crescent', icon: '🌘', minAngle: 292.5,  maxAngle: 337.5 },
];

/**
 * Get the configured moon cycle length (degrees per day).
 * Reads from Settings so fantasy worlds can override the 29.53-day default.
 * @returns {number} Degrees of lunar progression per day
 */
export function getDegreesPerDay() {
    const cycleDays = getSetting('moonCycleDays') || 29.53058867;
    return 360 / cycleDays;
}

/**
 * Get the stored lunar angle for the current chat.
 * The lunar angle (0-360) represents the absolute position in the lunar cycle,
 * where 0 = New Moon. This is stored in currentDay.lunarAngle.
 * @param {string} chatId
 * @returns {number} Angle in degrees, defaults to 0 if not yet set
 */
export function getLunarAngle(chatId) {
    const day = getCurrentDay(chatId);
    if (day && typeof day.lunarAngle === 'number' && !isNaN(day.lunarAngle)) {
        return ((day.lunarAngle % 360) + 360) % 360;
    }
    return 0;
}

/**
 * Set the stored lunar angle for the current chat.
 * @param {string} chatId
 * @param {number} angle - Angle in degrees (will be normalized to 0-360)
 */
export function setLunarAngle(chatId, angle) {
    const normalized = ((angle % 360) + 360) % 360;
    updateCurrentDay(chatId, { lunarAngle: normalized });
}

/**
 * Get the center angle for a given moon phase name.
 * @param {string} phaseName - e.g. "Waning Gibbous"
 * @returns {number} Center angle in degrees (0-360), defaults to 0 (New Moon) if unknown.
 */
export function getPhaseAngle(phaseName) {
    const phase = MOON_PHASES.find(p => p.name.toLowerCase() === (phaseName || '').toLowerCase());
    if (phase) return (phase.minAngle + phase.maxAngle) / 2;
    return 0;
}

/**
 * Get moon phase name and icon for a given angle in the lunar cycle.
 * @param {number} angle - Angle in degrees (0-360)
 * @returns {{ phaseName: string, icon: string }}
 */
function getMoonPhaseForAngle(angle) {
    const normalized = ((angle % 360) + 360) % 360;
    const phase = MOON_PHASES.find(p => normalized >= p.minAngle && normalized < p.maxAngle);
    if (phase) return { phaseName: phase.name, icon: phase.icon };
    // Angle >= 337.5 wraps around to New Moon
    return { phaseName: 'New Moon', icon: '🌑' };
}

/**
 * Generate N days of moon phases starting from an anchor angle.
 * Each subsequent day advances by getDegreesPerDay() through the lunar cycle,
 * yielding physically accurate progression (e.g., Full Moon → Waning Gibbous →
 * Last Quarter → Waning Crescent over ~10 days).
 *
 * @param {number} anchorAngle - Absolute angle in degrees (0-360) for day 0
 * @param {number} [numDays=7] - Number of days to generate
 * @param {number} [startOffset=0] - Day offset from anchor for the first entry
 * @returns {Array<{label: string, icon: string, phaseName: string}>}
 */
export function generateMoonPhases(anchorAngle, numDays = 7, startOffset = 0) {
    const labels = ['Today', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'];
    const degPerDay = getDegreesPerDay();
    const phases = [];

    for (let i = 0; i < numDays; i++) {
        const angle = anchorAngle + (startOffset + i) * degPerDay;
        const { phaseName, icon } = getMoonPhaseForAngle(angle);
        phases.push({
            label: labels[i] || `Day ${i + 1}`,
            icon,
            phaseName
        });
    }

    return phases;
}


// ── Internal prompts (NOT user-editable) ──────────────────────────────────

const DAY_ADVANCEMENT_SYSTEM_PROMPT = `You are a day advancement assistant for a narrative roleplay. Your job is to advance the in-game date by ONE day and generate an updated 7-day weather forecast.

You will receive:
- The current date display and sub-date
- The setting context (world climate/geography description)
- The current 7-day forecast

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
  ]
}

IMPORTANT: Write the date display and weather with atmospheric, narrative-appropriate detail. The forecast must be grounded in the setting context provided.

NOTE: Moon phases are calculated automatically by the system. Do NOT include moonPhases in the response.`;

/**
 * System prompt for forecast AND moon phases regeneration (no day advancement).
 * Used by the Forecast Regen button's "Both" option and to seed initial forecast after batch scan.
 */
const FORECAST_REGEN_SYSTEM_PROMPT = `You are a weather forecasting assistant for a narrative roleplay. Your job is to regenerate the 7-day weather forecast for the current in-game date.

You will receive:
- The current date display, sub-date, and season
- The setting context (world climate/geography description)
- The current 7-day forecast (may be empty if none exists yet)

Respond with a JSON object containing:
{
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
    ... 7 entries total
  ]
}

IMPORTANT: Do NOT change the date. Regenerate only the forecast. Write the forecast with atmospheric, narrative-appropriate detail grounded in the setting context.

NOTE: Moon phases are calculated automatically by the system. Do NOT include moonPhases in the response.`;

/**
 * System prompt for weather-ONLY regeneration.
 */
const FORECAST_ONLY_SYSTEM_PROMPT = `You are a weather forecasting assistant for a narrative roleplay. Your job is to regenerate ONLY the 7-day weather forecast for the current in-game date.

You will receive:
- The current date display, sub-date, and season
- The setting context (world climate/geography description)
- The current 7-day forecast (may be empty if none exists yet)

Respond with a JSON object containing:
{
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
    ... 7 entries total
  ]
}

IMPORTANT: Do NOT change the date. Regenerate ONLY the weather forecast. Write with atmospheric, narrative-appropriate detail grounded in the setting context.`;

// ── Forecast/Moon Regeneration (no day advancement) ────────────────────────

/**
 * Regenerate forecast and/or moon phases WITHOUT advancing the day.
 * Moon phases are calculated programmatically using real lunar cycle math
 * (~12.19° per day through the 8-phase cycle) — the LLM is only used for
 * creative weather text.
 *
 * @param {'all'|'forecast'|'moonPhases'} mode - What to regenerate
 * @returns {Promise<boolean>} True on success
 */
export async function regenerateForecast(mode = 'all') {
    const chatId = getChatId();
    if (!chatId) {
        nwstToast('No active chat detected.', 'error');
        return false;
    }

    showLoading(true);

    try {
        const currentDay = getCurrentDay(chatId);
        const settingContext = getSettingContext(chatId);
        const currentForecast = getForecast(chatId);
        const currentMoonPhases = getMoonPhases(chatId);

        // ── Moon phases are ALWAYS calculated programmatically ──────────
        if (mode === 'moonPhases' || mode === 'all') {
            // Read the stored lunar angle (absolute position in the cycle)
            let anchorAngle = getLunarAngle(chatId);

            // Migration: if lunarAngle is 0 but existing moon phases have a named phase,
            // compute the angle from the existing Day 0 phase name
            if (anchorAngle === 0 && currentMoonPhases && currentMoonPhases.length > 0) {
                const computedAngle = getPhaseAngle(currentMoonPhases[0].phaseName);
                if (computedAngle !== 0) {
                    anchorAngle = computedAngle;
                    setLunarAngle(chatId, anchorAngle);
                }
            }

            const newMoonPhases = generateMoonPhases(anchorAngle, 7, 0);
            replaceMoonPhases(chatId, newMoonPhases);
        }

        // ── Weather forecast is LLM-generated ──────────────────────────
        if (mode === 'forecast' || mode === 'all') {
            const profile = resolveProfile('dayAdvancementLLM');
            if (!profile) {
                throw new Error('No Day Advancement LLM connection profile configured. Set one in Settings.');
            }

            const systemPrompt = (mode === 'forecast')
                ? FORECAST_ONLY_SYSTEM_PROMPT
                : FORECAST_REGEN_SYSTEM_PROMPT;
            const userPrompt = buildForecastOnlyPrompt(currentDay, settingContext, currentForecast);

            const response = await callLLM(profile, systemPrompt, userPrompt);
            if (!response) {
                throw new Error('LLM returned empty response.');
            }

            const forecast = parseForecastOnlyField(response, 'forecast');
            if (!forecast || forecast.length === 0) {
                throw new Error('Failed to parse weather forecast from LLM response.');
            }
            replaceForecast(chatId, forecast);
        }

        // ── Feedback ───────────────────────────────────────────────────
        if (mode === 'forecast') {
            nwstToast('Weather forecast regenerated.', 'success');
        } else if (mode === 'moonPhases') {
            nwstToast('Moon phases regenerated (calculated from lunar cycle).', 'success');
        } else {
            nwstToast('Forecast regenerated. Moon phases recalculated from lunar cycle.', 'success');
        }

        return true;

    } catch (err) {
        console.error('[NWST DayAdvancement] Regeneration failed:', err);
        nwstToast(`Regeneration failed: ${err.message}`, 'error');
        return false;
    } finally {
        showLoading(false);
    }
}

/**
 * Regenerate only the weather forecast (preserves existing moon phases).
 * @returns {Promise<boolean>}
 */
export async function regenerateForecastOnly() {
    return regenerateForecast('forecast');
}

/**
 * Regenerate only the moon phases (preserves existing weather forecast).
 * @returns {Promise<boolean>}
 */
export async function regenerateMoonPhasesOnly() {
    return regenerateForecast('moonPhases');
}

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
    nwstToast('Generating forecast...', 'info');

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

        // 3. Build the LLM prompt (moon phases excluded — calculated programmatically)
        const userPrompt = buildDayAdvancementPrompt(currentDay, settingContext, currentForecast);

        // 4. Call the Day Advancement LLM
        const response = await callLLM(profile, DAY_ADVANCEMENT_SYSTEM_PROMPT, userPrompt);

        // 5. Parse the JSON response
        const result = parseDayAdvancementResponse(response);
        if (!result) {
            throw new Error('Failed to parse Day Advancement LLM response.');
        }

        // 6. Save the results (date + forecast from LLM)
        updateCurrentDay(chatId, {
            dateDisplay: result.dateDisplay,
            dateSub: result.dateSub,
            season: result.season
        });
        replaceForecast(chatId, result.forecast);

        // 7. Calculate moon phases programmatically
        //    Advance the stored lunar angle by one day's progression,
        //    then generate the new 7-day view from that position.
        const currentAngle = getLunarAngle(chatId);
        const newAngle = (currentAngle + getDegreesPerDay()) % 360;
        const newMoonPhases = generateMoonPhases(newAngle, 7, 0);
        replaceMoonPhases(chatId, newMoonPhases);
        setLunarAngle(chatId, newAngle);

        nwstToast('Forecast updated. Moon phases recalculated from lunar cycle.', 'success');

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

function buildDayAdvancementPrompt(currentDay, settingContext, forecast) {
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

    prompt += `\nAdvance the date by ONE day and generate the updated forecast. Moon phases are calculated automatically by the system. Respond with valid JSON only.`;

    return prompt;
}

/**
 * Build a prompt for regenerating ONLY the weather forecast.
 * Excludes moon phase data entirely.
 */
function buildForecastOnlyPrompt(currentDay, settingContext, forecast) {
    let prompt = '';

    prompt += `Current Date Display: ${currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Sub-Date: ${currentDay.dateSub || '(not set)'}\n`;
    prompt += `Current Season: ${currentDay.season || '(not set)'}\n\n`;

    if (settingContext) {
        prompt += `Setting Context (world climate/geography):\n${settingContext}\n\n`;
    }

    prompt += `Current 7-Day Forecast:\n`;
    if (forecast && forecast.length > 0) {
        for (const day of forecast) {
            prompt += `  ${day.label}: ${day.description || ''} | High: ${day.highF}°F / ${day.highC}°C | Low: ${day.lowF}°F / ${day.lowC}°C | Precip: ${day.precipChance}% | Icon: ${day.icon}\n`;
        }
    } else {
        prompt += `  (no forecast data)\n`;
    }

    prompt += `\nRegenerate ONLY the 7-day weather forecast. Keep the same date. Respond with valid JSON containing only a "forecast" array.`;

    return prompt;
}

/**
 * Parse a single field from an LLM JSON response.
 * Works for both 'forecast' and 'moonPhases' fields.
 *
 * @param {string} response - Raw LLM response text
 * @param {'forecast'|'moonPhases'} fieldName - Which field to extract
 * @returns {Array|null} The parsed array, or null on failure
 */
function parseForecastOnlyField(response, fieldName) {
    if (!response || typeof response !== 'string') return null;

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
        return Array.isArray(parsed[fieldName]) ? parsed[fieldName].slice(0, 7) : null;
    } catch (e) {
        console.error(`[NWST DayAdvancement] Parse ${fieldName} JSON error:`, e);
        console.log('Raw response:', response);
        return null;
    }
}

// ── LLM call ──────────────────────────────────────────────────────────────

async function callLLM(profile, systemPrompt, userPrompt) {
    // Build a minimal message array for the LLM call
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];

    // Use generateWithProfile to call the LLM via the connection profile
    // This uses the connection-manager's dedicated profile-aware request service,
    // which applies all profile settings (endpoint, key, model, preset) without
    // modifying any global ST state.
    const result = await generateWithProfile(profile, messages);

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
            forecast: Array.isArray(parsed.forecast) ? parsed.forecast.slice(0, 7) : []
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
