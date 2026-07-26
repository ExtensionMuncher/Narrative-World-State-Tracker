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
    getCurrentDay,
    updateConditionContent,
    toggleConditionEnabled,
    getSettingContext
} from '../data/worldState.js';
import {
    getAllCommunities,
    addCommunity, updateCommunity, deleteCommunity,
    updateCommunitySummary
} from '../data/communities.js';
import { resolveProfile, generateWithProfile } from '../llm/connections.js';
import { LLM_TOKEN_BUDGETS } from '../llm/tokenBudgets.js';
import { dlog } from '../lib/debug.js';
import { buildWorldEvidenceSources, formatWorldEvidenceSources, collectRecentCastNames, validateWorldConditionPayload } from '../llm/worldConditionEvidence.js';

// ── Dedicated system prompt for single-condition regeneration ──────────────
// This is a focused, lighter version of the scanner's condition prompt.
// It asks the LLM to regenerate a single world condition's atmospheric narrative
// based on recent chat messages and current world context.

const CONDITION_REGEN_SYSTEM_PROMPT = `You regenerate ONE persistent World Condition for an ongoing roleplay.

MANUAL REGENERATION IS AMBIENT-ONLY.
Do NOT mine the recent plot for a Grounded political/social/spiritual/environmental development. The purpose of this button is to rebuild a clean WORLD-SCALE background condition when the saved condition is stale, contaminated, or unsatisfactory.

Write a relatively durable 2-4 sentence condition that can remain useful across many messages or several in-world days. Draw only from the supplied Setting Context and current date/season/environmental frame plus restrained, low-stakes setting-consistent background life.

GLOBAL RULES:
- Do NOT name or causally reference the protagonist or immediate/recent cast.
- Do NOT summarize recent scenes, cases, conversations, visits, paperwork, surveillance targets, arrests, or relationships.
- Quiet background activity is allowed and encouraged when it plausibly makes the setting feel inhabited. Ambient may introduce modest current developments involving real or setting-supported institutions/factions — for example routine administrative guidance, procedural updates, staffing/budget pressure, promotion cycles, municipal initiatives, enforcement-priority shifts, or low-key corporate/faction maneuvering.
- AMBIENT PROPORTIONALITY TEST: an invented background development must remain something the active cast could plausibly never notice. If the development would reasonably force characters to change immediate plans, demand urgent follow-up, or substantially rewrite the playable world, it is too consequential for Ambient unless the supplied Setting Context/Current Day already supports that scale.
- Do NOT casually invent plot-forcing upheavals such as war, coups, states of emergency, martial law, government collapse, sweeping nationwide crackdowns/purges, mass civil disorder, economic collapse, catastrophic disasters, mass-casualty events, widespread infrastructure failure, or supernatural/metaphysical catastrophes.
- Prefer one coherent background theme with at most 1-2 closely related developments rather than a bulletin list of unrelated news.
- Keep the condition subordinate to the active story: it should remind the main model that a wider world exists, not compete with the plot.

CATEGORY BOUNDARIES:
- POLITICAL: ordinary wider power structures, institutions, factions, governance, territorial influence, regulatory climate, leadership/hierarchy, or institutional background. Named overarching institutions are allowed, and modest background developments within them are allowed when they remain low-stakes and non-plot-forcing.
- SOCIAL: collective behavior, cultural/social norms, community patterns, public routines, workplaces, commerce, social spaces, population habits, and reputation patterns. Weather/season may explain behavior but PEOPLE and SOCIAL SYSTEMS must remain the subject; do not turn Social into Environmental II.
- SPIRITUAL/SUPERNATURAL: durable metaphysical rules/pressures, supernatural factions, ritual cycles, regional spiritual phenomena, barriers/realms, sacred/profane conditions, or other setting-supported supernatural systems. Do not invent supernatural ontology if the supplied world frame does not support one.
- ENVIRONMENTAL: durable physical-world background such as seasonal transition, climate pattern, ecology, landscape, water/air conditions, regional hazards, flora/fauna, or persistent environmental tendencies. Today's isolated weather belongs in Current Day, not here.

OUTPUT — valid JSON only:
{
  "mode": "ambient",
  "scope": "category-appropriate macro scope",
  "evidenceRefs": [],
  "change": "concise description of the ambient category focus",
  "content": "one coherent 2-4 sentence World Condition paragraph"
}

Always return mode "ambient" and an empty evidenceRefs array.`;

