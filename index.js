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
//   • Per-chat narrative data stored in SillyTavern chatMetadata.
//
// ── DATA STORAGE SPLIT ────────────────────────────────────────────────────
//
//   GLOBAL (extensionSettings — stored once, shared across all chats):
//     • enabled, scanPaused, debugMode
//     • connections (planningLLM, dayAdvancementLLM, narrativeConsistencyLLM, secretsSidecarLLM)
//     • scanFrequency
//     • injection settings
//     • plannerPrompt
//
//   PER-CHAT (SillyTavern chatMetadata):
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

// ── Logging helpers ────────────────────────────────────────────────────────
// log() and debug() are both gated behind the "Debug F12 logging" toggle in
// Settings, so the console stays quiet during normal use. errorLog() is NEVER
// gated — real errors must always be visible.

function isDebugOn() {
    try {
        const { extensionSettings } = SillyTavern.getContext();
        return !!extensionSettings[MODULE_NAME]?.debugMode;
    } catch (_) {
        return false;
    }
}

function log(...args) {
    if (isDebugOn()) console.log(`[${MODULE_NAME_FANCY}]`, ...args);
}

function debug(...args) {
    if (isDebugOn()) console.log(`[${MODULE_NAME_FANCY} DEBUG]`, ...args);
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

// Re-export utils for modules that import from index.js directly
export { nwstToast, getChatId } from './utils.js';
export { MODULE_NAME };

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
        secretsSidecarLLM: '',
    },

    // No-think soft switch: append "/no_think" to each LLM call to disable
    // reasoning on supporting models (Qwen3, etc.). Harmless to others.
    noThink: false,
    // No-think hard switch: also send API params (think/enable_thinking=false).
    // Off by default — some backends error on unknown body keys.
    noThinkHard: false,
    // Per-profile no-think, keyed by connection profile ID. These take
    // precedence over the blanket booleans above when present.
    noThinkProfiles: {},
    noThinkHardProfiles: {},

    // Scanner cadence
    scanFrequency: 20,
    scanMinimumMessages: 10,  // Warmup floor — initial scan fires after this many messages
    maxSnapshotCount: 30,       // Snapshot retention target; protected landmark snapshots are never pruned

    // Event Horizon Compaction — stale resolved/missed events are compacted
    // into the Notebook's doNotForget section and removed from active events
    // after this many elapsed story days past their resolveElapsedDay marker.
    eventCompactionThreshold: 0,

    // Event→Secret Promotion — when a resolved/missed event has participants
    // with information asymmetry, automatically promote it to a structured
    // secret in the Notebook with whoKnows/whoDoesNotKnow tracking.
    autoPromoteEvents: true,

    // Day advancement: ask the Planning LLM whether any active event's premise
    // has become impossible/moot; flags for player review (never auto-removes)
    eventValidityReview: true,

    // International date entry: read slash dates day-first (10/4/26 = April 10th).
    // Used by the Starting Date parser in the deterministic date engine.
    dateFormatDMY: false,

    // Moon cycle configuration (fantasy worlds can override the 29.53-day cycle)
    moonCycleDays: 29.53,

    // ── Multi-Moon Configuration ──────────────────────────────────────────
    // Master toggle: disable moons entirely
    enableMoons: true,
    // Array of moon definitions — each moon has its own cycle length and phase names
    // Users can add fantasy moons (e.g. "The Crimson Eye", "Twin Sisters") or remove all for a moonless world
    moons: [
        { id: 'primary', name: 'The Moon', cycleDays: 29.53, enabled: true }
    ],
    // Natural moon phenomena toggle
    enableMoonPhenomena: true,
    // ──────────────────────────────────────────────────────────────────────

    // Injection settings
    injection: {
        injectCurrentDay: true,
        injectEvents: true,
        injectWorldConditions: true,
        densityMode: 'combined',   // 'token-budget' | 'combined' | 'atmospheric'
        maxActiveEvents: 12,       // Maximum total active events in the pool at any time
        placement: 'before_main',   // 'before_main' | 'after_main' | 'top_an' | 'bottom_an' | 'at_depth'
        depth: 2,
        depthRole: 'system',        // 'system' | 'user' | 'assistant'
        secretBudgetTokens: 600,    // Max tokens of secret text to inject per generation (relevance budget)
        maxSecretsInjected: 4,      // Hard count cap — never inject more than this many secrets, even if budget allows
    },

    // ── Secrets engine (prose-based scoring) ───────────────────────────
    secrets: {
        // Sidecar cadence — how often the scene analyzer LLM runs (messages)
        sidecarCadence: 10,

        // Sidecar scan range — how many recent prose messages the sidecar reads
        sidecarScanRange: 5,

        // Score threshold a secret must reach to be eligible for injection
        injectionThreshold: 50,
        decayThreshold: 250,    // messages since last injection before a non-High/Critical secret is flagged dormant for archive review (0 = disabled)
        reconcileCadence: 0,    // auto-tidy notebook every N scans (0 = manual only via the Tidy button)

        // Scoring weights — all editable. These determine how strongly each
        // relevance signal pushes a secret toward injection.
        weights: {
            knowerPresent:        30,  // a character who knows the secret is in the scene
            unawarePresent:       20,  // a character who must NOT know is in the scene
            bothPresent:          40,  // both a knower and an unaware party present AND the secret's subject is referenced in the scene
            coPresenceOnly:        5,  // a knower and an unaware party are co-present but the secret's subject is NOT referenced (coincidental co-presence)
            sharedThemeMatch:      5,  // a shared theme word (appears in 2+ secrets) matched, but no distinctive subject anchor — weak signal
            npcCutawayHolder:     35,  // NPC cutaway involving the secret's holder/schemer
            groupMatch:           25,  // a group/faction tied to the secret is present
            anchorMatch:          20,  // concept/object/location anchor appears in the scene
            revealConditionMatch: 35,  // a reveal condition is referenced in the prose
            pressureMatch:        25,  // the secret's pressureRisk is active in the scene
            continuityRisk:       45,  // omitting this secret risks a continuity break
            // Priority modifiers (added to score based on the secret's priority)
            priorityLow:         -15,
            priorityNormal:        0,
            priorityHigh:         20,
            priorityCritical:     50,
        },
    },

    // Internal planner instruction. Not exposed for user editing because it coordinates
    // too many subsystems for arbitrary prompt changes to be safe.
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

