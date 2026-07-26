/* eslint-disable */
// =============================================================================
// NWST Events Data Module — data/events.js
// =============================================================================
// Typed CRUD operations for the events array (per chat).
// All storage goes through storage.js.
//
// Event structure:
// {
//   id: string,
//   title: string,
//   description: string,
//   tier: "immediate" | "week" | "month" | "undetermined" | "future", // "future" is internal/invisible
//   status: "pending" | "inprogress" | "resolved" | "missed",
//   isNPC: boolean,
//   npcOrigin: "detected" | "generated" | null,  // null when isNPC is false
//   origin: "detected" | "generated",              // applies to all events
//   timestamp: number,                             // auto-set on creation
//   scheduledDate: string | null,                  // free-form narrative time, e.g. "Day 3", "March 15"
//   scheduledElapsedStart/End: number | null,       // elapsed-story-day occurrence window for one-time scheduling
//   resolveElapsedDay: number | null,              // elapsedStoryDays when status changed to resolved/missed
//   tierSetElapsedDay: number | null,              // elapsedStoryDays when the event entered its current tier
//   participants: string[],                        // character names involved in the event (auto-populated or manually set)
//   promotedSecretId: string | null,               // if this event was promoted to a secret, the secret's ID
//   knowledgeSummary: string | null                // free-form description of information asymmetry (who knows what about this event's resolution)
// }
// =============================================================================

import {
    getChatData,
    setChatData
} from './storage.js';

import { getCurrentDay, getCalendarConfig } from './worldState.js';
import { extractYearFromText, dateFromDayCount, resolveScheduledElapsedWindow, parseCurrentCalendarDate, monthLengthsFor, weekdayIndexFromDisplay } from '../lib/calendarMath.js';
import { getNotebook } from './notebook.js';
import { dlog } from "../lib/debug.js";
import { getChatId } from '../utils.js';

// ── Unique ID generator ───────────────────────────────────────────────────

/**
 * Generate a unique event ID.
 * Uses crypto.randomUUID() when available, falls back to timestamp + random.
 * @returns {string} A unique ID string
 */
function generateEventId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback: timestamp + random suffix
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}


function computeScheduledElapsedWindow(chatId, scheduledDate) {
    if (!scheduledDate) return { start: null, end: null };
    try {
        const day = getCurrentDay(chatId);
        const cfg = getCalendarConfig(chatId);
        const currentDayCount = Number.isInteger(day?.dayCount) && day.dayCount > 0 ? day.dayCount : 1;
        const currentElapsed = Number.isInteger(day?.elapsedStoryDays) && day.elapsedStoryDays >= 0 ? day.elapsedStoryDays : 0;
        const year = extractYearFromText(day?.dateSub || '') ?? extractYearFromText(day?.dateDisplay || '') ?? 1;
        const currentDate = dateFromDayCount(currentDayCount, year, cfg);
        const resolved = resolveScheduledElapsedWindow(
            scheduledDate,
            currentDate,
            currentDayCount,
            currentElapsed,
            cfg
        );
        return resolved ? { start: resolved.start, end: resolved.end } : { start: null, end: null };
    } catch (e) {
        return { start: null, end: null };
    }
}


function getTimingContext(chatId) {
    try {
        const day = getCurrentDay(chatId);
        const cfg = getCalendarConfig(chatId);
        const currentDayCount = Number.isInteger(day?.dayCount) && day.dayCount > 0 ? day.dayCount : 1;
        const currentElapsed = Number.isInteger(day?.elapsedStoryDays) && day.elapsedStoryDays >= 0 ? day.elapsedStoryDays : 0;
        const parsedDate = parseCurrentCalendarDate(day?.dateDisplay || '', day?.dateSub || '', cfg, false);
        const year = parsedDate?.year ?? extractYearFromText(day?.dateSub || '') ?? extractYearFromText(day?.dateDisplay || '') ?? 1;
        const currentDate = parsedDate || dateFromDayCount(currentDayCount, year, cfg);
        const weekLength = Array.isArray(cfg?.weekDays) && cfg.weekDays.length > 0 ? cfg.weekDays.length : 7;
        const weekdayIndex = weekdayIndexFromDisplay(day?.dateDisplay || '', cfg);
        const daysUntilWeekEnd = Number.isInteger(weekdayIndex) ? (weekLength - 1 - weekdayIndex) : (weekLength - 1);
        const monthLengths = monthLengthsFor(cfg, currentDate.year);
        const monthLength = monthLengths[currentDate.month - 1] || 0;
        const daysUntilMonthEnd = Math.max(0, monthLength - currentDate.day);
        return { day, cfg, currentDate, currentDayCount, currentElapsed, daysUntilWeekEnd, daysUntilMonthEnd };
    } catch (e) {
        return null;
    }
}

/**
 * Structurally place a concretely scheduled event into the visible horizon.
 * "future" is an internal queue for dated events beyond the current calendar
 * month; it is intentionally excluded from normal UI and prompt injection.
 * Tighter horizons win across boundaries: today/tomorrow, then current week,
 * then current calendar month, then future.
 */
