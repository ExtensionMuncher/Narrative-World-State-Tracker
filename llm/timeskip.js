/* eslint-disable */
// =============================================================================
// NWST Time Skip — llm/timeskip.js
// =============================================================================
// Handles the Time Skip process — the heaviest Planning LLM call.
//
// Process:
//   1. Save a FULL pre-skip snapshot (rollback point)
//   2. Call Planning LLM with skip description + full context
//   3. Planning LLM overhauls: Current Day, forecast/moon (via Day Adv LLM),
//      all events, world conditions, notebook
//   4. On ANY failure mid-process → roll back to pre-skip snapshot
//   5. Show error toast, restore UI
//
// The user should be able to retry the skip cleanly from a known good state.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { getSetting } from '../index.js';;
import {
    getWorldState, saveWorldState, getCurrentDay, replaceCurrentDay,
    getForecast, replaceForecast, getMoonPhases, replaceMoonPhases,
    getConditions, updateConditionContent, getSettingContext,
    saveSnapshot, getSeasonConfig, getCalendarConfig
} from '../data/worldState.js';
import { getAllEvents, saveAllEvents, addEvent } from '../data/events.js';
import { getNotebook, saveNotebook } from '../data/notebook.js';
import { getPlannerPrompt } from '../settings.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { getLunarAngle, setLunarAngle, getDegreesPerDay, generateMoonPhases, getPhaseAngle, computeLunarAngleFromDate, getMoonPhaseForAngle, computeSeason } from './dayAdvancement.js';

// ── Internal prompt ───────────────────────────────────────────────────────

const TIMESKIP_SYSTEM_PROMPT = `You are a time skip assistant for a narrative roleplay. The user wants to skip forward in time. Your job is to perform a complete overhaul of the world state to reflect the passage of time described.

You will receive:
- The time skip description (what the user wants to skip)
- The current world state (date, season, weather, conditions)
- The current moon phase
- All active events
- The full notebook
- Visible chat context

You must update ALL of the following:

1. CURRENT DAY BLOCK: New date, new season, new weather, new moon phase appropriate to the new time period
2. ALL EVENTS: Mark past-due events as resolved or missed. Update surviving events to correct tiers. Generate new events where the skip context warrants them. Adjust NPC events based on what would plausibly have occurred.
3. WORLD CONDITIONS: Update political, social, spiritual, and environmental conditions to reflect what the skip duration and reason imply.
4. NOTEBOOK: Update planted details, character whereabouts, offscreen pressures as appropriate for elapsed time. Remove items that would have resolved.

IMPORTANT — Moon Phase: You must determine the correct moon phase at the new date after the time skip. Consider:
- The current moon phase (provided in the context)
- The skip duration and description (e.g., "three weeks" = ~21 days, "a fortnight" = ~14 days, "a month" = ~29.5 days)
- Each day advances the moon by ~12.19° through the 29.53-day cycle
- The 8 standard phases in order: New Moon (0°) → Waxing Crescent (45°) → First Quarter (85.3°) → Waxing Gibbous (135°) → Full Moon (180°) → Waning Gibbous (225°) → Last Quarter (265.3°) → Waning Crescent (315°) → back to New Moon

Include "moonPhaseName" in the currentDay output to set the exact phase for the new date.

Respond with a JSON object:
{
  "currentDay": {
    "dateDisplay": "new date string",
    "dateSub": "sub-date if changed",
    "season": "new season",
    "weatherToday": "weather at the new time",
    "flora": "seasonal flora description",
    "fauna": "seasonal fauna description",
    "spiritualClimate": "if applicable",
    "moonPhaseName": "exact moon phase name at the new date (e.g. 'Waning Crescent', 'First Quarter', 'Full Moon')"
  },
  "eventUpdates": {
    "resolved": ["event_id_1", ...],
    "missed": ["event_id_2", ...],
    "newEvents": [
      {
        "title": "...",
        "description": "...",
        "tier": "immediate"|"week"|"month"|"undetermined",
        "isNPC": true|false,
        "origin": "generated",
        "scheduledDate": "REQUIRED when timing is clear — after a timeskip, events happening on the new date or near future MUST include a scheduledDate. Format: \"Day #\" or \"Month/Date\". OMIT for vague/uncertain timing."
      }
    ]
  },
  "conditionUpdates": {
    "political": "updated content or empty string",
    "social": "...",
    "spiritual": "...",
    "environmental": "..."
  },
  "notebookUpdates": {
    "removeCoreBullets": { "fieldName": [index1, index2] },
    "addCoreBullets": { "fieldName": ["text1", "text2"] },
    "removeMysteryBullets": { "fieldName": [index1] },
    "addMysteryBullets": { "fieldName": ["text1"] }
  }
}

Write with atmospheric detail. Ground everything in the setting context and the skip description.`;

