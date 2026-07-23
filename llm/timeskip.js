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
import { getSetting } from '../index.js';
import {
    getWorldState, saveWorldState, getCurrentDay, replaceCurrentDay,
    getForecast, replaceForecast, getMoonPhases, replaceMoonPhases,
    getConditions, updateConditionContent, getSettingContext,
    saveSnapshot, getSeasonConfig, getCalendarConfig
} from '../data/worldState.js';
import { getAllEvents, saveAllEvents, addEvent, classifyScheduledEventTier } from '../data/events.js';
import { getNotebook, saveNotebook } from '../data/notebook.js';
import { getPlannerPrompt } from '../settings.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { LLM_TOKEN_BUDGETS } from './tokenBudgets.js';
import { getLunarAngle, setLunarAngle, getDegreesPerDay, generateMoonPhases, getPhaseAngle, computeLunarAngleFromDate, getMoonPhaseForAngle, computeSeason, refreshExtraMoons, buildMoonPhenomenaOptions } from './dayAdvancement.js';
import { getEraPin } from '../data/worldState.js';
import { advanceCurrentCalendarDate, parseCurrentCalendarDate, dayOfYearFor, daysBetweenCalendarDates, wrapDayCount, extractYearFromText, computeDeterministicDate } from '../lib/calendarMath.js';
import { dlog } from "../lib/debug.js";
import { getMoonConfig } from '../data/moons.js';

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

