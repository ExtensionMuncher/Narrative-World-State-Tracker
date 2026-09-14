/* eslint-disable */
// =============================================================================
// NWST Pending Event Proposals UI
// =============================================================================
// Proposal review belongs to the Events tab. This module owns its rendering
// and approval/dismissal actions so generated proposals cannot be stranded in
// a different tab from the controls that created them.

import { getChatId, nwstToast } from '../index.js';
import { getChatData, setAllChatData } from '../data/storage.js';

function escapeHTML(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

export function buildPendingEventsSectionHTML() {
    return `
        <div id="nwst-pending-events-section" style="display:none;margin-bottom:14px">
            <div class="nwst-lbl" style="margin-bottom:6px">
                Pending event proposals
                <span class="nwst-badge nwst-badge-week" id="nwst-pending-events-count" style="text-transform:none;letter-spacing:0;font-weight:400;margin-left:6px"></span>
            </div>
            <div class="nwst-info-box" style="margin-bottom:8px">
                NWST proposed these events from recent chat or Generate Events. Approve any that should enter the event horizon, or dismiss them.
            </div>
            <div id="nwst-pending-events-list"></div>
            <div class="nwst-btn-row" style="margin-top:8px">
                <button class="menu_button nwst-btn-approve" id="nwst-approve-all-pending" style="font-size:13px;padding:7px 16px">Approve all</button>
                <button class="menu_button nwst-btn-danger" id="nwst-dismiss-all-pending">Dismiss all</button>
            </div>
        </div>`;
}

export function refreshPendingEvents() {
    const section = document.getElementById('nwst-pending-events-section');
    const list = document.getElementById('nwst-pending-events-list');
    const countBadge = document.getElementById('nwst-pending-events-count');
    if (!section || !list) return;

    let pending = [];
    try {
        const chatId = getChatId();
        pending = chatId ? (getChatData(chatId, 'pendingEvents') || []) : [];
    } catch (e) { /* non-fatal */ }

    section.style.display = pending.length ? 'block' : 'none';
    if (countBadge) countBadge.textContent = pending.length ? `${pending.length} pending` : '';
    if (!pending.length) {
        list.innerHTML = '';
        return;
    }

    list.innerHTML = pending.map(ev => {
        const tierLabel = ev.tier === 'immediate' ? 'Immediate' :
            ev.tier === 'week' ? 'This week' :
            ev.tier === 'month' ? 'This month' :
            ev.tier === 'persistent' ? 'Persistent' : 'Narratively Timed';
        const sourceLabel = ev.origin === 'generated' ? 'Generated' : 'Detected';
        const needsParticipantReview = ev.isNPC && (!Array.isArray(ev.participants) || ev.participants.length === 0);
        return `
        <div class="nwst-char-pending" style="margin-bottom:8px;border:0.5px solid #AFA9EC;border-radius:8px;overflow:hidden" data-pending-id="${escapeHTML(ev.id)}">
            <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--SmartThemeBlurTintColor,rgba(175,169,236,.14))">
                <span class="nwst-badge nwst-badge-week" style="flex-shrink:0">${escapeHTML(tierLabel)}</span>
                <span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:.4px">${escapeHTML(sourceLabel)}</span>
                ${needsParticipantReview ? '<span class="nwst-badge" style="background:rgba(212,154,61,.18);border:1px solid rgba(212,154,61,.65)" title="Participant completion failed; the event was preserved for review">⚠ Participant</span>' : ''}
                <span style="font-weight:500;font-size:13px;flex:1">${escapeHTML(ev.title)}</span>
            </div>
            <div style="padding:8px 12px;font-size:12px;line-height:1.5">${escapeHTML(ev.description)}${ev.scheduledDate ? `<div style="margin-top:5px;color:#999">Scheduled: ${escapeHTML(ev.scheduledDate)}</div>` : ''}${ev.tier === 'persistent' ? `<div style="margin-top:5px;color:#9a72c7"><b>Resolves when:</b> ${escapeHTML(ev.resolutionCondition || '(missing — approval blocked)')}</div>` : ''}${needsParticipantReview ? '<div style="margin-top:6px;color:#d49a3d;font-size:11px">No named participant was resolved. Approve to keep it, then add the participant below in Events.</div>' : ''}</div>
            <div class="nwst-btn-row" style="padding:6px 12px 10px">
                <button class="menu_button nwst-btn-approve nwst-approve-pending" data-pending-id="${escapeHTML(ev.id)}" style="font-size:12px">Approve</button>
                <button class="menu_button nwst-btn nwst-dismiss-pending" data-pending-id="${escapeHTML(ev.id)}" style="font-size:12px">Dismiss</button>
            </div>
        </div>`;
    }).join('');
}

export function wirePendingEvents() {
    const section = document.getElementById('nwst-pending-events-section');
    if (!section || section.dataset.nwstPendingWired) return;
    section.dataset.nwstPendingWired = '1';

    section.addEventListener('click', async event => {
        const target = event.target instanceof Element ? event.target : null;
        const approve = target?.closest('.nwst-approve-pending');
        const dismiss = target?.closest('.nwst-dismiss-pending');
        if (approve || dismiss) {
            event.preventDefault();
            const id = (approve || dismiss).getAttribute('data-pending-id');
            if (id) await (approve ? approvePendingEvent(id) : dismissPendingEvent(id));
            return;
        }

        if (target?.closest('#nwst-approve-all-pending')) {
            event.preventDefault();
            await approveAllPending();
            return;
        }

        if (target?.closest('#nwst-dismiss-all-pending')) {
            event.preventDefault();
            const ctx = SillyTavern.getContext();
            const chatId = getChatId();
            const pending = chatId ? (getChatData(chatId, 'pendingEvents') || []) : [];
            if (!pending.length) return;
            const confirmed = await ctx.callGenericPopup(
                `Dismiss all ${pending.length} pending event proposal(s)? Detected or generated events may be proposed again later.`,
                ctx.POPUP_TYPE.CONFIRM, ''
            );
            if (confirmed && getChatId() === chatId) await dismissAllPending(chatId, pending);
        }
    });
}

async function approvePendingEvent(pendingId) {
    try {
        const ctx = SillyTavern.getContext();
        const pending = getChatData(getChatId(), 'pendingEvents') || [];
        const ev = pending.find(item => item.id === pendingId);
        if (!ev) return;

        const chatId = getChatId();
        const { buildEventRecord, getAllEvents, getActivePoolEvents, getActivePersistentEvents, getStructuralTierForScheduledDate, notifyHiddenIntentionsOfEventChange, MAX_ACTIVE_PERSISTENT_EVENTS } = await import('../data/events.js');
        const { getMaxActiveEvents } = await import('../settings.js');
        const expectedData = { events: getAllEvents(chatId), pendingEvents: pending };
        const isDetected = ev.origin === 'detected' || ev.npcOrigin === 'detected';
        const poolCap = getMaxActiveEvents();
        const currentActive = getActivePoolEvents(chatId).length;
        const currentPersistent = getActivePersistentEvents(chatId).length;
        const isPersistent = ev.tier === 'persistent';
        const proposalTier = ev.scheduledDate ? getStructuralTierForScheduledDate(chatId, ev.scheduledDate).tier : null;

        if (isPersistent && !String(ev.resolutionCondition || '').trim()) {
            nwstToast('Persistent proposals require an explicit resolution condition before approval.', 'warning');
            return;
        }
        if (isPersistent && currentPersistent >= MAX_ACTIVE_PERSISTENT_EVENTS) {
            nwstToast(`Persistent event cap is full (${MAX_ACTIVE_PERSISTENT_EVENTS}). Resolve, replace, or remove one first.`, 'warning');
            return;
        }
        if (!isPersistent && !isDetected && proposalTier !== 'future' && currentActive >= poolCap) {
            nwstToast(`Event pool is full (${poolCap} active events). Resolve or dismiss existing events first.`, 'warning');
            return;
        }

        let preparedEvent = ev;
        if (ev.isNPC && (!Array.isArray(ev.participants) || !ev.participants.length)) {
            const { completeEventParticipants } = await import('../llm/eventParticipants.js');
            const completed = await completeEventParticipants(chatId, [{ ...ev, isNPC: true }], {});
            preparedEvent = completed.events[0] || ev;
        }
        if (getChatId() !== chatId) throw new Error('Active chat changed while approving the proposal.');
        const needsParticipantReview = preparedEvent.isNPC && (!Array.isArray(preparedEvent.participants) || !preparedEvent.participants.length);

        const newEvent = buildEventRecord(chatId, {
            title: preparedEvent.title,
            description: preparedEvent.description,
            tier: preparedEvent.tier || 'undetermined',
            status: 'pending',
            isNPC: Boolean(preparedEvent.isNPC),
            npcOrigin: preparedEvent.isNPC ? (preparedEvent.npcOrigin || (isDetected ? 'detected' : 'generated')) : null,
            origin: isDetected ? 'detected' : 'generated',
            scheduledDate: preparedEvent.tier === 'persistent' ? null : (preparedEvent.scheduledDate || null),
            resolutionCondition: preparedEvent.tier === 'persistent' ? (preparedEvent.resolutionCondition || null) : null,
            participants: Array.isArray(preparedEvent.participants) ? preparedEvent.participants : [],
            sourceIntentionIds: Array.isArray(preparedEvent.sourceIntentionIds) ? preparedEvent.sourceIntentionIds : []
        });

        await setAllChatData(chatId, {
            events: [...getAllEvents(chatId), newEvent],
            pendingEvents: pending.filter(item => item.id !== pendingId)
        }, expectedData);
        try {
            await notifyHiddenIntentionsOfEventChange(chatId, newEvent, 'An event was added or approved.');
        } catch (notifyError) {
            console.warn('[NWST Events] Event approved, but Hidden Intentions notification failed:', notifyError);
        }
        nwstToast(needsParticipantReview
            ? `Event added: "${ev.title}". It still needs a named participant; review it in Events.`
            : `Event added: "${ev.title}"`, needsParticipantReview ? 'warning' : 'success');
        refreshPendingEvents();
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'events');
    } catch (err) {
        console.error('[NWST Events] approvePendingEvent failed:', err);
        nwstToast('Could not approve that proposal. Check the console.', 'error');
    }
}