// ── Magic wand menu ─────────────────────────────────────────────────────────

/**
 * Opens a standalone floating popup (like TypefaceR's popout) that contains
 * the NWST panel content.  This is the pattern used by ALL third-party
 * extensions in ST's magic wand menu — they open their own independent
 * floating UI, NOT the sidebar extensions drawer.
 *
 * IMPORTANT: The drawer content is MOVED (not cloned) to the popout to avoid
 * duplicate-ID issues.  The `buildTab()` functions in ui/panel.js use
 * document.getElementById() which only finds the FIRST element with that ID.
 * Cloning creates duplicates — buildTab() would populate the hidden original
 * instead of the visible clone.  Moving avoids this entirely.  When the popout
 * closes, the content is moved back to the sidebar drawer.
 *
 * References:
 *   - TypefaceR:  openPopout() clones drawer content into a draggable popup
 *   - Notebook:   creates a panel in #movingDivs and toggles its visibility
 */
let nwstPopoutVisible = false;   // eslint-disable-line no-var
let $nwstPopout = null;          // eslint-disable-line no-var

function openNwstPopout() {
    if (nwstPopoutVisible) return;

    const $drawerContent = $('.nwst-extension-drawer .inline-drawer-content');
    if ($drawerContent.length === 0) {
        debug('[wand] NWST drawer content not found — cannot open popout.');
        return;
    }

    // Create the floating popup container (matches TypefaceR pattern)
    $nwstPopout = $(`
        <div id="nwst-popout" class="draggable">
            <div id="nwst-popout-header" class="nwst-popout-header">
                <div class="nwst-popout-title">
                    <i class="fa-solid fa-globe"></i>
                    <span>Narrative World State Tracker</span>
                </div>
                <div class="nwst-popout-close" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </div>
            </div>
            <div id="nwst-popout-content"></div>
        </div>
    `);

    // Append to body
    $('body').append($nwstPopout);

    // ── MOVE the drawer content into the popout (do NOT clone) ──
    // Cloning creates duplicate IDs, and buildTab() uses document.getElementById()
    // which only finds the first (hidden) element.  Moving ensures no duplicates.
    const popoutContent = $nwstPopout.find('#nwst-popout-content')[0];
    const drawerContentEl = $drawerContent[0];
    // Detach from sidebar drawer and append to popout
    popoutContent.appendChild(drawerContentEl);

    // Close button handler
    $nwstPopout.find('.nwst-popout-close').on('click', closeNwstPopout);

    // Close on Escape key
    $(document).on('keydown.nwst_popout', (e) => {
        if (e.key === 'Escape') {
            closeNwstPopout();
        }
    });

    // Make draggable using ST's built-in dragElement (from RossAscends-mods.js)
    if (typeof window.dragElement === 'function') {
        window.dragElement($nwstPopout);
    }

    // Fade in
    $nwstPopout.fadeIn(200);
    nwstPopoutVisible = true;
    log('[wand] NWST popout opened.');
}

