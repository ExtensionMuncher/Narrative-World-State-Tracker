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
import {
    getNotebook,
    getCoreFields, addCoreBullet, updateCoreBullet, deleteCoreBullet,
    getMysteryFields, addMysteryBullet, updateMysteryBullet, deleteMysteryBullet,
    getAllSecrets, addSecret, updateSecret, deleteSecret,
    addWhoKnows, removeWhoKnows, addWhoDoesNotKnow, removeWhoDoesNotKnow,
    clearNotebook
} from '../data/notebook.js';

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

        <!-- Core section -->
        <div class="nwst-nb-section nwst-open" id="nwst-nb-core">
            <div class="nwst-nb-section-hdr nwst-nb-toggle" data-section="core">
                <span class="nwst-nb-section-title">Core</span>
                <span style="font-size:11px;color:#999">▾</span>
            </div>
            <div class="nwst-nb-section-body" id="nwst-nb-core-body"></div>
        </div>

        <!-- Mystery & Continuity section -->
        <div class="nwst-nb-section nwst-open" id="nwst-nb-mystery">
            <div class="nwst-nb-section-hdr nwst-nb-toggle" data-section="mystery">
                <span class="nwst-nb-section-title">Mystery & Continuity</span>
                <span style="font-size:11px;color:#999">▾</span>
            </div>
            <div class="nwst-nb-section-body" id="nwst-nb-mystery-body"></div>
        </div>

        <!-- Secrets & Hidden Knowledge section -->
        <div class="nwst-nb-section nwst-open" id="nwst-nb-secrets">
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
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
                    <button class="menu_button nwst-btn" id="nwst-nb-scan-secrets">🔍 Scan for secrets</button>
                    <button class="menu_button nwst-btn nwst-nb-add-secret">+ Add secret</button>
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
}

// ── Refresh all notebook sections ─────────────────────────────────────────

export function refreshNotebookUI() {
    refreshCoreSection();
    refreshMysterySection();
    refreshSecretsSection();
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

function refreshSecretsSection() {
    const container = document.getElementById('nwst-nb-secrets-container');
    if (!container) return;

    const chatId = getChatId();
    const secrets = getAllSecrets(chatId);

    if (secrets.length === 0) {
        container.innerHTML = '<div class="nwst-nb-empty">No secrets yet. Add one to track hidden knowledge.</div>';
        return;
    }

    let html = '';
    for (const secret of secrets) {
        const typeDef = SECRET_TYPES.find(t => t.value === secret.type) || SECRET_TYPES[0];
        const isOpen = true; // All secrets open by default

        html += `
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
                        style="font-size:13px;line-height:1.5;border:0.5px solid #eee;border-radius:6px;padding:6px 8px;min-height:32px;cursor:text"
                        data-field="secret">${escapeHTML(secret.secret)}</div>
                </div>

                <!-- Who Knows / Who Does NOT Know -->
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
                    <div class="nwst-secret-field">
                        <div class="nwst-secret-field-label" style="color:#0F6E56">Who knows</div>
                        <ul class="nwst-nb-bullets nwst-who-knows-list" style="border:0.5px solid #eee;border-radius:6px;overflow:hidden">
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
                        <ul class="nwst-nb-bullets nwst-who-not-know-list" style="border:0.5px solid #eee;border-radius:6px;overflow:hidden">
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
                        style="font-size:13px;line-height:1.5;border:0.5px solid #eee;border-radius:6px;padding:6px 8px;min-height:32px;cursor:text">${escapeHTML(secret.evidenceShown)}</div>
                </div>

                <!-- Pressure / risk -->
                <div class="nwst-secret-field" style="margin-bottom:8px">
                    <div class="nwst-secret-field-label">Pressure / risk
                        <button class="nwst-expand-btn" style="font-size:12px;color:#bbb;background:none;border:none;cursor:pointer;margin-left:4px" title="Open in popout" data-popout-field="pressureRisk">⛶</button>
                    </div>
                    <div class="nwst-secret-field-content" contenteditable="true" data-field="pressureRisk"
                        style="font-size:13px;line-height:1.5;border:0.5px solid #eee;border-radius:6px;padding:6px 8px;min-height:32px;cursor:text">${escapeHTML(secret.pressureRisk)}</div>
                </div>

                <!-- Reveal conditions -->
                <div class="nwst-secret-field" style="margin-bottom:8px">
                    <div class="nwst-secret-field-label">Reveal conditions
                        <button class="nwst-expand-btn" style="font-size:12px;color:#bbb;background:none;border:none;cursor:pointer;margin-left:4px" title="Open in popout" data-popout-field="revealConditions">⛶</button>
                    </div>
                    <div class="nwst-secret-field-content" contenteditable="true" data-field="revealConditions"
                        style="font-size:13px;line-height:1.5;border:0.5px solid #eee;border-radius:6px;padding:6px 8px;min-height:32px;cursor:text">${escapeHTML(secret.revealConditions)}</div>
                </div>

                <!-- Type selector + priority + delete -->
                <div class="nwst-btn-row" style="margin-top:10px">
                    <select class="nwst-secret-type-select" style="width:auto;font-size:11px;padding:3px 6px">
                        ${SECRET_TYPES.map(t => `<option value="${t.value}"${secret.type === t.value ? ' selected' : ''}>${t.label}</option>`).join('')}
                    </select>
                    <select class="nwst-secret-priority-select" title="Injection priority — controls when this secret is injected into the main prompt" style="width:auto;font-size:11px;padding:3px 6px;border-color:${secret.injectionPriority === 'high' ? '#1D9E75' : secret.injectionPriority === 'low' ? '#999' : '#AFA9EC'};color:${secret.injectionPriority === 'high' ? '#0F6E56' : secret.injectionPriority === 'low' ? '#999' : '#3C3489'}">
                        <option value="high"${(secret.injectionPriority || 'normal') === 'high' ? ' selected' : ''}>⬆ High — always inject</option>
                        <option value="normal"${(secret.injectionPriority || 'normal') === 'normal' ? ' selected' : ''}>◈ Normal — inject when at risk</option>
                        <option value="low"${(secret.injectionPriority || 'normal') === 'low' ? ' selected' : ''}>⬇ Low — monitor only, never inject</option>
                    </select>
                    <button class="menu_button nwst-btn-danger nwst-secret-delete" style="font-size:11px;padding:3px 9px;margin-left:auto">Delete secret</button>
                </div>
            </div>
        </div>`;
    }

    container.innerHTML = html;
    wireSecretEvents();
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
                whoDoesNotKnow: []
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

    // ── Save contenteditable secret fields on blur ─────────────
    container.querySelectorAll('.nwst-secret-field-content[contenteditable]').forEach(el => {
        el.onblur = async function () {
            const entry = this.closest('.nwst-secret-entry');
            const secretId = entry?.getAttribute('data-secret-id');
            if (!secretId) return;
            const field = this.getAttribute('data-field');
            const value = this.textContent.trim();
            const chatId = getChatId();
            await updateSecret(chatId, secretId, { [field]: value });
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
