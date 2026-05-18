/* eslint-disable */
// =============================================================================
// NWST World State Tab UI — ui/worldState.js
// =============================================================================
// Builds and manages the World State tab pane. Matches nwst-mockup.html.
//
// Layout:
//   • Four world condition rows with eye toggles (Political, Social,
//     Spiritual/Supernatural, Environmental)
//   • Each condition: icon, label, eye toggle, edit pencil, expandable body,
//     and a Regen button that calls the Planning LLM to regenerate content
//   • Eye-off = muted row, no tracking, not injected
//   • Community summaries section with avatar entries
//   • Each community: name, members list, summary text, Edit button,
//     Regen button, editable name/members/summary fields
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
import { resolveProfile, generateWithProfile } from '../llm/connections.js';

// ── Dedicated system prompt for single-condition regeneration ──────────────
// This is a focused, lighter version of the scanner's condition prompt.
// It asks the LLM to regenerate a single world condition's atmospheric narrative
// based on recent chat messages and current world context.

const CONDITION_REGEN_SYSTEM_PROMPT = `You are a narrative world state analyst for an ongoing roleplay. Your task is to regenerate the content for ONE specific world condition based on recent chat messages.

A world condition is an ATMOSPHERIC NARRATIVE — it describes the current mood, subtext, and implications of a particular aspect of the world. It is NOT a factual summary or character action list.

Guidelines:
- Describe the condition's CURRENT MOOD, SUBTEXT, and IMPLICATIONS — not just facts
- Read the space between what is stated and what is left unsaid
- Convey tension, movement, or stasis with specificity and texture
- Sound like a thoughtful narrator interpreting the world, not a journalist listing events
- NEVER mention specific named characters. World conditions describe the macro state of the world.
- Be concise but evocative — 2-4 sentences typically

Respond with ONLY the condition content text. Do NOT include JSON, markdown fences, labels, or extra commentary. Just the atmospheric narrative text.`;

// ── Dedicated system prompt for single-community summary regeneration ──────
// Focuses the LLM on producing a rich, analytical summary for one community.

