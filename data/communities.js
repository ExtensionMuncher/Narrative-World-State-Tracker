/* eslint-disable */
// =============================================================================
// NWST Communities Data Module — data/communities.js
// =============================================================================
// Typed CRUD operations for the communities array (per chat).
// Communities are internal-only — they are NEVER injected into the main prompt.
// They exist to help the Planning LLM understand social dynamics.
//
// Community structure:
// {
//   id: string,
//   name: string,
//   members: string,              // comma-separated display string
//   avatarInitials: string,
//   avatarColors: { bg: string, text: string },
//   summary: string
// }
// =============================================================================

import {
    getChatData,
    setChatData,
    deleteChatData
} from './storage.js';

// ── Default avatar color palette ──────────────────────────────────────────
// Rotates through these colors for new communities so each has a distinct look.

const AVATAR_COLOR_PALETTE = [
    { bg: '#EEEDFE', text: '#3C3489' },  // Purple
    { bg: '#E1F5EE', text: '#085041' },  // Green
    { bg: '#FDE8E3', text: '#993C1D' },  // Red/Orange
    { bg: '#FEF3E2', text: '#8a5a00' },  // Amber
    { bg: '#E3F0FD', text: '#1D5E9E' },  // Blue
    { bg: '#FDE8F5', text: '#851D5E' },  // Pink
    { bg: '#E8F5E9', text: '#2E5E30' },  // Dark Green
    { bg: '#FFF3E0', text: '#8A4E00' },  // Brown
];

/**
 * Get the next avatar color from the palette based on how many communities exist.
 * @param {number} existingCount - Number of existing communities
 * @returns {object} { bg, text } color pair
 */
function getNextAvatarColor(existingCount) {
    return AVATAR_COLOR_PALETTE[existingCount % AVATAR_COLOR_PALETTE.length];
}

// ── Unique ID generator ───────────────────────────────────────────────────

