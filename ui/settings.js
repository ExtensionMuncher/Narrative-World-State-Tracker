/* eslint-disable */
// =============================================================================
// NWST Settings Tab UI — ui/settings.js
// =============================================================================
// Builds and manages the Settings tab pane. All UI matches nwst-mockup.html.
//
// Sections:
//   1. Connection profiles (3 dropdowns from ST's connection manager)
//   2. Setting context (per-chat world description)
//   3. Injection settings (toggles + placement + depth/role)
//   4. Planner prompt (the ONLY user-editable prompt)
//   5. Batch scan button
//   6. Import/Export data
// =============================================================================

import {
    isEnabled, setEnabled,
    isPaused, setPaused,
    getConnectionProfiles, setConnectionProfile,
    getScanFrequency, setScanFrequency,
    getInjectionSettings, setInjectionSetting,
    getPlannerPrompt, setPlannerPrompt, resetPlannerPrompt, getDefaultPlannerPrompt,
    exportGlobalSettings, importGlobalSettings,
    exportChatData, importChatData,
    exportAll, importAll
} from '../settings.js';

import { getSettingContext, saveSettingContext, getSeasonConfig, saveSeasonConfig, getCurrentDay, updateCurrentDay } from '../data/worldState.js';
import { getChatId, nwstToast, getSetting, setSetting } from '../index.js';
import { download } from '../../../../utils.js';
import { deleteAllChatData } from '../data/storage.js';
import { runBatchScan } from '../llm/batchScan.js';

// ── Build the Settings tab HTML ───────────────────────────────────────────

/**
 * Build the complete Settings tab HTML and inject it into the settings pane.
 * Called once when the extension initializes or when the settings tab is first opened.
 */
