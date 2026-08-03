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
//   4. Per-chat world/calendar configuration and data tools
//   5. Batch scan button
//   6. Import/Export data
// =============================================================================

import {
    isDebugMode, setDebugMode,
    getConnectionProfiles, setConnectionProfile,
    getScanFrequency, setScanFrequency,
    getScanMinimumMessages, setScanMinimumMessages,
    getMaxSnapshotCount, setMaxSnapshotCount,
    getInjectionSettings, setInjectionSetting, getMaxActiveEvents, getDensityMode,
    getSecretBudgetTokens, setSecretBudgetTokens,
    getMaxSecretsInjected, getSidecarCadence, getSidecarScanRange, getInjectionThreshold,
    getSecretDecayThreshold, getReconcileCadence,
    getScoringWeights, setScoringWeight, setSecretsConfigValue,
    exportAll, importAll
} from '../settings.js';

import { getSettingContext, saveSettingContext, getSettingContextProfiles, saveSettingContextProfiles, createSettingContextProfile, setActiveSettingContextProfile, deleteSettingContextProfile, getWorldState, saveWorldState, getSeasonConfig, saveSeasonConfig, getCalendarConfig, saveCalendarConfig, getCurrentDay, updateCurrentDay, getStartDate, saveStartDate, getEraPin, saveEraPin } from '../data/worldState.js';
import { getMoonConfig, saveMoonConfig, updateMoonConfig, getMoonPhenomenonOverrides, saveMoonPhenomenonOverrides, MOON_OVERRIDE_PHENOMENA } from '../data/moons.js';
import { parseUserDate, parseDisplayDate, parseCurrentCalendarDate, daysBetweenCalendarDates, computeDeterministicDate, advanceCurrentCalendarDate, extractYearFromText, dateFromDayCount, dayOfYearFor, monthLengthsFor, gregorianWeekdayIndex, ordinalSuffix, formatYear, monthNamesFor, yearLengthFor, calendarMonthLayoutFor, calendarDateForBaseMonthDay, calendarMonthInfoForDate, isLunisolarCalendar } from '../lib/calendarMath.js';
import { SPECIAL_DAY_CATEGORIES } from '../data/specialDays.js';
import {
    NAGER_HOLIDAY_TYPES,
    ensureNagerHolidayCacheForCurrentWindow,
    getNagerSubdivisionOptions,
    getNagerCacheStatus,
    isNagerDateAvailable
} from '../data/nagerDate.js';
import { getChatId, nwstToast, getSetting, setSetting } from '../index.js';
import { download } from '../../../../utils.js';
import { deleteAllChatData, DEFAULT_SEASON_CONFIG, DEFAULT_CALENDAR_CONFIG } from '../data/storage.js';
import { runBatchScan } from '../llm/batchScan.js';
import { getSecretsMeta, setSecretsMeta } from '../data/secretsMeta.js';
import { rebaseElapsedStoryDays } from '../data/timeMigration.js';
import { getWeatherProfilesState, saveWeatherProfilesState, getActiveWeatherProfile, setActiveWeatherProfile, deleteWeatherProfile, makeDefaultWeatherProfile, upsertWeatherProfile, profileSummary, WEATHER_EVENT_DEFS } from '../data/severeWeather.js';
import { analyzeSettingContextToWeatherProfile } from '../llm/weatherProfile.js';
import { getContextSnapshots, getContextSnapshot, saveContextSnapshot, deleteContextSnapshot, clearContextSnapshots } from '../data/contextSnapshots.js';
import { dlog } from '../lib/debug.js';

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
        <div class="nwst-accordion-section">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-connections">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Connection profiles</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-connections">
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

                    <!-- Secrets Sidecar LLM -->
                    <div style="font-size:12px;color:#666;margin-bottom:4px">Secrets Sidecar</div>
                    <div style="font-size:11px;color:#999;margin-bottom:6px;line-height:1.4">
                        Analyzes each scene for the prose-based secrets engine — who is present (resolving pronouns), what kind of scene it is, and which narrative pressures are active. Runs frequently on its own cadence, so use a <strong>cheap, fast model</strong> (Mistral-Nemo, Haiku, a local 8B). This is NOT the heavy consistency model.
                    </div>
                    <select id="nwst-setting-secretsSidecarLLM" style="margin-bottom:12px"></select>

                    <!-- No-think (per connection profile) -->
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#888;margin-bottom:4px">No-think (per profile)</div>
                    <div style="font-size:11px;color:#999;margin-bottom:8px;line-height:1.4">
                        Soft appends <code>/no_think</code> (safe, ignored if unsupported). Hard also sends API params (<code>think</code>/<code>enable_thinking=false</code>) — turn off if your backend errors.
                    </div>
                    <div id="nwst-nothink-rows" style="margin-bottom:16px"></div>

                    <!-- Scan frequency -->
                    <div style="font-size:12px;color:#666;margin-bottom:4px">Scan frequency</div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
                        <input type="number" id="nwst-setting-scanFrequency" value="20" min="1" max="100" style="width:60px;text-align:center">
                        <span style="font-size:12px;color:#666">messages</span>
                    </div>

                    <!-- Output Density Mode -->
                    <div style="font-size:12px;color:#666;margin-bottom:4px">Output density</div>
                    <div style="font-size:11px;color:#999;margin-bottom:6px;line-height:1.4">
                        Controls how much text is injected into the main prompt on every message.
                        <strong>Token-Budget</strong> is extremely lean — structured labels, no prose.
                        <strong>Combined</strong> balances quality and token cost (recommended for most users).
                        <strong>Atmospheric</strong> is full narrative prose — what you currently have.
                    </div>
                    <select id="nwst-setting-densityMode" style="width:100%">
                        <option value="token-budget">Token-Budget — lean labels only (~120-300 tokens/msg)</option>
                        <option value="combined" selected>Combined — balanced prose (~300-600 tokens/msg)</option>
                        <option value="atmospheric">Atmospheric — full narrative (~600-1,400 tokens/msg)</option>
                    </select>
                </div>
                <div class="nwst-setting-row">
                    <div>
                        <div class="nwst-setting-label">Minimum messages before first scan</div>
                        <div class="nwst-setting-sub">How many messages must exist before the initial scan fires. Ignored if batch scan has already been run.</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                        <input type="number" id="nwst-setting-scanMinimumMessages" value="10" min="1" max="100" style="width:60px;text-align:center">
                        <span style="font-size:12px;color:#666">messages</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- ── Setting Context (per-chat) ─────────────────────── -->
        <div class="nwst-accordion-section">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-context">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Setting context</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-context">
                <div class="nwst-card">
                    <div style="font-size:12px;color:#666;margin-bottom:8px;line-height:1.5">
                        Save and switch between foundational setting/arc contexts for this chat — location, society, geography, supernatural rules, political frame, climate, or anything else NWST should treat as the current world baseline. Future scans, event generation, world conditions, and weather use the active profile. Switching profiles never rewrites stored state automatically; NWST asks whether you want to refresh setting-dependent presentation/state after an intentional switch. <strong>Profiles are saved per-chat and switched manually.</strong>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                        <select id="nwst-setting-contextProfile" style="flex:1;min-width:120px"></select>
                        <button type="button" class="menu_button nwst-btn" id="nwst-setting-newContextProfile">+ New</button>
                    </div>
                    <div class="nwst-btn-row" style="margin-bottom:8px">
                        <button type="button" class="menu_button nwst-btn" id="nwst-setting-duplicateContextProfile">Duplicate</button>
                        <button type="button" class="menu_button nwst-btn" id="nwst-setting-renameContextProfile">Rename</button>
                        <button type="button" class="menu_button nwst-btn-danger" id="nwst-setting-deleteContextProfile">Delete</button>
                    </div>
                    <textarea id="nwst-setting-context" rows="4" style="margin-bottom:8px"
                        placeholder="e.g. Feudal Japan, late autumn, mountain valley surrounded by cedar forests. Climate is temperate with cold winters. Humidity is moderate. OR: High fantasy desert kingdom, perpetually arid, rare thunderstorms in the dry season..."></textarea>
                    <div class="nwst-btn-row">
                        <button class="menu_button nwst-btn" id="nwst-setting-saveContext">Save Active Profile</button>
                        <button class="menu_button nwst-btn" id="nwst-setting-refreshContextState">Refresh Setting State…</button>
                    </div>
                    <!-- ── Starting date (deterministic date engine) ── -->
                    <div style="margin-top:14px;padding-top:12px;border-top:1px solid #333">
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
                            <span style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.5px">Starting date</span>
                        </div>
                        <div style="font-size:11px;color:#888;margin-bottom:8px;line-height:1.4">
                            One-time entry, information only — saving it changes nothing in your world state. Warmup uses it as the authoritative starting date (code-built, so weekday and format are exact); if left blank, the warmup scan infers the date from the roleplay text and fills this field. Accepted formats: <b>1/1/26</b>, <b>01/01/2026</b>, <b>January 1st, 2026</b>.
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                            <input type="text" id="nwst-setting-startDate" placeholder="e.g. January 1st, 2026" style="flex:1;min-width:120px">
                            <button type="button" class="menu_button nwst-btn" id="nwst-setting-setStartDate" style="font-size:11px;padding:3px 9px">Set</button>
                        </div>
                        <div id="nwst-startdate-status" style="font-size:11px;color:#888;margin-bottom:10px"></div>
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                            <div style="font-size:12px;color:#666;white-space:nowrap">Era</div>
                            <input type="text" id="nwst-setting-eraPin" placeholder="optional — correct or set the era, e.g. Reiwa 8" style="flex:1;min-width:100px">
                            <button type="button" class="menu_button nwst-btn" id="nwst-setting-saveEraPin" style="font-size:11px;padding:3px 9px">Save</button>
                        </div>
                        <div style="font-size:11px;color:#888;margin-bottom:10px;line-height:1.4">
                            Real-world calendars only. If the era was read wrong (or the story never mentioned one), write the correct label here — it takes effect immediately and the LLM maintains it from then on, updating era years at rollovers. Editable anytime; save empty to hand era duty back to the LLM. Custom calendars use the Era name field in Calendar configuration instead.
                        </div>
                        <div class="nwst-setting-row" style="margin-bottom:8px">
                            <div>
                                <div class="nwst-setting-label">International date format</div>
                                <div class="nwst-setting-sub">Read slash dates day-first: 10/4/26 means April 10th, 2026</div>
                            </div>
                            <label class="nwst-toggle">
                                <input type="checkbox" id="nwst-setting-dateFormatDMY">
                                <span class="nwst-slider"></span>
                            </label>
                        </div>
                        <div class="nwst-setting-row">
                            <div>
                                <div class="nwst-setting-label">Leap years</div>
                                <div class="nwst-setting-sub" id="nwst-leap-years-note">Adds a leap day (Feb 29th) in real-world leap years. Also applies to custom calendars that mirror the real structure (12 months with a 28-day second month); other shapes never leap.</div>
                            </div>
                            <label class="nwst-toggle">
                                <input type="checkbox" id="nwst-setting-leapYears">
                                <span class="nwst-slider"></span>
                            </label>
                        </div>
                    </div>

                </div>
            </div>
        </div>

        <!-- ── Severe Weather (Experimental, per-chat) ───────── -->
        <div class="nwst-accordion-section">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-severe-weather">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Severe Weather</span>
                    <span class="nwst-experimental-badge">Experimental</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-severe-weather">
                <div class="nwst-card">
                    <div style="font-size:12px;color:#666;margin-bottom:10px;line-height:1.5">
                        Deterministic severe-weather RNG weighted by the active profile's climate, terrain, characteristics, and current season. The RNG decides the system; the Day Advancement LLM only renders that decision into the 7-day forecast. <strong>Weather Profiles are saved per-chat and switched manually.</strong>
                    </div>
                    <div class="nwst-setting-row" style="margin-bottom:10px">
                        <div><div class="nwst-setting-label">Enable Severe Weather</div><div class="nwst-setting-sub">Roll only on story-day advancement. Regenerating the forecast never rerolls weather.</div></div>
                        <label class="nwst-toggle"><input type="checkbox" id="nwst-weather-enabled"><span class="nwst-slider"></span></label>
                    </div>
                    <div style="font-size:12px;color:#666;margin-bottom:4px">Active Weather Profile</div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                        <select id="nwst-weather-profile-select" style="flex:1;min-width:120px"></select>
                        <button type="button" class="menu_button nwst-btn" id="nwst-weather-new-profile">+ New</button>
                    </div>
                    <div class="nwst-btn-row" style="margin-bottom:10px">
                        <button type="button" class="menu_button nwst-btn" id="nwst-weather-analyze-setting">Analyze Setting Context</button>
                        <button type="button" class="menu_button nwst-btn" id="nwst-weather-duplicate-profile">Duplicate</button>
                        <button type="button" class="menu_button nwst-btn-danger" id="nwst-weather-delete-profile">Delete</button>
                    </div>
                    <div id="nwst-weather-profile-editor" style="display:none;border-top:0.5px solid var(--SmartThemeBorderColor,#ddd);padding-top:10px">
                        <div style="display:flex;gap:8px;margin-bottom:8px">
                            <div style="flex:1"><div class="nwst-setting-label">Name</div><input id="nwst-weather-name" type="text"></div>
                            <div style="width:135px"><div class="nwst-setting-label">Frequency</div><select id="nwst-weather-frequency"><option value="rare">Rare</option><option value="occasional">Occasional</option><option value="active">Active</option></select></div>
                        </div>
                        <div class="nwst-setting-label">Climate tags</div>
                        <input id="nwst-weather-climate" type="text" placeholder="temperate, humid, subtropical" style="margin-bottom:8px">
                        <div class="nwst-setting-label">Terrain tags</div>
                        <input id="nwst-weather-terrain" type="text" placeholder="urban, mountainous, forested, coastal" style="margin-bottom:8px">
                        <div class="nwst-setting-label">Characteristics</div>
                        <input id="nwst-weather-characteristics" type="text" placeholder="harsh winters, humid summers, rainy season" style="margin-bottom:8px">
                        <div class="nwst-setting-label">Notes</div>
                        <textarea id="nwst-weather-notes" rows="2" placeholder="Weather-relevant notes for this region/profile"></textarea>
                        <div class="nwst-btn-row" style="margin-top:8px"><button type="button" class="menu_button nwst-btn" id="nwst-weather-save-profile">Save Weather Profile</button></div>
                    </div>
                    <div style="margin-top:10px;padding-top:10px;border-top:0.5px solid var(--SmartThemeBorderColor,#ddd)">
                        <div class="nwst-setting-row" style="margin-bottom:8px"><div><div class="nwst-setting-label">Affect 7-Day Forecast</div></div><label class="nwst-toggle"><input type="checkbox" id="nwst-weather-affect-forecast"><span class="nwst-slider"></span></label></div>
                        <div class="nwst-setting-row"><div><div class="nwst-setting-label">Show current system on Home</div></div><label class="nwst-toggle"><input type="checkbox" id="nwst-weather-show-home"><span class="nwst-slider"></span></label></div>
                    </div>
                    <div id="nwst-weather-current-system" style="margin-top:10px;font-size:11px;color:#888"></div>
                    <div style="margin-top:10px;padding-top:10px;border-top:0.5px solid var(--SmartThemeBorderColor,#ddd)">
                        <div class="nwst-setting-label">Weather Overrides</div>
                        <div class="nwst-setting-sub" style="margin-bottom:8px">Profile-specific manual events. Overrides can ignore climate/season rules because sometimes meteorology deserves to lose.</div>
                        <div id="nwst-weather-overrides-list"></div>
                        <div class="nwst-btn-row" style="margin-top:6px"><button type="button" class="menu_button nwst-btn" id="nwst-weather-add-override">+ Add Override</button><button type="button" class="menu_button nwst-btn" id="nwst-weather-clear-system">Clear Generated Weather</button></div>
                    </div>
                </div>
            </div>
        </div>


        <!-- ── Moon Cycles (Experimental) ─────────────────────── -->
        <div class="nwst-accordion-section">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-moons">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Moon Cycles</span>
                    <span class="nwst-experimental-badge">Experimental</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-moons">
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
                        The default lunar cycle length for this chat (29.53 days for Earth). Used as fallback when no moons are configured.
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
                        <input type="number" id="nwst-setting-moonCycleDays" value="29.53" min="1" max="999" step="0.01" style="width:80px;text-align:center">
                        <span style="font-size:12px;color:#666">days per cycle</span>
                    </div>

                    <!-- Enable/disable moon phenomena -->
                    <div class="nwst-setting-row" style="margin-bottom:10px">
                        <div>
                            <div class="nwst-setting-label">Enable moon phenomena</div>
                            <div class="nwst-setting-sub">Calendar-detected blue moons, eclipse subtypes, orbital appearances, and rare atmospheric moon optics</div>
                        </div>
                        <label class="nwst-toggle">
                            <input type="checkbox" id="nwst-setting-enableMoonPhenomena" checked>
                            <span class="nwst-slider"></span>
                        </label>
                    </div>

                    <!-- Multi-moon list -->
                    <div style="font-size:12px;color:#666;margin-bottom:4px">Configured moons</div>
                    <div style="font-size:11px;color:#999;margin-bottom:6px;line-height:1.4">
                        Add multiple moons for this chat. Disable moons entirely for a moonless world. Each enabled moon has its own cycle length and forecast strip.
                    </div>
                    <div id="nwst-moons-list" style="margin-bottom:8px"></div>
                    <div class="nwst-btn-row">
                        <button class="menu_button nwst-btn" id="nwst-setting-addMoon" style="font-size:11px;padding:3px 9px">+ Add Moon</button>
                        <button type="button" class="menu_button nwst-btn" id="nwst-setting-saveMoons" style="font-size:11px;padding:3px 9px">💾 Save Moons</button>
                        <button class="menu_button nwst-btn" id="nwst-setting-restoreDefaultMoons" style="font-size:11px;padding:3px 9px;margin-left:auto">Restore to Default</button>
                    </div>

                    <div style="border-top:0.5px solid var(--SmartThemeBorderColor,#444);margin:12px 0 10px;padding-top:10px">
                        <div style="font-size:12px;color:#666;margin-bottom:4px">Phenomenon overrides</div>
                        <div style="font-size:11px;color:#999;margin-bottom:8px;line-height:1.4">
                            Per-chat calendar ranges layered over the mathematical forecast. Use these for deliberate anomalies such as a three-day Blood Moon. Blue Moon remains calendar-detected and cannot be assigned here.
                        </div>
                        <div id="nwst-moon-overrides-list" style="margin-bottom:8px"></div>
                        <div class="nwst-btn-row">
                            <button type="button" class="menu_button nwst-btn" id="nwst-setting-addMoonOverride" style="font-size:11px;padding:3px 9px">+ Add Override</button>
                            <button type="button" class="menu_button nwst-btn" id="nwst-setting-saveMoonOverrides" style="font-size:11px;padding:3px 9px">💾 Save Overrides</button>
                        </div>
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

                    <template id="nwst-moon-override-tpl">
                        <div class="nwst-moon-override-entry" style="padding:8px;margin-bottom:7px;border-radius:6px;background:var(--dark1,rgba(0,0,0,0.04));border:0.5px solid var(--SmartThemeBorderColor,#444)">
                            <div style="display:flex;align-items:center;gap:7px;margin-bottom:7px">
                                <input type="checkbox" class="nwst-moon-override-enabled" checked title="Enable this override">
                                <select class="nwst-moon-override-moon" style="min-width:110px;flex:0 1 150px"></select>
                                <select class="nwst-moon-override-type" style="min-width:150px;flex:1"></select>
                                <button type="button" class="menu_button nwst-moon-override-remove" style="font-size:11px;padding:1px 6px;color:#c33" title="Remove override">✕</button>
                            </div>
                            <input type="text" class="nwst-moon-override-custom" placeholder="Custom phenomenon label" style="display:none;width:100%;margin-bottom:7px;box-sizing:border-box">
                            <div style="display:grid;grid-template-columns:auto repeat(3,minmax(52px,1fr));gap:5px;align-items:center;margin-bottom:5px;font-size:11px">
                                <span style="color:#888">Start</span>
                                <input type="number" class="nwst-moon-override-start-year" placeholder="Year">
                                <input type="number" class="nwst-moon-override-start-month" min="1" placeholder="Month">
                                <input type="number" class="nwst-moon-override-start-day" min="1" placeholder="Day">
                                <span style="color:#888">End</span>
                                <input type="number" class="nwst-moon-override-end-year" placeholder="Year">
                                <input type="number" class="nwst-moon-override-end-month" min="1" placeholder="Month">
                                <input type="number" class="nwst-moon-override-end-day" min="1" placeholder="Day">
                            </div>
                            <input type="text" class="nwst-moon-override-description" placeholder="Optional tooltip / anomaly description" style="width:100%;box-sizing:border-box">
                        </div>
                    </template>
                </div>
            </div>
        </div>

        <!-- ── Calendar Configuration (Experimental) ─────────── -->
        <div class="nwst-accordion-section">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-calendar">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Calendar configuration</span>
                    <span class="nwst-experimental-badge">Experimental</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-calendar">
                <div class="nwst-card">
                    <div style="font-size:12px;color:#666;margin-bottom:8px;line-height:1.5">
                        Configure the calendar system for this world. When enabled, the LLM will be instructed to use these month names when generating dates during day advancement and batch scanning. <strong>This is saved per-chat</strong> — each roleplay can have its own calendar.
                    </div>

                    <!-- Enable toggle -->
                    <div class="nwst-setting-row" style="margin-bottom:12px">
                        <div>
                            <div class="nwst-setting-label">Enable calendar configuration</div>
                            <div class="nwst-setting-sub">When enabled, month names are injected into LLM prompts during day advancement and batch scanning</div>
                        </div>
                        <label class="nwst-toggle">
                            <input type="checkbox" id="nwst-setting-enableCalendarConfig">
                            <span class="nwst-slider"></span>
                        </label>
                    </div>

                    <!-- Calendar system -->
                    <div style="margin-bottom:12px;padding:10px;border:0.5px solid var(--SmartThemeBorderColor,#444);border-radius:6px">
                        <div style="font-size:12px;color:#666;margin-bottom:5px">Calendar system</div>
                        <select id="nwst-setting-calendarSystem" style="width:100%;margin-bottom:6px">
                            <option value="standard">Standard / solar — fixed configured month lengths</option>
                            <option value="lunisolar">East Asian lunisolar — dynamic 29/30-day months + intercalary months</option>
                        </select>
                        <div id="nwst-lunisolar-settings" style="display:none;margin-top:8px">
                            <div style="font-size:11px;color:#888;line-height:1.45;margin-bottom:7px">
                                Uses the 12 configured month names as base months. NWST supplies each year's 29/30-day layout and inserts an intercalary month when needed. This is a reusable East-Asian lunisolar engine, not a scholarly reconstruction of every historical calendar method.
                            </div>
                            <div style="display:flex;align-items:center;gap:8px">
                                <div style="font-size:11px;color:#888;white-space:nowrap">Intercalary month label</div>
                                <input type="text" id="nwst-setting-lunisolarLeapLabel" value="Intercalary {month}" placeholder="Intercalary {month}" style="flex:1;min-width:120px">
                            </div>
                            <div style="font-size:10px;color:#777;margin-top:3px">Use <b>{month}</b> where the base month name should appear.</div>
                        </div>
                    </div>

                    <!-- Number of months -->
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
                        <div style="font-size:12px;color:#666;white-space:nowrap">Number of months</div>
                        <input type="number" id="nwst-setting-monthCount" value="12" min="1" max="24" style="width:55px;text-align:center">
                    </div>

                    <!-- Month editor list -->
                    <div id="nwst-calendar-months-list" style="margin-bottom:8px"></div>

                    <!-- Total days validation -->
                    <div id="nwst-calendar-validation" style="margin-bottom:10px"></div>

                    <!-- Days of the week editor -->
                    <div style="margin-top:14px;padding-top:10px;border-top:1px solid #333">
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
                            <span style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.5px">Days of the week</span>
                            <span class="nwst-experimental-badge" style="font-size:9px">Experimental</span>
                        </div>
                        <div style="font-size:11px;color:#888;margin-bottom:8px;line-height:1.4">
                            Configure custom day names for this world's week. When enabled, the LLM will use these names in date displays.
                        </div>
                        <div id="nwst-calendar-days-list" style="margin-bottom:8px"></div>
                        <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
                            <div style="font-size:12px;color:#666;white-space:nowrap">Era name</div>
                            <input type="text" id="nwst-setting-eraName" placeholder="optional — e.g. Third Age {year}" style="flex:1">
                        </div>
                        <div style="font-size:11px;color:#888;margin-top:4px;line-height:1.4">
                            Shown as the sub-date line when this custom calendar is enabled. Write <b>{year}</b> to insert the computed year (e.g. "Third Age {year}" → "Third Age 313").
                        </div>
                    </div>

                    <!-- Special days editor -->
                    <div style="margin-top:14px;padding-top:10px;border-top:1px solid #333">
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
                            <span style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.5px">Special days</span>
                        </div>
                        <div style="font-size:11px;color:#888;margin-bottom:8px;line-height:1.4">
                            Recurring calendar days — birthdays, holidays, festivals, deadlines, and more. Saved days live as collapsed cards grouped by type; tap a card to open and edit it, and save from inside the card. Each year, when a day's month arrives (or sooner for last-minute additions), it appears in the Events tab as a dated event with its category chip, starting under "This month" and moving forward with the calendar.
                        </div>
                        <div id="nwst-special-days-list" style="margin-bottom:8px"></div>
                        <div class="nwst-btn-row" style="margin-bottom:4px">
                            <button type="button" class="menu_button nwst-btn" id="nwst-special-day-add" style="font-size:11px;padding:3px 9px">➕ Add special day</button>
                        </div>
                    </div>

                    <!-- Nager.Date real-world holidays -->
                    <div style="margin-top:14px;padding-top:10px;border-top:1px solid #333">
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
                            <span style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.5px">Real-world holidays (Nager.Date)</span>
                        </div>
                        <div style="font-size:11px;color:#888;margin-bottom:10px;line-height:1.4">
                            Optional real-world holiday data for Gregorian-compatible calendars, including custom calendars that only rename months or weekdays. Holiday data stays separate from Special Days and does not create Events. Raw results are cached once per country and year; filtered holiday context begins entering the prompt within the configured upcoming window (7 days by default).
                        </div>

                        <div class="nwst-setting-row" style="margin-bottom:10px">
                            <div>
                                <div class="nwst-setting-label">Enable Nager.Date holidays</div>
                                <div class="nwst-setting-sub" id="nwst-nager-availability-note">Available for Gregorian-compatible calendars, including renamed month/weekday sets.</div>
                            </div>
                            <label class="nwst-toggle">
                                <input type="checkbox" id="nwst-setting-nagerEnabled">
                                <span class="nwst-slider"></span>
                            </label>
                        </div>

                        <div id="nwst-nager-settings" style="display:none;padding:10px;border:0.5px solid var(--SmartThemeBorderColor,#444);border-radius:6px;margin-bottom:10px">
                            <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-bottom:10px">
                                <div>
                                    <div class="nwst-setting-label" style="margin-bottom:4px">Country code</div>
                                    <input type="text" id="nwst-setting-nagerCountry" maxlength="2" placeholder="e.g. US, JP, GB" style="width:100%;box-sizing:border-box;text-transform:uppercase">
                                    <div class="nwst-setting-sub" style="margin-top:3px">ISO 3166-1 alpha-2 code.</div>
                                </div>
                                <div>
                                    <div class="nwst-setting-label" style="margin-bottom:4px">Region / subdivision <span style="font-weight:normal;color:#888">(optional)</span></div>
                                    <input type="text" id="nwst-setting-nagerSubdivision" list="nwst-nager-subdivision-options" placeholder="e.g. US-CA" style="width:100%;box-sizing:border-box;text-transform:uppercase">
                                    <datalist id="nwst-nager-subdivision-options"></datalist>
                                    <div class="nwst-setting-sub" style="margin-top:3px">Leave blank for nationwide holidays only. Cached regional codes are suggested after the first fetch.</div>
                                </div>
                            </div>

                            <div class="nwst-setting-label" style="margin-bottom:5px">Holiday types</div>
                            <div id="nwst-nager-types" style="display:flex;flex-wrap:wrap;gap:6px 12px;margin-bottom:10px">
                                ${NAGER_HOLIDAY_TYPES.map(type => `
                                    <label style="font-size:11px;display:flex;align-items:center;gap:4px">
                                        <input type="checkbox" class="nwst-nager-type" value="${type}"> ${type}
                                    </label>`).join('')}
                            </div>

                            <div class="nwst-setting-row" style="margin-bottom:8px">
                                <div>
                                    <div class="nwst-setting-label">Show holidays on calendar</div>
                                    <div class="nwst-setting-sub">Shows matching holidays beneath the current date on the Home tab.</div>
                                </div>
                                <label class="nwst-toggle">
                                    <input type="checkbox" id="nwst-setting-nagerShowCalendar">
                                    <span class="nwst-slider"></span>
                                </label>
                            </div>

                            <div class="nwst-setting-row" style="margin-bottom:8px">
                                <div>
                                    <div class="nwst-setting-label">Include holidays in prompt context</div>
                                    <div class="nwst-setting-sub">Injects only holidays that are today or close enough to matter.</div>
                                </div>
                                <label class="nwst-toggle">
                                    <input type="checkbox" id="nwst-setting-nagerInjectPrompt">
                                    <span class="nwst-slider"></span>
                                </label>
                            </div>

                            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                                <div style="font-size:12px;color:#666;white-space:nowrap">Upcoming holiday window</div>
                                <input type="number" id="nwst-setting-nagerUpcomingDays" value="7" min="0" max="30" style="width:55px;text-align:center">
                                <span style="font-size:11px;color:#888">days before the holiday</span>
                            </div>

                            <div id="nwst-nager-cache-status" class="nwst-setting-sub" style="line-height:1.4"></div>
                        </div>
                    </div>

                    <!-- Save button -->
                    <div class="nwst-btn-row">
                        <button type="button" class="menu_button nwst-btn" id="nwst-setting-saveCalendarConfig" style="font-size:11px;padding:3px 9px">Save Calendar Config</button>
                        <button type="button" class="menu_button nwst-btn" id="nwst-setting-restoreDefaultCalendar" style="font-size:11px;padding:3px 9px;margin-left:auto">Restore to Default</button>
                    </div>

                    <!-- Hidden template for month entry -->
                    <template id="nwst-calendar-month-tpl">
                        <div class="nwst-month-entry">
                            <span class="nwst-month-index"></span>
                            <input type="text" class="nwst-month-name-input" placeholder="Month name" style="flex:1;min-width:80px">
                            <input type="number" class="nwst-month-days-input" min="1" max="99" value="30">
                            <span class="nwst-month-days-label">days</span>
                        </div>
                    </template>

                    <!-- Hidden template for day entry -->
                    <template id="nwst-calendar-day-tpl">
                        <div class="nwst-month-entry">
                            <span class="nwst-month-index"></span>
                            <input type="text" class="nwst-weekday-name-input" placeholder="Day name" style="flex:1;min-width:80px">
                        </div>
                    </template>
                </div>
            </div>
        </div>

        <!-- ── Season Configuration (per-chat) ────────────────── -->
        <div class="nwst-accordion-section">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-seasons">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Season configuration</span>
                    <span class="nwst-experimental-badge">Experimental</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-seasons">
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
                            Each band defines a season's name and its day range within the year (1-based). Bands are checked in order — the first matching band is used.
                        </div>
                        <div id="nwst-season-bands-list"></div>
                        <div class="nwst-btn-row" style="margin-top:6px">
                            <button class="menu_button nwst-btn" id="nwst-setting-addSeasonBand" style="font-size:11px;padding:3px 9px">+ Add Season Band</button>
                        </div>
                    </div>

                    <!-- Editable day count (per-chat) -->
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding-top:8px;border-top:1px solid rgba(128,128,128,0.2)">
                        <div style="font-size:12px;color:#666;white-space:nowrap">Current day count</div>
                        <input type="number" id="nwst-setting-dayCount" value="1" min="1" style="width:70px;text-align:center">
                        <span style="font-size:11px;color:#888">cyclical calendar day within the current year (controls seasons and annual timing)</span>
                        <button class="menu_button nwst-btn" id="nwst-setting-saveDayCount" style="font-size:11px;padding:2px 7px;margin-left:auto">Update</button>
                    </div>

                    <!-- Save button -->
                    <div class="nwst-btn-row" style="margin-top:4px">
                        <button class="menu_button nwst-btn" id="nwst-setting-saveSeasonConfig">Save Season Config</button>
                        <button class="menu_button nwst-btn" id="nwst-setting-restoreDefaultSeasons" style="font-size:11px;padding:3px 9px;margin-left:auto">Restore to Default</button>
                    </div>

                    <!-- Hidden template for season band entry -->
                    <template id="nwst-season-band-tpl">
                        <div class="nwst-season-band-entry" style="display:flex;align-items:center;gap:6px;padding:4px 6px;margin-bottom:4px;border-radius:4px;background:var(--dark1,rgba(0,0,0,0.04))">
                            <input type="text" class="nwst-season-band-name" value="Spring" placeholder="Name" style="flex:1;min-width:80px">
                            <span style="font-size:11px;color:#888">from day</span>
                            <input type="number" class="nwst-season-band-start" value="1" min="1" max="9999" style="width:55px;text-align:center">
                            <span style="font-size:11px;color:#888">to day</span>
                            <input type="number" class="nwst-season-band-end" value="91" min="0" max="9999" style="width:55px;text-align:center">
                            <button class="menu_button nwst-season-band-remove" style="font-size:11px;padding:1px 5px;color:#c33" title="Remove this season band">✕</button>
                        </div>
                    </template>
                </div>
            </div>
        </div>


        <!-- ── Injection Settings ──────────────────────────────── -->
        <div class="nwst-accordion-section">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-injection">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Injection settings</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-injection">
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
                        <div>
                            <div class="nwst-setting-label">Maximum active events</div>
                            <div class="nwst-setting-sub">Hard cap on the total active event pool. New events won't be added when this is reached. Resolved and missed events don't count.</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                            <input type="number" id="nwst-setting-maxActiveEvents" value="12" min="4" max="50" style="width:52px;text-align:center">
                            <span style="font-size:12px;color:#666">events</span>
                        </div>
                    </div>
                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Snapshot retention limit</div>
                            <div class="nwst-setting-sub">Target maximum for stored snapshots per chat. Oldest regular snapshots are pruned first. Batch-scan and pre-time-skip landmark snapshots are protected and are never pruned, so the total can exceed this limit if protected landmarks alone exceed it.</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                            <input type="number" id="nwst-setting-maxSnapshotCount" value="30" min="1" max="200" style="width:52px;text-align:center">
                            <span style="font-size:12px;color:#666">snapshots</span>
                        </div>
                    </div>
                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Event compaction threshold</div>
                            <div class="nwst-setting-sub">Story days after which a resolved/missed event is compacted into the Notebook's "Past Events" section. 0 = compact immediately on day advancement. Set to a high value to disable.</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                            <input type="number" id="nwst-setting-eventCompactionThreshold" value="0" min="0" max="999" style="width:52px;text-align:center">
                            <span style="font-size:12px;color:#666">story days</span>
                        </div>
                    </div>
                    <!-- Event→Secret Promotion toggle -->
                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Assess concluded events for secret promotion</div>
                            <div class="nwst-setting-sub">When enabled, the day-advance event review has the Planning LLM assess concluded (resolved/missed) events for concealed knowledge. Candidates are QUEUED in the Events tab for your Promote / Don't-promote decision — nothing is promoted silently. Either choice removes the concluded event and keeps a summary in the notebook. Manual promotion from event cards is always available regardless of this setting.</div>
                        </div>
                        <label class="nwst-toggle">
                            <input type="checkbox" id="nwst-setting-autoPromoteEvents" checked>
                            <span class="nwst-slider"></span>
                        </label>
                    </div>
                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Event validity review on day advance</div>
                            <div class="nwst-setting-sub">After each day advancement, one Planning LLM call reviews event validity (queued for Keep / Mark Resolved / Mark Missed), reassesses undated-event urgency, proposes timing when an Undetermined event gains a concrete schedule, and—if enabled above—queues concluded events holding concealed knowledge for promotion review. Still one extra API call per day advance, skipped when there is nothing to review.</div>
                        </div>
                        <label class="nwst-toggle">
                            <input type="checkbox" id="nwst-setting-eventValidityReview" checked>
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
                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Secret budget tokens</div>
                            <div class="nwst-setting-sub">Max tokens of secret text to inject per message. Also governs auto-promotion LLM calls for knowledge distribution analysis. Higher = more secrets & smarter promotion.</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                            <input type="range" id="nwst-setting-secretBudget" min="100" max="2000" step="100" value="600" style="width:100px">
                            <span id="nwst-setting-secretBudget-value" style="font-size:12px;min-width:40px;text-align:center">600</span>
                            <span style="font-size:12px;color:#666">tokens</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>


        <!-- ── Secrets Engine (prose-based scoring) ─────────────── -->
        <div class="nwst-accordion-section">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-secrets">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Secrets engine</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-secrets">
                <div class="nwst-card">
                    <div style="font-size:11px;color:#999;margin-bottom:12px;line-height:1.4">
                        The prose-based secrets engine scores every secret against the current scene and injects the most relevant ones. These controls tune how aggressively secrets are injected. Use <code>/secretsdebug</code> in chat to see live scoring.
                    </div>

                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Max secrets injected</div>
                            <div class="nwst-setting-sub">Hard cap on how many secrets inject at once, regardless of token budget. Whichever limit is hit first wins.</div>
                        </div>
                        <input type="number" id="nwst-setting-maxSecretsInjected" value="4" min="1" max="20" style="width:52px;text-align:center;flex-shrink:0">
                    </div>

                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Sidecar cadence</div>
                            <div class="nwst-setting-sub">How often the scene-analyzer LLM runs (in messages). Lower = fresher scene reads, more API calls.</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                            <input type="number" id="nwst-setting-sidecarCadence" value="10" min="1" max="50" style="width:52px;text-align:center">
                            <span style="font-size:12px;color:#666">msgs</span>
                        </div>
                    </div>

                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Sidecar scan range</div>
                            <div class="nwst-setting-sub">How many recent prose messages the sidecar and cheap JS scan inspect. Default 5 keeps cutaways focused and avoids stale scene bleed.</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                            <input type="number" id="nwst-setting-sidecarScanRange" value="5" min="1" max="50" style="width:52px;text-align:center">
                            <span style="font-size:12px;color:#666">msgs</span>
                        </div>
                    </div>

                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Injection threshold</div>
                            <div class="nwst-setting-sub">Minimum relevance score a secret must reach to be eligible for injection.</div>
                        </div>
                        <input type="number" id="nwst-setting-injectionThreshold" value="50" min="0" max="200" style="width:52px;text-align:center;flex-shrink:0">
                    </div>

                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Dormancy decay</div>
                            <div class="nwst-setting-sub">Messages since a secret last injected before it's flagged for archive review. High/Critical secrets are exempt. Set 0 to disable.</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                            <input type="number" id="nwst-setting-decayThreshold" value="250" min="0" max="9999" style="width:60px;text-align:center">
                            <span style="font-size:12px;color:#666">msgs</span>
                        </div>
                    </div>

                    <div class="nwst-setting-row">
                        <div>
                            <div class="nwst-setting-label">Auto-tidy notebook</div>
                            <div class="nwst-setting-sub">Automatically run the notebook reconciliation pass every N scans (merges duplicates, clarifies, removes dead threads — all undoable). Set 0 for manual only via the Tidy button.</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                            <input type="number" id="nwst-setting-reconcileCadence" value="0" min="0" max="100" style="width:60px;text-align:center">
                            <span style="font-size:12px;color:#666">scans</span>
                        </div>
                    </div>

                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#888;margin:14px 0 6px">Scoring weights</div>
                    <div style="font-size:11px;color:#999;margin-bottom:10px;line-height:1.4">
                        How strongly each signal pushes a secret toward injection. Higher = that signal matters more. Negative values (priority Low) push secrets down.
                    </div>
                    <div id="nwst-scoring-weights"></div>
                    <button class="menu_button nwst-btn" id="nwst-setting-resetWeights" style="font-size:11px;padding:3px 9px;margin-top:8px">Reset weights to defaults</button>

                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#888;margin:16px 0 6px">User/PC identity</div>
                    <div style="font-size:11px;color:#999;margin-bottom:10px;line-height:1.4">
                        Optional per-chat identity for your protagonist. If a recent user message is present, this PC is counted as present even when the prose is first-person or does not name them.
                    </div>
                    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
                        <input type="text" id="nwst-secret-pc-name" placeholder="User/PC canonical name (e.g. Mira)" style="font-size:12px">
                        <input type="text" id="nwst-secret-pc-aliases" placeholder="PC aliases, comma-separated (e.g. Mira Rowan)" style="font-size:12px">
                        <button class="menu_button nwst-btn" id="nwst-secret-pc-save" style="font-size:11px;padding:3px 9px;align-self:flex-start">Save PC identity</button>
                    </div>

                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#888;margin:16px 0 6px">Alias manager</div>
                    <div style="font-size:11px;color:#999;margin-bottom:10px;line-height:1.4">
                        Collapse the different ways a character is named in prose down to one canonical name. The engine auto-detects names from your secrets and communities, but you can add aliases it can't infer (e.g. "The Silver Fox" → Rowan). Pretty names show in the UI; matching happens internally.
                    </div>
                    <div id="nwst-alias-list" style="margin-bottom:10px"></div>
                    <div style="display:flex;flex-direction:column;gap:6px">
                        <input type="text" id="nwst-alias-canonical" placeholder="Canonical name (e.g. Rowan)" style="font-size:12px">
                        <input type="text" id="nwst-alias-variants" placeholder="Aliases, comma-separated (e.g. The Silver Fox, Captain, Rowan Vale)" style="font-size:12px">
                        <button class="menu_button nwst-btn" id="nwst-alias-add" style="font-size:11px;padding:3px 9px;align-self:flex-start">+ Add alias group</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- ── Batch Scan ──────────────────────────────────────── -->
        <div class="nwst-accordion-section">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-batchscan">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Batch scan</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-batchscan">
                <div class="nwst-card">
                    <div style="font-size:12px;color:#666;margin-bottom:10px;line-height:1.5">
                        Scan your full chat history to generate an initial world state. Creates a current day entry, populates the event horizon, fills active world conditions, seeds the notebook, and groups any detected communities. Runs once — does not overwrite existing data.
                    </div>
                    <button class="menu_button nwst-btn" id="nwst-setting-batchScan" style="font-size:11px;padding:3px 9px">Run batch scan</button>
                    <span id="nwst-batchScan-spinner" style="display:none;margin-left:8px;" class="nwst-spinner"></span>
                </div>
            </div>
        </div>

        <!-- ── Data Import / Export / Clear ────────────────────── -->
        <div class="nwst-accordion-section">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-data">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Data</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-data">
                <div class="nwst-btn-row" style="margin-top:4px">
                    <button class="menu_button nwst-btn" id="nwst-setting-importAll">Import all</button>
                    <button class="menu_button nwst-btn" id="nwst-setting-exportAll">Export all</button>
                    <button class="menu_button nwst-btn" id="nwst-setting-clearAll" style="font-size:11px;padding:3px 9px">Clear all</button>
                </div>
            </div>
        </div>

        <!-- Debug accordion -->
        <div class="nwst-accordion">
            <div class="nwst-accordion-header" data-accordion="nwst-accordion-debug">
                <div class="nwst-accordion-header-left">
                    <span class="nwst-accordion-title">Debug</span>
                </div>
                <span class="nwst-accordion-arrow">▶</span>
            </div>
            <div class="nwst-accordion-body" id="nwst-accordion-debug">
                <div class="nwst-setting-label" style="margin-bottom:4px">Debug logging</div>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                    <label class="nwst-toggle" title="Enable verbose debug logging to the browser console (F12)">
                        <input type="checkbox" id="nwst-debug-logging-toggle" ${isDebugMode() ? 'checked' : ''}>
                        <span class="nwst-slider"></span>
                    </label>
                    <span style="font-size:11px;color:var(--SmartThemeBodyColor,#ddd)">Log NWST internal activity (scans, injections, scoring) to the browser console (opened with F12)</span>
                </div>
                <div class="nwst-setting-sub" style="margin-bottom:8px">Manual trigger buttons for testing LLM functions. These run immediately and may use API credits.</div>
                <div class="nwst-btn-row" style="margin-top:4px">
                    <button class="menu_button nwst-btn" id="nwst-debug-scan-secrets">🔍 Scan for secrets</button>
                    <button class="menu_button nwst-btn" id="nwst-debug-scan-communities">👥 Scan for communities</button>
                    <button class="menu_button nwst-btn" id="nwst-debug-scan-worldstate">🌍 Scan world state</button>
                    <button class="menu_button nwst-btn-debug" id="nwst-debug-review-participants" title="Use the Planning LLM to review all events and add participants where missing">🔎 Review event participants</button>
                    <button class="menu_button nwst-btn" id="nwst-debug-secrets-report" title="Show the secrets scoring report — scene context, per-secret scores, and inject/skip reasons">📊 Secrets scoring report</button>
                    <button class="menu_button nwst-btn" id="nwst-debug-run-sidecar" title="Run the secrets sidecar scene analyzer now (uses one API call)">🔬 Run sidecar now</button>
                    <button class="menu_button nwst-btn" id="nwst-debug-consistency-scan" title="Deep scan: reads ALL visible chat messages against every secret and applies updates — characters who learned a secret are moved to Who Knows, revealed secrets are flagged for archive review, contradictions are noted. One API call; long chats mean a large prompt.">🩺 Consistency scan (visible)</button>
                    <button class="menu_button nwst-btn" id="nwst-debug-backfill-anchors" title="Generate trigger anchors for secrets that don't have them yet (one Planning LLM call per secret)">🏷️ Generate missing anchors</button>
                    <button class="menu_button nwst-btn" id="nwst-debug-assign-weather-profile" title="Use the Planning LLM to analyze the active Setting Context and create + activate a new Weather Profile for this chat.">🌦️ Assign Weather Profile</button>
                </div>
                <div style="margin-top:10px;padding-top:10px;border-top:0.5px solid var(--SmartThemeBorderColor,#ddd)">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                        <div class="nwst-setting-label" style="flex:1">Context/Profile Snapshots</div>
                        <button type="button" class="menu_button nwst-btn" id="nwst-debug-clear-context-snapshots" style="font-size:10px;padding:2px 7px">Clear</button>
                    </div>
                    <div class="nwst-setting-sub" style="margin-bottom:8px">Manual Setting Context and Weather Profile undo history. Kept completely separate from Previous Day snapshots and never used by story-date rewind.</div>
                    <div id="nwst-context-snapshot-list"></div>
                </div>
                <div style="margin-top:10px;padding-top:10px;border-top:0.5px solid var(--SmartThemeBorderColor,#ddd)">
                    <div class="nwst-setting-label" style="margin-bottom:4px">Adjust Secret Priority</div>
                    <div class="nwst-setting-sub" style="margin-bottom:8px">Bulk-override the injection priority of ALL existing secrets. Useful for testing the priority system — resets all secrets to a single level.</div>
                    <div style="display:flex;align-items:center;gap:8px">
                        <select id="nwst-debug-priority-target" style="width:auto;font-size:11px;padding:3px 6px;flex:1">
                            <option value="critical">‼ Critical — continuity guard</option>
                            <option value="high">⬆ High — hotter/more eager</option>
                            <option value="normal">◈ Normal — standard relevance</option>
                            <option value="low">⬇ Low — background/rare</option>
                        </select>
                        <button class="menu_button nwst-btn" id="nwst-debug-apply-priority" style="flex-shrink:0">Apply to all</button>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
                        <span style="font-size:11px;color:var(--SmartThemeBodyColor,#ddd);flex:1">Or let the AI evaluate narrative context and assign priorities automatically:</span>
                        <button class="menu_button nwst-btn" id="nwst-debug-auto-priority" style="flex-shrink:0">🤖 AI Auto-Adjust</button>
                    </div>
                </div>
                <div style="margin-top:10px;padding-top:10px;border-top:0.5px solid var(--SmartThemeBorderColor,#ddd)">
                    <div class="nwst-setting-label" style="margin-bottom:4px">Fix Day Count</div>
                    <div class="nwst-setting-sub" style="margin-bottom:8px">Type the current date in <b>M/D</b> format (e.g. <b>1/12</b> or <b>5/31</b>) and click Set. The day count is computed from your Calendar Configuration's month lengths. No LLM call needed.</div>
                    <div style="display:flex;align-items:center;gap:8px">
                        <input type="text" id="nwst-debug-daycount-input" placeholder="M/D (e.g. 1/12 or 5/31)" style="width:140px;font-size:11px;padding:3px 6px">
                        <button class="menu_button nwst-btn" id="nwst-debug-detect-daycount">📅 Set Day</button>
                    </div>
                </div>
                <div style="margin-top:10px;padding-top:10px;border-top:0.5px solid var(--SmartThemeBorderColor,#ddd)">
                    <div class="nwst-setting-label" style="margin-bottom:4px">Adopt computed dates</div>
                    <div class="nwst-setting-sub" style="margin-bottom:8px">For chats that were already running before the date engine existed. Pairs the engine with today's displayed date so that from the next day advancement onward, dates, weekdays, and forecast day labels are code-computed instead of LLM-written. Nothing else changes — events, notebook, moons, and the day counter stay untouched. One-time, confirmed action.</div>
                    <button type="button" class="menu_button nwst-btn" id="nwst-debug-adopt-dates" title="Pair the deterministic date engine with this chat's current date. Requires a readable calendar date in Current Day (e.g. 'Wednesday, April 20th, 2024'). No LLM call.">🗓️ Adopt computed dates</button>
                </div>
            </div>
        </div>

        <!-- Hidden file input for import -->
        <input type="file" id="nwst-import-file" accept=".json" style="display:none">
    `;

    // Settings UI invariant: Severe Weather is a first-class experimental panel.
    // If this ever fails, the loaded settings module is stale or the template was corrupted.
    if (!pane.querySelector('[data-accordion="nwst-accordion-severe-weather"]')) {
        console.error('[NWST Settings UI] Severe Weather panel failed to render. The loaded settings module may be stale.');
    }

    // Wire accordion toggle behavior
    document.querySelectorAll('.nwst-accordion-header').forEach(header => {
        header.addEventListener('click', async () => {
            const bodyId = header.getAttribute('data-accordion');
            const body = document.getElementById(bodyId);
            if (!body) return;
            const arrow = header.querySelector('.nwst-accordion-arrow');
            const isOpen = body.classList.contains('open');
            if (isOpen) {
                body.classList.remove('open');
                if (arrow) arrow.classList.remove('open');
            } else {
                body.classList.add('open');
                if (arrow) arrow.classList.add('open');
            }
        });
    });

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

        removeBtn.addEventListener('click', async () => {
            const cfg = getSeasonConfig(chatId);
            if (cfg.seasons.length <= 1) {
                nwstToast('Cannot remove the last season band.', 'warning');
                return;
            }
            cfg.seasons.splice(i, 1);
            await saveSeasonConfig(chatId, cfg);
            renderSeasonBandsList();
        });

        container.appendChild(clone);
    }
}

// ── Calendar Configuration UI ────────────────────────────────────────────


/**
 * Populate the calendar config UI controls from the stored per-chat config.
 */
function populateCalendarConfigUI() {
    const chatId = getChatId();
    if (!chatId) return;

    const config = getCalendarConfig(chatId);

    setCheckbox('nwst-setting-enableCalendarConfig', config.enabled);

    const systemSelect = document.getElementById('nwst-setting-calendarSystem');
    if (systemSelect) systemSelect.value = isLunisolarCalendar(config) ? 'lunisolar' : 'standard';
    const leapLabelInput = document.getElementById('nwst-setting-lunisolarLeapLabel');
    if (leapLabelInput) leapLabelInput.value = config.lunisolar?.leapMonthLabel || 'Intercalary {month}';

    const monthCountInput = document.getElementById('nwst-setting-monthCount');
    if (monthCountInput) {
        monthCountInput.value = config.months || 12;
    }

    setCheckbox('nwst-setting-leapYears', config.leapYears !== false);
    setCheckbox('nwst-setting-dateFormatDMY', getSetting('dateFormatDMY') === true);

    const eraInput = document.getElementById('nwst-setting-eraName');
    if (eraInput) eraInput.value = config.eraName || '';

    populateStartDateUI();

    applyCalendarSystemUIState(config);
    renderCalendarMonthsList();
    renderCalendarDaysList();
    renderSpecialDaysList();
    populateNagerDateUI();
}

function currentCalendarYearForConfig(config) {
    const chatId = getChatId();
    if (!chatId) return 1;
    const day = getCurrentDay(chatId) || {};
    const parsed = parseCurrentCalendarDate(
        day.dateDisplay || '', day.dateSub || '', config,
        getSetting('dateFormatDMY') === true
    );
    if (parsed?.year) return parsed.year;
    const start = getStartDate(chatId);
    return start?.year || extractYearFromText(day.dateSub || '') || extractYearFromText(day.dateDisplay || '') || 1;
}

function applyCalendarSystemUIState(config = getCalendarConfig(getChatId())) {
    const lunisolar = isLunisolarCalendar(config);
    const monthCountInput = document.getElementById('nwst-setting-monthCount');
    if (monthCountInput) {
        if (lunisolar) monthCountInput.value = 12;
        monthCountInput.disabled = lunisolar;
        monthCountInput.title = lunisolar ? 'Lunisolar calendars use 12 base months; intercalary months are inserted automatically.' : '';
    }

    const lunisolarWrap = document.getElementById('nwst-lunisolar-settings');
    if (lunisolarWrap) lunisolarWrap.style.display = lunisolar ? 'block' : 'none';

    const leapToggle = document.getElementById('nwst-setting-leapYears');
    if (leapToggle) leapToggle.disabled = lunisolar;
    const leapNote = document.getElementById('nwst-leap-years-note');
    if (leapNote) leapNote.textContent = lunisolar
        ? 'Not used in lunisolar mode — year-specific 29/30-day months and intercalary months handle calendar alignment instead.'
        : 'Adds a leap day (Feb 29th) in real-world leap years. Also applies to custom calendars that mirror the real structure (12 months with a 28-day second month); other shapes never leap.';
}

function translateDateAcrossCalendarSystems(date, oldConfig, newConfig) {
    if (!date || !Number.isInteger(date.year) || !Number.isInteger(date.month) || !Number.isInteger(date.day)) return null;
    const oldInfo = isLunisolarCalendar(oldConfig) ? calendarMonthInfoForDate(date, oldConfig) : null;
    const baseMonth = oldInfo?.baseMonth || date.month;
    if (isLunisolarCalendar(newConfig)) {
        return calendarDateForBaseMonthDay(date.year, baseMonth, date.day, newConfig, false);
    }
    const lengths = monthLengthsFor(newConfig, date.year);
    if (baseMonth < 1 || baseMonth > lengths.length || date.day < 1 || date.day > lengths[baseMonth - 1]) return null;
    return { year: date.year, month: baseMonth, day: date.day };
}

function populateNagerDateUI() {
    const chatId = getChatId();
    if (!chatId) return;

    const config = getCalendarConfig(chatId);
    const nager = config.nagerDate || {};
    const available = isNagerDateAvailable(config);
    const enabled = nager.enabled === true;

    const toggle = document.getElementById('nwst-setting-nagerEnabled');
    if (toggle) {
        toggle.checked = enabled;
        toggle.disabled = !available;
    }

    const note = document.getElementById('nwst-nager-availability-note');
    if (note) {
        note.textContent = available
            ? (config.enabled
                ? 'Available — this custom calendar keeps Gregorian month lengths and only changes display names.'
                : 'Available for the default real-world Gregorian calendar.')
            : (isLunisolarCalendar(config)
                ? 'Unavailable while Calendar System is Lunisolar; Nager.Date public holidays use Gregorian dates.'
                : 'Unavailable because this custom calendar changes the Gregorian month/day structure.');
    }

    const settingsWrap = document.getElementById('nwst-nager-settings');
    if (settingsWrap) settingsWrap.style.display = (available && enabled) ? 'block' : 'none';

    const country = document.getElementById('nwst-setting-nagerCountry');
    if (country) country.value = nager.countryCode || '';
    const subdivision = document.getElementById('nwst-setting-nagerSubdivision');
    if (subdivision) subdivision.value = nager.subdivisionCode || '';
    setCheckbox('nwst-setting-nagerShowCalendar', nager.showOnCalendar !== false);
    setCheckbox('nwst-setting-nagerInjectPrompt', nager.includeInPrompt !== false);

    const upcoming = document.getElementById('nwst-setting-nagerUpcomingDays');
    if (upcoming) upcoming.value = Number.isInteger(nager.upcomingDays) ? nager.upcomingDays : 7;

    const selectedTypes = new Set(Array.isArray(nager.holidayTypes) && nager.holidayTypes.length ? nager.holidayTypes : ['Public']);
    document.querySelectorAll('#nwst-nager-types .nwst-nager-type').forEach(cb => {
        cb.checked = selectedTypes.has(cb.value);
    });

    const subdivisionList = document.getElementById('nwst-nager-subdivision-options');
    if (subdivisionList) {
        subdivisionList.innerHTML = getNagerSubdivisionOptions(chatId)
            .map(code => `<option value="${code}"></option>`)
            .join('');
    }

    const status = document.getElementById('nwst-nager-cache-status');
    if (status) {
        if (!available) {
            status.textContent = isLunisolarCalendar(config)
                ? 'Nager.Date is paused in Lunisolar mode because the public API uses Gregorian dates.'
                : 'Nager.Date is paused because this calendar is not structurally Gregorian-compatible.';
        } else if (!enabled) {
            status.textContent = 'Holiday integration is off.';
        } else if (!nager.countryCode) {
            status.textContent = 'Choose a country code, then save Calendar Config to fetch holidays.';
        } else {
            const cache = getNagerCacheStatus(chatId);
            if (!cache.currentDate) {
                status.textContent = 'Holiday settings saved. NWST will fetch once the Current Day has a parseable real-world date and year.';
            } else if (cache.currentYearCached) {
                status.textContent = `Holiday data cached for ${nager.countryCode} ${cache.currentDate.year}.`;
            } else {
                status.textContent = `No cached ${nager.countryCode} holiday data for ${cache.currentDate.year} yet.`;
            }
        }
    }
}

function readNagerDateConfigFromUI(existing) {
    const countryCode = document.getElementById('nwst-setting-nagerCountry')?.value?.trim().toUpperCase() || '';
    const subdivisionCode = document.getElementById('nwst-setting-nagerSubdivision')?.value?.trim().toUpperCase() || '';
    const holidayTypes = Array.from(document.querySelectorAll('#nwst-nager-types .nwst-nager-type:checked')).map(cb => cb.value);
    const upcomingRaw = parseInt(document.getElementById('nwst-setting-nagerUpcomingDays')?.value, 10);

    return {
        ...(existing || {}),
        enabled: document.getElementById('nwst-setting-nagerEnabled')?.checked === true,
        countryCode,
        subdivisionCode,
        holidayTypes,
        showOnCalendar: document.getElementById('nwst-setting-nagerShowCalendar')?.checked !== false,
        includeInPrompt: document.getElementById('nwst-setting-nagerInjectPrompt')?.checked !== false,
        upcomingDays: Number.isInteger(upcomingRaw) ? Math.max(0, Math.min(30, upcomingRaw)) : 7,
        cache: existing?.cache && typeof existing.cache === 'object' ? existing.cache : {}
    };
}

/**
 * Fill the Starting Date field + status line from the stored anchor.
 * A confirmed user entry locks the field permanently (one-time entry);
 * a scan-derived anchor stays editable until the user confirms their own.
 */
function populateStartDateUI() {
    const input = document.getElementById('nwst-setting-startDate');
    const btn = document.getElementById('nwst-setting-setStartDate');
    const status = document.getElementById('nwst-startdate-status');
    if (!input || !btn || !status) return;

    const chatId = getChatId();

    const pinInput = document.getElementById('nwst-setting-eraPin');
    if (pinInput) pinInput.value = chatId ? getEraPin(chatId) : '';
    const anchor = chatId ? getStartDate(chatId) : null;

    if (!anchor) {
        input.value = '';
        input.disabled = false;
        btn.disabled = false;
        const cur = chatId ? getCurrentDay(chatId) : null;
        // A fresh NWST state can carry a default dayCount before a canonical
        // Current Day exists. Only treat the chat as actively tracking when
        // there is an actual displayed date.
        const hasCurrentDate = typeof cur?.dateDisplay === 'string' && cur.dateDisplay.trim().length > 0;
        const tracking = hasCurrentDate && Number.isInteger(cur.dayCount) && cur.dayCount > 0;
        status.textContent = tracking
            ? 'Not set — NWST is already tracking this chat; anything entered now is stored as reference information only.'
            : 'Not set — the warmup scan will fill this from the roleplay text, or enter it yourself now.';
        return;
    }

    const cfg = getCalendarConfig(chatId);
    const names = monthNamesFor(cfg, anchor.year);
    const monthName = names[Math.min(anchor.month - 1, names.length - 1)] || `Month ${anchor.month}`;
    input.value = `${monthName} ${anchor.day}${ordinalSuffix(anchor.day)}, ${formatYear(anchor.year)}`;

    if (anchor.locked) {
        input.disabled = true;
        btn.disabled = true;
        status.textContent = 'Locked — recorded as this chat\u2019s starting date.';
    } else {
        input.disabled = false;
        btn.disabled = false;
        status.textContent = 'Auto-filled from the warmup scan. You may correct it — confirming your own entry locks it permanently.';
    }
}

/**
 * Render the month editor list for calendar config.
 */
function renderCalendarMonthsList() {
    const container = document.getElementById('nwst-calendar-months-list');
    if (!container) return;

    const chatId = getChatId();
    if (!chatId) return;

    const config = getCalendarConfig(chatId);
    const template = document.getElementById('nwst-calendar-month-tpl');
    if (!template) return;

    const lunisolar = isLunisolarCalendar(config);
    const baseMonthCount = lunisolar ? 12 : config.months;
    const year = currentCalendarYearForConfig(config);
    const layout = lunisolar ? calendarMonthLayoutFor(config, year) : [];
    const regularLengths = new Map(
        layout.filter(entry => !entry.isLeapMonth).map(entry => [entry.baseMonth, entry.days])
    );

    container.innerHTML = '';

    for (let i = 0; i < baseMonthCount; i++) {
        const clone = template.content.cloneNode(true);

        const indexSpan = clone.querySelector('.nwst-month-index');
        const nameInput = clone.querySelector('.nwst-month-name-input');
        const daysInput = clone.querySelector('.nwst-month-days-input');
        const daysLabel = clone.querySelector('.nwst-month-days-label');

        indexSpan.textContent = `${i + 1}.`;
        nameInput.value = config.monthNames[i] || `Month ${i + 1}`;
        daysInput.value = lunisolar ? (regularLengths.get(i + 1) || 29) : (config.monthDays[i] || 30);
        daysInput.disabled = lunisolar;
        daysInput.title = lunisolar ? `Automatically calculated for calendar year ${formatYear(year)}.` : '';
        if (daysLabel && lunisolar) daysLabel.textContent = 'days (auto)';

        // Keep display names live-saved as before. Fixed day counts are only
        // editable in standard mode; lunisolar day lengths come from the year layout.
        const updateMonth = async () => {
            const cfg = getCalendarConfig(chatId);
            cfg.monthNames[i] = nameInput.value.trim() || `Month ${i + 1}`;
            if (!isLunisolarCalendar(cfg)) cfg.monthDays[i] = parseInt(daysInput.value, 10) || 30;
            await saveCalendarConfig(chatId, cfg);
            validateCalendarTotal();
        };
        nameInput.addEventListener('change', updateMonth);
        daysInput.addEventListener('change', updateMonth);

        container.appendChild(clone);
    }

    validateCalendarTotal();
}

/**
 * Validate that total days in months matches season config year length.
 */
function validateCalendarTotal() {
    const validationEl = document.getElementById('nwst-calendar-validation');
    if (!validationEl) return;

    const chatId = getChatId();
    if (!chatId) return;

    const calendarConfig = getCalendarConfig(chatId);
    const seasonConfig = getSeasonConfig(chatId);

    if (isLunisolarCalendar(calendarConfig)) {
        const year = currentCalendarYearForConfig(calendarConfig);
        const layout = calendarMonthLayoutFor(calendarConfig, year);
        const totalDays = layout.reduce((sum, entry) => sum + entry.days, 0);
        const leapEntry = layout.find(entry => entry.isLeapMonth);
        const leapText = leapEntry ? ` · intercalary ${leapEntry.name}` : '';
        validationEl.innerHTML = `<span class="nwst-validation-ok">✓ Lunisolar ${formatYear(year)}: ${layout.length} months · ${totalDays} days${leapText}</span>`
            + `<div style="font-size:10px;color:#888;margin-top:3px">Lunisolar year length varies, so NWST does not require it to match the Season configuration year length.</div>`;
        return;
    }

    const totalDays = calendarConfig.monthDays.slice(0, calendarConfig.months).reduce((sum, d) => sum + (d || 0), 0);
    const yearLength = seasonConfig.yearLength || 365;

    if (totalDays === yearLength) {
        validationEl.innerHTML = `<span class="nwst-validation-ok">✓ Total days (${totalDays}) match season year length (${yearLength})</span>`;
    } else {
        validationEl.innerHTML = `<span class="nwst-validation-error">✗ Total days (${totalDays}) do not match season year length (${yearLength}) — adjust month days or year length to match</span>`;
    }
}

/**
 * Render the days-of-week editor list from the stored config.
 */

// ── Special Days: card-based editor ─────────────────────────────────────
// Saved days render as collapsed cards grouped into sections by category
// (like the Secrets menu). Tapping a card opens its edit form in place, with
// its own Save/Remove inside (like Events). "Add special day" opens an
// unsaved draft form; nothing persists until that draft's Save is pressed.
let specialDayDraft = null;
const expandedSpecialDayIds = new Set();

function specialDayDateText(sd, cfg) {
    const names = Array.isArray(cfg.monthNames) ? cfg.monthNames : [];
    const nameOf = (m) => names[m - 1] || `Month ${m}`;
    let text = `${nameOf(sd.month)} ${sd.day}`;
    if (sd.endMonth != null && sd.endDay != null) {
        text += (sd.endMonth === sd.month) ? `–${sd.endDay}` : ` – ${nameOf(sd.endMonth)} ${sd.endDay}`;
    }
    return text;
}

function specialDayFormHTML(sd, cfg, isDraft) {
    const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const monthNames = Array.isArray(cfg.monthNames) ? cfg.monthNames : [];
    const monthOptions = (sel) => monthNames.map((n, i) =>
        `<option value="${i + 1}"${(i + 1) === sel ? ' selected' : ''}>${esc(n)}</option>`).join('');
    const monthOptionsBlank = (sel) => `<option value=""${sel == null ? ' selected' : ''}>—</option>` + monthOptions(sel);
    const known = Object.prototype.hasOwnProperty.call(SPECIAL_DAY_CATEGORIES, sd.category) && sd.category !== 'custom';
    const customText = known ? '' : (sd.category === 'custom' ? '' : (sd.category || ''));
    const catOptions = () => {
        const keys = Object.keys(SPECIAL_DAY_CATEGORIES).filter(k => k !== 'custom');
        return keys.map(k =>
            `<option value="${k}"${k === sd.category ? ' selected' : ''}>${SPECIAL_DAY_CATEGORIES[k].chip} ${esc(SPECIAL_DAY_CATEGORIES[k].label)}</option>`
        ).join('') + `<option value="custom"${!known ? ' selected' : ''}>📌 Custom…</option>`;
    };
    return `
        <div class="nwst-sd-form" style="margin-top:6px">
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
                <input type="text" class="nwst-sd-name" value="${esc(sd.name)}" placeholder="Name (e.g. Elena's birthday)" style="flex:1;min-width:100px;font-size:12px;padding:3px 6px">
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                <select class="nwst-sd-month" style="font-size:12px">${monthOptions(sd.month || 1)}</select>
                <input type="number" class="nwst-sd-day" min="1" max="99" value="${parseInt(sd.day, 10) || 1}" style="width:52px;font-size:12px;padding:3px 4px" title="Day of month">
                <span style="font-size:11px;color:#888">through</span>
                <select class="nwst-sd-end-month" style="font-size:12px" title="Optional range end — leave as — for a single day">${monthOptionsBlank(sd.endMonth)}</select>
                <input type="number" class="nwst-sd-end-day" min="1" max="99" value="${sd.endDay != null ? parseInt(sd.endDay, 10) : ''}" style="width:52px;font-size:12px;padding:3px 4px" title="Optional range end day">
                <select class="nwst-sd-category" style="font-size:12px">${catOptions()}</select>
                <input type="text" class="nwst-sd-category-custom" value="${esc(customText)}" placeholder="Custom category" style="width:110px;font-size:12px;padding:3px 6px;${known ? 'display:none' : ''}">
            </div>
            <textarea class="nwst-sd-desc" placeholder="Optional lore the AI should know about this day (e.g. what it means, how it's observed, who cares about it) — carried into the event each year" style="width:100%;margin-top:4px;font-size:12px;padding:3px 6px;min-height:34px;resize:vertical">${esc(sd.description || '')}</textarea>
            <div class="nwst-btn-row" style="margin-top:6px;display:flex;gap:6px">
                <button type="button" class="menu_button nwst-btn nwst-sd-save" style="font-size:11px;padding:3px 10px">💾 Save special day</button>
                ${isDraft
                    ? `<button type="button" class="menu_button nwst-btn nwst-sd-cancel" style="font-size:11px;padding:3px 10px">Cancel</button>`
                    : `<button type="button" class="menu_button nwst-btn nwst-sd-collapse" style="font-size:11px;padding:3px 10px">Collapse</button>
                       <button type="button" class="menu_button nwst-btn nwst-sd-remove" style="font-size:11px;padding:3px 10px;margin-left:auto" title="Remove this special day">✗ Remove</button>`}
            </div>
        </div>`;
}

/** Read one card's form into a config entry. Returns null (with focus) when the name is missing. */
function collectSpecialDayFromForm(formEl, existingId) {
    const name = formEl.querySelector('.nwst-sd-name')?.value?.trim();
    if (!name) {
        nwstToast('Give the special day a name before saving.', 'warning');
        formEl.querySelector('.nwst-sd-name')?.focus();
        return null;
    }
    const month = parseInt(formEl.querySelector('.nwst-sd-month')?.value, 10) || 1;
    const day = parseInt(formEl.querySelector('.nwst-sd-day')?.value, 10) || 1;
    const endMonthRaw = formEl.querySelector('.nwst-sd-end-month')?.value;
    const endDayRaw = formEl.querySelector('.nwst-sd-end-day')?.value;
    const endMonth = endMonthRaw ? parseInt(endMonthRaw, 10) : null;
    const endDay = (endMonth != null && endDayRaw) ? parseInt(endDayRaw, 10) : null;
    let category = formEl.querySelector('.nwst-sd-category')?.value || 'custom';
    if (category === 'custom') {
        const text = formEl.querySelector('.nwst-sd-category-custom')?.value?.trim();
        category = text || 'custom';
    }
    const description = formEl.querySelector('.nwst-sd-desc')?.value?.trim() || '';
    return {
        id: existingId || ('sd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
        name, month, day,
        endMonth: (endMonth != null && endDay != null) ? endMonth : null,
        endDay: (endMonth != null && endDay != null) ? endDay : null,
        category, description
    };
}

/** Persist one entry (new or edited), then materialize near-term occurrences. */
async function commitSpecialDay(entry) {
    const chatId = getChatId();
    if (!chatId) { nwstToast('No active chat.', 'error'); return false; }
    const config = getCalendarConfig(chatId);
    config.specialDays = Array.isArray(config.specialDays) ? config.specialDays : [];
    const idx = config.specialDays.findIndex(x => x.id === entry.id);
    if (idx >= 0) config.specialDays[idx] = entry; else config.specialDays.push(entry);
    await saveCalendarConfig(chatId, config);
    try {
        const { materializeSpecialDays } = await import('../data/specialDays.js');
        const created = await materializeSpecialDays(chatId);
        if (created > 0) {
            nwstToast(`Special day saved — ${created} event(s) surfaced in the Events tab.`, 'success');
            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('events');
            return true;
        }
    } catch (e) { /* fall through to plain toast */ }
    nwstToast('Special day saved.', 'success');
    return true;
}

function renderSpecialDaysList() {
    const container = document.getElementById('nwst-special-days-list');
    if (!container) return;
    const chatId = getChatId();
    if (!chatId) { container.innerHTML = ''; return; }
    const cfg = getCalendarConfig(chatId);
    const specialDays = Array.isArray(cfg.specialDays) ? cfg.specialDays : [];
    const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    // Group saved days into category sections (known categories in registry
    // order, then each custom label as its own alphabetical section).
    const groups = new Map();
    for (const sd of specialDays) {
        const known = Object.prototype.hasOwnProperty.call(SPECIAL_DAY_CATEGORIES, sd.category) && sd.category !== 'custom';
        const key = known ? sd.category : ((typeof sd.category === 'string' && sd.category.trim() && sd.category !== 'custom') ? `~${sd.category.trim()}` : 'custom');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(sd);
    }
    const orderedKeys = [
        ...Object.keys(SPECIAL_DAY_CATEGORIES).filter(k => groups.has(k)),
        ...[...groups.keys()].filter(k => k.startsWith('~')).sort()
    ];

    let html = '';
    if (specialDayDraft) {
        html += `<div class="nwst-event-group nwst-sd-card" data-sd-draft="1" style="border:1px solid #6a9fb5;border-radius:8px;padding:8px;margin-bottom:8px">`;
        html += `<div class="nwst-lbl" style="margin-bottom:2px">➕ New special day</div>`;
        html += specialDayFormHTML(specialDayDraft, cfg, true);
        html += `</div>`;
    }

    for (const key of orderedKeys) {
        const info = key.startsWith('~')
            ? { label: key.slice(1).slice(0, 40), chip: SPECIAL_DAY_CATEGORIES.custom.chip }
            : (key === 'custom' ? { label: 'Custom', chip: SPECIAL_DAY_CATEGORIES.custom.chip } : SPECIAL_DAY_CATEGORIES[key]);
        const entries = groups.get(key);
        html += `<div class="nwst-event-group" style="border:1px solid #333;border-radius:8px;padding:6px 8px;margin-bottom:8px">`;
        html += `<div class="nwst-lbl" style="margin-bottom:4px">${info.chip} ${esc(info.label)} <span style="color:#666;font-weight:normal">(${entries.length})</span></div>`;
        for (const sd of entries.slice().sort((a, b) => (a.month - b.month) || (a.day - b.day))) {
            const expanded = expandedSpecialDayIds.has(sd.id);
            html += `<div class="nwst-sd-card" data-sd-id="${esc(sd.id)}" style="border:1px solid #2c2c2c;border-radius:6px;padding:5px 8px;margin-bottom:5px;background:rgba(255,255,255,0.02)">`;
            html += `<div class="nwst-sd-summary" style="display:flex;align-items:center;gap:8px;cursor:pointer" title="${expanded ? 'Collapse' : 'Open to edit'}">`;
            html += `<span style="font-weight:600;font-size:13px;flex:1">${esc(sd.name)}</span>`;
            html += `<span style="font-size:12px;color:#aaa">${esc(specialDayDateText(sd, cfg))}</span>`;
            html += `<span style="font-size:11px;color:#888">${info.chip} ${esc(info.label)}</span>`;
            html += `<span style="font-size:11px;color:#666">${expanded ? '▾' : '▸'}</span>`;
            html += `</div>`;
            if (expanded) html += specialDayFormHTML(sd, cfg, false);
            html += `</div>`;
        }
        html += `</div>`;
    }

    if (!html) {
        html = `<div style="font-size:11px;color:#666;font-style:italic">No special days yet — add birthdays, holidays, deadlines, and other recurring days here.</div>`;
    }
    container.innerHTML = html;

    // ── Wiring (per render) ──
    container.querySelectorAll('.nwst-sd-category').forEach(sel => {
        sel.addEventListener('change', () => {
            const custom = sel.closest('.nwst-sd-form').querySelector('.nwst-sd-category-custom');
            if (custom) custom.style.display = sel.value === 'custom' ? '' : 'none';
        });
    });
    container.querySelectorAll('.nwst-sd-summary').forEach(sum => {
        sum.addEventListener('click', () => {
            const id = sum.closest('.nwst-sd-card')?.dataset?.sdId;
            if (!id) return;
            if (expandedSpecialDayIds.has(id)) expandedSpecialDayIds.delete(id);
            else expandedSpecialDayIds.add(id);
            renderSpecialDaysList();
        });
    });
    container.querySelectorAll('.nwst-sd-save').forEach(btn => {
        btn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const card = btn.closest('.nwst-sd-card');
            const form = btn.closest('.nwst-sd-form');
            const isDraft = card?.dataset?.sdDraft === '1';
            const entry = collectSpecialDayFromForm(form, isDraft ? null : card?.dataset?.sdId);
            if (!entry) return;
            btn.disabled = true;
            const ok = await commitSpecialDay(entry);
            if (ok) {
                if (isDraft) specialDayDraft = null;
                expandedSpecialDayIds.delete(entry.id);
                renderSpecialDaysList();
            } else {
                btn.disabled = false;
            }
        });
    });
    container.querySelectorAll('.nwst-sd-cancel, .nwst-sd-collapse').forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const card = btn.closest('.nwst-sd-card');
            if (card?.dataset?.sdDraft === '1') specialDayDraft = null;
            else if (card?.dataset?.sdId) expandedSpecialDayIds.delete(card.dataset.sdId);
            renderSpecialDaysList();
        });
    });
    container.querySelectorAll('.nwst-sd-remove').forEach(btn => {
        btn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const id = btn.closest('.nwst-sd-card')?.dataset?.sdId;
            const cid = getChatId();
            if (!cid || !id) return;
            const c = getCalendarConfig(cid);
            c.specialDays = (c.specialDays || []).filter(x => x.id !== id);
            await saveCalendarConfig(cid, c);
            expandedSpecialDayIds.delete(id);
            renderSpecialDaysList();
            nwstToast('Special day removed. Any already-materialized event for it stays until you delete or resolve it.', 'info');
        });
    });
}

function renderCalendarDaysList() {
    const container = document.getElementById('nwst-calendar-days-list');
    if (!container) return;

    const chatId = getChatId();
    if (!chatId) return;

    const config = getCalendarConfig(chatId);
    const template = document.getElementById('nwst-calendar-day-tpl');
    if (!template) return;

    container.innerHTML = '';

    const dayCount = config.weekDays.length || 7;
    for (let i = 0; i < dayCount; i++) {
        const clone = template.content.cloneNode(true);

        const indexSpan = clone.querySelector('.nwst-month-index');
        const nameInput = clone.querySelector('.nwst-weekday-name-input');

        indexSpan.textContent = `${i + 1}.`;
        nameInput.value = config.weekDays[i] || `Day ${i + 1}`;

        // Wire live updates to store
        const updateDay = async () => {
            const cfg = getCalendarConfig(chatId);
            cfg.weekDays[i] = nameInput.value.trim() || `Day ${i + 1}`;
            await saveCalendarConfig(chatId, cfg);
        };
        nameInput.addEventListener('change', updateDay);

        container.appendChild(clone);
    }
}

// ── Populate UI with current settings values ──────────────────────────────

// Weight field definitions for the secrets engine UI
const SCORING_WEIGHT_FIELDS = [
    { key: 'knowerPresent',        label: 'Knower present',          hint: 'a character who knows the secret is in the scene' },
    { key: 'unawarePresent',       label: 'Unaware party present',   hint: 'a character who must not know is in the scene' },
    { key: 'bothPresent',          label: 'Both present (subject referenced)', hint: 'knower + unaware present AND the secret\'s subject is referenced in the scene' },
    { key: 'coPresenceOnly',       label: 'Co-present only',          hint: 'knower + unaware present but the secret\'s subject is NOT referenced — coincidental co-presence' },
    { key: 'sharedThemeMatch',     label: 'Shared theme match',      hint: 'a theme word shared across multiple secrets matched, but no distinctive subject anchor — weak signal' },
    { key: 'npcCutawayHolder',     label: 'NPC cutaway w/ holder',   hint: 'cutaway/surveillance/faction scene with the secret-holder' },
    { key: 'groupMatch',           label: 'Group/faction match',     hint: 'a group tied to the secret is present' },
    { key: 'anchorMatch',          label: 'Distinctive anchor match', hint: 'a word distinctive to THIS secret (not a shared theme) appears in the scene' },
    { key: 'revealConditionMatch', label: 'Reveal condition match',  hint: 'prose approaches the secret\'s reveal conditions' },
    { key: 'pressureMatch',        label: 'Pressure match',          hint: 'the secret\'s pressure/risk is active in the scene' },
    { key: 'continuityRisk',       label: 'Continuity risk',         hint: 'omitting a relevant Critical secret risks a break' },
    { key: 'priorityLow',          label: 'Priority: Low',           hint: 'modifier added when secret is Low priority' },
    { key: 'priorityNormal',       label: 'Priority: Normal',        hint: 'modifier added when secret is Normal priority' },
    { key: 'priorityHigh',         label: 'Priority: High',          hint: 'modifier added when secret is High priority' },
    { key: 'priorityCritical',     label: 'Priority: Critical',      hint: 'modifier added when secret is Critical priority' },
];

function renderScoringWeights() {
    const container = document.getElementById('nwst-scoring-weights');
    if (!container) return;
    const weights = getScoringWeights();
    let html = '';
    for (const field of SCORING_WEIGHT_FIELDS) {
        const val = weights[field.key] ?? 0;
        html += `
        <div class="nwst-setting-row" style="padding:5px 0">
            <div>
                <div class="nwst-setting-label" style="font-size:12px">${field.label}</div>
                <div class="nwst-setting-sub">${field.hint}</div>
            </div>
            <input type="number" class="nwst-weight-input" data-weight-key="${field.key}" value="${val}" min="-100" max="100" style="width:56px;text-align:center;flex-shrink:0">
        </div>`;
    }
    container.innerHTML = html;
    // Wire each weight input
    container.querySelectorAll('.nwst-weight-input').forEach(input => {
        input.onchange = function () {
            const key = this.getAttribute('data-weight-key');
            const v = parseInt(this.value);
            if (!isNaN(v)) setScoringWeight(key, v);
        };
    });
}

async function renderAliasList() {
    const container = document.getElementById('nwst-alias-list');
    if (!container) return;
    try {
        const { getManualAliases } = await import('../data/aliasRegistry.js');
        const groups = getManualAliases(getChatId());
        if (!groups || groups.length === 0) {
            container.innerHTML = '<div style="font-size:11px;color:#999;font-style:italic">No manual aliases yet.</div>';
            return;
        }
        let html = '';
        for (const g of groups) {
            const aliasStr = (g.aliases || []).filter(a => a !== g.canonical).join(', ');
            html += `
            <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:0.5px solid var(--SmartThemeBorderColor,#444)">
                <div style="flex:1">
                    <div style="font-size:12px;font-weight:500">${escapeHtmlLocal(g.display || g.canonical)}</div>
                    <div style="font-size:11px;color:#999">${escapeHtmlLocal(aliasStr || '(no extra aliases)')}</div>
                </div>
                <button class="menu_button nwst-btn-danger nwst-alias-remove" data-canonical="${escapeHtmlLocal(g.canonical)}" style="font-size:11px;padding:2px 8px;flex-shrink:0">Remove</button>
            </div>`;
        }
        container.innerHTML = html;
        container.querySelectorAll('.nwst-alias-remove').forEach(btn => {
            btn.onclick = async function () {
                const canonical = this.getAttribute('data-canonical');
                const { removeManualAlias } = await import('../data/aliasRegistry.js');
                await removeManualAlias(getChatId(), canonical);
                renderAliasList();
                nwstToast('Alias group removed.', 'info');
            };
        });
    } catch (e) {
        container.innerHTML = '<div style="font-size:11px;color:#999">Could not load aliases.</div>';
    }
}

function escapeHtmlLocal(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}


function splitTagInput(value) {
    return [...new Set(String(value || '').split(',').map(v => v.trim()).filter(Boolean))];
}

function renderSettingContextProfileUI() {
    const chatId = getChatId();
    const select = document.getElementById('nwst-setting-contextProfile');
    const textarea = document.getElementById('nwst-setting-context');
    if (!chatId || !select) return;
    const lib = getSettingContextProfiles(chatId);
    select.innerHTML = lib.profiles.length
        ? lib.profiles.map(p => `<option value="${escapeHtmlLocal(p.id)}">${escapeHtmlLocal(p.name)}</option>`).join('')
        : '<option value="">No saved profiles</option>';
    select.value = lib.activeProfileId || '';
    const active = lib.profiles.find(p => p.id === lib.activeProfileId);
    if (textarea) textarea.value = active?.content || getSettingContext(chatId) || '';
}

function weatherEventOptions(selected = '') {
    const opts = Object.entries(WEATHER_EVENT_DEFS).map(([id, def]) =>
        `<option value="${id}" ${id === selected ? 'selected' : ''}>${escapeHtmlLocal(def.icon + ' ' + def.label)}</option>`
    );
    opts.push(`<option value="custom" ${selected === 'custom' ? 'selected' : ''}>⚠️ Custom</option>`);
    return opts.join('');
}

function renderWeatherOverrides(profile) {
    const container = document.getElementById('nwst-weather-overrides-list');
    if (!container) return;
    if (!profile) {
        container.innerHTML = '<div class="nwst-setting-sub">Select or create a Weather Profile first.</div>';
        return;
    }
    const todayElapsed = getCurrentDay(getChatId())?.elapsedStoryDays || 0;
    const overrides = Array.isArray(profile.overrides) ? profile.overrides : [];
    if (overrides.length === 0) {
        container.innerHTML = '<div class="nwst-setting-sub">No overrides for this profile.</div>';
        return;
    }
    container.innerHTML = overrides.map((o, idx) => {
        const startsIn = Math.max(0, Number(o.startElapsedDay ?? todayElapsed) - todayElapsed);
        const durationDays = Math.max(1, Number(o.durationDays || Math.ceil((o.durationHours || 24) / 24)));
        return `<div class="nwst-card nwst-weather-override-row" data-index="${idx}" data-start-elapsed="${Number(o.startElapsedDay ?? todayElapsed)}" style="margin-bottom:6px;padding:8px">
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
                <select class="nwst-weather-ov-type" style="flex:1">${weatherEventOptions(o.type || 'severe_thunderstorm')}</select>
                <select class="nwst-weather-ov-severity" style="width:100px">
                    <option value="moderate" ${o.severity==='moderate'?'selected':''}>Moderate</option>
                    <option value="severe" ${o.severity==='severe'?'selected':''}>Severe</option>
                    <option value="extreme" ${o.severity==='extreme'?'selected':''}>Extreme</option>
                </select>
                <button type="button" class="menu_button nwst-btn-danger nwst-weather-ov-remove" style="padding:2px 7px">×</button>
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;font-size:11px">
                <span>Starts in</span><input class="nwst-weather-ov-start" type="number" min="0" value="${startsIn}" style="width:52px;text-align:center"><span>days</span>
                <span>Duration</span><input class="nwst-weather-ov-duration" type="number" min="1" max="30" value="${durationDays}" style="width:52px;text-align:center"><span>days</span>
                <select class="nwst-weather-ov-time" style="width:105px"><option ${o.timeOfDay==='morning'?'selected':''}>morning</option><option ${o.timeOfDay==='afternoon'?'selected':''}>afternoon</option><option ${o.timeOfDay==='evening'?'selected':''}>evening</option><option ${o.timeOfDay==='overnight'?'selected':''}>overnight</option><option ${!o.timeOfDay||o.timeOfDay==='all day'?'selected':''}>all day</option></select>
            </div>
            <input class="nwst-weather-ov-name" type="text" value="${escapeHtmlLocal(o.customName || '')}" placeholder="Custom name (optional)" style="margin-bottom:5px">
            <textarea class="nwst-weather-ov-desc" rows="2" placeholder="Optional hard-constraint notes">${escapeHtmlLocal(o.description || '')}</textarea>
        </div>`;
    }).join('');

    container.querySelectorAll('.nwst-weather-ov-remove').forEach(btn => {
        btn.onclick = async () => {
            const row = btn.closest('.nwst-weather-override-row');
            const idx = Number(row?.dataset?.index);
            const state = getWeatherProfilesState(getChatId());
            const active = state.profiles.find(p => p.id === state.activeProfileId);
            if (!active || !Number.isInteger(idx)) return;
            active.overrides.splice(idx, 1);
            await saveWeatherProfilesState(getChatId(), state);
            renderWeatherProfileUI();
        };
    });
}

async function collectWeatherOverridesIntoState(state) {
    const active = state.profiles.find(p => p.id === state.activeProfileId);
    if (!active) return;
    const todayElapsed = getCurrentDay(getChatId())?.elapsedStoryDays || 0;
    const rows = [...document.querySelectorAll('.nwst-weather-override-row')];
    active.overrides = rows.map((row, idx) => {
        const type = row.querySelector('.nwst-weather-ov-type')?.value || 'severe_thunderstorm';
        const startsIn = Math.max(0, parseInt(row.querySelector('.nwst-weather-ov-start')?.value || '0', 10) || 0);
        const durationDays = Math.max(1, parseInt(row.querySelector('.nwst-weather-ov-duration')?.value || '1', 10) || 1);
        const originalStart = Number(row.dataset.startElapsed);
        const startElapsedDay = Number.isFinite(originalStart) && originalStart <= todayElapsed && startsIn === 0
            ? originalStart
            : todayElapsed + startsIn;
        return {
            id: active.overrides?.[idx]?.id || `weather_override_${Date.now()}_${idx}`,
            enabled: true,
            type,
            severity: row.querySelector('.nwst-weather-ov-severity')?.value || 'severe',
            startElapsedDay,
            durationDays,
            durationHours: durationDays * 24,
            recoveryDays: 0,
            timeOfDay: row.querySelector('.nwst-weather-ov-time')?.value || 'all day',
            customName: row.querySelector('.nwst-weather-ov-name')?.value?.trim() || '',
            description: row.querySelector('.nwst-weather-ov-desc')?.value?.trim() || ''
        };
    });
}

function renderWeatherProfileUI() {
    const chatId = getChatId();
    if (!chatId) return;
    const state = getWeatherProfilesState(chatId);
    const select = document.getElementById('nwst-weather-profile-select');
    const editor = document.getElementById('nwst-weather-profile-editor');
    if (select) {
        select.innerHTML = state.profiles.length
            ? state.profiles.map(p => `<option value="${escapeHtmlLocal(p.id)}">${escapeHtmlLocal(p.name)}</option>`).join('')
            : '<option value="">No Weather Profiles</option>';
        select.value = state.activeProfileId || '';
    }
    const enabled = document.getElementById('nwst-weather-enabled');
    const affect = document.getElementById('nwst-weather-affect-forecast');
    const showHome = document.getElementById('nwst-weather-show-home');
    if (enabled) enabled.checked = state.enabled === true;
    if (affect) affect.checked = state.affectForecast !== false;
    if (showHome) showHome.checked = state.showOnHome !== false;

    const p = state.profiles.find(x => x.id === state.activeProfileId) || null;
    if (editor) editor.style.display = p ? 'block' : 'none';
    if (p) {
        const byId = id => document.getElementById(id);
        if (byId('nwst-weather-name')) byId('nwst-weather-name').value = p.name || '';
        if (byId('nwst-weather-frequency')) byId('nwst-weather-frequency').value = p.frequency || 'occasional';
        if (byId('nwst-weather-climate')) byId('nwst-weather-climate').value = (p.climate || []).join(', ');
        if (byId('nwst-weather-terrain')) byId('nwst-weather-terrain').value = (p.terrain || []).join(', ');
        if (byId('nwst-weather-characteristics')) byId('nwst-weather-characteristics').value = (p.characteristics || []).join(', ');
        if (byId('nwst-weather-notes')) byId('nwst-weather-notes').value = p.notes || '';
    }
    const status = document.getElementById('nwst-weather-current-system');
    if (status) {
        if (!p) status.textContent = 'No active Weather Profile.';
        else if (!p.activeSystem) status.textContent = `Profile: ${p.name} — ${profileSummary(p) || 'no climate/terrain tags yet'} · no severe weather active.`;
        else status.textContent = `Profile: ${p.name} · ${p.activeSystem.icon || '⚠️'} ${p.activeSystem.severity} ${p.activeSystem.label}`;
    }
    renderWeatherOverrides(p);
}

function populateSettingsUI() {
    // Connection profile dropdowns
    populateConnectionProfileDropdowns();

    // Scan frequency
    const minMsgInput = document.getElementById('nwst-setting-scanMinimumMessages');
    if (minMsgInput) minMsgInput.value = getScanMinimumMessages() || 10;

    const maxSnapInput = document.getElementById('nwst-setting-maxSnapshotCount');
    if (maxSnapInput) maxSnapInput.value = getMaxSnapshotCount() || 30;

    // Event compaction threshold
    const compactInput = document.getElementById('nwst-setting-eventCompactionThreshold');
    if (compactInput) compactInput.value = getSetting('eventCompactionThreshold') ?? 0;

    // Auto-promote events toggle
    setCheckbox('nwst-setting-autoPromoteEvents', getSetting('autoPromoteEvents') !== false);
    setCheckbox('nwst-setting-eventValidityReview', getSetting('eventValidityReview') !== false);
    renderNoThinkRows();

    const freqInput = document.getElementById('nwst-setting-scanFrequency');
    if (freqInput) freqInput.value = getScanFrequency();

    // Moon cycle (per-chat)
    const moonConfig = getMoonConfig(getChatId());
    const moonCycleInput = document.getElementById('nwst-setting-moonCycleDays');
    if (moonCycleInput) moonCycleInput.value = moonConfig.moonCycleDays || 29.53;
    setCheckbox('nwst-setting-enableMoons', moonConfig.enableMoons !== false);
    setCheckbox('nwst-setting-enableMoonPhenomena', moonConfig.enableMoonPhenomena !== false);
    renderMoonsList();
    renderMoonOverridesList();

    // Setting context profiles + Severe Weather profiles (both per-chat)
    renderSettingContextProfileUI();
    renderWeatherProfileUI();
    renderContextSnapshotsList();

    // Injection toggles
    const inj = getInjectionSettings();
    const maxEvInput = document.getElementById('nwst-setting-maxActiveEvents');
    if (maxEvInput) maxEvInput.value = getMaxActiveEvents();

    const maxSecInput = document.getElementById('nwst-setting-maxSecretsInjected');
    if (maxSecInput) maxSecInput.value = getMaxSecretsInjected();
    const sidecarCadInput = document.getElementById('nwst-setting-sidecarCadence');
    if (sidecarCadInput) sidecarCadInput.value = getSidecarCadence();
    const sidecarRangeInput = document.getElementById('nwst-setting-sidecarScanRange');
    if (sidecarRangeInput) sidecarRangeInput.value = getSidecarScanRange();
    const pcMeta = getSecretsMeta(getChatId());
    const pcNameInput = document.getElementById('nwst-secret-pc-name');
    const pcAliasesInput = document.getElementById('nwst-secret-pc-aliases');
    if (pcNameInput) pcNameInput.value = pcMeta.userCharacterName || '';
    if (pcAliasesInput) pcAliasesInput.value = pcMeta.userCharacterAliases || '';
    const threshInput = document.getElementById('nwst-setting-injectionThreshold');
    if (threshInput) threshInput.value = getInjectionThreshold();
    const decayInput = document.getElementById('nwst-setting-decayThreshold');
    if (decayInput) decayInput.value = getSecretDecayThreshold();
    const reconcileInput = document.getElementById('nwst-setting-reconcileCadence');
    if (reconcileInput) reconcileInput.value = getReconcileCadence();
    renderScoringWeights();
    renderAliasList();

    const densitySelect = document.getElementById('nwst-setting-densityMode');
    if (densitySelect) densitySelect.value = getDensityMode() || 'combined';
    setCheckbox('nwst-setting-injectCurrentDay', inj.injectCurrentDay);
    setCheckbox('nwst-setting-injectEvents', inj.injectEvents);
    setCheckbox('nwst-setting-injectWorldConditions', inj.injectWorldConditions);

    // Secret budget tokens
    const budgetSlider = document.getElementById('nwst-setting-secretBudget');
    const budgetVal = document.getElementById('nwst-setting-secretBudget-value');
    if (budgetSlider) {
        const val = getSecretBudgetTokens();
        budgetSlider.value = val;
        if (budgetVal) budgetVal.textContent = val;
    }

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

    // Season configuration (per-chat)
    populateSeasonConfigUI();

    // Calendar configuration (per-chat)
    populateCalendarConfigUI();
}

/**
 * Render the multi-moon list from settings and wire up add/remove events.
 */
function renderMoonsList() {
    const container = document.getElementById('nwst-moons-list');
    if (!container) return;

    const chatId = getChatId();
    const moons = getMoonConfig(chatId).moons || [];
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

        const updateMoon = async () => {
            const cfg = getMoonConfig(chatId);
            if (cfg.moons[i]) {
                cfg.moons[i].enabled = cb.checked;
                cfg.moons[i].name = nameInput.value.trim() || 'The Moon';
                cfg.moons[i].cycleDays = parseFloat(cycleInput.value) || 29.53;
                if (i === 0) cfg.moonCycleDays = cfg.moons[i].cycleDays;
                await saveMoonConfig(chatId, cfg);
            }
        };
        cb.addEventListener('change', updateMoon);
        nameInput.addEventListener('change', updateMoon);
        cycleInput.addEventListener('change', updateMoon);

        removeBtn.addEventListener('click', async () => {
            const cfg = getMoonConfig(chatId);
            if (cfg.moons.length <= 1) {
                nwstToast('Cannot remove the last moon. Disable moons entirely for a moonless world.', 'warning');
                return;
            }

            const removedMoonId = cfg.moons[i]?.id || '';
            const promotedMoonId = i === 0 ? (cfg.moons[1]?.id || '') : '';
            cfg.moons.splice(i, 1);
            cfg.moons[0].id = 'primary';
            cfg.moonCycleDays = cfg.moons[0].cycleDays || cfg.moonCycleDays;
            await saveMoonConfig(chatId, cfg);

            // A moon-specific anomaly must never silently become an all-moons
            // anomaly after its target is removed. Drop overrides belonging to
            // the deleted moon, and retarget the newly promoted primary moon.
            const overrides = getMoonPhenomenonOverrides(chatId);
            const reconciledOverrides = overrides
                .filter(override => override.moonId !== removedMoonId)
                .map(override => promotedMoonId && override.moonId === promotedMoonId
                    ? { ...override, moonId: 'primary' }
                    : override);
            if (reconciledOverrides.length !== overrides.length || promotedMoonId) {
                await saveMoonPhenomenonOverrides(chatId, reconciledOverrides);
            }

            renderMoonsList();
            renderMoonOverridesList();
            await refreshMoonStripsAfterConfigChange();
        });

        container.appendChild(clone);
    }
}

function currentOverrideDate() {
    const chatId = getChatId();
    const cal = getCalendarConfig(chatId);
    const day = getCurrentDay(chatId) || {};
    const dmy = getSetting('dateFormatDMY') === true;
    return parseCurrentCalendarDate(day.dateDisplay || '', day.dateSub || '', cal, dmy)
        || dateFromDayCount(day.dayCount || 1, extractYearFromText(day.dateSub || '') || extractYearFromText(day.dateDisplay || '') || 1, cal);
}

function readOverrideDate(row, prefix) {
    const year = parseInt(row.querySelector(`.nwst-moon-override-${prefix}-year`)?.value, 10);
    const month = parseInt(row.querySelector(`.nwst-moon-override-${prefix}-month`)?.value, 10);
    const day = parseInt(row.querySelector(`.nwst-moon-override-${prefix}-day`)?.value, 10);
    if (!Number.isInteger(year) || year === 0 || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    return { year, month, day };
}

function validateOverrideDate(date, calendarConfig) {
    if (!date) return false;
    const lengths = monthLengthsFor(calendarConfig, date.year);
    return date.month >= 1 && date.month <= lengths.length && date.day >= 1 && date.day <= lengths[date.month - 1];
}

function renderMoonOverridesList() {
    const container = document.getElementById('nwst-moon-overrides-list');
    if (!container) return;
    const chatId = getChatId();
    const overrides = getMoonPhenomenonOverrides(chatId);
    const moons = getMoonConfig(chatId).moons || [];
    const template = document.getElementById('nwst-moon-override-tpl');
    if (!template) return;

    if (overrides.length === 0) {
        container.innerHTML = '<div style="font-size:11px;color:#999;font-style:italic">No manual moon phenomena overrides.</div>';
        return;
    }

    container.innerHTML = '';
    overrides.forEach((override, index) => {
        const clone = template.content.cloneNode(true);
        const row = clone.querySelector('.nwst-moon-override-entry');
        const enabled = row.querySelector('.nwst-moon-override-enabled');
        const moonSelect = row.querySelector('.nwst-moon-override-moon');
        const typeSelect = row.querySelector('.nwst-moon-override-type');
        const custom = row.querySelector('.nwst-moon-override-custom');
        const description = row.querySelector('.nwst-moon-override-description');
        const remove = row.querySelector('.nwst-moon-override-remove');

        enabled.checked = override.enabled !== false;
        moonSelect.innerHTML = '<option value="all">All moons</option>' + moons.map(m => `<option value="${escapeHtmlLocal(m.id)}">${escapeHtmlLocal(m.name)}</option>`).join('');
        moonSelect.value = override.moonId || 'all';
        typeSelect.innerHTML = MOON_OVERRIDE_PHENOMENA.map(item => `<option value="${escapeHtmlLocal(item.value)}">${escapeHtmlLocal(item.label)}</option>`).join('');
        typeSelect.value = override.phenomenon || '__custom__';
        custom.value = override.customLabel || '';
        custom.style.display = typeSelect.value === '__custom__' ? 'block' : 'none';
        description.value = override.description || '';

        for (const [prefix, date] of [['start', override.startDate], ['end', override.endDate]]) {
            row.querySelector(`.nwst-moon-override-${prefix}-year`).value = date?.year ?? '';
            row.querySelector(`.nwst-moon-override-${prefix}-month`).value = date?.month ?? '';
            row.querySelector(`.nwst-moon-override-${prefix}-day`).value = date?.day ?? '';
        }

        typeSelect.addEventListener('change', () => {
            custom.style.display = typeSelect.value === '__custom__' ? 'block' : 'none';
        });
        remove.addEventListener('click', async () => {
            const current = getMoonPhenomenonOverrides(chatId);
            current.splice(index, 1);
            await saveMoonPhenomenonOverrides(chatId, current);
            renderMoonOverridesList();
            await refreshMoonStripsAfterConfigChange();
        });
        container.appendChild(clone);
    });
}

async function collectAndSaveMoonOverrides() {
    const chatId = getChatId();
    const calendarConfig = getCalendarConfig(chatId);
    const existing = getMoonPhenomenonOverrides(chatId);
    const rows = document.querySelectorAll('#nwst-moon-overrides-list .nwst-moon-override-entry');
    const overrides = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const startDate = readOverrideDate(row, 'start');
        const endDate = readOverrideDate(row, 'end') || startDate;
        if (!validateOverrideDate(startDate, calendarConfig) || !validateOverrideDate(endDate, calendarConfig)) {
            nwstToast(`Moon override ${i + 1} has an invalid calendar date.`, 'error');
            return false;
        }
        const span = daysBetweenCalendarDates(startDate, endDate, calendarConfig);
        if (!Number.isInteger(span) || span < 0) {
            nwstToast(`Moon override ${i + 1} ends before it starts.`, 'error');
            return false;
        }
        const phenomenon = row.querySelector('.nwst-moon-override-type').value;
        const customLabel = row.querySelector('.nwst-moon-override-custom').value.trim();
        if (phenomenon === '__custom__' && !customLabel) {
            nwstToast(`Moon override ${i + 1} needs a custom phenomenon label.`, 'error');
            return false;
        }
        overrides.push({
            id: existing[i]?.id || `moon_override_${Date.now()}_${i}`,
            enabled: row.querySelector('.nwst-moon-override-enabled').checked,
            moonId: row.querySelector('.nwst-moon-override-moon').value || 'all',
            phenomenon,
            customLabel,
            description: row.querySelector('.nwst-moon-override-description').value.trim(),
            startDate,
            endDate
        });
    }
    await saveMoonPhenomenonOverrides(chatId, overrides);
    return true;
}

async function refreshMoonStripsAfterConfigChange() {
    try {
        const { regenerateMoonPhasesOnly } = await import('../llm/dayAdvancement.js');
        await regenerateMoonPhasesOnly();
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
    } catch (e) {
        console.warn('[NWST Settings UI] Moon strip refresh failed:', e);
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
        { id: 'nwst-setting-narrativeConsistencyLLM', profileKey: 'narrativeConsistencyLLM' },
        { id: 'nwst-setting-secretsSidecarLLM', profileKey: 'secretsSidecarLLM' }
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
        select.innerHTML = '<option value="">— Not configured (feature disabled) —</option>';

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

function renderNoThinkRows() {
    const container = document.getElementById('nwst-nothink-rows');
    if (!container) return;
    const roleLabels = {
        planningLLM: 'Planning',
        dayAdvancementLLM: 'Day advancement',
        narrativeConsistencyLLM: 'Narrative consistency',
        secretsSidecarLLM: 'Secrets sidecar',
    };
    const conns = getConnectionProfiles() || {};
    const softMap = (getSetting('noThinkProfiles') && typeof getSetting('noThinkProfiles') === 'object') ? getSetting('noThinkProfiles') : {};
    const hardMap = (getSetting('noThinkHardProfiles') && typeof getSetting('noThinkHardProfiles') === 'object') ? getSetting('noThinkHardProfiles') : {};

    container.innerHTML = '';
    for (const roleKey of Object.keys(roleLabels)) {
        const pid = conns[roleKey] || '';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:14px;padding:5px 0;border-bottom:0.5px solid #2a2a2a';
        const label = pid ? roleLabels[roleKey] : `${roleLabels[roleKey]} <span style="color:#a66">(no profile)</span>`;
        const dis = pid ? '' : 'disabled';
        row.innerHTML = `
            <span style="flex:1;font-size:12px;color:#ccc">${label}</span>
            <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#aaa;cursor:pointer"><input type="checkbox" class="nwst-nt-soft" ${softMap[pid] ? 'checked' : ''} ${dis}> soft</label>
            <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#aaa;cursor:pointer"><input type="checkbox" class="nwst-nt-hard" ${hardMap[pid] ? 'checked' : ''} ${dis}> hard</label>
        `;
        const soft = row.querySelector('.nwst-nt-soft');
        const hard = row.querySelector('.nwst-nt-hard');
        if (soft) soft.addEventListener('change', () => {
            const m = (getSetting('noThinkProfiles') && typeof getSetting('noThinkProfiles') === 'object') ? getSetting('noThinkProfiles') : {};
            if (soft.checked) m[pid] = true; else delete m[pid];
            setSetting('noThinkProfiles', m);
        });
        if (hard) hard.addEventListener('change', () => {
            const m = (getSetting('noThinkHardProfiles') && typeof getSetting('noThinkHardProfiles') === 'object') ? getSetting('noThinkHardProfiles') : {};
            if (hard.checked) m[pid] = true; else delete m[pid];
            setSetting('noThinkHardProfiles', m);
        });
        container.appendChild(row);
    }
}


function cloneForContextSnapshot(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isActiveSettingsChat(chatId) {
    return Boolean(chatId) && getChatId() === chatId;
}

function clearSettingRefreshPopupState() {
    delete window._nwstRefreshSettingEnvironment;
    delete window._nwstRefreshSettingConditions;
    delete window._nwstRefreshSettingWorldEvents;
}

function normalizedSettingLibraryForSnapshot(library) {
    return {
        activeProfileId: library?.activeProfileId || null,
        profiles: Array.isArray(library?.profiles) ? cloneForContextSnapshot(library.profiles) : []
    };
}

function activeSettingName(library) {
    return library?.profiles?.find(p => p.id === library.activeProfileId)?.name || 'None';
}

function activeWeatherName(state) {
    return state?.profiles?.find(p => p.id === state.activeProfileId)?.name || 'None';
}

async function recordSettingProfileChangeSnapshot(beforeLibrary, afterLibrary, action = 'Setting Context') {
    const beforeId = beforeLibrary?.activeProfileId || null;
    const afterId = afterLibrary?.activeProfileId || null;
    if (beforeId === afterId) return null;
    const beforeName = activeSettingName(beforeLibrary);
    const afterName = activeSettingName(afterLibrary);
    const snap = await saveContextSnapshot(getChatId(), {
        type: 'setting_profile_change',
        label: `${action}: ${beforeName} → ${afterName}`,
        details: 'Selection/profile-library change only; no world state was regenerated.',
        payload: { settingContextProfilesSnapshot: normalizedSettingLibraryForSnapshot(beforeLibrary) }
    });
    renderContextSnapshotsList();
    return snap;
}

async function recordWeatherProfileChangeSnapshot(beforeState, afterState, action = 'Weather Profile') {
    const beforeId = beforeState?.activeProfileId || null;
    const afterId = afterState?.activeProfileId || null;
    if (beforeId === afterId) return null;
    const beforeName = activeWeatherName(beforeState);
    const afterName = activeWeatherName(afterState);
    const snap = await saveContextSnapshot(getChatId(), {
        type: 'weather_profile_change',
        label: `${action}: ${beforeName} → ${afterName}`,
        details: 'Weather Profile selection/library change only; no story-date snapshot was created.',
        payload: { weatherProfilesSnapshot: cloneForContextSnapshot(beforeState) }
    });
    renderContextSnapshotsList();
    return snap;
}

async function capturePreSettingRefreshSnapshot(options = {}) {
    const chatId = options.expectedChatId || getChatId();
    if (!isActiveSettingsChat(chatId)) return null;

    const refreshEnvironment = options.refreshEnvironment === true;
    const refreshConditions = options.refreshConditions === true;
    const replaceWorldEvents = options.replaceWorldEvents === true;
    if (!refreshEnvironment && !refreshConditions && !replaceWorldEvents) return null;

    const currentSettingLibrary = getSettingContextProfiles(chatId);
    const payload = {
        // For an immediate profile-switch refresh, restore all the way to the
        // pre-switch library. Manual refreshes restore the currently selected profile.
        settingContextProfilesSnapshot: normalizedSettingLibraryForSnapshot(
            options.previousSettingLibrary || currentSettingLibrary
        ),
        weatherProfilesSnapshot: cloneForContextSnapshot(getWeatherProfilesState(chatId))
    };

    const ws = getWorldState(chatId);
    if (refreshEnvironment) {
        payload.environmentSnapshot = {
            currentDay: {
                season: ws?.currentDay?.season || '',
                weatherToday: ws?.currentDay?.weatherToday || '',
                flora: ws?.currentDay?.flora || '',
                fauna: ws?.currentDay?.fauna || '',
                spiritualClimate: ws?.currentDay?.spiritualClimate || ''
            },
            forecast: cloneForContextSnapshot(ws?.forecast || [])
        };
    }
    if (refreshConditions) {
        payload.conditionsSnapshot = cloneForContextSnapshot(ws?.conditions || {});
    }
    if (replaceWorldEvents) {
        const eventsModule = await import('../data/events.js');
        if (!isActiveSettingsChat(chatId)) return null;
        payload.eventsSnapshot = cloneForContextSnapshot(eventsModule.getAllEvents(chatId) || []);
        const ctx = SillyTavern.getContext();
        payload.pendingEventsSnapshot = cloneForContextSnapshot(
            Array.isArray(ctx.chatMetadata['nwst:pendingEvents']) ? ctx.chatMetadata['nwst:pendingEvents'] : []
        );
    }

    const activeSetting = currentSettingLibrary.profiles.find(p => p.id === currentSettingLibrary.activeProfileId);
    const transition = options.changeLabel || activeSetting?.name || 'Current Setting';
    const selected = [
        refreshEnvironment ? 'environment/forecast' : null,
        refreshConditions ? 'world conditions' : null,
        replaceWorldEvents ? 'generated world events' : null
    ].filter(Boolean).join(', ');

    if (!isActiveSettingsChat(chatId)) return null;
    const snap = await saveContextSnapshot(chatId, {
        type: 'setting_refresh',
        label: `Before Setting Refresh — ${transition}`,
        details: `Captured before regenerating: ${selected}.`,
        refreshOptions: { refreshEnvironment, refreshConditions, replaceWorldEvents },
        payload
    });
    renderContextSnapshotsList();
    return snap;
}

async function restoreContextProfileSnapshot(snapshotId) {
    const chatId = getChatId();
    const snapshot = getContextSnapshot(chatId, snapshotId);
    if (!snapshot) {
        nwstToast('Context/Profile snapshot no longer exists.', 'warning');
        return;
    }

    const ok = await SillyTavern.getContext().callGenericPopup(
        `Restore <strong>${escapeHtmlLocal(snapshot.label)}</strong>?<br><br>This only restores the data captured by this Context/Profile snapshot. It does not invoke Previous Day or change the story date unless that data was explicitly part of the snapshot.`,
        SillyTavern.getContext().POPUP_TYPE.CONFIRM,
        ''
    );
    if (!ok) return;
    if (!isActiveSettingsChat(chatId)) {
        console.warn('[NWST ContextSnapshots] Restore cancelled because the active chat changed while the confirmation was open.');
        return;
    }

    const payload = snapshot.payload || {};
    try {
        if (payload.settingContextProfilesSnapshot) {
            await saveSettingContextProfiles(chatId, cloneForContextSnapshot(payload.settingContextProfilesSnapshot));
        }
        if (payload.weatherProfilesSnapshot) {
            await saveWeatherProfilesState(chatId, cloneForContextSnapshot(payload.weatherProfilesSnapshot));
        }

        if (payload.environmentSnapshot || payload.conditionsSnapshot) {
            const ws = getWorldState(chatId);
            if (payload.environmentSnapshot) {
                ws.currentDay = {
                    ...ws.currentDay,
                    ...cloneForContextSnapshot(payload.environmentSnapshot.currentDay || {})
                };
                ws.forecast = cloneForContextSnapshot(payload.environmentSnapshot.forecast || []);
            }
            if (payload.conditionsSnapshot) {
                ws.conditions = cloneForContextSnapshot(payload.conditionsSnapshot);
            }
            await saveWorldState(chatId, ws);
        }

        if (payload.eventsSnapshot) {
            const eventsModule = await import('../data/events.js');
            if (!isActiveSettingsChat(chatId)) return;
            await eventsModule.saveAllEvents(chatId, cloneForContextSnapshot(payload.eventsSnapshot));
        }
        if (payload.pendingEventsSnapshot) {
            if (!isActiveSettingsChat(chatId)) return;
            const ctx = SillyTavern.getContext();
            ctx.chatMetadata['nwst:pendingEvents'] = cloneForContextSnapshot(payload.pendingEventsSnapshot);
            await ctx.saveMetadata();
        }

        renderSettingContextProfileUI();
        renderWeatherProfileUI();
        renderContextSnapshotsList();
        if (typeof window?.nwstRefreshTabs === 'function') {
            window.nwstRefreshTabs('home', 'world', 'events', 'notebook');
        }
        nwstToast(`Restored Context/Profile snapshot: ${snapshot.label}`, 'success');
    } catch (err) {
        console.error('[NWST ContextSnapshots] Restore failed:', err);
        nwstToast(`Context/Profile restore failed: ${err.message}`, 'error');
    }
}

function renderContextSnapshotsList() {
    const container = document.getElementById('nwst-context-snapshot-list');
    if (!container) return;
    const list = getContextSnapshots(getChatId());
    if (!list.length) {
        container.innerHTML = '<div style="font-size:11px;color:#888;padding:4px 0">No Context/Profile snapshots yet.</div>';
        return;
    }

    container.innerHTML = list.map(snapshot => {
        const when = snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : 'Unknown time';
        return `<div class="nwst-context-snapshot-row" data-snapshot-id="${escapeHtmlLocal(snapshot.id)}" style="padding:7px 0;border-bottom:0.5px solid var(--SmartThemeBorderColor,#444)">
            <div style="font-size:11px;font-weight:600;color:var(--SmartThemeBodyColor,#ddd)">${escapeHtmlLocal(snapshot.label)}</div>
            <div style="font-size:10px;color:#888;margin:2px 0 5px">${escapeHtmlLocal(when)}${snapshot.details ? ` · ${escapeHtmlLocal(snapshot.details)}` : ''}</div>
            <div style="display:flex;gap:6px">
                <button type="button" class="menu_button nwst-btn nwst-context-snapshot-restore" style="font-size:10px;padding:2px 7px">Restore</button>
                <button type="button" class="menu_button nwst-btn-danger nwst-context-snapshot-delete" style="font-size:10px;padding:2px 7px">Delete</button>
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.nwst-context-snapshot-restore').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.closest('.nwst-context-snapshot-row')?.dataset?.snapshotId;
            if (id) await restoreContextProfileSnapshot(id);
        });
    });
    container.querySelectorAll('.nwst-context-snapshot-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.closest('.nwst-context-snapshot-row')?.dataset?.snapshotId;
            if (!id) return;
            await deleteContextSnapshot(getChatId(), id);
            renderContextSnapshotsList();
        });
    });
}


