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
    openPopout
} from '../index.js';

import { isEnabled, setEnabled, isPaused, setPaused } from '../settings.js';
import {
    getCurrentDay,
    updateCurrentDay,
    getForecast,
    getMoonPhases,
    replaceCurrentDay
} from '../data/worldState.js';
import { getEventsGroupedByTier } from '../data/events.js';

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
        <!-- ── Header: Extension name + Enable toggle + Pause button ── -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div>
                <div style="font-size:14px;font-weight:500">Narrative World State Tracker</div>
                <div style="font-size:11px;color:#999" id="nwst-ext-status">Extension enabled · Scanning active</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
                <button id="nwst-pause-btn" style="font-size:11px;padding:4px 10px;border:0.5px solid #ccc;border-radius:8px;background:transparent;color:#666;cursor:pointer;display:flex;align-items:center;gap:5px">
                    <span id="nwst-pause-icon">⏸</span><span id="nwst-pause-label">Pause</span>
                </button>
                <label class="nwst-toggle">
                    <input type="checkbox" id="nwst-enable-toggle" checked>
                    <span class="nwst-slider"></span>
                </label>
            </div>
        </div>
        <div class="nwst-div"></div>

        <!-- ── Day Navigation Bar ──────────────────────────────── -->
        <div class="nwst-day-nav">
            <button class="nwst-day-nav-btn" id="nwst-prev-day-btn" title="Previous day">‹</button>
            <div class="nwst-day-label">
                <div class="nwst-date-main" id="nwst-date-display" contenteditable="true" title="Click to edit"
                    style="cursor:text;border-radius:4px;padding:1px 4px;outline:none;"
                    onfocus="this.style.background='var(--SmartThemeChatScrollBarColor, #f8f8f8)'"
                    onblur="this.style.background='transparent'">—</div>
                <div class="nwst-date-sub" id="nwst-date-sub" contenteditable="true" title="Click to edit"
                    style="cursor:text;border-radius:4px;padding:1px 4px;outline:none;"
                    onfocus="this.style.background='var(--SmartThemeChatScrollBarColor, #f8f8f8)'"
                    onblur="this.style.background='transparent'">—</div>
            </div>
            <button class="nwst-day-nav-btn" id="nwst-next-day-btn" title="Next day">›</button>
        </div>

        <!-- ── Time Skip ───────────────────────────────────────── -->
        <div style="margin-bottom:14px">
            <div class="nwst-lbl">Time skip</div>
            <div class="nwst-jump-wrap">
                <input type="text" id="nwst-timeskip-input" placeholder="e.g. Three weeks later, end of harvest season…" style="flex:1">
                <button class="nwst-btn-regen" id="nwst-timeskip-jump">Jump →</button>
            </div>
        </div>

        <div class="nwst-div"></div>

        <!-- ── Current Day Journal Block ───────────────────────── -->
        <div class="nwst-journal-block" style="margin-bottom:10px">
            <div class="nwst-journal-hdr">
                <div class="nwst-journal-hdr-title">📅 Current Day</div>
                <div class="nwst-btn-row">
                    <button class="nwst-icon-btn" id="nwst-currentday-edit-btn" title="Edit">✎</button>
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
                    <button class="nwst-btn" id="nwst-currentday-save">Save</button>
                    <button class="nwst-btn" id="nwst-currentday-cancel">Cancel</button>
                    <button class="nwst-expand-btn" style="margin-left:4px;font-size:14px;color:#aaa"
                        id="nwst-currentday-popout" title="Open in popout">⛶</button>
                </div>
            </div>
        </div>

        <!-- ── 7-Day Forecast Strip ────────────────────────────── -->
        <div class="nwst-journal-block" style="margin-bottom:10px">
            <div class="nwst-journal-hdr">
                <div class="nwst-journal-hdr-title">🌤 7-Day Forecast</div>
                <div class="nwst-btn-row">
                    <button class="nwst-btn-regen" id="nwst-forecast-regen" style="font-size:11px;padding:3px 9px">↺ Regen</button>
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
                <button class="nwst-btn" id="nwst-events-manage-btn" style="font-size:11px;padding:3px 9px">Manage →</button>
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
    // ── Enable toggle ──────────────────────────────────────────
    const enableToggle = document.getElementById('nwst-enable-toggle');
    if (enableToggle) {
        enableToggle.addEventListener('change', function () {
            setEnabled(this.checked);
            updateStatusLabel();
            nwstToast(this.checked ? 'Extension enabled.' : 'Extension disabled.', 'info');
        });
    }

    // ── Pause / Resume button ──────────────────────────────────
    const pauseBtn = document.getElementById('nwst-pause-btn');
    if (pauseBtn) {
        pauseBtn.addEventListener('click', function () {
            const paused = !isPaused();
            setPaused(paused);
            updatePauseButton();
            updateStatusLabel();
            nwstToast(paused ? 'Scanner paused.' : 'Scanner resumed.', 'info');
        });
    }

    // ── Previous Day ───────────────────────────────────────────
    const prevDayBtn = document.getElementById('nwst-prev-day-btn');
    if (prevDayBtn) {
        prevDayBtn.addEventListener('click', () => {
            nwstToast('Previous Day will be available in a future update (restores snapshot).', 'info');
        });
    }

    // ── Next Day ───────────────────────────────────────────────
    const nextDayBtn = document.getElementById('nwst-next-day-btn');
    if (nextDayBtn) {
        nextDayBtn.addEventListener('click', () => {
            nwstToast('Next Day will be available in a future update (calls Day Advancement LLM).', 'info');
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
        jumpBtn.addEventListener('click', () => {
            const input = document.getElementById('nwst-timeskip-input');
            const skipDesc = input ? input.value.trim() : '';
            if (!skipDesc) {
                nwstToast('Enter a description of the time skip first.', 'warning');
                return;
            }
            nwstToast('Time skip will be available in a future update.', 'info');
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

    // ── Current Day Popout ─────────────────────────────────────
    const popoutBtn = document.getElementById('nwst-currentday-popout');
    if (popoutBtn) {
        popoutBtn.addEventListener('click', () => {
            const textarea = document.getElementById('nwst-currentday-textarea');
            if (textarea) {
                openPopout('Current Day', textarea.value, (newValue) => {
                    textarea.value = newValue;
                    saveCurrentDayEdit();
                });
            }
        });
    }

    // ── Forecast Regen button ──────────────────────────────────
    const forecastRegen = document.getElementById('nwst-forecast-regen');
    if (forecastRegen) {
        forecastRegen.addEventListener('click', () => {
            nwstToast('Forecast regeneration will be available in a future update.', 'info');
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
    const day = {};

    // Parse lines like "Season: Late Autumn — Chrysanthemum Month"
    const lines = text.split('\n');
    for (const line of lines) {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (match) {
            const key = match[1].trim().toLowerCase();
            const value = match[2].trim();
            if (key === 'season') day.season = value;
            else if (key === 'weather today') day.weatherToday = value;
            else if (key === 'flora') day.flora = value;
            else if (key === 'fauna') day.fauna = value;
            else if (key === 'spiritual climate') day.spiritualClimate = value;
        }
    }

    updateCurrentDay(chatId, day);
    toggleCurrentDayEdit(false);
    refreshCurrentDayDisplay();
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

// ── Status label + pause button ───────────────────────────────────────────

function updateStatusLabel() {
    const label = document.getElementById('nwst-ext-status');
    if (!label) return;

    const enabled = isEnabled();
    const paused = isPaused();

    if (!enabled) {
        label.textContent = 'Extension disabled';
        label.style.color = '#999';
    } else if (paused) {
        label.textContent = 'Extension enabled · Scanning paused';
        label.style.color = '#8a6c00';
    } else {
        label.textContent = 'Extension enabled · Scanning active';
        label.style.color = '#999';
    }
}

function updatePauseButton() {
    const btn = document.getElementById('nwst-pause-btn');
    const icon = document.getElementById('nwst-pause-icon');
    const label = document.getElementById('nwst-pause-label');
    if (!btn || !icon || !label) return;

    const paused = isPaused();

    if (paused) {
        btn.style.borderColor = '#f0c040';
        btn.style.color = '#8a6c00';
        btn.style.background = '#fffbe6';
        icon.textContent = '▶';
        label.textContent = 'Resume';
    } else {
        btn.style.borderColor = '#ccc';
        btn.style.color = '#666';
        btn.style.background = 'transparent';
        icon.textContent = '⏸';
        label.textContent = 'Pause';
    }

    // Disable pause button if extension is off
    const enabled = isEnabled();
    btn.style.opacity = enabled ? '1' : '0.4';
    btn.style.pointerEvents = enabled ? 'auto' : 'none';
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

    if (!moonPhases || moonPhases.length === 0) {
        strip.innerHTML = '<div class="nwst-nb-empty">No moon phase data yet.</div>';
        return;
    }

    let html = '';
    for (let i = 0; i < moonPhases.length; i++) {
        const moon = moonPhases[i];
        const isToday = i === 0;
        const todayClass = isToday ? ' nwst-today' : '';

        html += `
        <div class="nwst-moon-day${todayClass}">
            <div class="nwst-mn-name">${escapeHTML(moon.label || `Day ${i + 1}`)}</div>
            <div class="nwst-mn-icon">${escapeHTML(moon.icon || '—')}</div>
            <div class="nwst-mn-label">${escapeHTML(moon.phaseName || '')}</div>
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