// ── Dedicated system prompt for single-community summary regeneration ──────
// Focuses the LLM on producing a rich, analytical summary for one community.

const COMMUNITY_REGEN_SYSTEM_PROMPT = `You are a community analyst for a narrative roleplay. Your task is to regenerate the summary for ONE specific community — a social group, faction, or collective within the story. Your focus is the COMMUNITY as an entity: its internal structure, shared identity, collective pressures, and its role in the larger social landscape.

Your summary begins with an overview paragraph and may include analytical bullet observations when the community genuinely warrants them. Do not invent bullets just to satisfy a format.

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
BAD bullet (event-level): "Captain Vale's direct approach to Mira signals a fracture in the household staff's usual information channels" — this analyzes a single character's action, not the community.

Each bullet must answer: what does this reveal about the COMMUNITY as a collective? Not what does it reveal about a specific character or event.

MOTIVE / DURABILITY GROUNDING:
- Recent scenes are evidence for the community's durable or semi-durable collective state; do not narrate their chronology.
- Explicitly stated motives outrank dramatic stylistic inference. Do NOT turn fear, desperation, panic, confusion, impulsiveness, self-preservation, or reactive behavior into confidence, strategy, dominance, bravery, or calculated control unless the prose establishes it.
- Do not make a person or group more competent, composed, sinister, romantic, strategic, or "badass" than the evidence supports.

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
async function regenCondition(condKey, condLabel, options = {}) {
    const chatId = options.expectedChatId || getChatId();
    if (!chatId || getChatId() !== chatId) return false;

    // Resolve planning LLM profile
    const profile = resolveProfile('planningLLM');
    if (!profile) {
        nwstToast('No Planning LLM profile configured. Set one in Settings > Connections.', 'warning');
        return;
    }

    // Gather only the broad world frame for manual regeneration. Recent chat is
    // retained locally only so the validator can reject accidental cast leakage;
    // it is deliberately NOT shown to the regeneration model.
    const settingContext = getSettingContext(chatId);
    const currentDay = getCurrentDay(chatId);
    const recentMessages = getRecentChatMessages(10);
    const communities = getAllCommunities(chatId);
    const evidenceDay = options.settingChange
        ? { dateDisplay: currentDay?.dateDisplay || '', season: currentDay?.season || '' }
        : currentDay;
    const evidenceSources = buildWorldEvidenceSources([], evidenceDay, settingContext);
    const recentCastNames = collectRecentCastNames(recentMessages, communities);

    let userPrompt = `=== WORLD FRAME ===\n`;
    userPrompt += `${formatWorldEvidenceSources(evidenceSources)}\n`;
    userPrompt += `=== CONDITION TO REBUILD ===\n`;
    userPrompt += `Key: ${condKey}\n`;
    userPrompt += `Label: ${condLabel}\n`;
    const allowedScopeHints = {
        political: 'institution | faction | district | regional | population',
        social: 'population | community | district | cultural | regional',
        spiritual: 'spiritual | faction | regional | environmental',
        environmental: 'environmental | district | regional'
    };
    userPrompt += `Allowed scope values: ${allowedScopeHints[condKey] || 'category-appropriate macro scope'}\n`;
    userPrompt += `Rebuild this as AMBIENT world-scale background. Do not use or reconstruct the recent plot. Return JSON only.`;

    // Show loading state
    const row = document.getElementById(`nwst-cond-${condKey}`);
    if (row) row.classList.add('nwst-loading');

    try {
        const messages = [
            { role: 'system', content: CONDITION_REGEN_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, messages, { maxTokens: LLM_TOKEN_BUDGETS.HEAVY });
        if (getChatId() !== chatId) {
            dlog(`[NWST] Discarded stale ${condKey} condition result because the active chat changed.`);
            return false;
        }
        if (!response || !response.trim()) {
            nwstToast('LLM returned empty response for condition regen.', 'error');
            return;
        }

        let parsed;
        try {
            const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
            parsed = JSON.parse(cleaned);
        } catch (parseErr) {
            console.error(`[NWST] Condition regen returned invalid JSON for ${condKey}:`, response, parseErr);
            nwstToast('Condition regen returned an invalid structured response; existing condition was preserved.', 'error');
            return;
        }

        const newContent = typeof parsed?.content === 'string' ? parsed.content.trim() : '';
        const validation = validateWorldConditionPayload(parsed, evidenceSources, recentCastNames, condKey);
        if (!validation.ok || !newContent) {
            console.warn(`[NWST] Rejected regenerated ${condKey} condition: ${validation.reason || 'empty content'}`);
            nwstToast('Condition regen failed grounding check; existing condition was preserved.', 'warning');
            return;
        }

        await updateConditionContent(chatId, condKey, newContent);
        refreshConditionsUI();
        nwstToast(`${condLabel} condition regenerated (${validation.mode}).`, 'success');
        return true;

    } catch (err) {
        console.error(`[NWST] Condition regen failed for ${condKey}:`, err);
        nwstToast(`Failed to regenerate ${condLabel} condition.`, 'error');
    } finally {
        if (row) row.classList.remove('nwst-loading');
    }
}

/**
 * Rebuild all setting-dependent World Conditions after an intentional Setting
 * Context switch. This mode deliberately excludes old location-specific Current
 * Day prose from evidence so the previous setting cannot contaminate the rebuild.
 */
export async function regenerateAllWorldConditionsForSettingChange(expectedChatId = getChatId()) {
    if (!expectedChatId || getChatId() !== expectedChatId) return false;
    const conditions = getConditions(expectedChatId);
    for (const def of CONDITION_DEFS) {
        if (getChatId() !== expectedChatId) return false;
        if (conditions?.[def.key]?.enabled === false) continue;
        await regenCondition(def.key, def.label, { settingChange: true, expectedChatId });
    }
    return getChatId() === expectedChatId;
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
                            placeholder="e.g. Mira, Rowan, Elias">
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

    // Build user prompt — durable group state first, recent messages as evidence only.
    let userPrompt = `=== SETTING / WORLD FRAME ===\n${settingContext || '(no explicit setting context provided)'}\n\n`;
    userPrompt += `=== COMMUNITY ===\n`;
    userPrompt += `Name: ${community.name}\n`;
    userPrompt += `Members: ${community.members || 'none listed'}\n`;
    userPrompt += `Current summary: ${community.summary || '(empty)'}\n\n`;

    if (recentMessages.length > 0) {
        userPrompt += `=== RECENT CHAT — EVIDENCE ONLY ===\n`;
        for (const msg of recentMessages) {
            const sender = msg.name || (msg.is_user ? 'User' : 'Character');
            userPrompt += `[${sender}]: ${msg.mes}\n`;
        }
        userPrompt += '\n';
    }

    userPrompt += `Regenerate a durable analytical summary for "${community.name}" as a collective entity. Describe its structure, relationships, hierarchy, loyalties, fractures, shared pressures, reputation, objectives, and current collective posture. Absorb qualifying recent developments into those durable dynamics instead of retelling the scene.`;

    // Show loading
    const entry = document.querySelector(`.nwst-community-entry[data-community-id="${communityId}"]`);
    if (entry) entry.classList.add('nwst-loading');

    try {
        const messages = [
            { role: 'system', content: COMMUNITY_REGEN_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, messages, { maxTokens: LLM_TOKEN_BUDGETS.HEAVY });
        if (getChatId() !== chatId) {
            dlog('[NWST] Discarded stale community summary because the active chat changed.');
            return;
        }
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