async function refreshSettingDependentState(options = {}) {
    const chatId = options.expectedChatId || getChatId();
    if (!isActiveSettingsChat(chatId)) return false;

    const refreshEnvironment = options.refreshEnvironment === true;
    const refreshConditions = options.refreshConditions === true;
    const replaceWorldEvents = options.replaceWorldEvents === true;

    if (!refreshEnvironment && !refreshConditions && !replaceWorldEvents) {
        nwstToast('No setting-dependent refresh items were selected.', 'info');
        return;
    }

    nwstToast('Refreshing selected setting-dependent NWST state...', 'info');

    try {
        // Forecast + Current Day environment are refreshed first. The special
        // setting-change synthesis intentionally ignores old World Conditions
        // and old events so stale location data cannot bleed into the new scene.
        if (refreshEnvironment) {
            const { regenerateForecastOnly } = await import('../llm/dayAdvancement.js');
            const { synthesizeCurrentDay } = await import('../llm/currentDaySynth.js');
            if (!isActiveSettingsChat(chatId)) return false;
            const forecastOk = await regenerateForecastOnly();
            if (!forecastOk || !isActiveSettingsChat(chatId)) return false;
            await synthesizeCurrentDay(chatId, undefined, { ignoreConditions: true, ignoreEvents: true });
            if (!isActiveSettingsChat(chatId)) return false;
        }

        if (refreshConditions) {
            const { regenerateAllWorldConditionsForSettingChange } = await import('./worldState.js');
            if (!isActiveSettingsChat(chatId)) return false;
            const conditionsOk = await regenerateAllWorldConditionsForSettingChange(chatId);
            if (!conditionsOk || !isActiveSettingsChat(chatId)) return false;
        }

        if (replaceWorldEvents) {
            const eventsModule = await import('../data/events.js');
            if (!isActiveSettingsChat(chatId)) return false;
            const allEvents = eventsModule.getAllEvents(chatId) || [];
            const keptEvents = allEvents.filter(event => {
                const active = event?.status === 'pending' || event?.status === 'inprogress';
                const generatedWorld = event?.isNPC === false && event?.origin === 'generated';
                const specialDay = Boolean(event?.sourceSpecialDayId) || event?.origin === 'special_day';
                return !(active && generatedWorld && !specialDay);
            });
            const removedCount = allEvents.length - keptEvents.length;

            // Temporarily hide stale generated-world proposals so they cannot
            // suppress replacement ideas as duplicates. If generation fails or
            // produces nothing, restore them and keep the active old events too.
            if (!isActiveSettingsChat(chatId)) return false;
            const ctx = SillyTavern.getContext();
            const pendingBefore = Array.isArray(ctx.chatMetadata['nwst:pendingEvents'])
                ? [...ctx.chatMetadata['nwst:pendingEvents']]
                : [];
            const keptPending = pendingBefore.filter(event => !(event?.isNPC === false && event?.origin === 'generated'));
            if (keptPending.length !== pendingBefore.length) {
                ctx.chatMetadata['nwst:pendingEvents'] = keptPending;
                await ctx.saveMetadata();
            }

            const { regenerateAllWorldEvents } = await import('../llm/eventGen.js');
            let proposed = 0;
            try {
                proposed = await regenerateAllWorldEvents({ settingRefresh: true });
                if (!isActiveSettingsChat(chatId)) return false;
            } catch (generationErr) {
                // The old generated proposals were hidden only to keep stale-setting
                // duplicates out of the replacement prompt. Never lose them on error.
                if (keptPending.length !== pendingBefore.length) {
                    ctx.chatMetadata['nwst:pendingEvents'] = pendingBefore;
                    await ctx.saveMetadata();
                }
                throw generationErr;
            }
            if (proposed > 0) {
                if (removedCount > 0) await eventsModule.saveAllEvents(chatId, keptEvents);
                nwstToast(`Setting refresh removed ${removedCount} old generated world event(s) and proposed ${proposed} replacement(s) for review.`, 'success');
            } else {
                if (keptPending.length !== pendingBefore.length) {
                    ctx.chatMetadata['nwst:pendingEvents'] = pendingBefore;
                    await ctx.saveMetadata();
                }
                nwstToast('No replacement world-event proposals were generated, so the existing generated world events were preserved.', 'warning');
            }
        }

        if (!isActiveSettingsChat(chatId)) return false;
        if (typeof window?.nwstRefreshTabs === 'function') {
            window.nwstRefreshTabs('home', 'world', 'events');
        }
        nwstToast('Setting-dependent refresh complete.', 'success');
        return true;
    } catch (err) {
        console.error('[NWST Settings] Setting-dependent refresh failed:', err);
        nwstToast(`Setting refresh failed: ${err.message}`, 'error');
    }
}

