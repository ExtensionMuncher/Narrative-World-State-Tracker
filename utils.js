/* eslint-disable */
// =============================================================================
// NWST Utilities — utils.js
// =============================================================================
// Standalone utility functions with NO imports from other NWST modules.
// This file exists specifically to break the circular dependency that occurs
// when LLM modules import getChatId/nwstToast from index.js while index.js
// dynamically imports from those same LLM modules.
//
// Import from here instead of index.js for these utilities.
// =============================================================================

const TOAST_PREFIX = 'Narrative World State Tracker';

/**
 * Show a toast notification using ST's native toastr system.
 * @param {string} message - The message to display
 * @param {'info'|'success'|'warning'|'error'} type - Toast type
 */
export function nwstToast(message, type = 'info') {
    if (typeof toastr !== 'undefined') {
        toastr[type](message, TOAST_PREFIX);
    }
}

/**
 * Get the current chat ID from SillyTavern context.
 * @returns {string|null} The current chat ID, or null if unavailable
 */
export function getChatId() {
    try {
        const { chatId } = SillyTavern.getContext();
        return chatId || null;
    } catch (e) {
        return null;
    }
}

/**
 * Keep the Current Day sub-line limited to era/calendar context.
 * LLMs sometimes append setting labels such as "Modern City" or
 * "Present-day Region" after a valid era. Those are locations, not dates,
 * and become actively misleading when the story changes regions.
 *
 * This intentionally preserves legitimate temporal segments such as:
 *   Reiwa 6
 *   Imperial Era · 1125 CE
 *   Third Dynasty · Reign Year 5
 * while removing non-temporal trailing labels after a separator.
 *
 * @param {*} value
 * @returns {string}
 */
export function normalizeDateSub(value) {
    const text = String(value ?? '')
        .replace(/\s*\|\s*/g, ' · ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return '';

    const temporalToken = /(?:\d|\b(?:era|period|century|year|reign|dynasty|age|calendar|ce|bce|ad|bc|ah|regnal)\b)/i;
    const modernSettingLabel = /^(?:modern(?:[-\s]+day)?|present[-\s]+day|contemporary)\b/i;
    const segments = text.split(/\s*[·•]\s*/).map(part => part.trim()).filter(Boolean);
    if (segments.length === 0) return '';

    const cleaned = [];
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        const isModernLocationOnly = modernSettingLabel.test(segment) && !temporalToken.test(segment);
        if (isModernLocationOnly) continue;

        // After a valid era segment, bare trailing labels with no temporal
        // content are almost always a city/country/setting descriptor.
        if (index > 0 && !temporalToken.test(segment)) continue;
        cleaned.push(segment);
    }

    return cleaned.join(' · ');
}