export function buildSettingsTab() {
    const pane = document.getElementById('nwst-pane-settings');
    if (!pane) {
        console.error('[NWST Settings UI] Settings pane not found.');
        return;
    }

    pane.innerHTML = `
        <!-- ── Connection Profiles ────────────────────────────── -->
        <div class="nwst-lbl">Connection profiles</div>
        <div class="nwst-card">
            <!-- Planning LLM -->
            <div style="font-size:12px;color:#666;margin-bottom:4px">Planning LLM</div>
            <div style="font-size:11px;color:#999;margin-bottom:6px;line-height:1.4">
                Handles Current Day synthesis, world state, notebook, communities, time skips, event generation, and batch scan
            </div>
            <select id="nwst-setting-planningLLM" style="margin-bottom:12px"></select>

            <!-- Day Advancement LLM -->
            <div style="font-size:12px;color:#666;margin-bottom:4px">Day Advancement LLM</div>
            <div style="font-size:11px;color:#999;margin-bottom:6px;line-height:1.4">
                Handles date, forecast, moon phase updates, and front-facing event display
            </div>
            <select id="nwst-setting-dayAdvancementLLM" style="margin-bottom:12px"></select>

            <!-- Narrative Consistency LLM -->
            <div style="font-size:12px;color:#666;margin-bottom:4px">Narrative Consistency</div>
            <div style="font-size:11px;color:#999;margin-bottom:6px;line-height:1.4">
                Monitors secrets for knowledge leaks, flags inconsistencies, and manages selective secret injection. A reliable mid-size model is recommended (Mistral Small 24B, Qwen 3.5 9B, or equivalent) — this is a consistency check, not a creative task.
            </div>
            <select id="nwst-setting-narrativeConsistencyLLM" style="margin-bottom:12px"></select>

            <!-- Scan frequency -->
            <div style="font-size:12px;color:#666;margin-bottom:4px">Scan frequency</div>
            <div style="display:flex;align-items:center;gap:8px">
                <input type="number" id="nwst-setting-scanFrequency" value="20" min="1" max="100" style="width:60px;text-align:center">
                <span style="font-size:12px;color:#666">messages</span>
            </div>
        </div>

        <!-- ── World Climate / Atmosphere ───────────────────────── -->
        <div class="nwst-lbl">World climate / atmosphere</div>
        <div class="nwst-card">
            <!-- Enable/disable moons entirely -->
            <div class="nwst-setting-row" style="margin-bottom:10px">
                <div>
                    <div class="nwst-setting-label">Enable moons</div>
                    <div class="nwst-setting-sub">Disable to hide the moon phase system entirely</div>
                </div>
                <label class="nwst-toggle">
                    <input type="checkbox" id="nwst-setting-enableMoons" checked>
                    <span class="nwst-slider"></span>
                </label>
            </div>

            <!-- Primary moon cycle length (legacy/fallback) -->
            <div style="font-size:12px;color:#666;margin-bottom:4px">Default cycle length</div>
            <div style="font-size:11px;color:#999;margin-bottom:6px;line-height:1.4">
                The default lunar cycle length (29.53 days for Earth). Used as fallback when no moons are configured.
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
                <input type="number" id="nwst-setting-moonCycleDays" value="29.53" min="1" max="999" step="0.01" style="width:80px;text-align:center">
                <span style="font-size:12px;color:#666">days per cycle</span>
            </div>

            <!-- Enable/disable moon phenomena -->
            <div class="nwst-setting-row" style="margin-bottom:10px">
                <div>
                    <div class="nwst-setting-label">Enable moon phenomena</div>
                    <div class="nwst-setting-sub">Eclipses, blue moons, super moons, blood moons — rare natural events that appear alongside normal phases</div>
                </div>
                <label class="nwst-toggle">
                    <input type="checkbox" id="nwst-setting-enableMoonPhenomena" checked>
                    <span class="nwst-slider"></span>
                </label>
            </div>

            <!-- Multi-moon list -->
            <div style="font-size:12px;color:#666;margin-bottom:4px">Configured moons</div>
            <div style="font-size:11px;color:#999;margin-bottom:6px;line-height:1.4">
                Add multiple moons or remove all for a moonless world. Each moon has its own cycle length. Any enabled moon appears in the forecast strip individually.
            </div>
            <div id="nwst-moons-list" style="margin-bottom:8px"></div>
            <div class="nwst-btn-row">
                <button class="menu_button nwst-btn" id="nwst-setting-addMoon" style="font-size:11px;padding:3px 9px">+ Add Moon</button>
            </div>

            <!-- Hidden template for moon entry -->
            <template id="nwst-moon-entry-tpl">
                <div class="nwst-moon-entry" style="display:flex;align-items:center;gap:6px;padding:4px 6px;margin-bottom:4px;border-radius:4px;background:var(--dark1,rgba(0,0,0,0.04))">
                    <input type="checkbox" class="nwst-moon-enabled" checked style="margin:0;flex-shrink:0" title="Enable this moon">
                    <input type="text" class="nwst-moon-name" value="The Moon" placeholder="Name" style="flex:1;min-width:80px">
                    <input type="number" class="nwst-moon-cycle" value="29.53" min="1" max="999" step="0.01" style="width:60px;text-align:center" title="Cycle length (days)">
                    <span style="font-size:11px;color:#888;white-space:nowrap">days</span>
                    <button class="menu_button nwst-moon-remove" style="font-size:11px;padding:1px 5px;color:#c33" title="Remove this moon">✕</button>
                </div>
            </template>
        </div>

        <!-- ── Setting Context (per-chat) ─────────────────────── -->
        <div class="nwst-lbl">Setting context</div>
        <div class="nwst-card">
            <div style="font-size:12px;color:#666;margin-bottom:8px;line-height:1.5">
                Describe your world's climate, geography, and setting. The day advancement LLM reads this when generating weather forecasts so it knows what kind of world it's operating in — real-world location, fantasy biome, or anything in between. <strong>This is saved per-chat</strong> — each roleplay can have a completely different setting.
            </div>
            <textarea id="nwst-setting-context" rows="4" style="margin-bottom:8px"
                placeholder="e.g. Feudal Japan, late autumn, mountain valley surrounded by cedar forests. Climate is temperate with cold winters. Humidity is moderate. OR: High fantasy desert kingdom, perpetually arid, rare thunderstorms in the dry season..."></textarea>
            <div class="nwst-btn-row">
                <button class="menu_button nwst-btn" id="nwst-setting-saveContext">Save</button>
            </div>
        </div>

        <!-- ── Season Configuration (per-chat) ────────────────── -->
        <div class="nwst-lbl">Season configuration</div>
        <div class="nwst-card">
            <div style="font-size:12px;color:#666;margin-bottom:8px;line-height:1.5">
                Configure how seasons are determined for this chat. <strong>This is saved per-chat</strong> — each roleplay can have different seasonal patterns. When enabled (mode: Auto or Static), the computed season overrides whatever the LLM writes for the season field. The LLM still writes evocative seasonal prose, but the engine is the authority on which season it is.
            </div>

            <!-- Mode selector -->
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
                <div style="font-size:12px;color:#666;white-space:nowrap">Mode</div>
                <select id="nwst-setting-seasonMode" style="flex:1">
                    <option value="auto">Auto — seasons cycle based on day count</option>
                    <option value="static">Static — always the first season</option>
                    <option value="disabled">Disabled — LLM controls seasons (legacy)</option>
                </select>
            </div>

            <!-- Year length (only relevant for auto mode) -->
            <div id="nwst-season-yearLength-row" style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
                <div style="font-size:12px;color:#666;white-space:nowrap">Year length</div>
                <input type="number" id="nwst-setting-seasonYearLength" value="365" min="1" max="9999" style="width:70px;text-align:center">
                <span style="font-size:11px;color:#888">days in a full seasonal cycle</span>
            </div>

            <!-- Season bands editor -->
            <div id="nwst-season-bands-section">
                <div style="font-size:12px;color:#666;margin-bottom:6px">Season bands</div>
                <div style="font-size:11px;color:#999;margin-bottom:8px;line-height:1.4">
                    Each band defines a season's name and its day range within the year (0-based). Bands are checked in order — the first matching band is used.
                </div>
                <div id="nwst-season-bands-list"></div>
                <div class="nwst-btn-row" style="margin-top:6px">
                    <button class="menu_button nwst-btn" id="nwst-setting-addSeasonBand" style="font-size:11px;padding:3px 9px">+ Add Season Band</button>
                </div>
            </div>

            <!-- Editable day count (per-chat) -->
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding-top:8px;border-top:1px solid rgba(128,128,128,0.2)">
                <div style="font-size:12px;color:#666;white-space:nowrap">Current day count</div>
                <input type="number" id="nwst-setting-dayCount" value="0" min="0" style="width:70px;text-align:center">
                <span style="font-size:11px;color:#888">absolute elapsed days (controls season cycling)</span>
                <button class="menu_button nwst-btn" id="nwst-setting-saveDayCount" style="font-size:11px;padding:2px 7px;margin-left:auto">Update</button>
            </div>

            <!-- Save button -->
            <div class="nwst-btn-row" style="margin-top:4px">
                <button class="menu_button nwst-btn" id="nwst-setting-saveSeasonConfig">Save Season Config</button>
            </div>

            <!-- Hidden template for season band entry -->
            <template id="nwst-season-band-tpl">
                <div class="nwst-season-band-entry" style="display:flex;align-items:center;gap:6px;padding:4px 6px;margin-bottom:4px;border-radius:4px;background:var(--dark1,rgba(0,0,0,0.04))">
                    <input type="text" class="nwst-season-band-name" value="Spring" placeholder="Name" style="flex:1;min-width:80px">
                    <span style="font-size:11px;color:#888">from day</span>
                    <input type="number" class="nwst-season-band-start" value="0" min="0" max="9999" style="width:55px;text-align:center">
                    <span style="font-size:11px;color:#888">to day</span>
                    <input type="number" class="nwst-season-band-end" value="91" min="0" max="9999" style="width:55px;text-align:center">
                    <button class="menu_button nwst-season-band-remove" style="font-size:11px;padding:1px 5px;color:#c33" title="Remove this season band">✕</button>
                </div>
            </template>
        </div>

        <!-- ── Injection Settings ──────────────────────────────── -->
        <div class="nwst-lbl">Injection settings</div>
        <div class="nwst-card">
            <div class="nwst-setting-row">
                <div>
                    <div class="nwst-setting-label">Inject current day</div>
                    <div class="nwst-setting-sub">Date, season, weather, flora/fauna, spiritual climate</div>
                </div>
                <label class="nwst-toggle">
                    <input type="checkbox" id="nwst-setting-injectCurrentDay" checked>
                    <span class="nwst-slider"></span>
                </label>
            </div>
            <div class="nwst-setting-row">
                <div>
                    <div class="nwst-setting-label">Inject upcoming events</div>
                    <div class="nwst-setting-sub">Immediate, this week, this month, undetermined — resolved and missed events excluded</div>
                </div>
                <label class="nwst-toggle">
                    <input type="checkbox" id="nwst-setting-injectEvents" checked>
                    <span class="nwst-slider"></span>
                </label>
            </div>
            <div class="nwst-setting-row">
                <div>
                    <div class="nwst-setting-label">Inject world conditions</div>
                    <div class="nwst-setting-sub">Only active (eye-on) conditions are injected</div>
                </div>
                <label class="nwst-toggle">
                    <input type="checkbox" id="nwst-setting-injectWorldConditions" checked>
                    <span class="nwst-slider"></span>
                </label>
            </div>
            <div class="nwst-setting-row">
                <div><div class="nwst-setting-label">Injection placement</div></div>
                <select id="nwst-setting-placement" style="width:180px;flex-shrink:0">
                    <option value="before_main">Before Main Prompt / Story String</option>
                    <option value="after_main">After Main Prompt / Story String</option>
                    <option value="top_an">Top of Author's Note</option>
                    <option value="bottom_an">Bottom of Author's Note</option>
                    <option value="at_depth">Inject at Depth</option>
                </select>
            </div>
            <div class="nwst-setting-row" id="nwst-depth-row" style="display:none">
                <div>
                    <div class="nwst-setting-label">Depth</div>
                    <div class="nwst-setting-sub">Number of messages from the bottom</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                    <input type="number" id="nwst-setting-depth" value="2" min="0" max="99" style="width:52px;text-align:center">
                    <select id="nwst-setting-depthRole" style="width:90px">
                        <option value="system">System</option>
                        <option value="user">User</option>
                        <option value="assistant">Assistant</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- ── Planner Prompt ──────────────────────────────────── -->
        <div class="nwst-lbl">Planner prompt</div>
        <div class="nwst-card">
            <div style="font-size:12px;color:#666;margin-bottom:8px;line-height:1.5">
                Customize how the planner LLM updates world state and generates events. <strong>This is the only user-editable prompt</strong> — all other LLM prompts (scanner, day advancement, event generation, time skip, batch scan, narrative consistency) are internal and not exposed.
            </div>
            <textarea id="nwst-setting-plannerPrompt" rows="4" style="margin-bottom:8px"></textarea>
            <div class="nwst-btn-row">
                <button class="menu_button nwst-btn" id="nwst-setting-importPrompt">Import</button>
                <button class="menu_button nwst-btn" id="nwst-setting-exportPrompt">Export</button>
                <button class="menu_button nwst-btn" id="nwst-setting-resetPrompt">Reset to default</button>
            </div>
        </div>

        <!-- ── Batch Scan ──────────────────────────────────────── -->
        <div class="nwst-lbl">Batch scan</div>
        <div class="nwst-card">
            <div style="font-size:12px;color:#666;margin-bottom:10px;line-height:1.5">
                Scan your full chat history to generate an initial world state. Creates a current day entry, populates the event horizon, fills active world conditions, seeds the notebook, and groups any detected communities. Runs once — does not overwrite existing data.
            </div>
            <button class="menu_button nwst-btn" id="nwst-setting-batchScan" style="font-size:11px;padding:3px 9px">Run batch scan</button>
            <span id="nwst-batchScan-spinner" style="display:none;margin-left:8px;" class="nwst-spinner"></span>
        </div>

        <!-- ── Data Import / Export / Clear ────────────────────── -->
        <div class="nwst-lbl">Data</div>
        <div class="nwst-btn-row">
            <button class="menu_button nwst-btn" id="nwst-setting-importAll">Import all</button>
            <button class="menu_button nwst-btn" id="nwst-setting-exportAll">Export all</button>
            <button class="menu_button nwst-btn" id="nwst-setting-clearAll" style="font-size:11px;padding:3px 9px">Clear all</button>
        </div>

        <!-- Hidden file input for import -->
        <input type="file" id="nwst-import-file" accept=".json" style="display:none">
    `;

    // Populate UI with current values and wire events
    populateSettingsUI();
    wireSettingsEvents();
}

