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

import { getSettingContext, saveSettingContext } from '../data/worldState.js';
import { getChatId, nwstToast } from '../index.js';
import { download } from '../../../../utils.js';
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
            <button class="menu_button nwst-btn" id="nwst-setting-batchScan" style="border-color:#7F77DD;color:#3C3489">Run batch scan</button>
            <span id="nwst-batchScan-spinner" style="display:none;margin-left:8px;" class="nwst-spinner"></span>
        </div>

        <!-- ── Data Import / Export ────────────────────────────── -->
        <div class="nwst-lbl">Data</div>
        <div class="nwst-btn-row">
            <button class="menu_button nwst-btn" id="nwst-setting-importAll">Import all</button>
            <button class="menu_button nwst-btn" id="nwst-setting-exportAll">Export all</button>
        </div>

        <!-- Hidden file input for import -->
        <input type="file" id="nwst-import-file" accept=".json" style="display:none">
    `;

    // Populate UI with current values and wire events
    populateSettingsUI();
    wireSettingsEvents();
}

// ── Populate UI with current settings values ──────────────────────────────

function populateSettingsUI() {
    // Connection profile dropdowns
    populateConnectionProfileDropdowns();

    // Scan frequency
    const freqInput = document.getElementById('nwst-setting-scanFrequency');
    if (freqInput) freqInput.value = getScanFrequency();

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

        // Refresh dropdown on click (in case profiles changed)
        select.addEventListener('click', () => {
            populateConnectionProfileDropdowns();
        });
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
