/* eslint-disable */
// =============================================================================
// NWST Alias Registry — data/aliasRegistry.js
// =============================================================================
// Resolves the many ways a character/entity can be named in prose down to a
// single canonical ID. This is the foundation of the prose-based secrets
// engine: ST may store a full card title in msg.name (e.g. "Captain Renée Dubois")
// while secrets reference a short name ("Renée"), and prose may use other variants.
// Automatic normalization handles spelling-form differences; semantic titles or
// honorific variants should be connected explicitly through manual aliases.
//
// TWO SOURCES, MERGED:
//   1. AUTO-BUILT — names pulled from existing NWST data (whoKnows lists,
//      whoDoesNotKnow lists, community members, event participants). Every
//      name seen becomes its own canonical entity with itself as an alias.
//   2. MANUAL — user-defined alias groups via the Alias Manager UI. These
//      take precedence and let the user collapse variants the auto-builder
//      can't know are the same person ("the Captain" → Renée Dubois).
//
// Manual aliases are stored per-chat in chatMetadata under 'nwst:aliasRegistry'.
// Auto-built entries are computed fresh each call (not persisted) so they
// always reflect current data.
// =============================================================================

import { getChatId } from '../utils.js';
import { getAllSecrets } from './notebook.js';
import { getAllEvents } from './events.js';
import { getAllCommunities } from './communities.js';
import { getUserCharacterIdentity } from './secretsMeta.js';

const ALIAS_KEY = 'nwst:aliasRegistry';

// ── Canonical ID generation ───────────────────────────────────────────────