// ── Season Configuration UI ────────────────────────────────────────────────

/**
 * Populate the season config UI controls from the stored per-chat config.
 */
function populateSeasonConfigUI() {
    const chatId = getChatId();
    if (!chatId) return;

    const config = getSeasonConfig(chatId);

    const modeSelect = document.getElementById('nwst-setting-seasonMode');
    if (modeSelect) modeSelect.value = config.mode || 'auto';

    const yearLengthInput = document.getElementById('nwst-setting-seasonYearLength');
    if (yearLengthInput) yearLengthInput.value = config.yearLength || 365;

    // Show/hide year length and bands based on mode
    const yearLengthRow = document.getElementById('nwst-season-yearLength-row');
    const bandsSection = document.getElementById('nwst-season-bands-section');
    const isAuto = config.mode === 'auto';
    if (yearLengthRow) yearLengthRow.style.display = isAuto ? 'flex' : 'none';
    if (bandsSection) bandsSection.style.display = isAuto ? 'block' : 'none';

    // Populate dayCount from currentDay
    const dayCountInput = document.getElementById('nwst-setting-dayCount');
    if (dayCountInput) {
        const currentDay = getCurrentDay(chatId);
        dayCountInput.value = (currentDay && typeof currentDay.dayCount === 'number') ? currentDay.dayCount : 0;
    }

    renderSeasonBandsList();
}

