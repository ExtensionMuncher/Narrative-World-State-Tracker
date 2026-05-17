/* eslint-disable */
// =============================================================================
// NWST World State Tab UI — ui/worldState.js
// =============================================================================
// Builds and manages the World State tab pane. Matches nwst-mockup.html.
//
// Layout:
//   • Four world condition rows with eye toggles (Political, Social,
//     Spiritual/Supernatural, Environmental)
//   • Each condition: icon, label, eye toggle, edit pencil, expandable body
//   • Eye-off = muted row, no tracking, not injected
//   • Community summaries section with avatar entries
// =============================================================================

import { getChatId, nwstToast } from '../index.js';
import {
    getConditions,
    updateConditionContent,
    toggleConditionEnabled,
    getSettingContext
} from '../data/worldState.js';
import {
    getAllCommunities,
    addCommunity, updateCommunity, deleteCommunity,
    updateCommunitySummary
} from '../data/communities.js';
import { isInjectWorldConditions } from '../settings.js';

// ── Condition definitions ─────────────────────────────────────────────────

const CONDITION_DEFS = [
    { key: 'political', label: 'Political', icon: '⚖️' },
    { key: 'social', label: 'Social', icon: '👥' },
    { key: 'spiritual', label: 'Spiritual / Supernatural', icon: '🌀', optional: true },
    { key: 'environmental', label: 'Environmental', icon: '🍂' }
];

// ── Build the World State tab HTML ────────────────────────────────────────

export function buildWorldStateTab() {
    const pane = document.getElementById('nwst-pane-world');
    if (!pane) return;

    pane.innerHTML = `
        <div class="nwst-lbl">Active world conditions</div>
        <div style="font-size:11px;color:#999;margin-bottom:12px;line-height:1.5">
            Toggle the eye icon to enable or disable tracking and injection for each condition.
            Disabled conditions are not tracked by the planner LLM and are not injected into your main prompt.
        </div>

        <!-- Condition rows container -->
        <div id="nwst-conditions-container"></div>

        <div class="nwst-div"></div>

        <!-- Community summaries -->
        <div class="nwst-info-box">
            Community summaries are internal only — they are never injected into your main prompt.
            They exist to help the planner LLM understand social dynamics and offscreen pressures
            when updating world conditions and events.
        </div>
        <div class="nwst-lbl">Community summaries</div>
        <div id="nwst-communities-container"></div>
        <div style="margin-top:6px">
            <button class="menu_button nwst-btn" id="nwst-community-add">+ Add community</button>
        </div>
    `;

    refreshWorldStateUI();
    wireWorldStateEvents();
}

// ── Refresh ───────────────────────────────────────────────────────────────

export function refreshWorldStateUI() {
    refreshConditionsUI();
    refreshCommunitiesUI();
}

// ── Conditions UI ─────────────────────────────────────────────────────────

function refreshConditionsUI() {
    const container = document.getElementById('nwst-conditions-container');
    if (!container) return;

    const chatId = getChatId();
    const conditions = getConditions(chatId);

    let html = '';
    for (const def of CONDITION_DEFS) {
        const condition = conditions[def.key] || { enabled: true, content: '' };
        const mutedClass = condition.enabled ? '' : ' nwst-muted';
        const eyeActiveClass = condition.enabled ? ' nwst-active' : '';
        const openClass = condition.content ? ' nwst-open' : '';

        html += `
        <div class="nwst-condition-row${mutedClass}${openClass}" id="nwst-cond-${def.key}">
            <div class="nwst-condition-hdr">
                <span style="font-size:15px">${def.icon}</span>
                <div class="nwst-condition-label">
                    ${def.label}
                    ${def.optional ? '<span style="font-size:10px;font-weight:400;color:#aaa"> — optional</span>' : ''}
                </div>
                <div class="nwst-btn-row">
                    <button class="menu_button nwst-icon-btn nwst-cond-eye${eyeActiveClass}" data-cond="${def.key}" title="Toggle tracking">👁</button>
                    <button class="menu_button nwst-icon-btn nwst-cond-edit" data-cond="${def.key}" title="Edit">✎</button>
                </div>
            </div>
            <!-- View mode -->
            <div class="nwst-condition-body" id="nwst-cond-${def.key}-view">
                ${condition.content
                    ? `<div>${escapeHTML(condition.content)}</div>
                       <div class="nwst-btn-row" style="margin-top:8px">
                           <button class="menu_button nwst-btn nwst-cond-edit-btn" data-cond="${def.key}">Edit</button>
                       </div>`
                    : '<div class="nwst-nb-empty">No content yet. Click ✎ to add.</div>'}
            </div>
            <!-- Edit mode (hidden) -->
            <div class="nwst-condition-body" id="nwst-cond-${def.key}-edit" style="display:none">
                <textarea id="nwst-cond-${def.key}-textarea" rows="4" style="margin-bottom:8px">${escapeHTML(condition.content)}</textarea>
                <div class="nwst-btn-row">
                    <button class="menu_button nwst-btn nwst-cond-save" data-cond="${def.key}">Save</button>
                    <button class="menu_button nwst-btn nwst-cond-cancel" data-cond="${def.key}">Cancel</button>
                    <button class="editor_maximize nwst-expand-btn nwst-cond-popout" data-for="nwst-cond-${def.key}-textarea" style="margin-left:4px;font-size:14px;color:#aaa" title="Open in popout">⛶</button>
                </div>
            </div>
        </div>`;
    }

    container.innerHTML = html;

    // Wire condition-specific events
    wireConditionEvents();
}

