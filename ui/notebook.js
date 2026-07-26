/* eslint-disable */
// =============================================================================
// NWST Notebook Tab UI — ui/notebook.js
// =============================================================================
// Builds and manages the Notebook tab pane. Matches nwst-mockup.html exactly.
//
// Layout:
//   • Info box explaining the notebook's purpose
//   • Three accordion sections: Core, Mystery & Continuity, Secrets & Hidden Knowledge
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

// ── Build the Notebook tab HTML ───────────────────────────────────────────

export function buildNotebookTab() {
    const pane = document.getElementById('nwst-pane-notebook');
    if (!pane) return;

    pane.innerHTML = `
        <div class="nwst-info-box">
            The notebook is the planner LLM's internal working surface. These notes are <strong>never injected</strong> into your main prompt.
            Click ✎ to edit inline, or ⛶ to open a larger popout editor. Press Enter in the input row to add a new bullet.
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
                <span style="font-size:11px;color:#999">▾</span>
            </div>
            <div class="nwst-nb-section-body" id="nwst-nb-core-body"></div>
        </div>

        <!-- Mystery & Continuity section -->
        <div class="nwst-nb-section" id="nwst-nb-mystery">
            <div class="nwst-nb-section-hdr nwst-nb-toggle" data-section="mystery">
                <span class="nwst-nb-section-title">Mystery & Continuity</span>
                <span style="font-size:11px;color:#999">▾</span>
            </div>
            <div class="nwst-nb-section-body" id="nwst-nb-mystery-body"></div>
        </div>

        <!-- Secrets & Hidden Knowledge section -->
        <div class="nwst-nb-section" id="nwst-nb-secrets">
            <div class="nwst-nb-section-hdr nwst-nb-toggle" data-section="secrets">
                <span class="nwst-nb-section-title">Secrets & Hidden Knowledge</span>
                <span style="font-size:11px;color:#999">▾</span>
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

function wireBulletEvents(container) {
    if (!container) return;

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

                // Re-wire events after refresh
                wireBulletEvents(document.getElementById(`nwst-nb-${section}-body`));
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

            wireBulletEvents(document.getElementById(`nwst-nb-${section}-body`));
        });
    });

    // ── Save edited bullet on blur ─────────────────────────────
    container.querySelectorAll('.nwst-nb-bullet-text').forEach(span => {
        span.addEventListener('blur', async function () {
            const bullet = this.closest('.nwst-nb-bullet');
            const field = this.closest('.nwst-nb-field');
            const section = field.getAttribute('data-section');
            const fieldKey = field.getAttribute('data-field');
            const index = parseInt(bullet.getAttribute('data-index'), 10);
            const newText = this.textContent.trim();
            const chatId = getChatId();

            if (section === 'core') {
                await updateCoreBullet(chatId, fieldKey, index, newText);
            } else if (section === 'mystery') {
                await updateMysteryBullet(chatId, fieldKey, index, newText);
            }
        });

        // ── ⛶ popout button on focus ───────────────────────────
        span.addEventListener('focus', async function () {
            const bullet = this.closest('.nwst-nb-bullet');
            // Remove existing popout button if any
            const existing = bullet.querySelector('.nwst-nb-bullet-expand');
            if (existing) existing.remove();

            const popoutBtn = document.createElement('button');
            popoutBtn.className = 'nwst-nb-bullet-expand nwst-expand-btn editor_maximize';
            popoutBtn.title = 'Open in popout';
            popoutBtn.textContent = '⛶';
            popoutBtn.style.cssText = 'font-size:13px;color:#aaa;margin-top:1px;';
            popoutBtn.setAttribute('data-for', this.id);
            // Prevent blur from the contenteditable span when clicking the button
            popoutBtn.onmousedown = function (ev) {
                ev.preventDefault();
            };
            bullet.insertBefore(popoutBtn, bullet.querySelector('.nwst-nb-bullet-del'));
        });

        span.addEventListener('blur', async function () {
            // Remove popout button after a short delay (allows click to register)
            setTimeout(() => {
                const bullet = this.closest('.nwst-nb-bullet');
                if (bullet) {
                    const btn = bullet.querySelector('.nwst-nb-bullet-expand');
                    if (btn) btn.remove();
                }
            }, 150);
        });
    });
}

// ── Secrets section ───────────────────────────────────────────────────────

function buildSecretEntryHTML(secret) {
    let e = '';

        const typeDef = SECRET_TYPES.find(t => t.value === secret.type) || SECRET_TYPES[0];
        const isOpen = false; // All secrets collapsed by default — reduces visual noise

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
                                    <span class="nwst-nb-bullet-text" contenteditable="true">${escapeHTML(name)}</span>
                                    <button class="nwst-nb-bullet-del nwst-who-knows-del">✕</button>
                                </li>`).join('')}
                        </ul>
                        <div class="nwst-nb-add-row" style="padding:4px 0 0">
                            <input class="nwst-nb-add-input nwst-who-knows-add" placeholder="+ Add" data-secret-id="${secret.id}">
                        </div>
                    </div>
                    <div class="nwst-secret-field">
                        <div class="nwst-secret-field-label" style="color:#993C1D">Who does NOT know</div>
                        <ul class="nwst-nb-bullets nwst-who-not-know-list" style="border:0.5px solid #777;border-radius:6px;overflow:hidden">
                            ${(secret.whoDoesNotKnow || []).map(name => `
                                <li class="nwst-nb-bullet" style="padding:5px 8px">
                                    <span class="nwst-nb-bullet-text" contenteditable="true">${escapeHTML(name)}</span>
                                    <button class="nwst-nb-bullet-del nwst-who-not-know-del">✕</button>
                                </li>`).join('')}
                        </ul>
                        <div class="nwst-nb-add-row" style="padding:4px 0 0">
                            <input class="nwst-nb-add-input nwst-who-not-know-add" placeholder="+ Add" data-secret-id="${secret.id}">
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
                        <span style="font-size:10px;color:#999;font-weight:normal"> — distinctive words/phrases unique to THIS secret (comma-separated). These make injection reliable. e.g. for a secret about Mara: mara, night courier, silver ring, east gate</span>
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
                    <button class="menu_button nwst-btn-danger nwst-secret-delete" style="font-size:11px;padding:3px 9px">Delete secret</button>
                </div>
            </div>
        </div>`;
    
    return e;
}

function refreshSecretsSection() {
    const container = document.getElementById('nwst-nb-secrets-container');
    if (!container) return;

    // EDIT GUARD: if the user is actively editing a secret field (focus is
    // inside a secret entry, or an entry is flagged dirty), skip the rebuild.
    // A background scan re-rendering mid-edit is what caused edits to "roll
    // back" — the innerHTML replacement wiped in-progress typing.
    const active = document.activeElement;
    if (active && active.closest && active.closest('.nwst-secret-entry')) {
        return; // someone is typing in a secret — do not clobber
    }
    if (container.querySelector('.nwst-secret-entry.nwst-dirty')) {
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

function wireSecretEvents() {
    const container = document.getElementById('nwst-nb-secrets-container');
    if (!container) return;

    // ── Expand/collapse toggle ─────────────────────────────────
    container.querySelectorAll('.nwst-secret-toggle').forEach(hdr => {
        hdr.onclick = function () {
            this.closest('.nwst-secret-entry').classList.toggle('nwst-open');
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
            refreshSecretsSection();
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

            // Gather every field from the entry's DOM
            const updates = {};
            const titleEl = entry.querySelector('.nwst-secret-title');
            if (titleEl) updates.title = titleEl.textContent.trim() || 'Untitled secret';

            entry.querySelectorAll('.nwst-secret-field-content[contenteditable]').forEach(el => {
                const field = el.getAttribute('data-field');
                const value = el.textContent.trim();
                if (field === 'triggerAnchorsFlat') {
                    updates.triggerAnchors = parseAnchors(value);
                } else if (field) {
                    updates[field] = value;
                }
            });

            const typeSel = entry.querySelector('.nwst-secret-type-select');
            if (typeSel) updates.type = typeSel.value;
            const prioSel = entry.querySelector('.nwst-secret-priority-select');
            if (prioSel) updates.injectionPriority = prioSel.value;

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

    // ── Add Who Knows (Enter key) ──────────────────────────────
    container.querySelectorAll('.nwst-who-knows-add').forEach(input => {
        input.onkeydown = async function (e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const name = this.value.trim();
            if (!name) return;
            const secretId = this.getAttribute('data-secret-id');
            const chatId = getChatId();
            await addWhoKnows(chatId, secretId, name);
            this.value = '';
            refreshSecretsSection();
        };
    });

    // ── Add Who Does NOT Know (Enter key) ─────────────────────
    container.querySelectorAll('.nwst-who-not-know-add').forEach(input => {
        input.onkeydown = async function (e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const name = this.value.trim();
            if (!name) return;
            const secretId = this.getAttribute('data-secret-id');
            const chatId = getChatId();
            await addWhoDoesNotKnow(chatId, secretId, name);
            this.value = '';
            refreshSecretsSection();
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
            refreshSecretsSection();
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
            refreshSecretsSection();
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
