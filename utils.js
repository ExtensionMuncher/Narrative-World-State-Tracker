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

export const LONG_OPERATION_REMINDER_MS = 45_000;

/**
 * Warn the user that a potentially long NWST operation has started, then keep
 * reminding them at the same 45-second slow-call interval used by RST until
 * the caller explicitly stops the reminder. Chained timeouts avoid overlapping
 * reminders and make teardown deterministic on success, failure, or abort.
 *
 * @param {object} options
 * @param {string} options.initialMessage
 * @param {string} options.stillRunningMessage
 * @param {number} [options.intervalMs=LONG_OPERATION_REMINDER_MS]
 * @returns {() => void} stop function
 */
export function startLongOperationToast({
    initialMessage = '',
    stillRunningMessage = '',
    intervalMs = LONG_OPERATION_REMINDER_MS,
} = {}) {
    const delay = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
        ? Number(intervalMs)
        : LONG_OPERATION_REMINDER_MS;
    let stopped = false;
    let timer = null;

    if (initialMessage) nwstToast(initialMessage, 'info');

    const scheduleReminder = () => {
        timer = setTimeout(() => {
            timer = null;
            if (stopped) return;
            if (stillRunningMessage) nwstToast(stillRunningMessage, 'info');
            scheduleReminder();
        }, delay);
        // Node-based regression runs should not be kept alive solely by a toast timer.
        if (typeof timer?.unref === 'function') timer.unref();
    };

    scheduleReminder();

    return () => {
        if (stopped) return;
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
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
 * LLMs sometimes append setting labels such as "Modern Tokyo" or
 * "Modern-day capital" after a valid era. Those are locations, not dates,
 * and become actively misleading when the story changes regions.
 *
 * This intentionally preserves legitimate temporal segments such as:
 *   Regnal Year 6
 *   Second Age · 1125 CE
 *   Tang Dynasty · Kaiyuan 5
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

