/* eslint-disable */
// =============================================================================
// NWST Hidden Intentions Injection — llm/hiddenIntentionsInjection.js
// =============================================================================
// Pure-JS scene relevance selector for executable private NPC agency.
//
// Important boundaries:
//   • Only action-driving intentions are eligible (active plans, commitments,
//     and READY contingencies).
//   • An active Event with sourceIntentionIds containing the intention ID owns
//     the prompt representation. The Hidden Intention is suppressed until that
//     event is concluded/deleted; deleting it reopens this path automatically.
//   • This is narrator guidance, never shared character knowledge.
//   • Selection is scene-specific and uses current presence + plan anchors;
//     there is no LLM call on the prompt path.
// =============================================================================

import { getChatId } from '../utils.js';
import { isEnabled, isPaused, getHiddenIntentionsConfig } from '../settings.js';
import { getHiddenIntentions } from '../data/hiddenIntentions.js';
import { getTrackedEvents } from '../data/events.js';
import { getSceneContext } from './secretsSidecar.js';
import { dlog } from '../lib/debug.js';

const CLOSED_OR_SILENT = new Set(['parked', 'resolved', 'abandoned', 'stale', 'pending_review', 'blocked']);
const GENERIC = new Set([
    'about','after','again','along','around','before','being','between','could','current','during','every','first','follow','following','from','genuinely','have','into','maintain','make','more','next','only','other','plan','private','recent','remain','same','scene','should','still','than','that','their','them','then','there','these','they','this','through','toward','until','upon','very','want','with','without','would',
    'actor','action','objective','strategy','commitment','intention','approach','timing','person','someone','something','situation','contact','presence','routine','monitoring','continue','keep','hold','select','wait','look','find','check','read','talk','ask'
]);

