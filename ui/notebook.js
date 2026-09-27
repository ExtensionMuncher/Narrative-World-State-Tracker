/* eslint-disable */
// =============================================================================
// NWST Notebook Tab UI — ui/notebook.js
// =============================================================================
// Builds and manages the Notebook tab pane. Matches nwst-mockup.html exactly.
//
// Layout:
//   • Info box explaining the notebook's purpose
//   • Four accordion sections: Core, Mystery & Continuity, Hidden Intentions, Secrets & Hidden Knowledge
//   • Core and Mystery: bullet lists with contenteditable spans + ✕ delete + ⛶ popout
//   • Secrets: structured field entries (type, title, secret, whoKnows, whoDoesNotKnow, etc.)
// =============================================================================

import { getChatId, nwstToast } from '../index.js';
import { undoLastMutation, redoNextMutation, getHistoryStatus } from '../data/notebookHistory.js';
import { runNotebookReconcile } from '../llm/notebookReconcile.js';
import {

    getCoreFields, addCoreBullet, updateCoreBullet, deleteCoreBullet,
    getMysteryFields, addMysteryBullet, updateMysteryBullet, deleteMysteryBullet,
    getAllSecrets, addSecret, updateSecret, deleteSecret, resolveArchiveDecision,
    addWhoKnows, removeWhoKnows, addWhoDoesNotKnow, removeWhoDoesNotKnow,
    clearNotebook
} from '../data/notebook.js';
import {
    getHiddenIntentions, getHiddenIntentionsState,
    addHiddenIntention, updateHiddenIntention, deleteHiddenIntention,
    INTENTION_TYPES, INTENTION_DOMAINS
} from '../data/hiddenIntentions.js';
import { runHiddenIntentionsGenerate, runHiddenIntentionsReconcile, purgeUserCharacterIntentions } from '../llm/hiddenIntentions.js';
import { buildAliasRegistry, toCanonicalId } from '../data/aliasRegistry.js';
import { getHiddenIntentionsConfig } from '../settings.js';

// Flatten a triggerAnchors object into a comma-separated editable string,
// and parse it back. Anchors are stored structured but edited as flat text.
function flattenAnchors(ta) {
    if (!ta) return "";
    const all = [];
    for (const k of ["characters","aliases","concepts","objects","locations","organizations","groups","phrases","emotions"]) {
        for (const v of (ta[k] || [])) if (typeof v === "string" && v.trim()) all.push(v.trim());
    }
    return Array.from(new Set(all)).join(", ");
}

function parseAnchors(flat) {
    if (!flat || !flat.trim()) return undefined;
    const items = flat.split(",").map(s => s.trim()).filter(Boolean);
    if (items.length === 0) return undefined;
    return { phrases: Array.from(new Set(items)) };
}


// ── Core field definitions ────────────────────────────────────────────────

const CORE_FIELDS = [
    { key: 'unresolvedDetail', label: 'Unresolved detail' },
    { key: 'promiseThreatDeadline', label: 'Promise / threat / deadline' },
    { key: 'offscreenPressure', label: 'Offscreen pressure' },
    { key: 'doNotForget', label: 'Do not forget' }
];

const MYSTERY_FIELDS = [
    { key: 'establishedFacts', label: 'Established facts — do not contradict', emptyMsg: 'None flagged. The planner LLM will add items here as facts are established.' },
    { key: 'plantedDetails', label: 'Planted details — not yet resolved' },
    { key: 'characterWhereabouts', label: 'Character whereabouts — offscreen' },
    { key: 'inconsistenciesFlagged', label: 'Inconsistencies flagged', emptyMsg: 'None flagged. The planner LLM will add items here if it detects contradictions.' },
    { key: 'currentToneAtmosphere', label: 'Current tone / atmosphere' }
];

const SECRET_TYPES = [
    { value: 'character', label: 'Character secret', cssClass: 'nwst-stype-character' },
    { value: 'user_pc', label: 'User / PC secret', cssClass: 'nwst-stype-user' },
    { value: 'world', label: 'World secret', cssClass: 'nwst-stype-world' },
    { value: 'dramatic_irony', label: 'Dramatic irony', cssClass: 'nwst-stype-irony' },
    { value: 'unconfirmed_suspicion', label: 'Unconfirmed suspicion', cssClass: 'nwst-stype-suspicion' }
];

// Keep expanded secret cards stable across holder edits and background refreshes.
const openSecretIds = new Set();
// Preserve nested Hidden Intentions expansion state across saves/scans while
// the user remains in the Notebook. Leaving the Notebook intentionally resets
// these cards to closed so stale expansion state cannot reopen them later.
const openHiddenActorIds = new Set();
const openHiddenIntentionIds = new Set();
let hiddenExpansionChatId = null;

function ensureHiddenExpansionChat(chatId) {
    if (hiddenExpansionChatId === chatId) return;
    openHiddenActorIds.clear();
    openHiddenIntentionIds.clear();
    hiddenExpansionChatId = chatId || null;
}

export function collapseHiddenIntentionsForNotebookExit() {
    openHiddenActorIds.clear();
    openHiddenIntentionIds.clear();
    const container = document.getElementById('nwst-hi-container');
    if (!container) return;
    container.querySelectorAll('details[open]').forEach(node => { node.open = false; });
}

// ── Build the Notebook tab HTML ───────────────────────────────────────────

export function buildNotebookTab() {
    const pane = document.getElementById('nwst-pane-notebook');
    if (!pane) return;

    pane.innerHTML = `
        <div class="nwst-info-box">
            The notebook is the planner LLM's internal working surface. These notes are <strong>never injected</strong> into your main prompt.
            Inline edits <strong>save automatically when focus leaves the field</strong>. You can also use each section's <strong>Save edits</strong> button for an explicit commit. Click ⛶ to open a larger popout editor, or press Enter in the input row to add a new bullet.
        </div>

        <!-- Undo / redo bar for scanner mutations -->
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <button class="menu_button nwst-btn" id="nwst-nb-undo" title="Undo the last automatic notebook change made by a scan" style="font-size:12px;padding:4px 10px">↶ Undo scan change</button>
            <button class="menu_button nwst-btn" id="nwst-nb-redo" title="Redo a change you undid" style="font-size:12px;padding:4px 10px">↷ Redo</button>
            <button class="menu_button nwst-btn" id="nwst-nb-reconcile" title="Tidy the notebook ledgers — merge duplicates, clarify phrasing, remove dead threads, promote resolved questions. Auto-applied and fully undoable." style="font-size:12px;padding:4px 10px;margin-left:auto">✨ Tidy notebook</button>
            <span id="nwst-nb-history-status" style="font-size:11px;color:#999;flex:1"></span>
        </div>

        <!-- Core section -->
        <div class="nwst-nb-section" id="nwst-nb-core">
            <div class="nwst-nb-section-hdr nwst-nb-toggle" data-section="core">
                <span class="nwst-nb-section-title">Core</span>
                <span class="nwst-nb-section-actions">
                    <button type="button" class="menu_button nwst-btn nwst-nb-section-save" data-save-section="core" title="Save all edited Core notebook entries">Save edits</button>
                    <span style="font-size:11px;color:#999">▾</span>
                </span>
            </div>
            <div class="nwst-nb-section-body" id="nwst-nb-core-body"></div>
        </div>

        <!-- Mystery & Continuity section -->
        <div class="nwst-nb-section" id="nwst-nb-mystery">
            <div class="nwst-nb-section-hdr nwst-nb-toggle" data-section="mystery">
                <span class="nwst-nb-section-title">Mystery & Continuity</span>
                <span class="nwst-nb-section-actions">
                    <button type="button" class="menu_button nwst-btn nwst-nb-section-save" data-save-section="mystery" title="Save all edited Mystery & Continuity notebook entries">Save edits</button>
                    <span style="font-size:11px;color:#999">▾</span>
                </span>
            </div>
            <div class="nwst-nb-section-body" id="nwst-nb-mystery-body"></div>
        </div>

        <!-- Hidden Intentions section -->
        <div class="nwst-nb-section" id="nwst-nb-hiddenIntentions">
            <div class="nwst-nb-section-hdr nwst-nb-toggle" data-section="hiddenIntentions">
                <span class="nwst-nb-section-title">Hidden Intentions</span>
                <span class="nwst-nb-section-actions">
                    <button type="button" class="menu_button nwst-btn nwst-nb-section-save" data-save-section="hiddenIntentions" title="Save all currently rendered Hidden Intention edits">Save edits</button>
                    <span style="font-size:11px;color:#999">▾</span>
                </span>
            </div>
            <div class="nwst-nb-section-body" id="nwst-nb-hiddenIntentions-body" style="padding:10px 12px">
                <div style="font-size:11px;color:#999;margin-bottom:10px;line-height:1.5">
                    Compact private NPC objectives, plans, commitments, priorities, contingencies, and emerging interests. These records are <strong>never injected</strong> into the RP prompt.
                    <strong>Generate</strong> seeds new records; <strong>Reconcile</strong> only checks existing records for progress, blocking, revision, completion, or staleness.
                </div>
                <div id="nwst-hi-status" style="font-size:11px;color:#999;margin-bottom:8px"></div>
                <div id="nwst-hi-container"></div>
                <div class="nwst-btn-row nwst-hi-toolbar" style="margin-top:8px;flex-wrap:wrap">
                    <button class="menu_button nwst-btn" id="nwst-hi-add" title="Manually add one locked Hidden Intention record.">+ Add manually</button>
                    <button class="menu_button nwst-btn" id="nwst-hi-generate" title="Create new grounded records from the recent visible-message window plus relevant NWST Secrets, Communities, Events, Notebook pressures, and World State. This does not update or resolve existing records. Use Debug Backfill in Settings for older chats starting from zero.">✨ Generate new intentions</button>
                    <button class="menu_button nwst-btn" id="nwst-hi-reconcile" title="Review existing Hidden Intentions for progress, blocking, revision, completion, abandonment, or staleness. This does not create new records.">🔄 Reconcile existing</button>
                </div>
            </div>
        </div>

        <!-- Secrets & Hidden Knowledge section -->
        <div class="nwst-nb-section" id="nwst-nb-secrets">
            <div class="nwst-nb-section-hdr nwst-nb-toggle" data-section="secrets">
                <span class="nwst-nb-section-title">Secrets & Hidden Knowledge</span>
                <span class="nwst-nb-section-actions">
                    <button type="button" class="menu_button nwst-btn nwst-nb-section-save" data-save-section="secrets" title="Save all currently rendered Secret edits">Save edits</button>
                    <span style="font-size:11px;color:#999">▾</span>
                </span>
            </div>
            <div class="nwst-nb-section-body" style="padding:10px 12px" id="nwst-nb-secrets-body">
                <div style="font-size:11px;color:#999;margin-bottom:10px;line-height:1.5">
                    Secrets are internal only — never injected.
                    The planner LLM uses them to ensure characters only act on knowledge they actually have.
                    <strong style="color:#333">Who knows / who does not know</strong> is the most critical field.
                </div>
                <div id="nwst-nb-secrets-container"></div>
                <div class="nwst-btn-row" style="margin-top:4px">
                    <button class="menu_button nwst-btn nwst-nb-add-secret">+ Add secret</button>
                    <button class="menu_button nwst-btn" id="nwst-nb-scan-secrets" title="Scan the full chat history to auto-detect secrets">🔍 Scan for secrets</button>
                </div>
            </div>
        </div>

        <!-- Clear all -->
        <div style="margin-top:10px" class="nwst-btn-row">
            <button class="menu_button nwst-btn-danger" id="nwst-nb-clearAll">Clear all</button>
        </div>
    `;

    refreshNotebookUI();
    wireNotebookEvents();
    wireHistoryControls();
}

