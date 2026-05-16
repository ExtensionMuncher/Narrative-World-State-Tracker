/* eslint-disable */
// =============================================================================
// Narrative World State Tracker (NWST) — Main Entry Point
// =============================================================================
// This file registers the extension with SillyTavern, initializes all modules,
// mounts the five-tab UI panel, and handles chat-change lifecycle events.
//
// All narrative data is namespaced per chat ID. Opening a different chat loads
// that chat's independent dataset. There is zero crossover between chats.
//
// ── DATA STORAGE SPLIT ────────────────────────────────────────────────────
//
//   GLOBAL (stored once, shared across all chats):
//     • enabled, scanPaused, debugMode
//     • connections (planningLLM, dayAdvancementLLM, narrativeConsistencyLLM)
//     • scanFrequency
//     • injection settings (injectCurrentDay, injectEvents, etc.)
//     • plannerPrompt
//
//   PER-CHAT (namespaced under nwst:${chatId}:${dataType}):
//     • settingContext       — world climate/geography description
//     • worldState           — currentDay, forecast, moonPhases, conditions
//     • events               — all event objects
//     • notebook             — core, mystery, secrets
//     • communities          — community summaries
//     • snapshots            — per-message-range state snapshots
//
// =============================================================================

// ── SillyTavern core imports ───────────────────────────────────────────────
// These import paths are relative to this file's location inside ST's
// data/default-user/extensions/Narrative-World-State-Tracker/ directory.
import {
    getContext,
    saveSettingsDebounced,
    chat_metadata,
    extension_prompt_roles,
    extension_prompt_types,
    generateRaw,
    getMaxContextSize,
    CONNECT_API_MAP
} from '../../../../script.js';

import {
    extension_settings,
    saveMetadataDebounced
} from '../../../extensions.js';

// ── Utilities imported from ST's shared utils ──────────────────────────────
import { debounce, download, parseJsonFile } from '../../../utils.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Unique namespace for this extension. Used for all settings and data keys. */
const MODULE_NAME = 'nwst';

/** Human-readable name shown in toasts and logs. */
const MODULE_NAME_FANCY = 'Narrative World State Tracker';

/** Toast prefix shown before all notifications. */
const TOAST_PREFIX = 'Narrative World State Tracker';

// Export MODULE_NAME so other NWST modules can import it.
export { MODULE_NAME };

// ── State ──────────────────────────────────────────────────────────────────

/**
 * Holds the current chat ID. Updated whenever the chat changes.
 * Used to namespace all per-chat data storage.
 * @type {string|null}
 */
let currentChatId = null;

/**
 * Whether the extension panel is currently open/visible.
 * @type {boolean}
 */
let panelVisible = false;

// ── Logging helpers ────────────────────────────────────────────────────────

/**
 * Log a message to the browser console with the NWST prefix.
 * Use for general diagnostic information.
 * @param {...any} args - Arguments to log
 */
function log(...args) {
    console.log(`[${MODULE_NAME_FANCY}]`, ...args);
}

/**
 * Log a debug message to the console. Only appears if debug mode is enabled.
 * @param {...any} args - Arguments to log
 */
function debug(...args) {
    if (getSetting('debugMode')) {
        console.log(`[${MODULE_NAME_FANCY} DEBUG]`, ...args);
    }
}

/**
 * Log an error to the console and show a toast notification.
 * @param {...any} args - Arguments to log (first arg used as toast message)
 */
function errorToast(...args) {
    console.error(`[${MODULE_NAME_FANCY}]`, ...args);
    const message = Array.from(args).join(' ');
    if (typeof toastr !== 'undefined') {
        toastr.error(message, TOAST_PREFIX);
    }
}

/**
 * Show an info toast notification using ST's native toastr system.
 * @param {string} message - The message to display
 */
function nwstToast(message, type = 'info') {
    if (typeof toastr !== 'undefined') {
        toastr[type](message, TOAST_PREFIX);
    }
}

// ── Settings (global, NOT per-chat) ────────────────────────────────────────

/**
 * Default settings for the extension. These are stored globally (not per chat)
 * because they represent user preferences, not narrative data.
 * New settings added in future versions will be automatically merged via soft reset.
 */