/**
 * Render the season bands editor list from stored config.
 */
function renderSeasonBandsList() {
    const container = document.getElementById('nwst-season-bands-list');
    if (!container) return;

    const chatId = getChatId();
    if (!chatId) return;

    const config = getSeasonConfig(chatId);
    const seasons = config.seasons || [];
    const template = document.getElementById('nwst-season-band-tpl');
    if (!template) return;

    container.innerHTML = '';

    for (let i = 0; i < seasons.length; i++) {
        const s = seasons[i];
        const clone = template.content.cloneNode(true);

        const nameInput = clone.querySelector('.nwst-season-band-name');
        const startInput = clone.querySelector('.nwst-season-band-start');
        const endInput = clone.querySelector('.nwst-season-band-end');
        const removeBtn = clone.querySelector('.nwst-season-band-remove');

        nameInput.value = s.name || 'Season';
        startInput.value = s.startDay !== undefined ? s.startDay : 0;
        endInput.value = s.endDay !== undefined ? s.endDay : 0;

        // Wire inline changes to storage
        const updateBand = () => {
            const cfg = getSeasonConfig(chatId);
            if (cfg.seasons[i]) {
                cfg.seasons[i].name = nameInput.value.trim() || 'Season';
                cfg.seasons[i].startDay = parseInt(startInput.value, 10) || 0;
                cfg.seasons[i].endDay = parseInt(endInput.value, 10) || 0;
                // We don't auto-save — user clicks "Save Season Config"
            }
        };
        nameInput.addEventListener('change', updateBand);
        startInput.addEventListener('change', updateBand);
        endInput.addEventListener('change', updateBand);

        removeBtn.addEventListener('click', () => {
            const cfg = getSeasonConfig(chatId);
            if (cfg.seasons.length <= 1) {
                nwstToast('Cannot remove the last season band.', 'warning');
                return;
            }
            cfg.seasons.splice(i, 1);
            saveSeasonConfig(chatId, cfg);
            renderSeasonBandsList();
        });

        container.appendChild(clone);
    }
}