export function classifyScheduledEventTier(chatId, scheduledElapsedStart, scheduledElapsedEnd = scheduledElapsedStart) {
    if (typeof scheduledElapsedStart !== 'number') return null;
    const ctx = getTimingContext(chatId);
    if (!ctx) return null;
    const end = typeof scheduledElapsedEnd === 'number' ? scheduledElapsedEnd : scheduledElapsedStart;
    if (ctx.currentElapsed > end) return 'missed';
    const daysUntilStart = scheduledElapsedStart - ctx.currentElapsed;
    if (daysUntilStart <= 1) return 'immediate';
    if (daysUntilStart <= ctx.daysUntilWeekEnd) return 'week';
    if (daysUntilStart <= ctx.daysUntilMonthEnd) return 'month';
    return 'future';
}

/** Resolve a free-form scheduledDate and return its structural horizon. */
export function getStructuralTierForScheduledDate(chatId, scheduledDate) {
    const window = computeScheduledElapsedWindow(chatId, scheduledDate);
    return {
        tier: classifyScheduledEventTier(chatId, window.start, window.end),
        start: window.start,
        end: window.end
    };
}

// ── Core CRUD ─────────────────────────────────────────────────────────────

/**
 * Get all events for a chat.
 * @param {string} chatId
 * @returns {object[]} Array of event objects (deep cloned)
 */
export function getAllEvents(chatId) {
    return getChatData(chatId, 'events');
}

/**
 * Save the complete events array for a chat.
 * @param {string} chatId
 * @param {object[]} events - Complete events array
 */
export async function saveAllEvents(chatId, events) {
    await setChatData(chatId, 'events', events);
}

/**
 * Get a single event by its ID.
 * @param {string} chatId
 * @param {string} eventId
 * @returns {object|null} The event object, or null if not found
 */
export function getEventById(chatId, eventId) {
    const events = getAllEvents(chatId);
    return events.find(e => e.id === eventId) || null;
}

/**
 * Add a new event to the chat.
 * Automatically assigns a unique ID and timestamp.
 * @param {string} chatId
 * @param {object} eventData - Event fields (id and timestamp auto-generated if not provided)
 * @returns {object} The newly created event
 */
export async function addEvent(chatId, eventData) {
    const events = getAllEvents(chatId);
    // Stamp the story day the event enters its tier — the day-advance review
    // uses this to age undated events ("in this tier for N story days").
    let _createdDayCount = null;
    let _createdElapsedDay = 0;
    try {
        const _day = getCurrentDay(chatId);
        if (_day && typeof _day.dayCount === 'number') _createdDayCount = _day.dayCount;
        if (_day && Number.isInteger(_day.elapsedStoryDays) && _day.elapsedStoryDays >= 0) _createdElapsedDay = _day.elapsedStoryDays;
    } catch (e) { /* non-fatal */ }
    const _scheduleWindow = computeScheduledElapsedWindow(chatId, eventData.scheduledDate || null);
    const _scheduledTier = classifyScheduledEventTier(chatId, _scheduleWindow.start, _scheduleWindow.end);
    const newEvent = {
        id: eventData.id || generateEventId(),
        title: eventData.title || '',
        description: eventData.description || '',
        tier: (_scheduledTier && _scheduledTier !== 'missed') ? _scheduledTier : (eventData.tier || 'undetermined'),
        status: eventData.status || 'pending',
        isNPC: eventData.isNPC || false,
        npcOrigin: eventData.isNPC ? (eventData.npcOrigin || 'detected') : null,
        origin: eventData.origin || 'detected',
        timestamp: eventData.timestamp || Date.now(),
        scheduledDate: eventData.scheduledDate || null,
        scheduledElapsedStart: (typeof eventData.scheduledElapsedStart === 'number') ? eventData.scheduledElapsedStart : _scheduleWindow.start,
        scheduledElapsedEnd: (typeof eventData.scheduledElapsedEnd === 'number') ? eventData.scheduledElapsedEnd : _scheduleWindow.end,
        resolveDay: null, // Legacy compatibility field
        resolveElapsedDay: null,
        participants: eventData.participants || [],
        promotedSecretId: eventData.promotedSecretId || null,
        knowledgeSummary: eventData.knowledgeSummary || null,
        tierSetDay: (typeof eventData.tierSetDay === 'number') ? eventData.tierSetDay : _createdDayCount, // legacy compatibility
        tierSetElapsedDay: (typeof eventData.tierSetElapsedDay === 'number') ? eventData.tierSetElapsedDay : _createdElapsedDay,
        // Special-day materialization bookkeeping (see data/specialDays.js):
        // category chip for the UI, source link, and the per-occurrence dedup key.
        specialDayCategory: eventData.specialDayCategory || null,
        sourceSpecialDayId: eventData.sourceSpecialDayId || null,
        occurrenceDay: (typeof eventData.occurrenceDay === 'number') ? eventData.occurrenceDay : null,
        occurrenceKey: eventData.occurrenceKey || null
    };
    events.push(newEvent);
    await saveAllEvents(chatId, events);
    return newEvent;
}

