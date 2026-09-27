/* eslint-disable */
// =============================================================================
// NWST Hidden Intentions Data — data/hiddenIntentions.js
// =============================================================================
// Hidden Intentions live inside the Notebook so snapshots/imports/exports and
// Previous Day restoration carry them automatically. A small separate runtime
// state tracks cadence, dirty actors, and scan diagnostics.
// =============================================================================

import { getNotebook, saveNotebook } from './notebook.js';
import { getChatData, setChatData } from './storage.js';

export const INTENTION_TYPES = Object.freeze(['objective', 'active_plan', 'commitment', 'ongoing_priority', 'contingency', 'emerging_interest']);
export const INTENTION_DOMAINS = Object.freeze([
    'relational', 'care_support', 'duty_responsibility', 'personal', 'investigative',
    'logistical', 'social_factional', 'protective', 'opportunistic', 'adversarial', 'escape_avoidance'
]);
export const INTENTION_STATUSES = Object.freeze([
    'latent', 'active', 'ready', 'blocked', 'revised', 'parked', 'resolved', 'abandoned', 'stale', 'pending_review'
]);
export const INTENTION_PROGRESS = Object.freeze([
    'unattempted', 'prepared', 'attempted', 'progressed', 'blocked', 'failed', 'fulfilled'
]);
export const INTENTION_COMMITMENTS = Object.freeze(['low', 'medium', 'high']);
export const INTENTION_CONFIDENCE = Object.freeze(['low', 'medium', 'high']);

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeId(prefix = 'intent') {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function cleanList(value, max = 12) {
    const source = Array.isArray(value)
        ? value
        : (typeof value === 'string' && value.trim() ? value.split(/\n+|\s*•\s*|;\s+/) : []);
    const out = [];
    const seen = new Set();
    for (const item of source) {
        const text = String(item || '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= max) break;
    }
    return out;
}


function normalizeIntentionType(value) {
    const type = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (type === 'intention' || type === 'plan' || type === 'active_intention') return 'active_plan';
    if (type === 'priority' || type === 'maintenance_priority') return 'ongoing_priority';
    if (type === 'interest' || type === 'curiosity') return 'emerging_interest';
    return INTENTION_TYPES.includes(type) ? type : 'active_plan';
}

function normalizeIntentionDomain(value) {
    const domain = String(value || '').trim().toLowerCase().replace(/[\s/\-&]+/g, '_');
    const aliases = {
        care: 'care_support', support: 'care_support', duty: 'duty_responsibility', responsibility: 'duty_responsibility',
        social: 'social_factional', factional: 'social_factional', faction: 'social_factional',
        investigation: 'investigative', logistics: 'logistical', protection: 'protective',
        opportunity: 'opportunistic', hostile: 'adversarial', conflict: 'adversarial',
        escape: 'escape_avoidance', avoidance: 'escape_avoidance'
    };
    const mapped = aliases[domain] || domain;
    return INTENTION_DOMAINS.includes(mapped) ? mapped : '';
}

function inferIntentionDomain(raw = {}) {
    const supplied = normalizeIntentionDomain(raw.domain);
    if (supplied) return supplied;
    const asList = value => Array.isArray(value) ? value : (value == null ? [] : [value]);
    const text = [raw.objective, raw.strategy, raw.nextAction, ...asList(raw.triggerConditions), ...asList(raw.constraints)]
        .map(value => String(value || '').toLowerCase()).join(' ');
    const matches = pattern => pattern.test(text);
    if (matches(/\b(escape|resign|leave the company|leave the country|withdraw|flee|avoid involvement|self-preservation|clean exit)\b/)) return 'escape_avoidance';
    if (matches(/\b(contain|retaliat|undermine|coerc|threaten|attack|eliminate|sabotage|intimidat)\w*/)) return 'adversarial';
    if (matches(/\b(investigat|discover|identify|find out|evidence|research|verify|trace|uncover)\w*/)) return 'investigative';
    if (matches(/\b(faction|community|group cohesion|alliance|hierarchy|members|collective|coalition)\b/)) return 'social_factional';
    if (matches(/\b(friendship|relationship|affection|romance|emotional closeness|personal bond|become closer|reconcile with)\b/)) return 'relational';
    if (matches(/\b(emotional support|care for|comfort|well-?being|help (?:him|her|them|a friend|an ally)|look after|reassure|support (?:him|her|them|a friend|an ally))\b/)) return 'care_support';
    if (matches(/\b(supplies|inventory|travel|route|transport|resource allocation|procure|stockpile|logistics?)\b/)) return 'logistical';
    if (matches(/\b(duty|responsib|obligation|promise|deadline|assignment|report|presentation|project|acquisition|audition|meeting|workstream|complete|finalize|prepare|schedule)\w*/)) return 'duty_responsibility';
    if (matches(/\b(protect|preserve|secure|safeguard|defend|prevent harm|keep .* safe)\w*/)) return 'protective';
    if (matches(/\b(opportun|leverage|advantage|gain access|capitalize|position .* for|exploit an opening)\w*/)) return 'opportunistic';
    return 'personal';
}

function cleanEvidenceRanges(value) {
    if (!Array.isArray(value)) return [];
    const normalized = value.map(item => ({
        start: Number.isInteger(item?.start) ? item.start : null,
        end: Number.isInteger(item?.end) ? item.end : (Number.isInteger(item?.start) ? item.start : null),
        summary: String(item?.summary || '').trim().slice(0, 500)
    })).filter(item => item.summary || item.start != null);

    // One evidence range should appear once. When the model repeats the exact
    // same message span, keep the more informative summary rather than letting
    // chronological backfill accumulate duplicate rows.
    const bySpan = new Map();
    for (const item of normalized) {
        const key = `${item.start ?? 'null'}:${item.end ?? 'null'}`;
        const current = bySpan.get(key);
        if (!current || item.summary.length > current.summary.length) bySpan.set(key, item);
    }
    return Array.from(bySpan.values()).slice(-6);
}


const CLOSED_INTENTION_STATUSES = new Set(['resolved', 'abandoned', 'stale']);
const TERMINAL_INTENTION_PROGRESS = new Set(['failed', 'fulfilled']);

function latestEvidenceMessage(record = {}) {
    let latest = null;
    for (const range of record.evidenceRanges || []) {
        const candidate = Number.isInteger(range?.end) ? range.end : (Number.isInteger(range?.start) ? range.start : null);
        if (candidate != null && (latest == null || candidate > latest)) latest = candidate;
    }
    return latest;
}

export function normalizeHiddenIntention(raw = {}) {
    const actor = String(raw.actor || raw.actorDisplay || '').trim();
    const actorId = String(raw.actorId || '').trim();
    const origin = raw.origin === 'manual' ? 'manual' : 'generated';
    const progressNote = String(raw.progressNote || '').trim();
    const status = INTENTION_STATUSES.includes(raw.status) ? raw.status : 'active';
    let progressStage = INTENTION_PROGRESS.includes(raw.progressStage) ? raw.progressStage : 'unattempted';
    // Generated records cannot claim meaningful progress without explaining
    // what actually happened. Older first-pass records sometimes arrived as
    // "progressed" with a completely blank note, which produced misleading
    // empty UI fields. Treat those as newly tracked until a later scan supplies
    // grounded lifecycle evidence.
    if (origin === 'generated' && progressStage !== 'unattempted' && !progressNote) {
        progressStage = 'unattempted';
    }
    return {
        id: String(raw.id || makeId()),
        actorId,
        actor,
        type: normalizeIntentionType(raw.type),
        domain: inferIntentionDomain(raw),
        objective: String(raw.objective || '').trim(),
        strategy: String(raw.strategy || '').trim(),
        nextAction: String(raw.nextAction || '').trim(),
        triggerConditions: cleanList(raw.triggerConditions, 8),
        constraints: cleanList(raw.constraints, 8),
        basis: cleanList(raw.basis || raw.knowledgeBasis, 10),
        status,
        progressStage,
        progressNote,
        confidence: INTENTION_CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'medium',
        commitment: INTENTION_COMMITMENTS.includes(raw.commitment) ? raw.commitment : 'medium',
        relatedEventIds: cleanList(raw.relatedEventIds, 12),
        relatedCommunityIds: cleanList(raw.relatedCommunityIds, 12),
        evidenceRanges: cleanEvidenceRanges(raw.evidenceRanges),
        createdDay: Number.isInteger(raw.createdDay) ? raw.createdDay : null,
        createdMessage: Number.isInteger(raw.createdMessage) ? raw.createdMessage : null,
        lastReviewedDay: Number.isInteger(raw.lastReviewedDay) ? raw.lastReviewedDay : null,
        lastReviewedMessage: Number.isInteger(raw.lastReviewedMessage) ? raw.lastReviewedMessage : null,
        lastReinforcedDay: Number.isInteger(raw.lastReinforcedDay) ? raw.lastReinforcedDay : null,
        lastReinforcedMessage: Number.isInteger(raw.lastReinforcedMessage) ? raw.lastReinforcedMessage : null,
        parkedFromStatus: status === 'parked' && INTENTION_STATUSES.includes(raw.parkedFromStatus) && raw.parkedFromStatus !== 'parked' ? raw.parkedFromStatus : '',
        parkedAtDay: status === 'parked' && Number.isInteger(raw.parkedAtDay) ? raw.parkedAtDay : null,
        parkedAtMessage: status === 'parked' && Number.isInteger(raw.parkedAtMessage) ? raw.parkedAtMessage : null,
        parkedReason: status === 'parked' ? String(raw.parkedReason || '').trim().slice(0, 700) : '',
        parkedByIntentionId: status === 'parked' ? String(raw.parkedByIntentionId || '').trim() : '',
        reactivatedAtDay: Number.isInteger(raw.reactivatedAtDay) ? raw.reactivatedAtDay : null,
        reactivatedAtMessage: Number.isInteger(raw.reactivatedAtMessage) ? raw.reactivatedAtMessage : null,
        locked: raw.locked === true,
        origin
    };
}

export function getHiddenIntentions(chatId) {
    const notebook = getNotebook(chatId);
    return Array.isArray(notebook.hiddenIntentions)
        ? notebook.hiddenIntentions.map(normalizeHiddenIntention)
        : [];
}

export async function saveHiddenIntentions(chatId, intentions) {
    const notebook = getNotebook(chatId);
    notebook.hiddenIntentions = Array.isArray(intentions)
        ? intentions.map(normalizeHiddenIntention)
        : [];
    await saveNotebook(chatId, notebook);
    return notebook.hiddenIntentions;
}

async function saveRawHiddenIntentions(chatId, intentions) {
    const notebook = getNotebook(chatId);
    notebook.hiddenIntentions = Array.isArray(intentions) ? clone(intentions) : [];
    await saveNotebook(chatId, notebook);
    return notebook.hiddenIntentions;
}

export function getHiddenIntention(chatId, intentionId) {
    return getHiddenIntentions(chatId).find(item => item.id === intentionId) || null;
}

export async function addHiddenIntention(chatId, data = {}) {
    const list = getHiddenIntentions(chatId);
    const record = normalizeHiddenIntention({ ...data, id: data.id || makeId() });
    list.push(record);
    await saveHiddenIntentions(chatId, list);
    return record;
}

export async function updateHiddenIntention(chatId, intentionId, updates = {}) {
    const list = getHiddenIntentions(chatId);
    const index = list.findIndex(item => item.id === intentionId);
    if (index < 0) return null;
    const current = list[index];
    const manualOverride = updates?._manualOverride === true;
    const safeUpdates = { ...updates, id: current.id };
    delete safeUpdates._manualOverride;
    if (current.status === 'parked' && safeUpdates.status && safeUpdates.status !== 'parked') {
        safeUpdates.parkedFromStatus = '';
        safeUpdates.parkedAtDay = null;
        safeUpdates.parkedAtMessage = null;
        safeUpdates.parkedReason = '';
        safeUpdates.parkedByIntentionId = '';
    }
    if (safeUpdates.status === 'parked' && current.status !== 'parked') {
        safeUpdates.parkedFromStatus = current.status || 'active';
        safeUpdates.parkedReason = String(safeUpdates.parkedReason || 'Manually parked.').trim();
    }

    if (current.locked && !manualOverride && updates.locked !== false) {
        // Locked records may progress through their lifecycle, but automatic
        // scans cannot rewrite the player's objective/strategy/action wording.
        delete safeUpdates.objective;
        delete safeUpdates.strategy;
        delete safeUpdates.nextAction;
        delete safeUpdates.triggerConditions;
        delete safeUpdates.constraints;
        delete safeUpdates.basis;
        delete safeUpdates.type;
        delete safeUpdates.domain;
        delete safeUpdates.actor;
        delete safeUpdates.actorId;
    }
    const resultingProgress = safeUpdates.progressStage || current.progressStage;
    const resultingStatus = safeUpdates.status || current.status;
    if (TERMINAL_INTENTION_PROGRESS.has(resultingProgress) && !CLOSED_INTENTION_STATUSES.has(resultingStatus) && resultingStatus !== 'pending_review') {
        safeUpdates.status = 'resolved';
    }
    if (CLOSED_INTENTION_STATUSES.has(safeUpdates.status || current.status)) safeUpdates.nextAction = '';
    list[index] = normalizeHiddenIntention({ ...current, ...safeUpdates });
    await saveHiddenIntentions(chatId, list);
    return list[index];
}

export async function deleteHiddenIntention(chatId, intentionId) {
    const list = getHiddenIntentions(chatId);
    const next = list.filter(item => item.id !== intentionId);
    if (next.length === list.length) return false;
    await saveHiddenIntentions(chatId, next);
    // A completed Debug Backfill checkpoint is meaningless once the ledger is
    // empty. Reset cadence, diagnostics, actor caches, and resumable segment
    // metadata so the next debug click starts a genuinely fresh test.
    if (!next.length) {
        await resetHiddenIntentionsState(chatId);
        await setChatData(chatId, 'hiddenIntentionsRepairBackup', null);
        await setChatData(chatId, 'hiddenIntentionsBackfillCheckpoint', null);
    }
    return true;
}


export function getHiddenIntentionsRepairBackup(chatId) {
    const raw = getChatData(chatId, 'hiddenIntentionsRepairBackup');
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.intentions)) return null;
    return clone(raw);
}


