/* eslint-disable */
// =============================================================================
// NWST Panel Coordinator — ui/panel.js
// =============================================================================
// Ties all five tab UIs together. Handles tab switching callbacks and
// coordinates the refreshAllUI() function that index.js depends on.
//
// This module acts as the bridge between index.js (which mounts the shell)
// and the individual tab modules (home.js, events.js, worldState.js, etc.).
// =============================================================================

import { buildHomeTab, refreshHomeUI } from './home.js';
import { buildSettingsTab, refreshSettingsUI } from './settings.js';
import { buildEventsTab, refreshEventsUI } from './events.js';
import { buildWorldStateTab, refreshWorldStateUI } from './worldState.js';
import { buildNotebookTab, refreshNotebookUI } from './notebook.js';

// ── Module state ──────────────────────────────────────────────────────────

/** Tracks which tabs have been built (lazy initialization). */
const builtTabs = {
    home: false,
    events: false,
    world: false,
    notebook: false,
    settings: false
};

// ── Tab switch handler ────────────────────────────────────────────────────

/**
 * Called by index.js when a tab is clicked.
 * Lazy-builds the tab's content on first visit, then refreshes it.
 *
 * @param {string} tabName - 'home' | 'events' | 'world' | 'notebook' | 'settings'
 */
function onTabSwitched(tabName) {
    console.log(`[NWST Panel] Tab switched to: ${tabName}`);

    // Lazy-build on first access
    if (!builtTabs[tabName]) {
        buildTab(tabName);
        builtTabs[tabName] = true;
    }

    // Refresh the tab with current data
    refreshTab(tabName);
}

// Attach to window so index.js can call it
if (typeof window !== 'undefined') {
    window.nwstOnTabSwitched = onTabSwitched;
}

// ── Build individual tabs ─────────────────────────────────────────────────

function buildTab(tabName) {
    try {
        switch (tabName) {
            case 'home':
                buildHomeTab();
                break;
            case 'events':
                buildEventsTab();
                break;
            case 'world':
                buildWorldStateTab();
                break;
            case 'notebook':
                buildNotebookTab();
                break;
            case 'settings':
                buildSettingsTab();
                break;
        }
    } catch (e) {
        console.error(`[NWST Panel] Error building ${tabName} tab:`, e);
    }
}

function refreshTab(tabName) {
    try {
        switch (tabName) {
            case 'home':
                refreshHomeUI();
                break;
            case 'events':
                refreshEventsUI();
                break;
            case 'world':
                refreshWorldStateUI();
                break;
            case 'notebook':
                refreshNotebookUI();
                break;
            case 'settings':
                refreshSettingsUI();
                break;
        }
    } catch (e) {
        console.error(`[NWST Panel] Error refreshing ${tabName} tab:`, e);
    }
}

// ── Full UI refresh (called on chat change) ───────────────────────────────

/**
 * Refresh all currently-built tabs with the new chat's data.
 * Called by index.js when the chat changes.
 */
function refreshAllUI() {
    console.log('[NWST Panel] Refreshing all built tabs for new chat...');
    for (const [tabName, isBuilt] of Object.entries(builtTabs)) {
        if (isBuilt) {
            refreshTab(tabName);
        }
    }
}

// Attach to window so index.js can call it
if (typeof window !== 'undefined') {
    window.nwstRefreshAllUI = refreshAllUI;
}

// ── Placeholder for tabs not yet built ────────────────────────────────────

function showPlaceholder(tabName, message) {
    const pane = document.getElementById(`nwst-pane-${tabName}`);
    if (pane) {
        pane.innerHTML = `<div class="nwst-placeholder">${message}</div>`;
    }
}

// ── Initial build of tabs that should appear immediately ──────────────────

/**
 * Build all tabs that are ready. Called after panel mount.
 */
export function initializeTabs() {
    // Build Home and Settings tabs immediately (they're ready)
    buildTab('home');
    builtTabs.home = true;

    // Settings tab deferred until user clicks it (lazy)
    // buildTab('settings');
    // builtTabs.settings = true;
}

// ── Update the onTabSwitched callback in index.js ─────────────────────────

/**
 * Patch the global onTabSwitched that index.js references.
 */
export function patchIndexCallbacks() {
    if (typeof window !== 'undefined') {
        // The index.js references onTabSwitched and refreshAllUI as globals.
        // This module provides the real implementations.
        window.onTabSwitched = onTabSwitched;
        window.refreshAllUI = refreshAllUI;
    }
}

// Auto-patch when loaded
patchIndexCallbacks();
