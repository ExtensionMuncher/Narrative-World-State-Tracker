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

const CONDITION_REGEN_SYSTEM_PROMPT = `You are a narrative world state analyst for an ongoing roleplay. Your task is to regenerate the content for ONE specific world condition — a macro-level atmospheric description of a particular aspect of the world. Your focus is the WORLD'S STATE, not what characters are doing within it.

A world condition is an ATMOSPHERIC NARRATIVE — it describes the current mood, subtext, and implications of a particular aspect of the world (political, social, spiritual, or environmental). It is NOT a factual summary, character action list, or plot synopsis.

OUTPUT STRUCTURE — a single paragraph of exactly 2-4 sentences. No more, no less.

Each sentence must operate at the MACRO level — the world's atmosphere, the prevailing mood of a region, the texture of social undercurrents, the weight of unspoken tension across a landscape. Use setting details, weather, architecture, seasonal cues, and communal mood to convey the state of the world.

GOOD (macro, atmospheric): "The political atmosphere of the fortress has curdled into something watchful — not open conflict, but the particular stillness of a room where everyone is waiting for someone else to move first. Edicts are obeyed with theatrical punctuality. Favors are hoarded like coin. The air tastes of held breath."
BAD (micro, character-level): "Sachiko is navigating a web of political intrigue. Rukia has become more cautious. The servants are gossiping about Kenji Sato's outburst." — Named characters, action summaries, no atmospheric texture.

GOOD (macro, atmospheric): "Winter's grip is beginning to loosen, but the thaw has brought mudslides that choke the mountain passes, isolating the fortress further. The roads are treacherous, supply lines strained. There is a tension in the air between the promise of spring and the reality of being cut off."
BAD (micro, event-level): "The snow is melting. Supplies are running low because of the mudslides. People are worried about being cut off." — Generic, flat, reads like a checklist.

CRITICAL RULES:
- NO named characters whatsoever — world conditions describe the macro state of the world, not individuals
- NO event summaries or plot recaps — describe atmosphere and implications, not what happened
- NO generic or vague language — "there is tension" means nothing. What KIND of tension? What SHAPE does it take? What does it FEEL like?
- Be specific and evocative — use sensory detail (weather, light, sound, physical space, communal mood)
- EXACTLY 2-4 sentences — count your periods (. ! ?) to verify before outputting

SENTENCE COUNT — SELF-CHECK: Count the sentence-terminating punctuation marks (. ! ?) in your output. If the count is not between 2 and 4 (inclusive), your output is invalid. Rewrite.

Respond with ONLY the condition content text — a single paragraph of 2-4 sentences. No JSON, no markdown fences, no labels, no extra commentary. Just the atmospheric narrative.`;

// ── Dedicated system prompt for single-community summary regeneration ──────
// Focuses the LLM on producing a rich, analytical summary for one community.

