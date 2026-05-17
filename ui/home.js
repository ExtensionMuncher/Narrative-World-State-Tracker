/* eslint-disable */
// =============================================================================
// NWST Home Tab UI — ui/home.js
// =============================================================================
// Builds and manages the Home tab pane. All layout and styling matches
// nwst-mockup.html exactly.
//
// Sections:
//   1. Extension header — Enable toggle + Pause/Resume button
//   2. Day navigation — Prev/Next buttons, inline-editable date fields
//   3. Time skip input + Jump button
//   4. Current Day journal block — view/editor with Save/Cancel/⛶
//   5. 7-Day Forecast strip with temperature and precipitation
//   6. Moon Phase strip
//   7. Upcoming Events digest (read-only, links to Events tab)
// =============================================================================

import {
    getChatId,
    nwstToast,
    getSetting,
    updateStatusLabel,
    updatePauseButton
} from '../index.js';

import { isEnabled, setEnabled, isPaused, setPaused } from '../settings.js';
import {
    getCurrentDay,
    updateCurrentDay,
    getForecast,
    getMoonPhases,
    replaceCurrentDay,
    replaceMoonPhases
} from '../data/worldState.js';
import { getEventsGroupedByTier } from '../data/events.js';
import { advanceToNextDay, restorePreviousDay, regenerateForecast, regenerateForecastOnly, regenerateMoonPhasesOnly, regenerateMoonPhasesFromDate, setMoonPhaseAnchor, computeLunarAngleFromDate, getLunarAngle, setLunarAngle, getDegreesPerDay, generateMoonPhases, getMoonPhenomena, getMoonPhaseNames, getMoonPhaseForAngle } from '../llm/dayAdvancement.js';
import { executeTimeSkip } from '../llm/timeskip.js';
import { synthesizeCurrentDay } from '../llm/currentDaySynth.js';

// ── Build the Home tab HTML ───────────────────────────────────────────────

/**
 * Build the complete Home tab HTML and inject it into the home pane.
 * Called when the extension initializes.
 */