export function getHiddenIntentionsBackfillCheckpoint(chatId) {
    const raw = getChatData(chatId, 'hiddenIntentionsBackfillCheckpoint');
    if (!raw || typeof raw !== 'object' || !raw.runtimeState || typeof raw.runtimeState !== 'object') return null;
    if (!Array.isArray(raw.intentions)) return null;
    return clone(raw);
}

export async function saveHiddenIntentionsBackfillCheckpoint(chatId, { intentions = null, runtimeState = null, source = 'segment' } = {}) {
    if (!chatId) return null;
    const safeIntentions = Array.isArray(intentions) ? intentions : getHiddenIntentions(chatId);
    const safeState = runtimeState && typeof runtimeState === 'object' ? runtimeState : getHiddenIntentionsState(chatId);
    const checkpoint = {
        savedAt: Date.now(),
        source: String(source || 'segment'),
        intentions: clone(safeIntentions),
        runtimeState: clone(safeState)
    };
    await setChatData(chatId, 'hiddenIntentionsBackfillCheckpoint', checkpoint);
    return clone(checkpoint);
}

export async function clearHiddenIntentionsBackfillCheckpoint(chatId) {
    if (!chatId) return;
    await setChatData(chatId, 'hiddenIntentionsBackfillCheckpoint', null);
}

