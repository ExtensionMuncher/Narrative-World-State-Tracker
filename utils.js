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

const MODULE_NAME = 'nwst';
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