// ── Populate UI with current settings values ──────────────────────────────

function populateSettingsUI() {
    // Connection profile dropdowns
    populateConnectionProfileDropdowns();

    // Scan frequency
    const freqInput = document.getElementById('nwst-setting-scanFrequency');
    if (freqInput) freqInput.value = getScanFrequency();

    // Moon cycle
    const moonCycleInput = document.getElementById('nwst-setting-moonCycleDays');
    if (moonCycleInput) moonCycleInput.value = getSetting('moonCycleDays') || 29.53;
    setCheckbox('nwst-setting-enableMoons', getSetting('enableMoons') !== false);
    setCheckbox('nwst-setting-enableMoonPhenomena', getSetting('enableMoonPhenomena') !== false);
    renderMoonsList();

    // Setting context (per-chat — load from storage)
    const chatId = getChatId();
    const contextTextarea = document.getElementById('nwst-setting-context');
    if (contextTextarea) contextTextarea.value = getSettingContext(chatId);

    // Injection toggles
    const inj = getInjectionSettings();
    setCheckbox('nwst-setting-injectCurrentDay', inj.injectCurrentDay);
    setCheckbox('nwst-setting-injectEvents', inj.injectEvents);
    setCheckbox('nwst-setting-injectWorldConditions', inj.injectWorldConditions);

    // Injection placement
    const placementSelect = document.getElementById('nwst-setting-placement');
    if (placementSelect) {
        placementSelect.value = inj.placement;
        // Show/hide depth row based on current placement
        toggleDepthRow(inj.placement);
    }

    // Depth and role
    const depthInput = document.getElementById('nwst-setting-depth');
    if (depthInput) depthInput.value = inj.depth;
    const depthRole = document.getElementById('nwst-setting-depthRole');
    if (depthRole) depthRole.value = inj.depthRole;

    // Planner prompt
    const promptTextarea = document.getElementById('nwst-setting-plannerPrompt');
    if (promptTextarea) promptTextarea.value = getPlannerPrompt();

    // Season configuration (per-chat)
    populateSeasonConfigUI();
}

/**
 * Render the multi-moon list from settings and wire up add/remove events.
 */
function renderMoonsList() {
    const container = document.getElementById('nwst-moons-list');
    if (!container) return;

    const moons = getSetting('moons') || [];
    const template = document.getElementById('nwst-moon-entry-tpl');
    if (!template) return;

    container.innerHTML = '';

    for (let i = 0; i < moons.length; i++) {
        const moon = moons[i];
        const clone = template.content.cloneNode(true);

        const cb = clone.querySelector('.nwst-moon-enabled');
        const nameInput = clone.querySelector('.nwst-moon-name');
        const cycleInput = clone.querySelector('.nwst-moon-cycle');
        const removeBtn = clone.querySelector('.nwst-moon-remove');

        cb.checked = moon.enabled !== false;
        nameInput.value = moon.name || 'The Moon';
        cycleInput.value = moon.cycleDays || 29.53;

        // Wire events
        const updateMoon = () => {
            const m = getSetting('moons') || [];
            if (m[i]) {
                m[i].enabled = cb.checked;
                m[i].name = nameInput.value.trim() || 'The Moon';
                m[i].cycleDays = parseFloat(cycleInput.value) || 29.53;
                setSetting('moons', m);
            }
        };
        cb.addEventListener('change', updateMoon);
        nameInput.addEventListener('change', updateMoon);
        cycleInput.addEventListener('change', updateMoon);

        removeBtn.addEventListener('click', () => {
            const m = getSetting('moons') || [];
            if (m.length <= 1) {
                nwstToast('Cannot remove the last moon. Set its cycle length to 0 or disable moons entirely.', 'warning');
                return;
            }
            m.splice(i, 1);
            setSetting('moons', m);
            renderMoonsList();
        });

        container.appendChild(clone);
    }
}

