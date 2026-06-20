/* eslint-disable */
// =============================================================================
// NWST Alias Registry — data/aliasRegistry.js
// =============================================================================
// Resolves the many ways a character/entity can be named in prose down to a
// single canonical ID. This is the foundation of the prose-based secrets
// engine: ST stores the card title in msg.name (e.g. "Oyabun Ryōmen Sukuna")
// but secrets reference short names ("Sukuna"), and prose uses every variant
// in between ("the King of Curses", "the Oyabun"). All of these must resolve
// to one canonical entity: `sukuna`.
//
// TWO SOURCES, MERGED:
//   1. AUTO-BUILT — names pulled from existing NWST data (whoKnows lists,
//      whoDoesNotKnow lists, community members, event participants). Every
//      name seen becomes its own canonical entity with itself as an alias.
//   2. MANUAL — user-defined alias groups via the Alias Manager UI. These
//      take precedence and let the user collapse variants the auto-builder
//      can't know are the same person ("King of Curses" → sukuna).
//
// Manual aliases are stored per-chat in chatMetadata under 'nwst:aliasRegistry'.
// Auto-built entries are computed fresh each call (not persisted) so they
// always reflect current data.
// =============================================================================

import { getChatId } from '../utils.js';
import { getAllSecrets } from './notebook.js';
import { getAllEvents } from './events.js';
import { getAllCommunities } from './communities.js';

const ALIAS_KEY = 'nwst:aliasRegistry';

// ── Canonical ID generation ───────────────────────────────────────────────

/**
 * Convert a display name into a canonical ID.
 * Lowercase, strip honorifics/titles, collapse whitespace, drop diacritics.
 * "Oyabun Ryōmen Sukuna" → "ryomen sukuna" (then alias-resolved to "sukuna")
 * @param {string} name
 * @returns {string}
 */