/**
 * Update an existing event by ID. Only provided fields are changed.
 * @param {string} chatId
 * @param {string} eventId
 * @param {object} updates - Partial event fields to update
 * @returns {object|null} The updated event, or null if not found
 */
export async function updateEvent(chatId, eventId, updates) {
    const events = getAllEvents(chatId);
    const index = events.findIndex(e => e.id === eventId);
    if (index === -1) return null;

    // Re-stamp the in-tier age whenever the tier actually changes (unless the
    // caller supplied an explicit stamp).
    if (updates.tier !== undefined && updates.tier !== events[index].tier && updates.tierSetElapsedDay === undefined) {
        try {
            const day = getCurrentDay(chatId);
            updates = {
                ...updates,
                tierSetDay: (day && typeof day.dayCount === 'number') ? day.dayCount : null,
                tierSetElapsedDay: (day && Number.isInteger(day.elapsedStoryDays)) ? day.elapsedStoryDays : 0
            };
        } catch (e) { /* non-fatal */ }
    }

    // A changed schedule is resolved immediately against the current cyclical
    // calendar position, then stored as a one-time elapsed occurrence window.
    if (updates.scheduledDate !== undefined && updates.scheduledDate !== events[index].scheduledDate) {
        const window = computeScheduledElapsedWindow(chatId, updates.scheduledDate);
        updates = { ...updates, scheduledElapsedStart: window.start, scheduledElapsedEnd: window.end };
    }

    // Concrete dates outrank LLM/manual horizon guesses. Any parseable dated
    // event is structurally placed into Immediate / This Week / This Month, or
    // the internal Future Scheduled queue. Undated events keep their supplied
    // tier and remain eligible for narrative re-tiering.
    const finalStart = updates.scheduledElapsedStart !== undefined ? updates.scheduledElapsedStart : events[index].scheduledElapsedStart;
    const finalEnd = updates.scheduledElapsedEnd !== undefined ? updates.scheduledElapsedEnd : events[index].scheduledElapsedEnd;
    const scheduledTier = classifyScheduledEventTier(chatId, finalStart, finalEnd);
    if (scheduledTier && scheduledTier !== 'missed') {
        updates = { ...updates, tier: scheduledTier };
    }

    events[index] = { ...events[index], ...updates };
    await saveAllEvents(chatId, events);
    return events[index];
}

/**
 * Delete an event by ID.
 * @param {string} chatId
 * @param {string} eventId
 * @returns {boolean} True if deleted, false if not found
 */
export async function deleteEvent(chatId, eventId) {
    const events = getAllEvents(chatId);
    const index = events.findIndex(e => e.id === eventId);
    if (index === -1) return false;

    events.splice(index, 1);
    await saveAllEvents(chatId, events);
    return true;
}

// ── Status management ─────────────────────────────────────────────────────

/**
 * Change an event's status.
 * When setting to 'resolved' or 'missed', also records elapsedStoryDays in
 * resolveElapsedDay for Event Horizon Compaction. resolveDay remains only as
 * a legacy compatibility field.
 *
 * When a resolved/missed event has participants with known information asymmetry
 * AND the autoPromoteEvents setting is enabled, the event is automatically
 * promoted to a secret in the Notebook.
 *
 * @param {string} chatId
 * @param {string} eventId
 * @param {string} newStatus - 'pending' | 'inprogress' | 'resolved' | 'missed'
 * @returns {object|null} The updated event
 */
export async function setEventStatus(chatId, eventId, newStatus) {
    const validStatuses = ['pending', 'inprogress', 'resolved', 'missed'];
    if (!validStatuses.includes(newStatus)) {
        console.error(`[NWST Events] Invalid status: ${newStatus}`);
        return null;
    }

    // When resolving or missing an event, record the current story day
    // so Event Horizon Compaction can determine when it's old enough to compact.
    let resolveDay = null;
    let resolveElapsedDay = null;
    if (newStatus === 'resolved' || newStatus === 'missed') {
        try {
            const currentDay = getCurrentDay(chatId);
            resolveDay = currentDay?.dayCount || null;
            resolveElapsedDay = Number.isInteger(currentDay?.elapsedStoryDays) ? currentDay.elapsedStoryDays : 0;
        } catch (e) {
            // Non-fatal — resolveDay stays null for legacy compatibility
            console.warn('[NWST Events] Could not read current day for resolveDay:', e);
        }
    }

    // Update the event status
    const updated = await updateEvent(chatId, eventId, { status: newStatus, resolveDay, resolveElapsedDay });
    if (!updated) return null;

    // NOTE: Promotion to secret is intentionally NOT automatic here. Concluded
    // events are assessed for concealed knowledge by the Planning LLM during the
    // day-advance event review (llm/eventValidity.js), which queues candidates
    // for the player's decision in the Events tab. Manual promotion via the
    // event card's Promote button remains available.

    return updated;
}

