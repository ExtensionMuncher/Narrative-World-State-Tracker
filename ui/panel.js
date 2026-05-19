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

// Attach to window so index.js and LLM modules can call UI refreshes
// without importing UI modules directly (avoids circular dependencies).
if (typeof window !== 'undefined') {
    // Refresh ALL built tabs (used on chat change and batch scan)
    window.nwstRefreshAllUI = refreshAllUI;

    /**
     * Refresh specific tabs by name.
     * LLM modules call this after completing work so the user sees
     * updated data immediately without having to switch tabs manually.
     *
     * Usage: window.nwstRefreshTabs('home', 'events')
     *
     * @param {...string} tabNames - Tab names to refresh: 'home'|'events'|'world'|'notebook'|'settings'
     */
    /**
     * Open the shared popout editor from anywhere in the extension.
     * Used by secret fields and other editable areas that need expanded editing.
     * @param {string} title - Header title shown in the popout
     * @param {string} content - Initial textarea content
     * @param {function} onSave - Callback with saved text when user clicks Save & close
     */
    window.openNWSTPopout = function(title, currentContent, onSave) {
        const overlay = document.getElementById('nwst-popout-overlay');
        const titleEl = document.getElementById('nwst-popout-title');
        const textarea = document.getElementById('nwst-popout-textarea');
        if (!overlay || !titleEl || !textarea) return;
        titleEl.textContent = title;
        textarea.value = currentContent || '';
        overlay._nwstOnSave = onSave || null;
        overlay.classList.add('nwst-popout-open');
        setTimeout(() => textarea.focus(), 50);
    };

    window.nwstRefreshTabs = function(...tabNames) {
        for (const tabName of tabNames) {
            try {
                refreshTab(tabName);
            } catch (e) {
                console.warn(`[NWST Panel] Could not refresh tab "${tabName}":`, e);
            }
        }
    };
}

// ── Popout (⛶) handler ────────────────────────────────────────────────────

/**
 * Wire popout buttons that use the data-for attribute.
 * When clicked, opens ST's callGenericPopup with a textarea containing
 * the target element's current value. On save, writes back.
 */
function wirePopoutHandler() {
    $(document).on('click', '.nwst-expand-btn', async function () {
        // Skip if ST's native editor_maximize handler will handle this button
        if ($(this).hasClass('editor_maximize')) return;

        const targetId = $(this).data('for');
        if (!targetId) return;

        const targetEl = document.getElementById(targetId);
        if (!targetEl) return;

        const currentValue = targetEl.value || targetEl.textContent || '';
        const label = $(this).attr('title') || 'Edit content';

        const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();

        const formHtml = `
            <div style="padding:10px;min-width:400px;min-height:300px">
                <label style="display:block;font-size:12px;margin-bottom:6px;color:#999">${label}</label>
                <textarea class="text_pole" style="width:100%;min-height:250px;resize:vertical">${currentValue.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')}</textarea>
            </div>
        `;

        const result = await callGenericPopup(formHtml, POPUP_TYPE.TEXT, '', {
            okButton: 'Save',
            cancelButton: 'Cancel',
        });

        if (result) {
            // Read the value from the popup's textarea
            const popupTextarea = document.querySelector('.nwst-popout-overlay textarea, .popup textarea');
            if (popupTextarea) {
                const newValue = popupTextarea.value;
                if (targetEl.tagName === 'TEXTAREA' || targetEl.tagName === 'INPUT') {
                    targetEl.value = newValue;
                    // Trigger input/change event so any listeners fire
                    targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                    targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    targetEl.textContent = newValue;
                }
            }
        }
    });
}

// ── Initial build of tabs that should appear immediately ──────────────────

/**
 * Build all tabs that are ready. Called after panel mount.
 */
export function initializeTabs() {
    // Wire popout handler
    wirePopoutHandler();

    // Build Home and Settings tabs immediately (they're ready)
    buildTab('home');
    builtTabs.home = true;

    // Settings tab deferred until user clicks it (lazy)
    // buildTab('settings');
    // builtTabs.settings = true;
}