CRITICAL — NPC vs User Events: Events driven by NPC characters (events about a character's internal struggle, personal relationships, backstory, or decisions) MUST have "isNPC": true. Events that are world-facing or player-facing (faction movements, festivals, environmental changes, rumors the player can investigate) should have "isNPC": false. When in doubt, if a specific NPC name appears in the title or description, set isNPC: true.
3. WORLD CONDITIONS: Use one of two mental modes for each condition. GROUNDED means the skip description/current state actually establishes the macro condition, with at most ONE conservative inference and no invented actor, reaction, institution, team, rumor, policy, coordination, awareness, or offscreen development. AMBIENT means a restrained low-stakes background condition consistent with Setting Context and the new date/season, independent of the immediate cast. Ambient may introduce modest background motion involving setting-supported institutions/factions/populations/environments, including named overarching institutions, provided it stays something the active cast could plausibly never notice. If an invented development would force immediate plan changes, urgent follow-up, or substantially rewrite the playable world, it is too consequential unless the supplied world state already supports that scale. Keep conditions at macro/durable scale: institutions, factions, populations, districts, regions, cultures, social patterns, spiritual systems, or environments. A named character may be identified as the CAUSE of a genuine grounded macro shift, but do not turn their personal actions into the World Condition itself. Do not invent unseen meetings, rumor circulation, institutional reactions, coordination, mutual awareness, policy shifts, resource strain, new teams/details, or faction-wide sentiment to bridge a local fact into a macro consequence. Preserve information asymmetry. Plausible future consequences are not current conditions. Avoid casually inventing plot-forcing upheavals such as war, coups, states of emergency, sweeping nationwide crackdowns/purges, mass civil disorder, economic collapse, catastrophic disasters, mass-casualty events, widespread infrastructure failure, or supernatural/metaphysical catastrophes. Avoid unsupported unprecedented/historic/system-wide claims.

CATEGORY BOUNDARIES / MACRO THRESHOLDS FOR WORLD CONDITIONS:
- POLITICAL: institutions, factions, governance, territory, policy/regulatory pressure, leadership/hierarchy, organizational posture, or institutional/faction relationships. One case, target, operative, restraining order, arrest, or investigation is not macro by itself. AMBIENT Political may include modest institutional motion such as routine procedural guidance, staffing/budget pressure, promotion cycles, municipal initiatives, enforcement-priority shifts, or low-key faction/corporate maneuvering when background-scale.
- SOCIAL: collective behavior, norms, communities, public routines, workplaces, commerce, social spaces, population habits, or group-level pressures. Private relationships are not Social World State. Season/weather may explain social behavior but should not dominate the paragraph.
- SPIRITUAL/SUPERNATURAL: durable metaphysical systems/pressures, supernatural factions, ritual cycles, regional phenomena, barriers/realms, or other setting-supported supernatural conditions. One character's aura/encounter/emotion is not world-scale metaphysics. Do not invent supernatural ontology absent setting support.
- ENVIRONMENTAL: durable climate/seasonal patterns, ecology, landscape, water/air conditions, regional hazards, flora/fauna shifts, or persistent environmental change. The new day's immediate weather belongs in Current Day unless it reflects a wider pattern.
- A GROUNDED FACT is not automatically a GROUNDED WORLD CONDITION. If the skip only establishes case-specific facts, keep/preserve the broader condition or use restrained AMBIENT background rather than inflating those facts into macro state.
4. NOTEBOOK: Maintain the latest coherent Notebook state after the skip — not an archive of every superseded intermediate state. Remove or replace outdated, contradicted, resolved, expired, or no-longer-current bullets across all Notebook fields. characterWhereabouts must contain only one latest-known position per character; offscreenPressure only one current pressure per source; currentToneAtmosphere only the current tone. Preserve durable facts unless the story explicitly corrected them.

NOTEBOOK MOTIVE GROUNDING — applies to every Notebook addition/edit:
- When narration, dialogue, or internal thought explicitly states WHY a character acted, preserve that stated motive as higher-confidence evidence than dramatic presentation.
- Do NOT upgrade fear, desperation, panic, confusion, impulsiveness, self-preservation, or reactive behavior into confidence, strategy, dominance, bravery, or calculated control unless the prose establishes it.
- Do not make characters more competent, composed, sinister, romantic, strategic, or "badass" than the evidence supports.

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
    "moonPhaseName": "exact moon phase name at the new date (e.g. 'Waning Crescent', 'First Quarter', 'Full Moon')",
    "daysSkipped": number — the total whole days elapsed in this skip (e.g. "three weeks" = 21). REQUIRED. Count carefully; the system advances its deterministic calendar by exactly this many days.
  },
  "eventUpdates": {
    "resolved": ["event_id_1", ...],
    "missed": ["event_id_2", ...],
    "tierChanges": { "event_id_3": "immediate" | "week" | "month" } (never move events in or out of the "undetermined" tier — those are timeless by design),
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

EVENT UPDATE SAFETY: Only list an existing event under resolved, missed, or tierChanges when the time skip clearly changes that event. Existing events omitted from eventUpdates remain unchanged; omission does NOT mean resolved.

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

        const eraPinForPrompt = !getCalendarConfig(chatId).enabled ? getEraPin(chatId) : '';
        const userPrompt = buildTimeskipPrompt(
            skipDescription, currentDay, conditions, events,
            notebook, settingContext, chatContext, currentComputedSeason,
            eraPinForPrompt
        );

        // ── 4. Call Planning LLM via connection profile ────────
        const messages = [
            { role: 'system', content: TIMESKIP_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        dlog('[NWST Timeskip] Calling Planning LLM with full context...');
        const response = await generateWithProfile(profile, messages, { maxTokens: LLM_TOKEN_BUDGETS.BULK });

        if (!response) {
            throw new Error('Planning LLM returned empty response.');
        }

        // ── 5. Parse and apply results ─────────────────────────
        const result = parseTimeskipResponse(response);
        if (!result) {
            throw new Error('Failed to parse Planning LLM response.');
        }

        // Apply Current Day updates.
        // Calendar position (dayCount) is cyclical; elapsedStoryDays is a
        // separate duration counter. The calendar advances from the currently
        // displayed date using the chat's own Calendar Config — never from the
        // elapsed counter.
        let appliedDaysSkipped = null;
        if (result.currentDay) {
            nwstToast('Current Day updated.', 'info');

            const preDay = preSkipSnapshot.worldState?.currentDay || {};
            const oldDayCount = Number.isInteger(preDay.dayCount) && preDay.dayCount > 0 ? preDay.dayCount : 1;
            const oldElapsedStoryDays = Number.isInteger(preDay.elapsedStoryDays) && preDay.elapsedStoryDays >= 0 ? preDay.elapsedStoryDays : 0;
            const seasonConfig = getSeasonConfig(chatId);
            const calCfg = getCalendarConfig(chatId);
            const dmy = getSetting('dateFormatDMY') === true;

            let reportedDaysSkipped = Number(result.currentDay.daysSkipped);
            if (!Number.isInteger(reportedDaysSkipped) || reportedDaysSkipped < 0) reportedDaysSkipped = Math.floor(reportedDaysSkipped);
            if (!Number.isInteger(reportedDaysSkipped) || reportedDaysSkipped < 0 || reportedDaysSkipped > 36500) {
                reportedDaysSkipped = null;
            }

            // If the LLM omitted daysSkipped, derive it from the old and new
            // calendar dates using the configured custom month structure.
            if (!Number.isInteger(reportedDaysSkipped)) {
                const oldDate = parseCurrentCalendarDate(preDay.dateDisplay || '', preDay.dateSub || '', calCfg, dmy);
                const newDate = parseCurrentCalendarDate(result.currentDay.dateDisplay || '', result.currentDay.dateSub || '', calCfg, dmy);
                if (oldDate && newDate) {
                    const diff = daysBetweenCalendarDates(oldDate, newDate, calCfg);
                    if (Number.isInteger(diff) && diff >= 0) {
                        reportedDaysSkipped = diff;
                        dlog(`[NWST Timeskip] daysSkipped missing/invalid — derived ${diff} day(s) from configured calendar dates.`);
                    }
                }
            }
            appliedDaysSkipped = reportedDaysSkipped;

            let newDayCount = oldDayCount;
            let newElapsedStoryDays = oldElapsedStoryDays;
            if (Number.isInteger(appliedDaysSkipped)) {
                newElapsedStoryDays = oldElapsedStoryDays + appliedDaysSkipped;
                const advanced = advanceCurrentCalendarDate(preDay, appliedDaysSkipped, calCfg, dmy);
                if (advanced) {
                    result.currentDay.dateDisplay = advanced.dateDisplay;
                    newDayCount = advanced.dayOfYear;

                    // Preserve player-authored custom era labels. For other
                    // calendars the LLM's dateSub remains authoritative.
                    const codeEraWins = calCfg.enabled && (calCfg.eraName || '').trim();
                    if (codeEraWins) {
                        const eraSub = computeDeterministicDate(advanced.date, newDayCount, newDayCount, calCfg).eraSub || '';
                        result.currentDay.dateSub = eraSub;
                    }
                } else {
                    // If the pre-skip date itself cannot be parsed, trust the
                    // LLM-written new date when it can be parsed; otherwise wrap
                    // the cyclical counter by the configured year length.
                    const parsedNew = parseCurrentCalendarDate(result.currentDay.dateDisplay || '', result.currentDay.dateSub || '', calCfg, dmy);
                    if (parsedNew) {
                        newDayCount = dayOfYearFor(parsedNew, calCfg);
                    } else {
                        const currentYear = extractYearFromText(preDay.dateSub || '') ?? extractYearFromText(preDay.dateDisplay || '') ?? 1;
                        newDayCount = wrapDayCount(oldDayCount + appliedDaysSkipped, calCfg, currentYear);
                    }
                }
            } else {
                // No trustworthy elapsed duration: keep elapsedStoryDays as-is,
                // but if the LLM supplied a parseable new date, keep dayCount in
                // sync with that displayed calendar position.
                const parsedNew = parseCurrentCalendarDate(result.currentDay.dateDisplay || '', result.currentDay.dateSub || '', calCfg, dmy);
                if (parsedNew) newDayCount = dayOfYearFor(parsedNew, calCfg);
            }

            const computedSeason = computeSeason(newDayCount, seasonConfig);
            const finalSeason = computedSeason !== null ? computedSeason : (result.currentDay.season || '');
            await replaceCurrentDay(chatId, {
                ...result.currentDay,
                season: finalSeason,
                dayCount: newDayCount,
                elapsedStoryDays: newElapsedStoryDays
            });

            if (Number.isInteger(appliedDaysSkipped)) {
                dlog(`[NWST Timeskip] +${appliedDaysSkipped} story day(s) → dayCount ${newDayCount}, elapsedStoryDays ${newElapsedStoryDays}.`);
            } else {
                console.warn('[NWST Timeskip] No trustworthy skip length — elapsedStoryDays preserved.');
            }
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

            // Priority 0: a validated elapsed-day count advances the stored moon
            // angle directly, regardless of whether the displayed calendar date
            // is deterministic or LLM-owned.
            if (Number.isInteger(appliedDaysSkipped)) {
                const oldAngleDet = preSkipSnapshot.worldState?.currentDay?.lunarAngle ?? getLunarAngle(chatId) ?? 0;
                newAngle = ((oldAngleDet + appliedDaysSkipped * getDegreesPerDay(chatId)) % 360 + 360) % 360;
                phaseSource = `elapsed +${appliedDaysSkipped}d`;
            }

            // Priority 1: LLM directly specified the moon phase
            const llmPhaseName = result.currentDay?.moonPhaseName;
            if (!phaseSource && llmPhaseName && typeof llmPhaseName === 'string' && llmPhaseName.trim()) {
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
                newAngle = ((oldLunarAngle + estimatedDays * getDegreesPerDay(chatId)) % 360 + 360) % 360;
                phaseSource = `estimated ${estimatedDays}d from stored angle`;
            }

            // Normalize and store
            newAngle = ((newAngle % 360) + 360) % 360;
            setLunarAngle(chatId, newAngle);

            // Extra moons advance by the best-known skip length: exact when
            // the deterministic engine ran, else estimated from date strings.
            let extraMoonDays = appliedDaysSkipped;
            if (!Number.isInteger(extraMoonDays) || extraMoonDays < 0) {
                const oldDateEm = preSkipSnapshot.worldState?.currentDay?.dateDisplay || '';
                const est = estimateDaysBetweenDates(oldDateEm, result.currentDay?.dateDisplay || '');
                extraMoonDays = (Number.isInteger(est) && est > 0) ? est : 1;
            }

            // Generate new 7-day moon phase strip from the new angle
            // Build phenomena context from the current (pre-skip or updated) day
            const cycleDays = getMoonConfig(chatId).moonCycleDays || 29.53058867;
            const phenOptions = buildMoonPhenomenaOptions(chatId, result.currentDay || currentDay, {
                cycleDays,
                forecast: Array.isArray(result.forecast) && result.forecast.length > 0
                    ? result.forecast
                    : getForecast(chatId)
            });
            const newMoonPhases = generateMoonPhases(newAngle, 7, 0, phenOptions);
            await replaceMoonPhases(chatId, newMoonPhases);
            await refreshExtraMoons(chatId, extraMoonDays, phenOptions);

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

function buildTimeskipPrompt(skipDesc, currentDay, conditions, events, notebook, settingContext, chatContext, computedSeason, eraPin = '') {
    let prompt = '';

    prompt += `TIME SKIP DESCRIPTION:\n"${skipDesc}"\n\n`;

    prompt += `=== CURRENT WORLD STATE ===\n`;
    prompt += `Date: ${currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Sub-Date: ${currentDay.dateSub || ''}\n`;
    if (eraPin) {
        prompt += `PLAYER-VERIFIED ERA: the player manually confirmed the era system ("${eraPin}"). Keep the new dateSub in this same era system — update era-relative year numbers for the elapsed time, but do NOT switch to a different era system.\n`;
    }
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

function getVisibleChatContext(count = 20) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const visibleMessages = chat.filter(msg => {
            if (msg.is_system && msg.extra?.hidden) return false;
            if (msg.extra?.display === 'none') return false;
            return Boolean(msg.mes);
        });

        return visibleMessages.slice(-count).map(msg => {
            const sender = msg.name || (msg.is_user ? 'User' : 'Character');
            return `[${sender}]: ${msg.mes}`;
        }).join('\n');
    } catch (e) {
        console.warn('[NWST Timeskip] Could not gather recent visible chat context:', e);
        return '';
    }
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
    const currentDay = getCurrentDay(chatId);
    const currentDayCount = (currentDay && typeof currentDay.dayCount === 'number') ? currentDay.dayCount : null;
    const currentElapsedDay = (currentDay && Number.isInteger(currentDay.elapsedStoryDays)) ? currentDay.elapsedStoryDays : 0;

    // Only explicit LLM decisions mutate existing events. Omission means
    // "unchanged", not "resolved" — otherwise a truncated or incomplete
    // response can silently close unrelated future events.
    for (const id of (updates.resolved || [])) {
        const event = events.find(e => e.id === id);
        if (event) {
            event.status = 'resolved';
            event.resolveDay = currentDayCount;
            event.resolveElapsedDay = currentElapsedDay;
        }
    }

    for (const id of (updates.missed || [])) {
        const event = events.find(e => e.id === id);
        if (event) {
            event.status = 'missed';
            event.resolveDay = currentDayCount;
            event.resolveElapsedDay = currentElapsedDay;
        }
    }

    // The undetermined tier is protected — deliberately timeless — so it is
    // neither a valid source nor a valid target for automated tier changes.
    const VALID_TIERS = ['immediate', 'week', 'month'];
    const tierChanges = (updates.tierChanges && typeof updates.tierChanges === 'object') ? updates.tierChanges : {};
    for (const [id, tier] of Object.entries(tierChanges)) {
        const event = events.find(e => e.id === id);
        if (event && event.tier !== 'undetermined' && VALID_TIERS.includes(tier) && event.tier !== tier) {
            event.tier = tier;
            event.tierSetDay = currentDayCount;
            event.tierSetElapsedDay = currentElapsedDay;
        }
    }

    // Re-apply structural placement to every concretely dated active event.
    // Time Skip may change the current month by many days at once; dated events
    // therefore move into/out of the internal Future Scheduled queue based on
    // the new canonical date. Omission still does NOT auto-resolve or auto-miss
    // an event; only explicit LLM decisions can conclude one here.
    for (const event of events) {
        if (event.status !== 'pending' && event.status !== 'inprogress') continue;
        if (event.tier === 'undetermined' && typeof event.scheduledElapsedStart !== 'number') continue;
        const structuralTier = classifyScheduledEventTier(chatId, event.scheduledElapsedStart, event.scheduledElapsedEnd);
        if (structuralTier && structuralTier !== 'missed' && event.tier !== structuralTier) {
            event.tier = structuralTier;
            event.tierSetDay = currentDayCount;
            event.tierSetElapsedDay = currentElapsedDay;
        }
    }

    // Persist the modified events array (getAllEvents returns a deep clone,
    // so modifications must be saved back explicitly)
    await saveAllEvents(chatId, events);

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
    const CORE_FIELDS = ['unresolvedDetail', 'promiseThreatDeadline', 'offscreenPressure', 'doNotForget'];
    const MYSTERY_FIELDS = ['establishedFacts', 'plantedDetails', 'characterWhereabouts', 'inconsistenciesFlagged', 'currentToneAtmosphere'];

    const applyRemovals = (section, removals, allowedFields) => {
        if (!removals || typeof removals !== 'object') return;
        for (const [fieldName, indexes] of Object.entries(removals)) {
            if (!allowedFields.includes(fieldName) || !Array.isArray(indexes) || !Array.isArray(section[fieldName])) continue;
            const validIndexes = [...new Set(indexes)]
                .filter(index => Number.isInteger(index) && index >= 0 && index < section[fieldName].length)
                .sort((a, b) => b - a);
            for (const index of validIndexes) {
                section[fieldName].splice(index, 1);
            }
        }
    };

    const applyAdditions = (section, additions, allowedFields) => {
        if (!additions || typeof additions !== 'object') return;
        for (const [fieldName, bullets] of Object.entries(additions)) {
            if (!allowedFields.includes(fieldName) || !Array.isArray(bullets) || !Array.isArray(section[fieldName])) continue;
            for (const bullet of bullets) {
                if (typeof bullet !== 'string') continue;
                const trimmed = bullet.trim();
                if (trimmed && !section[fieldName].includes(trimmed)) {
                    section[fieldName].push(trimmed);
                }
            }
        }
    };

    applyRemovals(notebook.core, updates.removeCoreBullets, CORE_FIELDS);
    applyAdditions(notebook.core, updates.addCoreBullets, CORE_FIELDS);
    applyRemovals(notebook.mystery, updates.removeMysteryBullets, MYSTERY_FIELDS);
    applyAdditions(notebook.mystery, updates.addMysteryBullets, MYSTERY_FIELDS);

    await saveNotebook(chatId, notebook);
    dlog('[NWST Timeskip] Notebook updates applied.');
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