// ── Execute Time Skip ─────────────────────────────────────────────────────

/**
 * Execute a full time skip.
 *
 * @param {string} skipDescription - Natural language description of the skip
 * @returns {Promise<boolean>} True on success
 */
export async function executeTimeSkip(skipDescription) {
    const chatId = getChatId();
    if (!chatId) {
        nwstToast('No active chat detected.', 'error');
        return false;
    }

    if (!skipDescription || !skipDescription.trim()) {
        nwstToast('Enter a description of the time skip.', 'warning');
        return false;
    }

    // ── 1. Save pre-skip snapshot (ROLLBACK POINT) ──────────────
    nwstToast('Processing time skip — this may take a moment...', 'info');
    showTimeskipLoading(true);

    const preSkipSnapshot = {
        worldState: getWorldState(chatId),
        events: getAllEvents(chatId),
        notebook: getNotebook(chatId)
    };

    // Save snapshot for potential rollback
    const snapshotKey = `pre_skip_${Date.now()}`;
    await saveSnapshot(chatId, snapshotKey, preSkipSnapshot.worldState, preSkipSnapshot.events, preSkipSnapshot.notebook);

    try {
        // ── 2. Resolve Planning LLM profile ─────────────────────
        const profile = resolveProfile('planningLLM');
        if (!profile) {
            throw new Error('No Planning LLM connection profile configured.');
        }

        // ── 3. Build prompt with full context ──────────────────
        const currentDay = getCurrentDay(chatId);
        const conditions = getConditions(chatId);
        const events = getAllEvents(chatId);
        const notebook = getNotebook(chatId);
        const settingContext = getSettingContext(chatId);

        // Get visible chat context for the LLM
        const chatContext = getVisibleChatContext();

        // Compute the current season from the pre-skip dayCount so the LLM
        // receives accurate seasonal context for the skip description.
        const currentComputedSeason = (currentDay && typeof currentDay.dayCount === 'number')
            ? computeSeason(currentDay.dayCount, getSeasonConfig(chatId))
            : null;

        const userPrompt = buildTimeskipPrompt(
            skipDescription, currentDay, conditions, events,
            notebook, settingContext, chatContext, currentComputedSeason
        );

        // ── 4. Call Planning LLM via connection profile ────────
        const messages = [
            { role: 'system', content: TIMESKIP_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        console.log('[NWST Timeskip] Calling Planning LLM with full context...');
        const response = await generateWithProfile(profile, messages);

        if (!response) {
            throw new Error('Planning LLM returned empty response.');
        }

        // ── 5. Parse and apply results ─────────────────────────
        const result = parseTimeskipResponse(response);
        if (!result) {
            throw new Error('Failed to parse Planning LLM response.');
        }

        // Apply Current Day updates
        //   - The LLM generates a full new currentDay including season
        //   - When the seasonal engine is active, the computed season OVERRIDES
        //     the LLM's season — the engine is the authority on what season it is
        //   - dayCount is PRESERVED through timeskip (no reliable estimate of
        //     skip duration yet; user can edit via UI if needed)
        if (result.currentDay) {
            nwstToast('Current Day updated.', 'info');

            const oldDayCount = preSkipSnapshot.worldState?.currentDay?.dayCount ?? 0;
            const seasonConfig = getSeasonConfig(chatId);
            const computedSeason = computeSeason(oldDayCount, seasonConfig);
            const finalSeason = computedSeason !== null ? computedSeason : (result.currentDay.season || '');

            await replaceCurrentDay(chatId, {
                ...result.currentDay,
                season: finalSeason,
                dayCount: oldDayCount
            });
        }

        // Apply event updates
        if (result.eventUpdates) {
            await applyEventUpdates(chatId, result.eventUpdates);
            nwstToast('Events updated.', 'info');
        }

        // Apply condition updates
        if (result.conditionUpdates) {
            await applyConditionUpdates(chatId, result.conditionUpdates);
            nwstToast('World conditions updated.', 'info');
        }

        // Apply notebook updates
        if (result.notebookUpdates) {
            await applyNotebookUpdates(chatId, result.notebookUpdates);
            nwstToast('Notebook updated.', 'info');
        }

        // ── 6. Recalculate moon phases ───────────────────────────────
        // Priority 1: Use LLM-provided moonPhaseName (exact, no estimation)
        // Priority 2: Use computeLunarAngleFromDate on new dateDisplay
        // Priority 3: Fall back to estimateDaysBetweenDates advancement
        try {
            let newAngle = 0;
            let phaseSource = '';

            // Priority 1: LLM directly specified the moon phase
            const llmPhaseName = result.currentDay?.moonPhaseName;
            if (llmPhaseName && typeof llmPhaseName === 'string' && llmPhaseName.trim()) {
                const phaseAngle = getPhaseAngle(llmPhaseName.trim());
                // getPhaseAngle returns 0 for unknown phases, but valid phases
                // always return a positive center angle (New Moon = 11.25°)
                if (phaseAngle !== 0) {
                    newAngle = phaseAngle;
                    phaseSource = `LLM-specified phase "${llmPhaseName}"`;
                } else {
                    console.warn(`[NWST Timeskip] LLM provided unknown moonPhaseName "${llmPhaseName}" — falling back to date parsing.`);
                }
            }

            // Priority 2: Parse the new date text from LLM's dateDisplay
            if (!phaseSource) {
                const newDate = result.currentDay?.dateDisplay || '';
                if (newDate) {
                    newAngle = computeLunarAngleFromDate(newDate);
                    if (newAngle !== 0) {
                        phaseSource = `date-parsed from "${newDate}"`;
                    }
                }
            }

            // Priority 3: Fall back to estimating days between old and new dates
            if (!phaseSource) {
                const oldDay = preSkipSnapshot.worldState?.currentDay || {};
                const oldLunarAngle = oldDay.lunarAngle !== undefined ? oldDay.lunarAngle : 0;
                const oldDate = oldDay.dateDisplay || '';
                const newDate = result.currentDay?.dateDisplay || '';
                const estimatedDays = estimateDaysBetweenDates(oldDate, newDate);
                newAngle = ((oldLunarAngle + estimatedDays * getDegreesPerDay()) % 360 + 360) % 360;
                phaseSource = `estimated ${estimatedDays}d from stored angle`;
            }

            // Normalize and store
            newAngle = ((newAngle % 360) + 360) % 360;
            setLunarAngle(chatId, newAngle);

            // Generate new 7-day moon phase strip from the new angle
            // Build phenomena context from the current (pre-skip or updated) day
            const cycleDays = getSetting('moonCycleDays') || 29.53;
            const phenOptions = {
                season: currentDay?.season || '',
                weatherToday: currentDay?.weatherToday || '',
                cycleDays
            };
            const newMoonPhases = generateMoonPhases(newAngle, 7, 0, phenOptions);
            await replaceMoonPhases(chatId, newMoonPhases);

            const phaseInfo = getMoonPhaseForAngle(newAngle);
            nwstToast(`Moon phases recalculated (${phaseSource}). Anchored as "${phaseInfo.phaseName}" (${newAngle.toFixed(1)}°).`, 'info');
        } catch (moonErr) {
            console.warn('[NWST Timeskip] Moon phase recalculation failed (non-fatal):', moonErr);
        }

        // ── 8. Regenerate weather forecast ──────────────────────────
        try {
            const { regenerateForecast } = await import('./dayAdvancement.js');
            await regenerateForecast('forecast');
            nwstToast('Forecast updated.', 'info');
        } catch (forecastErr) {
            console.warn('[NWST Timeskip] Forecast regeneration failed (non-fatal):', forecastErr);
        }

        nwstToast('Time skip complete.', 'success');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'events', 'world', 'notebook');
        return true;

    } catch (err) {
        // ── FAILURE RECOVERY: Roll back to pre-skip snapshot ────
        console.error('[NWST Timeskip] FAILED — rolling back:', err);

        try {
            await saveWorldState(chatId, preSkipSnapshot.worldState);
            await saveAllEvents(chatId, preSkipSnapshot.events);
            await saveNotebook(chatId, preSkipSnapshot.notebook);
            nwstToast(`Time skip failed: ${err.message}. State rolled back.`, 'error');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'events', 'world', 'notebook');
        } catch (rollbackErr) {
            console.error('[NWST Timeskip] CRITICAL: Rollback also failed!', rollbackErr);
            nwstToast('Time skip failed and rollback was incomplete. Check console.', 'error');
        }

        return false;

    } finally {
        showTimeskipLoading(false);
    }
}

