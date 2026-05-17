/* eslint-disable */
// =============================================================================
// Narrative World State Tracker (NWST) — Main Entry Point
// =============================================================================
// This file registers the extension with SillyTavern, initializes all modules,
// mounts the five-tab UI panel using ST's native inline-drawer system, and
// handles chat-change lifecycle events via ST's native event system.
//
// KEY ARCHITECTURE DECISIONS:
//   • All ST APIs accessed via SillyTavern.getContext() — NOT direct imports
//     from script.js. This is the stable API that won't break with ST updates.
//   • Panel registered via #extensions_settings2 using ST's inline-drawer
//     pattern — this is how the extension appears in the dropdown menu.
//   • Chat change detection uses ST's native CHAT_CHANGED event — NOT polling.
//   • Settings stored in extensionSettings (global prefs, not per-chat).
//   • Per-chat narrative data stored in extensionSettings.nwst.chatData (namespaced under chatId).
//
// ── DATA STORAGE SPLIT ────────────────────────────────────────────────────
//
//   GLOBAL (extensionSettings — stored once, shared across all chats):
//     • enabled, scanPaused, debugMode
//     • connections (planningLLM, dayAdvancementLLM, narrativeConsistencyLLM)
//     • scanFrequency
//     • injection settings
//     • plannerPrompt
//
//   PER-CHAT (extensionSettings.nwst.chatData[chatId]):
//     • settingContext       — world climate/geography description
//     • worldState           — currentDay, forecast, moonPhases, conditions
//     • events               — all event objects
//     • notebook             — core, mystery, secrets
//     • communities          — community summaries
//     • snapshots            — per-message-range state snapshots
//
// =============================================================================

// ── Constants ──────────────────────────────────────────────────────────────

/** Unique namespace for this extension. Used for all settings and data keys. */
const MODULE_NAME = 'nwst';

/** Human-readable name shown in toasts and logs. */
const MODULE_NAME_FANCY = 'Narrative World State Tracker';

/** Toast prefix shown before all notifications. */
const TOAST_PREFIX = 'Narrative World State Tracker';

/** The folder name as installed in ST's third-party extensions directory. */
const EXTENSION_FOLDER = 'third-party/Narrative-World-State-Tracker';

// ── Logging helpers ────────────────────────────────────────────────────────

function log(...args) {
    console.log(`[${MODULE_NAME_FANCY}]`, ...args);
}

function debug(...args) {
    const { extensionSettings } = SillyTavern.getContext();
    if (extensionSettings[MODULE_NAME]?.debugMode) {
        console.log(`[${MODULE_NAME_FANCY} DEBUG]`, ...args);
    }
}

function errorLog(...args) {
    console.error(`[${MODULE_NAME_FANCY}]`, ...args);
}

/**
 * Show a toast notification using ST's native toastr system.
 * @param {string} message - The message to display
 * @param {'info'|'success'|'warning'|'error'} type - Toast type
 */
function nwstToast(message, type = 'info') {
    if (typeof toastr !== 'undefined') {
        toastr[type](message, TOAST_PREFIX);
    }
}

/**
 * Get the current chat ID from SillyTavern context.
 * Uses SillyTavern.getContext() — the stable API that won't break with ST updates.
 * @returns {string|null} The current chat ID, or null if context is not available
 */
function getChatId() {
    try {
        const { chatId } = SillyTavern.getContext();
        return chatId || null;
    } catch (e) {
        return null;
    }
}

// Export for use by other NWST modules
export { MODULE_NAME, nwstToast, getChatId };

// ── Default settings (global, NOT per-chat) ────────────────────────────────