// ── Refresh all notebook sections ─────────────────────────────────────────

export function refreshNotebookUI() {
    refreshCoreSection();
    refreshMysterySection();
    refreshHiddenIntentionsSection();
    refreshSecretsSection();
    refreshHistoryControls();
}

// ── Undo/redo controls for scanner mutations ──────────────────────────────
function refreshHistoryControls() {
    const status = getHistoryStatus();
    const undoBtn = document.getElementById('nwst-nb-undo');
    const redoBtn = document.getElementById('nwst-nb-redo');
    const statusEl = document.getElementById('nwst-nb-history-status');
    if (undoBtn) undoBtn.disabled = !status.canUndo;
    if (redoBtn) redoBtn.disabled = !status.canRedo;
    if (statusEl) {
        if (status.canUndo) {
            statusEl.textContent = `Next undo: ${status.undoLabel}`;
        } else if (status.canRedo) {
            statusEl.textContent = `Nothing to undo. Redo available.`;
        } else {
            statusEl.textContent = 'No scan changes to undo yet.';
        }
    }
}

export function wireHistoryControls() {
    const undoBtn = document.getElementById('nwst-nb-undo');
    const redoBtn = document.getElementById('nwst-nb-redo');
    if (undoBtn) {
        undoBtn.onclick = async () => {
            const ok = await undoLastMutation(getChatId());
            if (ok) {
                nwstToast('Last scan change undone.', 'success');
                refreshNotebookUI();
            } else {
                nwstToast('Nothing to undo.', 'info');
            }
        };
    }
    if (redoBtn) {
        redoBtn.onclick = async () => {
            const ok = await redoNextMutation(getChatId());
            if (ok) {
                nwstToast('Scan change redone.', 'success');
                refreshNotebookUI();
            } else {
                nwstToast('Nothing to redo.', 'info');
            }
        };
    }
    const reconcileBtn = document.getElementById('nwst-nb-reconcile');
    if (reconcileBtn) {
        reconcileBtn.onclick = async () => {
            reconcileBtn.textContent = '⏳ Tidying...';
            reconcileBtn.disabled = true;
            try {
                await runNotebookReconcile(getChatId());
                refreshNotebookUI();
            } catch (e) {
                nwstToast(`Reconciliation failed: ${e.message}`, 'error');
            } finally {
                reconcileBtn.textContent = '✨ Tidy notebook';
                reconcileBtn.disabled = false;
            }
        };
    }
}

// ── Core section ──────────────────────────────────────────────────────────

function refreshCoreSection() {
    const body = document.getElementById('nwst-nb-core-body');
    if (!body) return;

    const chatId = getChatId();
    const core = getCoreFields(chatId);

    let html = '';
    for (const field of CORE_FIELDS) {
        const bullets = core[field.key] || [];
        html += `<div class="nwst-nb-field" data-field="${field.key}" data-section="core">`;
        html += `<div class="nwst-nb-field-label">${field.label}</div>`;

        if (bullets.length === 0) {
            html += `<div class="nwst-nb-empty nwst-nb-empty-msg">No items yet.</div>`;
        } else {
            html += `<ul class="nwst-nb-bullets">`;
            for (let i = 0; i < bullets.length; i++) {
                html += `
                <li class="nwst-nb-bullet" data-index="${i}">
                    <span class="nwst-nb-bullet-text" contenteditable="true" id="nwst-nb-bullet-core-${field.key}-${i}">${escapeHTML(bullets[i])}</span>
                    <button class="nwst-nb-bullet-del nwst-bullet-delete">✕</button>
                </li>`;
            }
            html += `</ul>`;
        }

        html += `<div class="nwst-nb-add-row"><input class="nwst-nb-add-input" placeholder="+ Add item — press Enter" data-field="${field.key}" data-section="core"></div>`;
        html += `</div>`;
    }

    body.innerHTML = html;

    // Wire bullet events
    wireBulletEvents(body);
}

// ── Mystery section ───────────────────────────────────────────────────────

function refreshMysterySection() {
    const body = document.getElementById('nwst-nb-mystery-body');
    if (!body) return;

    const chatId = getChatId();
    const mystery = getMysteryFields(chatId);

    let html = '';
    for (const field of MYSTERY_FIELDS) {
        const bullets = mystery[field.key] || [];
        html += `<div class="nwst-nb-field" data-field="${field.key}" data-section="mystery">`;
        html += `<div class="nwst-nb-field-label">${field.label}</div>`;

        if (bullets.length === 0) {
            html += `<div class="nwst-nb-empty nwst-nb-empty-msg">${field.emptyMsg || 'No items yet.'}</div>`;
        } else {
            html += `<ul class="nwst-nb-bullets">`;
            for (let i = 0; i < bullets.length; i++) {
                html += `
                <li class="nwst-nb-bullet" data-index="${i}">
                    <span class="nwst-nb-bullet-text" contenteditable="true" id="nwst-nb-bullet-mystery-${field.key}-${i}">${escapeHTML(bullets[i])}</span>
                    <button class="nwst-nb-bullet-del nwst-bullet-delete">✕</button>
                </li>`;
            }
            html += `</ul>`;
        }

        html += `<div class="nwst-nb-add-row"><input class="nwst-nb-add-input" placeholder="+ Add item — press Enter" data-field="${field.key}" data-section="mystery"></div>`;
        html += `</div>`;
    }

    body.innerHTML = html;
    wireBulletEvents(body);
}

// ── Bullet event wiring ───────────────────────────────────────────────────

function markNotebookBulletSaved(span, text = null) {
    if (!span) return;
    span.dataset.savedText = text == null ? span.textContent.trim() : String(text).trim();
    span.classList.remove('nwst-dirty', 'nwst-save-error');
}

async function saveNotebookBulletElement(span, { force = false, notifyOnError = true } = {}) {
    if (!span) return true;
    const bullet = span.closest('.nwst-nb-bullet');
    const field = span.closest('.nwst-nb-field');
    if (!bullet || !field) return true;
    const section = field.getAttribute('data-section');
    const fieldKey = field.getAttribute('data-field');
    const index = parseInt(bullet.getAttribute('data-index'), 10);
    const newText = span.textContent.trim();
    const savedText = span.dataset.savedText ?? newText;
    if (!force && newText === savedText) {
        span.classList.remove('nwst-dirty', 'nwst-save-error');
        return true;
    }

    try {
        const chatId = getChatId();
        if (section === 'core') {
            await updateCoreBullet(chatId, fieldKey, index, newText);
        } else if (section === 'mystery') {
            await updateMysteryBullet(chatId, fieldKey, index, newText);
        } else {
            return true;
        }
        markNotebookBulletSaved(span, newText);
        return true;
    } catch (error) {
        span.classList.add('nwst-save-error');
        console.error('[NWST Notebook] Could not save edited bullet:', error);
        if (notifyOnError) nwstToast('Notebook edit could not be saved. Your text is still visible; try Save edits again.', 'error');
        return false;
    }
}

async function saveBulletNotebookSection(section, { notify = true } = {}) {
    const body = document.getElementById(`nwst-nb-${section}-body`);
    if (!body) return true;
    const spans = Array.from(body.querySelectorAll('.nwst-nb-bullet-text'));
    let ok = true;
    for (const span of spans) {
        if (!(await saveNotebookBulletElement(span, { force: false, notifyOnError: false }))) ok = false;
    }
    if (notify) nwstToast(ok ? `${section === 'core' ? 'Core' : 'Mystery & Continuity'} notebook edits saved.` : 'Some notebook edits could not be saved.', ok ? 'success' : 'error');
    return ok;
}