export function buildHomeTab() {
    const pane = document.getElementById('nwst-pane-home');
    if (!pane) {
        console.error('[NWST Home UI] Home pane not found.');
        return;
    }

    pane.innerHTML = `
        <!-- ── Day Navigation Bar ──────────────────────────────── -->
        <div class="nwst-day-nav">
            <button class="nwst-day-nav-btn" id="nwst-prev-day-btn" title="Previous day">‹</button>
            <div class="nwst-day-label">
                <div class="nwst-date-main" id="nwst-date-display" contenteditable="true" title="Click to edit"
                    style="cursor:text;border-radius:4px;padding:1px 4px;outline:none;">—</div>
                <div class="nwst-date-sub" id="nwst-date-sub" contenteditable="true" title="Click to edit"
                    style="cursor:text;border-radius:4px;padding:1px 4px;outline:none;">—</div>
            </div>
            <button class="nwst-day-nav-btn" id="nwst-next-day-btn" title="Next day">›</button>
        </div>

        <!-- ── Time Skip ───────────────────────────────────────── -->
        <div style="margin-bottom:14px">
            <div class="nwst-lbl">Time skip</div>
            <div class="nwst-jump-wrap">
                <input type="text" id="nwst-timeskip-input" placeholder="e.g. Three weeks later, end of harvest season…" style="flex:1">
                <button class="menu_button nwst-btn-regen" id="nwst-timeskip-jump">Jump →</button>
            </div>
        </div>

        <div class="nwst-div"></div>

        <!-- ── Current Day Journal Block ───────────────────────── -->
        <div class="nwst-journal-block" style="margin-bottom:10px">
            <div class="nwst-journal-hdr">
                <div class="nwst-journal-hdr-title">📅 Current Day</div>
                <div class="nwst-btn-row">
                    <button class="menu_button nwst-icon-btn" id="nwst-currentday-edit-btn" title="Edit">✎</button>
                </div>
            </div>
            <!-- View mode -->
            <div class="nwst-journal-body" id="nwst-currentday-view">
                <div class="nwst-md" id="nwst-currentday-content">
                    <div class="nwst-nb-empty">No Current Day data yet. Run a batch scan or advance the day to generate content.</div>
                </div>
            </div>
            <!-- Edit mode (hidden by default) -->
            <div class="nwst-journal-body nwst-editing" id="nwst-currentday-edit" style="display:none">
                <textarea id="nwst-currentday-textarea" rows="7"
                    placeholder="Season: ...&#10;Weather today: ...&#10;Flora: ...&#10;Fauna: ...&#10;Spiritual Climate: ..."></textarea>
                <div class="nwst-btn-row" style="padding:8px 12px;border-top:0.5px solid var(--SmartThemeBorderColor, #eee)">
                    <button class="menu_button nwst-btn" id="nwst-currentday-save">Save</button>
                    <button class="menu_button nwst-btn" id="nwst-currentday-cancel">Cancel</button>
                    <button class="editor_maximize nwst-expand-btn" style="margin-left:4px;font-size:14px;color:#aaa"
                        id="nwst-currentday-popout" data-for="nwst-currentday-textarea" title="Open in popout">⛶</button>
                </div>
            </div>
        </div>

        <!-- ── 7-Day Forecast Strip ────────────────────────────── -->
        <div class="nwst-journal-block" style="margin-bottom:10px">
            <div class="nwst-journal-hdr">
                <div class="nwst-journal-hdr-title">🌤 7-Day Forecast</div>
                <div class="nwst-btn-row">
                    <button class="menu_button nwst-btn-regen" id="nwst-forecast-regen" style="font-size:11px;padding:3px 9px">↺ Regen</button>
                </div>
            </div>
            <div class="nwst-journal-body">
                <div class="nwst-weather-strip" id="nwst-forecast-strip">
                    <div class="nwst-nb-empty">No forecast data yet.</div>
                </div>

                <!-- Moon phase strip -->
                <div style="font-size:10px;font-weight:500;color:#999;letter-spacing:.04em;text-transform:uppercase;margin:10px 0 5px">Moon phases</div>
                <div class="nwst-moon-strip" id="nwst-moon-strip">
                    <div class="nwst-nb-empty">No moon phase data yet.</div>
                </div>
            </div>
        </div>

        <!-- ── Upcoming Events Digest ──────────────────────────── -->
        <div class="nwst-journal-block">
            <div class="nwst-journal-hdr">
                <div class="nwst-journal-hdr-title">📋 Upcoming Events</div>
                <button class="menu_button nwst-btn" id="nwst-events-manage-btn" style="font-size:11px;padding:3px 9px">Manage →</button>
            </div>
            <div class="nwst-journal-body">
                <div class="nwst-md" id="nwst-events-digest">
                    <div class="nwst-nb-empty">No upcoming events.</div>
                </div>
            </div>
        </div>
    `;

    // Wire events and populate with current data
    wireHomeEvents();
    refreshHomeUI();
}

// ── Wire all Home tab UI events ───────────────────────────────────────────

