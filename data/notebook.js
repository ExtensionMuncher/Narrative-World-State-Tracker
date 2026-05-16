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
    deleteChatData
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
    return getChatData(chatId, 'notebook');
}

/**
 * Save the full notebook for a chat.
 * @param {string} chatId
 * @param {object} notebook - Complete notebook object
 */
export function saveNotebook(chatId, notebook) {
    setChatData(chatId, 'notebook', notebook);
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
export function addCoreBullet(chatId, fieldName, bulletText) {
    const nb = getNotebook(chatId);
    if (!nb.core[fieldName]) {
        console.error(`[NWST Notebook] Unknown core field: ${fieldName}`);
        return;
    }
    nb.core[fieldName].push(bulletText);
    saveNotebook(chatId, nb);
}

/**
 * Update a specific bullet in a Core field by index.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {number} index - 0-based index into the bullet array
 * @param {string} newText - The new bullet text
 */
export function updateCoreBullet(chatId, fieldName, index, newText) {
    const nb = getNotebook(chatId);
    if (!nb.core[fieldName] || index < 0 || index >= nb.core[fieldName].length) return;
    nb.core[fieldName][index] = newText;
    saveNotebook(chatId, nb);
}

/**
 * Delete a specific bullet from a Core field by index.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {number} index - 0-based index
 */
export function deleteCoreBullet(chatId, fieldName, index) {
    const nb = getNotebook(chatId);
    if (!nb.core[fieldName] || index < 0 || index >= nb.core[fieldName].length) return;
    nb.core[fieldName].splice(index, 1);
    saveNotebook(chatId, nb);
}

/**
 * Replace all bullets in a Core field.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {string[]} bullets - New array of bullet strings
 */
export function replaceCoreField(chatId, fieldName, bullets) {
    const nb = getNotebook(chatId);
    if (!nb.core[fieldName]) return;
    nb.core[fieldName] = bullets;
    saveNotebook(chatId, nb);
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
export function addMysteryBullet(chatId, fieldName, bulletText) {
    const nb = getNotebook(chatId);
    if (!nb.mystery[fieldName]) {
        console.error(`[NWST Notebook] Unknown mystery field: ${fieldName}`);
        return;
    }
    nb.mystery[fieldName].push(bulletText);
    saveNotebook(chatId, nb);
}

/**
 * Update a specific bullet in a Mystery field by index.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {number} index
 * @param {string} newText
 */
export function updateMysteryBullet(chatId, fieldName, index, newText) {
    const nb = getNotebook(chatId);
    if (!nb.mystery[fieldName] || index < 0 || index >= nb.mystery[fieldName].length) return;
    nb.mystery[fieldName][index] = newText;
    saveNotebook(chatId, nb);
}

/**
 * Delete a specific bullet from a Mystery field by index.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {number} index
 */
export function deleteMysteryBullet(chatId, fieldName, index) {
    const nb = getNotebook(chatId);
    if (!nb.mystery[fieldName] || index < 0 || index >= nb.mystery[fieldName].length) return;
    nb.mystery[fieldName].splice(index, 1);
    saveNotebook(chatId, nb);
}

/**
 * Replace all bullets in a Mystery field.
 * @param {string} chatId
 * @param {string} fieldName
 * @param {string[]} bullets
 */
export function replaceMysteryField(chatId, fieldName, bullets) {
    const nb = getNotebook(chatId);
    if (!nb.mystery[fieldName]) return;
    nb.mystery[fieldName] = bullets;
    saveNotebook(chatId, nb);
}

// ── Secrets section ───────────────────────────────────────────────────────

/**
 * Get all secrets for a chat.
 * @param {string} chatId
 * @returns {object[]} Array of secret objects
 */
export function getAllSecrets(chatId) {
    const nb = getNotebook(chatId);
    return nb.secrets;
}

/**
 * Get a single secret by ID.
 * @param {string} chatId
 * @param {string} secretId
 * @returns {object|null}
 */
export function getSecretById(chatId, secretId) {
    const nb = getNotebook(chatId);
    return nb.secrets.find(s => s.id === secretId) || null;
}

/**
 * Add a new secret.
 * @param {string} chatId
 * @param {object} secretData - Secret fields (id auto-generated if not provided)
 * @returns {object} The newly created secret
 */
export function addSecret(chatId, secretData) {
    const nb = getNotebook(chatId);
    const newSecret = {
        id: secretData.id || generateSecretId(),
        type: secretData.type || 'character',
        title: secretData.title || '',
        secret: secretData.secret || '',
        whoKnows: secretData.whoKnows || [],
        whoDoesNotKnow: secretData.whoDoesNotKnow || [],
        evidenceShown: secretData.evidenceShown || '',
        pressureRisk: secretData.pressureRisk || '',
        revealConditions: secretData.revealConditions || ''
    };
    nb.secrets.push(newSecret);
    saveNotebook(chatId, nb);
    return newSecret;
}

/**
 * Update an existing secret by ID.
 * @param {string} chatId
 * @param {string} secretId
 * @param {object} updates - Partial secret fields
 * @returns {object|null} The updated secret
 */
export function updateSecret(chatId, secretId, updates) {
    const nb = getNotebook(chatId);
    const index = nb.secrets.findIndex(s => s.id === secretId);
    if (index === -1) return null;
    nb.secrets[index] = { ...nb.secrets[index], ...updates };
    saveNotebook(chatId, nb);
    return nb.secrets[index];
}

/**
 * Delete a secret by ID.
 * @param {string} chatId
 * @param {string} secretId
 * @returns {boolean} True if deleted
 */
export function deleteSecret(chatId, secretId) {
    const nb = getNotebook(chatId);
    const index = nb.secrets.findIndex(s => s.id === secretId);
    if (index === -1) return false;
    nb.secrets.splice(index, 1);
    saveNotebook(chatId, nb);
    return true;
}

/**
 * Add a character to a secret's whoKnows list.
 * @param {string} chatId
 * @param {string} secretId
 * @param {string} characterName
 * @returns {object|null} Updated secret
 */
export function addWhoKnows(chatId, secretId, characterName) {
    const nb = getNotebook(chatId);
    const secret = nb.secrets.find(s => s.id === secretId);
    if (!secret) return null;
    if (!secret.whoKnows.includes(characterName)) {
        secret.whoKnows.push(characterName);
        saveNotebook(chatId, nb);
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
export function removeWhoKnows(chatId, secretId, characterName) {
    const nb = getNotebook(chatId);
    const secret = nb.secrets.find(s => s.id === secretId);
    if (!secret) return null;
    secret.whoKnows = secret.whoKnows.filter(n => n !== characterName);
    saveNotebook(chatId, nb);
    return secret;
}

/**
 * Add a character to a secret's whoDoesNotKnow list.
 * @param {string} chatId
 * @param {string} secretId
 * @param {string} characterName
 * @returns {object|null}
 */
export function addWhoDoesNotKnow(chatId, secretId, characterName) {
    const nb = getNotebook(chatId);
    const secret = nb.secrets.find(s => s.id === secretId);
    if (!secret) return null;
    if (!secret.whoDoesNotKnow.includes(characterName)) {
        secret.whoDoesNotKnow.push(characterName);
        saveNotebook(chatId, nb);
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
export function removeWhoDoesNotKnow(chatId, secretId, characterName) {
    const nb = getNotebook(chatId);
    const secret = nb.secrets.find(s => s.id === secretId);
    if (!secret) return null;
    secret.whoDoesNotKnow = secret.whoDoesNotKnow.filter(n => n !== characterName);
    saveNotebook(chatId, nb);
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
    return nb.secrets.filter(s => s.whoDoesNotKnow.includes(characterName));
}

// ── Bulk operations ───────────────────────────────────────────────────────

/**
 * Delete the entire notebook for a chat.
 * @param {string} chatId
 */
export function clearNotebook(chatId) {
    deleteChatData(chatId, 'notebook');
}