function wireBulletEvents(container) {
    if (!container) return;

    // Capture the persisted text represented by this render. Autosave only
    // writes when the inline value actually changes, which avoids redundant
    // metadata writes when the user merely tabs/clicks through the Notebook.
    container.querySelectorAll('.nwst-nb-bullet-text').forEach(span => markNotebookBulletSaved(span));

    // ── Add bullet on Enter ────────────────────────────────────
    container.querySelectorAll('.nwst-nb-add-input').forEach(input => {
        input.addEventListener('keydown', async function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const text = this.value.trim();
                if (!text) return;

                const fieldKey = this.getAttribute('data-field');
                const section = this.getAttribute('data-section');
                const chatId = getChatId();

                if (section === 'core') {
                    await addCoreBullet(chatId, fieldKey, text);
                    refreshCoreSection();
                } else if (section === 'mystery') {
                    await addMysteryBullet(chatId, fieldKey, text);
                    refreshMysterySection();
                }
            }
        });
    });

    // ── Delete bullet ──────────────────────────────────────────
    container.querySelectorAll('.nwst-bullet-delete').forEach(btn => {
        btn.addEventListener('click', async function () {
            const bullet = this.closest('.nwst-nb-bullet');
            const field = this.closest('.nwst-nb-field');
            const section = field.getAttribute('data-section');
            const fieldKey = field.getAttribute('data-field');
            const index = parseInt(bullet.getAttribute('data-index'), 10);
            const chatId = getChatId();

            if (section === 'core') {
                await deleteCoreBullet(chatId, fieldKey, index);
                refreshCoreSection();
            } else if (section === 'mystery') {
                await deleteMysteryBullet(chatId, fieldKey, index);
                refreshMysterySection();
            }
        });
    });

    // ── Save edited bullet on blur ─────────────────────────────
    container.querySelectorAll('.nwst-nb-bullet-text').forEach(span => {
        span.addEventListener('input', function () {
            const current = this.textContent.trim();
            this.classList.toggle('nwst-dirty', current !== (this.dataset.savedText ?? current));
            this.classList.remove('nwst-save-error');
        });

        span.addEventListener('blur', async function () {
            await saveNotebookBulletElement(this);
        });

        // ── ⛶ popout button on focus ───────────────────────────
        span.addEventListener('focus', function () {
            const bullet = this.closest('.nwst-nb-bullet');
            const existing = bullet.querySelector('.nwst-nb-bullet-expand');
            if (existing) existing.remove();

            const targetSpan = this;
            const popoutBtn = document.createElement('button');
            popoutBtn.className = 'nwst-nb-bullet-expand nwst-expand-btn';
            popoutBtn.title = 'Open in popout';
            popoutBtn.textContent = '⛶';
            popoutBtn.style.cssText = 'font-size:13px;color:#aaa;margin-top:1px;';
            // Keep focus on the editable span until our explicit popout-save
            // callback runs; this prevents a blur race with the expanded editor.
            popoutBtn.onmousedown = ev => ev.preventDefault();
            popoutBtn.onclick = function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                const currentText = targetSpan.textContent || '';
                if (typeof window.openNWSTPopout === 'function') {
                    window.openNWSTPopout('Edit notebook entry', currentText, async saved => {
                        targetSpan.textContent = saved;
                        targetSpan.classList.add('nwst-dirty');
                        await saveNotebookBulletElement(targetSpan, { force: true });
                    });
                }
            };
            bullet.insertBefore(popoutBtn, bullet.querySelector('.nwst-nb-bullet-del'));
        });

        span.addEventListener('blur', function () {
            // Remove popout button after a short delay (allows click to register).
            setTimeout(() => {
                const bullet = this.closest('.nwst-nb-bullet');
                if (bullet) bullet.querySelector('.nwst-nb-bullet-expand')?.remove();
            }, 150);
        });
    });
}

// ── Hidden Intentions section ─────────────────────────────────────────────

const HI_TYPES = [...INTENTION_TYPES];
const HI_DOMAINS = [...INTENTION_DOMAINS];
const HI_TYPE_LABELS = {
    objective: 'Objective',
    active_plan: 'Active plan',
    commitment: 'Commitment',
    ongoing_priority: 'Ongoing priority',
    contingency: 'Contingency',
    emerging_interest: 'Emerging interest'
};
const HI_DOMAIN_LABELS = {
    relational: 'Relational', care_support: 'Care / support', duty_responsibility: 'Duty / responsibility',
    personal: 'Personal', investigative: 'Investigative', logistical: 'Logistical',
    social_factional: 'Social / factional', protective: 'Protective', opportunistic: 'Opportunistic',
    adversarial: 'Adversarial', escape_avoidance: 'Escape / avoidance'
};
const HI_STATUSES = ['latent', 'active', 'ready', 'blocked', 'revised', 'parked', 'resolved', 'abandoned', 'stale', 'pending_review'];
const HI_PROGRESS = ['unattempted', 'prepared', 'attempted', 'progressed', 'blocked', 'failed', 'fulfilled'];
const HI_LEVELS = ['low', 'medium', 'high'];

function hiSelectOptions(values, selected, labels = {}) {
    return values.map(value => `<option value="${value}"${value === selected ? ' selected' : ''}>${escapeHTML(labels[value] || value.replaceAll('_', ' '))}</option>`).join('');
}

function hiListText(values) {
    return Array.isArray(values) ? values.join('\n') : '';
}

function parseHiList(value) {
    return Array.from(new Set(String(value || '').split(/\n|;/).map(x => x.trim()).filter(Boolean)));
}

function hiFieldDomId(item, field) {
    const safeId = String(item?.id || 'record').replace(/[^a-zA-Z0-9_-]/g, '-');
    const safeField = String(field || 'field').replace(/[^a-zA-Z0-9_-]/g, '-');
    return `nwst-hi-${safeId}-${safeField}`;
}

function buildHiTextareaField(item, field, label, value = '', {
    rows = 3,
    placeholder = '',
    required = false,
    list = false
} = {}) {
    const id = hiFieldDomId(item, field);
    const content = list ? hiListText(value) : String(value || '');
    const placeholderAttr = placeholder ? ` placeholder="${escapeHTML(placeholder)}"` : '';
    return `
        <div class="nwst-secret-field-label nwst-hi-text-field" data-hi-field="${escapeHTML(field)}">
            <label class="nwst-hi-field-caption" for="${id}">
                <span>${escapeHTML(label)}</span>${required ? '<span class="nwst-hi-required">required</span>' : ''}
            </label>
            <div class="nwst-hi-textarea-shell">
                <textarea id="${id}" class="text_pole nwst-hi-field" data-field="${escapeHTML(field)}" rows="${rows}"${placeholderAttr}>${escapeHTML(content)}</textarea>
                <button type="button" class="editor_maximize nwst-expand-btn nwst-hi-text-expand" data-for="${id}" title="Expand ${escapeHTML(label)}">⛶</button>
            </div>
        </div>`;
}

function buildHiddenIntentionCard(item) {
    const objective = item.objective || item.nextAction || '(No objective written yet)';
    const reviewBadge = item.status === 'pending_review'
        ? `<span class="nwst-hi-badge nwst-hi-badge-review">review</span>`
        : '';
    const lockBadge = item.locked
        ? `<span class="nwst-hi-badge" title="Wording locked">🔒</span>`
        : '';
    const evidence = (item.evidenceRanges || []).slice(-4).map(row => {
        const range = row.start == null ? '' : `M${row.start}${row.end != null && row.end !== row.start ? `–M${row.end}` : ''}: `;
        return `<li>${escapeHTML(range + (row.summary || 'Narrative evidence'))}</li>`;
    }).join('');

    const hasStrategy = Boolean(item.strategy);
    const hasNextAction = Boolean(item.nextAction);
    const hasTriggers = Boolean(item.triggerConditions?.length);
    const hasConstraints = Boolean(item.constraints?.length);
    const hasProgressNote = Boolean(item.progressNote);
    const requiresStrategy = ['active_plan', 'contingency'].includes(item.type);
    const requiresNextAction = ['active_plan', 'commitment'].includes(item.type);
    const requiresTriggers = item.type === 'contingency';
    const optionalFields = [];
    optionalFields.push(`<label class="nwst-secret-field-label">Actor<input class="text_pole nwst-hi-field" data-field="actor" value="${escapeHTML(item.actor)}"></label>`);
    if (!hasStrategy && !requiresStrategy) optionalFields.push(buildHiTextareaField(item, 'strategy', 'Strategy', '', { rows: 4, placeholder: 'Optional broad approach' }));
    if (!hasNextAction && !requiresNextAction) optionalFields.push(buildHiTextareaField(item, 'nextAction', 'Next action', '', { rows: 3, placeholder: 'Optional nearest concrete step' }));
    if (!hasTriggers && !requiresTriggers) optionalFields.push(buildHiTextareaField(item, 'triggerConditions', 'Trigger conditions', [], { rows: 4, placeholder: 'One per line', list: true }));
    if (!hasConstraints) optionalFields.push(buildHiTextareaField(item, 'constraints', 'Constraints', [], { rows: 4, placeholder: 'One per line', list: true }));
    if (!hasProgressNote) optionalFields.push(buildHiTextareaField(item, 'progressNote', 'Progress note', '', { rows: 4, placeholder: 'Filled when the intention is acted upon or changes' }));

    return `
    <details class="nwst-hi-card" data-intention-id="${escapeHTML(item.id)}"${openHiddenIntentionIds.has(item.id) ? ' open' : ''}>
        <summary class="nwst-hi-card-summary">
            <span class="nwst-hi-summary-objective">${escapeHTML(objective)}</span>
            <span class="nwst-hi-badge">${escapeHTML(HI_TYPE_LABELS[item.type] || item.type)}</span>
            <span class="nwst-hi-badge">${escapeHTML(HI_DOMAIN_LABELS[item.domain] || item.domain)}</span>
            <span class="nwst-hi-badge">${escapeHTML(item.status)}</span>
            ${reviewBadge}${lockBadge}
        </summary>
        <div class="nwst-hi-card-body">
            <div class="nwst-hi-meta-grid">
                <label class="nwst-secret-field-label">Type<select class="text_pole nwst-hi-field" data-field="type">${hiSelectOptions(HI_TYPES, item.type, HI_TYPE_LABELS)}</select></label>
                <label class="nwst-secret-field-label">Domain<select class="text_pole nwst-hi-field" data-field="domain">${hiSelectOptions(HI_DOMAINS, item.domain, HI_DOMAIN_LABELS)}</select></label>
                <label class="nwst-secret-field-label">Status<select class="text_pole nwst-hi-field" data-field="status">${hiSelectOptions(HI_STATUSES, item.status)}</select></label>
                <label class="nwst-secret-field-label">Progress<select class="text_pole nwst-hi-field" data-field="progressStage">${hiSelectOptions(HI_PROGRESS, item.progressStage)}</select></label>
            </div>
            ${buildHiTextareaField(item, 'objective', 'Objective', item.objective, { rows: 3 })}
            ${(hasStrategy || requiresStrategy) ? buildHiTextareaField(item, 'strategy', 'Strategy', item.strategy, { rows: 4, required: requiresStrategy, placeholder: requiresStrategy ? 'Broad method: how this plan or response will be carried out' : 'Optional broad approach' }) : ''}
            ${(hasNextAction || requiresNextAction) ? buildHiTextareaField(item, 'nextAction', 'Next action', item.nextAction, { rows: 3, required: requiresNextAction, placeholder: 'Nearest concrete step' }) : ''}
            ${(hasTriggers || requiresTriggers) ? buildHiTextareaField(item, 'triggerConditions', 'Trigger conditions', item.triggerConditions, { rows: 4, required: requiresTriggers, placeholder: 'One per line', list: true }) : ''}
            ${hasConstraints ? buildHiTextareaField(item, 'constraints', 'Constraints', item.constraints, { rows: 4, list: true }) : ''}
            ${buildHiTextareaField(item, 'basis', 'Grounding basis', item.basis, { rows: 6, placeholder: 'One supporting fact per line', list: true })}
            ${hasProgressNote ? buildHiTextareaField(item, 'progressNote', 'Progress note', item.progressNote, { rows: 4 }) : ''}
            ${item.status === 'parked' ? `<div class="nwst-info-box nwst-hi-parked-note"><strong>Parked working-set history</strong><br>${escapeHTML(item.parkedReason || 'A more current or actionable intention displaced this record from the five-slot working set.')}<br><span style="font-size:11px;color:#999">Parked at message ${item.parkedAtMessage ?? '—'}${item.parkedFromStatus ? ` · previous status: ${escapeHTML(item.parkedFromStatus)}` : ''}</span></div>` : ''}
            <div class="nwst-hi-level-grid">
                <label class="nwst-secret-field-label">Confidence<select class="text_pole nwst-hi-field" data-field="confidence">${hiSelectOptions(HI_LEVELS, item.confidence)}</select></label>
                <label class="nwst-secret-field-label">Commitment<select class="text_pole nwst-hi-field" data-field="commitment">${hiSelectOptions(HI_LEVELS, item.commitment)}</select></label>
            </div>
            ${optionalFields.length ? `<details class="nwst-hi-optional"><summary>Optional / currently empty fields</summary><div class="nwst-hi-optional-body">${optionalFields.join('')}</div></details>` : ''}
            ${evidence ? `<details class="nwst-hi-evidence"><summary>Narrative evidence (${item.evidenceRanges.length})</summary><ul>${evidence}</ul></details>` : ''}
            <div class="nwst-hi-record-meta">Last reviewed: message ${item.lastReviewedMessage ?? '—'} · story day ${item.lastReviewedDay ?? '—'} · origin: ${escapeHTML(item.origin)}</div>
            <div class="nwst-btn-row nwst-hi-actions">
                <button class="menu_button nwst-btn nwst-hi-save">Save</button>
                <button class="menu_button nwst-btn nwst-hi-lock">${item.locked ? '🔓 Unlock wording' : '🔒 Lock wording'}</button>
                ${item.status === 'pending_review' ? '<button class="menu_button nwst-btn nwst-hi-accept">Accept</button>' : ''}
                ${item.status === 'parked' ? '<button class="menu_button nwst-btn nwst-hi-reactivate">Reactivate</button>' : ''}
                ${!['abandoned','resolved'].includes(item.status) ? '<button class="menu_button nwst-btn nwst-hi-abandon">Abandon</button>' : ''}
                <button class="menu_button nwst-btn-danger nwst-hi-delete">Delete</button>
            </div>
        </div>
    </details>`;
}