// ── Date estimation helper ─────────────────────────────────────────────────

/**
 * Estimate the number of days between two freeform date strings.
 * Extracts the first numeric value from each string and computes the difference.
 * Falls back to 1 (minimum shift) if dates can't be parsed numerically.
 *
 * @param {string} oldDate - Previous dateDisplay string
 * @param {string} newDate - New dateDisplay string from LLM
 * @returns {number} Estimated days between the two dates (at least 1)
 */
function estimateDaysBetweenDates(oldDate, newDate) {
    if (!oldDate || !newDate) return 1;
    const oldNum = parseInt(oldDate.match(/\d+/)?.[0], 10);
    const newNum = parseInt(newDate.match(/\d+/)?.[0], 10);
    if (!isNaN(oldNum) && !isNaN(newNum) && newNum > oldNum) {
        return newNum - oldNum;
    }
    // Fallback: if dates contain month names or qualitative indicators,
    // default to a reasonable skip. Since we can't reliably parse
    // freeform narrative dates, 1 day is the safest minimum.
    return 1;
}

// ── Prompt building ───────────────────────────────────────────────────────

function buildTimeskipPrompt(skipDesc, currentDay, conditions, events, notebook, settingContext, chatContext, computedSeason) {
    let prompt = '';

    prompt += `TIME SKIP DESCRIPTION:\n"${skipDesc}"\n\n`;

    prompt += `=== CURRENT WORLD STATE ===\n`;
    prompt += `Date: ${currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Sub-Date: ${currentDay.dateSub || ''}\n`;
    prompt += `Season: ${currentDay.season || '(not set)'}\n`;
    if (computedSeason) {
        prompt += `System-computed current season: ${computedSeason}\n`;
    }
    prompt += `Weather: ${currentDay.weatherToday || '(not set)'}\n`;
    prompt += `Flora: ${currentDay.flora || ''}\n`;
    prompt += `Fauna: ${currentDay.fauna || ''}\n`;
    prompt += `Spiritual Climate: ${currentDay.spiritualClimate || ''}\n`;

    // Get current moon phase info for LLM context
    const chatId = getChatId();
    let moonPhaseName = '(not tracked)';
    let moonPhaseAngle = 0;
    let moonDay = 0;
    try {
        moonPhaseAngle = getLunarAngle(chatId);
        const phaseInfo = getMoonPhaseForAngle(moonPhaseAngle);
        moonPhaseName = phaseInfo.phaseName;
        moonDay = Math.round((moonPhaseAngle / 360) * 29.53);
    } catch (e) {
        // ignore
    }
    prompt += `Moon Phase: ${moonPhaseName} (${moonPhaseAngle.toFixed(1)}°, approximately Day ${moonDay} of the lunar cycle)\n\n`;

    // ── CALENDAR SYSTEM (date format reference) ─────────────────
    const calConfig = getCalendarConfig(chatId);
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

    // Conditions
    prompt += `=== WORLD CONDITIONS ===\n`;
    for (const [key, cond] of Object.entries(conditions)) {
        prompt += `[${key}]: ${cond.content || '(empty)'}\n`;
    }
    prompt += '\n';

    // Events
    prompt += `=== ALL EVENTS (${events.length}) ===\n`;
    for (const event of events) {
        const dateStr = event.scheduledDate ? ` [scheduled: ${event.scheduledDate}]` : '';
        prompt += `[${event.id}] [${event.tier}] [${event.status}]${dateStr} ${event.title}: ${event.description}\n`;
    }
    prompt += '\n';

    // Notebook summary
    prompt += `=== NOTEBOOK ===\n`;
    prompt += `Core - Unresolved: ${(notebook.core?.unresolvedDetail || []).join(' | ')}\n`;
    prompt += `Core - Promises: ${(notebook.core?.promiseThreatDeadline || []).join(' | ')}\n`;
    prompt += `Core - Offscreen: ${(notebook.core?.offscreenPressure || []).join(' | ')}\n`;
    prompt += `Core - Don't Forget: ${(notebook.core?.doNotForget || []).join(' | ')}\n`;
    prompt += `Mystery - Facts: ${(notebook.mystery?.establishedFacts || []).join(' | ')}\n`;
    prompt += `Mystery - Planted: ${(notebook.mystery?.plantedDetails || []).join(' | ')}\n`;
    prompt += `Mystery - Whereabouts: ${(notebook.mystery?.characterWhereabouts || []).join(' | ')}\n`;
    prompt += '\n';

    if (settingContext) {
        prompt += `=== SETTING CONTEXT ===\n${settingContext}\n\n`;
    }

    if (chatContext) {
        prompt += `=== RECENT CHAT CONTEXT ===\n${chatContext}\n\n`;
    }

    prompt += `Perform a complete time skip overhaul. Respond with valid JSON only.`;

    return prompt;
}