const COMMUNITY_REGEN_SYSTEM_PROMPT = `You are a community analyst for a narrative roleplay. Your task is to regenerate the summary for ONE specific community — a social group, faction, or collective within the story. Your focus is the COMMUNITY as an entity: its internal structure, shared identity, collective pressures, and its role in the larger social landscape.

Your summaries have two parts: an overview paragraph and bullet observations. Both must always be present.

PART 1 — OVERVIEW PARAGRAPH (2-3 sentences):
Write with narrative voice and atmosphere. Capture what this community IS as a social entity — its nature, its position in the power structure, the shared condition that binds its members, and the tensions that operate at the GROUP level. Do NOT name specific characters in the paragraph itself. Do NOT reference specific chat events. The paragraph should describe the community's permanent or semi-permanent character, not what happened in the last scene.

PART 2 — ANALYTICAL OBSERVATIONS (variable bullet count — determined by the community itself):
Each bullet is an observation about the COMMUNITY's dynamics — its internal fractures, collective strategies, shared grievances, sources of cohesion, or relationships to other factions. Each bullet must describe the group, not an individual's actions. Use recent events as EVIDENCE for group-level observations, not as the subject of the observation itself.

BULLET COUNT IS A TEST OF ANALYTICAL RIGOR.
Do not aim for any specific number. Let the community dictate the count:
- A simple, peripheral community might warrant only 1-2 bullets.
- A deeply entangled community might warrant 4-5 bullets.
- A community with no meaningful internal dynamics warrants 0 bullets (just the overview paragraph).
The single worst outcome is padding. Four bullets where three would suffice is a FAILURE. Three bullets where two would suffice is a FAILURE. Each bullet must earn its place by revealing something distinct and non-obvious about the community as a collective.

SELF-CRITIQUE STEP (mandatory, perform silently before finalizing):
1. Read each bullet you wrote. Does it describe the COMMUNITY as a collective, or does it describe an individual character's action? If the latter, delete it.
2. Does this bullet add information that no other bullet covers? If not, merge or delete it.
3. Could this community be fully captured without this bullet? If yes, delete it.
4. After pruning, if only 1-2 bullets remain, that is correct — do not add filler.

GOOD bullet (community-level): "The servants operate as an informal intelligence network — not through explicit conspiracy, but through the simple fact that no one notices them noticing. Their grievances have coalesced into a shared vocabulary of resentment, making them an organizational force that could pivot from passive observation to active leverage at speed."
BAD bullet (event-level): "Yumi's willingness to offer intelligence on Rin Hino's dawn shrine visits reveals a servant who understands that information is the only currency" — this is about Yumi's individual actions, not the community's dynamic.

GOOD bullet (community-level): "Internally, the household staff is split between those who see their invisibility as protection and those who see it as erasure — a fracture that any outsider with enough perception could exploit."
BAD bullet (event-level): "Tomoe Minamoto's direct approach to Sachiko signals a fracture in the servant network's usual information channels" — this analyzes a single character's action, not the community.

Each bullet must answer: what does this reveal about the COMMUNITY as a collective? Not what does it reveal about a specific character or event.

CRITICAL RULES:
- Bullets must describe the COMMUNITY (its nature, structure, internal dynamics, collective behavior)
- Bullets must NOT analyze individual character actions or choices from the chat
- No character names in the overview paragraph
- No plot summaries or event recaps anywhere
- No generic observations ("the group is tense") — be specific or say nothing

SENTENCE LIMIT PER BULLET — MAXIMUM 2 SENTENCES. ABSOLUTE HARD LIMIT.
A "sentence" is text ending with a period (.), exclamation (!), or question mark (?). Colons, semicolons, and em-dashes are internal punctuation — they do NOT sentence-terminate. Count your sentence terminators (. ! ?) to verify. If a bullet has more than 2, you are in violation.

GOOD (2 sentences): "The servants operate as an informal intelligence network — their resentment coalesced into a shared vocabulary. This makes them an organizational force capable of pivoting from observation to leverage at speed."
GOOD (1 sentence): "Internally, the household staff is split between those who see invisibility as protection and those who see it as erasure."
BAD — SENTENCE COUNT VIOLATION (3 sentences): "The servants operate as an informal intelligence network. Their resentment has coalesced into a shared vocabulary. This makes them a force to be reckoned with." — Count the periods: three. Violation.
BAD — DISGUISED VIOLATION (still 3 sentences): "The servants operate as an informal intelligence network; their resentment has coalesced into a shared vocabulary. This gives them leverage. That leverage could be exploited." — Three periods (".", ".", ".") means three sentences, regardless of the semicolon. Violation.

SELF-CHECK: Before each bullet, silently count its sentence-terminating punctuation marks (. ! ?). If the count exceeds 2, shorten it. This is not optional.

CONSEQUENCE: Any bullet exceeding 2 sentences will cause the entire output to be rejected. Period.

OUTPUT FORMAT:
[Overview paragraph here]

• [Observation — only if it earns its place through SELF-CRITIQUE]
• [Observation — only if it earns its place]
• [...] more only if independently warranted — stop when the community is fully captured, even if that means only 1-2 bullets total]

Respond with ONLY the formatted summary. No JSON, no markdown fences, no labels beyond the bullet points. If after self-critique only the overview paragraph survives, output that alone.`;

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

    userPrompt += `Write a compelling atmospheric narrative for the "${condLabel}" condition informed by the recent events below (but never naming characters or referencing those events directly). Remember: no named characters, just the macro state of the world.`;

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
        <div class="nwst-community-entry" data-community-id="${com.id}">
            <div class="nwst-community-hdr nwst-community-toggle">
                <div class="nwst-community-av" style="background:${com.avatarColors?.bg || '#EEEDFE'};color:${com.avatarColors?.text || '#3C3489'}">${escapeHTML(com.avatarInitials || '??')}</div>
                <div style="flex:1">
                    <div style="font-weight:500;font-size:13px">${escapeHTML(com.name)}</div>
                    <div style="font-size:11px;color:#999">${escapeHTML(com.members || 'No members listed')}</div>
                </div>
                <span class="nwst-community-arrow" style="font-size:11px;color:#999">▸</span>
                <button class="menu_button nwst-icon-btn nwst-community-edit-pencil" title="Edit">✎</button>
            </div>
            <div class="nwst-community-body">
                <div class="nwst-community-summary-text">${renderCommunitySummary(com.summary)}</div>
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
                        <button class="editor_maximize nwst-expand-btn nwst-cond-popout" data-for="nwst-community-textarea-${com.id}" style="margin-left:4px;font-size:14px;color:#aaa" title="Open in popout">⛶</button>
                    </div>
                </div>
                <div class="nwst-btn-row" style="margin-top:8px">
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
            const entry = this.closest('.nwst-community-entry');
            const isOpen = entry.classList.toggle('nwst-open');
            const arrow = entry.querySelector('.nwst-community-arrow');
            if (arrow) arrow.textContent = isOpen ? '▾' : '▸';
        };
    });

    // ── Edit pencil ───────────────────────────────────────────
    document.querySelectorAll('.nwst-community-edit-pencil').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const entry = this.closest('.nwst-community-entry');
            // Open the entry if collapsed
            entry.classList.add('nwst-open');
            const arrow = entry.querySelector('.nwst-community-arrow');
            if (arrow) arrow.textContent = '▾';
            // Show edit area, hide summary text
            entry.querySelector('.nwst-community-summary-text').style.display = 'none';
            entry.querySelector('.nwst-community-edit-area').style.display = 'block';
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

    userPrompt += `Write a rich, analytical summary for "${community.name}" as a collective entity. Describe its nature, internal structure, shared pressures, and position in the social landscape. The chat messages below are evidence to inform your analysis — do NOT make the events themselves the subject of the bullets. Surface subtext, power dynamics, and internal tensions at the GROUP level. Use bullet points (•) for observations, with each bullet being a specific, concrete observation. Do not pad — output only as many bullets as the community genuinely warrants. An optional 1-2 sentence overview paragraph may precede the bullets.`;

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

