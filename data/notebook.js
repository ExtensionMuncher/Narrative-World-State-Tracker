/* eslint-disable */
// =============================================================================
// NWST Notebook Data Module — data/notebook.js
// =============================================================================
// Typed CRUD operations for the notebook data structure (per chat).
// All storage goes through storage.js.
//
// Notebook structure:
// {
//   core: {
//     unresolvedDetail: string[],
//     promiseThreatDeadline: string[],
//     offscreenPressure: string[],
//     doNotForget: string[]
//   },
//   mystery: {
//     establishedFacts: string[],
//     plantedDetails: string[],
//     characterWhereabouts: string[],
//     inconsistenciesFlagged: string[],
//     currentToneAtmosphere: string[]
//   },
//   secrets: [
//     {
//       id: string,
//       type: "character" | "user_pc" | "world" | "dramatic_irony" | "unconfirmed_suspicion",
//       title: string,
//       secret: string,
//       whoKnows: string[],
//       whoDoesNotKnow: string[],
//       evidenceShown: string,
//       pressureRisk: string,
//       revealConditions: string
//     }
//   ]
// }
// =============================================================================

import {
    getChatData,
    setChatData,
    deleteChatData,
    DEFAULT_NOTEBOOK
} from './storage.js';

// ── Unique ID generator ───────────────────────────────────────────────────

/**
 * Generate a unique ID for secrets.
 * @returns {string}
 */