function wireConditionEvents() {
    // ── Eye toggle ─────────────────────────────────────────────
    document.querySelectorAll('.nwst-cond-eye').forEach(btn => {
        btn.onclick = function () {
            const condKey = this.getAttribute('data-cond');
            const chatId = getChatId();
            const nowEnabled = toggleConditionEnabled(chatId, condKey);
            this.classList.toggle('nwst-active', nowEnabled);
            const row = document.getElementById(`nwst-cond-${condKey}`);
            if (row) row.classList.toggle('nwst-muted', !nowEnabled);
            nwstToast(`${CONDITION_DEFS.find(d => d.key === condKey)?.label || condKey}: ${nowEnabled ? 'Tracking enabled' : 'Tracking disabled'}.`, 'info');
        };
    });

    // ── Edit pencil ────────────────────────────────────────────
    document.querySelectorAll('.nwst-cond-edit, .nwst-cond-edit-btn').forEach(btn => {
        btn.onclick = function () {
            const condKey = this.getAttribute('data-cond');
            toggleConditionEdit(condKey, true);
        };
    });

    // ── Save ──────────────────────────────────────────────────
    document.querySelectorAll('.nwst-cond-save').forEach(btn => {
        btn.onclick = function () {
            const condKey = this.getAttribute('data-cond');
            const textarea = document.getElementById(`nwst-cond-${condKey}-textarea`);
            if (textarea) {
                const chatId = getChatId();
                updateConditionContent(chatId, condKey, textarea.value);
                toggleConditionEdit(condKey, false);
                refreshConditionsUI();
                nwstToast(`${CONDITION_DEFS.find(d => d.key === condKey)?.label} saved.`, 'success');
            }
        };
    });

    // ── Cancel ────────────────────────────────────────────────
    document.querySelectorAll('.nwst-cond-cancel').forEach(btn => {
        btn.onclick = function () {
            const condKey = this.getAttribute('data-cond');
            toggleConditionEdit(condKey, false);
            refreshConditionsUI();
        };
    });

}

function toggleConditionEdit(condKey, showEdit) {
    const view = document.getElementById(`nwst-cond-${condKey}-view`);
    const edit = document.getElementById(`nwst-cond-${condKey}-edit`);
    if (view && edit) {
        view.style.display = showEdit ? 'none' : 'block';
        edit.style.display = showEdit ? 'block' : 'none';
    }
}

// ── Communities UI ─────────────────────────────────────────────────────────

