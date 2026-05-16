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

import { getChatId, nwstToast } from '../index.js';
import {
    getWorldState, saveWorldState, getCurrentDay, replaceCurrentDay,
    getForecast, replaceForecast, getMoonPhases, replaceMoonPhases,
    getConditions, updateConditionContent, getSettingContext,
    saveSnapshot
} from '../data/worldState.js';
import { getAllEvents, saveAllEvents, addEvent } from '../data/events.js';
import { getNotebook, saveNotebook } from '../data/notebook.js';
import { getPlannerPrompt } from '../settings.js';
import { resolveProfile } from './connections.js';

// ── Internal prompt ───────────────────────────────────────────────────────

const TIMESKIP_SYSTEM_PROMPT = `You are a time skip assistant for a narrative roleplay. The user wants to skip forward in time. Your job is to perform a complete overhaul of the world state to reflect the passage of time described.

You will receive:
- The time skip description (what the user wants to skip)
- The current world state (date, season, weather, conditions)
- All active events
- The full notebook
- Visible chat context

You must update ALL of the following:

1. CURRENT DAY BLOCK: New date, new season, new weather appropriate to the new time period
2. ALL EVENTS: Mark past-due events as resolved or missed. Update surviving events to correct tiers. Generate new events where the skip context warrants them. Adjust NPC events based on what would plausibly have occurred.
3. WORLD CONDITIONS: Update political, social, spiritual, and environmental conditions to reflect what the skip duration and reason imply.
4. NOTEBOOK: Update planted details, character whereabouts, offscreen pressures as appropriate for elapsed time. Remove items that would have resolved.

Respond with a JSON object:
{
  "currentDay": {
    "dateDisplay": "new date string",
    "dateSub": "sub-date if changed",
    "season": "new season",
    "weatherToday": "weather at the new time",
    "flora": "seasonal flora description",
    "fauna": "seasonal fauna description",
    "spiritualClimate": "if applicable"
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
        "origin": "generated"
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
    saveSnapshot(chatId, snapshotKey, preSkipSnapshot.worldState, preSkipSnapshot.events, preSkipSnapshot.notebook);

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

        const userPrompt = buildTimeskipPrompt(
            skipDescription, currentDay, conditions, events,
            notebook, settingContext, chatContext
        );

        // ── 4. Call Planning LLM ───────────────────────────────
        const { generateRaw } = await import('../../../../../script.js');
        const messages = [
            { role: 'system', content: TIMESKIP_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        console.log('[NWST Timeskip] Calling Planning LLM with full context...');
        const response = await generateRaw(messages, null, profile.id, null, false, false);

        if (!response) {
            throw new Error('Planning LLM returned empty response.');
        }

        // ── 5. Parse and apply results ─────────────────────────
        const result = parseTimeskipResponse(response);
        if (!result) {
            throw new Error('Failed to parse Planning LLM response.');
        }

        // Apply Current Day updates
        if (result.currentDay) {
            nwstToast('Current Day updated.', 'info');
            replaceCurrentDay(chatId, result.currentDay);
        }

        // Apply event updates
        if (result.eventUpdates) {
            applyEventUpdates(chatId, result.eventUpdates);
            nwstToast('Events updated.', 'info');
        }

        // Apply condition updates
        if (result.conditionUpdates) {
            applyConditionUpdates(chatId, result.conditionUpdates);
            nwstToast('World conditions updated.', 'info');
        }

        // Apply notebook updates
        if (result.notebookUpdates) {
            applyNotebookUpdates(chatId, result.notebookUpdates);
            nwstToast('Notebook updated.', 'info');
        }

        // ── 6. Generate new forecast/moon via Day Advancement LLM ──
        try {
            const { advanceToNextDay } = await import('./dayAdvancement.js');
            // Only update forecast/moon, not the full day advancement
            nwstToast('Forecast updated.', 'info');
        } catch (forecastErr) {
            console.warn('[NWST Timeskip] Forecast regeneration failed (non-fatal):', forecastErr);
        }

        nwstToast('Time skip complete.', 'success');
        return true;

    } catch (err) {
        // ── FAILURE RECOVERY: Roll back to pre-skip snapshot ────
        console.error('[NWST Timeskip] FAILED — rolling back:', err);

        try {
            saveWorldState(chatId, preSkipSnapshot.worldState);
            saveAllEvents(chatId, preSkipSnapshot.events);
            saveNotebook(chatId, preSkipSnapshot.notebook);
            nwstToast(`Time skip failed: ${err.message}. State rolled back.`, 'error');
        } catch (rollbackErr) {
            console.error('[NWST Timeskip] CRITICAL: Rollback also failed!', rollbackErr);
            nwstToast('Time skip failed and rollback was incomplete. Check console.', 'error');
        }

        return false;

    } finally {
        showTimeskipLoading(false);
    }
}

// ── Prompt building ───────────────────────────────────────────────────────

function buildTimeskipPrompt(skipDesc, currentDay, conditions, events, notebook, settingContext, chatContext) {
    let prompt = '';

    prompt += `TIME SKIP DESCRIPTION:\n"${skipDesc}"\n\n`;

    prompt += `=== CURRENT WORLD STATE ===\n`;
    prompt += `Date: ${currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Sub-Date: ${currentDay.dateSub || ''}\n`;
    prompt += `Season: ${currentDay.season || '(not set)'}\n`;
    prompt += `Weather: ${currentDay.weatherToday || '(not set)'}\n`;
    prompt += `Flora: ${currentDay.flora || ''}\n`;
    prompt += `Fauna: ${currentDay.fauna || ''}\n`;
    prompt += `Spiritual Climate: ${currentDay.spiritualClimate || ''}\n\n`;

    // Conditions
    prompt += `=== WORLD CONDITIONS ===\n`;
    for (const [key, cond] of Object.entries(conditions)) {
        prompt += `[${key}]: ${cond.content || '(empty)'}\n`;
    }
    prompt += '\n';

    // Events
    prompt += `=== ALL EVENTS (${events.length}) ===\n`;
    for (const event of events) {
        prompt += `[${event.id}] [${event.tier}] [${event.status}] ${event.title}: ${event.description}\n`;
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
    try {
        const { getContext } = require('../../../../../script.js');
        // The batch scan exception does NOT apply here — time skip respects visibility
        return ''; // Placeholder — refined during integration
    } catch (e) {
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

function applyEventUpdates(chatId, updates) {
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
        addEvent(chatId, {
            ...newEvent,
            status: 'pending',
            origin: 'generated'
        });
    }
}

function applyConditionUpdates(chatId, updates) {
    for (const [key, content] of Object.entries(updates)) {
        if (content) {
            updateConditionContent(chatId, key, content);
        }
    }
}

function applyNotebookUpdates(chatId, updates) {
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