function wireHomeEvents() {
    // ── Previous Day ───────────────────────────────────────────
    const prevDayBtn = document.getElementById('nwst-prev-day-btn');
    if (prevDayBtn) {
        prevDayBtn.addEventListener('click', async () => {
            await restorePreviousDay();
            refreshHomeUI();
        });
    }

    // ── Next Day ───────────────────────────────────────────────
    const nextDayBtn = document.getElementById('nwst-next-day-btn');
    if (nextDayBtn) {
        nextDayBtn.addEventListener('click', async () => {
            await advanceToNextDay();
            refreshHomeUI();
        });
    }

    // ── Date display edits (inline contenteditable) ────────────
    // Manual edits to date fields do NOT trigger any API call — they just update the stored data
    const dateDisplay = document.getElementById('nwst-date-display');
    if (dateDisplay) {
        dateDisplay.addEventListener('blur', () => {
            const chatId = getChatId();
            updateCurrentDay(chatId, { dateDisplay: dateDisplay.textContent.trim() });
        });
    }
    const dateSub = document.getElementById('nwst-date-sub');
    if (dateSub) {
        dateSub.addEventListener('blur', () => {
            const chatId = getChatId();
            updateCurrentDay(chatId, { dateSub: dateSub.textContent.trim() });
        });
    }

    // ── Time skip Jump button ──────────────────────────────────
    const jumpBtn = document.getElementById('nwst-timeskip-jump');
    if (jumpBtn) {
        jumpBtn.addEventListener('click', async () => {
            const input = document.getElementById('nwst-timeskip-input');
            const skipDesc = input ? input.value.trim() : '';
            if (!skipDesc) {
                nwstToast('Enter a description of the time skip first.', 'warning');
                return;
            }
            await executeTimeSkip(skipDesc);
            refreshHomeUI();
        });
    }

    // ── Current Day edit toggle ────────────────────────────────
    const editBtn = document.getElementById('nwst-currentday-edit-btn');
    if (editBtn) {
        editBtn.addEventListener('click', () => {
            toggleCurrentDayEdit(true);
        });
    }

    // ── Current Day Save ───────────────────────────────────────
    const saveBtn = document.getElementById('nwst-currentday-save');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveCurrentDayEdit);
    }

    // ── Current Day Cancel ─────────────────────────────────────
    const cancelBtn = document.getElementById('nwst-currentday-cancel');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => toggleCurrentDayEdit(false));
    }

    // ── Forecast Regen button with popup ───────────────────────
    const forecastRegen = document.getElementById('nwst-forecast-regen');
    if (forecastRegen) {
        forecastRegen.addEventListener('click', async () => {
            const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
            const phaseNames = getMoonPhaseNames();

            const html = `
                <div style="padding:10px;min-width:320px">
                    <p style="margin-bottom:14px;font-size:13px">What would you like to regenerate?</p>

                    <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Scope</div>
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;font-size:13px;padding:4px 6px;border-radius:4px;background:var(--dark1,rgba(0,0,0,0.04))">
                        <input type="radio" name="nwst-regen-scope" value="all" checked
                            onchange="window._nwstRegenScope=this.value" style="margin:0;flex-shrink:0">
                        <span>Both (Weather + Moon Phases)</span>
                    </label>
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;font-size:13px;padding:4px 6px;border-radius:4px;background:var(--dark1,rgba(0,0,0,0.04))">
                        <input type="radio" name="nwst-regen-scope" value="forecast"
                            onchange="window._nwstRegenScope=this.value" style="margin:0;flex-shrink:0">
                        <span>Weather Only</span>
                    </label>
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;font-size:13px;padding:4px 6px;border-radius:4px;background:var(--dark1,rgba(0,0,0,0.04))">
                        <input type="radio" name="nwst-regen-scope" value="moonPhases"
                            onchange="window._nwstRegenScope=this.value" style="margin:0;flex-shrink:0">
                        <span>Moon Phases Only</span>
                    </label>

                    <div style="border-top:1px solid var(--SmartThemeBorderColor,#eee);margin-top:10px;padding-top:10px">
                        <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Moon phase source</div>
                        <div style="font-size:11px;color:#999;margin-bottom:8px;line-height:1.4">Determines how the starting phase is chosen. Only applies when Moon Phases or Both is selected.</div>

                        <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;font-size:13px;padding:4px 6px;border-radius:4px;background:var(--dark1,rgba(0,0,0,0.04))">
                            <input type="radio" name="nwst-regen-source" value="stored" checked
                                onchange="window._nwstRegenSource=this.value" style="margin:0;flex-shrink:0">
                            <span>Use stored angle</span>
                        </label>
                        <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;font-size:13px;padding:4px 6px;border-radius:4px;background:var(--dark1,rgba(0,0,0,0.04))">
                            <input type="radio" name="nwst-regen-source" value="date"
                                onchange="window._nwstRegenSource=this.value" style="margin:0;flex-shrink:0">
                            <span>Recalculate from date text</span>
                        </label>
                        <div style="padding-left:26px;margin-bottom:8px">
                            <input type="text" id="nwst-regen-date-input" placeholder="e.g. Day 7, Full Moon, 11/7/1125, Seventh Day of the Waxing Moon"
                                style="width:100%;padding:5px 7px;font-size:12px;border:1px solid var(--SmartThemeBorderColor,#ccc);border-radius:4px;background:var(--dark2,rgba(0,0,0,0.06));color:inherit;box-sizing:border-box"
                                oninput="window._nwstRegenDateText=this.value">
                            <div style="font-size:10px;color:#999;margin-top:3px;line-height:1.3">Type a phase name, day number, or date. Uses semantic parsing — "Day 7" → First Quarter, "Full Moon" → 180°.</div>
                        </div>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;padding:4px 6px;border-radius:4px;background:var(--dark1,rgba(0,0,0,0.04))">
                            <input type="radio" name="nwst-regen-source" value="manual"
                                onchange="window._nwstRegenSource=this.value;window._nwstRegenPhase=document.getElementById('nwst-regen-phase-select').value" style="margin:0;flex-shrink:0">
                            <span style="white-space:nowrap">Set to specific phase:</span>
                            <select id="nwst-regen-phase-select" style="flex:1;min-width:80px"
                                onchange="window._nwstRegenPhase=this.value">
                                ${phaseNames.map(p => `<option value="${p}">${p}</option>`).join('')}
                            </select>
                        </label>
                    </div>
                </div>
            `;

            // Set defaults
            window._nwstRegenScope = 'all';
            window._nwstRegenSource = 'stored';
            window._nwstRegenPhase = phaseNames[0] || 'New Moon';

            const result = await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                okButton: 'Regenerate',
                cancelButton: 'Cancel',
            });

            if (result) {
                const scope = window._nwstRegenScope || 'all';
                const source = window._nwstRegenSource || 'stored';
                const chatId = getChatId();

                // Helper: regenerate moon phases based on selected source
                const doMoonPhaseRegen = () => {
                    if (source === 'date') {
                        // Read from the text input the user typed — avoids ambiguous
                        // automatic parsing of the existing date display text
                        const userText = window._nwstRegenDateText || '';
                        if (userText) {
                            regenerateMoonPhasesFromDate(chatId, userText);
                        } else {
                            nwstToast('No date text entered. Using stored angle.', 'warning');
                            const storedAngle = getLunarAngle(chatId);
                            const newMoonPhases = generateMoonPhases(storedAngle, 7, 0);
                            replaceMoonPhases(chatId, newMoonPhases);
                        }
                    } else if (source === 'manual') {
                        const selectedPhase = window._nwstRegenPhase || phaseNames[0];
                        setMoonPhaseAnchor(chatId, selectedPhase);
                        nwstToast(`Moon phase set to "${selectedPhase}".`, 'success');
                    } else {
                        // 'stored' — use the direct stored angle without date parsing
                        const storedAngle = getLunarAngle(chatId);
                        const newMoonPhases = generateMoonPhases(storedAngle, 7, 0);
                        replaceMoonPhases(chatId, newMoonPhases);
                    }
                };

                if (scope === 'forecast') {
                    await regenerateForecastOnly();
                } else if (scope === 'moonPhases') {
                    doMoonPhaseRegen();
                } else {
                    // 'all' — regen moon phases first, then weather
                    doMoonPhaseRegen();
                    await regenerateForecastOnly();
                }
                refreshHomeUI();
            }
        });
    }

    // ── Manage Events button (switches to Events tab) ──────────
    const manageBtn = document.getElementById('nwst-events-manage-btn');
    if (manageBtn) {
        manageBtn.addEventListener('click', () => {
            // Simulate clicking the Events tab
            const eventsTab = document.querySelector('.nwst-tab[data-nwst-tab="events"]');
            if (eventsTab) eventsTab.click();
        });
    }
}