function buildHiddenActorGroup(group) {
    const working = group.items.filter(item => !['parked', 'resolved', 'abandoned', 'stale'].includes(item.status));
    const parked = group.items.filter(item => item.status === 'parked');
    const closed = group.items.filter(item => ['resolved', 'abandoned', 'stale'].includes(item.status));
    const contingencies = working.filter(item => item.type === 'contingency').length;
    const open = openHiddenActorIds.has(group.actorId);
    const parkedOpen = parked.some(item => openHiddenIntentionIds.has(item.id));
    const closedOpen = closed.some(item => openHiddenIntentionIds.has(item.id));
    const workingHtml = working.length
        ? working.map(buildHiddenIntentionCard).join('')
        : '<div class="nwst-nb-empty">No current working-set records.</div>';
    const parkedHtml = parked.length
        ? `<details class="nwst-hi-history-group"${parkedOpen ? ' open' : ''}><summary>Parked history (${parked.length})</summary><div class="nwst-hi-history-body">${parked.map(buildHiddenIntentionCard).join('')}</div></details>`
        : '';
    const closedHtml = closed.length
        ? `<details class="nwst-hi-history-group"${closedOpen ? ' open' : ''}><summary>Closed history (${closed.length})</summary><div class="nwst-hi-history-body">${closed.map(buildHiddenIntentionCard).join('')}</div></details>`
        : '';
    return `
    <details class="nwst-hi-actor-group" data-actor-id="${escapeHTML(group.actorId)}"${open ? ' open' : ''}>
        <summary class="nwst-hi-actor-summary">
            <strong>${escapeHTML(group.actor || 'Unnamed NPC')}</strong>
            <span>${group.items.length} record${group.items.length === 1 ? '' : 's'}</span>
            <span class="nwst-hi-badge">${working.length} current</span>
            ${parked.length ? `<span class="nwst-hi-badge">${parked.length} parked</span>` : ''}
            ${contingencies ? `<span class="nwst-hi-badge">${contingencies} contingenc${contingencies === 1 ? 'y' : 'ies'}</span>` : ''}
        </summary>
        <div class="nwst-hi-actor-body">${workingHtml}${parkedHtml}${closedHtml}</div>
    </details>`;
}

function currentHiddenIntentionsMessageCount() {
    try { return SillyTavern.getContext().chat?.length || 0; } catch (_) { return 0; }
}

function formatHiddenIntentionsStatus({ items, groups, state, cfg }) {
    const count = currentHiddenIntentionsMessageCount();
    const trackable = items.filter(item => !['resolved', 'abandoned', 'stale'].includes(item.status));
    const ownerIds = new Set(trackable.map(item => item.actorId || toCanonicalId(item.actor)).filter(Boolean));
    const dirtyActors = (state.dirtyActors || []).map(item => item.actor).filter(Boolean);
    const relevantDirtyCount = (state.dirtyActors || []).filter(item => ownerIds.has(item.actorId || toCanonicalId(item.actor))).length;
    const pendingParts = [];
    if (dirtyActors.length) pendingParts.push(`${dirtyActors.length} dirty actor${dirtyActors.length === 1 ? '' : 's'}`);
    if (state.worldDirty) pendingParts.push('world changes');

    const lastReconcileMessage = Number.isInteger(state.lastReconcileMessageCount) && state.lastReconcileMessageCount > 0
        ? state.lastReconcileMessageCount
        : null;
    const lastReconcileTrigger = String(state.lastReconcileTrigger || '').replaceAll('_', ' ');
    const lastReconcile = lastReconcileMessage == null
        ? 'Last reconciliation: never'
        : `Last reconciliation: M${lastReconcileMessage}${lastReconcileTrigger ? ` · ${lastReconcileTrigger}` : ''}${state.lastReconcileSummary ? ` · ${state.lastReconcileSummary}` : ''}`;

    let nextAuto = '';
    if (!cfg.enabled) {
        nextAuto = 'Automatic reconciliation: disabled';
    } else if (!trackable.length) {
        nextAuto = 'Automatic reconciliation: waiting for at least one seeded Hidden Intention';
    } else {
        const nextMessage = Math.max(
            cfg.minimumMessages,
            Number(state.cooldownUntilMessage || 0),
            Number(state.lastScanMessageCount || 0) + cfg.cadence
        );
        if (count < nextMessage) {
            const remaining = nextMessage - count;
            nextAuto = `Next automatic reconciliation: M${nextMessage} · ${remaining} message${remaining === 1 ? '' : 's'} remaining`;
        } else if (!relevantDirtyCount && !state.worldDirty) {
            nextAuto = `Automatic reconciliation: eligible at M${nextMessage}, waiting for a relevant actor/world change`;
        } else {
            nextAuto = `Automatic reconciliation: eligible now (threshold M${nextMessage})`;
        }
    }

    const pending = `Pending signals: ${pendingParts.join(' + ') || 'none'}`;
    const mode = 'Automatic cadence / Day Advance / Time Skip reconcile existing records only; new records come from Generate, Batch Scan, or Debug Backfill.';
    const error = state.lastError ? `Last error: ${state.lastError}` : '';
    return {
        summary: `${items.length} record${items.length === 1 ? '' : 's'} across ${groups.length} NPC${groups.length === 1 ? '' : 's'}`,
        lines: [lastReconcile, nextAuto, pending, mode, error].filter(Boolean)
    };
}

function refreshHiddenIntentionsSection() {
    const container = document.getElementById('nwst-hi-container');
    const statusEl = document.getElementById('nwst-hi-status');
    if (!container) return;
    const chatId = getChatId();
    ensureHiddenExpansionChat(chatId);
    const registry = buildAliasRegistry(chatId);
    const rawItems = getHiddenIntentions(chatId);
    const items = rawItems.filter(item => {
        const actorId = registry.resolve(item.actor) || item.actorId || toCanonicalId(item.actor);
        return !registry.isUserPc(actorId);
    }).sort((a, b) =>
        String(a.actor || '').localeCompare(String(b.actor || '')) || String(a.objective || '').localeCompare(String(b.objective || ''))
    );
    // Early builds could generate PC records. Hide them immediately and persist
    // the cleanup asynchronously so they also disappear from exports/consumers.
    if (items.length !== rawItems.length) {
        purgeUserCharacterIntentions(chatId).catch(error => console.warn('[NWST Notebook] PC intention purge failed:', error));
    }

    const groupsByActor = new Map();
    for (const item of items) {
        const actorId = item.actorId || registry.resolve(item.actor) || toCanonicalId(item.actor);
        if (!groupsByActor.has(actorId)) groupsByActor.set(actorId, { actorId, actor: item.actor || registry.getDisplay(actorId), items: [] });
        groupsByActor.get(actorId).items.push(item);
    }
    const groups = Array.from(groupsByActor.values()).sort((a, b) => String(a.actor).localeCompare(String(b.actor)));
    const state = getHiddenIntentionsState(chatId);
    const cfg = getHiddenIntentionsConfig();
    if (statusEl) {
        const status = formatHiddenIntentionsStatus({ items, groups, state, cfg });
        statusEl.innerHTML = `
            <div class="nwst-hi-status-summary">${escapeHTML(status.summary)}</div>
            ${status.lines.map(line => `<div class="nwst-hi-status-line">${escapeHTML(line)}</div>`).join('')}`;
    }
    container.innerHTML = groups.length
        ? groups.map(buildHiddenActorGroup).join('')
        : '<div class="nwst-nb-empty">No hidden intentions yet. Use <strong>Generate new intentions</strong> to seed this chat. Automatic cadence and day advancement only reconcile records after they exist.</div>';
    wireHiddenIntentionsEvents();
}