// NOTE: `settingContext` is stored PER-CHAT (not in this global settings object).
// It describes the world's climate/geography for a specific roleplay. Each chat
// can have a completely different setting (e.g., feudal Japan vs. fantasy desert).
// See data/storage.js for the per-chat storage key: nwst:${chatId}:settingContext

const defaultSettings = {
    // ── Core ──────────────────────────────────────────────────────────────
    enabled: true,
    scanPaused: false,
    debugMode: false,

    // ── Connection profiles ───────────────────────────────────────────────
    // These hold the profile IDs from ST's connection manager.
    connections: {
        planningLLM: '',           // Profile ID for Planning LLM
        dayAdvancementLLM: '',     // Profile ID for Day Advancement LLM
        narrativeConsistencyLLM: '' // Profile ID for Narrative Consistency LLM
    },

    // ── Scanner ───────────────────────────────────────────────────────────
    scanFrequency: 20,             // Scan every N messages (default: 20)

    // ── Injection settings ────────────────────────────────────────────────
    injection: {
        injectCurrentDay: true,        // Include Current Day block in prompt
        injectEvents: true,            // Include upcoming events in prompt
        injectWorldConditions: true,   // Include active world conditions in prompt
        placement: 'before_main',      // Where to inject: 'before_main' | 'after_main' | 'top_an' | 'bottom_an' | 'at_depth'
        depth: 2,                      // Only used when placement is 'at_depth'
        depthRole: 'system'            // Only used when placement is 'at_depth': 'system' | 'user' | 'assistant'
    },

    // ── Planner prompt (the ONLY user-editable LLM prompt) ─────────────────
    plannerPrompt: `You are maintaining a living narrative world state for an ongoing roleplay. On each scan, review the recent messages and update: the current day block (season, weather, spiritual climate if applicable), upcoming events, and active world conditions. Write with atmospheric detail — this is a living document, not a spreadsheet. Do not invent events that contradict established facts. Flag any contradictions you detect in the inconsistencies field.`
};

/**
 * Initialize extension settings in ST's extension_settings storage.
 * On first run, creates settings from defaults. On subsequent runs,
 * merges any missing keys (soft reset — preserves existing values).
 */
function initSettings() {
    if (extension_settings[MODULE_NAME] !== undefined) {
        // Settings already exist — soft reset to add any new default keys
        log('Settings found. Performing soft reset to merge defaults...');
        extension_settings[MODULE_NAME] = Object.assign(
            {},
            defaultSettings,
            extension_settings[MODULE_NAME]
        );
    } else {
        // First run — create settings from scratch
        log('No settings found. Initializing with defaults...');
        extension_settings[MODULE_NAME] = JSON.parse(JSON.stringify(defaultSettings));
    }
}

/**
 * Get a global extension setting by key.
 * @param {string} key - The setting key to retrieve
 * @param {boolean} [copy=false] - If true, returns a deep copy (safe for mutation)
 * @returns {*} The setting value
 */
function getSetting(key, copy = false) {
    const value = extension_settings[MODULE_NAME]?.[key] ?? defaultSettings[key];
    return copy ? JSON.parse(JSON.stringify(value)) : value;
}

/**
 * Set a global extension setting and save.
 * @param {string} key - The setting key to set
 * @param {*} value - The value to store
 */
function setSetting(key, value) {
    extension_settings[MODULE_NAME][key] = value;
    saveSettingsDebounced();
}

// Export settings helpers so other NWST modules can use them.
export { getSetting, setSetting, defaultSettings, nwstToast };

// ── Chat ID detection ──────────────────────────────────────────────────────

/**
 * Get the current SillyTavern chat ID.
 * Uses ST's native context to retrieve the active chat identifier.
 * For group chats, returns the group ID. For solo chats, returns the character chat ID.
 * @returns {string|null} The current chat ID, or null if no chat is active
 */
function getCurrentChatId() {
    try {
        const context = getContext();
        // Group chat takes priority
        if (context.groupId) {
            return `group_${context.groupId}`;
        }
        // Solo chat — use character ID
        if (context.characterId !== undefined && context.characterId !== null) {
            return `char_${context.characterId}`;
        }
        // Fallback: use the chat file name from the context
        if (context.chat && context.chat.length > 0) {
            // Use the chat metadata or a hash of the chat content as identifier
            return `chat_${context.chatId || 'unknown'}`;
        }
        return null;
    } catch (e) {
        console.error(`[${MODULE_NAME_FANCY}] Error getting chat ID:`, e);
        return null;
    }
}

