/* eslint-disable */
// =============================================================================
// NWST Events Tab UI — ui/events.js
// =============================================================================
// Builds and manages the Events tab pane. Matches nwst-mockup.html exactly.
//
// Layout:
//   • + Add event / ↺ Regenerate all buttons
//   • Info text explaining detection vs generation
//   • Four tier groups: Immediate, This Week, This Month, Undetermined
//   • Each event: colored dot, title, tier badge, status badge, NPC badge
//   • Expanded body: description textarea, status selector, Save/Delete/⛶
// =============================================================================

import { getChatId, nwstToast } from '../index.js';
import {
    getAllEvents,
    addEvent, updateEvent, deleteEvent, setEventStatus,
    getEventsGroupedByTier
} from '../data/events.js';

// ── Build the Events tab HTML ─────────────────────────────────────────────

export function buildEventsTab() {
    const pane = document.getElementById('nwst-pane-events');
    if (!pane) return;

    pane.innerHTML = `
        <div class="nwst-btn-row" style="margin-bottom:14px">
            <button class="menu_button nwst-btn" id="nwst-events-add">+ Add event</button>
            <button class="menu_button nwst-btn-regen" id="nwst-events-regenAll">↺ Regenerate all</button>
        </div>
        <div style="font-size:11px;color:#999;margin-bottom:12px;line-height:1.5">
            Event statuses are updated by the scanner when it detects changes in the chat, or manually by you.
            <span style="color:#8a5a00">NPC</span> events are detected automatically from character plans, meetings, and interactions.
        </div>

        <!-- Tier groups are generated dynamically -->
        <div id="nwst-events-container">
            <div class="nwst-nb-empty">Loading events...</div>
        </div>
    `;

    refreshEventsUI();
}

// ── Refresh the Events tab ────────────────────────────────────────────────

export function refreshEventsUI() {
    const container = document.getElementById('nwst-events-container');
    if (!container) return;

    const chatId = getChatId();
    const grouped = getEventsGroupedByTier(chatId);

    const tierConfigs = [
        { key: 'immediate', label: 'Immediate' },
        { key: 'week', label: 'This week' },
        { key: 'month', label: 'This month' },
        { key: 'undetermined', label: 'Undetermined', noRegen: true }
    ];

    let html = '';

    for (const tier of tierConfigs) {
        const events = grouped[tier.key] || [];

        html += `<div class="nwst-event-group">`;
        html += `<div class="nwst-event-group-hdr">`;
        html += `<div class="nwst-lbl" style="margin-bottom:0">${tier.label}</div>`;
        if (!tier.noRegen) {
            html += `<button class="menu_button nwst-btn-regen nwst-events-tier-regen" style="font-size:11px;padding:3px 9px" data-tier="${tier.key}">↺ Regen</button>`;
        } else {
            html += `<div style="font-size:11px;color:#999">Not regenerated — timing is intentional</div>`;
        }
        html += `</div>`;

        if (events.length === 0) {
            html += `<div class="nwst-nb-empty" style="padding:4px 0">No ${tier.label.toLowerCase()} events.</div>`;
        } else {
            for (const event of events) {
                html += buildEventItemHTML(event);
            }
        }

        html += `</div>`;
        if (tier.key !== 'undetermined') {
            html += `<div class="nwst-div"></div>`;
        }
    }

    container.innerHTML = html;

    // Wire events for all event items
    wireEventItemEvents();
}

// ── Build a single event item's HTML ──────────────────────────────────────

function buildEventItemHTML(event) {
    const isOpen = event.status === 'pending' || event.status === 'inprogress'; // Open by default if active
    const openClass = isOpen ? ' nwst-open' : '';

    return `
    <div class="nwst-event-item${openClass}" data-event-id="${event.id}">
        <div class="nwst-event-item-hdr nwst-events-toggle">
            <div class="nwst-event-dot nwst-${event.tier}"></div>
            <div class="nwst-event-title">${escapeHTML(event.title)}</div>
            <span class="nwst-badge nwst-badge-${event.tier}">${capitalize(event.tier)}</span>
            ${event.isNPC ? '<span class="nwst-badge nwst-badge-npc">NPC</span>' : ''}
            <span class="nwst-badge nwst-badge-${event.status}">${statusLabel(event.status)}</span>
        </div>
        <div class="nwst-event-body">
            <textarea class="nwst-events-desc" rows="2" style="margin-bottom:8px" id="nwst-event-desc-${event.id}">${escapeHTML(event.description)}</textarea>
            <div style="font-size:11px;color:#999;margin-bottom:6px">Status</div>
            <div class="nwst-btn-row nwst-events-status-btns" style="margin-bottom:10px">
                <button class="menu_button nwst-btn nwst-events-status" data-status="pending" style="font-size:11px${event.status === 'pending' ? ';border-color:#7F77DD;color:#3C3489' : ''}">Pending</button>
                <button class="menu_button nwst-btn nwst-events-status" data-status="inprogress" style="font-size:11px${event.status === 'inprogress' ? ';border-color:#7F77DD;color:#3C3489' : ''}">In progress</button>
                <button class="menu_button nwst-btn nwst-events-status" data-status="resolved" style="font-size:11px${event.status === 'resolved' ? ';border-color:#7F77DD;color:#3C3489' : ''}">Resolved</button>
                <button class="menu_button nwst-btn nwst-events-status" data-status="missed" style="font-size:11px${event.status === 'missed' ? ';border-color:#7F77DD;color:#3C3489' : ''}">Missed</button>
            </div>
            <div class="nwst-btn-row">
                <button class="menu_button nwst-btn nwst-events-save">Save</button>
                <button class="menu_button nwst-btn-danger nwst-events-delete">Delete</button>
                <button class="editor_maximize nwst-expand-btn nwst-events-popout" data-for="nwst-event-desc-${event.id}" style="margin-left:4px;font-size:14px;color:#aaa" title="Open in popout">⛶</button>
            </div>
        </div>
    </div>`;
}