/**
 * Convert a display name into a canonical ID.
 * Lowercase, collapse whitespace, strip punctuation, and drop diacritics.
 * Titles and honorifics are NOT stripped automatically; map those through manual aliases.
 * "Renée Dubois" → "renee dubois"
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
 * Shape: [{ canonical: "renee dubois", display: "Renée Dubois", aliases: ["renee", "captain dubois", "the captain"] }]
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
 * @param {string} displayName - The canonical display name (e.g. "Renée Dubois")
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

    function ensureEntity(canonical, display, kind = 'character') {
        if (!canonical) return null;
        if (!entities.has(canonical)) {
            entities.set(canonical, {
                canonical,
                display: display || canonical,
                aliases: new Set([canonical]),
                kinds: new Set([kind])
            });
        }
        const e = entities.get(canonical);
        e.kinds.add(kind);
        // Prefer a non-canonical-looking display if we get a better one
        if (display && display.length > 0 && e.display === e.canonical) {
            e.display = display;
        }
        return e;
    }

    function addName(rawName, kind = 'character') {
        if (!rawName || typeof rawName !== 'string') return;
        const trimmed = rawName.trim();
        if (!trimmed) return;
        const canonical = toCanonicalId(trimmed);
        if (!canonical) return;
        const e = ensureEntity(canonical, trimmed, kind);
        e.aliases.add(canonical);
    }

    function mergeEntities(sourceCanonical, targetCanonical) {
        if (!sourceCanonical || !targetCanonical || sourceCanonical === targetCanonical) return;
        const source = entities.get(sourceCanonical);
        const target = entities.get(targetCanonical);
        if (!source || !target) return;
        for (const a of source.aliases) target.aliases.add(a);
        for (const k of source.kinds) target.kinds.add(k);
        if (target.display === target.canonical && source.display) target.display = source.display;
        entities.delete(sourceCanonical);
    }

    const UNSAFE_SHORT_ALIASES = new Set([
        'the','and','of','no','de','la','le','el','a','an','to','in','on','for',
        'king','queen','lord','lady','sir','madam','master','mistress','oyabun',
        'team','group','faction','network','committee','staff','servants',
        'surveillance','operatives','unknown','someone','everyone'
    ]);

    function isSafeShortAlias(token) {
        return token && token.length >= 3 && !UNSAFE_SHORT_ALIASES.has(token) && !/^\d+$/.test(token);
    }

    function addOrMergeShortNameAliases() {
        const snapshot = Array.from(entities.values());
        const tokenOwners = new Map();
        for (const e of snapshot) {
            const parts = e.canonical.split(' ').filter(isSafeShortAlias);
            if (parts.length < 2) continue;
            for (const token of [parts[0], parts[parts.length - 1]]) {
                if (!isSafeShortAlias(token)) continue;
                if (!tokenOwners.has(token)) tokenOwners.set(token, new Set());
                tokenOwners.get(token).add(e.canonical);
            }
        }
        for (const e of Array.from(entities.values())) {
            if (!entities.has(e.canonical)) continue;
            const parts = e.canonical.split(' ').filter(isSafeShortAlias);
            if (parts.length < 2) continue;
            for (const token of [parts[0], parts[parts.length - 1]]) {
                if (!isSafeShortAlias(token)) continue;
                const owners = tokenOwners.get(token);
                if (!owners || owners.size !== 1) continue; // collision guard
                if (entities.has(token)) {
                    mergeEntities(e.canonical, token); // prefer explicit short-name entity when it exists
                } else {
                    const current = entities.get(e.canonical);
                    if (current) current.aliases.add(token);
                }
            }
        }
    }

    // ── 1. Auto-build from secrets ─────────────────────────────
    const secrets = getAllSecrets(chatId) || [];
    for (const secret of secrets) {
        for (const n of (secret.whoKnows || []))       addName(n);
        for (const n of (secret.whoDoesNotKnow || []))  addName(n);
        // Trigger anchors if present (v2 secrets)
        if (secret.triggerAnchors) {
            for (const n of (secret.triggerAnchors.characters || [])) addName(n, 'character');
            for (const n of (secret.triggerAnchors.aliases   || [])) addName(n, 'character');
            for (const n of (secret.triggerAnchors.groups    || [])) addName(n, 'group');
            for (const n of (secret.triggerAnchors.organizations || [])) addName(n, 'group');
        }
    }

    // Configured user/PC identity is treated as a real entity, but only
    // sceneContext decides whether it is present in a user message.
    const pc = getUserCharacterIdentity(chatId);
    if (pc.name) {
        addName(pc.name, 'user_pc');
        const pcCanonical = toCanonicalId(pc.name);
        const e = ensureEntity(pcCanonical, pc.name, 'user_pc');
        for (const alias of pc.aliases || []) {
            const ac = toCanonicalId(alias);
            if (ac) e.aliases.add(ac);
        }
    }

    // ── 2. Auto-build from events ──────────────────────────────
    const events = getAllEvents(chatId) || [];
    for (const evt of events) {
        if (Array.isArray(evt.participants)) {
            for (const n of evt.participants) addName(n, 'character');
        }
    }

    // ── 3. Auto-build from communities (members) ───────────────
    const communities = getAllCommunities(chatId) || [];
    for (const com of communities) {
        if (com.members && typeof com.members === 'string') {
            for (const m of com.members.split(',')) {
                addName(m, 'character');
            }
        }
        // Community name itself can be a group entity
        if (com.name) addName(com.name, 'group');
    }

    // ── 3.5 Auto-merge safe first/full-name variants ───────────
    addOrMergeShortNameAliases();

    // ── 4. Merge manual alias groups (these take precedence) ───
    const manualGroups = getManualAliases(chatId);
    for (const group of manualGroups) {
        const e = ensureEntity(group.canonical, group.display, 'manual');
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

    // ── Merge word-order permutation duplicates ────────────────
    // "Mara Ellis" and "Ellis Mara" produce different canonical IDs
    // (we never reorder words in toCanonicalId, to stay safe). But they are the
    // same person. Detect entities whose canonical token-sets are identical and
    // merge them into the one with the most aliases (most established).
    {
        const tokenKey = (canonical) => canonical.split(' ').filter(Boolean).sort().join(' ');
        const byTokenKey = new Map(); // sorted-tokens -> [canonical,...]
        for (const canonical of entities.keys()) {
            // Only consider multi-word names; single tokens can't be reordered
            if (!canonical.includes(' ')) continue;
            const key = tokenKey(canonical);
            if (!byTokenKey.has(key)) byTokenKey.set(key, []);
            byTokenKey.get(key).push(canonical);
        }
        for (const [, group] of byTokenKey) {
            if (group.length < 2) continue;
            // Keep the entity with the most aliases as the survivor
            group.sort((a, b) => (entities.get(b)?.aliases.size || 0) - (entities.get(a)?.aliases.size || 0));
            const survivor = entities.get(group[0]);
            for (let i = 1; i < group.length; i++) {
                const dup = entities.get(group[i]);
                if (!dup) continue;
                for (const a of dup.aliases) survivor.aliases.add(a);
                survivor.aliases.add(group[i]); // ensure the dup's own ID resolves to survivor
                // Merge kinds (group/org/user_pc flags) so nothing is lost
                if (dup.kinds) {
                    if (!survivor.kinds) survivor.kinds = new Set();
                    for (const k of dup.kinds) survivor.kinds.add(k);
                }
                entities.delete(group[i]);
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
         * (so "captain renee dubois" can resolve via an explicitly registered "renee" alias).
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
                aliases: Array.from(e.aliases),
                kinds: Array.from(e.kinds || [])
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

        isGroup(canonical) {
            const e = entities.get(canonical);
            return !!e && (e.kinds?.has('group') || e.kinds?.has('organization'));
        },

        isUserPc(canonical) {
            const e = entities.get(canonical);
            return !!e && e.kinds?.has('user_pc');
        },

        /**
         * Scan a block of prose and return the set of canonical entity IDs
         * mentioned in it. This is the core prose-based detection primitive.
         */
        scanProse(text) {
            if (!text) return [];
            // Normalize: lowercase, strip diacritics, convert all apostrophe/quote
            // variants to a single space so "Renée's" → "renee s" and the
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
                    const aliasNorm = alias
                        .replace(/[^\w\s]/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (aliasNorm.length < 3) continue;
                    // Multi-word aliases: check as a phrase. Single-word: word boundary.
                    if (padded.includes(' ' + aliasNorm + ' ')) {
                        found.add(e.canonical);
                        break;
                    }
                }
            }
            return Array.from(found);
        }
    };
}