/**
 * Called whenever the active chat changes. Reloads all NWST data for the new chat.
 */
function onChatChanged() {
    const newChatId = getCurrentChatId();
    if (newChatId === currentChatId) return; // No change

    log(`Chat changed: "${currentChatId}" → "${newChatId}"`);

    // Save any pending changes to the old chat before switching
    if (currentChatId) {
        // Future: save dirty state here
    }

    currentChatId = newChatId;

    // Reload the panel UI with the new chat's data
    if (panelVisible && typeof refreshAllUI === 'function') {
        refreshAllUI();
    }
}

/**
 * Expose the current chat ID to other modules.
 * @returns {string|null}
 */
function getChatId() {
    if (!currentChatId) {
        currentChatId = getCurrentChatId();
    }
    return currentChatId;
}

export { getChatId, onChatChanged };

// ── Panel mounting ─────────────────────────────────────────────────────────

/**
 * HTML template for the main NWST panel.
 * This is the outer shell — the five tab panes are populated by their
 * respective UI modules (ui/home.js, ui/events.js, etc.).
 */
const panelHTML = `
<div id="nwst-panel" class="nwst-panel drawer-content flexGap5" style="display:none;">
    <div class="nwst-shell">
        <!-- Tab bar -->
        <div class="nwst-tabs">
            <div class="nwst-tab nwst-tab-on" data-nwst-tab="home">Home</div>
            <div class="nwst-tab" data-nwst-tab="events">Events</div>
            <div class="nwst-tab" data-nwst-tab="world">World State</div>
            <div class="nwst-tab" data-nwst-tab="notebook">Notebook</div>
            <div class="nwst-tab" data-nwst-tab="settings">Settings</div>
        </div>

        <!-- Home tab pane -->
        <div id="nwst-pane-home" class="nwst-pane nwst-pane-on">
            <div class="nwst-placeholder">Home tab loading...</div>
        </div>

        <!-- Events tab pane -->
        <div id="nwst-pane-events" class="nwst-pane">
            <div class="nwst-placeholder">Events tab loading...</div>
        </div>

        <!-- World State tab pane -->
        <div id="nwst-pane-world" class="nwst-pane">
            <div class="nwst-placeholder">World State tab loading...</div>
        </div>

        <!-- Notebook tab pane -->
        <div id="nwst-pane-notebook" class="nwst-pane">
            <div class="nwst-placeholder">Notebook tab loading...</div>
        </div>

        <!-- Settings tab pane -->
        <div id="nwst-pane-settings" class="nwst-pane">
            <div class="nwst-placeholder">Settings tab loading...</div>
        </div>
    </div>

    <!-- Popout overlay (shared by all tabs) -->
    <div class="nwst-popout-overlay" id="nwst-popout-overlay">
        <div class="nwst-popout-modal">
            <div class="nwst-popout-modal-hdr">
                <span class="nwst-popout-modal-title" id="nwst-popout-title">Edit</span>
                <button class="nwst-icon-btn" id="nwst-popout-close">&times;</button>
            </div>
            <div class="nwst-popout-modal-body">
                <textarea id="nwst-popout-textarea" rows="10" placeholder="Type here..."></textarea>
            </div>
            <div class="nwst-popout-modal-footer">
                <button class="nwst-btn" id="nwst-popout-save">Save & close</button>
                <button class="nwst-btn" id="nwst-popout-cancel">Cancel</button>
            </div>
        </div>
    </div>
</div>
`;

/**
 * Mount the NWST panel into ST's movable panels container (#movingDivs).
 * Creates the DOM structure and wires tab switching behavior.
 */
function mountPanel() {
    // Check if panel already exists (prevent duplicate mounting)
    if (document.getElementById('nwst-panel')) {
        log('Panel already mounted.');
        return;
    }

    log('Mounting NWST panel...');

    // Find the #movingDivs container where ST stores movable panels
    const movingDivs = document.getElementById('movingDivs');
    if (!movingDivs) {
        console.error(`[${MODULE_NAME_FANCY}] #movingDivs not found — cannot mount panel.`);
        return;
    }

    // Create panel container and inject HTML
    const panelContainer = document.createElement('div');
    panelContainer.innerHTML = panelHTML;
    movingDivs.appendChild(panelContainer.firstElementChild);

    // Wire tab switching
    wireTabSwitching();

    // Wire popout overlay
    wirePopout();

    log('Panel mounted successfully.');
}