const defaultSettings = {
    // Core
    enabled: true,
    scanPaused: false,
    debugMode: false,

    // Connection profiles — store the profile IDs from ST's connection manager
    connections: {
        planningLLM: '',
        dayAdvancementLLM: '',
        narrativeConsistencyLLM: '',
    },

    // Scanner cadence
    scanFrequency: 20,

    // Injection settings
    injection: {
        injectCurrentDay: true,
        injectEvents: true,
        injectWorldConditions: true,
        placement: 'before_main',   // 'before_main' | 'after_main' | 'top_an' | 'bottom_an' | 'at_depth'
        depth: 2,
        depthRole: 'system',        // 'system' | 'user' | 'assistant'
    },

    // The ONLY user-editable LLM prompt in the extension
    plannerPrompt: `You are maintaining a living narrative world state for an ongoing roleplay. On each scan, review the recent messages and update: the current day block (season, weather, spiritual climate if applicable), upcoming events, and active world conditions. Write with atmospheric detail — this is a living document, not a spreadsheet. Do not invent events that contradict established facts. Flag any contradictions you detect in the inconsistencies field.`,
};

// ── Settings helpers ───────────────────────────────────────────────────────

/**
 * Initialize extension settings. On first run, creates from defaults.
 * On subsequent runs, merges to add any new keys (soft reset).
 */
function initSettings() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();

    if (extensionSettings[MODULE_NAME] === undefined) {
        log('No settings found. Initializing with defaults...');
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    } else {
        log('Settings found. Merging defaults for any new keys...');
        // Use lodash merge for deep merge — available via SillyTavern.libs
        const { lodash } = SillyTavern.libs;
        extensionSettings[MODULE_NAME] = lodash.merge(
            structuredClone(defaultSettings),
            extensionSettings[MODULE_NAME]
        );
    }

    saveSettingsDebounced();
}

/**
 * Get a global extension setting by key.
 * @param {string} key
 * @returns {*}
 */
function getSetting(key) {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME]?.[key] ?? defaultSettings[key];
}

/**
 * Set a global extension setting and save.
 * @param {string} key
 * @param {*} value
 */
function setSetting(key, value) {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    extensionSettings[MODULE_NAME][key] = value;
    saveSettingsDebounced();
}

export { getSetting, setSetting, defaultSettings };

// ── Per-chat data helpers (chatMetadata) ───────────────────────────────────
// Per-chat narrative data lives in ST's chatMetadata, not extensionSettings.
// chatMetadata is automatically scoped to the current chat — no manual
// namespacing needed beyond a key prefix to avoid conflicts with other extensions.
//
// IMPORTANT: Never cache a reference to chatMetadata. Always call
// SillyTavern.getContext().chatMetadata to get the current chat's metadata,
// because the reference changes when the chat is switched.

/**
 * Get a per-chat NWST data value.
 * @param {string} key - The data key (will be prefixed with 'nwst:')
 * @param {*} defaultValue - Value to return if key doesn't exist
 * @returns {*}
 */
function getChatData(key, defaultValue = null) {
    const { chatMetadata } = SillyTavern.getContext();
    return chatMetadata[`nwst:${key}`] ?? defaultValue;
}

/**
 * Set a per-chat NWST data value and save metadata.
 * @param {string} key - The data key (will be prefixed with 'nwst:')
 * @param {*} value - JSON-serializable value to store
 */
async function setChatData(key, value) {
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    chatMetadata[`nwst:${key}`] = value;
    await saveMetadata();
}

export { getChatData, setChatData };

// ── Panel registration (ST native inline-drawer pattern) ───────────────────

/**
 * Register the NWST panel in ST's extensions dropdown using the native
 * inline-drawer system. This is what makes the extension appear in the
 * extensions menu when the user clicks the stacked-blocks icon.
 *
 * ST's pattern:
 *   1. Render an HTML template using renderExtensionTemplateAsync()
 *   2. Append to #extensions_settings2 (the extensions dropdown container)
 *   3. The template uses ST's inline-drawer CSS classes for the collapsible
 *      header/body pattern that all extensions use
 */
async function registerPanel() {
    try {
        const { renderExtensionTemplateAsync } = SillyTavern.getContext();

        // Render our panel.html template (ST handles DOMPurify sanitization)
        const html = await renderExtensionTemplateAsync(
            EXTENSION_FOLDER,
            'panel',
            {}  // No template variables needed at this stage
        );

        // Append to the extensions settings container
        $('#extensions_settings2').append(html);

        log('Panel registered in extensions dropdown.');

        // Wire up internal tab switching after DOM is ready
        wireTabSwitching();
        wireEnableToggle();

    } catch (err) {
        errorLog('Failed to register panel:', err);
        nwstToast('Failed to load NWST panel. Check the console for details.', 'error');
    }
}