function collectHiddenIntentionForm(card) {
    const value = field => card.querySelector(`.nwst-hi-field[data-field="${field}"]`)?.value ?? '';
    const actor = value('actor').trim();
    const registry = buildAliasRegistry(getChatId());
    return {
        actor,
        actorId: registry.resolve(actor) || toCanonicalId(actor),
        type: value('type'),
        domain: value('domain'),
        status: value('status'),
        objective: value('objective').trim(),
        strategy: value('strategy').trim(),
        nextAction: value('nextAction').trim(),
        triggerConditions: parseHiList(value('triggerConditions')),
        constraints: parseHiList(value('constraints')),
        basis: parseHiList(value('basis')),
        progressNote: value('progressNote').trim(),
        progressStage: value('progressStage'),
        confidence: value('confidence'),
        commitment: value('commitment'),
        _manualOverride: true
    };
}

function wireHiddenIntentionsEvents() {
    const container = document.getElementById('nwst-hi-container');
    if (!container) return;
    container.querySelectorAll('.nwst-hi-actor-group').forEach(group => {
        group.ontoggle = function () {
            const actorId = this.getAttribute('data-actor-id');
            if (!actorId) return;
            if (this.open) {
                openHiddenActorIds.add(actorId);
            } else {
                openHiddenActorIds.delete(actorId);
                // Closing an actor group is an explicit request to collapse its
                // nested cards too. Native <details> does not emit toggle events
                // for hidden descendants, so clear their remembered state here.
                this.querySelectorAll('.nwst-hi-card').forEach(card => {
                    const id = card.getAttribute('data-intention-id');
                    if (id) openHiddenIntentionIds.delete(id);
                    card.open = false;
                });
                this.querySelectorAll('.nwst-hi-history-group').forEach(history => { history.open = false; });
            }
        };
    });
    container.querySelectorAll('.nwst-hi-card').forEach(card => {
        card.ontoggle = function () {
            const id = this.getAttribute('data-intention-id');
            if (!id) return;
            if (this.open) openHiddenIntentionIds.add(id); else openHiddenIntentionIds.delete(id);
        };
    });
    container.querySelectorAll('.nwst-hi-save').forEach(btn => btn.onclick = async function () {
        const card = this.closest('.nwst-hi-card');
        const id = card?.getAttribute('data-intention-id');
        if (!id) return;
        const form = collectHiddenIntentionForm(card);
        const problem = validateHiddenIntentionForm(form);
        if (problem) {
            nwstToast(problem, 'warning');
            return;
        }
        await updateHiddenIntention(getChatId(), id, form);
        refreshHiddenIntentionsSection();
        nwstToast('Hidden intention saved.', 'success');
    });
    container.querySelectorAll('.nwst-hi-lock').forEach(btn => btn.onclick = async function () {
        const card = this.closest('.nwst-hi-card');
        const id = card?.getAttribute('data-intention-id');
        const item = getHiddenIntentions(getChatId()).find(x => x.id === id);
        if (!item) return;
        await updateHiddenIntention(getChatId(), id, { locked: !item.locked, _manualOverride: true });
        refreshHiddenIntentionsSection();
    });
    container.querySelectorAll('.nwst-hi-accept').forEach(btn => btn.onclick = async function () {
        const card = this.closest('.nwst-hi-card');
        const id = card?.getAttribute('data-intention-id');
        if (!id) return;
        await updateHiddenIntention(getChatId(), id, { ...collectHiddenIntentionForm(card), status: 'active' });
        refreshHiddenIntentionsSection();
        nwstToast('Hidden intention accepted.', 'success');
    });
    container.querySelectorAll('.nwst-hi-reactivate').forEach(btn => btn.onclick = async function () {
        const card = this.closest('.nwst-hi-card');
        const id = card?.getAttribute('data-intention-id');
        const item = getHiddenIntentions(getChatId()).find(x => x.id === id);
        if (!item) return;
        await updateHiddenIntention(getChatId(), id, { status: item.parkedFromStatus || 'active', _manualOverride: true });
        refreshHiddenIntentionsSection();
        nwstToast('Hidden intention reactivated. Reconciliation may rotate the working set if this exceeds five.', 'success');
    });
    container.querySelectorAll('.nwst-hi-abandon').forEach(btn => btn.onclick = async function () {
        const card = this.closest('.nwst-hi-card');
        const id = card?.getAttribute('data-intention-id');
        if (!id) return;
        await updateHiddenIntention(getChatId(), id, { status: 'abandoned', progressNote: 'Manually abandoned.', _manualOverride: true });
        refreshHiddenIntentionsSection();
    });
    container.querySelectorAll('.nwst-hi-delete').forEach(btn => btn.onclick = async function () {
        const card = this.closest('.nwst-hi-card');
        const id = card?.getAttribute('data-intention-id');
        if (!id) return;
        await deleteHiddenIntention(getChatId(), id);
        refreshHiddenIntentionsSection();
        nwstToast('Hidden intention deleted.', 'info');
    });
}

// ── Secrets section ───────────────────────────────────────────────────────

function buildSecretEntryHTML(secret) {
    let e = '';

        const typeDef = SECRET_TYPES.find(t => t.value === secret.type) || SECRET_TYPES[0];
        const isOpen = openSecretIds.has(secret.id); // preserve user expansion across refreshes
        const lifecycleStatus = secret.status || 'active';
        const lifecycleButton = lifecycleStatus === 'active'
            ? '<button class="menu_button nwst-btn nwst-secret-manual-archive" style="font-size:11px;padding:3px 9px" title="Archive this secret without deleting it. Archived secrets stop injecting and can be restored later.">Archive</button>'
            : lifecycleStatus === 'archived'
                ? '<button class="menu_button nwst-btn nwst-secret-restore" style="font-size:11px;padding:3px 9px" title="Restore this secret to active injection.">Restore</button>'
                : '';

        e += `
        <div class="nwst-secret-entry${isOpen ? ' nwst-open' : ''}" data-secret-id="${secret.id}">
            <div class="nwst-secret-hdr nwst-secret-toggle">
                <span class="nwst-secret-type ${typeDef.cssClass}">${typeDef.label}</span>
                <span class="nwst-secret-title" contenteditable="true" style="flex:1;font-weight:500;font-size:13px;margin-left:6px;outline:none;cursor:text" spellcheck="false">${escapeHTML(secret.title)}</span>
                <div class="nwst-btn-row" style="gap:4px" onclick="event.stopPropagation()">
                    <button class="nwst-nb-bullet-del nwst-secret-delete-btn" style="width:auto;font-size:12px">✕</button>
                </div>
            </div>
            <div class="nwst-secret-body">
                <div class="nwst-secret-field" style="margin-bottom:8px">
                    <div class="nwst-secret-field-label">Secret
                        <button class="nwst-expand-btn" style="font-size:12px;color:#bbb;background:none;border:none;cursor:pointer;margin-left:4px" title="Open in popout" data-popout-field="secret">⛶</button>
                    </div>
                    <div class="nwst-secret-field-content" contenteditable="true"
                        style="font-size:13px;line-height:1.5;border:0.5px solid #777;border-radius:6px;padding:6px 8px;min-height:32px;cursor:text"
                        data-field="secret">${escapeHTML(secret.secret)}</div>
                </div>

                <!-- Who Knows / Who Does NOT Know -->
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
                    <div class="nwst-secret-field">
                        <div class="nwst-secret-field-label" style="color:#0F6E56">Who knows</div>
                        <ul class="nwst-nb-bullets nwst-who-knows-list" style="border:0.5px solid #777;border-radius:6px;overflow:hidden">
                            ${(secret.whoKnows || []).map(name => `
                                <li class="nwst-nb-bullet" style="padding:5px 8px">
                                    <span class="nwst-nb-bullet-text nwst-knowledge-name" contenteditable="true" spellcheck="false" data-original-name="${escapeHTML(name)}">${escapeHTML(name)}</span>
                                    <button class="nwst-nb-bullet-del nwst-who-knows-del">✕</button>
                                </li>`).join('')}
                        </ul>
                        <div class="nwst-nb-add-row" style="padding:4px 0 0;display:flex;gap:5px;align-items:center">
                            <input class="nwst-nb-add-input nwst-who-knows-add" placeholder="Type a name" data-secret-id="${secret.id}" style="flex:1;min-width:0">
                            <button type="button" class="menu_button nwst-btn nwst-who-knows-add-btn" style="font-size:10px;padding:2px 7px">Add</button>
                        </div>
                    </div>
                    <div class="nwst-secret-field">
                        <div class="nwst-secret-field-label" style="color:#993C1D">Who does NOT know</div>
                        <ul class="nwst-nb-bullets nwst-who-not-know-list" style="border:0.5px solid #777;border-radius:6px;overflow:hidden">
                            ${(secret.whoDoesNotKnow || []).map(name => `
                                <li class="nwst-nb-bullet" style="padding:5px 8px">
                                    <span class="nwst-nb-bullet-text nwst-knowledge-name" contenteditable="true" spellcheck="false" data-original-name="${escapeHTML(name)}">${escapeHTML(name)}</span>
                                    <button class="nwst-nb-bullet-del nwst-who-not-know-del">✕</button>
                                </li>`).join('')}
                        </ul>
                        <div class="nwst-nb-add-row" style="padding:4px 0 0;display:flex;gap:5px;align-items:center">
                            <input class="nwst-nb-add-input nwst-who-not-know-add" placeholder="Type a name" data-secret-id="${secret.id}" style="flex:1;min-width:0">
                            <button type="button" class="menu_button nwst-btn nwst-who-not-know-add-btn" style="font-size:10px;padding:2px 7px">Add</button>
                        </div>
                    </div>
                </div>

                <!-- Evidence shown -->
                <div class="nwst-secret-field" style="margin-bottom:8px">
                    <div class="nwst-secret-field-label">Evidence already shown
                        <button class="nwst-expand-btn" style="font-size:12px;color:#bbb;background:none;border:none;cursor:pointer;margin-left:4px" title="Open in popout" data-popout-field="evidenceShown">⛶</button>
                    </div>
                    <div class="nwst-secret-field-content" contenteditable="true" data-field="evidenceShown"
                        style="font-size:13px;line-height:1.5;border:0.5px solid #777;border-radius:6px;padding:6px 8px;min-height:32px;cursor:text">${escapeHTML(secret.evidenceShown)}</div>
                </div>

                <!-- Pressure / risk -->
                <div class="nwst-secret-field" style="margin-bottom:8px">
                    <div class="nwst-secret-field-label">Pressure / risk
                        <button class="nwst-expand-btn" style="font-size:12px;color:#bbb;background:none;border:none;cursor:pointer;margin-left:4px" title="Open in popout" data-popout-field="pressureRisk">⛶</button>
                    </div>
                    <div class="nwst-secret-field-content" contenteditable="true" data-field="pressureRisk"
                        style="font-size:13px;line-height:1.5;border:0.5px solid #777;border-radius:6px;padding:6px 8px;min-height:32px;cursor:text">${escapeHTML(secret.pressureRisk)}</div>
                </div>

                <!-- Reveal conditions -->
                <div class="nwst-secret-field" style="margin-bottom:8px">
                    <div class="nwst-secret-field-label">Reveal conditions
                        <button class="nwst-expand-btn" style="font-size:12px;color:#bbb;background:none;border:none;cursor:pointer;margin-left:4px" title="Open in popout" data-popout-field="revealConditions">⛶</button>
                    </div>
                    <div class="nwst-secret-field-content" contenteditable="true" data-field="revealConditions"
                        style="font-size:13px;line-height:1.5;border:0.5px solid #777;border-radius:6px;padding:6px 8px;min-height:32px;cursor:text">${escapeHTML(secret.revealConditions)}</div>
                </div>

                <div class="nwst-secret-field" style="margin-bottom:8px">
                    <div class="nwst-secret-field-label">Trigger anchors
                        <span style="font-size:10px;color:#999;font-weight:normal"> — distinctive words/phrases unique to THIS secret (comma-separated). These make injection reliable. e.g. for a secret about Mira: mira, affiliate, courier, tattoo</span>
                    </div>
                    <div class="nwst-secret-field-content" contenteditable="true" data-field="triggerAnchorsFlat"
                        style="font-size:13px;line-height:1.5;border:0.5px solid #777;border-radius:6px;padding:6px 8px;min-height:28px;cursor:text">${escapeHTML(flattenAnchors(secret.triggerAnchors))}</div>
                </div>

                <!-- Type selector + priority + delete -->
                <div class="nwst-btn-row" style="margin-top:10px">
                    <select class="nwst-secret-type-select" style="width:auto;font-size:11px;padding:3px 6px">
                        ${SECRET_TYPES.map(t => `<option value="${t.value}"${secret.type === t.value ? ' selected' : ''}>${t.label}</option>`).join('')}
                    </select>
                    <select class="nwst-secret-priority-select" title="Injection priority — controls when this secret is injected into the main prompt" style="width:auto;font-size:11px;padding:3px 6px">
                        <option value="critical"${(secret.injectionPriority || 'normal') === 'critical' ? ' selected' : ''}>‼ Critical — continuity guard</option>
                        <option value="high"${(secret.injectionPriority || 'normal') === 'high' ? ' selected' : ''}>⬆ High — hotter/more eager</option>
                        <option value="normal"${(secret.injectionPriority || 'normal') === 'normal' ? ' selected' : ''}>◈ Normal — standard relevance</option>
                        <option value="low"${(secret.injectionPriority || 'normal') === 'low' ? ' selected' : ''}>⬇ Low — background/rare</option>
                    </select>
                    <button class="menu_button nwst-btn nwst-secret-save" style="font-size:11px;padding:3px 9px;margin-left:auto" title="Save all edits to this secret">💾 Save</button>
                    ${lifecycleButton}
                    <button class="menu_button nwst-btn-danger nwst-secret-delete" style="font-size:11px;padding:3px 9px">Delete secret</button>
                </div>
            </div>
        </div>`;
    
    return e;
}