/**
 * Wire click events for the five tabs so clicking a tab switches panes.
 */
function wireTabSwitching() {
    const tabs = document.querySelectorAll('.nwst-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', function () {
            const targetTab = this.getAttribute('data-nwst-tab');

            // Deactivate all tabs and panes
            document.querySelectorAll('.nwst-tab').forEach(t => t.classList.remove('nwst-tab-on'));
            document.querySelectorAll('.nwst-pane').forEach(p => p.classList.remove('nwst-pane-on'));

            // Activate the clicked tab and its pane
            this.classList.add('nwst-tab-on');
            const targetPane = document.getElementById(`nwst-pane-${targetTab}`);
            if (targetPane) {
                targetPane.classList.add('nwst-pane-on');
            }

            // Trigger any lazy-loading the tab needs (future phases)
            if (typeof onTabSwitched === 'function') {
                onTabSwitched(targetTab);
            }
        });
    });
}

/**
 * Wire the popout overlay (shared modal editor used by all tabs).
 * The popout is opened programmatically by calling openPopout(title, content).
 */
function wirePopout() {
    const overlay = document.getElementById('nwst-popout-overlay');
    const closeBtn = document.getElementById('nwst-popout-close');
    const saveBtn = document.getElementById('nwst-popout-save');
    const cancelBtn = document.getElementById('nwst-popout-cancel');

    if (!overlay) return;

    // Close when clicking the overlay background (not the modal itself)
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) {
            closePopout();
        }
    });

    // Close buttons
    if (closeBtn) closeBtn.addEventListener('click', closePopout);
    if (cancelBtn) cancelBtn.addEventListener('click', closePopout);
    if (saveBtn) saveBtn.addEventListener('click', function () {
        // The save action is handled by the module that opened the popout
        if (typeof onPopoutSave === 'function') {
            onPopoutSave();
        }
        closePopout();
    });
}

/**
 * Open the shared popout modal editor.
 * @param {string} title - Title displayed in the modal header
 * @param {string} content - Initial text content for the textarea
 * @param {function} [onSave] - Optional callback when Save is clicked
 */
function openPopout(title, content, onSave) {
    const overlay = document.getElementById('nwst-popout-overlay');
    const titleEl = document.getElementById('nwst-popout-title');
    const textarea = document.getElementById('nwst-popout-textarea');

    if (!overlay || !titleEl || !textarea) return;

    titleEl.textContent = title;
    textarea.value = content || '';

    // Store the save callback on the overlay element for wirePopout to use
    overlay._onSave = onSave || null;

    overlay.classList.add('nwst-popout-open');

    // Focus the textarea after the modal is visible
    setTimeout(() => textarea.focus(), 50);
}

/**
 * Close the popout modal.
 */
function closePopout() {
    const overlay = document.getElementById('nwst-popout-overlay');
    if (overlay) {
        overlay.classList.remove('nwst-popout-open');
        overlay._onSave = null;
    }
}

/**
 * Global handler called when the popout Save button is clicked.
 * Delegates to the callback stored by openPopout().
 */
function onPopoutSave() {
    const overlay = document.getElementById('nwst-popout-overlay');
    const textarea = document.getElementById('nwst-popout-textarea');
    if (overlay && overlay._onSave && textarea) {
        overlay._onSave(textarea.value);
    }
}

// Export popout functions for use by other modules
export { openPopout, closePopout };

// ── Panel visibility toggle ────────────────────────────────────────────────

/**
 * Show or hide the NWST panel.
 * @param {boolean} [show] - If provided, sets visibility. Otherwise toggles.
 */
function togglePanel(show) {
    const panel = document.getElementById('nwst-panel');
    if (!panel) return;

    if (show === undefined) {
        show = panel.style.display === 'none';
    }

    panel.style.display = show ? 'flex' : 'none';
    panelVisible = show;

    if (show && !currentChatId) {
        currentChatId = getCurrentChatId();
        log(`Panel opened for chat: ${currentChatId}`);
    }
}