// ── Connection profile dropdowns ──────────────────────────────────────────

/**
 * Populate the three connection profile dropdowns from ST's connection manager.
 * Follows the same pattern used by other ST extensions (e.g., MessageSummarize).
 */
function populateConnectionProfileDropdowns() {
    const dropdowns = [
        { id: 'nwst-setting-planningLLM', profileKey: 'planningLLM' },
        { id: 'nwst-setting-dayAdvancementLLM', profileKey: 'dayAdvancementLLM' },
        { id: 'nwst-setting-narrativeConsistencyLLM', profileKey: 'narrativeConsistencyLLM' }
    ];

    // Get connection profiles from ST's connection manager
    let profiles = [];
    try {
        const ctx = SillyTavern.getContext();
        // Check if connection-manager extension is active
        if (ctx.extensionSettings?.connectionManager?.profiles) {
            profiles = ctx.extensionSettings.connectionManager.profiles;
        }
    } catch (e) {
        console.warn('[NWST Settings UI] Could not read connection profiles:', e);
    }

    for (const dd of dropdowns) {
        const select = document.getElementById(dd.id);
        if (!select) continue;

        // Clear and add default option
        select.innerHTML = '<option value="">— Same as current chat profile —</option>';

        // Add each connection profile as an option
        for (const profile of profiles) {
            const option = document.createElement('option');
            option.value = profile.id || profile.name;
            option.textContent = profile.name || profile.id;
            select.appendChild(option);
        }

        // Set current value
        const currentProfileId = getConnectionProfiles()[dd.profileKey];
        if (currentProfileId) {
            select.value = currentProfileId;
        }

    }
}

// ── Wire events for all settings controls ─────────────────────────────────

