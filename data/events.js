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
//   tier: "immediate" | "week" | "month" | "undetermined",
//   status: "pending" | "inprogress" | "resolved" | "missed",
//   isNPC: boolean,
//   npcOrigin: "detected" | "generated" | null,  // null when isNPC is false
//   origin: "detected" | "generated",              // applies to all events
//   timestamp: number
// }
// =============================================================================

import {
    getChatData,
    setChatData,
    deleteChatData
} from './storage.js';

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
    const newEvent = {
        id: eventData.id || generateEventId(),
        title: eventData.title || '',
        description: eventData.description || '',
        tier: eventData.tier || 'undetermined',
        status: eventData.status || 'pending',
        isNPC: eventData.isNPC || false,
        npcOrigin: eventData.isNPC ? (eventData.npcOrigin || 'detected') : null,
        origin: eventData.origin || 'detected',
        timestamp: eventData.timestamp || Date.now()
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
    return updateEvent(chatId, eventId, { status: newStatus });
}

/**
 * Mark an event as resolved.
 * @param {string} chatId
 * @param {string} eventId
 * @returns {object|null}
 */
export async function resolveEvent(chatId, eventId) {
    return setEventStatus(chatId, eventId, 'resolved');
}

/**
 * Mark an event as missed (past due, never addressed).
 * @param {string} chatId
 * @param {string} eventId
 * @returns {object|null}
 */
export async function missEvent(chatId, eventId) {
    return setEventStatus(chatId, eventId, 'missed');
}

// ── Tier management ───────────────────────────────────────────────────────

/**
 * Change an event's tier.
 * @param {string} chatId
 * @param {string} eventId
 * @param {string} newTier - 'immediate' | 'week' | 'month' | 'undetermined'
 * @returns {object|null}
 */
export async function setEventTier(chatId, eventId, newTier) {
    const validTiers = ['immediate', 'week', 'month', 'undetermined'];
    if (!validTiers.includes(newTier)) {
        console.error(`[NWST Events] Invalid tier: ${newTier}`);
        return null;
    }
    return updateEvent(chatId, eventId, { tier: newTier });
}

// ── Queries (filtered views used by UI and prompt injection) ──────────────

/**
 * Get events filtered by tier.
 * @param {string} chatId
 * @param {string} tier - 'immediate' | 'week' | 'month' | 'undetermined'
 * @returns {object[]} Events in that tier
 */
export function getEventsByTier(chatId, tier) {
    const events = getAllEvents(chatId);
    return events.filter(e => e.tier === tier);
}

/**
 * Get events filtered by status.
 * @param {string} chatId
 * @param {string} status - 'pending' | 'inprogress' | 'resolved' | 'missed'
 * @returns {object[]}
 */
export function getEventsByStatus(chatId, status) {
    const events = getAllEvents(chatId);
    return events.filter(e => e.status === status);
}

/**
 * Get only ACTIVE events (pending or in-progress).
 * Used for prompt injection — resolved and missed events are excluded.
 * @param {string} chatId
 * @returns {object[]} Active events
 */
export function getActiveEvents(chatId) {
    const events = getAllEvents(chatId);
    return events.filter(e => e.status === 'pending' || e.status === 'inprogress');
}

/**
 * Get NPC-only events.
 * @param {string} chatId
 * @returns {object[]} Events where isNPC is true
 */
export function getNPCEvents(chatId) {
    const events = getAllEvents(chatId);
    return events.filter(e => e.isNPC === true);
}

/**
 * Get events by origin type.
 * @param {string} chatId
 * @param {string} origin - 'detected' | 'generated'
 * @returns {object[]}
 */
export function getEventsByOrigin(chatId, origin) {
    const events = getAllEvents(chatId);
    return events.filter(e => e.origin === origin);
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
 * This is called during day advancement to update event tiers appropriately:
 *   - Immediate events that are past-due → marked missed
 *   - Week events may become immediate
 *   - Month events may become week
 *   - Undetermined events stay unchanged
 *
 * The exact logic depends on the narrative context and is ultimately decided
 * by the Planning LLM. This function provides the structural update only.
 *
 * @param {string} chatId
 * @param {object} tierChanges - Object mapping event IDs to their new tiers
 *   e.g., { "evt_123": "missed", "evt_456": "immediate" }
 */
export async function rollEventHorizon(chatId, tierChanges) {
    const events = getAllEvents(chatId);
    for (const event of events) {
        if (tierChanges[event.id]) {
            const newTier = tierChanges[event.id];
            if (newTier === 'missed') {
                event.status = 'missed';
            } else {
                event.tier = newTier;
            }
        }
    }
    await saveAllEvents(chatId, events);
}

// ── Bulk operations ───────────────────────────────────────────────────────

/**
 * Delete all events for a chat.
 * @param {string} chatId
 */
export function clearAllEvents(chatId) {
    deleteChatData(chatId, 'events');
}

/**
 * Get the total count of events for a chat.
 * @param {string} chatId
 * @returns {number}
 */
export function getEventCount(chatId) {
    const events = getAllEvents(chatId);
    return events.length;
}