// ── Extension button in ST's extensions menu ───────────────────────────────

/**
 * Create a button in ST's extensions menu that toggles the NWST panel.
 */
function createMenuButton() {
    const extensionsMenu = document.getElementById('extensionsMenu');
    if (!extensionsMenu) {
        console.error(`[${MODULE_NAME_FANCY}] #extensionsMenu not found.`);
        return;
    }

    // Create the button element
    const button = document.createElement('div');
    button.id = 'nwst-menu-button';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.tabIndex = 0;
    button.title = 'Open/Close Narrative World State Tracker';

    // Create icon
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-globe'; // World/globe icon for world state tracking

    // Create label
    const label = document.createElement('span');
    label.textContent = 'World State Tracker';

    // Assemble button
    button.appendChild(icon);
    button.appendChild(label);

    // Wire click to toggle panel
    button.addEventListener('click', () => togglePanel());

    // Add to extensions menu
    extensionsMenu.appendChild(button);

    log('Menu button created.');
}

// ── Chat change listener ───────────────────────────────────────────────────

/**
 * Set up a listener that detects when the user switches chats.
 * Uses a polling approach checking the chat ID on common ST events.
 * Future: Replace with ST's native event emitter when available.
 */
function setupChatChangeListener() {
    // Poll for chat changes when the user interacts with ST
    const checkChatChange = debounce(() => {
        const newId = getCurrentChatId();
        if (newId !== currentChatId && newId !== null) {
            onChatChanged();
        }
    }, 500);

    // Hook into ST's chat management events if possible
    // Fallback: use a MutationObserver on the chat area
    const chatArea = document.getElementById('chat');
    if (chatArea) {
        const observer = new MutationObserver(() => {
            checkChatChange();
        });
        observer.observe(chatArea, { childList: true, subtree: true });
    }

    // Also check periodically (safety net)
    setInterval(checkChatChange, 5000);
}

// ── Placeholder for UI refresh (filled by ui modules in later phases) ─────

/**
 * Refresh all UI panels with current data.
 * This function is replaced by ui/panel.js in later phases.
 */
function refreshAllUI() {
    log('refreshAllUI called — UI modules not yet loaded.');
    // Future phases will populate this with actual refresh logic
}

// ── Extension lifecycle ────────────────────────────────────────────────────

/**
 * Main initialization. Called when ST loads the extension.
 * This is the entry point — everything starts here.
 */
function init() {
    log('═══════════════════════════════════════════');
    log('Narrative World State Tracker initializing...');
    log('═══════════════════════════════════════════');

    // 1. Initialize settings (global preferences)
    initSettings();

    // 2. Detect the current chat ID
    currentChatId = getCurrentChatId();
    log(`Current chat ID: ${currentChatId}`);

    // 3. Mount the UI panel into ST's interface
    mountPanel();

    // 4. Create the menu toggle button
    createMenuButton();

    // 5. Set up chat change detection
    setupChatChangeListener();

    // 6. Register ST slash commands (optional convenience)
    try {
        const ctx = getContext();
        if (ctx && typeof ctx.registerSlashCommand === 'function') {
            ctx.registerSlashCommand('nwst', () => togglePanel(), ['worldstate'], 'Toggle the Narrative World State Tracker panel.');
            log('Slash commands registered: /nwst, /worldstate');
        }
    } catch (e) {
        // Slash commands are a convenience — failure is non-critical
        log('Slash command registration not available (may require newer ST version).');
    }

    log('NWST initialization complete. ✅');
    log('───────────────────────────────────────────');
}

// ── Start the extension ────────────────────────────────────────────────────

// Use jQuery's document ready if available, otherwise fall back to DOMContentLoaded.
// ST extensions are typically loaded after the DOM is ready, but this is a safety net.
if (typeof jQuery !== 'undefined') {
    jQuery(document).ready(() => {
        // Small delay to ensure ST is fully initialized
        setTimeout(init, 100);
    });
} else {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(init, 100);
    });
}

// Log that the module has been loaded (before init runs)
console.log(`[${MODULE_NAME_FANCY}] Module loaded. Waiting for ST initialization...`);