// ── Current Day edit mode toggling ────────────────────────────────────────

function toggleCurrentDayEdit(showEdit) {
    const viewEl = document.getElementById('nwst-currentday-view');
    const editEl = document.getElementById('nwst-currentday-edit');
    if (!viewEl || !editEl) return;

    if (showEdit) {
        // Populate textarea with current Current Day data
        const chatId = getChatId();
        const day = getCurrentDay(chatId);
        const textarea = document.getElementById('nwst-currentday-textarea');
        if (textarea) {
            textarea.value = formatCurrentDayForEdit(day);
        }
        viewEl.style.display = 'none';
        editEl.style.display = 'block';
    } else {
        viewEl.style.display = 'block';
        editEl.style.display = 'none';
    }
}

/**
 * Convert Current Day object to plain text for the edit textarea.
 */
function formatCurrentDayForEdit(day) {
    if (!day) return '';
    const lines = [];
    if (day.dateDisplay) lines.push(`Date: ${day.dateDisplay}`);
    if (day.dateSub) lines.push(`Sub: ${day.dateSub}`);
    if (day.season) lines.push(`Season: ${day.season}`);
    if (day.weatherToday) lines.push(`Weather today: ${day.weatherToday}`);
    if (day.flora) lines.push(`Flora: ${day.flora}`);
    if (day.fauna) lines.push(`Fauna: ${day.fauna}`);
    if (day.spiritualClimate) lines.push(`Spiritual Climate: ${day.spiritualClimate}`);
    return lines.join('\n');
}