// ── Tab switching ──────────────────────────────────────────────────────────

/**
 * Wire click events for the five NWST tabs.
 * Tabs live inside the inline-drawer content area.
 */
function wireTabSwitching() {
    // Use event delegation on the document so this works regardless of
    // when the DOM elements are added
    $(document).on('click', '.nwst-tab', function () {
        const targetTab = $(this).data('nwst-tab');

        // Deactivate all tabs and panes within the NWST panel
        $('.nwst-tab').removeClass('nwst-tab-on');
        $('.nwst-pane').removeClass('nwst-pane-on');

        // Activate the clicked tab and its pane
        $(this).addClass('nwst-tab-on');
        $(`#nwst-pane-${targetTab}`).addClass('nwst-pane-on');

        debug(`Tab switched to: ${targetTab}`);

        // Trigger lazy-build for the tab content (handled by ui/panel.js)
        if (typeof window.nwstOnTabSwitched === 'function') {
            window.nwstOnTabSwitched(targetTab);
        }
    });
}


// ── Enable toggle ──────────────────────────────────────────────────────────

/**
 * Wire the enable/disable toggle on the Home tab.
 * Manages scanner lifecycle plus consistency check cadence.
 */
function wireEnableToggle() {
    $(document).on('change', '#nwst-enable-toggle', async function () {
        const enabled = $(this).prop('checked');
        setSetting('enabled', enabled);
        updateStatusLabel();

        if (enabled) {
            debug('Extension enabled — starting scanner.');
            const { startScanner } = await import('./llm/scanner.js');
            startScanner();
        } else {
            debug('Extension disabled — stopping scanner.');
            const { stopScanner } = await import('./llm/scanner.js');
            stopScanner();
        }

        // Update prompt injection to reflect new state (clear or show)
        try {
            const { updateInjection } = await import('./inject/promptInjector.js');
            updateInjection();
        } catch (err) {
            // Non-fatal — injection may not be registered yet
        }
    });

    $(document).on('click', '#nwst-pause-btn', async function () {
        const currentlyPaused = getSetting('scanPaused');
        setSetting('scanPaused', !currentlyPaused);
        updatePauseButton();
        updateStatusLabel();

        if (getSetting('scanPaused')) {
            debug('Scanning paused — stopping scanner.');
            const { stopScanner } = await import('./llm/scanner.js');
            stopScanner();
        } else {
            debug('Scanning resumed — starting scanner.');
            const { startScanner } = await import('./llm/scanner.js');
            startScanner();
        }

        // Update prompt injection to reflect paused state (world state only, no secrets)
        try {
            const { updateInjection } = await import('./inject/promptInjector.js');
            updateInjection();
        } catch (err) {
            // Non-fatal — injection may not be registered yet
        }
    });
}

/**
 * Update the status label under the extension title.
 */
export function updateStatusLabel() {
    const enabled = getSetting('enabled');
    const paused = getSetting('scanPaused');
    const label = document.getElementById('nwst-status-label');
    if (!label) return;

    if (!enabled) {
        label.textContent = 'Extension disabled';
        label.style.color = '';
    } else if (paused) {
        label.textContent = 'Extension enabled · Scanning paused';
        label.style.color = '#8a6c00';
    } else {
        label.textContent = 'Extension enabled · Scanning active';
        label.style.color = '';
    }
}

/**
 * Update the pause button appearance based on current state.
 */
export function updatePauseButton() {
    const paused = getSetting('scanPaused');
    const btn = document.getElementById('nwst-pause-btn');
    const icon = document.getElementById('nwst-pause-icon');
    const lbl = document.getElementById('nwst-pause-label');

    if (!btn) return;

    if (paused) {
        btn.style.borderColor = '#f0c040';
        btn.style.color = '#8a6c00';
        btn.style.background = '#fffbe6';
        if (icon) icon.textContent = '▶';
        if (lbl) lbl.textContent = 'Resume';
    } else {
        btn.style.borderColor = '';
        btn.style.color = '';
        btn.style.background = '';
        if (icon) icon.textContent = '⏸';
        if (lbl) lbl.textContent = 'Pause';
    }
}

