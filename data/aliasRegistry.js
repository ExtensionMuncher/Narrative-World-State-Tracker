/* eslint-disable */
// =============================================================================
// NWST Alias Registry — data/aliasRegistry.js
// =============================================================================
// Resolves the many ways a character/entity can be named in prose down to a
// single canonical ID. This is the foundation of the prose-based secrets
// engine: character identities are discovered from narrative prose and existing
// NWST state. SillyTavern character-card titles / assistant speaker labels are
// deliberately excluded because a card can narrate multiple NPCs and is not
// itself a character.
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
// Manual aliases are stored per-chat through NWST's guarded storage layer.
// Auto-built entries are computed fresh each call (not persisted) so they
// always reflect current data. Auto-detected groups that the user deletes are
// persisted separately as blacklist entries and filtered before manual aliases
// are applied, so a deliberate manual group can still override a suppression.
// =============================================================================

import { getChatId } from '../utils.js';
import { getAllSecrets } from './notebook.js';
import { getHiddenIntentions } from './hiddenIntentions.js';
import { getAllEvents } from './events.js';
import { getAllCommunities } from './communities.js';
import { getUserCharacterIdentity } from './secretsMeta.js';
import { getChatData, setChatData } from './storage.js';

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
    const groups = getChatData(chatId, 'aliasRegistry');
    return Array.isArray(groups) ? groups : [];
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
        await setChatData(chatId, 'aliasRegistry', Array.isArray(aliasGroups) ? aliasGroups : []);
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
function normalizeManualAliasDisplays(values) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(values) ? values : []) {
        const display = String(raw || '').trim();
        const key = toCanonicalId(display);
        if (!display || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(display);
    }
    return out;
}

export async function addManualAlias(chatId, displayName, aliases) {
    if (!chatId) chatId = getChatId();
    const groups = getManualAliases(chatId);
    const canonical = toCanonicalId(displayName);
    if (!canonical) return null;

    // Merge into existing group if canonical already exists. Preserve display
    // spelling/case in storage; buildAliasRegistry canonicalizes only for matching.
    const existing = groups.find(g => g.canonical === canonical);
    if (existing) {
        existing.aliases = normalizeManualAliasDisplays([...(existing.aliases || []), ...(aliases || [])]);
        existing.display = String(displayName || '').trim() || existing.display || canonical;
    } else {
        groups.push({
            canonical,
            display: String(displayName || '').trim() || canonical,
            aliases: normalizeManualAliasDisplays(aliases)
        });
    }
    await saveManualAliases(chatId, groups);
    return groups.find(g => g.canonical === canonical) || null;
}

/**
 * Edit an existing manual group without changing its stable internal ID.
 * The visible canonical/display name may be corrected freely; it is also
 * registered as an alias so resolution follows the edited spelling.
 */