async function promptSettingContextStateRefresh({ reason = 'profile-switch', previousSettingLibrary = null, changeLabel = '' } = {}) {
    const chatId = getChatId();
    if (!chatId) return false;

    const settingLib = getSettingContextProfiles(chatId);
    const activeSetting = settingLib.profiles.find(p => p.id === settingLib.activeProfileId);
    const activeWeather = getActiveWeatherProfile(chatId);
    const settingName = escapeHtmlLocal(activeSetting?.name || 'Current Setting');
    const weatherName = escapeHtmlLocal(activeWeather?.name || 'None selected');

    window._nwstRefreshSettingEnvironment = true;
    window._nwstRefreshSettingConditions = true;
    window._nwstRefreshSettingWorldEvents = false;

    const html = `
        <div style="padding:6px 4px;max-width:620px;line-height:1.45">
            <div style="font-size:15px;font-weight:600;margin-bottom:8px">Refresh NWST for “${settingName}”?</div>
            <div style="font-size:12px;color:#aaa;margin-bottom:10px">
                The Setting Context changed, but NWST has <strong>not</strong> rewritten any existing state. Choose what should be rebuilt for the new setting. Cancel/Keep Existing performs zero model calls.
            </div>
            <div style="font-size:11px;color:#999;margin-bottom:10px;padding:8px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:6px">
                <strong>Always preserved:</strong> current date/calendar, Notebook, Secrets, Communities, NPC events, story-detected events, Special Days, resolved/missed event history, and character continuity.
            </div>
            <label style="display:flex;gap:9px;align-items:flex-start;margin-bottom:8px;cursor:pointer">
                <input type="checkbox" checked onchange="window._nwstRefreshSettingEnvironment=this.checked" style="margin-top:3px">
                <span><strong>Current environment + 7-day forecast</strong><br><span style="font-size:11px;color:#999">Regenerates forecast plus Current Day weather/flora/fauna/spiritual atmosphere. ~2 model calls.</span></span>
            </label>
            <label style="display:flex;gap:9px;align-items:flex-start;margin-bottom:8px;cursor:pointer">
                <input type="checkbox" checked onchange="window._nwstRefreshSettingConditions=this.checked" style="margin-top:3px">
                <span><strong>World Conditions</strong><br><span style="font-size:11px;color:#999">Rebuilds Political, Social, Spiritual, and Environmental conditions against the new Setting Context. Up to 4 Planning LLM calls.</span></span>
            </label>
            <label style="display:flex;gap:9px;align-items:flex-start;margin-bottom:10px;cursor:pointer">
                <input type="checkbox" onchange="window._nwstRefreshSettingWorldEvents=this.checked" style="margin-top:3px">
                <span><strong>Replace generated World Events</strong><br><span style="font-size:11px;color:#999">Removes only active LLM-generated non-NPC/world events from the old setting, then generates replacement world-event proposals for approval. NPC, detected, and Special Day events are untouched. ~3 Planning LLM calls.</span></span>
            </label>
            <div style="font-size:11px;color:#c99;padding-top:8px;border-top:1px solid var(--SmartThemeBorderColor,#555)">
                Active Weather Profile: <strong>${weatherName}</strong>. Forecast refresh uses this profile. If the location changed and this Weather Profile is wrong, choose <strong>Keep Existing</strong>, switch Weather Profile, then click <strong>Refresh Setting State…</strong>.
            </div>
        </div>`;

    const ctx = SillyTavern.getContext();
    const result = await ctx.callGenericPopup(html, ctx.POPUP_TYPE.TEXT, '', {
        okButton: 'Refresh Selected',
        cancelButton: 'Keep Existing',
        wide: true,
    });

    if (!result) {
        clearSettingRefreshPopupState();
        if (reason === 'profile-switch') {
            nwstToast('Setting Context changed; existing NWST state was kept unchanged. Refresh later if needed.', 'info');
        }
        return false;
    }
    if (!isActiveSettingsChat(chatId)) {
        clearSettingRefreshPopupState();
        console.warn('[NWST Settings] Setting refresh cancelled because the active chat changed while the popup was open.');
        return false;
    }

    const refreshOptions = {
        refreshEnvironment: window._nwstRefreshSettingEnvironment !== false,
        refreshConditions: window._nwstRefreshSettingConditions !== false,
        replaceWorldEvents: window._nwstRefreshSettingWorldEvents === true,
    };
    clearSettingRefreshPopupState();
    const snapshot = await capturePreSettingRefreshSnapshot({
        ...refreshOptions,
        expectedChatId: chatId,
        previousSettingLibrary,
        changeLabel
    });
    if (!isActiveSettingsChat(chatId)) return false;
    if ((refreshOptions.refreshEnvironment || refreshOptions.refreshConditions || refreshOptions.replaceWorldEvents) && !snapshot) return false;
    return await refreshSettingDependentState({ ...refreshOptions, expectedChatId: chatId });
}