// ── Wire events for all event items ───────────────────────────────────────

function wireEventItemEvents() {
    const container = document.getElementById('nwst-events-container');
    if (!container) return;

    // ── Add Event button with popup ─────────────────────────────
    const addBtn = document.getElementById('nwst-events-add');
    if (addBtn) {
        addBtn.onclick = async () => {
            const chatId = getChatId();
            const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();

            const formHtml = `
                <div style="padding:10px;min-width:320px">
                    <div style="margin-bottom:14px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">Title</label>
                        <input type="text" class="text_pole" style="width:100%" placeholder="e.g. The King's arrival"
                            oninput="window._nwstAddEventTitle=this.value">
                    </div>
                    <div style="margin-bottom:14px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">Description</label>
                        <textarea class="text_pole" rows="3" style="width:100%" placeholder="Describe the event..."
                            oninput="window._nwstAddEventDesc=this.value"></textarea>
                    </div>
                    <div>
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">Category</label>
                        <select class="text_pole" style="width:100%"
                            onchange="window._nwstAddEventTier=this.value">
                            <option value="immediate">Immediate</option>
                            <option value="week">This week</option>
                            <option value="month">This month</option>
                            <option value="undetermined" selected>Undetermined</option>
                        </select>
                    </div>
                </div>
            `;

            // Reset temp variables
            window._nwstAddEventTitle = '';
            window._nwstAddEventDesc = '';
            window._nwstAddEventTier = 'undetermined';

            const result = await callGenericPopup(formHtml, POPUP_TYPE.TEXT, '', {
                okButton: 'Add event',
                cancelButton: 'Cancel',
            });

            if (result) {
                const title = window._nwstAddEventTitle?.trim() || 'New event';
                const description = window._nwstAddEventDesc?.trim() || 'No description provided.';
                const tier = window._nwstAddEventTier || 'undetermined';

                const newEvent = addEvent(chatId, {
                    title: title,
                    description: description,
                    tier: tier,
                    status: 'pending',
                    isNPC: false,
                    origin: 'detected'
                });
                refreshEventsUI();
                nwstToast(`Event "${title}" added (${tier}).`, 'success');
            }
        };
    }

    // ── Regenerate All button ─────────────────────────────────
    const regenAllBtn = document.getElementById('nwst-events-regenAll');
    if (regenAllBtn) {
        regenAllBtn.onclick = () => {
            nwstToast('Regenerate all will be available in a future update.', 'info');
        };
    }

    // ── Tier Regen buttons ────────────────────────────────────
    container.querySelectorAll('.nwst-events-tier-regen').forEach(btn => {
        btn.onclick = () => {
            const tier = btn.getAttribute('data-tier');
            nwstToast(`Regenerate ${tier} events will be available in a future update.`, 'info');
        };
    });

    // ── Expand/collapse toggle ─────────────────────────────────
    container.querySelectorAll('.nwst-events-toggle').forEach(hdr => {
        hdr.onclick = function () {
            this.closest('.nwst-event-item').classList.toggle('nwst-open');
        };
    });

    // ── Status buttons ────────────────────────────────────────
    container.querySelectorAll('.nwst-events-status').forEach(btn => {
        btn.onclick = function (e) {
            e.stopPropagation();
            const eventId = this.closest('.nwst-event-item').getAttribute('data-event-id');
            const newStatus = this.getAttribute('data-status');
            const chatId = getChatId();
            setEventStatus(chatId, eventId, newStatus);
            refreshEventsUI();
            nwstToast(`Event status changed to ${statusLabel(newStatus)}.`, 'info');
        };
    });

    // ── Save button ───────────────────────────────────────────
    container.querySelectorAll('.nwst-events-save').forEach(btn => {
        btn.onclick = function (e) {
            e.stopPropagation();
            const item = this.closest('.nwst-event-item');
            const eventId = item.getAttribute('data-event-id');
            const descTextarea = item.querySelector('.nwst-events-desc');
            const chatId = getChatId();
            if (descTextarea) {
                updateEvent(chatId, eventId, { description: descTextarea.value });
                nwstToast('Event saved.', 'success');
            }
        };
    });

    // ── Delete button ─────────────────────────────────────────
    container.querySelectorAll('.nwst-events-delete').forEach(btn => {
        btn.onclick = function (e) {
            e.stopPropagation();
            const eventId = this.closest('.nwst-event-item').getAttribute('data-event-id');
            const chatId = getChatId();
            deleteEvent(chatId, eventId);
            refreshEventsUI();
            nwstToast('Event deleted.', 'info');
        };
    });

}

// ── Helpers ───────────────────────────────────────────────────────────────

function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function statusLabel(status) {
    const labels = {
        pending: 'Pending',
        inprogress: 'In progress',
        resolved: 'Resolved',
        missed: 'Missed'
    };
    return labels[status] || status;
}