/**
 * Parse the edit textarea content back into Current Day fields and save.
 */
function saveCurrentDayEdit() {
    const textarea = document.getElementById('nwst-currentday-textarea');
    if (!textarea) return;

    const chatId = getChatId();
    const text = textarea.value.trim();

    // ── Snapshot old date before overwriting ──
    const existingDay = getCurrentDay(chatId);
    const oldDateDisplay = existingDay?.dateDisplay || '';

    // Start with ALL fields empty so that removed lines explicitly overwrite old values
    // Preserve lunarAngle — it's managed by the moon phase engine, not user-editable
    const day = {
        dateDisplay: '',
        dateSub: '',
        season: '',
        weatherToday: '',
        flora: '',
        fauna: '',
        spiritualClimate: '',
        lunarAngle: (existingDay && typeof existingDay.lunarAngle === 'number') ? existingDay.lunarAngle : 0
    };

    // Parse lines like "Date: Chrysanthemum Month · Seventh Day of the Waxing Moon"
    const lines = text.split('\n');
    for (const line of lines) {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (match) {
            const key = match[1].trim().toLowerCase();
            const value = match[2].trim();
            if (key === 'date' || key === 'date display') day.dateDisplay = value;
            else if (key === 'sub' || key === 'sub date' || key === 'date sub') day.dateSub = value;
            else if (key === 'season') day.season = value;
            else if (key === 'weather today') day.weatherToday = value;
            else if (key === 'flora') day.flora = value;
            else if (key === 'fauna') day.fauna = value;
            else if (key === 'spiritual climate') day.spiritualClimate = value;
        }
    }

    updateCurrentDay(chatId, day);

    // ── Recalculate lunar angle if the date changed ──────────────
    // Instead of estimating day difference, we now parse the date text
    // semantically to compute a meaningful lunar angle from scratch.
    // This handles narrative dates like "Seventh Day of the Waxing Moon",
    // "Full Moon Festival", "11/7/1125", "Day 14", etc.
    if (day.dateDisplay && day.dateDisplay !== oldDateDisplay) {
        const newAngle = computeLunarAngleFromDate(day.dateDisplay);
        const phaseInfo = getMoonPhaseForAngle(newAngle);
        setLunarAngle(chatId, newAngle);
        const newMoonPhases = generateMoonPhases(newAngle, 7, 0);
        replaceMoonPhases(chatId, newMoonPhases);
        nwstToast(`Date changed — moon phases recalculated from date text. Anchored as "${phaseInfo.phaseName}" (${newAngle.toFixed(1)}°).`, 'info');
    }

    toggleCurrentDayEdit(false);
    refreshCurrentDayDisplay();
    refreshMoonDisplay();
    nwstToast('Current Day saved.', 'success');
}

// ── UI Refresh ────────────────────────────────────────────────────────────