// ── Event→Secret Promotion ────────────────────────────────────────────────

/**
 * Determine the most appropriate secret type for an event based on its
 * participants, status, and narrative context.
 * @param {object} event - The event object
 * @param {object} [options] - Promotion options
 * @param {string[]} [options.whoKnows] - Characters who know the truth
 * @param {string[]} [options.whoDoesNotKnow] - Characters kept in the dark
 * @returns {string} Secret type: 'character' | 'dramatic_irony' | 'world'
 */
function inferSecretType(event, options = {}) {
    const whoKnows = options.whoKnows || [];
    const whoDoesNotKnow = options.whoDoesNotKnow || [];

    // Dramatic irony: the audience/user-PC knows but characters don't
    if (whoKnows.length > 0 && whoDoesNotKnow.length > 0) {
        return 'dramatic_irony';
    }
    // Character secret: one or more specific characters know
    if (whoKnows.length > 0) {
        return 'character';
    }
    // World secret: affects the world state broadly
    if (event.tier === 'month' || event.isNPC) {
        return 'world';
    }
    return 'character';
}

/**
 * Promote a resolved/missed event to a structured secret in the Notebook.
 *
 * Information asymmetry arises when some characters know about an event's
 * resolution while others don't. This function creates a secret that tracks
 * exactly who knows and who doesn't, preserving the narrative tension.
 *
 * If no whoKnows/whoDoesNotKnow lists are provided, the function attempts
 * to infer them from the event's participants (all participants assumed to know).
 *
 * @param {string} chatId
 * @param {string} eventId
 * @param {object} [options] - Promotion options
 * @param {string[]} [options.whoKnows] - Character names who know about the event/resolution
 * @param {string[]} [options.whoDoesNotKnow] - Character names who are unaware
 * @param {string} [options.type] - Override secret type (auto-inferred if omitted)
 * @param {object} [options.customSecret] - Full secret overrides (for fine-grained control)
 * @param {boolean} [options.autoPromoted=false] - Whether this was triggered automatically (vs manual)
 * @returns {Promise<object|null>} The created secret, or null on failure
 */
/**
 * Extract distinctive subject-matter words from an event's actual title and
 * description, for use as secret trigger anchors. This gives promoted-event
 * secrets real anchor words to match against prose, instead of relying only
 * on the templated pressureRisk/revealConditions boilerplate (which is generic
 * and produces weak anchor matching).
 * @param {object} event
 * @returns {object} triggerAnchors object for the scoring engine
 */
function buildEventAnchors(event) {
    const ANCHOR_STOP = new Set([
        'this','that','with','from','they','them','their','there','where','when',
        'what','which','would','could','should','about','into','over','under',
        'been','have','will','still','some','more','very','than','then','only',
        'event','events','scheduled','originally','resolved','missed','status',
        'character','characters','will','being','these','those','such','they',
        'after','before','during','through','where','while','because','around'
    ]);
    const phrases = new Set();
    const sources = [event.title, event.description];
    for (const src of sources) {
        if (typeof src !== 'string') continue;
        const words = src.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .match(/\b[a-z]{5,}\b/g) || [];
        for (const w of words) {
            if (!ANCHOR_STOP.has(w)) phrases.add(w);
        }
    }
    return {
        characters: Array.isArray(event.participants) ? event.participants.slice() : [],
        phrases: Array.from(phrases).slice(0, 12)  // cap to keep it focused
    };
}