export function toCanonicalId(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics: ō → o
        .replace(/[^\w\s-]/g, '')                          // drop punctuation
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Manual alias storage ──────────────────────────────────────────────────

/**
 * Get the manual alias groups for this chat.
 * Shape: [{ canonical: "sukuna", display: "Sukuna", aliases: ["king of curses", "oyabun", "ryomen sukuna"] }]
 * @param {string} chatId
 * @returns {object[]}
 */
export function getManualAliases(chatId) {
    if (!chatId) chatId = getChatId();
    if (!chatId) return [];
    try {
        const { chatMetadata } = SillyTavern.getContext();
        return chatMetadata?.[ALIAS_KEY] || [];
    } catch (e) {
        return [];
    }
}

/**
 * Save the manual alias groups for this chat.
 * @param {string} chatId
 * @param {object[]} aliasGroups
 */
export async function saveManualAliases(chatId, aliasGroups) {
    if (!chatId) chatId = getChatId();
    if (!chatId) return;
    try {
        const ctx = SillyTavern.getContext();
        ctx.chatMetadata[ALIAS_KEY] = aliasGroups;
        await ctx.saveMetadata();
    } catch (e) {
        console.error('[NWST AliasRegistry] Failed to save manual aliases:', e);
    }
}

/**
 * Add a single manual alias group.
 * @param {string} chatId
 * @param {string} displayName - The canonical display name (e.g. "Sukuna")
 * @param {string[]} aliases - Alternate names that resolve to it
 */
export async function addManualAlias(chatId, displayName, aliases) {
    if (!chatId) chatId = getChatId();
    const groups = getManualAliases(chatId);
    const canonical = toCanonicalId(displayName);

    // Merge into existing group if canonical already exists
    const existing = groups.find(g => g.canonical === canonical);
    if (existing) {
        const merged = new Set([...existing.aliases, ...aliases.map(toCanonicalId)]);
        existing.aliases = Array.from(merged).filter(Boolean);
        existing.display = displayName; // refresh display
    } else {
        groups.push({
            canonical,
            display: displayName,
            aliases: Array.from(new Set(aliases.map(toCanonicalId))).filter(Boolean)
        });
    }
    await saveManualAliases(chatId, groups);
}

/**
 * Remove a manual alias group by canonical ID.
 * @param {string} chatId
 * @param {string} canonical
 */
export async function removeManualAlias(chatId, canonical) {
    if (!chatId) chatId = getChatId();
    const groups = getManualAliases(chatId).filter(g => g.canonical !== canonical);
    await saveManualAliases(chatId, groups);
}

// ── Registry building ─────────────────────────────────────────────────────

/**
 * Build the complete alias registry for this chat.
 * Merges auto-built entries (from NWST data) with manual alias groups.
 *
 * Returns a resolver object with:
 *   - resolve(name): string|null   — canonical ID for any name/alias/prose mention
 *   - getDisplay(canonical): string — pretty display name for a canonical ID
 *   - allEntities(): object[]       — every known entity with its aliases
 *   - allAliasStrings(): string[]   — flat list of every alias string (for prose scanning)
 *
 * @param {string} chatId
 * @returns {object} resolver
 */
export function buildAliasRegistry(chatId) {
    if (!chatId) chatId = getChatId();

    // entity map: canonicalId -> { canonical, display, aliases:Set }
    const entities = new Map();

    function ensureEntity(canonical, display) {
        if (!canonical) return null;
        if (!entities.has(canonical)) {
            entities.set(canonical, {
                canonical,
                display: display || canonical,
                aliases: new Set([canonical])
            });
        }
        const e = entities.get(canonical);
        // Prefer a non-canonical-looking display if we get a better one
        if (display && display.length > 0 && e.display === e.canonical) {
            e.display = display;
        }
        return e;
    }

    function addName(rawName) {
        if (!rawName || typeof rawName !== 'string') return;
        const trimmed = rawName.trim();
        if (!trimmed) return;
        const canonical = toCanonicalId(trimmed);
        if (!canonical) return;
        const e = ensureEntity(canonical, trimmed);
        e.aliases.add(canonical);
    }

    // ── 1. Auto-build from secrets ─────────────────────────────
    const secrets = getAllSecrets(chatId) || [];
    for (const secret of secrets) {
        for (const n of (secret.whoKnows || []))       addName(n);
        for (const n of (secret.whoDoesNotKnow || []))  addName(n);
        // Trigger anchors if present (v2 secrets)
        if (secret.triggerAnchors) {
            for (const n of (secret.triggerAnchors.characters || [])) addName(n);
            for (const n of (secret.triggerAnchors.aliases   || [])) addName(n);
        }
    }

    // ── 2. Auto-build from events (participants in titles/descriptions) ──
    // Events don't have a structured participant field, so we only pull
    // explicit names if a future schema adds them. For now, skip — prose
    // scanning handles event-mentioned characters.

    // ── 3. Auto-build from communities (members) ───────────────
    const communities = getAllCommunities(chatId) || [];
    for (const com of communities) {
        if (com.members && typeof com.members === 'string') {
            for (const m of com.members.split(',')) {
                addName(m);
            }
        }
        // Community name itself can be a group entity
        if (com.name) addName(com.name);
    }

    // ── 4. Merge manual alias groups (these take precedence) ───
    const manualGroups = getManualAliases(chatId);
    for (const group of manualGroups) {
        const e = ensureEntity(group.canonical, group.display);
        e.aliases.add(group.canonical);
        for (const a of (group.aliases || [])) {
            const ac = toCanonicalId(a);
            if (ac) e.aliases.add(ac);
        }
        // A manual alias may point variants at a canonical that auto-build
        // created as its own separate entity. Fold those in.
        for (const a of (group.aliases || [])) {
            const ac = toCanonicalId(a);
            if (ac && ac !== group.canonical && entities.has(ac)) {
                // Absorb the separate auto-entity's aliases, then remove it
                const absorbed = entities.get(ac);
                for (const sub of absorbed.aliases) e.aliases.add(sub);
                entities.delete(ac);
            }
        }
    }

    // ── Build reverse lookup: alias string -> canonical ID ─────
    const aliasToCanonical = new Map();
    for (const [canonical, e] of entities) {
        for (const alias of e.aliases) {
            aliasToCanonical.set(alias, canonical);
        }
    }

    // ── Resolver API ───────────────────────────────────────────
    return {
        /**
         * Resolve any name/alias/prose mention to a canonical ID.
         * Tries exact canonical match first, then substring containment
         * (so "oyabun ryomen sukuna" resolves via its "sukuna" alias).
         */
        resolve(name) {
            if (!name) return null;
            const c = toCanonicalId(name);
            if (!c) return null;
            // Exact alias match
            if (aliasToCanonical.has(c)) return aliasToCanonical.get(c);
            // Containment match — does any alias appear within this name or vice versa?
            for (const [alias, canonical] of aliasToCanonical) {
                if (alias.length < 3) continue; // skip ultra-short aliases to avoid noise
                if (c.includes(alias) || alias.includes(c)) return canonical;
            }
            return null;
        },

        getDisplay(canonical) {
            const e = entities.get(canonical);
            return e ? e.display : canonical;
        },

        allEntities() {
            return Array.from(entities.values()).map(e => ({
                canonical: e.canonical,
                display: e.display,
                aliases: Array.from(e.aliases)
            }));
        },

        allAliasStrings() {
            const out = [];
            for (const e of entities.values()) {
                for (const alias of e.aliases) {
                    if (alias.length >= 3) out.push(alias);
                }
            }
            return out;
        },

        /**
         * Scan a block of prose and return the set of canonical entity IDs
         * mentioned in it. This is the core prose-based detection primitive.
         */
        scanProse(text) {
            if (!text) return [];
            // Normalize: lowercase, strip diacritics, convert all apostrophe/quote
            // variants to a single space so "Sukuna's" → "sukuna s" and the
            // name still matches at a word boundary. Replace all non-word chars
            // with spaces so punctuation never blocks a match.
            const normalized = text.toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^\w\s]/g, ' ')   // all punctuation → space (handles ' " — etc.)
                .replace(/\s+/g, ' ');
            const padded = ' ' + normalized + ' ';
            const found = new Set();
            for (const e of entities.values()) {
                for (const alias of e.aliases) {
                    if (alias.length < 3) continue;
                    // Multi-word aliases: check as a phrase. Single-word: word boundary.
                    if (padded.includes(' ' + alias + ' ')) {
                        found.add(e.canonical);
                        break;
                    }
                }
            }
            return Array.from(found);
        }
    };
}