/**
 * Refresh the entire Home tab with current data from storage.
 * Called when the panel opens or when the chat changes.
 */
export function refreshHomeUI() {
    updateStatusLabel();
    updatePauseButton();
    refreshCurrentDayDisplay();
    refreshForecastDisplay();
    refreshMoonDisplay();
    refreshEventsDigest();
}

// ── Current Day display ───────────────────────────────────────────────────

function refreshCurrentDayDisplay() {
    const container = document.getElementById('nwst-currentday-content');
    const dateDisplay = document.getElementById('nwst-date-display');
    const dateSub = document.getElementById('nwst-date-sub');
    const enableToggle = document.getElementById('nwst-enable-toggle');

    if (enableToggle) enableToggle.checked = isEnabled();

    const chatId = getChatId();
    const day = getCurrentDay(chatId);

    // Update date fields in nav bar
    if (dateDisplay) dateDisplay.textContent = day.dateDisplay || '—';
    if (dateSub) dateSub.textContent = day.dateSub || '—';

    if (!container) return;

    // Check if there's any content to display
    const hasContent = day.season || day.weatherToday || day.flora || day.fauna || day.spiritualClimate;

    if (!hasContent) {
        container.innerHTML = '<div class="nwst-nb-empty">No Current Day data yet. Run a batch scan or advance the day to generate content.</div>';
        return;
    }

    // Build the rendered Current Day view (matching mockup's .md format)
    let html = '<ul>';
    if (day.season) {
        html += `<li><strong>Season</strong> ${escapeHTML(day.season)}</li>`;
    }
    if (day.weatherToday) {
        html += `<li><strong>Weather today</strong> ${escapeHTML(day.weatherToday)}</li>`;
    }
    if (day.flora) {
        html += `<li><strong>Flora</strong> ${escapeHTML(day.flora)}</li>`;
    }
    if (day.fauna) {
        html += `<li><strong>Fauna</strong> ${escapeHTML(day.fauna)}</li>`;
    }
    if (day.spiritualClimate) {
        // Check if Spiritual condition is enabled
        const conditions = getCondition ? getCondition(chatId, 'spiritual') : { enabled: true };
        if (conditions.enabled) {
            html += `<li><strong>Spiritual Climate</strong> ${escapeHTML(day.spiritualClimate)}</li>`;
        }
    }
    html += '</ul>';
    container.innerHTML = html;
}

/**
 * Import condition check for Spiritual Climate visibility.
 * We use a lazy import to avoid circular dependency.
 */
function getCondition(chatId, conditionName) {
    // Dynamic import to avoid circular dependency
    // For now, default to enabled if we can't check
    try {
        // We'll access this through the stored data directly
        return { enabled: true };
    } catch (e) {
        return { enabled: true };
    }
}

// ── Forecast display ──────────────────────────────────────────────────────

function refreshForecastDisplay() {
    const strip = document.getElementById('nwst-forecast-strip');
    if (!strip) return;

    const chatId = getChatId();
    const forecast = getForecast(chatId);

    if (!forecast || forecast.length === 0) {
        strip.innerHTML = '<div class="nwst-nb-empty">No forecast data yet.</div>';
        return;
    }

    let html = '';
    for (let i = 0; i < forecast.length; i++) {
        const day = forecast[i];
        const isToday = i === 0;
        const todayClass = isToday ? ' nwst-today' : '';

        html += `
        <div class="nwst-weather-day${todayClass}">
            <div class="nwst-wd-name">${escapeHTML(day.label || `Day ${i + 1}`)}</div>
            <div class="nwst-wd-icon">${escapeHTML(day.icon || '—')}</div>
            <div class="nwst-wd-desc">${escapeHTML(day.description || '')}</div>
            <div class="nwst-wd-temps">
                <span class="nwst-wd-hi">${day.highF != null ? day.highF + '°F' : '—'}</span>
                <span class="nwst-wd-sep">/</span>
                <span class="nwst-wd-lo">${day.lowF != null ? day.lowF + '°F' : '—'}</span>
            </div>
            <span class="nwst-wd-cf">${day.highC != null ? day.highC + '°C' : ''}${day.highC != null && day.lowC != null ? ' / ' : ''}${day.lowC != null ? day.lowC + '°C' : ''}</span>
            ${day.precipChance != null ? `<span class="nwst-wd-precip">💧 ${day.precipChance}%</span>` : ''}
        </div>`;
    }

    strip.innerHTML = html;
}