function closeNwstPopout() {
    if (!nwstPopoutVisible || !$nwstPopout) return;

    // ── Move the content back to the sidebar drawer ──
    const popoutContent = document.getElementById('nwst-popout-content');
    const drawerContent = popoutContent?.firstElementChild; // .inline-drawer-content

    $nwstPopout.fadeOut(200, () => {
        // Move content back to the original sidebar drawer
        if (drawerContent) {
            const $originalDrawer = $('.nwst-extension-drawer');
            if ($originalDrawer.length > 0) {
                $originalDrawer.append(drawerContent);
            }
        }
        $nwstPopout.remove();
        $nwstPopout = null;
    });

    nwstPopoutVisible = false;
    $(document).off('keydown.nwst_popout');
    log('[wand] NWST popout closed.');
}

/**
 * Adds an entry for NWST in ST's magic wand dropdown (#extensionsMenu).
 * Third-party extensions are NOT auto-discovered in the wand menu — each
 * extension must self-register.  This follows the same pattern used by
 * TypefaceR, Extension-Notebook, and other third-party extensions.
 *
 * Clicking the wand entry toggles a standalone floating popup (TypefaceR
 * pattern) — it does NOT open the sidebar extensions drawer.
 */
function registerMagicWandMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        debug('Magic wand menu (#extensionsMenu) not found — cannot register wand entry.');
        return;
    }

    // Prevent duplicate entries if init is somehow called again
    if (document.getElementById('nwst-wand-entry')) {
        return;
    }

    const entry = document.createElement('div');
    entry.id = 'nwst-wand-entry';
    entry.className = 'list-group-item flex-container flexGap5 interactable';
    entry.title = 'Open Narrative World State Tracker';
    entry.tabIndex = 0;
    entry.innerHTML = `
        <i class="fa-solid fa-globe"></i>
        <span>Narrative World State</span>
    `;

    entry.addEventListener('click', function () {
        // Toggle the standalone floating popup — NOT the sidebar drawer
        if (nwstPopoutVisible) {
            closeNwstPopout();
        } else {
            openNwstPopout();
        }
    });

    menu.appendChild(entry);
    log('Magic wand menu entry registered.');
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
async function onChatChanged() {
    const { chatMetadata, chatId } = SillyTavern.getContext();
    log('Chat changed — reloading NWST data for new chat.');

    // Reset per-session profile warnings so the user is re-notified
    // if profiles are still missing in the new chat context
    try {
        const { resetProfileWarnings } = await import('./llm/connections.js');
        resetProfileWarnings();
    } catch (e) { /* non-fatal */ }

    // Run one-time migrations for this chat
    if (chatId) {
        try {
            const { migrateLegacyData } = await import('./data/storage.js');
            const legacyMigrated = await migrateLegacyData(chatId);
            if (legacyMigrated) {
                log(`Legacy data migrated for chat: ${chatId}`);
            }
            const { ensureMoonConfigMigrated } = await import('./data/moons.js');
            const moonMigrated = await ensureMoonConfigMigrated(chatId);
            if (moonMigrated) log(`Moon configuration migrated to per-chat storage for ${chatId}.`);

            // Migrate event data to ensure all events have latest fields
            const { migrateEventData, cleanupPromotedConcludedEvents } = await import('./data/events.js');
            const eventsMigrated = await migrateEventData(chatId);
            if (eventsMigrated > 0) {
                log(`Event data migration: ${eventsMigrated} events updated for chat ${chatId}`);
            }
            const promotedEventsCleaned = await cleanupPromotedConcludedEvents(chatId);
            if (promotedEventsCleaned > 0) {
                log(`Promoted Event cleanup: ${promotedEventsCleaned} concluded event(s) moved to Past Events.`);
            }

            const { migrateTemporalState } = await import('./data/timeMigration.js');
            const temporal = await migrateTemporalState(chatId);
            if (temporal.changed) {
                log(`Temporal state migration: dayCount ${temporal.dayCount}, elapsed story days ${temporal.elapsedStoryDays}.`);
            }

            const { repairSecretKnowledgeIntegrity } = await import('./data/notebook.js');
            const repairedSecrets = await repairSecretKnowledgeIntegrity(chatId);
            if (repairedSecrets > 0) {
                log(`Secret knowledge integrity repair: ${repairedSecrets} secret(s) normalized.`);
            }
        } catch (e) {
            console.warn('[NWST] Migration check failed (non-fatal):', e);
        }
    }

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

    // 2. Run one-time migrations for the currently open chat (if needed)
    //    This handles the case where the user opens ST with a chat already active
    try {
        const { chatId } = SillyTavern.getContext();
        if (chatId) {
            const { migrateLegacyData } = await import('./data/storage.js');
            const legacyMigrated = await migrateLegacyData(chatId);
            if (legacyMigrated) log(`Legacy data migrated for current chat: ${chatId}`);
            const { ensureMoonConfigMigrated } = await import('./data/moons.js');
            const moonMigrated = await ensureMoonConfigMigrated(chatId);
            if (moonMigrated) log(`Moon configuration migrated to per-chat storage for current chat.`);

            // Migrate event data to ensure all events have the latest fields
            // (participants, promotion metadata, and temporal bookkeeping fields)
            const { migrateEventData, cleanupPromotedConcludedEvents } = await import('./data/events.js');
            const eventsMigrated = await migrateEventData(chatId);
            if (eventsMigrated > 0) log(`Event data migration: ${eventsMigrated} events updated for chat ${chatId}`);
            const promotedEventsCleaned = await cleanupPromotedConcludedEvents(chatId);
            if (promotedEventsCleaned > 0) log(`Promoted Event cleanup: ${promotedEventsCleaned} concluded event(s) moved to Past Events.`);


            const { migrateTemporalState } = await import('./data/timeMigration.js');
            const temporal = await migrateTemporalState(chatId);
            if (temporal.changed) log(`Temporal state migration: dayCount ${temporal.dayCount}, elapsed story days ${temporal.elapsedStoryDays}.`);


            const { repairSecretKnowledgeIntegrity } = await import('./data/notebook.js');
            const repairedSecrets = await repairSecretKnowledgeIntegrity(chatId);
            if (repairedSecrets > 0) log(`Secret knowledge integrity repair: ${repairedSecrets} secret(s) normalized.`);
        }
    } catch (e) {
        console.warn('[NWST] Init migration check failed (non-fatal):', e);
    }

    // 3. Register the panel in ST's extensions dropdown
    await registerPanel();

    // 3a. Register the entry in ST's magic wand menu (chatbar dropdown)
    registerMagicWandMenuEntry();

    // 3b. Dynamically import UI modules to avoid circular dependency
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

    // Register slash commands
    await registerSlashCommands();
    log('Slash commands registered (/dayadv, /dayrewind).');

    log('NWST initialization complete. ✅');
    log('───────────────────────────────────────────');
}