const COMMUNITY_REGEN_SYSTEM_PROMPT = `You are a community analyst for a narrative roleplay. Your task is to regenerate the summary for ONE specific community based on recent chat messages.

Your summaries are not plot recaps. They are analytical portraits of a group — what the characters are maneuvering around, what they want and can't say, how they relate to each other beneath the surface.

Guidelines:
- Surface the SUBTEXT, not just the events
- Identify POWER DYNAMICS — who holds leverage, who is vulnerable
- Note SPECIFIC DETAILS that carry symbolic or narrative weight
- Describe INTERNAL TENSIONS within the group
- Be dense with insight — 3-5 sentences typically

Respond with ONLY the summary text. Do NOT include JSON, markdown fences, labels, or extra commentary. Just the analytical summary.`;

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
                <span style="font-size:11px;color:#999;margin-left:-4px;margin-right:4px">▾</span>
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
                           <button class="menu_button nwst-btn-regen nwst-cond-regen" data-cond="${def.key}" title="Regenerate with Planning LLM">↺ Regen</button>
                       </div>`
                    : '<div class="nwst-nb-empty">No content yet. Click ✎ to add or use ↺ Regen.</div>'}
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
        btn.onclick = async function (e) {
            e.stopPropagation();
            const condKey = this.getAttribute('data-cond');
            const chatId = getChatId();
            const nowEnabled = await toggleConditionEnabled(chatId, condKey);
            this.classList.toggle('nwst-active', nowEnabled);
            const row = document.getElementById(`nwst-cond-${condKey}`);
            if (row) row.classList.toggle('nwst-muted', !nowEnabled);
            nwstToast(`${CONDITION_DEFS.find(d => d.key === condKey)?.label || condKey}: ${nowEnabled ? 'Tracking enabled' : 'Tracking disabled'}.`, 'info');
        };
    });

    // ── Edit pencil ────────────────────────────────────────────
    document.querySelectorAll('.nwst-cond-edit').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const condKey = this.getAttribute('data-cond');
            toggleConditionEdit(condKey, true);
        };
    });

    // ── Save ──────────────────────────────────────────────────
    document.querySelectorAll('.nwst-cond-save').forEach(btn => {
        btn.onclick = async function () {
            const condKey = this.getAttribute('data-cond');
            const textarea = document.getElementById(`nwst-cond-${condKey}-textarea`);
            if (textarea) {
                const chatId = getChatId();
                await updateConditionContent(chatId, condKey, textarea.value);
                toggleConditionEdit(condKey, false);
                refreshConditionsUI();
                nwstToast(`${CONDITION_DEFS.find(d => d.key === condKey)?.label} saved.`, 'success');
            }
        };
    });

    // ── Cancel ────────────────────────────────────────────────
    document.querySelectorAll('.nwst-cond-cancel').forEach(btn => {
        btn.onclick = async function () {
            const condKey = this.getAttribute('data-cond');
            toggleConditionEdit(condKey, false);
            refreshConditionsUI();
        };
    });

    // ── Condition Regen ───────────────────────────────────────
    document.querySelectorAll('.nwst-cond-regen').forEach(btn => {
        btn.onclick = async function () {
            const condKey = this.getAttribute('data-cond');
            const def = CONDITION_DEFS.find(d => d.key === condKey);
            if (!def) return;
            await regenCondition(condKey, def.label);
        };
    });

    // ── Accordion collapse/expand toggle ─────────────────────
    document.querySelectorAll('.nwst-condition-hdr').forEach(hdr => {
        hdr.onclick = async function () {
            const row = this.closest('.nwst-condition-row');
            if (row) row.classList.toggle('nwst-open');
        };
    });

}

// ── Condition Regeneration via LLM ─────────────────────────────────────────

/**
 * Call the Planning LLM to regenerate a single world condition's content.
 * @param {string} condKey - 'political' | 'social' | 'spiritual' | 'environmental'
 * @param {string} condLabel - Human-readable label (e.g. 'Political')
 */
async function regenCondition(condKey, condLabel) {
    const chatId = getChatId();
    if (!chatId) return;

    // Resolve planning LLM profile
    const profile = resolveProfile('planningLLM');
    if (!profile) {
        nwstToast('No Planning LLM profile configured. Set one in Settings > Connections.', 'warning');
        return;
    }

    // Gather context
    const conditions = getConditions(chatId);
    const currentContent = conditions[condKey]?.content || '';
    const settingContext = getSettingContext(chatId);
    const recentMessages = getRecentChatMessages(10);

    // Build user prompt
    let userPrompt = `Regenerate the "${condLabel}" world condition.\n\n`;
    userPrompt += `=== CONDITION TO REGENERATE ===\n`;
    userPrompt += `Key: ${condKey}\n`;
    userPrompt += `Label: ${condLabel}\n`;
    userPrompt += `Current content: ${currentContent || '(empty)'}\n\n`;

    if (settingContext) {
        userPrompt += `=== SETTING CONTEXT ===\n${settingContext}\n\n`;
    }

    if (recentMessages.length > 0) {
        userPrompt += `=== RECENT CHAT MESSAGES ===\n`;
        for (const msg of recentMessages) {
            const sender = msg.name || (msg.is_user ? 'User' : 'Character');
            userPrompt += `[${sender}]: ${msg.mes}\n`;
        }
        userPrompt += '\n';
    }

    userPrompt += `Write a compelling atmospheric narrative for the "${condLabel}" condition based on the recent events. Remember: no named characters, just the macro state of the world.`;

    // Show loading state
    const row = document.getElementById(`nwst-cond-${condKey}`);
    if (row) row.classList.add('nwst-loading');

    try {
        const messages = [
            { role: 'system', content: CONDITION_REGEN_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, messages);
        if (!response || !response.trim()) {
            nwstToast('LLM returned empty response for condition regen.', 'error');
            return;
        }

        const newContent = response.trim();
        await updateConditionContent(chatId, condKey, newContent);
        refreshConditionsUI();
        nwstToast(`${condLabel} condition regenerated.`, 'success');

    } catch (err) {
        console.error(`[NWST] Condition regen failed for ${condKey}:`, err);
        nwstToast(`Failed to regenerate ${condLabel} condition.`, 'error');
    } finally {
        if (row) row.classList.remove('nwst-loading');
    }
}

/**
 * Get the N most recent non-system chat messages.
 * @param {number} count
 * @returns {object[]}
 */
function getRecentChatMessages(count) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const visible = chat.filter(msg => {
            if (msg.is_system && msg.extra?.hidden) return false;
            if (msg.extra?.display === 'none') return false;
            return true;
        });
        return visible.slice(-count);
    } catch (e) {
        return [];
    }
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
                    <div style="margin-bottom:8px">
                        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:2px">Community name</label>
                        <input type="text" class="text_pole nwst-community-name-input" style="width:100%" value="${escapeHTML(com.name)}"
                            placeholder="e.g. The King's Court">
                    </div>
                    <div style="margin-bottom:8px">
                        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:2px">Members (comma-separated character names)</label>
                        <input type="text" class="text_pole nwst-community-members-input" style="width:100%" value="${escapeHTML(com.members)}"
                            placeholder="e.g. Sukuna, Uraume, Kenjaku">
                    </div>
                    <div style="margin-bottom:8px">
                        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:2px">Summary</label>
                        <textarea class="nwst-community-textarea" rows="3" style="width:100%" id="nwst-community-textarea-${com.id}">${escapeHTML(com.summary || '')}</textarea>
                    </div>
                    <div class="nwst-btn-row">
                        <button class="menu_button nwst-btn nwst-community-save">Save</button>
                        <button class="menu_button nwst-btn nwst-community-cancel">Cancel</button>
                        <button class="menu_button nwst-btn-danger nwst-community-delete">Delete</button>
                    </div>
                </div>
                <div class="nwst-btn-row" style="margin-top:8px">
                    <button class="menu_button nwst-btn nwst-community-edit-btn">Edit</button>
                    <button class="menu_button nwst-btn-regen nwst-community-regen" data-community-id="${com.id}" title="Regenerate summary with Planning LLM">↺ Regen</button>
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
        hdr.onclick = async function () {
            this.closest('.nwst-community-entry').classList.toggle('nwst-open');
        };
    });

    // ── Edit button ───────────────────────────────────────────
    document.querySelectorAll('.nwst-community-edit-btn').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const entry = this.closest('.nwst-community-entry');
            entry.querySelector('.nwst-community-summary-text').style.display = 'none';
            entry.querySelector('.nwst-community-edit-area').style.display = 'block';
            this.closest('.nwst-btn-row').style.display = 'none';
        };
    });

    // ── Save ──────────────────────────────────────────────────
    document.querySelectorAll('.nwst-community-save').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const entry = this.closest('.nwst-community-entry');
            const comId = entry.getAttribute('data-community-id');
            const nameInput = entry.querySelector('.nwst-community-name-input');
            const membersInput = entry.querySelector('.nwst-community-members-input');
            const textarea = entry.querySelector('.nwst-community-textarea');
            if (textarea && comId) {
                const chatId = getChatId();
                const updates = {
                    summary: textarea.value
                };
                if (nameInput) updates.name = nameInput.value;
                if (membersInput) updates.members = membersInput.value;
                await updateCommunity(chatId, comId, updates);
                refreshCommunitiesUI();
                nwstToast('Community saved.', 'success');
            }
        };
    });

    // ── Cancel ────────────────────────────────────────────────
    document.querySelectorAll('.nwst-community-cancel').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            refreshCommunitiesUI();
        };
    });

    // ── Delete ────────────────────────────────────────────────
    document.querySelectorAll('.nwst-community-delete').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const entry = this.closest('.nwst-community-entry');
            const comId = entry.getAttribute('data-community-id');
            const chatId = getChatId();
            await deleteCommunity(chatId, comId);
            refreshCommunitiesUI();
            nwstToast('Community deleted.', 'info');
        };
    });

    // ── Community Regen ───────────────────────────────────────
    document.querySelectorAll('.nwst-community-regen').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const comId = this.getAttribute('data-community-id');
            if (!comId) return;
            await regenCommunitySummary(comId);
        };
    });

}

// ── Community Summary Regeneration via LLM ─────────────────────────────────

/**
 * Call the Planning LLM to regenerate a single community's summary.
 * @param {string} communityId
 */
async function regenCommunitySummary(communityId) {
    const chatId = getChatId();
    if (!chatId || !communityId) return;

    const profile = resolveProfile('planningLLM');
    if (!profile) {
        nwstToast('No Planning LLM profile configured. Set one in Settings > Connections.', 'warning');
        return;
    }

    const communities = getAllCommunities(chatId);
    const community = communities.find(c => c.id === communityId);
    if (!community) {
        nwstToast('Community not found.', 'error');
        return;
    }

    const settingContext = getSettingContext(chatId);
    const recentMessages = getRecentChatMessages(10);

    // Build user prompt
    let userPrompt = `Regenerate the community summary for "${community.name}".\n\n`;
    userPrompt += `=== COMMUNITY ===\n`;
    userPrompt += `Name: ${community.name}\n`;
    userPrompt += `Members: ${community.members || 'none listed'}\n`;
    userPrompt += `Current summary: ${community.summary || '(empty)'}\n\n`;

    if (settingContext) {
        userPrompt += `=== SETTING CONTEXT ===\n${settingContext}\n\n`;
    }

    if (recentMessages.length > 0) {
        userPrompt += `=== RECENT CHAT MESSAGES ===\n`;
        for (const msg of recentMessages) {
            const sender = msg.name || (msg.is_user ? 'User' : 'Character');
            userPrompt += `[${sender}]: ${msg.mes}\n`;
        }
        userPrompt += '\n';
    }

    userPrompt += `Write a rich, analytical summary for "${community.name}" based on the recent events. Surface subtext, power dynamics, and internal tensions.`;

    // Show loading
    const entry = document.querySelector(`.nwst-community-entry[data-community-id="${communityId}"]`);
    if (entry) entry.classList.add('nwst-loading');

    try {
        const messages = [
            { role: 'system', content: COMMUNITY_REGEN_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, messages);
        if (!response || !response.trim()) {
            nwstToast('LLM returned empty response for community regen.', 'error');
            return;
        }

        const newSummary = response.trim();
        await updateCommunitySummary(chatId, communityId, newSummary);
        refreshCommunitiesUI();
        nwstToast(`Summary for "${community.name}" regenerated.`, 'success');

    } catch (err) {
        console.error(`[NWST] Community regen failed for ${communityId}:`, err);
        nwstToast(`Failed to regenerate summary for "${community.name}".`, 'error');
    } finally {
        if (entry) entry.classList.remove('nwst-loading');
    }
}

function wireWorldStateEvents() {
    // Add community button
    const addBtn = document.getElementById('nwst-community-add');
    if (addBtn) {
        addBtn.onclick = async () => {
            const chatId = getChatId();
            await addCommunity(chatId, {
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