function wireSettingsEvents() {
    // ── Connection profile dropdowns ─────────────────────────────
    wireSelect('nwst-setting-planningLLM', (val) => setConnectionProfile('planningLLM', val));
    wireSelect('nwst-setting-dayAdvancementLLM', (val) => setConnectionProfile('dayAdvancementLLM', val));
    wireSelect('nwst-setting-narrativeConsistencyLLM', (val) => setConnectionProfile('narrativeConsistencyLLM', val));

    // ── Scan frequency ───────────────────────────────────────────
    wireInput('nwst-setting-scanFrequency', (val) => {
        const num = parseInt(val, 10);
        if (num >= 1 && num <= 100) setScanFrequency(num);
    });

    // ── Moon cycle ─────────────────────────────────────────────
    wireInput('nwst-setting-moonCycleDays', (val) => {
        const num = parseFloat(val);
        if (num >= 1 && num <= 999) setSetting('moonCycleDays', num);
    });
    wireCheckbox('nwst-setting-enableMoons', (checked) => setSetting('enableMoons', checked));
    wireCheckbox('nwst-setting-enableMoonPhenomena', (checked) => setSetting('enableMoonPhenomena', checked));

    // ── Add Moon button ────────────────────────────────────────
    const addMoonBtn = document.getElementById('nwst-setting-addMoon');
    if (addMoonBtn) {
        addMoonBtn.addEventListener('click', () => {
            const moons = getSetting('moons') || [];
            const newId = 'moon_' + Date.now();
            moons.push({ id: newId, name: 'New Moon', cycleDays: 29.53, enabled: true });
            setSetting('moons', moons);
            renderMoonsList();
        });
    }

    // ── Setting context (per-chat) ───────────────────────────────
    const saveContextBtn = document.getElementById('nwst-setting-saveContext');
    if (saveContextBtn) {
        saveContextBtn.addEventListener('click', () => {
            const chatId = getChatId();
            const textarea = document.getElementById('nwst-setting-context');
            if (textarea) {
                saveSettingContext(chatId, textarea.value);
                nwstToast('Setting context saved.', 'success');
            }
        });
    }

    // ── Injection toggles ────────────────────────────────────────
    wireCheckbox('nwst-setting-injectCurrentDay', (checked) => setInjectionSetting('injectCurrentDay', checked));
    wireCheckbox('nwst-setting-injectEvents', (checked) => setInjectionSetting('injectEvents', checked));
    wireCheckbox('nwst-setting-injectWorldConditions', (checked) => setInjectionSetting('injectWorldConditions', checked));

    // ── Injection placement ──────────────────────────────────────
    wireSelect('nwst-setting-placement', (val) => {
        setInjectionSetting('placement', val);
        toggleDepthRow(val);
    });

    // ── Depth and role ───────────────────────────────────────────
    wireInput('nwst-setting-depth', (val) => {
        const num = parseInt(val, 10);
        if (num >= 0 && num <= 99) setInjectionSetting('depth', num);
    });
    wireSelect('nwst-setting-depthRole', (val) => setInjectionSetting('depthRole', val));

    // ── Season Configuration ─────────────────────────────────────
    // Mode selector — show/hide year length and bands based on mode
    const seasonModeSelect = document.getElementById('nwst-setting-seasonMode');
    if (seasonModeSelect) {
        seasonModeSelect.addEventListener('change', () => {
            const yearLengthRow = document.getElementById('nwst-season-yearLength-row');
            const bandsSection = document.getElementById('nwst-season-bands-section');
            const isAuto = seasonModeSelect.value === 'auto';
            if (yearLengthRow) yearLengthRow.style.display = isAuto ? 'flex' : 'none';
            if (bandsSection) bandsSection.style.display = isAuto ? 'block' : 'none';
            // Don't save until "Save" is clicked
        });
    }

    // Add season band button
    const addBandBtn = document.getElementById('nwst-setting-addSeasonBand');
    if (addBandBtn) {
        addBandBtn.addEventListener('click', () => {
            const chatId = getChatId();
            if (!chatId) { nwstToast('No active chat.', 'error'); return; }
            const config = getSeasonConfig(chatId);
            // Find a reasonable default start day (after the last band's end + 1)
            let defaultStart = 0;
            let defaultEnd = 30;
            if (config.seasons.length > 0) {
                const last = config.seasons[config.seasons.length - 1];
                defaultStart = (last.endDay || 0) + 1;
                defaultEnd = defaultStart + 30;
            }
            config.seasons.push({ name: 'New Season', startDay: defaultStart, endDay: defaultEnd });
            saveSeasonConfig(chatId, config);
            renderSeasonBandsList();
        });
    }

    // Save season config button
    const saveSeasonBtn = document.getElementById('nwst-setting-saveSeasonConfig');
    if (saveSeasonBtn) {
        saveSeasonBtn.addEventListener('click', () => {
            const chatId = getChatId();
            if (!chatId) { nwstToast('No active chat.', 'error'); return; }

            const modeSelect = document.getElementById('nwst-setting-seasonMode');
            const yearLengthInput = document.getElementById('nwst-setting-seasonYearLength');

            // Read current band values from the DOM
            const bandEntries = document.querySelectorAll('#nwst-season-bands-list .nwst-season-band-entry');
            const seasons = [];
            bandEntries.forEach(entry => {
                const nameInput = entry.querySelector('.nwst-season-band-name');
                const startInput = entry.querySelector('.nwst-season-band-start');
                const endInput = entry.querySelector('.nwst-season-band-end');
                if (nameInput) {
                    seasons.push({
                        name: nameInput.value.trim() || 'Season',
                        startDay: parseInt(startInput?.value, 10) || 0,
                        endDay: parseInt(endInput?.value, 10) || 0
                    });
                }
            });

            const config = {
                mode: modeSelect ? modeSelect.value : 'auto',
                yearLength: parseInt(yearLengthInput?.value, 10) || 365,
                seasons: seasons.length > 0 ? seasons : [{ name: 'Spring', startDay: 0, endDay: 91 }]
            };

            saveSeasonConfig(chatId, config);
            nwstToast('Season configuration saved.', 'success');
        });
    }

    // ── Day Count (update instantly on button click) ──────────────
    const saveDayCountBtn = document.getElementById('nwst-setting-saveDayCount');
    if (saveDayCountBtn) {
        saveDayCountBtn.addEventListener('click', () => {
            const chatId = getChatId();
            if (!chatId) { nwstToast('No active chat.', 'error'); return; }
            const dayCountInput = document.getElementById('nwst-setting-dayCount');
            if (!dayCountInput) return;
            const newCount = parseInt(dayCountInput.value, 10);
            if (isNaN(newCount) || newCount < 0) {
                nwstToast('Day count must be a non-negative integer.', 'warning');
                return;
            }
            updateCurrentDay(chatId, { dayCount: newCount });
            nwstToast('Day count updated to ' + newCount + '.', 'success');
        });
    }

    // ── Planner prompt ───────────────────────────────────────────
    wireTextarea('nwst-setting-plannerPrompt', (val) => setPlannerPrompt(val));

    // Import planner prompt from file
    const importPromptBtn = document.getElementById('nwst-setting-importPrompt');
    if (importPromptBtn) {
        importPromptBtn.addEventListener('click', () => {
            triggerFileImport((text) => {
                const textarea = document.getElementById('nwst-setting-plannerPrompt');
                if (textarea) {
                    textarea.value = text;
                    setPlannerPrompt(text);
                    nwstToast('Planner prompt imported.', 'success');
                }
            });
        });
    }

    // Export planner prompt to file
    const exportPromptBtn = document.getElementById('nwst-setting-exportPrompt');
    if (exportPromptBtn) {
        exportPromptBtn.addEventListener('click', () => {
            const prompt = getPlannerPrompt();
            download(prompt, 'nwst-planner-prompt.txt', 'text/plain');
            nwstToast('Planner prompt exported.', 'info');
        });
    }

    // Reset planner prompt to default
    const resetPromptBtn = document.getElementById('nwst-setting-resetPrompt');
    if (resetPromptBtn) {
        resetPromptBtn.addEventListener('click', () => {
            resetPlannerPrompt();
            const textarea = document.getElementById('nwst-setting-plannerPrompt');
            if (textarea) textarea.value = getPlannerPrompt();
            nwstToast('Planner prompt reset to default.', 'info');
        });
    }

    // ── Batch scan ───────────────────────────────────────────────
    const batchScanBtn = document.getElementById('nwst-setting-batchScan');
    if (batchScanBtn) {
        batchScanBtn.addEventListener('click', async () => {
            await runBatchScan();
        });
    }

    // ── Import / Export All ──────────────────────────────────────
    const importAllBtn = document.getElementById('nwst-setting-importAll');
    if (importAllBtn) {
        importAllBtn.addEventListener('click', () => {
            triggerFileImport((text) => {
                const chatId = getChatId();
                const success = importAll(chatId, text);
                if (success) {
                    populateSettingsUI();
                    nwstToast('Settings and chat data imported successfully. UI refreshed.', 'success');
                } else {
                    nwstToast('Import failed — invalid file format.', 'error');
                }
            });
        });
    }

    const exportAllBtn = document.getElementById('nwst-setting-exportAll');
    if (exportAllBtn) {
        exportAllBtn.addEventListener('click', () => {
            const chatId = getChatId();
            const json = exportAll(chatId);
            download(json, `nwst-export-${chatId}.json`, 'application/json');
            nwstToast('Settings and chat data exported.', 'info');
        });
    }

    // ── Clear All (per-chat) ──────────────────────────────────
    const clearAllBtn = document.getElementById('nwst-setting-clearAll');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', async () => {
            const chatId = getChatId();
            if (!chatId) {
                nwstToast('No active chat detected.', 'error');
                return;
            }
            const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
            const confirmed = await callGenericPopup(
                'This will permanently delete ALL stored NWST data for this chat. Continue?',
                POPUP_TYPE.CONFIRM,
                '',
            );
            if (!confirmed) return;

            // Preserve the Setting Context — it describes the world and is
            // manually authored by the user, not auto-generated by the LLM.
            const preservedContext = getSettingContext(chatId);

            deleteAllChatData(chatId);

            // Restore the Setting Context
            if (preservedContext) {
                saveSettingContext(chatId, preservedContext);
            }

            nwstToast('All NWST data cleared for this chat (Setting Context preserved).', 'success');
            // Refresh the UI to reflect the cleared state
            populateSettingsUI();
        });
    }
}