function repairCanonicalName(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function runtimeCharacterCardNames() {
    const names = new Map();
    const add = value => {
        const display = String(value || '').trim();
        const canonical = repairCanonicalName(display);
        // Repair only unmistakable container/card labels. A single-character or
        // group-chat card may legitimately share an NPC's exact name; those are
        // protected from automatic reassignment. Prompt construction excludes
        // every card label regardless, so this narrower test is repair-only.
        const looksLikeContainer = /\b(rpg|roleplay|scenario|simulator|adventure|story|chat|world|au|alternate universe|narrator|game master|gm)\b/.test(canonical);
        if (canonical && looksLikeContainer) names.set(canonical, display);
    };
    try {
        const ctx = SillyTavern.getContext();
        for (const candidate of [ctx?.name2, ctx?.character_name, ctx?.characterName]) add(candidate);
        for (const msg of ctx?.chat || []) {
            if (!msg?.is_user) add(msg?.name);
        }
    } catch (_) { /* Repair also runs in import/test contexts without ST runtime. */ }
    return names;
}

function searchableIntentionText(record = {}) {
    return [
        record.objective, record.strategy, record.nextAction, record.progressNote,
        ...(record.triggerConditions || []), ...(record.constraints || []), ...(record.basis || []),
        ...(record.evidenceRanges || []).map(item => item?.summary)
    ].map(value => String(value || '')).join('\n');
}

function escapeRepairRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function actorMentionScore(text, actor = '') {
    const canonical = repairCanonicalName(actor);
    if (!canonical) return 0;
    const haystack = repairCanonicalName(text);
    let score = 0;
    const full = new RegExp(`(?:^|\\s)${escapeRepairRegex(canonical)}(?:$|\\s)`, 'g');
    score += (haystack.match(full) || []).length * 6;
    const parts = canonical.split(' ').filter(token => token.length >= 3 && !/^(the|and|for|with|from|high|school|rpg|roleplay|story|chat|character|narrator)$/.test(token));
    const distinctive = parts.length ? parts[parts.length - 1] : '';
    if (distinctive && distinctive !== canonical) {
        const token = new RegExp(`(?:^|\\s)${escapeRepairRegex(distinctive)}(?:$|\\s)`, 'g');
        score += Math.min(4, (haystack.match(token) || []).length) * 2;
    }
    return score;
}

function evidenceRangesOverlap(a = {}, b = {}) {
    const aStart = Number.isInteger(a?.start) ? a.start : null;
    const aEnd = Number.isInteger(a?.end) ? a.end : aStart;
    const bStart = Number.isInteger(b?.start) ? b.start : null;
    const bEnd = Number.isInteger(b?.end) ? b.end : bStart;
    return aStart != null && bStart != null && Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

function recordEvidenceOverlapCount(a = {}, b = {}) {
    let count = 0;
    for (const left of a.evidenceRanges || []) {
        if ((b.evidenceRanges || []).some(right => evidenceRangesOverlap(left, right))) count += 1;
    }
    return count;
}

function repairWordSet(value) {
    return new Set(repairCanonicalName(value).split(' ').filter(token => token.length >= 4 && !/^(with|from|that|this|into|about|their|there|where|after|before|toward|between|through|growing|maintain|continue|active|current|investigative|relational)$/.test(token)));
}

function repairTextSimilarity(a, b) {
    const left = repairWordSet(a);
    const right = repairWordSet(b);
    if (!left.size || !right.size) return 0;
    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    return shared / Math.max(left.size, right.size);
}

function strongerLevel(a, b, order) {
    return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function mergeCardRepairEvidence(targetRanges = [], sourceRanges = []) {
    const merged = clone(targetRanges || []);
    for (const incoming of sourceRanges || []) {
        const inStart = Number.isInteger(incoming?.start) ? incoming.start : null;
        const inEnd = Number.isInteger(incoming?.end) ? incoming.end : inStart;
        const container = merged.find(existing => {
            const exStart = Number.isInteger(existing?.start) ? existing.start : null;
            const exEnd = Number.isInteger(existing?.end) ? existing.end : exStart;
            return inStart != null && exStart != null && exStart <= inStart && exEnd >= inEnd;
        });
        if (container) {
            if (String(incoming?.summary || '').length > String(container?.summary || '').length) container.summary = String(incoming.summary || '').trim();
            continue;
        }
        merged.push(clone(incoming));
    }
    return cleanEvidenceRanges(merged);
}

function mergeMisassignedCardRecord(target, source) {
    const merged = clone(target);
    merged.basis = cleanList([...(target.basis || []), ...(source.basis || [])], 10);
    merged.evidenceRanges = mergeCardRepairEvidence(target.evidenceRanges, source.evidenceRanges);
    merged.lastReviewedMessage = Math.max(Number(target.lastReviewedMessage || 0), Number(source.lastReviewedMessage || 0)) || null;
    merged.lastReinforcedMessage = latestEvidenceMessage(merged);
    merged.lastReviewedDay = Math.max(Number(target.lastReviewedDay || 0), Number(source.lastReviewedDay || 0)) || null;
    merged.lastReinforcedDay = Math.max(Number(target.lastReinforcedDay || 0), Number(source.lastReinforcedDay || 0)) || null;
    if (String(source.progressNote || '').length > String(target.progressNote || '').length) merged.progressNote = source.progressNote;
    merged.confidence = strongerLevel(target.confidence, source.confidence, INTENTION_CONFIDENCE);
    merged.commitment = strongerLevel(target.commitment, source.commitment, INTENTION_COMMITMENTS);
    return normalizeHiddenIntention(merged);
}

function cardRecordIsStrictDuplicate(source, target) {
    if (!source || !target) return false;
    if (source.type !== target.type || source.domain !== target.domain) return false;

    const sourceObjective = repairCanonicalName(source.objective);
    const targetObjective = repairCanonicalName(target.objective);
    const objectiveSimilarity = repairTextSimilarity(source.objective, target.objective);
    const exactObjective = Boolean(sourceObjective && sourceObjective === targetObjective);

    const sourceRanges = Array.isArray(source.evidenceRanges) ? source.evidenceRanges : [];
    const targetRanges = Array.isArray(target.evidenceRanges) ? target.evidenceRanges : [];
    const evidenceFullyCovered = sourceRanges.length > 0 && sourceRanges.every(left =>
        targetRanges.some(right => evidenceRangesOverlap(left, right))
    );

    const sourceAction = repairCanonicalName(source.nextAction);
    const targetAction = repairCanonicalName(target.nextAction);
    const actionCompatible = !sourceAction || !targetAction || sourceAction === targetAction || repairTextSimilarity(source.nextAction, target.nextAction) >= 0.75;

    // Character-card attribution is an actor-label error, not permission to
    // collapse two psychologically distinct records. Merge only when the two
    // records are effectively the same schema entry with the same narrative
    // evidence. Different types (for example active_plan vs emerging_interest)
    // always remain separate after reassignment.
    return evidenceFullyCovered && actionCompatible && (exactObjective || objectiveSimilarity >= 0.82);
}

function scoreCardActorCandidates(source, legitimateRecords) {
    const byActor = new Map();
    for (const record of legitimateRecords || []) {
        const actorKey = repairCanonicalName(record.actorId || record.actor);
        if (!actorKey) continue;
        if (!byActor.has(actorKey)) byActor.set(actorKey, []);
        byActor.get(actorKey).push(record);
    }

    const text = searchableIntentionText(source);
    const actorScores = [];
    for (const [actorKey, actorRecords] of byActor.entries()) {
        const actorName = actorRecords[0]?.actor || actorKey;
        let score = actorMentionScore(text, actorName);
        let evidenceOverlap = 0;
        for (const candidate of actorRecords) {
            const overlap = recordEvidenceOverlapCount(source, candidate);
            evidenceOverlap += overlap;
            score += overlap * 12;
            if (source.domain === candidate.domain) score += 2;
            if (source.type === candidate.type) score += 1;
            score += Math.round(repairTextSimilarity(source.objective, candidate.objective) * 8);
        }
        actorScores.push({ actorKey, actorName, actorRecords, score, evidenceOverlap });
    }
    actorScores.sort((a, b) => b.evidenceOverlap - a.evidenceOverlap || b.score - a.score);
    const winner = actorScores[0];
    const runnerUp = actorScores[1];
    const uniquelyGroundedByEvidence = winner?.evidenceOverlap > 0 && (!runnerUp || runnerUp.evidenceOverlap === 0);
    if (!winner || winner.score < 10 || (!uniquelyGroundedByEvidence && runnerUp && winner.score - runnerUp.score < 4)) return null;
    return winner;
}

function recoverPreviouslyMergedCardRecords(records, previousBackup, runtimeState, report, changedIds) {
    if (!previousBackup || !Array.isArray(previousBackup.intentions)) return records;
    const summary = String(runtimeState?.lastRepairSummary || '');
    const lastRepairAt = Number(runtimeState?.lastRepairAt || 0);
    const lastScanAt = Number(runtimeState?.lastScanAt || 0);
    if (!lastRepairAt || !/character-card record\(s\) merged/i.test(summary) || lastScanAt > lastRepairAt) return records;

    const cardNames = runtimeCharacterCardNames();
    if (!cardNames.size) return records;
    const forbidden = new Set(cardNames.keys());
    const currentIds = new Set(records.map(record => record.id));
    const missingCardRecords = previousBackup.intentions.filter(record =>
        forbidden.has(repairCanonicalName(record.actorId || record.actor)) && !currentIds.has(record.id)
    );
    if (!missingCardRecords.length) return records;

    let next = records.map(clone);
    for (const sourceRaw of missingCardRecords) {
        const source = normalizeHiddenIntention(sourceRaw);
        const legitimatePoolById = new Map();
        for (const candidate of previousBackup.intentions) {
            if (!forbidden.has(repairCanonicalName(candidate.actorId || candidate.actor))) legitimatePoolById.set(candidate.id, candidate);
        }
        for (const candidate of next) {
            if (!forbidden.has(repairCanonicalName(candidate.actorId || candidate.actor))) legitimatePoolById.set(candidate.id, candidate);
        }
        const winner = scoreCardActorCandidates(source, Array.from(legitimatePoolById.values()));
        if (!winner) continue;

        let bestTarget = null;
        let bestTargetScore = -1;
        for (const candidate of next.filter(record => repairCanonicalName(record.actorId || record.actor) === winner.actorKey)) {
            const overlap = recordEvidenceOverlapCount(source, candidate);
            const similarity = repairTextSimilarity(source.objective, candidate.objective);
            const targetScore = overlap * 20 + Math.round(similarity * 10) + (source.domain === candidate.domain ? 3 : 0) + (source.type === candidate.type ? 2 : 0);
            if (targetScore > bestTargetScore) {
                bestTarget = candidate;
                bestTargetScore = targetScore;
            }
        }

        // v1.3.21 may have folded this source into the winning target. Because
        // no LLM scan has run since that repair, restore the target's exact
        // pre-repair form before re-adding the source as its own intention.
        if (bestTarget) {
            const backupTarget = previousBackup.intentions.find(record => record.id === bestTarget.id);
            if (backupTarget) {
                next = next.map(record => record.id === bestTarget.id ? normalizeHiddenIntention(backupTarget) : record);
                changedIds.add(bestTarget.id);
            }
        }

        next.push(normalizeHiddenIntention({ ...source, actorId: winner.actorKey, actor: winner.actorName }));
        changedIds.add(source.id);
        report.cardActorRecordsDetected += 1;
        report.cardActorRecordsReassigned += 1;
        report.priorMergedCardRecordsRecovered += 1;
    }
    return next;
}

function repairCharacterCardActors(records, report, changedIds) {
    const cardNames = runtimeCharacterCardNames();
    if (!cardNames.size) return records;
    const forbidden = new Set(cardNames.keys());
    const legitimate = records.filter(record => !forbidden.has(repairCanonicalName(record.actorId || record.actor)));
    const removedIds = new Set();
    const replacements = new Map();
    for (const source of records) {
        const sourceKey = repairCanonicalName(source.actorId || source.actor);
        if (!forbidden.has(sourceKey)) continue;
        report.cardActorRecordsDetected += 1;
        const winner = scoreCardActorCandidates(source, legitimate);
        if (!winner) {
            report.cardActorRecordsUnresolved += 1;
            continue;
        }

        let bestTarget = null;
        let bestTargetScore = -1;
        for (const candidate of winner.actorRecords) {
            const overlap = recordEvidenceOverlapCount(source, candidate);
            const similarity = repairTextSimilarity(source.objective, candidate.objective);
            const targetScore = overlap * 20 + Math.round(similarity * 10) + (source.domain === candidate.domain ? 3 : 0) + (source.type === candidate.type ? 2 : 0);
            if (targetScore > bestTargetScore) {
                bestTarget = candidate;
                bestTargetScore = targetScore;
            }
        }

        if (bestTarget && cardRecordIsStrictDuplicate(source, bestTarget)) {
            const merged = mergeMisassignedCardRecord(bestTarget, source);
            replacements.set(bestTarget.id, merged);
            removedIds.add(source.id);
            changedIds.add(bestTarget.id);
            changedIds.add(source.id);
            report.cardActorRecordsMerged += 1;
            report.recordsDeleted += 1;
        } else {
            const reassigned = normalizeHiddenIntention({ ...source, actorId: winner.actorKey, actor: winner.actorName });
            replacements.set(source.id, reassigned);
            changedIds.add(source.id);
            report.cardActorRecordsReassigned += 1;
        }
    }

    return records
        .filter(record => !removedIds.has(record.id))
        .map(record => replacements.get(record.id) || record);
}

export async function repairHiddenIntentions(chatId, { createBackup = true, source = 'manual' } = {}) {
    const notebook = getNotebook(chatId);
    const original = Array.isArray(notebook.hiddenIntentions) ? clone(notebook.hiddenIntentions) : [];
    const originalState = getHiddenIntentionsState(chatId);
    const previousBackup = getHiddenIntentionsRepairBackup(chatId);
    if (createBackup) {
        await setChatData(chatId, 'hiddenIntentionsRepairBackup', {
            createdAt: Date.now(),
            source: String(source || 'manual'),
            intentions: clone(original),
            runtimeState: clone(originalState)
        });
    }

    const report = {
        inspected: original.length,
        changed: 0,
        closedNextActionsCleared: 0,
        reinforcementTimestampsCorrected: 0,
        lifecycleNormalized: 0,
        recordsDeleted: 0,
        cardActorRecordsDetected: 0,
        cardActorRecordsMerged: 0,
        cardActorRecordsReassigned: 0,
        cardActorRecordsUnresolved: 0,
        priorMergedCardRecordsRecovered: 0,
        llmCalls: 0
    };

    const changedIds = new Set();
    let repairSource = recoverPreviouslyMergedCardRecords(original, previousBackup, originalState, report, changedIds);
    report.inspected = repairSource.length;
    let repaired = repairSource.map(sourceRecord => {
        let record = clone(sourceRecord);
        let changed = false;

        if (TERMINAL_INTENTION_PROGRESS.has(record.progressStage) && !CLOSED_INTENTION_STATUSES.has(record.status) && record.status !== 'pending_review') {
            record.status = 'resolved';
            report.lifecycleNormalized += 1;
            changed = true;
        }
        if (record.status === 'blocked' && !TERMINAL_INTENTION_PROGRESS.has(record.progressStage) && record.progressStage !== 'blocked') {
            record.progressStage = 'blocked';
            report.lifecycleNormalized += 1;
            changed = true;
        }
        if (CLOSED_INTENTION_STATUSES.has(record.status) && String(record.nextAction || '').trim()) {
            record.nextAction = '';
            report.closedNextActionsCleared += 1;
            changed = true;
        }

        const latestEvidence = latestEvidenceMessage(record);
        if (latestEvidence != null && record.lastReinforcedMessage !== latestEvidence) {
            record.lastReinforcedMessage = latestEvidence;
            report.reinforcementTimestampsCorrected += 1;
            changed = true;
        }



        const normalized = normalizeHiddenIntention(record);
        if (JSON.stringify(normalized) !== JSON.stringify(sourceRecord)) changed = true;
        if (changed) changedIds.add(sourceRecord.id);
        return normalized;
    });

    repaired = repairCharacterCardActors(repaired, report, changedIds);
    report.changed = changedIds.size;
    await saveHiddenIntentions(chatId, repaired);
    const summary = `${report.changed}/${report.inspected} repaired; ${report.closedNextActionsCleared} closed next action(s) cleared; ${report.reinforcementTimestampsCorrected} reinforcement timestamp(s) corrected; ${report.lifecycleNormalized} lifecycle normalization(s); ${report.cardActorRecordsMerged} strict duplicate character-card record(s) merged; ${report.cardActorRecordsReassigned} character-card record(s) reassigned; ${report.priorMergedCardRecordsRecovered} previously merged record(s) restored; ${report.cardActorRecordsUnresolved} unresolved card record(s); 0 LLM calls.`;
    await saveHiddenIntentionsState(chatId, {
        ...getHiddenIntentionsState(chatId),
        lastRepairAt: Date.now(),
        lastRepairSource: String(source || 'manual'),
        lastRepairSummary: summary
    });
    const repairedState = getHiddenIntentionsState(chatId);
    if (repairedState.backfillPlanSignature && Array.isArray(repairedState.backfillSuccessfulSegments) && repairedState.backfillSuccessfulSegments.length) {
        await saveHiddenIntentionsBackfillCheckpoint(chatId, {
            intentions: repaired,
            runtimeState: repairedState,
            source: 'local_repair'
        });
    }
    return { ...report, summary };
}

export async function restoreHiddenIntentionsRepairBackup(chatId) {
    const backup = getHiddenIntentionsRepairBackup(chatId);
    if (!backup) return null;
    await saveRawHiddenIntentions(chatId, backup.intentions);
    if (backup.runtimeState && typeof backup.runtimeState === 'object') {
        await saveHiddenIntentionsState(chatId, {
            ...backup.runtimeState,
            scanInProgress: false,
            backfillInProgress: false,
            backfillPauseRequested: false,
            lastRepairAt: Date.now(),
            lastRepairSource: 'undo',
            lastRepairSummary: `Restored Hidden Intentions repair backup from ${new Date(backup.createdAt || Date.now()).toISOString()}.`
        });
        const restoredState = getHiddenIntentionsState(chatId);
        if (restoredState.backfillPlanSignature && Array.isArray(restoredState.backfillSuccessfulSegments) && restoredState.backfillSuccessfulSegments.length) {
            await saveHiddenIntentionsBackfillCheckpoint(chatId, {
                intentions: backup.intentions,
                runtimeState: restoredState,
                source: 'repair_undo'
            });
        }
    }
    return { restored: backup.intentions.length, createdAt: Number(backup.createdAt || 0), source: String(backup.source || '') };
}

export async function clearHiddenIntentions(chatId) {
    await saveHiddenIntentions(chatId, []);
    await resetHiddenIntentionsState(chatId);
    await setChatData(chatId, 'hiddenIntentionsRepairBackup', null);
    await setChatData(chatId, 'hiddenIntentionsBackfillCheckpoint', null);
}

const DEFAULT_RUNTIME_STATE = Object.freeze({
    dirtyActors: [],
    worldDirty: false,
    reasons: [],
    lastScanMessageCount: 0,
    lastScanElapsedDay: null,
    lastScanAt: 0,
    lastReconcileMessageCount: 0,
    lastReconcileElapsedDay: null,
    lastReconcileAt: 0,
    lastReconcileTrigger: '',
    lastReconcileSummary: '',
    cooldownUntilMessage: 0,
    lastScannedActorIds: [],
    lastScanTrigger: '',
    lastJsonRecovery: '',
    lastValidationSummary: '',
    lastWorkingSetRotations: [],
    recordIdRedirects: {},
    lastError: '',
    scanInProgress: false,
    backfillInProgress: false,
    backfillTotalChunks: 0,
    backfillCompletedChunks: 0,
    backfillTotalBatches: 0,
    backfillCompletedBatches: 0,
    backfillPlanVersion: 0,
    backfillPlanSignature: '',
    backfillSourceMessageCount: 0,
    backfillNarrativeTokenBudget: 0,
    backfillNarrativeCharTarget: 0,
    backfillRequestCharLimit: 0,
    backfillSuccessfulSegments: [],
    backfillPlannedCalls: 0,
    backfillCompletedCalls: 0,
    backfillNextChunk: 0,
    backfillFinalPassCompleted: false,
    backfillMessagesScanned: 0,
    backfillActorsScanned: 0,
    backfillCreated: 0,
    backfillUpdated: 0,
    backfillParked: 0,
    backfillReactivated: 0,
    backfillRejected: 0,
    backfillFailedBatches: 0,
    backfillFailedSegments: [],
    backfillEmptySegments: 0,
    backfillSkippedSegments: 0,
    backfillJsonRecoveries: 0,
    backfillCompactRetries: 0,
    backfillReasoningExhaustions: 0,
    backfillActorSplits: 0,
    backfillNarrativeSplits: 0,
    backfillRollbacks: 0,
    backfillProactiveActorBatches: 0,
    backfillProactiveNarrativeBatches: 0,
    backfillRecoveryIncidents: [],
    backfillPauseRequested: false,
    backfillPausedByUser: false,
    backfillStartedAt: 0,
    backfillFinishedAt: 0,
    backfillSummary: '',
    lastRepairAt: 0,
    lastRepairSource: '',
    lastRepairSummary: ''
});

function normalizeDirtyActor(item = {}) {
    return {
        actorId: String(item.actorId || '').trim(),
        actor: String(item.actor || '').trim(),
        reasons: cleanList(item.reasons, 8),
        markedAtMessage: Number.isInteger(item.markedAtMessage) ? item.markedAtMessage : null,
        markedAtDay: Number.isInteger(item.markedAtDay) ? item.markedAtDay : null
    };
}

export function getHiddenIntentionsState(chatId) {
    const raw = getChatData(chatId, 'hiddenIntentionsState') || {};
    const state = {
        ...clone(DEFAULT_RUNTIME_STATE),
        ...raw,
        dirtyActors: Array.isArray(raw.dirtyActors) ? raw.dirtyActors.map(normalizeDirtyActor).filter(x => x.actorId || x.actor) : [],
        reasons: cleanList(raw.reasons, 12),
        lastScannedActorIds: cleanList(raw.lastScannedActorIds, 20),
        lastWorkingSetRotations: Array.isArray(raw.lastWorkingSetRotations) ? raw.lastWorkingSetRotations.slice(-20) : [],
        recordIdRedirects: raw.recordIdRedirects && typeof raw.recordIdRedirects === 'object' && !Array.isArray(raw.recordIdRedirects)
            ? Object.fromEntries(Object.entries(raw.recordIdRedirects).slice(-200).map(([key, value]) => [String(key || '').toLowerCase(), String(value || '')]).filter(([key, value]) => key && value))
            : {},
        backfillFailedSegments: Array.isArray(raw.backfillFailedSegments) ? raw.backfillFailedSegments.slice(-30) : [],
        backfillSuccessfulSegments: Array.isArray(raw.backfillSuccessfulSegments) ? raw.backfillSuccessfulSegments.filter(Number.isInteger).slice(-500) : [],
        backfillRecoveryIncidents: Array.isArray(raw.backfillRecoveryIncidents) ? raw.backfillRecoveryIncidents.slice(-20) : [],
        backfillFinalPassCompleted: raw.backfillFinalPassCompleted === true,
        backfillPauseRequested: raw.backfillPauseRequested === true,
        backfillPausedByUser: raw.backfillPausedByUser === true,
        worldDirty: raw.worldDirty === true,
        scanInProgress: raw.scanInProgress === true,
        backfillInProgress: raw.backfillInProgress === true
    };
    // v1.3.55 compatibility: older states only remembered the most recent HI
    // operation. If that operation was a reconciliation, promote it into the
    // dedicated reconciliation fields so the Notebook status display is useful
    // immediately after upgrade without forcing another LLM call.
    if (!Number.isInteger(raw.lastReconcileMessageCount) && String(raw.lastScanTrigger || '').startsWith('reconcile:')) {
        state.lastReconcileMessageCount = Number.isInteger(raw.lastScanMessageCount) ? raw.lastScanMessageCount : 0;
        state.lastReconcileElapsedDay = Number.isInteger(raw.lastScanElapsedDay) ? raw.lastScanElapsedDay : null;
        state.lastReconcileAt = Math.max(0, Number(raw.lastScanAt) || 0);
        state.lastReconcileTrigger = String(raw.lastScanTrigger || '').replace(/^reconcile:/, '');
        state.lastReconcileSummary = String(raw.lastValidationSummary || '').trim();
    }
    return state;
}

export async function saveHiddenIntentionsState(chatId, state) {
    const normalized = {
        ...getHiddenIntentionsState(chatId),
        ...clone(state || {})
    };
    normalized.dirtyActors = Array.isArray(normalized.dirtyActors)
        ? normalized.dirtyActors.map(normalizeDirtyActor).filter(x => x.actorId || x.actor)
        : [];
    normalized.reasons = cleanList(normalized.reasons, 12);
    normalized.lastScannedActorIds = cleanList(normalized.lastScannedActorIds, 20);
    normalized.lastWorkingSetRotations = Array.isArray(normalized.lastWorkingSetRotations) ? normalized.lastWorkingSetRotations.slice(-20) : [];
    normalized.recordIdRedirects = normalized.recordIdRedirects && typeof normalized.recordIdRedirects === 'object' && !Array.isArray(normalized.recordIdRedirects)
        ? Object.fromEntries(Object.entries(normalized.recordIdRedirects).slice(-200).map(([key, value]) => [String(key || '').toLowerCase(), String(value || '')]).filter(([key, value]) => key && value))
        : {};
    normalized.backfillSuccessfulSegments = Array.isArray(normalized.backfillSuccessfulSegments)
        ? Array.from(new Set(normalized.backfillSuccessfulSegments.filter(Number.isInteger).map(Number))).filter(value => value >= 0).sort((a, b) => a - b).slice(-500)
        : [];
    normalized.backfillFailedSegments = Array.isArray(normalized.backfillFailedSegments)
        ? normalized.backfillFailedSegments.slice(-30).map(item => ({
            segmentIndex: Number.isInteger(item?.segmentIndex) ? item.segmentIndex : -1,
            startMessage: Number.isInteger(item?.startMessage) ? item.startMessage : null,
            endMessage: Number.isInteger(item?.endMessage) ? item.endMessage : null,
            code: String(item?.code || '').slice(0, 120),
            error: String(item?.error || '').slice(0, 500),
            responsePreview: String(item?.responsePreview || '').slice(0, 1200),
            requestChars: Math.max(0, Math.floor(Number(item?.requestChars) || 0)),
            reasoningChars: Math.max(0, Math.floor(Number(item?.reasoningChars) || 0)),
            finishReason: String(item?.finishReason || '').slice(0, 120),
            failedAt: Math.max(0, Number(item?.failedAt) || 0)
        }))
        : [];
    normalized.backfillRecoveryIncidents = Array.isArray(normalized.backfillRecoveryIncidents)
        ? normalized.backfillRecoveryIncidents.slice(-20).map(item => ({
            at: Math.max(0, Number(item?.at) || 0),
            phase: String(item?.phase || '').slice(0, 80),
            range: String(item?.range || '').slice(0, 80),
            actors: Array.isArray(item?.actors) ? item.actors.map(value => String(value || '').slice(0, 100)).filter(Boolean).slice(0, 8) : [],
            reason: String(item?.reason || '').slice(0, 120),
            finishReason: String(item?.finishReason || '').slice(0, 120),
            visibleChars: Math.max(0, Math.floor(Number(item?.visibleChars) || 0)),
            reasoningChars: Math.max(0, Math.floor(Number(item?.reasoningChars) || 0)),
            requestChars: Math.max(0, Math.floor(Number(item?.requestChars) || 0))
        }))
        : [];
    normalized.backfillPauseRequested = normalized.backfillPauseRequested === true;
    normalized.backfillPausedByUser = normalized.backfillPausedByUser === true;
    normalized.lastReconcileMessageCount = Math.max(0, Math.floor(Number(normalized.lastReconcileMessageCount) || 0));
    normalized.lastReconcileElapsedDay = Number.isInteger(normalized.lastReconcileElapsedDay) ? normalized.lastReconcileElapsedDay : null;
    normalized.lastReconcileAt = Math.max(0, Number(normalized.lastReconcileAt) || 0);
    normalized.lastReconcileTrigger = String(normalized.lastReconcileTrigger || '').slice(0, 120);
    normalized.lastReconcileSummary = String(normalized.lastReconcileSummary || '').slice(0, 1200);
    normalized.lastRepairAt = Math.max(0, Number(normalized.lastRepairAt) || 0);
    normalized.lastRepairSource = String(normalized.lastRepairSource || '').slice(0, 80);
    normalized.lastRepairSummary = String(normalized.lastRepairSummary || '').slice(0, 1200);
    normalized.backfillPlanSignature = String(normalized.backfillPlanSignature || '').slice(0, 4000);
    normalized.backfillFinalPassCompleted = normalized.backfillFinalPassCompleted === true;
    normalized.worldDirty = normalized.worldDirty === true;
    normalized.scanInProgress = normalized.scanInProgress === true;
    normalized.backfillInProgress = normalized.backfillInProgress === true;
    for (const key of [
        'backfillTotalChunks', 'backfillCompletedChunks', 'backfillTotalBatches',
        'backfillCompletedBatches', 'backfillPlanVersion', 'backfillSourceMessageCount',
        'backfillNarrativeTokenBudget', 'backfillNarrativeCharTarget', 'backfillRequestCharLimit', 'backfillPlannedCalls', 'backfillCompletedCalls', 'backfillNextChunk',
        'backfillMessagesScanned', 'backfillActorsScanned', 'backfillEmptySegments', 'backfillSkippedSegments',
        'backfillJsonRecoveries', 'backfillCompactRetries', 'backfillReasoningExhaustions', 'backfillActorSplits', 'backfillNarrativeSplits', 'backfillRollbacks', 'backfillProactiveActorBatches', 'backfillProactiveNarrativeBatches',
        'backfillCreated', 'backfillUpdated', 'backfillParked', 'backfillReactivated', 'backfillRejected', 'backfillFailedBatches',
        'backfillStartedAt', 'backfillFinishedAt'
    ]) normalized[key] = Math.max(0, Number.isFinite(Number(normalized[key])) ? Math.floor(Number(normalized[key])) : 0);
    normalized.backfillSummary = String(normalized.backfillSummary || '').trim();
    await setChatData(chatId, 'hiddenIntentionsState', normalized);
    return normalized;
}

export async function resetHiddenIntentionsState(chatId) {
    await setChatData(chatId, 'hiddenIntentionsState', clone(DEFAULT_RUNTIME_STATE));
    await setChatData(chatId, 'hiddenIntentionsBackfillCheckpoint', null);
}
