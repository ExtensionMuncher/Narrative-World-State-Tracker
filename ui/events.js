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
import { regenerateAllEvents, regenerateTierEvents } from '../llm/eventGen.js';

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
    const isOpen = false; // All events default to collapsed
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
            <div style="margin-bottom:6px">
                <div style="font-size:11px;color:#999;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em">Event name</div>
                <input type="text" class="nwst-events-title" value="${escapeHTML(event.title)}" style="width:100%;font-size:13px;padding:5px 8px;border:0.5px solid #ccc;border-radius:8px;" placeholder="Event title...">
            </div>
            <div style="margin-bottom:8px">
                <div style="font-size:11px;color:#999;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em">Time category</div>
                <select class="nwst-events-tier" style="width:100%;font-size:13px;padding:5px 8px;">
                    <option value="immediate"${event.tier === 'immediate' ? ' selected' : ''}>Immediate</option>
                    <option value="week"${event.tier === 'week' ? ' selected' : ''}>This week</option>
                    <option value="month"${event.tier === 'month' ? ' selected' : ''}>This month</option>
                    <option value="undetermined"${event.tier === 'undetermined' ? ' selected' : ''}>Undetermined</option>
                </select>
            </div>
            <textarea class="nwst-events-desc" rows="2" style="margin-bottom:8px" id="nwst-event-desc-${event.id}">${escapeHTML(event.description)}</textarea>
            <div style="font-size:11px;color:#999;margin-bottom:6px">Status</div>
            <div class="nwst-btn-row nwst-events-status-btns" style="margin-bottom:10px">
                <button class="menu_button nwst-btn nwst-events-status${event.status === 'pending' ? ' nwst-status-active' : ''}" data-status="pending" style="font-size:11px">Pending</button>
                <button class="menu_button nwst-btn nwst-events-status${event.status === 'inprogress' ? ' nwst-status-active' : ''}" data-status="inprogress" style="font-size:11px">In progress</button>
                <button class="menu_button nwst-btn nwst-events-status${event.status === 'resolved' ? ' nwst-status-active' : ''}" data-status="resolved" style="font-size:11px">Resolved</button>
                <button class="menu_button nwst-btn nwst-events-status${event.status === 'missed' ? ' nwst-status-active' : ''}" data-status="missed" style="font-size:11px">Missed</button>
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

                const newEvent = await addEvent(chatId, {
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
        regenAllBtn.onclick = async () => {
            await regenerateAllEvents();
            refreshEventsUI();
        };
    }

    // ── Tier Regen buttons ────────────────────────────────────
    container.querySelectorAll('.nwst-events-tier-regen').forEach(btn => {
        btn.onclick = async () => {
            const tier = btn.getAttribute('data-tier');
            await regenerateTierEvents(tier);
            refreshEventsUI();
        };
    });

    // ── Expand/collapse toggle ─────────────────────────────────
    container.querySelectorAll('.nwst-events-toggle').forEach(hdr => {
        hdr.onclick = async function () {
            this.closest('.nwst-event-item').classList.toggle('nwst-open');
        };
    });

    // ── Status buttons ────────────────────────────────────────
    container.querySelectorAll('.nwst-events-status').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const eventId = this.closest('.nwst-event-item').getAttribute('data-event-id');
            const newStatus = this.getAttribute('data-status');
            const chatId = getChatId();
            await setEventStatus(chatId, eventId, newStatus);
            refreshEventsUI();
            nwstToast(`Event status changed to ${statusLabel(newStatus)}.`, 'info');
        };
    });

    // ── Save button ───────────────────────────────────────────
    container.querySelectorAll('.nwst-events-save').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const item = this.closest('.nwst-event-item');
            const eventId = item.getAttribute('data-event-id');
            const descTextarea = item.querySelector('.nwst-events-desc');
            const titleInput   = item.querySelector('.nwst-events-title');
            const tierSelect   = item.querySelector('.nwst-events-tier');
            const chatId = getChatId();

            const updates = {};
            if (descTextarea) updates.description = descTextarea.value;
            if (titleInput)   updates.title = titleInput.value.trim() || 'Untitled event';
            if (tierSelect)   updates.tier  = tierSelect.value;

            if (Object.keys(updates).length > 0) {
                await updateEvent(chatId, eventId, updates);
                // If tier changed, re-render so event moves to correct group
                if (tierSelect) {
                    refreshEventsUI();
                }
                nwstToast('Event saved.', 'success');
            }
        };
    });

    // ── Delete button ─────────────────────────────────────────
    container.querySelectorAll('.nwst-events-delete').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const eventId = this.closest('.nwst-event-item').getAttribute('data-event-id');
            const chatId = getChatId();
            await deleteEvent(chatId, eventId);
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