function generateCommunityId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `com_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// ── Duplicate detection helpers ──────────────────────────────────────────

/**
 * Normalize a string for fuzzy comparison — lowercase, trim, collapse whitespace.
 * @param {string} str
 * @returns {string}
 */
function normalize(str) {
    return String(str).toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Parse a comma-separated members string into a normalized set.
 * @param {string} membersStr
 * @returns {Set<string>}
 */
function parseMembers(membersStr) {
    if (!membersStr || typeof membersStr !== 'string') return new Set();
    return new Set(
        membersStr.split(',')
            .map(m => normalize(m))
            .filter(m => m.length > 0)
    );
}

/**
 * Compute Jaccard similarity between two sets.
 * @param {Set} a
 * @param {Set} b
 * @returns {number} 0-1
 */
function jaccardSimilarity(a, b) {
    if (a.size === 0 && b.size === 0) return 0;
    const intersection = new Set([...a].filter(x => b.has(x)));
    const union = new Set([...a, ...b]);
    return intersection.size / union.size;
}

/**
 * Find existing communities that are similar to a proposed new community,
 * to prevent duplicate/similar entries. Checks multiple signals:
 *
 * 1. Exact/case-insensitive name match → instant match (return immediately)
 * 2. Substring name containment → score 0.75
 * 3. Significant word overlap in name (Jaccard >0.3) → score 0.6-0.8
 * 4. Significant member overlap (Jaccard >=0.4) → score 0.5-0.8
 *
 * Returns the best match if total similarity score >= 0.5, otherwise null.
 *
 * @param {object[]} existingCommunities - Array of community objects from getAllCommunities()
 * @param {string} name - Proposed community name
 * @param {string} [members] - Proposed comma-separated member list
 * @returns {object|null} The most similar existing community, or null
 */
export function findSimilarCommunity(existingCommunities, name, members) {
    if (!Array.isArray(existingCommunities) || existingCommunities.length === 0) return null;
    if (!name && !members) return null;

    const proposedName = normalize(name || '');
    const proposedMembers = parseMembers(members);

    let bestMatch = null;
    let bestScore = 0;

    for (const com of existingCommunities) {
        let score = 0;
        const existingName = normalize(com.name);

        // 1. Exact case-insensitive name match → instant return
        if (proposedName && existingName === proposedName) {
            return com;
        }

        // 2. Substring containment — one name is contained within the other
        if (proposedName && existingName) {
            if (existingName.includes(proposedName) || proposedName.includes(existingName)) {
                score = Math.max(score, 0.75);
            }

            // 3. Significant word overlap (e.g., "Kurosaki Family" ↔ "Kurosaki Household")
            const proposedWords = new Set(proposedName.split(/\s+/));
            const existingWords = new Set(existingName.split(/\s+/));
            const wordOverlap = jaccardSimilarity(proposedWords, existingWords);
            if (wordOverlap > 0.3) {
                score = Math.max(score, 0.6 + wordOverlap * 0.2);
            }
        }

        // 4. Member overlap check
        const existingMembers = parseMembers(com.members);
        if (proposedMembers.size > 0 && existingMembers.size > 0) {
            const overlap = jaccardSimilarity(proposedMembers, existingMembers);
            if (overlap >= 0.4) {
                score = Math.max(score, 0.5 + overlap * 0.3);
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestMatch = com;
        }
    }

    return bestScore >= 0.5 ? bestMatch : null;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

/**
 * Get all communities for a chat.
 * @param {string} chatId
 * @returns {object[]} Array of community objects (deep cloned)
 */
export function getAllCommunities(chatId) {
    return getChatData(chatId, 'communities');
}

/**
 * Save the complete communities array.
 * @param {string} chatId
 * @param {object[]} communities
 */
export async function saveAllCommunities(chatId, communities) {
    await setChatData(chatId, 'communities', communities);
}

/**
 * Get a single community by ID.
 * @param {string} chatId
 * @param {string} communityId
 * @returns {object|null}
 */
export function getCommunityById(chatId, communityId) {
    const communities = getAllCommunities(chatId);
    return communities.find(c => c.id === communityId) || null;
}

/**
 * Add a new community. Guards against duplicates by checking findSimilarCommunity().
 * If a similar community already exists, the new data is MERGED into the existing
 * community (updating summary, members, etc.) instead of creating a duplicate entry.
 *
 * Auto-generates avatar initials from the name and assigns a color from the palette.
 *
 * @param {string} chatId
 * @param {object} communityData - Community fields
 * @param {string} communityData.name - Community name
 * @param {string} [communityData.members] - Comma-separated member list
 * @param {string} [communityData.summary] - Community summary text
 * @param {string} [communityData.avatarInitials] - Override auto-generated initials
 * @param {object} [communityData.avatarColors] - Override auto-assigned colors
 * @returns {object} The newly created (or merged) community
 */
export async function addCommunity(chatId, communityData) {
    const communities = getAllCommunities(chatId);

    // ── Duplicate guard ───────────────────────────────────────────────────
    const similar = findSimilarCommunity(communities, communityData.name, communityData.members);
    if (similar) {
        // Merge new data into the existing community instead of creating a duplicate
        const updates = {};
        if (communityData.summary && communityData.summary.trim()) {
            updates.summary = communityData.summary.trim();
        }
        if (communityData.members && communityData.members.trim()) {
            // Merge member lists — combine existing + new, deduplicate
            const existingMembers = new Set(
                (similar.members || '').split(',').map(m => normalize(m)).filter(m => m)
            );
            const newMembers = communityData.members.split(',').map(m => normalize(m)).filter(m => m);
            for (const m of newMembers) {
                existingMembers.add(m);
            }
            updates.members = [...existingMembers].join(', ');
        }
        if (Object.keys(updates).length > 0) {
            await updateCommunity(chatId, similar.id, updates);
        }
        return getCommunityById(chatId, similar.id);
    }

    // ── Normal creation path ──────────────────────────────────────────────
    let autoInitials = '??';
    if (communityData.name) {
        const words = communityData.name.trim().split(/\s+/);
        autoInitials = words.slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('');
    }

    const newCommunity = {
        id: communityData.id || generateCommunityId(),
        name: communityData.name || 'Unnamed Community',
        members: communityData.members || '',
        avatarInitials: communityData.avatarInitials || autoInitials,
        avatarColors: communityData.avatarColors || getNextAvatarColor(communities.length),
        summary: communityData.summary || ''
    };

    communities.push(newCommunity);
    await saveAllCommunities(chatId, communities);
    return newCommunity;
}

/**
 * Update an existing community by ID. Only provided fields are changed.
 * @param {string} chatId
 * @param {string} communityId
 * @param {object} updates - Partial community fields
 * @returns {object|null} The updated community
 */
export async function updateCommunity(chatId, communityId, updates) {
    const communities = getAllCommunities(chatId);
    const index = communities.findIndex(c => c.id === communityId);
    if (index === -1) return null;

    communities[index] = { ...communities[index], ...updates };
    await saveAllCommunities(chatId, communities);
    return communities[index];
}

/**
 * Delete a community by ID.
 * @param {string} chatId
 * @param {string} communityId
 * @returns {boolean} True if deleted
 */
export async function deleteCommunity(chatId, communityId) {
    const communities = getAllCommunities(chatId);
    const index = communities.findIndex(c => c.id === communityId);
    if (index === -1) return false;

    communities.splice(index, 1);
    await saveAllCommunities(chatId, communities);
    return true;
}

/**
 * Update a community's summary text.
 * @param {string} chatId
 * @param {string} communityId
 * @param {string} summary - New summary text
 * @returns {object|null}
 */
export async function updateCommunitySummary(chatId, communityId, summary) {
    return updateCommunity(chatId, communityId, { summary });
}

/**
 * Update a community's member list.
 * @param {string} chatId
 * @param {string} communityId
 * @param {string} members - Comma-separated member string
 * @returns {object|null}
 */
export async function updateCommunityMembers(chatId, communityId, members) {
    return updateCommunity(chatId, communityId, { members });
}

// ── Bulk operations ───────────────────────────────────────────────────────

/**
 * Delete all communities for a chat.
 * @param {string} chatId
 */
export async function clearAllCommunities(chatId) {
    deleteChatData(chatId, 'communities');
}

/**
 * Get the count of communities for a chat.
 * @param {string} chatId
 * @returns {number}
 */
export function getCommunityCount(chatId) {
    const communities = getAllCommunities(chatId);
    return communities.length;
}