function refreshSecretsSection({ force = false } = {}) {
    const container = document.getElementById('nwst-nb-secrets-container');
    if (!container) return;

    // EDIT GUARD: if the user is actively editing a secret field (focus is
    // inside a secret entry, or an entry is flagged dirty), skip the rebuild.
    // A background scan re-rendering mid-edit is what caused edits to "roll
    // back" — the innerHTML replacement wiped in-progress typing.
    const active = document.activeElement;
    if (!force && active && active.closest && active.closest('.nwst-secret-entry')) {
        return; // someone is typing in a secret — do not clobber
    }
    if (!force && container.querySelector('.nwst-secret-entry.nwst-dirty')) {
        return; // unsaved edits pending — do not clobber
    }

    const chatId = getChatId();
    const secrets = getAllSecrets(chatId);

    if (secrets.length === 0) {
        container.innerHTML = '<div class="nwst-nb-empty">No secrets yet. Add one to track hidden knowledge.</div>';
        return;
    }

    // Preserve the current filter text across rebuilds
    const prevFilter = (document.getElementById('nwst-secret-filter')?.value || '').toLowerCase().trim();

    const statusOf = (s) => (s.status || 'active');
    const pending       = secrets.filter(s => statusOf(s) === 'pending_archive');
    const activeSecrets = secrets.filter(s => statusOf(s) === 'active');
    const archived      = secrets.filter(s => statusOf(s) === 'archived');

    // Filter predicate — matches title, secret text, involved parties, type
    const matchesFilter = (s) => {
        if (!prevFilter) return true;
        const hay = [
            s.title, s.secret, s.type,
            ...(s.whoKnows || []), ...(s.whoDoesNotKnow || [])
        ].join(' ').toLowerCase();
        return hay.includes(prevFilter);
    };

    let html = '';

    // ── Filter bar ─────────────────────────────────────────────
    html += `<div style="margin-bottom:10px">
        <input type="text" id="nwst-secret-filter" placeholder="Filter secrets by name, character, or type..."
            value="${escapeHTML(prevFilter)}"
            style="width:100%;font-size:12px;padding:5px 9px;border:0.5px solid #777;border-radius:6px">
    </div>`;

    // ── Pending archive review (always shown when non-empty) ───
    if (pending.length > 0) {
        html += `<div class="nwst-secret-group" style="margin-bottom:10px">
            <div style="font-size:12px;font-weight:600;color:#d6a93a;margin-bottom:6px">
                ⚠ Pending archive review (${pending.length})
            </div>
            <div style="font-size:11px;color:#999;margin-bottom:8px">
                These secrets were flagged as revealed or dormant. Archive stops them injecting; Keep active restores them.
            </div>`;
        for (const s of pending) {
            const reason = s.archiveReason === 'revealed' ? 'revealed on-screen'
                         : s.archiveReason === 'dormant' ? 'dormant (not injected in a long time)'
                         : 'flagged';
            html += `<div class="nwst-pending-secret" data-secret-id="${s.id}"
                style="border:0.5px solid #d6a93a;border-radius:6px;padding:8px 10px;margin-bottom:6px">
                <div style="font-weight:500;font-size:13px">${escapeHTML(s.title || 'Untitled')}</div>
                <div style="font-size:11px;color:#999;margin:2px 0 6px">Reason: ${reason}</div>
                <div class="nwst-btn-row" style="gap:6px">
                    <button class="menu_button nwst-btn nwst-secret-archive" style="font-size:11px;padding:3px 9px">Archive</button>
                    <button class="menu_button nwst-btn nwst-secret-keepactive" style="font-size:11px;padding:3px 9px">Keep active</button>
                </div>
            </div>`;
        }
        html += `</div>`;
    }

    // ── Active secrets, sub-grouped by type ────────────────────
    const activeFiltered = activeSecrets.filter(matchesFilter);
    if (activeFiltered.length > 0) {
        html += `<div class="nwst-secret-group">
            <div style="font-size:12px;font-weight:600;color:#bbb;margin-bottom:6px">Active (${activeFiltered.length})</div>`;
        for (const typeDef of SECRET_TYPES) {
            const ofType = activeFiltered.filter(s => (s.type || 'character') === typeDef.value);
            if (ofType.length === 0) continue;
            html += `<details class="nwst-secret-typegroup" open style="margin-bottom:8px">
                <summary style="font-size:11px;color:#999;cursor:pointer;padding:2px 0">${typeDef.label} (${ofType.length})</summary>
                <div style="margin-top:6px">`;
            for (const s of ofType) html += buildSecretEntryHTML(s);
            html += `</div></details>`;
        }
        html += `</div>`;
    } else if (prevFilter) {
        html += `<div class="nwst-nb-empty" style="font-size:12px">No active secrets match "${escapeHTML(prevFilter)}".</div>`;
    }

    // ── Archived secrets (collapsed) ───────────────────────────
    const archivedFiltered = archived.filter(matchesFilter);
    if (archivedFiltered.length > 0) {
        html += `<details class="nwst-secret-group" style="margin-top:10px">
            <summary style="font-size:12px;font-weight:600;color:#888;cursor:pointer">Archived (${archivedFiltered.length}) — not injected</summary>
            <div style="margin-top:8px;opacity:0.7">`;
        for (const s of archivedFiltered) html += buildSecretEntryHTML(s);
        html += `</div></details>`;
    }

    container.innerHTML = html;
    wireSecretEvents();
    wireSecretFilterAndArchive();
}

function wireSecretFilterAndArchive() {
    // Filter input — re-render the secrets section on input (debounced lightly)
    const filterInput = document.getElementById('nwst-secret-filter');
    if (filterInput) {
        let t = null;
        filterInput.oninput = function () {
            clearTimeout(t);
            const caret = this.selectionStart;
            t = setTimeout(() => {
                refreshSecretsSection();
                // Restore focus + caret after re-render
                const again = document.getElementById('nwst-secret-filter');
                if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) {} }
            }, 200);
        };
    }

    // Archive / Keep active buttons in the pending review group
    document.querySelectorAll('.nwst-secret-archive').forEach(btn => {
        btn.onclick = async function () {
            const card = this.closest('.nwst-pending-secret');
            const secretId = card?.getAttribute('data-secret-id');
            if (!secretId) return;
            await resolveArchiveDecision(getChatId(), secretId, 'archive');
            nwstToast('Secret archived — it will no longer be injected.', 'success');
            refreshSecretsSection();
        };
    });
    document.querySelectorAll('.nwst-secret-keepactive').forEach(btn => {
        btn.onclick = async function () {
            const card = this.closest('.nwst-pending-secret');
            const secretId = card?.getAttribute('data-secret-id');
            if (!secretId) return;
            await resolveArchiveDecision(getChatId(), secretId, 'keep');
            nwstToast('Secret kept active.', 'info');
            refreshSecretsSection();
        };
    });
}