export async function promoteEventToSecret(chatId, eventId, options = {}) {
    try {
        const events = getAllEvents(chatId);
        const event = events.find(e => e.id === eventId);
        if (!event) {
            console.error(`[NWST Events] Cannot promote: event ${eventId} not found.`);
            return null;
        }

        // Prevent double-promotion
        if (event.promotedSecretId) {
            console.warn(`[NWST Events] Event "${event.title}" already promoted to secret ${event.promotedSecretId}.`);
            return null;
        }

        // Only resolved/missed events can be promoted
        if (event.status !== 'resolved' && event.status !== 'missed') {
            console.warn(`[NWST Events] Cannot promote event "${event.title}" with status "${event.status}". Only resolved/missed events can be promoted.`);
            return null;
        }

        // ── Intelligent knowledge distribution (auto-promotion path) ──────
        // When auto-promoted without explicit whoKnows/whoDoesNotKnow, use an
        // LLM call to determine which participants know about the resolution
        // and which are unaware — instead of assuming all participants know.
        let { whoKnows, whoDoesNotKnow } = options;

        if (options.autoPromoted && (!whoKnows || !whoDoesNotKnow)) {
            const llmResult = await inferKnowledgeDistribution(chatId, event);
            if (llmResult) {
                whoKnows = llmResult.whoKnows;
                whoDoesNotKnow = llmResult.whoDoesNotKnow;
            }
        }

        // Fallback: use participants list if LLM call failed or not auto-promoted
        if (!whoKnows || !Array.isArray(whoKnows)) {
            whoKnows = event.participants || [];
        }
        if (!whoDoesNotKnow || !Array.isArray(whoDoesNotKnow)) {
            whoDoesNotKnow = [];
        }

        const statusIcon = event.status === 'resolved' ? '✅' : '⏳';
        const title = options.customSecret?.title || `${statusIcon} ${event.title}`;
        const secretText = options.customSecret?.secret ||
            `Event "${event.title}" has been ${event.status}. ${event.description || ''}` +
            (event.scheduledDate ? ` (Originally scheduled: ${event.scheduledDate})` : '');

        const secretType = options.type || options.customSecret?.type || inferSecretType(event, { whoKnows, whoDoesNotKnow });

        const evidenceShown = options.customSecret?.evidenceShown ||
            (whoKnows.length > 0
                ? `Known to: ${whoKnows.join(', ')}`
                : '') +
            (whoDoesNotKnow.length > 0
                ? (whoKnows.length > 0 ? '; ' : '') + `Hidden from: ${whoDoesNotKnow.join(', ')}`
                : '');

        const pressureRisk = options.customSecret?.pressureRisk ||
            (whoDoesNotKnow.length > 0
                ? `Information asymmetry between ${whoKnows.join(', ')} and ${whoDoesNotKnow.join(', ')}`
                : 'No active knowledge conflict');

        const revealConditions = options.customSecret?.revealConditions ||
            `May be revealed when ${whoDoesNotKnow.length > 0 ? whoDoesNotKnow.join(' or ') : 'a relevant character'} discovers the truth about "${event.title}".`;

        // ── Create the secret in the Notebook ────────────────────────────
        const { addSecret } = await import('./notebook.js');
        const secret = await addSecret(chatId, {
            type: secretType,
            title: title,
            secret: secretText,
            whoKnows: whoKnows,
            whoDoesNotKnow: whoDoesNotKnow,
            evidenceShown: evidenceShown,
            pressureRisk: pressureRisk,
            revealConditions: revealConditions,
            injectionPriority: 'normal',
            // v2: give the scoring engine distinctive anchor words drawn from the
            // event's real title/description, so anchor matching works on promoted
            // secrets instead of relying only on templated boilerplate text.
            triggerAnchors: options.customSecret?.triggerAnchors || buildEventAnchors(event)
        });

        if (!secret) {
            console.error(`[NWST Events] Failed to create secret for event "${event.title}".`);
            return null;
        }

        // ── Record the promotion on the event ────────────────────────────
        const knowledgeSummary = options.customSecret?.knowledgeSummary ||
            `Promoted to secret on ${event.status}. ` +
            `Characters who know: ${whoKnows.length > 0 ? whoKnows.join(', ') : '(none specified)'}. ` +
            `Characters unaware: ${whoDoesNotKnow.length > 0 ? whoDoesNotKnow.join(', ') : '(none specified)'}.`;

        event.promotedSecretId = secret.id;
        event.knowledgeSummary = knowledgeSummary;
        await saveAllEvents(chatId, events);

        dlog(`[NWST Events] Promoted event "${event.title}" → secret "${secret.title}" (${secretType}, id: ${secret.id})`);

        return secret;

    } catch (e) {
        console.error(`[NWST Events] Failed to promote event ${eventId} to secret:`, e);
        return null;
    }
}

// ── Intelligent knowledge distribution (LLM-powered) ──────────────────────

/**
 * Use the Planning LLM to determine who knows and who doesn't know about
 * a resolved/missed event's outcome. This replaces the naive "all participants
 * know" approach with actual narrative analysis.
 *
 * @param {string} chatId - Chat that owns the event
 * @param {object} event - The event object being promoted
 * @returns {Promise<{whoKnows: string[], whoDoesNotKnow: string[], knowledgeSummary: string}|null>}
 *   Parsed result from the LLM, or null if the call fails or is unavailable
 */