function refreshCommunitiesUI() {
    const container = document.getElementById('nwst-communities-container');
    if (!container) return;

    const chatId = getChatId();
    const communities = getAllCommunities(chatId);

    if (communities.length === 0) {
        container.innerHTML = '<div class="nwst-nb-empty">No communities yet. Add one below or run a batch scan to auto-detect them.</div>';
        return;
    }

    let html = '';
    for (const com of communities) {
        html += `
        <div class="nwst-community-entry nwst-open" data-community-id="${com.id}">
            <div class="nwst-community-hdr nwst-community-toggle">
                <div class="nwst-community-av" style="background:${com.avatarColors?.bg || '#EEEDFE'};color:${com.avatarColors?.text || '#3C3489'}">${escapeHTML(com.avatarInitials || '??')}</div>
                <div style="flex:1">
                    <div style="font-weight:500;font-size:13px">${escapeHTML(com.name)}</div>
                    <div style="font-size:11px;color:#999">${escapeHTML(com.members || 'No members listed')}</div>
                </div>
                <span style="font-size:11px;color:#999">▾</span>
            </div>
            <div class="nwst-community-body">
                <div class="nwst-community-summary-text">${escapeHTML(com.summary || 'No summary yet.')}</div>
                <div class="nwst-community-edit-area" style="display:none;margin-top:8px">
                    <textarea class="nwst-community-textarea" rows="3" style="margin-bottom:8px" id="nwst-community-textarea-${com.id}">${escapeHTML(com.summary || '')}</textarea>
                    <div class="nwst-btn-row">
                        <button class="menu_button nwst-btn nwst-community-save">Save</button>
                        <button class="menu_button nwst-btn nwst-community-cancel">Cancel</button>
                        <button class="menu_button nwst-btn-danger nwst-community-delete">Delete</button>
                        <button class="editor_maximize nwst-expand-btn nwst-community-popout" data-for="nwst-community-textarea-${com.id}" style="margin-left:4px;font-size:14px;color:#aaa" title="Open in popout">⛶</button>
                    </div>
                </div>
                <div class="nwst-btn-row" style="margin-top:8px">
                    <button class="menu_button nwst-btn nwst-community-edit-btn">Edit</button>
                </div>
            </div>
        </div>`;
    }

    container.innerHTML = html;

    // Wire community events
    wireCommunityEvents();
}

// ── Wire community and global events ──────────────────────────────────────

function wireCommunityEvents() {
    // ── Expand/collapse toggle ─────────────────────────────────
    document.querySelectorAll('.nwst-community-toggle').forEach(hdr => {
        hdr.onclick = function () {
            this.closest('.nwst-community-entry').classList.toggle('nwst-open');
        };
    });

    // ── Edit button ───────────────────────────────────────────
    document.querySelectorAll('.nwst-community-edit-btn').forEach(btn => {
        btn.onclick = function (e) {
            e.stopPropagation();
            const entry = this.closest('.nwst-community-entry');
            entry.querySelector('.nwst-community-summary-text').style.display = 'none';
            entry.querySelector('.nwst-community-edit-area').style.display = 'block';
            this.closest('.nwst-btn-row').style.display = 'none';
        };
    });

    // ── Save ──────────────────────────────────────────────────
    document.querySelectorAll('.nwst-community-save').forEach(btn => {
        btn.onclick = function (e) {
            e.stopPropagation();
            const entry = this.closest('.nwst-community-entry');
            const comId = entry.getAttribute('data-community-id');
            const textarea = entry.querySelector('.nwst-community-textarea');
            if (textarea) {
                const chatId = getChatId();
                updateCommunitySummary(chatId, comId, textarea.value);
                refreshCommunitiesUI();
                nwstToast('Community summary saved.', 'success');
            }
        };
    });

    // ── Cancel ────────────────────────────────────────────────
    document.querySelectorAll('.nwst-community-cancel').forEach(btn => {
        btn.onclick = function (e) {
            e.stopPropagation();
            refreshCommunitiesUI();
        };
    });

    // ── Delete ────────────────────────────────────────────────
    document.querySelectorAll('.nwst-community-delete').forEach(btn => {
        btn.onclick = function (e) {
            e.stopPropagation();
            const entry = this.closest('.nwst-community-entry');
            const comId = entry.getAttribute('data-community-id');
            const chatId = getChatId();
            deleteCommunity(chatId, comId);
            refreshCommunitiesUI();
            nwstToast('Community deleted.', 'info');
        };
    });

}

function wireWorldStateEvents() {
    // Add community button
    const addBtn = document.getElementById('nwst-community-add');
    if (addBtn) {
        addBtn.onclick = () => {
            const chatId = getChatId();
            addCommunity(chatId, {
                name: 'New Community',
                members: '',
                summary: ''
            });
            refreshCommunitiesUI();
            nwstToast('Community added. Edit to set name, members, and summary.', 'info');
        };
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