// ── Render community summary as formatted HTML ────────────────────────────────

function renderCommunitySummary(summary) {
    if (!summary || summary.trim() === '') {
        return '<span style="color:#999;font-style:italic">No summary yet.</span>';
    }

    const lines = summary.split('\n');
    let overviewLines = [];
    let bulletLines = [];
    let inBullets = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('\u2022') || trimmed.startsWith('- ')) {
            inBullets = true;
            bulletLines.push(trimmed.replace(/^[\u2022\-]\s*/, '').trim());
        } else if (trimmed.length > 0 && !inBullets) {
            overviewLines.push(trimmed);
        }
    }

    if (bulletLines.length === 0 && summary.includes('\u2022')) {
        const parts = summary.split('\u2022');
        overviewLines = [parts[0].trim()];
        bulletLines = parts.slice(1).map(p => p.trim()).filter(p => p.length > 0);
    }

    let html = '';
    if (overviewLines.length > 0) {
        html += `<p style="margin:0 0 10px 0;line-height:1.6">${escapeHTML(overviewLines.join(' '))}</p>`;
    }
    if (bulletLines.length > 0) {
        html += '<ul style="margin:0;padding:0;list-style:none">';
        for (const bullet of bulletLines) {
            html += `<li style="display:flex;align-items:flex-start;gap:8px;padding:4px 0;line-height:1.5;border-top:0.5px solid rgba(128,128,128,0.15)">` +
                    `<span style="flex-shrink:0;color:var(--SmartThemeQuoteColor,#7F77DD);margin-top:2px">\u2022</span>` +
                    `<span>${escapeHTML(bullet)}</span>` +
                    `</li>`;
        }
        html += '</ul>';
    }
    return html || `<span>${escapeHTML(summary)}</span>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
