/* eslint-disable */
// =============================================================================
// NWST Events Tab UI — ui/events.js
// =============================================================================
// Builds and manages the Events tab pane. Matches nwst-mockup.html exactly.
//
// Layout:
//   • + Add event / Generate Events buttons
//   • Info text explaining detection vs generation
//   • Four tier groups: Immediate, This Week, This Month, Undetermined
//   • Each event: colored dot, title, tier badge, status badge, NPC badge
//   • Expanded body: description textarea, status selector, Save/Delete/⛶
// =============================================================================

import { getChatId, nwstToast } from '../index.js';
import {
    getAllEvents,
    addEvent, updateEvent, deleteEvent, setEventStatus,
    getEventsGroupedByTier,
    promoteEventToSecret,
    removeEventWithSummary
} from '../data/events.js';
import { getAllSecrets } from '../data/notebook.js';
import { getCurrentDay } from '../data/worldState.js';
import { resolveSpecialDayCategory } from '../data/specialDays.js';
import { regenerateAllEvents, regenerateTierEvents } from '../llm/eventGen.js';
import { buildPendingEventsSectionHTML, refreshPendingEvents, wirePendingEvents } from './pendingEvents.js';

// ── Build the Events tab HTML ─────────────────────────────────────────────

export function buildEventsTab() {
    const pane = document.getElementById('nwst-pane-events');
    if (!pane) return;

    pane.innerHTML = `
        <div class="nwst-btn-row" style="margin-bottom:14px">
            <button class="menu_button nwst-btn" id="nwst-events-add">+ Add event</button>
            <button class="menu_button nwst-btn-regen" id="nwst-events-regenAll">✦ Generate Events</button>
        </div>
        <div style="font-size:11px;color:#999;margin-bottom:12px;line-height:1.5">
            Event statuses are updated by the scanner when it detects changes in the chat, or manually by you.
            <span style="color:#8a5a00">NPC</span> events are detected automatically from character plans, meetings, and interactions.
        </div>

        ${buildPendingEventsSectionHTML()}

        <!-- Tier groups are generated dynamically -->
        <div id="nwst-events-container">
            <div class="nwst-nb-empty">Loading events...</div>
        </div>
    `;

    wirePendingEvents();
    refreshEventsUI();
}

// ── Refresh the Events tab ────────────────────────────────────────────────