async function inferKnowledgeDistribution(chatId, event) {
    try {
        if (getChatId() !== chatId) return null;

        const { resolveProfile, generateWithProfile } = await import('../llm/connections.js');
        const { LLM_TOKEN_BUDGETS } = await import('../llm/tokenBudgets.js');

        const profile = resolveProfile('planningLLM');
        if (!profile) {
            console.warn('[NWST Events] Cannot infer knowledge distribution: no Planning LLM profile configured.');
            return null;
        }


        const systemMessage = {
            role: 'system',
            content: 'You are a narrative analysis assistant. Given an event from a roleplay, determine which characters know about its resolution and which do not. Return ONLY valid JSON with no markdown formatting, no code fences, no extra text.'
        };

        const participantsList = (event.participants || []).join(', ') || 'none';
        const userMessage = {
            role: 'user',
            content: [
                `Analyze this resolved event for information asymmetry:`,
                ``,
                `Event Title: "${event.title}"`,
                `Status: ${event.status}`,
                `Description: ${event.description || '(no description)'}`,
                `Participants: ${participantsList}`,
                event.scheduledDate ? `Originally scheduled: ${event.scheduledDate}` : null,
                event.isNPC ? `Type: NPC event` : null,
                ``,
                `Determine which participants KNOW about this resolution and which are UNAWARE.`,
                `Consider: who was directly involved, who witnessed the outcome, who would logically`,
                `have been told afterward, and who would remain in the dark. For character secrets,`,
                `the knowledge asymmetry creates dramatic tension — be thoughtful.`,
                ``,
                `If this is a world event (weather disaster, political shift, festival) with no`,
                `specific knowledge asymmetry, assume ALL participants know and return an empty`,
                `whoDoesNotKnow list.`,
                ``,
                `Return ONLY this JSON structure (no markdown, no code fences):`,
                `{`,
                `  "whoKnows": ["character1", "character2"],`,
                `  "whoDoesNotKnow": ["character3"],`,
                `  "knowledgeSummary": "Brief explanation of who knows what and why"`,
                `}`
            ].filter(Boolean).join('\n')
        };

        const response = await generateWithProfile(profile, [systemMessage, userMessage], {
            maxTokens: LLM_TOKEN_BUDGETS.SMALL
        });
        if (getChatId() !== chatId) {
            dlog('[NWST Events] Discarded stale knowledge-distribution result because the active chat changed.');
            return null;
        }

        if (!response) {
            console.warn('[NWST Events] LLM returned empty response for knowledge distribution.');
            return null;
        }

        // Parse JSON from response — strip any markdown fences that may leak through
        let jsonStr = response.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
            jsonStr = fenceMatch[1].trim();
        }

        const result = JSON.parse(jsonStr);

        // Validate structure
        if (!Array.isArray(result.whoKnows) && !Array.isArray(result.whoDoesNotKnow)) {
            console.warn('[NWST Events] LLM returned invalid knowledge distribution structure:', result);
            return null;
        }

        // Filter to only known participants (LLM may invent names)
        const knownParticipants = new Set(event.participants || []);
        const filteredKnows = (result.whoKnows || []).filter(n => knownParticipants.has(n));
        const filteredNotKnows = (result.whoDoesNotKnow || []).filter(n => knownParticipants.has(n));

        // Remove overlap: if a character appears in both, they go to whoKnows
        const finalNotKnows = filteredNotKnows.filter(n => !filteredKnows.includes(n));

        dlog(`[NWST Events] Knowledge distribution inferred: knows=${filteredKnows.join(',') || 'none'}, unaware=${finalNotKnows.join(',') || 'none'}`);

        return {
            whoKnows: filteredKnows,
            whoDoesNotKnow: finalNotKnows,
            knowledgeSummary: result.knowledgeSummary || ''
        };

    } catch (e) {
        console.warn('[NWST Events] Failed to infer knowledge distribution (falling back to all participants):', e);
        return null;
    }
}

// ── Event Data Migration ──────────────────────────────────────────────────

/**
 * Migrate legacy event data to include new fields introduced in later versions.
 * Safe to call on any chat — checks each event for missing fields and fills defaults.
 *
 * Fields migrated:
 *   - participants: string[]     (default: [])
 *   - promotedSecretId: string|null (default: null)
 *   - knowledgeSummary: string|null (default: null)
 *   - resolveDay: number|null    (legacy compatibility)
 *   - resolveElapsedDay: number|null (duration bookkeeping)
 *   - tierSetElapsedDay: number|null (duration bookkeeping)
 *
 * @param {string} chatId
 * @returns {number} Number of events that were modified
 */
export async function migrateEventData(chatId) {
    const events = getAllEvents(chatId);
    if (!events || events.length === 0) return 0;

    let migrated = 0;
    for (const event of events) {
        let changed = false;

        if (!Array.isArray(event.participants)) {
            event.participants = [];
            changed = true;
        }
        if (event.promotedSecretId === undefined) {
            event.promotedSecretId = null;
            changed = true;
        }
        if (event.knowledgeSummary === undefined) {
            event.knowledgeSummary = null;
            changed = true;
        }
        if (event.resolveDay === undefined) {
            event.resolveDay = null;
            changed = true;
        }
        if (event.resolveElapsedDay === undefined) {
            event.resolveElapsedDay = null;
            changed = true;
        }
        if (event.tierSetElapsedDay === undefined) {
            event.tierSetElapsedDay = null;
            changed = true;
        }
        if (event.timingDismissedElapsedDay === undefined) {
            event.timingDismissedElapsedDay = null;
            changed = true;
        }
        if (event.scheduledElapsedStart === undefined) {
            event.scheduledElapsedStart = null;
            changed = true;
        }
        if (event.scheduledElapsedEnd === undefined) {
            event.scheduledElapsedEnd = null;
            changed = true;
        }
        if (event.occurrenceKey === undefined) {
            event.occurrenceKey = null;
            changed = true;
        }

        if (changed) migrated++;
    }

    if (migrated > 0) {
        await saveAllEvents(chatId, events);
        dlog(`[NWST Events] Migrated ${migrated}/${events.length} events for chat ${chatId}.`);
    } else {
        dlog(`[NWST Events] No event migration needed for chat ${chatId}.`);
    }

    return migrated;
}