// ── Explicit section-level saves ─────────────────────────────────────────

function validateHiddenIntentionForm(form) {
    if (['active_plan', 'contingency'].includes(form.type) && !form.strategy) {
        return 'Active Plans and Contingencies require a strategy describing the broad method.';
    }
    if (['active_plan', 'commitment'].includes(form.type) && !form.nextAction) {
        return 'Active Plans and Commitments require a nearest next action.';
    }
    if (form.type === 'contingency' && !form.triggerConditions.length) {
        return 'Contingencies require at least one trigger condition.';
    }
    return '';
}

async function saveHiddenIntentionsSection({ notify = true } = {}) {
    const container = document.getElementById('nwst-hi-container');
    if (!container) return true;
    const pending = Array.from(container.querySelectorAll('.nwst-hi-card')).map(card => ({
        card,
        id: card.getAttribute('data-intention-id'),
        form: collectHiddenIntentionForm(card)
    })).filter(item => item.id);
    for (const item of pending) {
        const problem = validateHiddenIntentionForm(item.form);
        if (problem) {
            if (notify) nwstToast(`Hidden Intentions not saved: ${problem}`, 'warning');
            return false;
        }
    }
    try {
        for (const item of pending) await updateHiddenIntention(getChatId(), item.id, item.form);
        if (notify) nwstToast('Hidden Intention edits saved.', 'success');
        return true;
    } catch (error) {
        console.error('[NWST Notebook] Could not save Hidden Intentions section:', error);
        if (notify) nwstToast('Hidden Intention edits could not be saved.', 'error');
        return false;
    }
}

async function saveSecretsSection({ notify = true } = {}) {
    const container = document.getElementById('nwst-nb-secrets-container');
    if (!container) return true;
    const entries = Array.from(container.querySelectorAll('.nwst-secret-entry'));
    try {
        for (const entry of entries) {
            const secretId = entry.getAttribute('data-secret-id');
            if (!secretId) continue;
            await updateSecret(getChatId(), secretId, collectSecretEntryUpdates(entry));
            entry.classList.remove('nwst-dirty');
        }
        if (notify) nwstToast('Secret edits saved.', 'success');
        return true;
    } catch (error) {
        console.error('[NWST Notebook] Could not save Secrets section:', error);
        if (notify) nwstToast('Some Secret edits could not be saved.', 'error');
        return false;
    }
}

async function saveNotebookSection(section) {
    if (section === 'core' || section === 'mystery') return saveBulletNotebookSection(section);
    if (section === 'hiddenIntentions') return saveHiddenIntentionsSection();
    if (section === 'secrets') return saveSecretsSection();
    return false;
}

// ── Wire notebook-level events ────────────────────────────────────────────

function wireNotebookEvents() {
    // ── Accordion toggle ───────────────────────────────────────
    document.querySelectorAll('.nwst-nb-toggle').forEach(hdr => {
        hdr.onclick = async function () {
            const sectionId = this.getAttribute('data-section');
            const section = document.getElementById(`nwst-nb-${sectionId}`);
            if (section) section.classList.toggle('nwst-open');
        };
    });

    // ── Explicit section Save edits buttons ────────────────────
    document.querySelectorAll('.nwst-nb-section-save[data-save-section]').forEach(btn => {
        // Do not collapse the accordion or trigger a competing blur before the
        // explicit save captures the current inline value.
        btn.onmousedown = e => e.preventDefault();
        btn.onclick = async function (e) {
            e.preventDefault();
            e.stopPropagation();
            const section = this.getAttribute('data-save-section');
            const oldText = this.textContent;
            this.disabled = true;
            this.textContent = 'Saving…';
            try {
                await saveNotebookSection(section);
            } finally {
                this.disabled = false;
                this.textContent = oldText;
            }
        };
    });

    // ── Clear all ──────────────────────────────────────────────
    const clearBtn = document.getElementById('nwst-nb-clearAll');
    if (clearBtn) {
        clearBtn.onclick = async () => {
            const chatId = getChatId();
            await clearNotebook(chatId);
            refreshNotebookUI();
            nwstToast('Notebook cleared.', 'warning');
        };
    }

    // ── Hidden Intentions controls ──────────────────────────
    const addIntentionBtn = document.getElementById('nwst-hi-add');
    if (addIntentionBtn) {
        addIntentionBtn.onclick = async () => {
            const actor = String(window.prompt('NPC name for this intention:', '') || '').trim();
            if (!actor) return;
            const objective = String(window.prompt('Durable objective or intended action:', '') || '').trim();
            if (!objective) return;
            const registry = buildAliasRegistry(getChatId());
            const actorId = registry.resolve(actor) || toCanonicalId(actor);
            if (registry.isUserPc(actorId)) {
                nwstToast('The user character cannot own Hidden Intentions.', 'warning');
                return;
            }
            await addHiddenIntention(getChatId(), {
                actor,
                actorId,
                type: 'objective',
                domain: 'personal',
                objective,
                basis: ['Manually added by the player.'],
                status: 'active',
                confidence: 'high',
                commitment: 'medium',
                locked: true,
                origin: 'manual'
            });
            refreshHiddenIntentionsSection();
            nwstToast('Hidden intention added and wording locked.', 'success');
        };
    }
    const generateIntentionsBtn = document.getElementById('nwst-hi-generate');
    if (generateIntentionsBtn) {
        generateIntentionsBtn.onclick = async () => {
            generateIntentionsBtn.disabled = true;
            const original = generateIntentionsBtn.textContent;
            generateIntentionsBtn.textContent = '⏳ Generating...';
            try {
                await runHiddenIntentionsGenerate({ trigger: 'manual_generate', expectedChatId: getChatId(), force: true, broad: true });
                refreshHiddenIntentionsSection();
            } finally {
                generateIntentionsBtn.disabled = false;
                generateIntentionsBtn.textContent = original;
            }
        };
    }
    const reconcileIntentionsBtn = document.getElementById('nwst-hi-reconcile');
    if (reconcileIntentionsBtn) {
        reconcileIntentionsBtn.onclick = async () => {
            reconcileIntentionsBtn.disabled = true;
            const original = reconcileIntentionsBtn.textContent;
            reconcileIntentionsBtn.textContent = '⏳ Reconciling...';
            try {
                await runHiddenIntentionsReconcile({ trigger: 'manual_reconcile', expectedChatId: getChatId(), force: true });
                refreshHiddenIntentionsSection();
            } finally {
                reconcileIntentionsBtn.disabled = false;
                reconcileIntentionsBtn.textContent = original;
            }
        };
    }

    // ── Add secret button ──────────────────────────────────────
    // Direct onclick assignment — self-deduplicating, survives re-renders
    const addSecretBtn = document.querySelector('.nwst-nb-add-secret');
    if (addSecretBtn) {
        addSecretBtn.onclick = async function () {
            const chatId = getChatId();
            await addSecret(chatId, {
                title: 'New secret',
                type: 'character',
                secret: '',
                whoKnows: [],
                whoDoesNotKnow: [],
                injectionPriority: 'normal'
            });
            refreshSecretsSection();
            nwstToast('Secret added.', 'info');
        };
    }

    // ── Scan for secrets button ────────────────────────────────
    const scanBtn = document.getElementById('nwst-nb-scan-secrets');
    if (scanBtn) {
        scanBtn.onclick = async function () {
            const chatId = getChatId();
            scanBtn.disabled = true;
            scanBtn.textContent = '⏳ Scanning...';
            try {
                const { scanForSecrets } = await import('../llm/secretScan.js');
                const count = await scanForSecrets(chatId);
                refreshSecretsSection();
                if (count > 0) {
                    nwstToast(`Found ${count} new secret(s) from full history scan.`, 'success');
                } else {
                    nwstToast('No new secrets detected in the chat history.', 'info');
                }
            } catch (e) {
                console.error('[NWST Notebook] Secrets scan failed:', e);
                nwstToast('Secrets scan failed. Check console.', 'error');
            } finally {
                scanBtn.disabled = false;
                scanBtn.textContent = '🔍 Scan for secrets';
            }
        };
    }

    wireSecretEvents();
}

// ── Wire secret-specific events ───────────────────────────────────────────
// Single clean wiring — no duplicate registrations.

/**
 * Read the complete editable state of one Secret card. Lifecycle actions use
 * this too so clicking Archive/Restore cannot discard text that has not yet
 * blurred/saved.
 */
function collectSecretEntryUpdates(entry) {
    const updates = {};
    const titleEl = entry?.querySelector('.nwst-secret-title');
    if (titleEl) updates.title = titleEl.textContent.trim() || 'Untitled secret';

    entry?.querySelectorAll('.nwst-secret-field-content[contenteditable]').forEach(el => {
        const field = el.getAttribute('data-field');
        const value = el.textContent.trim();
        if (field === 'triggerAnchorsFlat') {
            updates.triggerAnchors = parseAnchors(value);
        } else if (field) {
            updates[field] = value;
        }
    });

    updates.whoKnows = Array.from(entry?.querySelectorAll('.nwst-who-knows-list .nwst-knowledge-name') || [])
        .map(el => el.textContent.trim()).filter(Boolean);
    updates.whoDoesNotKnow = Array.from(entry?.querySelectorAll('.nwst-who-not-know-list .nwst-knowledge-name') || [])
        .map(el => el.textContent.trim()).filter(Boolean);

    const typeSel = entry?.querySelector('.nwst-secret-type-select');
    if (typeSel) updates.type = typeSel.value;
    const prioSel = entry?.querySelector('.nwst-secret-priority-select');
    if (prioSel) updates.injectionPriority = prioSel.value;
    return updates;
}

