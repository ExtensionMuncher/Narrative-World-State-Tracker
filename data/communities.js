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
export function saveAllCommunities(chatId, communities) {
    setChatData(chatId, 'communities', communities);
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
 * Add a new community.
 * Auto-generates avatar initials from the name and assigns a color from the palette.
 *
 * @param {string} chatId
 * @param {object} communityData - Community fields
 * @param {string} communityData.name - Community name
 * @param {string} [communityData.members] - Comma-separated member list
 * @param {string} [communityData.summary] - Community summary text
 * @param {string} [communityData.avatarInitials] - Override auto-generated initials
 * @param {object} [communityData.avatarColors] - Override auto-assigned colors
 * @returns {object} The newly created community
 */
export function addCommunity(chatId, communityData) {
    const communities = getAllCommunities(chatId);

    // Auto-generate avatar initials from the community name (first letter of first two words)
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
    saveAllCommunities(chatId, communities);
    return newCommunity;
}

/**
 * Update an existing community by ID. Only provided fields are changed.
 * @param {string} chatId
 * @param {string} communityId
 * @param {object} updates - Partial community fields
 * @returns {object|null} The updated community
 */
export function updateCommunity(chatId, communityId, updates) {
    const communities = getAllCommunities(chatId);
    const index = communities.findIndex(c => c.id === communityId);
    if (index === -1) return null;

    communities[index] = { ...communities[index], ...updates };
    saveAllCommunities(chatId, communities);
    return communities[index];
}

/**
 * Delete a community by ID.
 * @param {string} chatId
 * @param {string} communityId
 * @returns {boolean} True if deleted
 */
export function deleteCommunity(chatId, communityId) {
    const communities = getAllCommunities(chatId);
    const index = communities.findIndex(c => c.id === communityId);
    if (index === -1) return false;

    communities.splice(index, 1);
    saveAllCommunities(chatId, communities);
    return true;
}

/**
 * Update a community's summary text.
 * @param {string} chatId
 * @param {string} communityId
 * @param {string} summary - New summary text
 * @returns {object|null}
 */
export function updateCommunitySummary(chatId, communityId, summary) {
    return updateCommunity(chatId, communityId, { summary });
}

/**
 * Update a community's member list.
 * @param {string} chatId
 * @param {string} communityId
 * @param {string} members - Comma-separated member string
 * @returns {object|null}
 */
export function updateCommunityMembers(chatId, communityId, members) {
    return updateCommunity(chatId, communityId, { members });
}

// ── Bulk operations ───────────────────────────────────────────────────────

/**
 * Delete all communities for a chat.
 * @param {string} chatId
 */
export function clearAllCommunities(chatId) {
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