// ── Tier management ───────────────────────────────────────────────────────

// ── Queries (filtered views used by UI and prompt injection) ──────────────

/**
 * Get only ACTIVE events (pending or in-progress).
 * Used for prompt injection — resolved and missed events are excluded.
 * @param {string} chatId
 * @returns {object[]} Active events
 */
export function getActiveEvents(chatId) {
    const events = getAllEvents(chatId);
    return events.filter(e =>
        (e.status === 'pending' || e.status === 'inprogress') && e.tier !== 'future'
    );
}

/**
 * Get all non-concluded events, including internally queued Future Scheduled
 * events. Used by scanner/planning dedup so hidden future commitments are not
 * rediscovered every cadence.
 */
export function getTrackedEvents(chatId) {
    const events = getAllEvents(chatId);
    return events.filter(e => e.status === 'pending' || e.status === 'inprogress');
}

/**
 * Get events grouped by tier (for UI display).
 * Returns an object with keys 'immediate', 'week', 'month', 'undetermined',
 * each containing an array of events.
 * @param {string} chatId
 * @returns {object} { immediate: [...], week: [...], month: [...], undetermined: [...] }
 */
export function getEventsGroupedByTier(chatId) {
    const events = getAllEvents(chatId);
    return {
        immediate: events.filter(e => e.tier === 'immediate'),
        week: events.filter(e => e.tier === 'week'),
        month: events.filter(e => e.tier === 'month'),
        undetermined: events.filter(e => e.tier === 'undetermined')
    };
}

// ── Event horizon roll (day advancement) ──────────────────────────────────

/**
 * Roll the event horizon forward by one day.
 * Applies tier/status changes that were already decided by the structural calendar
 * or an approved review result. Dated-event placement itself is deterministic; this
 * helper persists the requested move and stamps the appropriate timing markers.
 *
 * @param {string} chatId
 * @param {object} tierChanges - Object mapping event IDs to their new tiers
 *   e.g., { "evt_123": "missed", "evt_456": "immediate" }
 */
export async function rollEventHorizon(chatId, tierChanges) {
    const events = getAllEvents(chatId);
    let dayCount = null;
    let elapsedStoryDays = 0;
    try {
        const day = getCurrentDay(chatId);
        if (day && typeof day.dayCount === 'number') dayCount = day.dayCount;
        if (day && Number.isInteger(day.elapsedStoryDays)) elapsedStoryDays = day.elapsedStoryDays;
    } catch (e) { /* non-fatal */ }
    for (const event of events) {
        if (tierChanges[event.id]) {
            const newTier = tierChanges[event.id];
            if (newTier === 'missed') {
                event.status = 'missed';
                // Stamp resolveDay so Event Horizon Compaction can age these
                // out — previously roll-missed events never carried one and
                // therefore never compacted.
                if (typeof event.resolveDay !== 'number') event.resolveDay = dayCount;
                if (typeof event.resolveElapsedDay !== 'number') event.resolveElapsedDay = elapsedStoryDays;
            } else {
                event.tier = newTier;
                event.tierSetDay = dayCount;
                event.tierSetElapsedDay = elapsedStoryDays;
            }
        }
    }
    await saveAllEvents(chatId, events);
}

// ── Bulk operations ───────────────────────────────────────────────────────

/**
 * Remove a single concluded event from the active list, preserving a concise
 * summary in the Notebook's doNotForget section (same format as Event Horizon
 * Compaction). Used by the promotion review queue, where the event leaves the
 * list whether or not the player promotes it to a secret.
 * @param {string} chatId
 * @param {string} eventId
 * @returns {Promise<boolean>} true if the event was found and removed
 */
export async function removeEventWithSummary(chatId, eventId) {
    const events = getAllEvents(chatId);
    const event = events.find(e => e.id === eventId);
    if (!event) return false;

    try {
        const notebook = getNotebook(chatId);
        const doNotForget = notebook.core.doNotForget || [];
        const statusIcon = event.status === 'resolved' ? '✅' : '⏳';
        const tierTag = event.tier !== 'undetermined' ? ` [${event.tier}]` : '';
        const dateTag = event.scheduledDate ? ` (${event.scheduledDate})` : '';
        const resolveTag = typeof event.resolveElapsedDay === 'number' ? ` — Resolved after ${event.resolveElapsedDay} elapsed story day(s)` : '';
        let summary = `📋 ${statusIcon} ${event.title}: ${event.description}${tierTag}${dateTag}${resolveTag}`;
        if (summary.length > 300) summary = summary.substring(0, 297) + '...';
        const updatedDoNotForget = [...doNotForget, summary];
        if (updatedDoNotForget.length > 50) {
            updatedDoNotForget.splice(0, updatedDoNotForget.length - 50);
        }
        notebook.core.doNotForget = updatedDoNotForget;
        const { saveNotebook } = await import('./notebook.js');
        await saveNotebook(chatId, notebook);
    } catch (e) {
        console.warn('[NWST Events] Failed to write removal summary to notebook (event still removed):', e);
    }

    await saveAllEvents(chatId, events.filter(e => e.id !== eventId));
    return true;
}