function wireSecretEvents() {
    const container = document.getElementById('nwst-nb-secrets-container');
    if (!container) return;

    // ── Expand/collapse toggle ─────────────────────────────────
    container.querySelectorAll('.nwst-secret-toggle').forEach(hdr => {
        hdr.onclick = function () {
            const entry = this.closest('.nwst-secret-entry');
            if (!entry) return;
            entry.classList.toggle('nwst-open');
            const secretId = entry.getAttribute('data-secret-id');
            if (entry.classList.contains('nwst-open')) openSecretIds.add(secretId);
            else openSecretIds.delete(secretId);
        };
    });

    // ── Manual archive / restore ────────────────────────────────
    // Prevent mousedown from moving focus first. Otherwise an async blur-save
    // can race the lifecycle write and resurrect the old status afterward.
    container.querySelectorAll('.nwst-secret-manual-archive, .nwst-secret-restore').forEach(btn => {
        btn.onmousedown = (e) => e.preventDefault();
    });

    container.querySelectorAll('.nwst-secret-manual-archive').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!secretId) return;
            const chatId = getChatId();
            const updates = collectSecretEntryUpdates(entry);
            updates.status = 'archived';
            updates.archiveReason = 'manual';
            updates.flaggedAtMsgIndex = -1;
            await updateSecret(chatId, secretId, updates);
            entry.classList.remove('nwst-dirty');
            openSecretIds.delete(secretId);
            refreshSecretsSection({ force: true });
            nwstToast('Secret archived — it will no longer be injected.', 'success');
        };
    });

    container.querySelectorAll('.nwst-secret-restore').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!secretId) return;
            const chatId = getChatId();
            const updates = collectSecretEntryUpdates(entry);
            updates.status = 'active';
            updates.archiveReason = '';
            updates.flaggedAtMsgIndex = -1;
            await updateSecret(chatId, secretId, updates);
            entry.classList.remove('nwst-dirty');
            openSecretIds.add(secretId);
            refreshSecretsSection({ force: true });
            nwstToast('Secret restored to active tracking.', 'success');
        };
    });

    // ── Delete secret (✕ header button and body Delete button) ─
    container.querySelectorAll('.nwst-secret-delete-btn, .nwst-secret-delete').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!secretId) return;
            const chatId = getChatId();
            await deleteSecret(chatId, secretId);
            openSecretIds.delete(secretId);
            refreshSecretsSection({ force: true });
            nwstToast('Secret deleted.', 'info');
        };
    });

    // ── Mark a secret entry dirty while editing (edit guard) ───
    container.querySelectorAll('.nwst-secret-field-content[contenteditable], .nwst-secret-title').forEach(el => {
        el.oninput = function () {
            const entry = this.closest('.nwst-secret-entry');
            if (entry) entry.classList.add('nwst-dirty');
        };
    });

    // ── Save contenteditable secret fields on blur ─────────────
    container.querySelectorAll('.nwst-secret-field-content[contenteditable]').forEach(el => {
        el.onblur = async function () {
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!secretId) return;
            const field = this.getAttribute('data-field');
            const value = this.textContent.trim();
            const chatId = getChatId();
            if (field === 'triggerAnchorsFlat') {
                await updateSecret(chatId, secretId, { triggerAnchors: parseAnchors(value) });
            } else {
                await updateSecret(chatId, secretId, { [field]: value });
            }
            // Clear dirty once focus has left the entry entirely (next tick, so
            // activeElement has updated). Keeps the guard while tabbing between
            // fields, releases it when the user leaves the secret.
            setTimeout(() => {
                const stillInside = document.activeElement &&
                    document.activeElement.closest &&
                    document.activeElement.closest('.nwst-secret-entry') === entry;
                if (!stillInside) entry.classList.remove('nwst-dirty');
            }, 0);
        };
    });

    // ── Also clear dirty when the title field blur-saves ───────
    // (title handler below saves separately; this keeps the guard consistent)

    // ── Save button: commit ALL fields of a secret at once ─────
    container.querySelectorAll('.nwst-secret-save').forEach(btn => {
        btn.onclick = async function () {
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!secretId) return;
            const chatId = getChatId();

            const updates = collectSecretEntryUpdates(entry);
            await updateSecret(chatId, secretId, updates);
            entry.classList.remove('nwst-dirty');   // clear edit guard
            nwstToast('Secret saved.', 'success');
        };
    });

    // ── Save secret title on blur ──────────────────────────────
    container.querySelectorAll('.nwst-secret-title').forEach(span => {
        span.onblur = async function () {
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!secretId) return;
            const chatId = getChatId();
            const newTitle = this.textContent.trim() || 'Untitled secret';
            await updateSecret(chatId, secretId, { title: newTitle });
            setTimeout(() => {
                const stillInside = document.activeElement &&
                    document.activeElement.closest &&
                    document.activeElement.closest('.nwst-secret-entry') === entry;
                if (entry && !stillInside) entry.classList.remove('nwst-dirty');
            }, 0);
        };
    });

    // ── Type selector ──────────────────────────────────────────
    container.querySelectorAll('.nwst-secret-type-select').forEach(select => {
        select.onchange = async function () {
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!secretId) return;
            const chatId = getChatId();
            await updateSecret(chatId, secretId, { type: this.value });
            const typeDef = SECRET_TYPES.find(t => t.value === this.value);
            const badge = entry.querySelector('.nwst-secret-type');
            if (badge && typeDef) {
                badge.textContent = typeDef.label;
                badge.className = `nwst-secret-type ${typeDef.cssClass}`;
            }
        };
    });

    // ── Injection priority selector ────────────────────────────
    container.querySelectorAll('.nwst-secret-priority-select').forEach(select => {
        select.onchange = async function () {
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!secretId) return;
            const chatId = getChatId();
            await updateSecret(chatId, secretId, { injectionPriority: this.value });
            // Update border/color to reflect priority visually
            const colors = {
                high:   { border: '#1D9E75', color: '#0F6E56' },
                normal: { border: '#AFA9EC', color: '#3C3489' },
                low:    { border: '#999',    color: '#999'    }
            };
            const c = colors[this.value] || colors.normal;
            this.style.borderColor = c.border;
            this.style.color = c.color;
        };
    });

    // ── Add / edit knowledge holders ───────────────────────
    async function addKnowledgeHolder(input, listType) {
        const name = String(input?.value || '').trim();
        if (!name) return;
        const secretId = input.getAttribute('data-secret-id');
        const chatId = getChatId();
        if (!secretId || !chatId) return;
        if (listType === 'knows') await addWhoKnows(chatId, secretId, name);
        else await addWhoDoesNotKnow(chatId, secretId, name);
        input.value = '';
        input.blur(); // release edit guard before rebuilding the chips
        openSecretIds.add(secretId);
        refreshSecretsSection({ force: true });
        nwstToast(`${name} added to ${listType === 'knows' ? 'Who Knows' : 'Who Does Not Know'}.`, 'success');
    }

    container.querySelectorAll('.nwst-who-knows-add').forEach(input => {
        input.onkeydown = async function (e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            await addKnowledgeHolder(this, 'knows');
        };
    });
    container.querySelectorAll('.nwst-who-not-know-add').forEach(input => {
        input.onkeydown = async function (e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            await addKnowledgeHolder(this, 'not');
        };
    });
    container.querySelectorAll('.nwst-who-knows-add-btn').forEach(btn => {
        btn.onclick = async function () {
            await addKnowledgeHolder(this.parentElement?.querySelector('.nwst-who-knows-add'), 'knows');
        };
    });
    container.querySelectorAll('.nwst-who-not-know-add-btn').forEach(btn => {
        btn.onclick = async function () {
            await addKnowledgeHolder(this.parentElement?.querySelector('.nwst-who-not-know-add'), 'not');
        };
    });

    // Inline holder names are real editable fields, not decorative text.
    container.querySelectorAll('.nwst-knowledge-name').forEach(span => {
        span.onkeydown = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); this.blur(); }
        };
        span.oninput = function () {
            this.closest('.nwst-secret-entry')?.classList.add('nwst-dirty');
        };
        span.onblur = async function () {
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!entry || !secretId) return;
            const updates = {
                whoKnows: Array.from(entry.querySelectorAll('.nwst-who-knows-list .nwst-knowledge-name')).map(el => el.textContent.trim()).filter(Boolean),
                whoDoesNotKnow: Array.from(entry.querySelectorAll('.nwst-who-not-know-list .nwst-knowledge-name')).map(el => el.textContent.trim()).filter(Boolean)
            };
            await updateSecret(getChatId(), secretId, updates);
            entry.classList.remove('nwst-dirty');
            openSecretIds.add(secretId);
            refreshSecretsSection({ force: true });
        };
    });

    // ── Remove Who Knows ───────────────────────────────────────
    container.querySelectorAll('.nwst-who-knows-del').forEach(btn => {
        btn.onclick = async function () {
            const nameEl = this.parentElement.querySelector('.nwst-nb-bullet-text');
            const name = nameEl ? nameEl.textContent.trim() : '';
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!name || !secretId) return;
            const chatId = getChatId();
            await removeWhoKnows(chatId, secretId, name);
            openSecretIds.add(secretId);
            refreshSecretsSection({ force: true });
        };
    });

    // ── Remove Who Does NOT Know ───────────────────────────────
    container.querySelectorAll('.nwst-who-not-know-del').forEach(btn => {
        btn.onclick = async function () {
            const nameEl = this.parentElement.querySelector('.nwst-nb-bullet-text');
            const name = nameEl ? nameEl.textContent.trim() : '';
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!name || !secretId) return;
            const chatId = getChatId();
            await removeWhoDoesNotKnow(chatId, secretId, name);
            openSecretIds.add(secretId);
            refreshSecretsSection({ force: true });
        };
    });

    // ── ⛶ Popout buttons on secret fields ─────────────────────
    container.querySelectorAll('.nwst-expand-btn[data-popout-field]').forEach(btn => {
        btn.onclick = async function (e) {
            e.stopPropagation();
            const field = this.getAttribute('data-popout-field');
            const secretEntry = this.closest('.nwst-secret-entry');
            const secretId = secretEntry?.getAttribute('data-secret-id');
            const contentEl = this.closest('.nwst-secret-field')?.querySelector('.nwst-secret-field-content');
            const currentText = contentEl ? contentEl.textContent.trim() : '';
            const fieldLabel = this.getAttribute('title') || field;

            if (typeof window.openNWSTPopout === 'function') {
                window.openNWSTPopout(fieldLabel, currentText, async (saved) => {
                    if (contentEl) contentEl.textContent = saved;
                    const chatId = getChatId();
                    if (secretId) await updateSecret(chatId, secretId, { [field]: saved });
                });
            }
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