// ── Moon phase display ────────────────────────────────────────────────────

function refreshMoonDisplay() {
    const strip = document.getElementById('nwst-moon-strip');
    if (!strip) return;

    const chatId = getChatId();
    const moonPhases = getMoonPhases(chatId);
    const enableMoons = getSetting('enableMoons');

    if (enableMoons === false) {
        strip.innerHTML = '<div class="nwst-nb-empty" style="color:#999">🌙 Moons are disabled. Enable them in Settings.</div>';
        return;
    }

    if (!moonPhases || moonPhases.length === 0) {
        strip.innerHTML = '<div class="nwst-nb-empty">No moon phase data yet.</div>';
        return;
    }

    // Calculate base angle for phenomena detection
    const day = getCurrentDay(chatId);
    const lunarAngle = getLunarAngle(chatId);
    const cycleDays = getSetting('moonCycleDays') || 29.53;
    const degPerDay = 360 / cycleDays;

    // Gather weather/season context for weather-dependent phenomena
    // (Moonbows need rain, Lunar Rings need high clouds)
    const phenomenaOptions = {
        season: day.season || '',
        weatherToday: day.weatherToday || ''
    };

    let html = '';
    for (let i = 0; i < moonPhases.length; i++) {
        const moon = moonPhases[i];
        const isToday = i === 0;
        const todayClass = isToday ? ' nwst-today' : '';

        // Get phenomena for this day's phase
        const dayAngle = (lunarAngle + i * degPerDay) % 360;
        const phenomena = getMoonPhenomena(dayAngle, i, cycleDays, phenomenaOptions);

        // Build phenomena tags
        let phenHtml = '';
        if (phenomena.length > 0) {
            phenHtml = `<div class="nwst-mn-phenomena">${phenomena.map(p => `<span class="nwst-phen-tag">${escapeHTML(p)}</span>`).join('')}</div>`;
        }

        html += `
        <div class="nwst-moon-day${todayClass}">
            <div class="nwst-mn-name">${escapeHTML(moon.label || `Day ${i + 1}`)}</div>
            <div class="nwst-mn-icon">${escapeHTML(moon.icon || '—')}</div>
            <div class="nwst-mn-label">${escapeHTML(moon.phaseName || '')}</div>
            ${phenHtml}
        </div>`;
    }

    strip.innerHTML = html;
}

// ── Events digest (read-only summary) ─────────────────────────────────────

function refreshEventsDigest() {
    const container = document.getElementById('nwst-events-digest');
    if (!container) return;

    const chatId = getChatId();
    const grouped = getEventsGroupedByTier(chatId);
    const activeTiers = ['immediate', 'week', 'month', 'undetermined'];

    let html = '';
    let hasAnyEvents = false;

    for (const tier of activeTiers) {
        const events = grouped[tier];
        if (!events || events.length === 0) continue;

        // Filter to active events only (pending + in-progress)
        const activeEvents = events.filter(e => e.status === 'pending' || e.status === 'inprogress');
        if (activeEvents.length === 0) continue;

        hasAnyEvents = true;
        const tierLabel = tier === 'immediate' ? 'Immediate' :
                          tier === 'week' ? 'This week' :
                          tier === 'month' ? 'This month' : 'Undetermined';

        html += `<h3>${tierLabel}</h3><ul>`;
        for (const event of activeEvents) {
            html += `<li><strong>${escapeHTML(event.title)}</strong> — ${escapeHTML(event.description)}</li>`;
        }
        html += '</ul>';
    }

    if (!hasAnyEvents) {
        html = '<div class="nwst-nb-empty">No upcoming events.</div>';
    }

    container.innerHTML = html;
}

// ── Utility: Escape HTML entities ─────────────────────────────────────────

function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