/**
 * Remove legacy concluded events that were already promoted to Secrets but
 * remained in the visible Event list. The Secret is independent; preserve a
 * Past Events summary and remove the stale Event immediately.
 * @param {string} chatId
 * @returns {Promise<number>} number of lingering promoted events removed
 */
export async function cleanupPromotedConcludedEvents(chatId) {
    const lingeringIds = getAllEvents(chatId)
        .filter(event => (event.status === 'resolved' || event.status === 'missed') && event.promotedSecretId)
        .map(event => event.id);

    let removed = 0;
    for (const eventId of lingeringIds) {
        if (await removeEventWithSummary(chatId, eventId)) removed++;
    }
    return removed;
}

// ── Event Horizon Compaction ──────────────────────────────────────────────

/**
 * Compact stale resolved/missed events into the Notebook's "Past Events"
 * (doNotForget) section, then remove them from the active events array.
 *
 * This prevents the events list from accumulating narrative dead weight.
 * Resolved/missed events are not injected into the RP prompt (only active
 * events are), so they serve no purpose beyond historical reference.
 * Compaction moves them to doNotForget where the Planner LLM can reference
 * them during scans — but they are NOT injected into the main RP LLM.
 *
 * Compaction eligibility (MUST satisfy ALL):
 *   - Event status is 'resolved' or 'missed'
 *   - Event has a resolveElapsedDay set
 *   - Current elapsedStoryDays - resolveElapsedDay >= thresholdDays
 *
 * Events without resolveElapsedDay are NOT compacted until migration or a
 * later status update establishes the duration marker.
 *
 * The doNotForget field has a hard cap of 50 entries (FIFO eviction).
 *
 * @param {string} chatId
 * @param {number} [thresholdDays=0] - Story days after which a resolved/missed
 *   event is eligible for compaction.
 * @returns {Promise<{ compacted: number, summaries: string[], error?: string }>} Result info
 */
export async function compactEventHorizon(chatId, thresholdDays = 0) {
    try {
        const currentDay = getCurrentDay(chatId);
        const elapsedStoryDays = Number.isInteger(currentDay?.elapsedStoryDays) ? currentDay.elapsedStoryDays : 0;
        const events = getAllEvents(chatId);
        const notebook = getNotebook(chatId);
        const doNotForget = notebook.core.doNotForget || [];

        // Find compactable events
        const compactable = [];
        const remaining = [];

        for (const event of events) {
            const isStale = event.status === 'resolved' || event.status === 'missed';
            const hasResolveDay = typeof event.resolveElapsedDay === 'number';
            const pastThreshold = hasResolveDay && (elapsedStoryDays - event.resolveElapsedDay >= thresholdDays);
            // Events awaiting a player decision (promotion review or validity
            // review) must not be compacted out from under the pending card.
            const awaitingDecision = event.promotionFlag != null || event.validityFlag != null || event.timingFlag != null;

            // Promoted events are compactable too: the Notebook secret is
            // independent, and keeping the concluded Event only creates clutter.
            if (isStale && hasResolveDay && pastThreshold && !awaitingDecision) {
                compactable.push(event);
            } else {
                remaining.push(event);
            }
        }

        if (compactable.length === 0) {
            return { compacted: 0, summaries: [] };
        }

        // Generate summary strings for the Notebook's doNotForget section
        const summaries = [];
        for (const event of compactable) {
            const statusIcon = event.status === 'resolved' ? '✅' : '⏳';
            const tierTag = event.tier !== 'undetermined' ? ` [${event.tier}]` : '';
            const dateTag = event.scheduledDate ? ` (${event.scheduledDate})` : '';
            const summary = `📋 ${statusIcon} ${event.title}: ${event.description}${tierTag}${dateTag} — Resolved after ${event.resolveElapsedDay} elapsed story day(s)`;

            // Truncate overlong summaries (cap at 300 chars to keep the field tidy)
            summaries.push(summary.length > 300 ? summary.substring(0, 297) + '...' : summary);
        }

        // Add summaries to doNotForget (with FIFO cap of 50)
        const updatedDoNotForget = [...doNotForget, ...summaries];
        if (updatedDoNotForget.length > 50) {
            updatedDoNotForget.splice(0, updatedDoNotForget.length - 50);
        }

        notebook.core.doNotForget = updatedDoNotForget;
        const { saveNotebook } = await import('./notebook.js');
        await saveNotebook(chatId, notebook);
        await saveAllEvents(chatId, remaining);

        dlog(`[NWST Events] Compacted ${compactable.length} resolved/missed events into Past Events (doNotForget).`);

        return { compacted: compactable.length, summaries };

    } catch (e) {
        console.error('[NWST Events] Event Horizon Compaction failed:', e);
        return { compacted: 0, summaries: [], error: e.message };
    }
}