async function dismissPendingEvent(pendingId) {
    try {
        const chatId = getChatId();
        const pending = getChatData(chatId, 'pendingEvents') || [];
        await setAllChatData(chatId, { pendingEvents: pending.filter(item => item.id !== pendingId) }, { pendingEvents: pending });
        refreshPendingEvents();
    } catch (err) {
        console.error('[NWST Events] dismissPendingEvent failed:', err);
        nwstToast('Could not dismiss that proposal. Check the console.', 'error');
    }
}

async function approveAllPending() {
    try {
        const ctx = SillyTavern.getContext();
        const pending = [...(getChatData(getChatId(), 'pendingEvents') || [])];
        if (!pending.length) return;

        const chatId = getChatId();
        const { buildEventRecord, getAllEvents, getActivePoolEvents, getActivePersistentEvents, getStructuralTierForScheduledDate, notifyHiddenIntentionsOfEventChange, MAX_ACTIVE_PERSISTENT_EVENTS } = await import('../data/events.js');
        const { getMaxActiveEvents } = await import('../settings.js');
        const expectedData = { events: getAllEvents(chatId), pendingEvents: pending };
        const { completeEventParticipants } = await import('../llm/eventParticipants.js');
        const poolCap = getMaxActiveEvents();
        let currentActive = getActivePoolEvents(chatId).length;
        let currentPersistent = getActivePersistentEvents(chatId).length;
        let added = 0;
        let participantWarnings = 0;
        let poolCapCount = 0;
        let persistentCapCount = 0;
        let missingPersistentConditionCount = 0;
        const remaining = [];
        const events = getAllEvents(chatId);
        const completed = await completeEventParticipants(chatId, pending, {});
        if (getChatId() !== chatId) throw new Error('Active chat changed while approving proposals.');

        for (const ev of completed.events) {
            const isDetected = ev.origin === 'detected' || ev.npcOrigin === 'detected';
            const isPersistent = ev.tier === 'persistent';
            const proposalTier = ev.scheduledDate ? getStructuralTierForScheduledDate(chatId, ev.scheduledDate).tier : null;
            if (isPersistent && !String(ev.resolutionCondition || '').trim()) {
                missingPersistentConditionCount++;
                remaining.push(ev);
                continue;
            }
            if (isPersistent && currentPersistent >= MAX_ACTIVE_PERSISTENT_EVENTS) {
                persistentCapCount++;
                remaining.push(ev);
                continue;
            }
            if (!isPersistent && !isDetected && proposalTier !== 'future' && currentActive >= poolCap) {
                poolCapCount++;
                remaining.push(ev);
                continue;
            }
            const needsParticipantReview = ev.isNPC && (!Array.isArray(ev.participants) || !ev.participants.length);
            const addedEvent = buildEventRecord(chatId, {
                title: ev.title,
                description: ev.description,
                tier: ev.tier || 'undetermined',
                status: 'pending',
                isNPC: Boolean(ev.isNPC),
                npcOrigin: ev.isNPC ? (ev.npcOrigin || (isDetected ? 'detected' : 'generated')) : null,
                origin: isDetected ? 'detected' : 'generated',
                scheduledDate: isPersistent ? null : (ev.scheduledDate || null),
                resolutionCondition: isPersistent ? (ev.resolutionCondition || null) : null,
                participants: Array.isArray(ev.participants) ? ev.participants : [],
                sourceIntentionIds: Array.isArray(ev.sourceIntentionIds) ? ev.sourceIntentionIds : []
            });
            events.push(addedEvent);
            if (addedEvent?.tier === 'persistent') currentPersistent++;
            else if (addedEvent?.tier !== 'future') currentActive++;
            if (needsParticipantReview) participantWarnings++;
            added++;
        }

        await setAllChatData(chatId, { events, pendingEvents: remaining }, expectedData);
        if (added > 0) {
            for (const event of events.slice(-added)) {
                try {
                    await notifyHiddenIntentionsOfEventChange(chatId, event, 'An event was added or approved.');
                } catch (notifyError) {
                    console.warn('[NWST Events] Event approved, but Hidden Intentions notification failed:', notifyError);
                }
            }
        }
        if (remaining.length || participantWarnings) {
            const notes = [];
            if (poolCapCount) notes.push(`${poolCapCount} blocked by the event pool cap`);
            if (persistentCapCount) notes.push(`${persistentCapCount} blocked by the Persistent cap`);
            if (missingPersistentConditionCount) notes.push(`${missingPersistentConditionCount} Persistent proposal(s) missing resolution conditions`);
            if (participantWarnings) notes.push(`${participantWarnings} approved NPC event(s) still need named participants`);
            nwstToast(`${added} event(s) approved. ${notes.join('; ')}.`, 'warning');
        } else {
            nwstToast(`${added} event(s) approved.`, 'success');
        }
        refreshPendingEvents();
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'events');
    } catch (err) {
        console.error('[NWST Events] approveAllPending failed:', err);
        nwstToast('Could not approve all proposals. Check the console.', 'error');
    }
}

async function dismissAllPending(chatId, pending) {
    try {
        await setAllChatData(chatId, { pendingEvents: [] }, { pendingEvents: pending });
        refreshPendingEvents();
        nwstToast('All pending events dismissed.', 'info');
    } catch (err) {
        console.error('[NWST Events] dismissAllPending failed:', err);
        nwstToast('Could not dismiss all proposals. Check the console.', 'error');
    }
}