function normalize(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function nameTokens(registry) {
    const out = new Set();
    try {
        for (const alias of registry?.allAliasStrings?.() || []) {
            for (const token of normalize(alias).split(' ')) if (token.length >= 3) out.add(token);
        }
    } catch (_) { /* degraded but functional */ }
    return out;
}

function meaningfulTerms(value, registry) {
    const names = nameTokens(registry);
    const terms = [];
    const seen = new Set();
    for (const token of normalize(value).split(' ')) {
        if (token.length < 4 || GENERIC.has(token) || names.has(token) || seen.has(token)) continue;
        seen.add(token);
        terms.push(token);
    }
    return terms.slice(0, 24);
}

function signalMatch(value, sceneText, registry) {
    const terms = meaningfulTerms(value, registry);
    if (!terms.length) return { hits: 0, strong: false, terms: [] };
    const sceneWords = new Set(normalize(sceneText).split(' ').filter(Boolean));
    const hits = terms.filter(term => sceneWords.has(term));
    const strong = hits.length >= 2;
    return { hits: hits.length, strong, terms: hits.slice(0, 4) };
}


function requiresSceneAnchor(record, registry) {
    const triggers = Array.isArray(record?.triggerConditions) ? record.triggerConditions.filter(Boolean) : [];
    if (triggers.length) return true;
    const next = normalize(record?.nextAction || '');
    if (!next) return false;
    // Explicit conditional/setting language means co-presence alone is not
    // sufficient. The current scene must also intersect the stated condition
    // or next-action wording. This is what keeps a plan such as "ask her during the scheduled meetup"
    // out of an unrelated kitchen conversation.
    const conditional = /\b(?:when|once|during|after|before|upon|while|if|until)\b/.test(next);
    return conditional && meaningfulTerms(record.nextAction, registry).length > 0;
}

function recordActorId(record, registry) {
    return registry?.resolve?.(record.actor) || registry?.resolve?.(record.actorId) || record.actorId || '';
}

function recordTargets(record, registry, actorId) {
    const text = [record.objective, record.strategy, record.nextAction, ...(record.triggerConditions || []), ...(record.constraints || [])].join('\n');
    const ids = new Set();
    try {
        for (const id of registry?.scanProse?.(text) || []) {
            if (id && id !== actorId && !registry?.isGroup?.(id)) ids.add(id);
        }
    } catch (_) { /* no-op */ }
    return ids;
}

export function eventSemanticallyRepresentsIntention(record, event, registry = null) {
    if (!record || !event || !registry) return false;
    const actorId = recordActorId(record, registry);
    const targets = recordTargets(record, registry, actorId);
    const participantIds = new Set((event.participants || []).map(name => registry.resolve?.(name) || normalize(name)).filter(Boolean));
    if (actorId && !participantIds.has(actorId)) return false;
    if (targets.size && !Array.from(targets).some(target => participantIds.has(target))) return false;
    const eventText = `${event.title || ''} ${event.description || ''}`;
    const objective = signalMatch(record.objective, eventText, registry);
    const strategy = signalMatch(record.strategy, eventText, registry);
    const next = signalMatch(record.nextAction, eventText, registry);
    const combinedHits = objective.hits + strategy.hits + next.hits;
    const distinctiveLegacyHit = [...objective.terms, ...strategy.terms, ...next.terms].some(term => term.length >= 8);
    return objective.strong || strategy.strong || (next.strong && objective.hits > 0)
        || (combinedHits >= 2 && (objective.hits > 0 || strategy.hits > 0))
        || distinctiveLegacyHit;
}

export function hasCorrespondingActiveEvent(record, activeEvents = [], registry = null) {
    const id = String(record?.id || '');
    if (!id) return false;
    const actorId = recordActorId(record, registry);
    const targets = recordTargets(record, registry, actorId);
    const relatedIds = new Set((record.relatedEventIds || []).map(String));
    return (activeEvents || []).some(event => {
        if (!['pending', 'inprogress'].includes(event?.status)) return false;
        if (Array.isArray(event?.sourceIntentionIds) && event.sourceIntentionIds.some(sourceId => String(sourceId) === id)) return true;

        // Legacy fallback for Events created before sourceIntentionIds was
        // consistently populated. A mere relatedEventIds link is NOT enough:
        // the event must include the actor/target and semantically express the
        // plan itself. This prevents a venue/outing Event from suppressing a
        // private conversation plan that is only meant to happen during it.
        if (!relatedIds.has(String(event?.id || '')) || !registry) return false;
        return eventSemanticallyRepresentsIntention(record, event, registry);
    });
}

function eligibleRecord(record) {
    if (!record || CLOSED_OR_SILENT.has(record.status)) return false;
    if (record.type === 'active_plan') return Boolean(String(record.nextAction || '').trim());
    if (record.type === 'commitment') return Boolean(String(record.nextAction || '').trim());
    if (record.type === 'contingency') return record.status === 'ready' && Boolean(String(record.strategy || '').trim());
    return false;
}

export function scoreHiddenIntentionForScene(record, sceneContext, activeEvents = []) {
    const registry = sceneContext?.registry;
    if (!eligibleRecord(record)) return { eligible: false, score: 0, reasons: ['not action-driving/current'] };
    if (hasCorrespondingActiveEvent(record, activeEvents, registry)) return { eligible: false, score: 0, reasons: ['represented by active event'], eventSuppressed: true };

    const present = new Set(sceneContext?.charactersPresent || []);
    const actorId = recordActorId(record, registry);
    const targets = recordTargets(record, registry, actorId);
    const actorPresent = actorId && present.has(actorId);
    const targetPresent = Array.from(targets).some(id => present.has(id));
    const semanticText = [
        sceneContext?.currentText || sceneContext?.recentText,
        ...(sceneContext?.sidecarPresenceFresh === false ? [] : [sceneContext?.sceneSummary, ...(sceneContext?.activePressures || [])])
    ].filter(Boolean).join('\n');

    const trigger = signalMatch((record.triggerConditions || []).join(' '), semanticText, registry);
    const next = signalMatch(record.nextAction, semanticText, registry);
    const strategy = signalMatch(record.strategy, semanticText, registry);
    const objective = signalMatch(record.objective, semanticText, registry);

    let score = 0;
    const reasons = [];
    if (actorPresent) { score += 45; reasons.push('actor present'); }
    if (targetPresent) { score += 30; reasons.push('plan target present'); }
    if (actorPresent && targetPresent) { score += 25; reasons.push('actor and target co-present'); }
    if (trigger.hits) { score += trigger.strong ? 80 : 45; reasons.push(`trigger match: ${trigger.terms.join(', ')}`); }
    if (next.hits) { score += next.strong ? 65 : 35; reasons.push(`next-action match: ${next.terms.join(', ')}`); }
    if (strategy.hits) { score += strategy.strong ? 30 : 15; reasons.push(`strategy match: ${strategy.terms.join(', ')}`); }
    if (objective.hits) { score += objective.strong ? 20 : 10; reasons.push(`objective match: ${objective.terms.join(', ')}`); }
    const trustedSceneType = sceneContext?.sidecarPresenceFresh === false ? 'unknown' : sceneContext?.sceneType;
    if (actorPresent && ['npc_cutaway', 'surveillance', 'faction'].includes(trustedSceneType)) {
        score += 20;
        reasons.push(`${trustedSceneType} scene`);
    }
    if (record.status === 'ready') { score += 10; reasons.push('ready status'); }
    if (record.commitment === 'high') score += 5;

    // Fail closed on coincidence. Explicitly conditional/setting-specific
    // plans require a scene-anchor match; actor+target co-presence by itself
    // must not fire a karaoke plan in an unrelated apartment conversation.
    const sceneAnchorRequired = requiresSceneAnchor(record, registry);
    const sceneAnchorMatched = Boolean(trigger.hits || next.hits);
    const actionSignal = trigger.strong || next.strong;
    const grounded = sceneAnchorRequired
        ? (actorPresent && sceneAnchorMatched && actionSignal)
        : (actorPresent && (actionSignal || (targetPresent && (trigger.hits + next.hits >= 2))));

    if (sceneAnchorRequired && !sceneAnchorMatched) reasons.push('waiting for stated scene/trigger');
    return { eligible: grounded && score >= 80, score, reasons, actorId, actorPresent, targetPresent, sceneAnchorRequired, sceneAnchorMatched };
}

export function selectHiddenIntentionsForInjection(chatId = null, options = {}) {
    const id = chatId || getChatId();
    if (!id || !isEnabled() || isPaused()) return [];
    const cfg = getHiddenIntentionsConfig();
    if (cfg.enabled === false || cfg.injectPlans === false) return [];

    const sceneContext = options.sceneContext || getSceneContext(id);
    const activeEvents = options.activeEvents || getTrackedEvents(id);
    const records = options.records || getHiddenIntentions(id);
    const max = Math.max(1, Math.min(5, Number(cfg.maxInjectedPlans || 3)));

    const scored = [];
    for (const record of records) {
        const result = scoreHiddenIntentionForScene(record, sceneContext, activeEvents);
        if (!result.eligible) continue;
        scored.push({ record, ...result });
    }
    scored.sort((a, b) => b.score - a.score || Number(b.record.lastReinforcedMessage || 0) - Number(a.record.lastReinforcedMessage || 0));

    const selected = [];
    const actorCounts = new Map();
    for (const item of scored) {
        const key = item.actorId || item.record.actorId || item.record.actor;
        if ((actorCounts.get(key) || 0) >= 2) continue;
        actorCounts.set(key, (actorCounts.get(key) || 0) + 1);
        selected.push(item);
        if (selected.length >= max) break;
    }
    return selected;
}

function relevanceText(reasons = []) {
    const useful = reasons.filter(reason => !reason.endsWith('status')).slice(0, 3);
    return useful.length ? useful.join('; ') : 'the current scene intersects this private plan';
}

export function buildHiddenIntentionsInjection(chatId = null) {
    const selected = selectHiddenIntentionsForInjection(chatId);
    if (!selected.length) return '';

    let block = '[NPC PRIVATE AGENCY — Narrator Guidance Only]\n';
    block += 'Use only as private behavioral guidance for the named NPC. Do not reveal the plan to other characters, narrate it as public fact, or force the action if the scene naturally prevents it. Let the NPC act, hesitate, defer, or pursue the next step when the opportunity is genuinely present.\n';
    for (const { record, reasons } of selected) {
        block += `\nActor: ${record.actor || record.actorId}\n`;
        block += `Private objective: ${record.objective}\n`;
        if (record.strategy) block += `Method: ${record.strategy}\n`;
        if (record.nextAction) block += `Nearest next action: ${record.nextAction}\n`;
        if (record.triggerConditions?.length) block += `Trigger: ${record.triggerConditions.join('; ')}\n`;
        if (record.constraints?.length) block += `Constraints: ${record.constraints.join('; ')}\n`;
        block += `Current relevance: ${relevanceText(reasons)}.\n`;
    }
    return block.trim();
}

export function debugHiddenIntentionsInjection(chatId = null) {
    try {
        return selectHiddenIntentionsForInjection(chatId).map(item => ({
            id: item.record.id,
            actor: item.record.actor,
            objective: item.record.objective,
            score: item.score,
            reasons: item.reasons
        }));
    } catch (error) {
        dlog('[NWST HiddenIntentionsInjection] Debug selection failed:', error);
        return [];
    }
}