// ── Helper: Show/hide the depth row based on placement selection ──────────

function toggleDepthRow(placement) {
    const depthRow = document.getElementById('nwst-depth-row');
    if (depthRow) {
        depthRow.style.display = (placement === 'at_depth') ? 'flex' : 'none';
    }
}

// ── Helper: Trigger a file import dialog and read the file ────────────────

function triggerFileImport(callback) {
    const fileInput = document.getElementById('nwst-import-file');
    if (!fileInput) return;

    // Remove old listener by cloning (simple way to reset)
    const newInput = fileInput.cloneNode(true);
    fileInput.parentNode.replaceChild(newInput, fileInput);

    newInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            callback(text);
        } catch (err) {
            console.error('[NWST Settings UI] File read error:', err);
            nwstToast('Failed to read file.', 'error');
        }

        // Reset so the same file can be re-imported
        newInput.value = '';
    });

    newInput.click();
}

// ── Wiring helpers ────────────────────────────────────────────────────────

function wireSelect(id, callback) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => callback(el.value));
}

function wireInput(id, callback) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => callback(el.value));
}

function wireCheckbox(id, callback) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => callback(el.checked));
}

function wireTextarea(id, callback) {
    const el = document.getElementById(id);
    if (el) {
        // Save on blur (user clicks away)
        el.addEventListener('blur', () => callback(el.value));
        // Also save periodically while typing (every 3 seconds of inactivity)
        let debounceTimer;
        el.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => callback(el.value), 3000);
        });
    }
}

function setCheckbox(id, checked) {
    const el = document.getElementById(id);
    if (el) el.checked = checked;
}

// ── Refresh all settings UI (called when chat changes) ────────────────────

/**
 * Refresh the settings tab with current values.
 * Called when the user switches chats or opens the settings tab.
 */
export function refreshSettingsUI() {
    populateSettingsUI();
}