// ── Chat change handling ───────────────────────────────────────────────────

/**
 * Called by ST's native CHAT_CHANGED event when the user switches chats.
 * Reloads all NWST data for the new chat.
 *
 * NOTE: Do NOT cache chatMetadata between chats — the reference changes.
 * Always call SillyTavern.getContext().chatMetadata fresh.
 */
function onChatChanged() {
    const { chatMetadata } = SillyTavern.getContext();
    log('Chat changed — reloading NWST data for new chat.');

    // Refresh the UI with data from the new chat's metadata
    // Uses window-level refreshAllUI provided by ui/panel.js
    if (typeof window.nwstRefreshAllUI === 'function') {
        window.nwstRefreshAllUI();
    }

    // Restart scanner for the new chat (if extension is enabled and not paused)
    if (getSetting('enabled') && !getSetting('scanPaused')) {
        import('./llm/scanner.js').then(({ restartScanner }) => {
            restartScanner();
        });
    }

    debug('Chat metadata available:', !!chatMetadata);
}

export { onChatChanged };

// ── Placeholder UI refresh ─────────────────────────────────────────────────

/**
 * Refresh all UI panels with current chat data.
 * Placeholder — will be replaced by ui/panel.js in later build phases.
 */
function refreshAllUI() {
    log('refreshAllUI called — UI modules not yet loaded.');
}

// ── Extension initialization ───────────────────────────────────────────────

/**
 * Main initialization. Uses ST's APP_READY event to ensure ST is fully loaded
 * before we try to register the panel or access any ST APIs.
 *
 * Per ST docs:
 *   APP_READY = app is fully loaded and ready to use. Auto-fires for any new
 *               listener attached after the app is ready, so no race condition.
 */
async function init() {
    log('═══════════════════════════════════════════');
    log('Narrative World State Tracker initializing...');
    log('═══════════════════════════════════════════');

    // 1. Initialize settings
    initSettings();

    // 2. Register the panel in ST's extensions dropdown
    await registerPanel();

    // 3. Dynamically import UI modules to avoid circular dependency
    //    (sub-modules like ui/home.js import from index.js, so they must
    //     be loaded AFTER index.js is fully evaluated)
    const { initializeTabs } = await import('./ui/panel.js');
    initializeTabs();

    // 4. Wire ST's native CHAT_CHANGED event for data isolation between chats
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    log('CHAT_CHANGED listener registered.');

    // 5. Set initial UI state based on loaded settings
    updateStatusLabel();
    updatePauseButton();

    // 6. Register prompt injection with ST's extension prompt system
    //     This ensures the world state block is injected into every LLM prompt.
    try {
        const { registerPromptInjection } = await import('./inject/promptInjector.js');
        registerPromptInjection();
        log('Prompt injection registered.');
    } catch (err) {
        console.warn('[NWST] Failed to register prompt injection:', err);
    }

    // 7. Start background scanner if extension is enabled
    if (getSetting('enabled') && !getSetting('scanPaused')) {
        try {
            const { startScanner } = await import('./llm/scanner.js');
            startScanner();
            log('Background scanner started.');
        } catch (err) {
            console.warn('[NWST] Failed to start scanner:', err);
        }
    } else {
        log('Scanner not started (disabled or paused).');
    }

    log('NWST initialization complete. ✅');
    log('───────────────────────────────────────────');
}

// ── Start the extension ────────────────────────────────────────────────────

// Listen for APP_READY — this is ST's signal that everything is loaded.
// Per ST docs, APP_READY auto-fires for any new listener if the app is
// already ready, so there is no race condition to worry about.
const { eventSource, event_types } = SillyTavern.getContext();
eventSource.on(event_types.APP_READY, () => {
    init().catch(err => {
        console.error(`[${MODULE_NAME_FANCY}] Initialization failed:`, err);
    });
});

log('Module loaded. Waiting for APP_READY...');