function generateSecretId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `sec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// ── Full notebook ─────────────────────────────────────────────────────────

/**
 * Get the full notebook for a chat.
 * @param {string} chatId
 * @returns {object} The notebook object (deep cloned)
 */
export function getNotebook(chatId) {
    const nb = getChatData(chatId, 'notebook');
    // Merge with DEFAULT_NOTEBOOK to ensure all fields exist
    // (handles migration for chats stored before secrets feature was added)
    return {
        core: {
            unresolvedDetail: Array.isArray(nb.core?.unresolvedDetail) ? nb.core.unresolvedDetail : [],
            promiseThreatDeadline: Array.isArray(nb.core?.promiseThreatDeadline) ? nb.core.promiseThreatDeadline : [],
            offscreenPressure: Array.isArray(nb.core?.offscreenPressure) ? nb.core.offscreenPressure : [],
            doNotForget: Array.isArray(nb.core?.doNotForget) ? nb.core.doNotForget : []
        },
        mystery: {
            establishedFacts: Array.isArray(nb.mystery?.establishedFacts) ? nb.mystery.establishedFacts : [],
            plantedDetails: Array.isArray(nb.mystery?.plantedDetails) ? nb.mystery.plantedDetails : [],
            characterWhereabouts: Array.isArray(nb.mystery?.characterWhereabouts) ? nb.mystery.characterWhereabouts : [],
            inconsistenciesFlagged: Array.isArray(nb.mystery?.inconsistenciesFlagged) ? nb.mystery.inconsistenciesFlagged : [],
            currentToneAtmosphere: Array.isArray(nb.mystery?.currentToneAtmosphere) ? nb.mystery.currentToneAtmosphere : []
        },
        secrets: Array.isArray(nb.secrets) ? nb.secrets : []
    };
}

/**
 * Save the full notebook for a chat.
 * @param {string} chatId
 * @param {object} notebook - Complete notebook object
 */
export async function saveNotebook(chatId, notebook) {
    await setChatData(chatId, 'notebook', notebook);
}

// ── Core section ──────────────────────────────────────────────────────────

/**
 * Get all Core fields.
 * @param {string} chatId
 * @returns {object} { unresolvedDetail, promiseThreatDeadline, offscreenPressure, doNotForget }
 */
export function getCoreFields(chatId) {
    const nb = getNotebook(chatId);
    return nb.core;
}

/**
 * Get a single Core field's bullets.
 * @param {string} chatId
 * @param {string} fieldName - 'unresolvedDetail' | 'promiseThreatDeadline' | 'offscreenPressure' | 'doNotForget'
 * @returns {string[]} Array of bullet strings
 */
export function getCoreField(chatId, fieldName) {
    const nb = getNotebook(chatId);
    return nb.core[fieldName] || [];
}

/**
 * Add a bullet to a Core field.
 * @param {string} chatId
 * @param {string} fieldName - The Core field name
 * @param {string} bulletText - The text to add
 */
export async function addCoreBullet(chatId, fieldName, bulletText) {
    const nb = getNotebook(chatId);
    if (!nb.core[fieldName]) {
        console.error(`[NWST Notebook] Unknown core field: ${fieldName}`);
        return;
    }
    nb.core[fieldName].push(bulletText);
    await saveNotebook(chatId, nb);
}

/**
 * Update a specific bullet in a Core field by index.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {number} index - 0-based index into the bullet array
 * @param {string} newText - The new bullet text
 */
export async function updateCoreBullet(chatId, fieldName, index, newText) {
    const nb = getNotebook(chatId);
    if (!nb.core[fieldName] || index < 0 || index >= nb.core[fieldName].length) return;
    nb.core[fieldName][index] = newText;
    await saveNotebook(chatId, nb);
}

/**
 * Delete a specific bullet from a Core field by index.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {number} index - 0-based index
 */
export async function deleteCoreBullet(chatId, fieldName, index) {
    const nb = getNotebook(chatId);
    if (!nb.core[fieldName] || index < 0 || index >= nb.core[fieldName].length) return;
    nb.core[fieldName].splice(index, 1);
    await saveNotebook(chatId, nb);
}

/**
 * Replace all bullets in a Core field.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {string[]} bullets - New array of bullet strings
 */
/**
 * Upsert a source-keyed bullet into a CORE field (e.g. offscreenPressure where
 * each pressure belongs to a character/source). Bullet form "Source: detail";
 * an existing bullet with the same source prefix is replaced, not duplicated.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {string} bulletText
 */
export async function upsertCoreBullet(chatId, fieldName, bulletText) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.core[fieldName])) {
        console.error(`[NWST Notebook] Unknown core field: ${fieldName}`);
        return;
    }
    const colonIdx = bulletText.indexOf(':');
    if (colonIdx <= 0) {
        if (!nb.core[fieldName].includes(bulletText)) {
            nb.core[fieldName].push(bulletText);
            await saveNotebook(chatId, nb);
        }
        return;
    }
    const key = bulletText.slice(0, colonIdx).trim().toLowerCase();
    const removed = nb.core[fieldName].filter(b => {
        const ci = (b || '').indexOf(':');
        if (ci <= 0) return false;
        return (b.slice(0, ci).trim().toLowerCase()) === key;
    });
    nb.core[fieldName] = nb.core[fieldName].filter(b => !removed.includes(b));
    nb.core[fieldName].push(bulletText);
    await saveNotebook(chatId, nb);
    return { removed, added: [bulletText] };
}

export async function replaceCoreField(chatId, fieldName, bullets) {
    const nb = getNotebook(chatId);
    if (!nb.core[fieldName]) return;
    nb.core[fieldName] = bullets;
    await saveNotebook(chatId, nb);
}

// ── Mystery section ───────────────────────────────────────────────────────

/**
 * Get all Mystery fields.
 * @param {string} chatId
 * @returns {object} { establishedFacts, plantedDetails, characterWhereabouts, inconsistenciesFlagged, currentToneAtmosphere }
 */
export function getMysteryFields(chatId) {
    const nb = getNotebook(chatId);
    return nb.mystery;
}

/**
 * Get a single Mystery field's bullets.
 * @param {string} chatId
 * @param {string} fieldName - 'establishedFacts' | 'plantedDetails' | 'characterWhereabouts' | 'inconsistenciesFlagged' | 'currentToneAtmosphere'
 * @returns {string[]}
 */
export function getMysteryField(chatId, fieldName) {
    const nb = getNotebook(chatId);
    return nb.mystery[fieldName] || [];
}

/**
 * Add a bullet to a Mystery field.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {string} bulletText
 */
export async function addMysteryBullet(chatId, fieldName, bulletText) {
    const nb = getNotebook(chatId);
    if (!nb.mystery[fieldName]) {
        console.error(`[NWST Notebook] Unknown mystery field: ${fieldName}`);
        return;
    }
    nb.mystery[fieldName].push(bulletText);
    await saveNotebook(chatId, nb);
}

/**
 * Upsert a character-keyed bullet into a mystery field. The bullet is expected
 * to be in "Name: detail" form. Any existing bullet whose name prefix matches
 * (case-insensitive) is REPLACED rather than duplicated. Used for
 * characterWhereabouts so a character has one current location, not a stack of
 * stale ones.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {string} bulletText - "CharacterName: location/detail"
 */
export async function upsertCharacterBullet(chatId, fieldName, bulletText) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.mystery[fieldName])) {
        console.error(`[NWST Notebook] Unknown mystery field: ${fieldName}`);
        return;
    }
    const colonIdx = bulletText.indexOf(':');
    if (colonIdx <= 0) {
        // No "Name:" prefix — fall back to plain append, but de-dupe exact matches
        if (!nb.mystery[fieldName].includes(bulletText)) {
            nb.mystery[fieldName].push(bulletText);
            await saveNotebook(chatId, nb);
        }
        return;
    }
    const name = bulletText.slice(0, colonIdx).trim().toLowerCase();
    // Capture which bullets we're removing (for undo history)
    const removed = nb.mystery[fieldName].filter(b => {
        const ci = (b || '').indexOf(':');
        if (ci <= 0) return false;
        return (b.slice(0, ci).trim().toLowerCase()) === name;
    });
    nb.mystery[fieldName] = nb.mystery[fieldName].filter(b => !removed.includes(b));
    nb.mystery[fieldName].push(bulletText);
    await saveNotebook(chatId, nb);
    return { removed, added: [bulletText] };
}

/**
 * Update a specific bullet in a Mystery field by index.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {number} index
 * @param {string} newText
 */
export async function updateMysteryBullet(chatId, fieldName, index, newText) {
    const nb = getNotebook(chatId);
    if (!nb.mystery[fieldName] || index < 0 || index >= nb.mystery[fieldName].length) return;
    nb.mystery[fieldName][index] = newText;
    await saveNotebook(chatId, nb);
}

/**
 * Delete a specific bullet from a Mystery field by index.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {number} index
 */
export async function deleteMysteryBullet(chatId, fieldName, index) {
    const nb = getNotebook(chatId);
    if (!nb.mystery[fieldName] || index < 0 || index >= nb.mystery[fieldName].length) return;
    nb.mystery[fieldName].splice(index, 1);
    await saveNotebook(chatId, nb);
}

/**
 * Replace all bullets in a Mystery field.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {string[]} bullets
 */
export async function replaceMysteryFieldDiff(chatId, fieldName, bullets) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.mystery[fieldName])) return { removed: [], added: [] };
    const removed = nb.mystery[fieldName].filter(b => !bullets.includes(b));
    const added = bullets.filter(b => !nb.mystery[fieldName].includes(b));
    nb.mystery[fieldName] = bullets.slice();
    await saveNotebook(chatId, nb);
    return { removed, added };
}

export async function replaceMysteryField(chatId, fieldName, bullets) {
    const nb = getNotebook(chatId);
    if (!nb.mystery[fieldName]) return;
    nb.mystery[fieldName] = bullets;
    await saveNotebook(chatId, nb);
}

// ── Secrets section ───────────────────────────────────────────────────────

/**
 * Get all secrets for a chat.
 * @param {string} chatId
 * @returns {object[]} Array of secret objects
 */
export function getAllSecrets(chatId) {
    const nb = getNotebook(chatId);
    // Defensive: nb.secrets may be undefined if the notebook was stored by batch scan
    // without a secrets field (e.g., older saved notebook, or LLM didn't include it).
    return (nb && nb.secrets) || [];
}

/**
 * Get the lifecycle status of a secret, treating any secret without an explicit
 * status as 'active' (backward compatible with pre-lifecycle secrets).
 * @param {object} secret
 * @returns {'active'|'pending_archive'|'archived'}
 */
export function getSecretStatus(secret) {
    return (secret && secret.status) || 'active';
}

/**
 * Get only the secrets that should be scored/injected. Archived secrets are
 * excluded entirely; active and pending_archive both still inject.
 * @param {string} chatId
 * @returns {object[]}
 */
export function getInjectableSecrets(chatId) {
    return getAllSecrets(chatId).filter(s => getSecretStatus(s) !== 'archived');
}

/**
 * Get secrets currently awaiting the player's archive decision.
 * @param {string} chatId
 * @returns {object[]}
 */
export function getPendingArchiveSecrets(chatId) {
    return getAllSecrets(chatId).filter(s => getSecretStatus(s) === 'pending_archive');
}

/**
 * Flag a secret for archive review (sets pending_archive). Does NOT archive it —
 * the player still decides. No-op if already pending or archived.
 * @param {string} chatId
 * @param {string} secretId
 * @param {'revealed'|'dormant'} reason
 * @param {number} msgIndex
 */
export async function flagSecretForArchive(chatId, secretId, reason, msgIndex) {
    const secret = getSecretById(chatId, secretId);
    if (!secret) return;
    if (getSecretStatus(secret) !== 'active') return; // only flag active secrets
    await updateSecret(chatId, secretId, {
        status: 'pending_archive',
        archiveReason: reason || '',
        flaggedAtMsgIndex: msgIndex ?? -1
    });
}

/**
 * Resolve a pending_archive secret: 'archive' to archive it, 'keep' to restore active.
 * @param {string} chatId
 * @param {string} secretId
 * @param {'archive'|'keep'} decision
 */
export async function resolveArchiveDecision(chatId, secretId, decision) {
    const updates = decision === 'archive'
        ? { status: 'archived' }
        : { status: 'active', archiveReason: '', flaggedAtMsgIndex: -1 };
    await updateSecret(chatId, secretId, updates);
}


/**
 * Get a single secret by ID.
 * @param {string} chatId
 * @param {string} secretId
 * @returns {object|null}
 */
export function getSecretById(chatId, secretId) {
    const nb = getNotebook(chatId);
    if (!nb.secrets) return null;
    return nb.secrets.find(s => s.id === secretId) || null;
}

/**
 * Add a new secret.
 * @param {string} chatId
 * @param {object} secretData - Secret fields (id auto-generated if not provided)
 * @returns {object} The newly created secret
 */
export async function addSecret(chatId, secretData) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.secrets)) nb.secrets = [];
    const newSecret = {
        id: secretData.id || generateSecretId(),
        type: secretData.type || 'character',
        title: secretData.title || '',
        secret: secretData.secret || '',
        whoKnows: secretData.whoKnows || [],
        whoDoesNotKnow: secretData.whoDoesNotKnow || [],
        evidenceShown: secretData.evidenceShown || '',
        pressureRisk: secretData.pressureRisk || '',
        revealConditions: secretData.revealConditions || '',
        // Injection priority modifies the v2 relevance score. It does not decide basic triggering.
        injectionPriority: secretData.injectionPriority || 'normal',
        // Relevance scoring fields (used by getSelectiveSecretInjection):
        //   lastInjectionMsgIndex — message counter from chat.length at time of last injection.
        //   -1 means never injected. Used for cooldown and stale-bonus calculations.
        lastInjectionMsgIndex: secretData.lastInjectionMsgIndex ?? -1,
        // Optional v2 trigger anchors. Preserve exactly to avoid event-promotion data loss.
        triggerAnchors: secretData.triggerAnchors || null,
        // ── Lifecycle status ──────────────────────────────────────────
        //   'active'          — normal; scored and injected
        //   'pending_archive' — LLM flagged it as likely revealed/dormant; awaiting
        //                       player decision. Still injects until resolved.
        //   'archived'        — player approved; stops injecting entirely.
        status: secretData.status || 'active',
        // Why it was flagged for archive (shown in the review UI): 'revealed' | 'dormant' | ''
        archiveReason: secretData.archiveReason || '',
        // Message index when flagged, for ordering the review list.
        flaggedAtMsgIndex: secretData.flaggedAtMsgIndex ?? -1,
        //   relevanceKeywords — comma-separated keywords auto-extracted from title + evidence +
        //   revealConditions on creation. Used for keyword matching against recent chat messages.
        relevanceKeywords: secretData.relevanceKeywords || extractRelevanceKeywords(secretData)
    };
    nb.secrets.push(newSecret);
    await saveNotebook(chatId, nb);
    return newSecret;
}

/**
 * Update an existing secret by ID.
 * @param {string} chatId
 * @param {string} secretId
 * @param {object} updates - Partial secret fields
 * @returns {object|null} The updated secret
 */
export async function updateSecret(chatId, secretId, updates) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.secrets)) return null;
    const index = nb.secrets.findIndex(s => s.id === secretId);
    if (index === -1) return null;
    nb.secrets[index] = { ...nb.secrets[index], ...updates };
    await saveNotebook(chatId, nb);
    return nb.secrets[index];
}

/**
 * Delete a secret by ID.
 * @param {string} chatId
 * @param {string} secretId
 * @returns {boolean} True if deleted
 */
export async function deleteSecret(chatId, secretId) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.secrets)) return false;
    const index = nb.secrets.findIndex(s => s.id === secretId);
    if (index === -1) return false;
    nb.secrets.splice(index, 1);
    await saveNotebook(chatId, nb);
    return true;
}

/**
 * Add a character to a secret's whoKnows list.
 * @param {string} chatId
 * @param {string} secretId
 * @param {string} characterName
 * @returns {object|null} Updated secret
 */
export async function addWhoKnows(chatId, secretId, characterName) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.secrets)) return null;
    const secret = nb.secrets.find(s => s.id === secretId);
    if (!secret) return null;
    if (!secret.whoKnows.includes(characterName)) {
        secret.whoKnows.push(characterName);
        await saveNotebook(chatId, nb);
    }
    return secret;
}

/**
 * Remove a character from a secret's whoKnows list.
 * @param {string} chatId
 * @param {string} secretId
 * @param {string} characterName
 * @returns {object|null}
 */
export async function removeWhoKnows(chatId, secretId, characterName) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.secrets)) return null;
    const secret = nb.secrets.find(s => s.id === secretId);
    if (!secret) return null;
    secret.whoKnows = secret.whoKnows.filter(n => n !== characterName);
    await saveNotebook(chatId, nb);
    return secret;
}

/**
 * Add a character to a secret's whoDoesNotKnow list.
 * @param {string} chatId
 * @param {string} secretId
 * @param {string} characterName
 * @returns {object|null}
 */
export async function addWhoDoesNotKnow(chatId, secretId, characterName) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.secrets)) return null;
    const secret = nb.secrets.find(s => s.id === secretId);
    if (!secret) return null;
    if (!secret.whoDoesNotKnow.includes(characterName)) {
        secret.whoDoesNotKnow.push(characterName);
        await saveNotebook(chatId, nb);
    }
    return secret;
}

/**
 * Remove a character from a secret's whoDoesNotKnow list.
 * @param {string} chatId
 * @param {string} secretId
 * @param {string} characterName
 * @returns {object|null}
 */
export async function removeWhoDoesNotKnow(chatId, secretId, characterName) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.secrets)) return null;
    const secret = nb.secrets.find(s => s.id === secretId);
    if (!secret) return null;
    secret.whoDoesNotKnow = secret.whoDoesNotKnow.filter(n => n !== characterName);
    await saveNotebook(chatId, nb);
    return secret;
}

/**
 * Get all secrets where a specific character is in the whoKnows list.
 * Used by narrativeConsistency.js for selective secret injection.
 * @param {string} chatId
 * @param {string} characterName
 * @returns {object[]} Array of secrets where the character knows
 */
export function getSecretsKnownBy(chatId, characterName) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.secrets)) return [];
    return nb.secrets.filter(s => s.whoKnows.includes(characterName));
}

/**
 * Get all secrets where a specific character is in the whoDoesNotKnow list.
 * Used by narrativeConsistency.js to enforce knowledge boundaries.
 * @param {string} chatId
 * @param {string} characterName
 * @returns {object[]} Array of secrets the character must NOT know
 */
export function getSecretsUnknownTo(chatId, characterName) {
    const nb = getNotebook(chatId);
    if (!Array.isArray(nb.secrets)) return [];
    return nb.secrets.filter(s => s.whoDoesNotKnow.includes(characterName));
}

// ── Relevance keyword extraction ───────────────────────────────────────────

const STOP_WORDS = new Set([
    'the','a','an','is','are','was','were','be','been','being',
    'have','has','had','do','does','did','will','would','could',
    'should','may','might','shall','can','need','dare','ought',
    'used','to','of','in','for','on','with','at','by','from',
    'as','into','through','during','before','after','above','below',
    'between','out','off','over','under','again','further','then',
    'once','here','there','when','where','why','how','all','each',
    'every','both','few','more','most','other','some','such','no',
    'nor','not','only','own','same','so','than','too','very',
    'just','because','but','and','or','if','while','about','up'
]);

/**
 * Extract meaningful keywords from a secret's text fields for relevance matching.
 * @param {object} secretData - Secret data object
 * @returns {string} Comma-separated list of unique lowercase keywords
 */
function extractRelevanceKeywords(secretData) {
    const words = new Set();
    const sources = [
        secretData.title,
        secretData.evidenceShown,
        secretData.revealConditions,
        secretData.secret
    ];
    for (const source of sources) {
        if (!source) continue;
        // Split on non-alphanumeric (keep apostrophes for possessives)
        const tokens = source.toLowerCase().split(/[^a-zA-Z0-9']+/).filter(Boolean);
        for (const token of tokens) {
            if (token.length < 3) continue;           // Skip very short words
            if (STOP_WORDS.has(token)) continue;       // Skip common words
            words.add(token);
        }
    }
    return Array.from(words).join(', ');
}

// ── Bulk operations ───────────────────────────────────────────────────────

/**
 * Delete the entire notebook for a chat.
 * @param {string} chatId
 */
export async function clearNotebook(chatId) {
    await deleteChatData(chatId, 'notebook');
}