export function refreshEventsUI() {
    refreshPendingEvents();
    const container = document.getElementById('nwst-events-container');
    if (!container) return;

    const chatId = getChatId();
    const grouped = getEventsGroupedByTier(chatId);

    // ── Validity review section (events the day-advance review flagged) ──
    const flagged = getAllEvents(chatId).filter(ev => ev.validityFlag
        && (ev.status === 'pending' || ev.status === 'inprogress'));
    let validityHtml = '';
    if (flagged.length > 0) {
        validityHtml += `<div class="nwst-event-group" style="border:1px solid #b8860b;border-radius:8px;padding:8px;margin-bottom:10px">`;
        validityHtml += `<div class="nwst-lbl" style="margin-bottom:6px">⚠ Validity review — do these still make sense?</div>`;
        for (const ev of flagged) {
            const reason = (ev.validityFlag.reason || '').replace(/</g, '&lt;');
            validityHtml += `<div style="margin-bottom:8px;padding:6px;background:rgba(184,134,11,0.08);border-radius:6px">`;
            validityHtml += `<div style="font-weight:600;font-size:13px">${(ev.title || '').replace(/</g, '&lt;')}</div>`;
            validityHtml += `<div style="font-size:12px;color:#bbb;margin:3px 0">${reason} <span style="color:#888">(flagged ${ev.validityFlag.flaggedOn || ''})</span></div>`;
            validityHtml += `<div style="display:flex;gap:6px;margin-top:4px">`;
            validityHtml += `<button class="menu_button nwst-btn nwst-validity-keep" data-event-id="${ev.id}" style="font-size:11px;padding:3px 10px">✓ Keep event</button>`;
            validityHtml += `<button class="menu_button nwst-btn nwst-validity-resolve" data-event-id="${ev.id}" style="font-size:11px;padding:3px 10px">✓ Mark resolved</button>`;
            validityHtml += `<button class="menu_button nwst-btn nwst-validity-miss" data-event-id="${ev.id}" style="font-size:11px;padding:3px 10px">✗ Mark missed</button>`;
            validityHtml += `</div></div>`;
        }
        validityHtml += `</div>`;
    }

    // ── Persistent resolution review queue ───────────────────────
    // Persistent events never conclude from calendar aging or silent LLM
    // maintenance. The scanner may only queue explicit textual evidence for
    // the player's Resolve / Keep decision.
    const persistentResolutionQueue = getAllEvents(chatId).filter(ev =>
        ev.tier === 'persistent'
        && ev.persistentResolutionFlag
        && (ev.status === 'pending' || ev.status === 'inprogress'));
    if (persistentResolutionQueue.length > 0) {
        validityHtml += `<div class="nwst-event-group" style="border:1px solid #9a72c7;border-radius:8px;padding:8px;margin-bottom:10px">`;
        validityHtml += `<div class="nwst-lbl" style="margin-bottom:6px">♾ Persistent resolution evidence — explicit narrative matches awaiting your decision</div>`;
        for (const ev of persistentResolutionQueue) {
            const f = ev.persistentResolutionFlag || {};
            const condition = String(ev.resolutionCondition || '').replace(/</g, '&lt;');
            const evidence = String(f.evidence || '').replace(/</g, '&lt;');
            validityHtml += `<div style="margin-bottom:8px;padding:6px;background:rgba(154,114,199,0.08);border-radius:6px">`;
            validityHtml += `<div style="font-weight:600;font-size:13px">${(ev.title || '').replace(/</g, '&lt;')}</div>`;
            validityHtml += `<div style="font-size:11px;color:#999;margin-top:3px"><b>Resolves when:</b> ${condition || '(missing condition)'}</div>`;
            validityHtml += `<div style="font-size:12px;color:#bbb;margin:4px 0"><b>Evidence:</b> ${evidence || '(no evidence text supplied)'}</div>`;
            validityHtml += `<div style="display:flex;gap:6px;margin-top:4px">`;
            validityHtml += `<button class="menu_button nwst-btn nwst-persistent-resolve" data-event-id="${ev.id}" style="font-size:11px;padding:3px 10px">✓ Resolve event</button>`;
            validityHtml += `<button class="menu_button nwst-btn nwst-persistent-keep" data-event-id="${ev.id}" style="font-size:11px;padding:3px 10px">Keep persistent</button>`;
            validityHtml += `</div></div>`;
        }
        validityHtml += `</div>`;
    }

    // ── Timing proposal queue — undetermined events whose timing the ──────
    // story has fixed, per the day-advance review. Accept moves the event
    // out of undetermined (the only automated-adjacent door out of that
    // tier, and it still requires the player's click); Dismiss leaves it
    // timeless and rests re-proposals for ~7 story days.
    const timingQueue = getAllEvents(chatId).filter(ev => ev.timingFlag
        && ev.tier === 'undetermined'
        && (ev.status === 'pending' || ev.status === 'inprogress'));
    if (timingQueue.length > 0) {
        validityHtml += `<div class="nwst-event-group" style="border:1px solid #b5a76a;border-radius:8px;padding:8px;margin-bottom:10px">`;
        validityHtml += `<div class="nwst-lbl" style="margin-bottom:6px">⏰ Timing proposals — narratively timed events whose timing the story has fixed</div>`;
        for (const ev of timingQueue) {
            const f = ev.timingFlag;
            const reason = (f.reason || '').replace(/</g, '&lt;');
            const tierLabel = f.tier === 'immediate' ? 'Immediate' : f.tier === 'week' ? 'This week' : f.tier === 'future' ? 'Future scheduled' : 'This month';
            const placement = f.scheduledDate ? `${tierLabel} · ${String(f.scheduledDate).replace(/</g, '&lt;')}` : tierLabel;
            validityHtml += `<div style="margin-bottom:8px;padding:6px;background:rgba(181,167,106,0.08);border-radius:6px">`;
            validityHtml += `<div style="font-weight:600;font-size:13px">${(ev.title || '').replace(/</g, '&lt;')}</div>`;
            validityHtml += `<div style="font-size:12px;color:#bbb;margin:3px 0">${reason} <span style="color:#888">(flagged ${f.flaggedOn || ''})</span></div>`;
            validityHtml += `<div style="font-size:12px;margin:2px 0">Proposed placement: <b>${placement}</b></div>`;
            validityHtml += `<div style="display:flex;gap:6px;margin-top:4px">`;
            validityHtml += `<button class="menu_button nwst-btn nwst-timing-accept" data-event-id="${ev.id}" style="font-size:11px;padding:3px 10px">⏰ Accept placement</button>`;
            validityHtml += `<button class="menu_button nwst-btn nwst-timing-dismiss" data-event-id="${ev.id}" style="font-size:11px;padding:3px 10px">✗ Keep timeless</button>`;
            validityHtml += `</div></div>`;
        }
        validityHtml += `</div>`;
    }

    // ── Promotion review queue — concluded events flagged as holding ──────
    // concealed knowledge by the day-advance event review. Either choice
    // removes the concluded event; a summary is kept in the notebook.
    const promoQueue = getAllEvents(chatId).filter(ev => ev.promotionFlag
        && (ev.status === 'resolved' || ev.status === 'missed')
        && !ev.promotedSecretId);
    if (promoQueue.length > 0) {
        validityHtml += `<div class="nwst-event-group" style="border:1px solid #6a9fb5;border-radius:8px;padding:8px;margin-bottom:10px">`;
        validityHtml += `<div class="nwst-lbl" style="margin-bottom:6px">🔒 Promotion review — concluded events holding concealed knowledge</div>`;
        for (const ev of promoQueue) {
            const reason = (ev.promotionFlag.reason || '').replace(/</g, '&lt;');
            validityHtml += `<div style="margin-bottom:8px;padding:6px;background:rgba(106,159,181,0.08);border-radius:6px">`;
            validityHtml += `<div style="font-weight:600;font-size:13px">${(ev.title || '').replace(/</g, '&lt;')}</div>`;
            validityHtml += `<div style="font-size:12px;color:#bbb;margin:3px 0">${reason} <span style="color:#888">(flagged ${ev.promotionFlag.flaggedOn || ''})</span></div>`;
            validityHtml += `<div style="font-size:11px;color:#888;margin:2px 0">Either choice removes this concluded event from the list — a summary is kept in the Notebook's Past Events.</div>`;
            validityHtml += `<div style="display:flex;gap:6px;margin-top:4px">`;
            validityHtml += `<button class="menu_button nwst-btn nwst-promo-accept" data-event-id="${ev.id}" style="font-size:11px;padding:3px 10px">🔒 Promote to secret</button>`;
            validityHtml += `<button class="menu_button nwst-btn nwst-promo-deny" data-event-id="${ev.id}" style="font-size:11px;padding:3px 10px">✗ Don't promote</button>`;
            validityHtml += `</div></div>`;
        }
        validityHtml += `</div>`;
    }

    const tierConfigs = [
        { key: 'immediate', label: 'Immediate' },
        { key: 'week', label: 'This week' },
        { key: 'month', label: 'This month' },
        { key: 'undetermined', label: 'Narratively Timed', noRegen: true },
        { key: 'persistent', label: 'Persistent' }
    ];

    let html = validityHtml;

    for (const tier of tierConfigs) {
        const events = grouped[tier.key] || [];

        html += `<div class="nwst-event-group">`;
        html += `<div class="nwst-event-group-hdr">`;
        html += `<div class="nwst-lbl" style="margin-bottom:0">${tier.label}</div>`;
        if (!tier.noRegen) {
            html += `<button class="menu_button nwst-btn-regen nwst-events-tier-regen" style="font-size:11px;padding:3px 9px" data-tier="${tier.key}">✦ Generate</button>`;
        } else {
            html += `<div style="font-size:11px;color:#999">The roleplaying model may introduce these whenever narratively appropriate</div>`;
        }
        if (tier.key === 'persistent') {
            html += `<div style="font-size:11px;color:#999;margin-left:auto">Persists until its explicit resolution condition is shown in the narrative · max 3 active</div>`;
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
        if (tier.key !== 'persistent') {
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

    // Show promoted badge in header if event was promoted to a secret
    const promotedBadge = event.promotedSecretId
        ? '<span class="nwst-badge nwst-badge-promoted" title="Promoted to secret">🔒 Secret</span>'
        : '';
    const participantWarningBadge = event.isNPC && (!Array.isArray(event.participants) || event.participants.length === 0)
        ? '<span class="nwst-badge" style="background:rgba(212,154,61,.18);border:1px solid rgba(212,154,61,.65)" title="This NPC event was preserved but still needs a named participant">⚠ Participant</span>'
        : '';
    const tierDisplayLabel = event.tier === 'undetermined' ? 'Narratively Timed' : event.tier === 'persistent' ? 'Persistent' : capitalize(event.tier);

    // Show promote button only for resolved/missed events that haven't been promoted yet
    const canPromote = (event.status === 'resolved' || event.status === 'missed') && !event.promotedSecretId;
    const promoteBtn = canPromote
        ? `<button class="menu_button nwst-btn nwst-events-promote" style="font-size:11px;color:#6a9fb5" title="Promote this event to a Notebook secret with whoKnows/whoDoesNotKnow tracking">🔒 Promote to Secret</button>`
        : '';

    return `
    <div class="nwst-event-item${openClass}" data-event-id="${event.id}">
        <div class="nwst-event-item-hdr nwst-events-toggle">
            <div class="nwst-event-dot nwst-${event.tier}"></div>
            <div class="nwst-event-title">${escapeHTML(event.title)}</div>
            ${event.scheduledDate ? `<span class="nwst-event-time" title="Click to edit scheduled time">${escapeHTML(event.scheduledDate)}</span>` : ''}
            <span class="nwst-badge nwst-badge-${event.tier}">${tierDisplayLabel}</span>
            ${event.isNPC ? '<span class="nwst-badge nwst-badge-npc">NPC</span>' : ''}
            ${participantWarningBadge}
            ${event.origin === 'special_day' ? `<span class="nwst-badge" style="background:rgba(181,167,106,0.25);border:1px solid #b5a76a" title="Player-defined calendar day">${(() => { const c = resolveSpecialDayCategory(event.specialDayCategory); return `${c.chip} ${escapeHTML(c.label)}`; })()}</span>` : ''}
            <span class="nwst-badge nwst-badge-${event.status}">${statusLabel(event.status)}</span>
            ${promotedBadge}
        </div>
        <div class="nwst-event-body">
            <div style="margin-bottom:6px">
                <div style="font-size:11px;color:#999;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em">Event name</div>
                <input type="text" class="nwst-events-title" value="${escapeHTML(event.title)}" style="width:100%;font-size:13px;padding:5px 8px;border:0.5px solid #ccc;border-radius:8px;" placeholder="Event title...">
            </div>
            <div style="margin-bottom:8px">
                <div style="font-size:11px;color:#999;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em">Time</div>
                <div style="display:flex;gap:8px;align-items:start">
                    <select class="nwst-events-tier" style="flex:1;font-size:13px;padding:5px 8px;">
                        <option value="immediate"${event.tier === 'immediate' ? ' selected' : ''}>Immediate</option>
                        <option value="week"${event.tier === 'week' ? ' selected' : ''}>This week</option>
                        <option value="month"${event.tier === 'month' ? ' selected' : ''}>This month</option>
                        <option value="undetermined"${event.tier === 'undetermined' ? ' selected' : ''}>Narratively Timed</option>
                        <option value="persistent"${event.tier === 'persistent' ? ' selected' : ''}>Persistent</option>
                    </select>
                    <input type="text" class="nwst-events-scheduled" value="${event.scheduledDate ? escapeHTML(event.scheduledDate) : ''}" style="flex:1;font-size:13px;padding:5px 8px;border:0.5px solid #ccc;border-radius:8px;${event.tier === 'persistent' ? 'opacity:.45' : ''}" placeholder="e.g. Day 3, March 15..." ${event.tier === 'persistent' ? 'disabled' : ''}>
                </div>
            </div>
            <div class="nwst-events-resolution-wrap" style="margin-bottom:8px;${event.tier === 'persistent' ? '' : 'display:none'}">
                <div style="font-size:11px;color:#999;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em">Resolution condition <span style="color:#ccc;font-weight:normal;text-transform:none">(Persistent only)</span></div>
                <textarea class="nwst-events-resolution" rows="2" style="width:100%;font-size:12px;padding:5px 8px;border:0.5px solid #ccc;border-radius:8px" placeholder="Explicit narrative condition that must be shown before this event can resolve">${escapeHTML(event.resolutionCondition || '')}</textarea>
            </div>
            <div style="margin-bottom:8px">
                <div style="display:flex;align-items:center;gap:8px">
                    <label style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.04em;cursor:pointer;display:flex;align-items:center;gap:4px;user-select:none">
                        <input type="checkbox" class="nwst-events-isnpc" ${event.isNPC ? 'checked' : ''} style="margin:0;width:13px;height:13px;cursor:pointer;vertical-align:middle">
                        NPC event
                    </label>
                    <span style="font-size:10px;color:#bbb">NPC events bypass the pool cap</span>
                </div>
            </div>
            <!-- Participants field — who is involved in or aware of this event -->
            <div style="margin-bottom:8px">
                <div style="font-size:11px;color:#999;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em">
                    Participants <span style="color:#ccc;font-weight:normal;text-transform:none">(comma-separated character names)</span>
                </div>
                <input type="text" class="nwst-events-participants" value="${escapeHTML((event.participants || []).join(', '))}" style="width:100%;font-size:13px;padding:5px 8px;border:0.5px solid #ccc;border-radius:8px;" placeholder="e.g. Seraphina, Kaelen, Lysander">
            </div>
            <textarea class="nwst-events-desc" rows="2" style="margin-bottom:8px" id="nwst-event-desc-${event.id}">${escapeHTML(event.description)}</textarea>
            <div style="font-size:11px;color:#999;margin-bottom:6px">Status</div>
            <div class="nwst-btn-row nwst-events-status-btns" style="margin-bottom:10px">
                <button class="menu_button nwst-btn nwst-events-status${event.status === 'pending' ? ' nwst-status-active' : ''}" data-status="pending" style="font-size:11px">Pending</button>
                <button class="menu_button nwst-btn nwst-events-status${event.status === 'inprogress' ? ' nwst-status-active' : ''}" data-status="inprogress" style="font-size:11px">In progress</button>
                <button class="menu_button nwst-btn nwst-events-status${event.status === 'resolved' ? ' nwst-status-active' : ''}" data-status="resolved" style="font-size:11px">Resolved</button>
                <button class="menu_button nwst-btn nwst-events-status${event.status === 'missed' ? ' nwst-status-active' : ''}" data-status="missed" style="font-size:11px">Missed</button>
            </div>
            ${promoteBtn ? `<div class="nwst-btn-row" style="margin-bottom:8px">${promoteBtn}</div>` : ''}
            <div class="nwst-btn-row">
                <button class="menu_button nwst-btn nwst-events-save">Save</button>
                <button class="menu_button nwst-btn-danger nwst-events-delete">Delete</button>
                <button class="editor_maximize nwst-expand-btn nwst-cond-popout" data-for="nwst-event-desc-${event.id}" style="margin-left:4px;font-size:14px;color:#aaa" title="Open in popout">⛶</button>
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
                    <div style="margin-bottom:14px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">Category</label>
                        <select class="text_pole" style="width:100%"
                            onchange="window._nwstAddEventTier=this.value">
                            <option value="immediate">Immediate</option>
                            <option value="week">This week</option>
                            <option value="month">This month</option>
                            <option value="undetermined" selected>Narratively Timed</option>
                            <option value="persistent">Persistent</option>
                        </select>
                    </div>
                    <div style="margin-bottom:14px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">Resolution condition <span style="color:#ccc;font-style:italic">(required for Persistent)</span></label>
                        <textarea class="text_pole" rows="2" style="width:100%" placeholder="e.g. Resolve only after the next Hollow attack is explicitly shown on-screen"
                            oninput="window._nwstAddEventResolution=this.value"></textarea>
                    </div>
                    <div style="margin-bottom:14px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">Scheduled date / time <span style="color:#ccc;font-style:italic">(ignored for Persistent)</span></label>
                        <input type="text" class="text_pole" style="width:100%" placeholder="e.g. Day 3, March 15, Evening of the festival..."
                            oninput="window._nwstAddEventScheduled=this.value">
                    </div>
                    <div style="margin-bottom:14px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">Participants <span style="color:#ccc;font-style:italic">(required for NPC events)</span></label>
                        <input type="text" class="text_pole" style="width:100%" placeholder="e.g. Mira Vale, Alden Reed"
                            oninput="window._nwstAddEventParticipants=this.value">
                        <div style="font-size:11px;color:#888;margin-top:4px;line-height:1.4">List direct attendees, organizers, responsible actors, or subjects. World events may remain empty only when no named character is directly involved.</div>
                    </div>
                    <div style="padding:6px 0">
                        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
                            <input type="checkbox" id="nwst-add-event-isnpc" class="checkbox_input" onchange="window._nwstAddEventIsNPC=this.checked"
                                style="width:16px;height:16px;flex-shrink:0;cursor:pointer">
                            <div>
                                <div style="font-size:13px;font-weight:500">NPC event</div>
                                <div style="font-size:11px;color:#999;margin-top:2px">Check if this event is driven by a character rather than the world. NPC events bypass the active event pool cap.</div>
                            </div>
                        </label>
                    </div>
                </div>
            `;

            // Reset temp variables
            window._nwstAddEventTitle = '';
            window._nwstAddEventDesc = '';
            window._nwstAddEventTier = 'undetermined';
            window._nwstAddEventScheduled = '';
            window._nwstAddEventResolution = '';
            window._nwstAddEventParticipants = '';
            window._nwstAddEventIsNPC = false;

            const result = await callGenericPopup(formHtml, POPUP_TYPE.TEXT, '', {
                okButton: 'Add event',
                cancelButton: 'Cancel',
            });

            if (result) {
                const title = window._nwstAddEventTitle?.trim() || 'New event';
                const description = window._nwstAddEventDesc?.trim() || 'No description provided.';
                const tier = window._nwstAddEventTier || 'undetermined';

                // The popup may already have removed its DOM after confirmation.
                const npcCheckbox = document.getElementById('nwst-add-event-isnpc');
                const isNPC = npcCheckbox ? npcCheckbox.checked : Boolean(window._nwstAddEventIsNPC);
                const scheduledDate = tier === 'persistent' ? null : (window._nwstAddEventScheduled?.trim() || null);
                const resolutionCondition = window._nwstAddEventResolution?.trim() || null;
                if (tier === 'persistent' && !resolutionCondition) {
                    nwstToast('Persistent events require an explicit resolution condition.', 'error');
                    return;
                }
                const participants = (window._nwstAddEventParticipants || '')
                    .split(',').map(name => name.trim()).filter(Boolean);
                if (isNPC && participants.length === 0) {
                    nwstToast('NPC events require at least one named participant.', 'error');
                    return;
                }
                await addEvent(chatId, {
                    title: title,
                    description: description,
                    tier: tier,
                    status: 'pending',
                    isNPC: isNPC,
                    npcOrigin: isNPC ? 'detected' : null,
                    origin: 'detected',
                    scheduledDate: scheduledDate,
                    resolutionCondition,
                    participants
                });
                refreshEventsUI();
                nwstToast(`Event "${title}" added (${tier}).`, 'success');
            }
        };
    }

    // ── Generate Events button ────────────────────────────────
    const regenAllBtn = document.getElementById('nwst-events-regenAll');
    if (regenAllBtn) {
        regenAllBtn.onclick = async () => {
            if (regenAllBtn.disabled) return;
            regenAllBtn.disabled = true;
            const originalText = regenAllBtn.textContent;
            regenAllBtn.textContent = 'Generating…';
            try {
                await regenerateAllEvents();
                refreshEventsUI();
            } finally {
                regenAllBtn.disabled = false;
                regenAllBtn.textContent = originalText;
            }
        };
    }

    // ── Tier Regen buttons ────────────────────────────────────
    container.querySelectorAll('.nwst-validity-keep').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const eventId = btn.dataset.eventId;
            await updateEvent(getChatId(), eventId, { validityFlag: null });
            nwstToast('Event kept — flag cleared.', 'success');
            refreshEventsUI();
        };
    });

    container.querySelectorAll('.nwst-validity-resolve').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const eventId = btn.dataset.eventId;
            const chatId = getChatId();
            await updateEvent(chatId, eventId, { validityFlag: null });
            await setEventStatus(chatId, eventId, 'resolved');
            nwstToast('Event marked resolved — it will compact into the notebook after the usual delay.', 'success');
            refreshEventsUI();
        };
    });

    container.querySelectorAll('.nwst-validity-miss').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const eventId = btn.dataset.eventId;
            const chatId = getChatId();
            await updateEvent(chatId, eventId, { validityFlag: null });
            await setEventStatus(chatId, eventId, 'missed');
            nwstToast('Event marked missed — it will compact into the notebook after the usual delay.', 'info');
            refreshEventsUI();
        };
    });

    // ── Persistent resolution evidence handlers ───────────────
    container.querySelectorAll('.nwst-persistent-keep').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            await updateEvent(getChatId(), btn.dataset.eventId, { persistentResolutionFlag: null });
            nwstToast('Persistent event kept — resolution evidence cleared.', 'info');
            refreshEventsUI();
        };
    });

    container.querySelectorAll('.nwst-persistent-resolve').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const chatId = getChatId();
            const eventId = btn.dataset.eventId;
            await updateEvent(chatId, eventId, { persistentResolutionFlag: null });
            await setEventStatus(chatId, eventId, 'resolved');
            nwstToast('Persistent event resolved from reviewed narrative evidence.', 'success');
            refreshEventsUI();
        };
    });

    // ── Timing proposal handlers ───────────────────────────────
    container.querySelectorAll('.nwst-timing-accept').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const eventId = btn.dataset.eventId;
            const chatId = getChatId();
            const ev = getAllEvents(chatId).find(x => x.id === eventId);
            if (!ev || !ev.timingFlag) return;
            const updates = { tier: ev.timingFlag.tier, timingFlag: null };
            if (ev.timingFlag.scheduledDate) updates.scheduledDate = ev.timingFlag.scheduledDate;
            // updateEvent stamps tierSetDay automatically on the tier change.
            await updateEvent(chatId, eventId, updates);
            nwstToast('Placement accepted — the calendar will move this event like any dated one.', 'success');
            refreshEventsUI();
        };
    });

    container.querySelectorAll('.nwst-timing-dismiss').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const eventId = btn.dataset.eventId;
            const chatId = getChatId();
            let dismissedElapsedDay = 0;
            try {
                const d = getCurrentDay(chatId);
                if (d && Number.isInteger(d.elapsedStoryDays)) dismissedElapsedDay = d.elapsedStoryDays;
            } catch (err) { /* non-fatal */ }
            await updateEvent(chatId, eventId, { timingFlag: null, timingDismissedElapsedDay: dismissedElapsedDay });
            nwstToast('Kept timeless — this proposal will rest for about a week of story days.', 'info');
            refreshEventsUI();
        };
    });

    // ── Promotion review handlers ──────────────────────────────
    container.querySelectorAll('.nwst-promo-accept').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const eventId = btn.dataset.eventId;
            const chatId = getChatId();
            btn.disabled = true;
            btn.textContent = 'Promoting…';
            // autoPromoted lets promoteEventToSecret() infer whoKnows /
            // whoDoesNotKnow via its knowledge-distribution LLM call.
            const secret = await promoteEventToSecret(chatId, eventId, { autoPromoted: true });
            if (!secret) {
                btn.disabled = false;
                btn.textContent = '🔒 Promote to secret';
                nwstToast('Promotion failed — event kept in the queue. See console for details.', 'error');
                return;
            }
            await removeEventWithSummary(chatId, eventId);
            nwstToast('Secret created — event summarized into the notebook and removed.', 'success');
            refreshEventsUI();
        };
    });

    container.querySelectorAll('.nwst-promo-deny').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const eventId = btn.dataset.eventId;
            await removeEventWithSummary(getChatId(), eventId);
            nwstToast('Event summarized into the notebook and removed.', 'info');
            refreshEventsUI();
        };
    });

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

    // ── Header time: click-to-edit inline ─────────────────────
    container.querySelectorAll('.nwst-event-time').forEach(el => {
        el.onclick = async function (e) {
            e.stopPropagation();
            const item = this.closest('.nwst-event-item');
            const eventId = item.getAttribute('data-event-id');
            const isEmpty = this.querySelector('.nwst-event-time-empty') !== null;
            const currentTime = isEmpty ? '' : this.textContent.trim();

            // Replace with inline input
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'nwst-event-time-input';
            input.value = currentTime;
            input.placeholder = 'e.g. Day 3, March 15...';
            input.style.width = '130px';

            this.replaceWith(input);
            input.focus();
            input.select();

            const saveTime = async () => {
                const chatId = getChatId();
                const val = input.value.trim();
                await updateEvent(chatId, eventId, { scheduledDate: val || null });
                refreshEventsUI();
            };

            input.onblur = saveTime;
            input.onkeydown = (ev) => {
                if (ev.key === 'Enter') { input.blur(); }
                if (ev.key === 'Escape') { refreshEventsUI(); }
            };
        };
    });

    container.querySelectorAll('.nwst-events-tier').forEach(select => {
        select.onchange = function () {
            const item = this.closest('.nwst-event-item');
            const persistent = this.value === 'persistent';
            const wrap = item?.querySelector('.nwst-events-resolution-wrap');
            const scheduled = item?.querySelector('.nwst-events-scheduled');
            if (wrap) wrap.style.display = persistent ? '' : 'none';
            if (scheduled) {
                scheduled.disabled = persistent;
                scheduled.style.opacity = persistent ? '.45' : '';
                if (persistent) scheduled.value = '';
            }
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

            const scheduledInput = item.querySelector('.nwst-events-scheduled');
            const npcCheckbox = item.querySelector('.nwst-events-isnpc');
            const participantsInput = item.querySelector('.nwst-events-participants');
            const resolutionInput = item.querySelector('.nwst-events-resolution');
            const current = getAllEvents(chatId).find(ev => ev.id === eventId);
            if (!current) {
                nwstToast('Could not save event: the event no longer exists.', 'error');
                refreshEventsUI();
                return;
            }

            // Only submit fields the player actually changed. The previous
            // editor re-sent tier + scheduledDate on every save, which let the
            // data layer silently reclassify a manual tier edit from the old
            // date and then still show a success toast.
            const updates = {};
            const nextDescription = descTextarea ? descTextarea.value : current.description;
            const nextTitle = titleInput ? (titleInput.value.trim() || 'Untitled event') : current.title;
            const nextTier = tierSelect ? tierSelect.value : current.tier;
            const nextScheduledDate = nextTier === 'persistent' ? null : (scheduledInput ? (scheduledInput.value.trim() || null) : (current.scheduledDate || null));
            const nextResolutionCondition = resolutionInput ? (resolutionInput.value.trim() || null) : (current.resolutionCondition || null);
            if (nextTier === 'persistent' && !nextResolutionCondition) {
                nwstToast('Persistent events require an explicit resolution condition.', 'error');
                return;
            }
            const nextIsNPC = npcCheckbox ? npcCheckbox.checked : !!current.isNPC;
            const normalizeEditorParticipants = values => {
                const out = [];
                const seen = new Set();
                for (const raw of (Array.isArray(values) ? values : [])) {
                    const name = String(raw || '').trim();
                    const key = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                    if (!name || !key || seen.has(key)) continue;
                    seen.add(key);
                    out.push(name);
                }
                return out;
            };
            const rawParticipants = participantsInput ? participantsInput.value.trim() : '';
            const nextParticipants = participantsInput
                ? normalizeEditorParticipants(rawParticipants ? rawParticipants.split(',') : [])
                : normalizeEditorParticipants(current.participants || []);

            if (nextIsNPC && nextParticipants.length === 0) {
                nwstToast('NPC events require at least one named participant.', 'error');
                return;
            }

            if (nextDescription !== (current.description || '')) updates.description = nextDescription;
            if (nextTitle !== (current.title || '')) updates.title = nextTitle;
            if (nextTier !== current.tier) updates.tier = nextTier;
            if (nextScheduledDate !== (current.scheduledDate || null)) updates.scheduledDate = nextScheduledDate;
            if (nextTier === 'persistent') {
                if (nextResolutionCondition !== (current.resolutionCondition || null)) updates.resolutionCondition = nextResolutionCondition;
            } else if (current.resolutionCondition) {
                updates.resolutionCondition = null;
                updates.persistentResolutionFlag = null;
            }
            if (nextIsNPC !== !!current.isNPC) {
                updates.isNPC = nextIsNPC;
                updates.npcOrigin = nextIsNPC ? (current.npcOrigin || 'generated') : null;
            }

            const currentParticipants = normalizeEditorParticipants(current.participants || []);
            const participantKey = arr => normalizeEditorParticipants(arr).join('\u0000');
            if (participantKey(nextParticipants) !== participantKey(currentParticipants)) {
                updates.participants = nextParticipants;
            }

            if (Object.keys(updates).length === 0) {
                nwstToast('No event changes to save.', 'info');
                return;
            }

            const saved = await updateEvent(chatId, eventId, updates);
            if (!saved) {
                nwstToast('Event save failed: the event could not be updated.', 'error');
                refreshEventsUI();
                return;
            }

            // Re-read persisted state before claiming success. This prevents a
            // false green toast if storage rejected the write or another rule
            // rewrote a player-edited value.
            const persisted = getAllEvents(chatId).find(ev => ev.id === eventId);
            const mismatches = [];
            if (!persisted) mismatches.push('event missing after save');
            else {
                if (updates.title !== undefined && persisted.title !== updates.title) mismatches.push('title');
                if (updates.description !== undefined && persisted.description !== updates.description) mismatches.push('description');
                if (updates.tier !== undefined && persisted.tier !== updates.tier) mismatches.push('tier');
                if (updates.scheduledDate !== undefined && (persisted.scheduledDate || null) !== updates.scheduledDate) mismatches.push('scheduled date');
                if (updates.resolutionCondition !== undefined && (persisted.resolutionCondition || null) !== updates.resolutionCondition) mismatches.push('resolution condition');
                if (updates.isNPC !== undefined && !!persisted.isNPC !== !!updates.isNPC) mismatches.push('NPC flag');
                if (updates.participants !== undefined && participantKey(persisted.participants || []) !== participantKey(updates.participants)) mismatches.push('participants');
            }

            refreshEventsUI();
            if (mismatches.length > 0) {
                console.warn('[NWST Events] Event save verification failed:', { eventId, mismatches, requested: updates, persisted });
                nwstToast(`Event save did not persist: ${mismatches.join(', ')}.`, 'error');
                return;
            }

            nwstToast('Event saved.', 'success');
        };
    });

    // ── Promote to Secret button ──────────────────────────────
    container.querySelectorAll('.nwst-events-promote').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const item = this.closest('.nwst-event-item');
            const eventId = item.getAttribute('data-event-id');
            const chatId = getChatId();
            const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();

            // Read current event data to pre-fill the form
            const events = getAllEvents(chatId);
            const event = events.find(ev => ev.id === eventId);
            if (!event) {
                nwstToast('Event not found.', 'error');
                return;
            }

            // Get existing secrets to check for duplicates
            const existingSecrets = getAllSecrets(chatId);
            const existingTitles = new Set(existingSecrets.map(s => s.title.toLowerCase()));

            const currentParticipants = (event.participants || []).join(', ');

            // ── Use globals to capture form values before popup closes ──
            // ST's POPUP_TYPE.TEXT destroys DOM elements on close, so
            // post-popup getElementById() returns null.  The same pattern
            // is used by the "Add Event" popup above.
            window._nwstPromoteSecretType = 'dramatic_irony';
            window._nwstPromoteWhoKnows = currentParticipants;
            window._nwstPromoteWhoNot = '';
            window._nwstPromoteSecretText = event.description || '';
            window._nwstPromoteReveal = '';

            const formHtml = `
                <div style="padding:10px;min-width:380px">
                    <div style="font-size:14px;font-weight:600;margin-bottom:12px">Promote Event to Secret</div>
                    <div style="font-size:12px;color:#999;margin-bottom:14px;line-height:1.5">
                        This will create a structured secret in the Notebook tracking who knows
                        about "${escapeHTML(event.title)}" and who doesn't. The secret will be
                        used by the narrative consistency monitor to enforce knowledge boundaries.
                    </div>
                    <div style="margin-bottom:12px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">Secret Type</label>
                        <select class="text_pole" style="width:100%"
                            onchange="window._nwstPromoteSecretType=this.value">
                            <option value="character">Character Secret</option>
                            <option value="dramatic_irony" selected>Dramatic Irony</option>
                            <option value="world">World Secret</option>
                            <option value="user_pc">User PC Secret</option>
                        </select>
                    </div>
                    <div style="margin-bottom:12px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">
                            Characters who KNOW <span style="color:#ccc;font-weight:normal">(comma-separated)</span>
                        </label>
                        <div style="display:flex;gap:6px;align-items:flex-start">
                            <textarea class="text_pole" rows="2" style="flex:1" id="nwst-promote-who-knows" placeholder="e.g. Seraphina, Kaelen"
                                oninput="window._nwstPromoteWhoKnows=this.value">${escapeHTML(currentParticipants)}</textarea>
                            <button class="editor_maximize nwst-expand-btn" data-for="nwst-promote-who-knows" style="margin-left:4px;font-size:14px;color:#aaa" title="Open in popout">⛶</button>
                        </div>
                    </div>
                    <div style="margin-bottom:12px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">
                            Characters who do NOT know <span style="color:#ccc;font-weight:normal">(comma-separated)</span>
                        </label>
                        <div style="display:flex;gap:6px;align-items:flex-start">
                            <input type="text" class="text_pole" style="flex:1" id="nwst-promote-who-not" placeholder="e.g. Lysander"
                                oninput="window._nwstPromoteWhoNot=this.value">
                            <button class="editor_maximize nwst-expand-btn" data-for="nwst-promote-who-not" style="margin-left:4px;font-size:14px;color:#aaa" title="Open in popout">⛶</button>
                        </div>
                    </div>
                    <div style="margin-bottom:12px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">
                            Secret description <span style="color:#ccc;font-weight:normal">(optional — overrides event description)</span>
                        </label>
                        <div style="display:flex;gap:6px;align-items:flex-start">
                            <textarea class="text_pole" rows="3" style="flex:1" id="nwst-promote-secret-text" placeholder="${escapeHTML(event.description || 'No description')}"
                                oninput="window._nwstPromoteSecretText=this.value">${escapeHTML(event.description || '')}</textarea>
                            <button class="editor_maximize nwst-expand-btn" data-for="nwst-promote-secret-text" style="margin-left:4px;font-size:14px;color:#aaa" title="Open in popout">⛶</button>
                        </div>
                    </div>
                    <div style="margin-bottom:8px">
                        <label style="display:block;font-size:12px;margin-bottom:4px;color:#999">
                            Reveal conditions <span style="color:#ccc;font-weight:normal">(optional)</span>
                        </label>
                        <div style="display:flex;gap:6px;align-items:flex-start">
                            <textarea class="text_pole" rows="2" style="flex:1" id="nwst-promote-reveal" placeholder="e.g. May be revealed when the unaware character discovers evidence..."
                                oninput="window._nwstPromoteReveal=this.value"></textarea>
                            <button class="editor_maximize nwst-expand-btn" data-for="nwst-promote-reveal" style="margin-left:4px;font-size:14px;color:#aaa" title="Open in popout">⛶</button>
                        </div>
                    </div>
                </div>
            `;

            const result = await callGenericPopup(formHtml, POPUP_TYPE.TEXT, '', {
                okButton: 'Promote',
                cancelButton: 'Cancel'
            });

            if (!result) return;

            // Read form values from globals (captured via oninput before popup closed)
            const whoKnows = (window._nwstPromoteWhoKnows || '')
                .split(',').map(s => s.trim()).filter(Boolean);
            const whoDoesNotKnow = (window._nwstPromoteWhoNot || '')
                .split(',').map(s => s.trim()).filter(Boolean);

            if (whoKnows.length === 0 && whoDoesNotKnow.length === 0) {
                nwstToast('Please specify at least one character who knows or doesn\'t know.', 'error');
                return;
            }

            // Auto-detect dramatic_irony type if there's asymmetry
            let secretType = window._nwstPromoteSecretType || 'dramatic_irony';
            if (whoKnows.length > 0 && whoDoesNotKnow.length > 0 && secretType === 'character') {
                secretType = 'dramatic_irony';
            }

            // Check for duplicate secret title
            const secretTitle = `✅ ${event.title}`;
            if (existingTitles.has(secretTitle.toLowerCase())) {
                nwstToast('A secret with this event title already exists.', 'warning');
                return;
            }

            const secretData = await promoteEventToSecret(chatId, eventId, {
                whoKnows: whoKnows,
                whoDoesNotKnow: whoDoesNotKnow,
                type: secretType,
                customSecret: {
                    secret: (window._nwstPromoteSecretText || '').trim() || event.description || '',
                    revealConditions: (window._nwstPromoteReveal || '').trim()
                }
            });

            if (secretData) {
                await removeEventWithSummary(chatId, eventId);
                nwstToast(`Event promoted to secret "${secretData.title}" and moved to Past Events.`, 'success');
                refreshEventsUI();
                // Refresh the notebook tab too so the new secret appears
                if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('notebook');
            } else {
                nwstToast('Failed to promote event to secret.', 'error');
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