export async function updateManualAlias(chatId, originalCanonical, displayName, aliases) {
    if (!chatId) chatId = getChatId();
    const groups = getManualAliases(chatId);
    const group = groups.find(g => g.canonical === originalCanonical);
    if (!group) return null;
    const display = String(displayName || '').trim();
    if (!display) return null;
    group.display = display;
    group.aliases = normalizeManualAliasDisplays([display, ...(aliases || [])])
        .filter(alias => toCanonicalId(alias) !== group.canonical);
    await saveManualAliases(chatId, groups);
    return group;
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


// ── Auto-detected alias blacklist ─────────────────────────────────────────

function normalizeBlacklistAliases(values) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(values) ? values : []) {
        const key = toCanonicalId(String(raw || ''));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

function normalizeBlacklistEntry(raw, index = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const canonical = toCanonicalId(raw.canonical || raw.display || '');
    const aliases = normalizeBlacklistAliases([
        canonical,
        raw.display,
        ...(Array.isArray(raw.aliases) ? raw.aliases : [])
    ]);
    if (!canonical && !aliases.length) return null;
    return {
        id: String(raw.id || `alias_blacklist_${canonical || index}`),
        canonical: canonical || aliases[0],
        display: String(raw.display || raw.canonical || aliases[0] || '').trim(),
        aliases,
        kinds: normalizeBlacklistAliases(raw.kinds || []),
        blacklistedAt: Number(raw.blacklistedAt) || 0
    };
}

/** Return persistent suppressions for deleted auto-detected alias groups. */
export function getAutoAliasBlacklist(chatId) {
    if (!chatId) chatId = getChatId();
    if (!chatId) return [];
    const raw = getChatData(chatId, 'aliasBlacklist');
    return (Array.isArray(raw) ? raw : [])
        .map((entry, index) => normalizeBlacklistEntry(entry, index))
        .filter(Boolean);
}

export async function saveAutoAliasBlacklist(chatId, entries) {
    if (!chatId) chatId = getChatId();
    if (!chatId) return;
    const normalized = (Array.isArray(entries) ? entries : [])
        .map((entry, index) => normalizeBlacklistEntry(entry, index))
        .filter(Boolean);
    await setChatData(chatId, 'aliasBlacklist', normalized);
}

function aliasOverlapMatch(entry, canonical, aliases) {
    const entryAliases = new Set(normalizeBlacklistAliases([
        entry?.canonical,
        entry?.display,
        ...(entry?.aliases || [])
    ]));
    const entityAliases = new Set(normalizeBlacklistAliases([canonical, ...(aliases || [])]));
    if (!entryAliases.size || !entityAliases.size) return false;

    if (canonical && entry.canonical === canonical) return true;

    const overlap = [];
    for (const alias of entityAliases) {
        if (entryAliases.has(alias)) overlap.push(alias);
    }
    if (overlap.length >= 2) return true;

    // A matching multi-word/full-name alias is strong enough on its own. This
    // avoids suppressing an unrelated future character merely because both use
    // the same short first name.
    return overlap.some(alias => alias.includes(' ') || alias.length >= 8);
}

/**
 * Persistently suppress an auto-detected alias group. The complete alias set is
 * stored so the group stays hidden even if auto-merging later picks a different
 * canonical member as the survivor.
 */
export async function blacklistAutoAliasGroup(chatId, entity) {
    if (!chatId) chatId = getChatId();
    if (!chatId || !entity) return null;
    const canonical = toCanonicalId(entity.canonical || entity.display || '');
    const aliases = normalizeBlacklistAliases([
        canonical,
        entity.display,
        ...(Array.isArray(entity.aliases) ? entity.aliases : [])
    ]);
    if (!canonical || !aliases.length) return null;

    const entries = getAutoAliasBlacklist(chatId);
    const existing = entries.find(entry => aliasOverlapMatch(entry, canonical, aliases));
    if (existing) {
        existing.aliases = normalizeBlacklistAliases([...(existing.aliases || []), ...aliases]);
        existing.display = String(entity.display || existing.display || canonical).trim();
        existing.kinds = normalizeBlacklistAliases([...(existing.kinds || []), ...(entity.kinds || [])]);
        existing.blacklistedAt = Date.now();
        await saveAutoAliasBlacklist(chatId, entries);
        return existing;
    }

    const entry = {
        id: `alias_blacklist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        canonical,
        display: String(entity.display || entity.canonical || canonical).trim(),
        aliases,
        kinds: normalizeBlacklistAliases(entity.kinds || []),
        blacklistedAt: Date.now()
    };
    entries.push(entry);
    await saveAutoAliasBlacklist(chatId, entries);
    return entry;
}

/** Restore a previously deleted auto-detected group. */
export async function restoreAutoAliasGroup(chatId, blacklistId) {
    if (!chatId) chatId = getChatId();
    if (!chatId || !blacklistId) return;
    const entries = getAutoAliasBlacklist(chatId).filter(entry => entry.id !== blacklistId);
    await saveAutoAliasBlacklist(chatId, entries);
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
        if (source.display) {
            const targetWords = toCanonicalId(target.display || '').split(' ').filter(Boolean).length;
            const sourceWords = toCanonicalId(source.display || '').split(' ').filter(Boolean).length;
            // Prefer an informative full personal name over a bare short name.
            // Title wrappers were already collapsed by mergeContainedNameVariants,
            // so this selects "Alden Reed" rather than "Alden" without
            // restoring "Captain Alden Reed" as the display label.
            if (target.display === target.canonical || sourceWords > targetWords) target.display = source.display;
        }
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

    function mergeContainedNameVariants() {
        // Fold exact title/full-name wrappers before short-name collision
        // analysis. Example: "Captain Alden Reed" contains the complete
        // canonical name "Alden Reed"; treating those as separate people
        // later defeats per-actor caps and duplicate reconciliation.
        let changed = true;
        while (changed) {
            changed = false;
            const names = Array.from(entities.keys()).sort((a, b) => b.length - a.length);
            outer: for (const longer of names) {
                if (!entities.has(longer) || !longer.includes(' ')) continue;
                for (const shorter of names.slice().sort((a, b) => b.length - a.length)) {
                    if (longer === shorter || !entities.has(shorter) || !shorter.includes(' ')) continue;
                    if (longer.endsWith(' ' + shorter) || longer.startsWith(shorter + ' ')) {
                        const preferredDisplay = entities.get(shorter)?.display;
                        mergeEntities(longer, shorter);
                        if (preferredDisplay && entities.get(shorter)) entities.get(shorter).display = preferredDisplay;
                        changed = true;
                        break outer;
                    }
                }
            }
        }
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
    const userPcSecrets = secrets.filter(secret => secret?.type === 'user_pc');
    const userPcKnowerCounts = new Map();
    for (const secret of secrets) {
        for (const n of (secret.whoKnows || [])) {
            addName(n);
            if (secret?.type === 'user_pc') {
                const key = toCanonicalId(n);
                if (key) userPcKnowerCounts.set(key, (userPcKnowerCounts.get(key) || 0) + 1);
            }
        }
        for (const n of (secret.whoDoesNotKnow || []))  addName(n);
        // Trigger anchors if present (v2 secrets)
        if (secret.triggerAnchors) {
            for (const n of (secret.triggerAnchors.characters || [])) addName(n, 'character');
            for (const n of (secret.triggerAnchors.aliases   || [])) addName(n, 'character');
            for (const n of (secret.triggerAnchors.groups    || [])) addName(n, 'group');
            for (const n of (secret.triggerAnchors.organizations || [])) addName(n, 'group');
        }
    }

    // When explicit/runtime persona metadata is missing, repeated User / PC
    // secrets still provide a cautious fallback: only a single name shared by
    // every User / PC secret is treated as the protagonist. Do not mark every
    // knower, because an NPC confidant may legitimately know a PC secret too.
    if (userPcSecrets.length) {
        const sharedPcCandidates = Array.from(userPcKnowerCounts.entries())
            .filter(([, count]) => count === userPcSecrets.length)
            .map(([canonical]) => canonical);
        if (sharedPcCandidates.length === 1) {
            const canonical = sharedPcCandidates[0];
            const entity = entities.get(canonical);
            if (entity) entity.kinds.add('user_pc');
        }
    }

    // Hidden Intention actors are canonical entities even when they are not
    // currently present in events/communities/secrets.
    for (const intention of getHiddenIntentions(chatId) || []) {
        if (intention.actor) addName(intention.actor, 'character');
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

    // SillyTavern already knows which speaker is the user/active persona. Use
    // those runtime names as additional authoritative PC signals. This covers
    // older chats where the Secrets identity fields were never configured.
    try {
        const ctx = SillyTavern.getContext();
        const runtimeNames = new Set();
        for (const candidate of [ctx?.name1, ctx?.user_name, ctx?.userName, ctx?.persona?.name]) {
            const name = String(candidate || '').trim();
            if (name && !/^(user|you|me)$/i.test(name)) runtimeNames.add(name);
        }
        for (const msg of ctx?.chat || []) {
            if (!msg?.is_user) continue;
            const name = String(msg?.name || '').trim();
            if (name && !/^(user|you|me)$/i.test(name)) runtimeNames.add(name);
        }
        for (const name of runtimeNames) addName(name, 'user_pc');
    } catch (_) { /* Runtime identity is optional outside SillyTavern. */ }

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

    // ── 3.25 Character-card titles are intentionally excluded ──
    // Do not add ctx.name2 / character_name / non-user msg.name here. Those
    // values identify the SillyTavern card or narrator surface, not necessarily
    // an in-story NPC. Real actors are recovered from prose and structured NWST
    // state instead.

    // ── 3.5 Auto-merge safe title/full/short-name variants ─────
    mergeContainedNameVariants();
    addOrMergeShortNameAliases();

    // ── 3.75 Apply persistent auto-detected suppressions ──────
    // Suppress only the auto-built registry. Manual groups are merged afterward
    // and therefore remain an intentional user-controlled override.
    const autoBlacklist = getAutoAliasBlacklist(chatId);
    if (autoBlacklist.length) {
        for (const [canonical, entity] of Array.from(entities.entries())) {
            const aliases = Array.from(entity.aliases || []);
            if (autoBlacklist.some(entry => aliasOverlapMatch(entry, canonical, aliases))) {
                entities.delete(canonical);
            }
        }
    }

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
    // "Maya Ishikawa" and "Ishikawa Maya" produce different canonical IDs
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

    // Word-order duplicate merging can remove the collision that originally
    // prevented a unique short name from being attached (e.g. "Alden Reed"
    // and "Reed, Alden" both blocked "Alden" on the first pass). Run
    // the guarded short-name merge once more against the consolidated registry.
    addOrMergeShortNameAliases();

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