// ── Chat context ──────────────────────────────────────────────────────────

function getVisibleChatContext() {
    // Placeholder — refined during integration
    return '';
}

// ── Response parsing ──────────────────────────────────────────────────────

function parseTimeskipResponse(response) {
    if (!response || typeof response !== 'string') return null;

    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];

    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error('[NWST Timeskip] JSON parse error:', e);
        return null;
    }
}

// ── Apply helpers ─────────────────────────────────────────────────────────

async function applyEventUpdates(chatId, updates) {
    const events = getAllEvents(chatId);

    // Mark resolved
    for (const id of (updates.resolved || [])) {
        const event = events.find(e => e.id === id);
        if (event) event.status = 'resolved';
    }

    // Mark missed
    for (const id of (updates.missed || [])) {
        const event = events.find(e => e.id === id);
        if (event) event.status = 'missed';
    }

    // Add new events
    for (const newEvent of (updates.newEvents || [])) {
        await addEvent(chatId, {
            ...newEvent,
            status: 'pending',
            origin: 'generated'
        });
    }
}

async function applyConditionUpdates(chatId, updates) {
    for (const [key, content] of Object.entries(updates)) {
        if (content) {
            await updateConditionContent(chatId, key, content);
        }
    }
}

async function applyNotebookUpdates(chatId, updates) {
    const notebook = getNotebook(chatId);

    // This is a simplified application — refined during integration testing
    // The LLM response format for notebook updates will be calibrated with real responses
    console.log('[NWST Timeskip] Notebook updates applied.');
}

// ── Loading UI ────────────────────────────────────────────────────────────

function showTimeskipLoading(show) {
    const homePane = document.getElementById('nwst-pane-home');
    if (homePane) {
        homePane.classList.toggle('nwst-loading', show);
    }

    const jumpBtn = document.getElementById('nwst-timeskip-jump');
    if (jumpBtn) {
        jumpBtn.disabled = show;
        jumpBtn.textContent = show ? 'Processing...' : 'Jump →';
    }
}