// ── Slash commands ───────────────────────────────────────────────────────────

/**
 * Register NWST slash commands with SillyTavern.
 *
 * /dayadv   — Advance to the next day (same as pressing the › button)
 * /dayrewind — Restore the previous day from snapshot (same as pressing ‹)
 */
async function registerSlashCommands() {
    try {
        const { SlashCommandParser, SlashCommand } =
            SillyTavern.getContext();

        if (!SlashCommandParser || !SlashCommand) {
            console.warn('[NWST] SlashCommandParser not available — slash commands not registered.');
            return;
        }

        // /dayadv — advance one day forward
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'dayadv',
            helpString: 'Advance the NWST world state to the next in-game day.',
            unnamedArgumentList: [],
            callback: async () => {
                try {
                    const { advanceToNextDay } = await import('./llm/dayAdvancement.js');
                    nwstToast('Advancing day...', 'info');
                    const success = await advanceToNextDay();
                    if (success) {
                        if (typeof window?.nwstRefreshTabs === 'function') {
                            window.nwstRefreshTabs('home', 'events');
                        }
                    }
                } catch (err) {
                    console.error('[NWST] /dayadv failed:', err);
                    nwstToast('Day advancement failed. Check the console.', 'error');
                }
                return '';
            }
        }));

        // /dayrewind — restore the most recent previous day snapshot
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'dayrewind',
            helpString: 'Restore the NWST world state to the previous in-game day snapshot.',
            unnamedArgumentList: [],
            callback: async () => {
                try {
                    const { restorePreviousDay } = await import('./llm/dayAdvancement.js');
                    const { getDayBoundarySnapshots } = await import('./data/worldState.js');

                    const chatId = getChatId();
                    if (!chatId) {
                        nwstToast('No active chat.', 'warning');
                        return '';
                    }

                    const snapshots = getDayBoundarySnapshots(chatId);
                    if (!snapshots || snapshots.length === 0) {
                        nwstToast('No previous day snapshot found.', 'warning');
                        return '';
                    }

                    // Always restore the most recent snapshot (index 0)
                    const target = snapshots[0];
                    nwstToast('Rewinding to previous day...', 'info');
                    await restorePreviousDay(target.key);

                    if (typeof window?.nwstRefreshTabs === 'function') {
                        window.nwstRefreshTabs('home', 'events');
                    }
                } catch (err) {
                    console.error('[NWST] /dayrewind failed:', err);
                    nwstToast('Day rewind failed. Check the console.', 'error');
                }
                return '';
            }
        }));

        // /secretsdebug — show the secrets scoring decision report
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'secretsdebug',
            helpString: 'Show the NWST secrets scoring report: scene context, per-secret scores, and why each was injected or skipped.',
            unnamedArgumentList: [],
            callback: async () => {
                try {
                    const { buildSecretsDebugReport } = await import('./llm/secretsDebug.js');
                    const report = buildSecretsDebugReport(getChatId());
                    const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
                    // Show in a monospace-friendly popup
                    await callGenericPopup(
                        `<pre style="text-align:left;white-space:pre-wrap;font-size:12px;max-height:70vh;overflow:auto">${report.replace(/</g,'&lt;')}</pre>`,
                        POPUP_TYPE.TEXT, '', { wide: true, large: true }
                    );
                } catch (err) {
                    console.error('[NWST] /secretsdebug failed:', err);
                    nwstToast('Secrets debug failed. Check the console.', 'error');
                }
                return '';
            }
        }));

    } catch (err) {
        console.warn('[NWST] Slash command registration failed:', err);
    }
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