function wireSettingsEvents() {
    // ── Connection profile dropdowns ─────────────────────────────
    wireSelect('nwst-setting-planningLLM', (val) => { setConnectionProfile('planningLLM', val); renderNoThinkRows(); });
    wireSelect('nwst-setting-dayAdvancementLLM', (val) => { setConnectionProfile('dayAdvancementLLM', val); renderNoThinkRows(); });
    wireSelect('nwst-setting-narrativeConsistencyLLM', (val) => { setConnectionProfile('narrativeConsistencyLLM', val); renderNoThinkRows(); });
    wireSelect('nwst-setting-secretsSidecarLLM', (val) => { setConnectionProfile('secretsSidecarLLM', val); renderNoThinkRows(); });

    // ── Scan frequency ───────────────────────────────────────────
    wireInput('nwst-setting-scanMinimumMessages', (val) => {
        setScanMinimumMessages(val);
    });

    wireInput('nwst-setting-maxSnapshotCount', (val) => {
        setMaxSnapshotCount(val);
    });

    // ── Event compaction threshold ─────────────────────────────
    wireInput('nwst-setting-eventCompactionThreshold', (val) => {
        const num = parseInt(val, 10);
        if (num >= 0 && num <= 999) setSetting('eventCompactionThreshold', num);
    });

    // ── Event→Secret auto-promotion ──────────────────────────
    wireCheckbox('nwst-setting-eventValidityReview', (checked) => {
        setSetting('eventValidityReview', checked);
    });
    wireCheckbox('nwst-setting-autoPromoteEvents', (checked) => {
        setSetting('autoPromoteEvents', checked);
    });

    wireInput('nwst-setting-scanFrequency', (val) => {
        const num = parseInt(val, 10);
        if (num >= 1 && num <= 100) setScanFrequency(num);
    });

    // ── Moon cycle (per-chat) ─────────────────────────────────
    wireInput('nwst-setting-moonCycleDays', async (val) => {
        const num = parseFloat(val);
        if (num >= 1 && num <= 999) {
            const cfg = getMoonConfig(getChatId());
            cfg.moonCycleDays = num;
            if (cfg.moons[0]) cfg.moons[0].cycleDays = num;
            await saveMoonConfig(getChatId(), cfg);
            renderMoonsList();
            await refreshMoonStripsAfterConfigChange();
        }
    });
    wireCheckbox('nwst-setting-enableMoons', async (checked) => {
        await updateMoonConfig(getChatId(), { enableMoons: checked });
        await refreshMoonStripsAfterConfigChange();
    });
    wireCheckbox('nwst-setting-enableMoonPhenomena', async (checked) => {
        await updateMoonConfig(getChatId(), { enableMoonPhenomena: checked });
        await refreshMoonStripsAfterConfigChange();
    });

    const saveMoonsBtn = document.getElementById('nwst-setting-saveMoons');
    if (saveMoonsBtn) {
        saveMoonsBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const chatId = getChatId();
            const container = document.getElementById('nwst-moons-list');
            if (!container) return;
            const cfg = getMoonConfig(chatId);
            const existing = cfg.moons || [];
            const rows = container.querySelectorAll('.nwst-moon-entry');
            const moons = [];
            rows.forEach((row, i) => {
                const name = row.querySelector('.nwst-moon-name')?.value?.trim() || 'The Moon';
                const cycle = parseFloat(row.querySelector('.nwst-moon-cycle')?.value) || 29.53;
                const enabled = row.querySelector('.nwst-moon-enabled')?.checked !== false;
                moons.push({
                    id: i === 0 ? 'primary' : (existing[i]?.id || `moon_${Date.now()}_${i}`),
                    name,
                    cycleDays: cycle > 0 ? cycle : 29.53,
                    enabled
                });
            });
            cfg.moons = moons;
            if (moons[0]) cfg.moonCycleDays = moons[0].cycleDays;
            await saveMoonConfig(chatId, cfg);
            await refreshMoonStripsAfterConfigChange();
            nwstToast(`Moon settings saved for this chat (${moons.length} moon${moons.length === 1 ? '' : 's'}).`, 'success');
        });
    }

    const addMoonBtn = document.getElementById('nwst-setting-addMoon');
    if (addMoonBtn) {
        addMoonBtn.addEventListener('click', async () => {
            const cfg = getMoonConfig(getChatId());
            cfg.moons.push({ id: `moon_${Date.now()}`, name: 'New Moon', cycleDays: 29.53, enabled: true });
            await saveMoonConfig(getChatId(), cfg);
            renderMoonsList();
            renderMoonOverridesList();
        });
    }

    const restoreMoonsBtn = document.getElementById('nwst-setting-restoreDefaultMoons');
    if (restoreMoonsBtn) {
        restoreMoonsBtn.addEventListener('click', async () => {
            const confirmed = await SillyTavern.getContext().callGenericPopup(
                'This will reset moon cycle settings for the current chat. Manual phenomenon overrides will be preserved. Continue?',
                SillyTavern.getContext().POPUP_TYPE.CONFIRM,
                '',
            );
            if (!confirmed) return;
            await saveMoonConfig(getChatId(), {
                enableMoons: true,
                moonCycleDays: 29.53,
                enableMoonPhenomena: true,
                moons: [{ id: 'primary', name: 'The Moon', cycleDays: 29.53, enabled: true }]
            });
            const moonCycleInput = document.getElementById('nwst-setting-moonCycleDays');
            if (moonCycleInput) moonCycleInput.value = 29.53;
            setCheckbox('nwst-setting-enableMoons', true);
            setCheckbox('nwst-setting-enableMoonPhenomena', true);
            renderMoonsList();
            renderMoonOverridesList();
            await refreshMoonStripsAfterConfigChange();
            nwstToast('Moon cycle settings restored for this chat.', 'success');
        });
    }

    const addOverrideBtn = document.getElementById('nwst-setting-addMoonOverride');
    if (addOverrideBtn) {
        addOverrideBtn.addEventListener('click', async () => {
            const chatId = getChatId();
            const date = currentOverrideDate();
            if (!date) {
                nwstToast('Set or repair the Current Day date before adding a moon override.', 'warning');
                return;
            }
            const overrides = getMoonPhenomenonOverrides(chatId);
            overrides.push({
                id: `moon_override_${Date.now()}`,
                enabled: true,
                moonId: 'all',
                phenomenon: '🌕 Blood Moon',
                customLabel: '',
                description: '',
                startDate: { ...date },
                endDate: { ...date }
            });
            await saveMoonPhenomenonOverrides(chatId, overrides);
            renderMoonOverridesList();
        });
    }

    const saveOverridesBtn = document.getElementById('nwst-setting-saveMoonOverrides');
    if (saveOverridesBtn) {
        saveOverridesBtn.addEventListener('click', async () => {
            if (!await collectAndSaveMoonOverrides()) return;
            await refreshMoonStripsAfterConfigChange();
            nwstToast('Moon phenomenon overrides saved for this chat.', 'success');
        });
    }

    // ── Setting context profiles (per-chat) ──────────────────────
    const contextSelect = document.getElementById('nwst-setting-contextProfile');
    if (contextSelect) {
        contextSelect.addEventListener('change', async () => {
            const chatId = getChatId();
            if (!chatId || !contextSelect.value) return;
            const beforeLib = getSettingContextProfiles(chatId);
            const before = beforeLib.activeProfileId;
            const beforeName = activeSettingName(beforeLib);
            const targetName = beforeLib.profiles.find(p => p.id === contextSelect.value)?.name || 'Selected Setting';
            await setActiveSettingContextProfile(chatId, contextSelect.value);
            const afterLib = getSettingContextProfiles(chatId);
            await recordSettingProfileChangeSnapshot(beforeLib, afterLib);
            renderSettingContextProfileUI();
            nwstToast('Setting Context profile changed. Review the active Weather Profile if the location/environment also changed.', 'info');
            if (before !== contextSelect.value) await promptSettingContextStateRefresh({
                reason: 'profile-switch',
                previousSettingLibrary: beforeLib,
                changeLabel: `${beforeName} → ${targetName}`
            });
        });
    }

    const saveContextBtn = document.getElementById('nwst-setting-saveContext');
    if (saveContextBtn) {
        saveContextBtn.addEventListener('click', async () => {
            const chatId = getChatId();
            const textarea = document.getElementById('nwst-setting-context');
            if (textarea) {
                await saveSettingContext(chatId, textarea.value);
                renderSettingContextProfileUI();
                nwstToast('Setting Context profile saved. Review the active Weather Profile if the environment changed.', 'success');
            }
        });
    }

    const refreshContextStateBtn = document.getElementById('nwst-setting-refreshContextState');
    if (refreshContextStateBtn) {
        refreshContextStateBtn.addEventListener('click', async () => {
            await promptSettingContextStateRefresh({ reason: 'manual' });
        });
    }

    const newContextBtn = document.getElementById('nwst-setting-newContextProfile');
    if (newContextBtn) {
        newContextBtn.addEventListener('click', async () => {
            const name = await SillyTavern.getContext().callGenericPopup('Name this Setting Context profile:', SillyTavern.getContext().POPUP_TYPE.INPUT, 'New Setting');
            if (!name) return;
            const chatId = getChatId();
            const beforeLib = getSettingContextProfiles(chatId);
            await createSettingContextProfile(chatId, String(name).trim() || 'New Setting', '', true);
            await recordSettingProfileChangeSnapshot(beforeLib, getSettingContextProfiles(chatId), 'Setting Context created');
            renderSettingContextProfileUI();
            nwstToast('Setting Context profile created. Review the active Weather Profile if needed.', 'info');
        });
    }

    const duplicateContextBtn = document.getElementById('nwst-setting-duplicateContextProfile');
    if (duplicateContextBtn) {
        duplicateContextBtn.addEventListener('click', async () => {
            const chatId = getChatId();
            const lib = getSettingContextProfiles(chatId);
            const active = lib.profiles.find(p => p.id === lib.activeProfileId);
            if (!active) return;
            const beforeLib = cloneForContextSnapshot(lib);
            await createSettingContextProfile(chatId, `${active.name} Copy`, active.content, true);
            await recordSettingProfileChangeSnapshot(beforeLib, getSettingContextProfiles(chatId), 'Setting Context duplicated');
            renderSettingContextProfileUI();
            nwstToast('Setting Context profile duplicated.', 'success');
        });
    }

    const renameContextBtn = document.getElementById('nwst-setting-renameContextProfile');
    if (renameContextBtn) {
        renameContextBtn.addEventListener('click', async () => {
            const chatId = getChatId();
            let lib = getSettingContextProfiles(chatId);
            const active = lib.profiles.find(p => p.id === lib.activeProfileId);
            if (!active) return;
            const name = await SillyTavern.getContext().callGenericPopup('Rename this Setting Context profile:', SillyTavern.getContext().POPUP_TYPE.INPUT, active.name);
            if (!name) return;
            active.name = String(name).trim() || active.name;
            if (lib.virtualLegacy) lib = { activeProfileId: lib.activeProfileId, profiles: lib.profiles };
            await saveSettingContextProfiles(chatId, lib);
            renderSettingContextProfileUI();
            nwstToast('Setting Context profile renamed.', 'success');
        });
    }

    const deleteContextBtn = document.getElementById('nwst-setting-deleteContextProfile');
    if (deleteContextBtn) {
        deleteContextBtn.addEventListener('click', async () => {
            const chatId = getChatId();
            const lib = getSettingContextProfiles(chatId);
            const active = lib.profiles.find(p => p.id === lib.activeProfileId);
            if (!active) return;
            const ok = await SillyTavern.getContext().callGenericPopup(`Delete Setting Context profile <b>${escapeHtmlLocal(active.name)}</b>?`, SillyTavern.getContext().POPUP_TYPE.CONFIRM, '');
            if (!ok) return;
            const beforeLib = cloneForContextSnapshot(lib);
            const beforeId = lib.activeProfileId;
            const beforeName = active.name || 'Deleted Setting';
            const afterLib = await deleteSettingContextProfile(chatId, active.id);
            await recordSettingProfileChangeSnapshot(beforeLib, afterLib, 'Setting Context deleted');
            renderSettingContextProfileUI();
            nwstToast('Setting Context profile deleted. Review the active Weather Profile if needed.', 'info');
            if (beforeId !== afterLib.activeProfileId && afterLib.activeProfileId) {
                await promptSettingContextStateRefresh({
                    reason: 'profile-switch',
                    previousSettingLibrary: beforeLib,
                    changeLabel: `${beforeName} → ${activeSettingName(afterLib)}`
                });
            }
        });
    }

    // ── Severe Weather / Weather Profiles ───────────────────────
    const weatherEnabled = document.getElementById('nwst-weather-enabled');
    if (weatherEnabled) weatherEnabled.addEventListener('change', async () => {
        const state = getWeatherProfilesState(getChatId());
        state.enabled = weatherEnabled.checked;
        await saveWeatherProfilesState(getChatId(), state);
        renderWeatherProfileUI();
        if (weatherEnabled.checked && !state.activeProfileId) {
            nwstToast('Severe Weather is enabled, but no Weather Profile is selected. Create one manually or analyze Setting Context.', 'warning');
        }
    });
    const weatherAffect = document.getElementById('nwst-weather-affect-forecast');
    if (weatherAffect) weatherAffect.addEventListener('change', async () => {
        const state = getWeatherProfilesState(getChatId());
        state.affectForecast = weatherAffect.checked;
        await saveWeatherProfilesState(getChatId(), state);
    });
    const weatherShow = document.getElementById('nwst-weather-show-home');
    if (weatherShow) weatherShow.addEventListener('change', async () => {
        const state = getWeatherProfilesState(getChatId());
        state.showOnHome = weatherShow.checked;
        await saveWeatherProfilesState(getChatId(), state);
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
    });

    const weatherSelect = document.getElementById('nwst-weather-profile-select');
    if (weatherSelect) weatherSelect.addEventListener('change', async () => {
        if (!weatherSelect.value) return;
        const chatId = getChatId();
        const beforeState = getWeatherProfilesState(chatId);
        await setActiveWeatherProfile(chatId, weatherSelect.value);
        await recordWeatherProfileChangeSnapshot(beforeState, getWeatherProfilesState(chatId));
        renderWeatherProfileUI();
        nwstToast('Weather Profile changed.', 'info');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
    });

    const weatherNew = document.getElementById('nwst-weather-new-profile');
    if (weatherNew) weatherNew.addEventListener('click', async () => {
        const name = await SillyTavern.getContext().callGenericPopup('Name this Weather Profile:', SillyTavern.getContext().POPUP_TYPE.INPUT, 'New Weather Region');
        if (!name) return;
        const chatId = getChatId();
        const beforeState = getWeatherProfilesState(chatId);
        const p = makeDefaultWeatherProfile(String(name).trim() || 'New Weather Region');
        await upsertWeatherProfile(chatId, p, { activate: true });
        await recordWeatherProfileChangeSnapshot(beforeState, getWeatherProfilesState(chatId), 'Weather Profile created');
        renderWeatherProfileUI();
    });

    const weatherAnalyze = document.getElementById('nwst-weather-analyze-setting');
    if (weatherAnalyze) weatherAnalyze.addEventListener('click', async () => {
        weatherAnalyze.disabled = true;
        try {
            nwstToast('Analyzing Setting Context for climate and terrain...', 'info');
            const chatId = getChatId();
            const beforeState = getWeatherProfilesState(chatId);
            await analyzeSettingContextToWeatherProfile(chatId, { activate: true });
            await recordWeatherProfileChangeSnapshot(beforeState, getWeatherProfilesState(chatId), 'Weather Profile generated');
            renderWeatherProfileUI();
        } catch (e) {
            console.error('[NWST WeatherProfile] Analysis failed:', e);
            nwstToast(`Weather Profile analysis failed: ${e.message}`, 'error');
        } finally { weatherAnalyze.disabled = false; }
    });

    const weatherDuplicate = document.getElementById('nwst-weather-duplicate-profile');
    if (weatherDuplicate) weatherDuplicate.addEventListener('click', async () => {
        const chatId = getChatId();
        const beforeState = getWeatherProfilesState(chatId);
        const p = getActiveWeatherProfile(chatId);
        if (!p) return;
        const copy = JSON.parse(JSON.stringify(p));
        copy.id = `weather_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        copy.name = `${p.name} Copy`;
        copy.activeSystem = null;
        copy.history = [];
        await upsertWeatherProfile(chatId, copy, { activate: true });
        await recordWeatherProfileChangeSnapshot(beforeState, getWeatherProfilesState(chatId), 'Weather Profile duplicated');
        renderWeatherProfileUI();
    });

    const weatherDelete = document.getElementById('nwst-weather-delete-profile');
    if (weatherDelete) weatherDelete.addEventListener('click', async () => {
        const chatId = getChatId();
        const beforeState = getWeatherProfilesState(chatId);
        const p = getActiveWeatherProfile(chatId);
        if (!p) return;
        const ok = await SillyTavern.getContext().callGenericPopup(`Delete Weather Profile <b>${escapeHtmlLocal(p.name)}</b>?`, SillyTavern.getContext().POPUP_TYPE.CONFIRM, '');
        if (!ok) return;
        await deleteWeatherProfile(chatId, p.id);
        await recordWeatherProfileChangeSnapshot(beforeState, getWeatherProfilesState(chatId), 'Weather Profile deleted');
        renderWeatherProfileUI();
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
    });

    const weatherSave = document.getElementById('nwst-weather-save-profile');
    if (weatherSave) weatherSave.addEventListener('click', async () => {
        const state = getWeatherProfilesState(getChatId());
        const p = state.profiles.find(x => x.id === state.activeProfileId);
        if (!p) return;
        p.name = document.getElementById('nwst-weather-name')?.value?.trim() || p.name;
        p.frequency = document.getElementById('nwst-weather-frequency')?.value || 'occasional';
        p.climate = splitTagInput(document.getElementById('nwst-weather-climate')?.value);
        p.terrain = splitTagInput(document.getElementById('nwst-weather-terrain')?.value);
        p.characteristics = splitTagInput(document.getElementById('nwst-weather-characteristics')?.value);
        p.notes = document.getElementById('nwst-weather-notes')?.value?.trim() || '';
        await collectWeatherOverridesIntoState(state);
        await saveWeatherProfilesState(getChatId(), state);
        renderWeatherProfileUI();
        nwstToast('Weather Profile saved.', 'success');
    });

    const weatherAddOverride = document.getElementById('nwst-weather-add-override');
    if (weatherAddOverride) weatherAddOverride.addEventListener('click', async () => {
        const state = getWeatherProfilesState(getChatId());
        const p = state.profiles.find(x => x.id === state.activeProfileId);
        if (!p) { nwstToast('Create or select a Weather Profile first.', 'warning'); return; }
        await collectWeatherOverridesIntoState(state);
        p.overrides.push({
            id: `weather_override_${Date.now()}`,
            enabled: true,
            type: 'severe_thunderstorm',
            severity: 'severe',
            startElapsedDay: getCurrentDay(getChatId())?.elapsedStoryDays || 0,
            durationDays: 1,
            durationHours: 24,
            recoveryDays: 0,
            timeOfDay: 'afternoon',
            customName: '', description: ''
        });
        await saveWeatherProfilesState(getChatId(), state);
        renderWeatherProfileUI();
    });

    const weatherClear = document.getElementById('nwst-weather-clear-system');
    if (weatherClear) weatherClear.addEventListener('click', async () => {
        const state = getWeatherProfilesState(getChatId());
        const p = state.profiles.find(x => x.id === state.activeProfileId);
        if (!p?.activeSystem) { nwstToast('No generated severe weather is active.', 'info'); return; }
        p.activeSystem = null;
        await saveWeatherProfilesState(getChatId(), state);
        renderWeatherProfileUI();
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
        nwstToast('Generated severe weather cleared.', 'info');
    });

    // ── Injection toggles ────────────────────────────────────────
    wireCheckbox('nwst-setting-injectCurrentDay', (checked) => setInjectionSetting('injectCurrentDay', checked));
    wireInput('nwst-setting-maxActiveEvents', (val) => setInjectionSetting('maxActiveEvents', Math.max(4, parseInt(val) || 12)));
    wireInput('nwst-setting-maxSecretsInjected', (val) => setInjectionSetting('maxSecretsInjected', Math.max(1, parseInt(val) || 4)));
    wireInput('nwst-setting-sidecarCadence', (val) => setSecretsConfigValue('sidecarCadence', Math.max(1, parseInt(val) || 10)));
    wireInput('nwst-setting-sidecarScanRange', (val) => setSecretsConfigValue('sidecarScanRange', Math.max(1, parseInt(val) || 5)));
    wireInput('nwst-setting-injectionThreshold', (val) => setSecretsConfigValue('injectionThreshold', Math.max(0, parseInt(val) || 30)));
    wireInput('nwst-setting-decayThreshold', (val) => setSecretsConfigValue('decayThreshold', Math.max(0, parseInt(val) || 0)));
    wireInput('nwst-setting-reconcileCadence', (val) => setSecretsConfigValue('reconcileCadence', Math.max(0, parseInt(val) || 0)));

    const savePcBtn = document.getElementById('nwst-secret-pc-save');
    if (savePcBtn) {
        savePcBtn.onclick = async () => {
            await setSecretsMeta(getChatId(), {
                userCharacterName: (document.getElementById('nwst-secret-pc-name')?.value || '').trim(),
                userCharacterAliases: (document.getElementById('nwst-secret-pc-aliases')?.value || '').trim()
            });
            nwstToast('Secrets PC identity saved.', 'success');
        };
    }

    const addAliasBtn = document.getElementById('nwst-alias-add');
    if (addAliasBtn) {
        addAliasBtn.onclick = async () => {
            const canonicalInput = document.getElementById('nwst-alias-canonical');
            const variantsInput = document.getElementById('nwst-alias-variants');
            const canonical = (canonicalInput?.value || '').trim();
            const variantsRaw = (variantsInput?.value || '').trim();
            if (!canonical) {
                nwstToast('Enter a canonical name.', 'warning');
                return;
            }
            const variants = variantsRaw ? variantsRaw.split(',').map(v => v.trim()).filter(Boolean) : [];
            const { addManualAlias } = await import('../data/aliasRegistry.js');
            await addManualAlias(getChatId(), canonical, variants);
            if (canonicalInput) canonicalInput.value = '';
            if (variantsInput) variantsInput.value = '';
            renderAliasList();
            nwstToast(`Alias group "${canonical}" added.`, 'success');
        };
    }

    const resetWeightsBtn = document.getElementById('nwst-setting-resetWeights');
    if (resetWeightsBtn) {
        resetWeightsBtn.onclick = () => {
            const defaults = {
                knowerPresent: 30, unawarePresent: 20, bothPresent: 40, coPresenceOnly: 5, sharedThemeMatch: 5,
                npcCutawayHolder: 35, groupMatch: 25, anchorMatch: 20,
                revealConditionMatch: 35, pressureMatch: 25, continuityRisk: 45,
                priorityLow: -15, priorityNormal: 0, priorityHigh: 20, priorityCritical: 50
            };
            for (const [k, v] of Object.entries(defaults)) setScoringWeight(k, v);
            renderScoringWeights();
    renderAliasList();
            nwstToast('Scoring weights reset to defaults.', 'success');
        };
    }
    wireSelect('nwst-setting-densityMode', (val) => {
        setInjectionSetting('densityMode', val);
        // Rebuild injection immediately so user sees the change take effect
        try {
            import('../inject/promptInjector.js').then(({ updateInjection }) => updateInjection());
        } catch (e) { /* non-fatal */ }
    });
    wireCheckbox('nwst-setting-injectEvents', (checked) => setInjectionSetting('injectEvents', checked));
    wireCheckbox('nwst-setting-injectWorldConditions', (checked) => setInjectionSetting('injectWorldConditions', checked));

    // ── Secret budget tokens ─────────────────────────────────────
    const budgetSlider = document.getElementById('nwst-setting-secretBudget');
    const budgetVal = document.getElementById('nwst-setting-secretBudget-value');
    if (budgetSlider && budgetVal) {
        budgetSlider.addEventListener('input', () => {
            budgetVal.textContent = budgetSlider.value;
            setSecretBudgetTokens(parseInt(budgetSlider.value) || 600);
        });
    }

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
        seasonModeSelect.addEventListener('change', async () => {
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
        addBandBtn.addEventListener('click', async () => {
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
            await saveSeasonConfig(chatId, config);
            renderSeasonBandsList();
        });
    }

    // Save season config button
    const saveSeasonBtn = document.getElementById('nwst-setting-saveSeasonConfig');
    if (saveSeasonBtn) {
        saveSeasonBtn.addEventListener('click', async () => {
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

            await saveSeasonConfig(chatId, config);
            nwstToast('Season configuration saved.', 'success');
        });
    }

    // ── Restore season config to default ───────────────────────────
    const restoreSeasonsBtn = document.getElementById('nwst-setting-restoreDefaultSeasons');
    if (restoreSeasonsBtn) {
        restoreSeasonsBtn.addEventListener('click', async () => {
            const chatId = getChatId();
            if (!chatId) { nwstToast('No active chat.', 'error'); return; }
            const confirmed = await SillyTavern.getContext().callGenericPopup(
                'This will reset season configuration (mode, year length, and season bands) to their defaults. Continue?',
                SillyTavern.getContext().POPUP_TYPE.CONFIRM,
                '',
            );
            if (!confirmed) return;
            const defaults = DEFAULT_SEASON_CONFIG;
            await saveSeasonConfig(chatId, {
                mode: defaults.mode,
                yearLength: defaults.yearLength,
                seasons: defaults.seasons.map(s => ({ ...s }))
            });
            populateSeasonConfigUI();
            nwstToast('Season configuration restored to defaults.', 'success');
        });
    }

    // ── Calendar Configuration ──────────────────────────────────────
    const enableCalToggle = document.getElementById('nwst-setting-enableCalendarConfig');
    if (enableCalToggle) {
        enableCalToggle.addEventListener('change', async () => {
            const chatId = getChatId();
            if (!chatId) return;
            const config = getCalendarConfig(chatId);
            config.enabled = enableCalToggle.checked;
            await saveCalendarConfig(chatId, config);
            populateNagerDateUI();
        });
    }

    const nagerToggle = document.getElementById('nwst-setting-nagerEnabled');
    if (nagerToggle) {
        nagerToggle.addEventListener('change', () => {
            const wrap = document.getElementById('nwst-nager-settings');
            if (wrap) wrap.style.display = nagerToggle.checked ? 'block' : 'none';
        });
    }

    // ── Starting Date (deterministic date engine) ─────────────────────
    const saveEraPinBtn = document.getElementById('nwst-setting-saveEraPin');
    if (saveEraPinBtn) {
        saveEraPinBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const chatId = getChatId();
            if (!chatId) { nwstToast('No active chat.', 'error'); return; }
            const pinInput = document.getElementById('nwst-setting-eraPin');
            const pin = pinInput?.value?.trim() || '';
            await saveEraPin(chatId, pin);
            const cfg = getCalendarConfig(chatId);
            if (pin && cfg.enabled) {
                nwstToast('Era saved — note: a custom calendar is enabled, which uses its own Era name field instead.', 'warning');
                return;
            }
            if (pin) {
                // Information only — applied at the next day advance,
                // timeskip, or warmup via the player-verified era notice.
                nwstToast(`Era saved: ${pin} — applies from the next day advance or warmup.`, 'success');
            } else {
                nwstToast('Era pin cleared — the LLM manages the era label again.', 'info');
            }
        });
    }

    const dmyToggle = document.getElementById('nwst-setting-dateFormatDMY');
    if (dmyToggle) {
        dmyToggle.addEventListener('change', () => {
            setSetting('dateFormatDMY', dmyToggle.checked);
        });
    }

    const leapToggle = document.getElementById('nwst-setting-leapYears');
    if (leapToggle) {
        leapToggle.addEventListener('change', async () => {
            const chatId = getChatId();
            if (!chatId) return;
            const config = getCalendarConfig(chatId);
            if (isLunisolarCalendar(config)) {
                leapToggle.checked = config.leapYears !== false;
                return;
            }
            config.leapYears = leapToggle.checked;
            await saveCalendarConfig(chatId, config);
        });
    }

    const setStartBtn = document.getElementById('nwst-setting-setStartDate');
    if (setStartBtn) {
        setStartBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const chatId = getChatId();
            if (!chatId) { nwstToast('No active chat.', 'error'); return; }

            const existing = getStartDate(chatId);
            if (existing?.locked) { nwstToast('The starting date is locked for this chat.', 'warning'); return; }

            const input = document.getElementById('nwst-setting-startDate');
            const text = input?.value?.trim() || '';
            if (!text) { nwstToast('Enter a date first.', 'warning'); return; }

            const dmy = getSetting('dateFormatDMY') === true;
            const cfgForParse = getCalendarConfig(chatId);
            const parsed = cfgForParse.enabled
                ? (parseDisplayDate(text, cfgForParse) || parseUserDate(text, dmy, cfgForParse))
                : parseUserDate(text, dmy);
            if (!parsed) {
                nwstToast(cfgForParse.enabled
                    ? 'Couldn\u2019t read that date. Use your configured month names (e.g. "Duskmonth 3rd, 312") or numbers (e.g. 13/5/312).'
                    : 'Couldn\u2019t read that date. Accepted formats: 1/1/26, 01/01/2026, January 1st, 2026.', 'error');
                return;
            }

            // Show the parsed interpretation back to the user — this is what
            // makes the day/month ambiguity of slash dates safe to accept.
            const cfg = getCalendarConfig(chatId);
            const names = monthNamesFor(cfg, parsed.year);
            const monthName = names[Math.min(parsed.month - 1, names.length - 1)] || `Month ${parsed.month}`;
            let interpreted = `${monthName} ${parsed.day}${ordinalSuffix(parsed.day)}, ${formatYear(parsed.year)}`;
            if (!cfg.enabled && Array.isArray(cfg.weekDays) && cfg.weekDays.length === 7) {
                const wdIdx = gregorianWeekdayIndex(parsed.year, parsed.month, parsed.day);
                interpreted = `${cfg.weekDays[wdIdx] || ''}, ${interpreted}`;
            }

            // Starting Date can be entered late. It never rewinds the current
            // calendar or narrative state; when a Current Day already exists,
            // elapsedStoryDays is recalculated from Starting Date -> Current Date
            // and duration markers are rebased so existing event ages stay intact.
            const cur = getCurrentDay(chatId);
            // A default dayCount alone does not mean the chat has a canonical
            // Current Day yet. Fresh chats must stay on the direct setup path.
            const hasCurrentDate = typeof cur?.dateDisplay === 'string' && cur.dateDisplay.trim().length > 0;
            const tracking = hasCurrentDate && Number.isInteger(cur.dayCount) && cur.dayCount > 0;
            let currentDateForRebase = null;
            let elapsedForRebase = null;
            if (tracking) {
                currentDateForRebase = parseCurrentCalendarDate(cur.dateDisplay || '', cur.dateSub || '', cfg, dmy);
                if (!currentDateForRebase) {
                    // Last-resort compatibility path for unusual legacy displays:
                    // if the absolute year is still available, rebuild month/day
                    // from the already-migrated cyclical dayCount.
                    const currentYear = extractYearFromText(cur.dateSub || '')
                        ?? extractYearFromText(cur.dateDisplay || '');
                    if (Number.isInteger(currentYear)) {
                        currentDateForRebase = dateFromDayCount(cur.dayCount, currentYear, cfg);
                    }
                }
                if (!currentDateForRebase) {
                    nwstToast('NWST could not identify the current canonical date, so the Starting Date was not locked. Check the Current Day date/year and try again.', 'error');
                    return;
                }

                elapsedForRebase = daysBetweenCalendarDates(parsed, currentDateForRebase, cfg);
                if (!Number.isInteger(elapsedForRebase)) {
                    nwstToast('NWST could not calculate elapsed story days from the current calendar. Nothing was changed.', 'error');
                    return;
                }
                if (elapsedForRebase < 0) {
                    nwstToast('The starting date cannot be later than the current story date. Nothing was changed.', 'error');
                    return;
                }
            }
            const consequence = tracking
                ? 'Your current world state and calendar date will not change. NWST will recalculate elapsed story days from this date to the current displayed date and preserve existing event ages.'
                : 'Warmup will use this as the authoritative starting date instead of inferring one from the roleplay text.';

            const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
            const confirmed = await callGenericPopup(
                `Set the starting date to:<br><br><b>${interpreted}</b><br><br>${consequence}<br><br>This is a one-time entry — once confirmed it locks permanently. Are you sure this date is correct?`,
                POPUP_TYPE.CONFIRM,
                '',
                { okButton: 'Yes, lock it in', cancelButton: 'Cancel' }
            );
            if (!confirmed) return;

            // Preserve legacy anchor metadata for backward compatibility. The
            // anchor's calendar position is also the initial seasonal day count
            // for a fresh chat so Season Configuration is immediately aligned.
            const anchorDayCount = dayOfYearFor(parsed, cfg);
            const anchor = { ...parsed, anchorDayCount, source: 'user', locked: true };
            await saveStartDate(chatId, anchor);

            if (tracking) {
                await rebaseElapsedStoryDays(chatId, elapsedForRebase);
            }

            // dayCount is the current cyclical position in the calendar year,
            // not elapsed duration. Fresh chats start at the Starting Date;
            // already-tracking chats keep their later canonical Current Day.
            const seasonalDate = tracking ? currentDateForRebase : parsed;
            const seasonalDayCount = dayOfYearFor(seasonalDate, cfg);
            const { computeSeason } = await import('../llm/dayAdvancement.js');
            const computedSeason = computeSeason(seasonalDayCount, getSeasonConfig(chatId));
            const seasonalUpdate = { dayCount: seasonalDayCount, dayCountAutoSet: true };
            if (computedSeason) seasonalUpdate.season = computedSeason;
            await updateCurrentDay(chatId, seasonalUpdate);

            populateStartDateUI();
            populateSeasonConfigUI();
            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
            const seasonNote = computedSeason ? ` · ${computedSeason}` : '';
            nwstToast(`Starting date saved: ${interpreted}. Seasonal day count: ${seasonalDayCount}${seasonNote}.`, 'success');
        });
    }

    const calendarSystemSelect = document.getElementById('nwst-setting-calendarSystem');
    if (calendarSystemSelect) {
        calendarSystemSelect.addEventListener('change', async () => {
            const chatId = getChatId();
            if (!chatId) return;
            const previousConfig = getCalendarConfig(chatId);
            const currentDayBeforeChange = getCurrentDay(chatId) || {};
            const previousDate = parseCurrentCalendarDate(
                currentDayBeforeChange.dateDisplay || '', currentDayBeforeChange.dateSub || '', previousConfig,
                getSetting('dateFormatDMY') === true
            );
            const config = getCalendarConfig(chatId);
            config.calendarSystem = calendarSystemSelect.value === 'lunisolar' ? 'lunisolar' : 'standard';
            config.lunisolar = {
                engine: 'east_asian',
                leapMonthLabel: document.getElementById('nwst-setting-lunisolarLeapLabel')?.value?.trim() || config.lunisolar?.leapMonthLabel || 'Intercalary {month}'
            };
            if (config.calendarSystem === 'lunisolar') {
                config.months = 12;
                while (config.monthNames.length < 12) config.monthNames.push(`Month ${config.monthNames.length + 1}`);
                while (config.monthDays.length < 12) config.monthDays.push(30);
                config.monthNames = config.monthNames.slice(0, 12);
                config.monthDays = config.monthDays.slice(0, 12);
            }
            await saveCalendarConfig(chatId, config);
            if (previousDate) {
                const translated = translateDateAcrossCalendarSystems(previousDate, previousConfig, config);
                if (translated) await updateCurrentDay(chatId, { dayCount: dayOfYearFor(translated, config) });
            }
            applyCalendarSystemUIState(config);
            renderCalendarMonthsList();
            populateNagerDateUI();
            validateCalendarTotal();
        });
    }

    const lunisolarLeapLabel = document.getElementById('nwst-setting-lunisolarLeapLabel');
    if (lunisolarLeapLabel) {
        lunisolarLeapLabel.addEventListener('change', async () => {
            const chatId = getChatId();
            if (!chatId) return;
            const config = getCalendarConfig(chatId);
            config.lunisolar = {
                engine: 'east_asian',
                leapMonthLabel: lunisolarLeapLabel.value.trim() || 'Intercalary {month}'
            };
            await saveCalendarConfig(chatId, config);
            renderCalendarMonthsList();
            validateCalendarTotal();
        });
    }

    const monthCountInput = document.getElementById('nwst-setting-monthCount');
    if (monthCountInput) {
        monthCountInput.addEventListener('change', async () => {
            const chatId = getChatId();
            if (!chatId) return;
            const activeConfig = getCalendarConfig(chatId);
            if (isLunisolarCalendar(activeConfig)) {
                monthCountInput.value = 12;
                return;
            }
            const num = parseInt(monthCountInput.value, 10);
            if (num < 1 || num > 24) {
                nwstToast('Month count must be between 1 and 24.', 'warning');
                monthCountInput.value = 12;
                return;
            }
            const config = getCalendarConfig(chatId);
            config.months = num;
            // Extend or trim monthNames/monthDays arrays
            while (config.monthNames.length < num) config.monthNames.push(`Month ${config.monthNames.length + 1}`);
            while (config.monthDays.length < num) config.monthDays.push(30);
            config.monthNames = config.monthNames.slice(0, num);
            config.monthDays = config.monthDays.slice(0, num);
            await saveCalendarConfig(chatId, config);
            renderCalendarMonthsList();
            validateCalendarTotal();
        });
    }

    const addSpecialDayBtn = document.getElementById('nwst-special-day-add');
    if (addSpecialDayBtn) {
        addSpecialDayBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!getChatId()) { nwstToast('No active chat.', 'error'); return; }
            // Open an unsaved draft form — nothing is stored until the
            // draft's own "Save special day" button commits it.
            specialDayDraft = specialDayDraft || {
                id: null, name: '', month: 1, day: 1,
                endMonth: null, endDay: null, category: 'birthday', description: ''
            };
            renderSpecialDaysList();
            document.querySelector('#nwst-special-days-list .nwst-sd-name')?.focus();
        });
    }

    const saveCalBtn = document.getElementById('nwst-setting-saveCalendarConfig');
    if (saveCalBtn) {
        saveCalBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const chatId = getChatId();
            if (!chatId) { nwstToast('No active chat.', 'error'); return; }

            const unnamedSpecialDay = Array.from(document.querySelectorAll('#nwst-special-days-list .nwst-special-day-entry'))
                .find(row => !row.querySelector('.nwst-sd-name')?.value?.trim());
            if (unnamedSpecialDay) {
                nwstToast('Give each special day a name before saving.', 'warning');
                unnamedSpecialDay.querySelector('.nwst-sd-name')?.focus();
                return;
            }

            // Preserve the canonical displayed date while changing calendar systems.
            // The same named/base month + day is translated into the destination
            // year's concrete layout so dayCount does not remain on the old math.
            const oldConfig = getCalendarConfig(chatId);
            const currentBeforeSave = getCurrentDay(chatId) || {};
            const oldCanonicalDate = parseCurrentCalendarDate(
                currentBeforeSave.dateDisplay || '', currentBeforeSave.dateSub || '', oldConfig,
                getSetting('dateFormatDMY') === true
            );

            // Read current values from DOM
            const monthEntries = document.querySelectorAll('#nwst-calendar-months-list .nwst-month-entry');
            const config = getCalendarConfig(chatId);
            config.calendarSystem = document.getElementById('nwst-setting-calendarSystem')?.value === 'lunisolar' ? 'lunisolar' : 'standard';
            config.lunisolar = {
                engine: 'east_asian',
                leapMonthLabel: document.getElementById('nwst-setting-lunisolarLeapLabel')?.value?.trim() || config.lunisolar?.leapMonthLabel || 'Intercalary {month}'
            };
            const preservedMonthDays = Array.isArray(config.monthDays) ? [...config.monthDays] : [];
            config.monthNames = [];
            if (!isLunisolarCalendar(config)) config.monthDays = [];
            monthEntries.forEach(entry => {
                const nameInput = entry.querySelector('.nwst-month-name-input');
                const daysInput = entry.querySelector('.nwst-month-days-input');
                if (nameInput) {
                    config.monthNames.push(nameInput.value.trim() || `Month ${config.monthNames.length + 1}`);
                    if (!isLunisolarCalendar(config)) config.monthDays.push(parseInt(daysInput?.value, 10) || 30);
                }
            });
            if (isLunisolarCalendar(config)) {
                config.months = 12;
                config.monthNames = config.monthNames.slice(0, 12);
                config.monthDays = preservedMonthDays.slice(0, 12);
                while (config.monthDays.length < 12) config.monthDays.push(30);
            } else {
                config.months = config.monthNames.length;
            }

            // Read weekDays from DOM
            const dayEntries = document.querySelectorAll('#nwst-calendar-days-list .nwst-month-entry');
            config.weekDays = [];
            dayEntries.forEach(entry => {
                const nameInput = entry.querySelector('.nwst-weekday-name-input');
                if (nameInput) {
                    config.weekDays.push(nameInput.value.trim() || `Day ${config.weekDays.length + 1}`);
                }
            });

            // Era name for custom calendars (deterministic date engine sub-line)
            const eraInput = document.getElementById('nwst-setting-eraName');
            if (eraInput) config.eraName = eraInput.value.trim();

            // Optional Nager.Date real-world holiday layer. It remains stored
            // on any calendar, but only runs when the active calendar keeps
            // Gregorian month/day structure. Renaming month/weekday labels is
            // explicitly allowed.
            config.nagerDate = readNagerDateConfigFromUI(config.nagerDate);
            if (config.nagerDate.enabled) {
                if (!isNagerDateAvailable(config)) {
                    nwstToast('Nager.Date holidays require Gregorian month lengths (12 months with the standard day counts) and a 7-day week. Renaming months or weekdays is fine.', 'warning');
                } else if (!/^[A-Z]{2}$/.test(config.nagerDate.countryCode)) {
                    nwstToast('Enter a valid 2-letter country code for Nager.Date (for example US, JP, or GB).', 'warning');
                    document.getElementById('nwst-setting-nagerCountry')?.focus();
                    return;
                }
                if (!Array.isArray(config.nagerDate.holidayTypes) || config.nagerDate.holidayTypes.length === 0) {
                    nwstToast('Select at least one Nager.Date holiday type.', 'warning');
                    return;
                }
            }

            // Special days are managed by their own cards (per-card save);
            // config already carries the stored list, so global save keeps
            // them intact without reading the editor DOM.
            await saveCalendarConfig(chatId, config);

            if (oldCanonicalDate) {
                const translated = translateDateAcrossCalendarSystems(oldCanonicalDate, oldConfig, config);
                if (translated) {
                    await updateCurrentDay(chatId, { dayCount: dayOfYearFor(translated, config) });
                }
            }

            let nagerFetchResult = null;
            if (isNagerDateAvailable(config) && config.nagerDate?.enabled) {
                nagerFetchResult = await ensureNagerHolidayCacheForCurrentWindow(chatId);
                if (!nagerFetchResult.ok && nagerFetchResult.failedYears?.length) {
                    nwstToast(`Calendar settings saved, but Nager.Date holiday fetch failed for ${nagerFetchResult.failedYears.join(', ')}. NWST will retry when the story date advances. Check F12 for details.`, 'error');
                }
            }
            // Re-validate and re-populate to ensure consistency
            renderCalendarMonthsList();
            renderCalendarDaysList();
            renderSpecialDaysList();
            populateNagerDateUI();
            validateCalendarTotal();
            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');

            // Surface last-minute special days immediately (in-month / near-term
            // occurrences materialize now rather than waiting for a day advance).
            try {
                const { materializeSpecialDays } = await import('../data/specialDays.js');
                const created = await materializeSpecialDays(chatId);
                if (created > 0) {
                    nwstToast(`Calendar saved — ${created} special day event(s) surfaced in the Events tab.`, 'success');
                    if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('events');
                } else if (nagerFetchResult?.ok !== false) {
                    nwstToast('Calendar configuration saved.', 'success');
                }
            } catch (e) {
                if (nagerFetchResult?.ok !== false) nwstToast('Calendar configuration saved.', 'success');
            }
        });
    }

    // ── Restore calendar config to default ────────────────────────
    const restoreCalBtn = document.getElementById('nwst-setting-restoreDefaultCalendar');
    if (restoreCalBtn) {
        restoreCalBtn.addEventListener('click', async () => {
            const chatId = getChatId();
            if (!chatId) { nwstToast('No active chat.', 'error'); return; }
            const confirmed = await SillyTavern.getContext().callGenericPopup(
                'This will reset calendar configuration (month names, month day counts, week day names) to their defaults. Continue?',
                SillyTavern.getContext().POPUP_TYPE.CONFIRM,
                '',
            );
            if (!confirmed) return;
            const defaults = DEFAULT_CALENDAR_CONFIG;
            await saveCalendarConfig(chatId, {
                enabled: false,
                months: defaults.months,
                monthNames: [...defaults.monthNames],
                monthDays: [...defaults.monthDays],
                weekDays: [...defaults.weekDays],
                calendarSystem: 'standard',
                lunisolar: { ...defaults.lunisolar },
                leapYears: defaults.leapYears !== false
            });
            populateCalendarConfigUI();
            nwstToast('Calendar configuration restored to defaults.', 'success');
        });
    }

    // ── Day Count (update instantly on button click) ──────────────
    const saveDayCountBtn = document.getElementById('nwst-setting-saveDayCount');
    if (saveDayCountBtn) {
        saveDayCountBtn.addEventListener('click', async () => {
            const chatId = getChatId();
            if (!chatId) { nwstToast('No active chat.', 'error'); return; }
            const dayCountInput = document.getElementById('nwst-setting-dayCount');
            if (!dayCountInput) return;
            const newCount = parseInt(dayCountInput.value, 10);
            if (isNaN(newCount) || newCount < 1) {
                nwstToast('Day count must be a positive 1-based calendar day.', 'warning');
                return;
            }
            const current = getCurrentDay(chatId);
            const cfg = getCalendarConfig(chatId);
            const year = extractYearFromText(current?.dateSub || '')
                ?? extractYearFromText(current?.dateDisplay || '')
                ?? 1;
            const maxDay = yearLengthFor(cfg, year);
            if (newCount > maxDay) {
                nwstToast(`Day count must be between 1 and ${maxDay} for the current configured calendar year.`, 'warning');
                return;
            }
            await updateCurrentDay(chatId, { dayCount: newCount });
            nwstToast('Day count updated to ' + newCount + '.', 'success');
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
        importAllBtn.addEventListener('click', async () => {
            triggerFileImport(async (text) => {
                const chatId = getChatId();
                const success = await importAll(chatId, text);
                if (success) {
                    // Imported exports may predate cyclical dayCount / elapsed
                    // duration bookkeeping. Migrate immediately so users do not
                    // need to reload or switch chats before the imported state is
                    // safe to use.
                    const { migrateEventData } = await import('../data/events.js');
                    await migrateEventData(chatId);
                    const { migrateTemporalState } = await import('../data/timeMigration.js');
                    await migrateTemporalState(chatId);
                    populateSettingsUI();
                    if (typeof window?.nwstRefreshTabs === 'function') {
                        window.nwstRefreshTabs('home', 'events', 'world', 'notebook');
                    }
                    nwstToast('Settings and chat data imported successfully. UI refreshed.', 'success');
                } else {
                    nwstToast('Import failed — invalid or corrupt file. Check the console for details.', 'error');
                }
            });
        });
    }

    const exportAllBtn = document.getElementById('nwst-setting-exportAll');
    if (exportAllBtn) {
        exportAllBtn.addEventListener('click', async () => {
            const chatId = getChatId();
            const json = exportAll(chatId);
            if (!json) {
                nwstToast('Export failed — check the console for details.', 'error');
                return;
            }
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

            // Preserve user-authored configuration. Generated severe-weather
            // state/history is narrative state and is intentionally cleared, but
            // the profile definitions and manual overrides survive.
            let preservedSettingProfiles = getSettingContextProfiles(chatId);
            preservedSettingProfiles = {
                activeProfileId: preservedSettingProfiles.activeProfileId || null,
                profiles: Array.isArray(preservedSettingProfiles.profiles) ? preservedSettingProfiles.profiles : []
            };
            const preservedSeasonConfig = getSeasonConfig(chatId);
            const preservedCalendarConfig = getCalendarConfig(chatId);
            const preservedWeatherProfiles = getWeatherProfilesState(chatId);
            preservedWeatherProfiles.profiles = preservedWeatherProfiles.profiles.map(p => ({ ...p, activeSystem: null, history: [] }));

            // Stop the event-driven scanner before clearing so its in-memory
            // cadence does not continue from data that no longer exists.
            let scannerModule = null;
            try {
                scannerModule = await import('../llm/scanner.js');
                scannerModule.stopScanner();
            } catch (error) {
                console.warn('[NWST Settings] Could not stop scanner before Clear All:', error);
            }

            await deleteAllChatData(chatId);

            // Restore user-authored data
            if (preservedSettingProfiles.profiles.length > 0) {
                await saveSettingContextProfiles(chatId, preservedSettingProfiles);
            }
            await saveSeasonConfig(chatId, preservedSeasonConfig);
            await saveCalendarConfig(chatId, preservedCalendarConfig);
            if (preservedWeatherProfiles.profiles.length > 0) {
                await saveWeatherProfilesState(chatId, preservedWeatherProfiles);
            }

            // Restart only after preserved configuration is restored so the
            // chat re-enters warmup from a genuinely clean boundary.
            if (scannerModule && getSetting('enabled') && !getSetting('scanPaused')) {
                scannerModule.startScanner();
            }

            nwstToast('All generated NWST data cleared for this chat. Scanner warmup was reset; Setting Context profiles, Weather Profiles, Season Config, and Calendar Config were preserved.', 'success');
            // Refresh every tab so stale generated content disappears at once.
            if (typeof window.nwstRefreshAllUI === 'function') {
                window.nwstRefreshAllUI();
            } else {
                populateSettingsUI();
            }
        });
    }

    // ── Debug: F12 Console Logging toggle ────────────────────────────────
    const debugLoggingToggle = document.getElementById('nwst-debug-logging-toggle');
    if (debugLoggingToggle) {
        debugLoggingToggle.addEventListener('change', () => {
            setDebugMode(debugLoggingToggle.checked);
            nwstToast(debugLoggingToggle.checked
                ? 'Debug logging enabled. Open the browser console (F12) to watch NWST work.'
                : 'Debug logging disabled.', 'info');
        });
    }

    const debugAdoptDates = document.getElementById('nwst-debug-adopt-dates');
    if (debugAdoptDates) {
        debugAdoptDates.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const chatId = getChatId();
            if (!chatId) { nwstToast('No active chat.', 'error'); return; }

            const cur = getCurrentDay(chatId);
            if (!cur || !Number.isInteger(cur.dayCount) || cur.dayCount <= 0) {
                nwstToast('NWST has no populated Current Day in this chat — run warmup first.', 'warning');
                return;
            }

            const cfg = getCalendarConfig(chatId);
            const existing = getStartDate(chatId);
            const dmy = getSetting('dateFormatDMY') === true;

            // Read the CURRENT canonical date through the same custom-calendar
            // parser used by temporal migration. This supports LLM-written date
            // lines whose month names come from Calendar Config, including
            // configured month names that themselves contain commas.
            let parsed = parseCurrentCalendarDate(cur.dateDisplay || '', cur.dateSub || '', cfg, dmy);
            let derived = false;
            if (!parsed) {
                let year = extractYearFromText(cur.dateSub || '');
                if (year === null) year = extractYearFromText(cur.dateDisplay || '');
                if (year === null) {
                    const { callGenericPopup: popupIn, POPUP_TYPE: PT } = SillyTavern.getContext();
                    const answer = await popupIn(
                        'What year is it currently in the story? (Needed once to place the cyclical day count on the calendar. Numbers only — add "BC" for ancient settings, e.g. "44 BC".)',
                        PT.INPUT, ''
                    );
                    if (!answer || typeof answer !== 'string') { nwstToast('Adoption cancelled — no year provided.', 'info'); return; }
                    const bcIn = /\bBCE?\b/i.test(answer);
                    const num = parseInt(String(answer).replace(/[^\d]/g, ''), 10);
                    if (!Number.isInteger(num) || num === 0) { nwstToast('Couldn’t read that year — adoption cancelled.', 'error'); return; }
                    year = bcIn ? -num : num;
                }
                parsed = dateFromDayCount(cur.dayCount, year, cfg);
                derived = true;
            }

            // Normalize the date without treating cyclical dayCount as an
            // absolute timeline. A zero-day calendar advance preserves the
            // configured weekday already written in a parseable date line.
            const normalizedFromCurrent = advanceCurrentCalendarDate(cur, 0, cfg, dmy);
            const normalized = normalizedFromCurrent || computeDeterministicDate(parsed, cur.dayCount, cur.dayCount, cfg);

            const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
            const confirmed = await callGenericPopup(
                `Adopt computed dates for this chat?<br><br>Current date line: <b>${cur.dateDisplay}</b><br>Will display as: <b>${normalized.dateDisplay}</b>${derived ? '<br><span style="font-size:11px">(derived from the day counter + your Calendar Config — check it looks right before confirming)</span>' : ''}<br><br>The era sub-line ("${cur.dateSub || 'none'}") is not touched. From the next day advancement onward, dates, weekdays, and forecast day labels are computed from the current canonical date and your Calendar Config (LLM fallback if the displayed date cannot be parsed). The cyclical day counter, elapsed story days, events, notebook, and moons do not change.`,
                POPUP_TYPE.CONFIRM,
                '',
                { okButton: 'Adopt', cancelButton: 'Cancel' }
            );
            if (!confirmed) return;

            const record = existing
                ? { ...existing }
                : { ...parsed, source: 'scan', locked: false };
            record.anchorDate = { year: parsed.year, month: parsed.month, day: parsed.day };
            record.anchorDayCount = cur.dayCount;
            await saveStartDate(chatId, record);
            await updateCurrentDay(chatId, { dateDisplay: normalized.dateDisplay });
            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
            populateStartDateUI();
            nwstToast(`Date engine adopted: ${normalized.dateDisplay}`, 'success');
        });
    }

    // ── Debug buttons ─────────────────────────────────────────────────────


    const clearContextSnapshotsBtn = document.getElementById('nwst-debug-clear-context-snapshots');
    if (clearContextSnapshotsBtn) {
        clearContextSnapshotsBtn.addEventListener('click', async () => {
            const list = getContextSnapshots(getChatId());
            if (!list.length) {
                nwstToast('No Context/Profile snapshots to clear.', 'info');
                return;
            }
            const ok = await SillyTavern.getContext().callGenericPopup(
                `Clear all ${list.length} Context/Profile snapshot(s)?<br><br>This does not affect Previous Day snapshots.`,
                SillyTavern.getContext().POPUP_TYPE.CONFIRM,
                ''
            );
            if (!ok) return;
            await clearContextSnapshots(getChatId());
            renderContextSnapshotsList();
            nwstToast('Context/Profile snapshot history cleared.', 'success');
        });
    }

    const debugAssignWeather = document.getElementById('nwst-debug-assign-weather-profile');
    if (debugAssignWeather) {
        debugAssignWeather.addEventListener('click', async () => {
            debugAssignWeather.disabled = true;
            const original = debugAssignWeather.textContent;
            debugAssignWeather.textContent = '⏳ Assigning...';
            try {
                nwstToast('Debug: analyzing active Setting Context...', 'info');
                const chatId = getChatId();
                const beforeState = getWeatherProfilesState(chatId);
                const profile = await analyzeSettingContextToWeatherProfile(chatId, { activate: true, silent: true });
                await recordWeatherProfileChangeSnapshot(beforeState, getWeatherProfilesState(chatId), 'Debug Weather Profile assignment');
                renderWeatherProfileUI();
                nwstToast(`Debug Weather Profile assigned: ${profile.name}`, 'success');
            } catch (err) {
                console.error('[NWST Debug] Weather Profile assignment failed:', err);
                nwstToast(`Weather Profile assignment failed: ${err.message}`, 'error');
            } finally {
                debugAssignWeather.textContent = original;
                debugAssignWeather.disabled = false;
            }
        });
    }

    const debugScanSecrets = document.getElementById('nwst-debug-scan-secrets');
    if (debugScanSecrets) {
        debugScanSecrets.addEventListener('click', async () => {
            debugScanSecrets.textContent = '⏳ Scanning...';
            debugScanSecrets.disabled = true;
            try {
                const { scanForSecrets } = await import('../llm/secretScan.js');
                const chatId = getChatId();
                const count = await scanForSecrets(chatId);
                nwstToast(`Secrets scan complete — ${count} new secret(s) found.`, 'success');
                if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('notebook');
            } catch (err) {
                nwstToast(`Secrets scan failed: ${err.message}`, 'error');
            } finally {
                debugScanSecrets.textContent = '🔍 Scan for secrets';
                debugScanSecrets.disabled = false;
            }
        });
    }

    const debugScanCommunities = document.getElementById('nwst-debug-scan-communities');
    if (debugScanCommunities) {
        debugScanCommunities.addEventListener('click', async () => {
            debugScanCommunities.textContent = '⏳ Scanning...';
            debugScanCommunities.disabled = true;
            try {
                const { synthesizeCommunities } = await import('../llm/scanner.js');
                const chatId = getChatId();
                const ctx = SillyTavern.getContext();
                const messages = (ctx.chat || []).filter(m => !(m.is_system && m.extra?.hidden) && m.extra?.display !== 'none');
                await synthesizeCommunities(chatId, messages);
                nwstToast('Community scan complete.', 'success');
                if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('world');
            } catch (err) {
                nwstToast(`Community scan failed: ${err.message}`, 'error');
            } finally {
                debugScanCommunities.textContent = '👥 Scan for communities';
                debugScanCommunities.disabled = false;
            }
        });
    }

    const debugScanWorldState = document.getElementById('nwst-debug-scan-worldstate');
    if (debugScanWorldState) {
        debugScanWorldState.addEventListener('click', async () => {
            debugScanWorldState.textContent = '⏳ Scanning...';
            debugScanWorldState.disabled = true;
            try {
                const { runScan } = await import('../llm/scanner.js');
                await runScan();
                nwstToast('World state scan complete.', 'success');
                if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'world', 'notebook');
            } catch (err) {
                nwstToast(`World state scan failed: ${err.message}`, 'error');
            } finally {
                debugScanWorldState.textContent = '🌍 Scan world state';
                debugScanWorldState.disabled = false;
            }
        });
    }

    // ── Debug: Secrets Scoring Report ───────────────────────────────
    const debugSecretsReport = document.getElementById('nwst-debug-secrets-report');
    if (debugSecretsReport) {
        debugSecretsReport.addEventListener('click', async () => {
            try {
                const { buildSecretsDebugReport } = await import('../llm/secretsDebug.js');
                const report = buildSecretsDebugReport(getChatId());
                const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
                await callGenericPopup(
                    `<pre style="text-align:left;white-space:pre-wrap;font-size:12px;max-height:70vh;overflow:auto">${report.replace(/</g,'&lt;')}</pre>`,
                    POPUP_TYPE.TEXT, '', { wide: true, large: true }
                );
            } catch (err) {
                nwstToast(`Secrets report failed: ${err.message}`, 'error');
            }
        });
    }

    // ── Debug: Run Secrets Sidecar Now ──────────────────────────────
    const debugRunSidecar = document.getElementById('nwst-debug-run-sidecar');
    if (debugRunSidecar) {
        debugRunSidecar.addEventListener('click', async () => {
            debugRunSidecar.textContent = '⏳ Analyzing...';
            debugRunSidecar.disabled = true;
            try {
                const { runSecretsSidecar } = await import('../llm/secretsSidecar.js');
                const result = await runSecretsSidecar();
                if (result) {
                    nwstToast('Sidecar analysis complete. View the scoring report to see results.', 'success');
                } else {
                    nwstToast('Sidecar did not run — check that a Secrets Sidecar profile is set and secrets exist.', 'warning');
                }
            } catch (err) {
                nwstToast(`Sidecar failed: ${err.message}`, 'error');
            } finally {
                debugRunSidecar.textContent = '🔬 Run sidecar now';
                debugRunSidecar.disabled = false;
            }
        });
    }

    // ── Debug: Consistency Scan on visible messages ─────────────────
    const debugConsistencyScan = document.getElementById('nwst-debug-consistency-scan');
    if (debugConsistencyScan) {
        debugConsistencyScan.addEventListener('click', async () => {
            debugConsistencyScan.textContent = '⏳ Scanning...';
            debugConsistencyScan.disabled = true;
            try {
                const { runVisibleConsistencyScan } = await import('../llm/narrativeConsistency.js');
                await runVisibleConsistencyScan();
            } catch (err) {
                nwstToast(`Consistency scan failed: ${err.message}`, 'error');
            } finally {
                debugConsistencyScan.textContent = '🩺 Consistency scan (visible)';
                debugConsistencyScan.disabled = false;
            }
        });
    }

    // ── Debug: Generate Missing Anchors (backfill) ──────────────────
    const debugBackfillAnchors = document.getElementById('nwst-debug-backfill-anchors');
    if (debugBackfillAnchors) {
        debugBackfillAnchors.addEventListener('click', async () => {
            debugBackfillAnchors.textContent = '⏳ Generating...';
            debugBackfillAnchors.disabled = true;
            try {
                const { backfillSecretAnchors } = await import('../llm/secretsAnchorBackfill.js');
                const r = await backfillSecretAnchors(getChatId());
                nwstToast(`Anchors generated: ${r.filled} filled, ${r.skipped} already had anchors, ${r.failed} failed.`,
                    r.failed > 0 ? 'warning' : 'success');
                // Refresh the notebook so new anchors show in the secret fields
                if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('notebook');
            } catch (err) {
                nwstToast(`Anchor generation failed: ${err.message}`, 'error');
            } finally {
                debugBackfillAnchors.textContent = '🏷️ Generate missing anchors';
                debugBackfillAnchors.disabled = false;
            }
        });
    }

    // ── Debug: Review Event Participants ────────────────────────────
    const debugReviewParticipants = document.getElementById('nwst-debug-review-participants');
    if (debugReviewParticipants) {
        debugReviewParticipants.addEventListener('click', async () => {
            const chatId = getChatId();
            if (!chatId) {
                nwstToast('No active chat.', 'error');
                return;
            }

            debugReviewParticipants.textContent = '⏳ Reviewing...';
            debugReviewParticipants.disabled = true;

            try {
                const { reviewEventParticipants } = await import('../llm/batchScan.js');
                const result = await reviewEventParticipants(chatId);

                if (result.updated > 0) {
                    nwstToast(`Added participants to ${result.updated} event(s).`, 'success');
                } else if (result.reviewed > 0) {
                    nwstToast('All events already have participants.', 'info');
                } else {
                    nwstToast('No events found to review.', 'info');
                }
            } catch (err) {
                console.error('[NWST Settings] Participant review failed:', err);
                nwstToast(`Participant review failed: ${err.message}`, 'error');
            } finally {
                debugReviewParticipants.textContent = '🔎 Review event participants';
                debugReviewParticipants.disabled = false;
            }
        });
    }

    // ── Debug: Adjust Secret Priority ──────────────────────────────
    const debugApplyPriority = document.getElementById('nwst-debug-apply-priority');
    if (debugApplyPriority) {
        debugApplyPriority.addEventListener('click', async () => {
            const targetSelect = document.getElementById('nwst-debug-priority-target');
            if (!targetSelect) return;
            const priority = targetSelect.value;
            const label = targetSelect.options[targetSelect.selectedIndex]?.text || priority;

            const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
            const confirm = await callGenericPopup(
                `Set ALL secrets to <b>${label}</b>?<br><br><span style="font-size:11px;color:#999">This will override the injection priority of every secret in the current chat. This cannot be undone manually — you would need to reselect each secret's priority individually.</span>`,
                POPUP_TYPE.CONFIRM,
                '',
                { okButton: 'Apply', cancelButton: 'Cancel' }
            );
            if (!confirm) return;

            const chatId = getChatId();
            const { getAllSecrets, updateSecret } = await import('../data/notebook.js');
            const allSecrets = getAllSecrets(chatId);
            if (!allSecrets || allSecrets.length === 0) {
                nwstToast('No secrets found to update.', 'warning');
                return;
            }

            let count = 0;
            for (const secret of allSecrets) {
                await updateSecret(chatId, secret.id, { injectionPriority: priority });
                count++;
            }

            nwstToast(`Updated ${count} secret(s) to ${label}.`, 'success');
            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('notebook');
        });
    }

    // ── Debug: AI Auto-Adjust Secret Priority ───────────────────────
    const debugAutoPriority = document.getElementById('nwst-debug-auto-priority');
    if (debugAutoPriority) {
        debugAutoPriority.addEventListener('click', async () => {
            const chatId = getChatId();
            if (!chatId) {
                nwstToast('No active chat.', 'warning');
                return;
            }

            // Dynamic imports
            const { getAllSecrets, updateSecret } = await import('../data/notebook.js');
            const { resolveProfile, generateWithProfile } = await import('../llm/connections.js');
            const { LLM_TOKEN_BUDGETS } = await import('../llm/tokenBudgets.js');
            const secrets = getAllSecrets(chatId);
            if (!secrets || secrets.length === 0) {
                nwstToast('No secrets found to evaluate.', 'warning');
                return;
            }

            // Resolve the Planning LLM profile
            const profile = resolveProfile('planningLLM');
            if (!profile) {
                nwstToast(
                    'Cannot auto-adjust priorities: No Planning LLM profile configured. ' +
                    'Set one in Settings → Connection Profiles.',
                    'warning'
                );
                return;
            }

            const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
            const confirm = await callGenericPopup(
                `Use the AI to evaluate <b>${secrets.length}</b> secret(s) and reassign their injection priorities?` +
                `<br><br>` +
                `<span style="font-size:11px;color:#999">The Planning LLM will analyze each secret's title, description, whoKnows/whoDoesNotKnow lists,` +
                ` and current priority, then assign <b>high</b> (always inject), <b>normal</b> (inject when at risk), or <b>low</b> (monitor only) based on` +
                ` narrative urgency and context. This will use API credits.</span>`,
                POPUP_TYPE.CONFIRM,
                '',
                { okButton: 'Run Auto-Adjust', cancelButton: 'Cancel' }
            );
            if (!confirm) return;
            if (getChatId() !== chatId) {
                dlog('[NWST AutoPriority] Active chat changed before auto-adjust started; cancelled stale operation.');
                return;
            }

            nwstToast(`Evaluating ${secrets.length} secret(s) with Planning LLM...`, 'info');

            // Build the priority system guide
            const priorityGuide = [
                'INJECTION PRIORITY SYSTEM:',
                '  high   — Always inject the secret into the prompt whenever a whoKnows character is present.',
                '           Use for critical, time-sensitive secrets with major consequences if revealed.',
                '  normal — Inject only when a whoDoesNotKnow character is ALSO present (active risk).',
                '           Use for standard secrets that are relevant but not immediately critical.',
                '  low    — Never inject into the main prompt; consistency monitor only.',
                '           Use for minor, background, or resolved secrets that don\'t need active tracking.'
            ].join('\n');

            // Format each secret for the prompt
            const secretList = secrets.map((s, i) => {
                const fields = [
                    `[${i + 1}] ID: ${s.id}`,
                    `    Title: ${s.title || '(untitled)'}`,
                    `    Type: ${s.type || 'unknown'}`,
                    `    Description: ${(s.secret || '').substring(0, 300)}`,
                    `    whoKnows: ${(s.whoKnows || []).join(', ') || '(none)'}`,
                    `    whoDoesNotKnow: ${(s.whoDoesNotKnow || []).join(', ') || '(none)'}`,
                    `    Current Priority: ${s.injectionPriority || 'normal'}`
                ];
                return fields.join('\n');
            }).join('\n\n');

            const systemMessage = {
                role: 'system',
                content: `You are a narrative analysis assistant for an RPG world state tracker. Your task is to evaluate secrets and assign appropriate injection priorities based on narrative urgency and dramatic potential.

${priorityGuide}

Respond with ONLY a valid JSON object in the following format, no other text:
{
  "secrets": [
    {
      "id": "secret-id-here",
      "injectionPriority": "critical|high|normal|low",
      "reasoning": "Brief explanation for this assignment"
    }
  ]
}

Analyze each secret carefully. Consider:
- Would omission likely cause a continuity/knowledge-boundary break? → critical
- Is the secret time-sensitive, hot, or approaching reveal? → high
- Does the secret have active narrative pressure? → normal
- Is the secret distant, background, or no longer active? → low
- WhoKnows and WhoDoesNotKnow lists matter, but prose relevance and cutaways matter too`
            };

            const userMessage = {
                role: 'user',
                content: `Evaluate the following ${secrets.length} secret(s) and assign appropriate injection priorities:\n\n${secretList}`
            };

            try {
                const response = await generateWithProfile(profile, [systemMessage, userMessage], { maxTokens: LLM_TOKEN_BUDGETS.MEDIUM });
                if (getChatId() !== chatId) {
                    dlog('[NWST AutoPriority] Active chat changed during auto-adjust; discarded stale result.');
                    return;
                }
                if (!response) {
                    nwstToast('AI Auto-Adjust failed — LLM returned empty response.', 'error');
                    return;
                }

                // Parse JSON from response
                let parsed;
                try {
                    // Try direct parse first
                    parsed = JSON.parse(response);
                } catch {
                    // Fall back: extract JSON block from markdown
                    const jsonMatch = response.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        try {
                            parsed = JSON.parse(jsonMatch[0]);
                        } catch {
                            nwstToast('AI Auto-Adjust failed — could not parse LLM response as JSON.', 'error');
                            console.error('[NWST AutoPriority] Failed to parse:', response);
                            return;
                        }
                    } else {
                        nwstToast('AI Auto-Adjust failed — could not parse LLM response as JSON.', 'error');
                        console.error('[NWST AutoPriority] No JSON found in:', response);
                        return;
                    }
                }

                if (!parsed?.secrets || !Array.isArray(parsed.secrets)) {
                    nwstToast('AI Auto-Adjust failed — response missing "secrets" array.', 'error');
                    console.error('[NWST AutoPriority] Unexpected structure:', parsed);
                    return;
                }

                // Apply the updates
                let updated = 0;
                let skipped = 0;
                for (const entry of parsed.secrets) {
                    if (!entry.id || !entry.injectionPriority) {
                        skipped++;
                        continue;
                    }
                    const valid = ['critical', 'high', 'normal', 'low'];
                    if (!valid.includes(entry.injectionPriority)) {
                        skipped++;
                        continue;
                    }
                    const secret = secrets.find(s => s.id === entry.id);
                    if (!secret) {
                        skipped++;
                        continue;
                    }
                    // Only update if the priority actually changed
                    if (secret.injectionPriority === entry.injectionPriority) {
                        skipped++;
                        continue;
                    }
                    if (getChatId() !== chatId) {
                        dlog('[NWST AutoPriority] Active chat changed while applying priorities; stopped stale updates.');
                        return;
                    }
                    await updateSecret(chatId, entry.id, { injectionPriority: entry.injectionPriority });
                    updated++;
                }

                if (getChatId() !== chatId) return;
                nwstToast(`AI Auto-Adjust complete: ${updated} updated, ${skipped} skipped.`, updated > 0 ? 'success' : 'info');
                if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('notebook');
            } catch (err) {
                console.error('[NWST AutoPriority] Error during auto-adjust:', err);
                nwstToast('AI Auto-Adjust failed with an unexpected error. Check console.', 'error');
            }
        });
    }

    // ── Debug: Set Day Count from M/D input ─────────────────────────
    // User types "1/12" or "5/31" → computes day-of-year from calendar config's monthDays → saves immediately
    const debugDetectDayCount = document.getElementById('nwst-debug-detect-daycount');
    const debugInput = document.getElementById('nwst-debug-daycount-input');
    if (debugDetectDayCount && debugInput) {
        // Also trigger on Enter key in the input field
        debugInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') debugDetectDayCount.click();
        });

        debugDetectDayCount.addEventListener('click', async () => {
            const chatId = getChatId();
            if (!chatId) {
                nwstToast('No active chat.', 'warning');
                return;
            }

            const raw = debugInput.value.trim();
            if (!raw) {
                nwstToast('Please type a date in M/D format (e.g. 1/12 or 5/31).', 'warning');
                return;
            }

            // Parse "M/D" → [configured month index, day]. This debug tool
            // follows the active Calendar Config rather than assuming 12 months.
            const parts = raw.split('/');
            if (parts.length !== 2) {
                nwstToast('Invalid format. Use M/D (e.g. 1/12 or 5/31).', 'warning');
                return;
            }

            const month = parseInt(parts[0], 10);
            const day = parseInt(parts[1], 10);
            const calendarConfig = getCalendarConfig(chatId);
            const currentDay = getCurrentDay(chatId);
            const parsedCurrent = parseCurrentCalendarDate(
                currentDay?.dateDisplay || '', currentDay?.dateSub || '', calendarConfig,
                getSetting('dateFormatDMY') === true
            );
            const year = parsedCurrent?.year
                ?? extractYearFromText(currentDay?.dateSub || '')
                ?? extractYearFromText(currentDay?.dateDisplay || '')
                ?? 1;
            const monthDays = monthLengthsFor(calendarConfig, year);

            if (isNaN(month) || isNaN(day) || month < 1 || month > monthDays.length || day < 1) {
                nwstToast(`Invalid date. Month must be 1–${monthDays.length} and day must be a positive number.`, 'warning');
                return;
            }

            const maxDay = monthDays[month - 1];
            if (!maxDay || day > maxDay) {
                nwstToast(`Month ${month} has only ${maxDay || '?'} days. Day ${day} is out of range.`, 'warning');
                return;
            }

            const dayOfYear = dayOfYearFor({ year, month, day }, calendarConfig);

            // Save immediately
            await updateCurrentDay(chatId, { ...currentDay, dayCount: dayOfYear, dayCountAutoSet: true });

            // Clear input for next use
            debugInput.value = '';

            // Provide season feedback
            const { computeSeason } = await import('../llm/dayAdvancement.js');
            const seasonConfig = getSeasonConfig(chatId);
            const computedSeason = computeSeason(dayOfYear, seasonConfig);
            if (computedSeason) {
                nwstToast(`Day count set to ${dayOfYear} (Month ${month}, Day ${day}). Season: ${computedSeason}.`, 'success');
            } else {
                nwstToast(`Day count set to ${dayOfYear} (Month ${month}, Day ${day}).`, 'success');
            }

            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
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
            await callback(text);
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
