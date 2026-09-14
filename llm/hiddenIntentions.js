/* eslint-disable */
// =============================================================================
// NWST Hidden Intentions — llm/hiddenIntentions.js
// =============================================================================
// Maintains compact, evidence-grounded private NPC objectives, plans, commitments,
// priorities, contingencies, and emerging interests. Records are Notebook-only and are NEVER directly injected into
// the RP prompt. They may inform generated NPC events and community synthesis.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { getHiddenIntentionsConfig } from '../settings.js';
import { resolveProfile, generateWithProfileDetailed } from './connections.js';
import { LLM_TOKEN_BUDGETS } from './tokenBudgets.js';
import {
    getHiddenIntentions, saveHiddenIntentions,
    getHiddenIntentionsState, saveHiddenIntentionsState,
    getHiddenIntentionsRepairBackup,
    getHiddenIntentionsBackfillCheckpoint, saveHiddenIntentionsBackfillCheckpoint,
    normalizeHiddenIntention, repairHiddenIntentions,
    INTENTION_TYPES, INTENTION_DOMAINS, INTENTION_STATUSES, INTENTION_PROGRESS
} from '../data/hiddenIntentions.js';
import { getWorldState, getSettingContext } from '../data/worldState.js';
import { getTrackedEvents } from '../data/events.js';
import { getNotebook } from '../data/notebook.js';
import { getAllCommunities } from '../data/communities.js';
import { buildAliasRegistry, toCanonicalId } from '../data/aliasRegistry.js';
import { getUserCharacterIdentity } from '../data/secretsMeta.js';
import { dlog } from '../lib/debug.js';

const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };
let cadenceTimer = null;
let stateQueue = Promise.resolve();
let activeBackfillChatId = null;
const activeHiddenIntentionsOperationChatIds = new Set();

const COMMON_SYSTEM_PROMPT = `You maintain HIDDEN INTENTIONS for important NPCs in an ongoing roleplay.

This is NOT an inner-monologue generator and NOT a second narrator. Hidden does not mean malicious, deceptive, romantic, or protagonist-focused. Preserve only compact, durable private agency that may matter beyond the immediate scene.

STRUCTURAL TYPES:
- objective: a durable outcome the NPC wants; broad and not necessarily actionable yet
- active_plan: a concrete course of action currently being pursued; requires a strategy describing the broad method and a nearest nextAction
- commitment: a promise, duty, scheduled obligation, or decision the NPC feels bound to carry out; requires a nextAction
- ongoing_priority: something the NPC wants to maintain, protect, support, or prevent from deteriorating; no single completion point required
- contingency: a conditional response reserved for a stated trigger; requires triggerConditions and a strategy describing the intended response method
- emerging_interest: a growing curiosity, concern, attachment, ambition, or idea that has not matured into a plan

DOMAINS:
- relational
- care_support
- duty_responsibility
- personal
- investigative
- logistical
- social_factional
- protective
- opportunistic
- adversarial
- escape_avoidance

BALANCE RULES:
- Consider ordinary work, responsibilities, friendship, care, curiosity, preparation, routines, personal ambition, self-preservation, community maintenance, logistics, affection, and conflict when genuinely supported.
- Do not make every NPC scheme, threaten, contain, manipulate, or focus on the user character.
- Constructive, mundane, professional, protective, and self-directed intentions are valid and often more realistic.
- Most actors should have a small mixed set, not several variations of the same strategic objective.
- Before adding a record, decide whether it is a separate durable agency thread or merely a subtask, obstacle, evidence update, or immediate step within an existing record. Keep one record when the objectives would succeed, fail, or resolve together; split them only when they can progress independently.
- Compare protagonist-facing motives against the actor's work, personal, event-linked, and community obligations. Involvement with the user/PC is not automatically more durable or important.
- Each NPC has a five-record CURRENT WORKING SET, not a first-come lifetime quota. Parked history does not consume a slot.
- When the working set is full, you may still propose a genuinely more current, actionable, or important addition. NWST will compare it against the current five and park the weakest eligible generated record when replacement is justified.
- Do not propose weak additions merely to churn the working set. Manual, locked, and pending-review records cannot be displaced automatically.

TYPE MATURITY TEST:
- emerging_interest is pre-action curiosity, concern, attachment, or ambition: the actor has not yet selected a settled method and concrete next step.
- active_plan means the actor has selected a broad method plus a concrete next step, or is already executing that course of action.
- ongoing_priority maintains or protects a condition without one bounded completion point; do not use it for a finite plan with a clear method and next step.
- commitment requires an explicit promise, duty, scheduled obligation, or firm decision—not merely likely concern or general support.

KNOWLEDGE AND AUTHORITY:
- Treat every actor packet independently and use ONLY the facts in that actor's packet.
- Hidden Intentions describe what an NPC wants, plans, attempts, revises, or abandons.
- They do NOT declare objective world outcomes. A proposed/generated event is not proof that an action happened.
- Narrative lines are evidence of what occurred, not automatic knowledge for the actor. Do not grant knowledge of private dialogue, cutaways, or facts the actor did not witness.
- Community analysis, events, Notebook pressures, and world conditions are structural context. They constrain opportunity and plausibility but are not automatically conscious knowledge.
- A pending actor-linked event may support a commitment, plan, priority, or contingency only when its description actually assigns the actor a role, obligation, opportunity, or pressure. Treat it as upcoming context, never proof that the action already happened.
- Use community state primarily for role obligations, faction pressure, loyalties, and constraints. Do not copy a community summary into an NPC's private psychology.
- Use world conditions primarily to adjust plausibility, timing, strategy, and constraints rather than fabricating unrelated motives.
- When a supplied event or community materially grounds a record, include its exact ID in relatedEventIds or relatedCommunityIds. Omit decorative or merely adjacent links.
- Setting Context constrains plausibility; it is not a demand to reference every setting element.
- Existing motives may conflict. Do not flatten characters into perfectly rational agents.
- Further-future plans must be less specific than immediate plans.
- Return no change when evidence is insufficient.

CROSS-SOURCE SYNTHESIS AND LOW-CONFIDENCE EVIDENCE:
- Use an evidence hierarchy instead of treating every supplied source as equally authoritative.
- PRIMARY actor-specific evidence includes the actor's own choice, repeated behavior, internal narration, preparation, refusal, concealment, grievance, attempt, or an actor-linked obligation explicitly assigned to them.
- CORROBORATING evidence includes credible second-hand testimony, actor-specific community observations, Notebook pressures, relevant events, and world conditions that explain or reinforce an already-visible orientation.
- When Low-confidence additions are permitted, a tentative emerging_interest may combine evidence across narrative segments and structured NWST sources only when at least one PRIMARY source shows actor-specific behavior, reaction, repeated grievance, concealment, or private disposition, and another compatible signal corroborates it.
- A community, role, world condition, event possibility, or another character's speculation cannot independently create a specific plan, commitment, retaliation, investigation, protection, or intervention.
- Prefer tentative objectives describing curiosity, concern, grievance, evaluation, attachment, or orientation. Do not invent a strategy or nextAction until the actor has actually selected or begun a method.
- Cross-source synthesis should connect weak but compatible signals; it must not convert atmospheric context into certainty or manufacture drama merely because the confidence threshold is Low.

DECISION FINALITY AND CONSERVATIVE PERSISTENCE:
- Make one classification pass. Once you select update, resolution, addition, or omission, do not reopen the decision.
- Do not narrate deliberation, compare multiple drafts, or explain why you selected a field. Spend the response budget on the JSON object.
- When evidence for durable future agency is ambiguous, omit the record. A missed weak inference is safer than invented persistence.
- Prefer updating an existing record over creating a parallel record when both threads would succeed, fail, or resolve together.
- A completed one-time warning, delivery, conversation, assignment, or role-implied responsibility does not establish an ongoing private plan by itself.
- Do not infer future monitoring, retaliation, investigation, protection, or intervention unless the actor explicitly decides, prepares, attempts, or commits to it.

LIFECYCLE:
- status must be one of: latent, active, ready, blocked, revised, parked, resolved, abandoned, stale
- progressStage must be one of: unattempted, prepared, attempted, progressed, blocked, failed, fulfilled
- update operation must be one of: update, progress, block, revise, park, reactivate, resolve, abandon, stale
- confidence and commitment must each be one of: low, medium, high
- status and progressStage answer different questions: status says whether the record remains current; progressStage says what happened to the objective.
- fulfilled means the actor achieved the objective. failed means an attempt ended without achieving it. A closed record may correctly be status resolved with progressStage failed.
- blocked is temporary prevention while the actor still intends to continue. abandoned means the actor chose to stop. stale means the record lost current relevance without a decisive outcome.
- Never mark a failed plan fulfilled merely because the scene or record ended.
- After a major outcome, keep every active record current: revise any objective, strategy, or nextAction that has already happened, become impossible, or no longer describes the actor's actual course.
- Closed records (resolved, abandoned, or stale) must omit nextAction. Do not leave a completed instruction attached to a closed record.
- Spell out organizational divisions when an acronym could be mistaken for a medical or personal condition.

OUTPUT RULES — STRICT:
- Return exactly one JSON object and nothing else.
- Use double-quoted JSON strings only.
- Do not use comments, trailing commas, markdown fences, pipe notation, or prose outside the JSON object.
- In ordinary generation/reconciliation, every requested actor must appear once with both arrays. Chronological backfill is sparse: omit actors with no change and return {"actors": []} when a segment contains no durable Hidden Intention work.
- Omit optional properties rather than writing placeholders or empty strings. Strategy is NOT optional for active_plan or contingency records.
- strategy describes HOW the actor intends to pursue or respond; nextAction describes the nearest concrete step. Do not repeat the same sentence in both fields.
- basis, triggerConditions, constraints, relatedEventIds, and relatedCommunityIds MUST be JSON arrays of strings, even when there is only one item.
- evidenceMessageStart and evidenceMessageEnd MUST be integer message indices such as 29, never labels such as "M29".
- actorId must identify the supplied actor. For updates, copy either the exact record id or its short ref (for example R1) from the actor packet. Do not invent an update target ID.

VALID MINIMAL OUTPUT:
{
  "actors": [
    {
      "actorId": "exact_actor_id_from_packet",
      "updates": [],
      "additions": []
    }
  ]
}`;

const GENERATE_SYSTEM_PROMPT = `${COMMON_SYSTEM_PROMPT}

MODE: GENERATE NEW HIDDEN INTENTIONS
- Your sole task is to create missing, durable records. Do NOT update, progress, resolve, stale, or otherwise mutate existing records.
- Every actor's updates array MUST be empty.
- Examine existing records only to avoid duplication and identify meaningful gaps.
- Prefer a balanced mix of relevant structural types and domains. Do not pad the output to cover every type.
- Most actors need zero to two additions. Return none when the evidence does not support a durable record.
- New records always begin at progressStage "unattempted". Historical actions belong in basis/evidence, not fake lifecycle progress.
- An objective requires objective and basis.
- An active_plan requires objective, strategy, nextAction, and basis.
- A commitment requires objective, nextAction, and basis.
- An ongoing_priority requires objective and basis.
- A contingency requires objective, at least one triggerCondition, strategy, and basis. nextAction is optional until the trigger is active or the response is being prepared.
- An emerging_interest requires objective and basis; it should not pretend a concrete plan already exists.

ADDITION FIELDS:
- Required for every addition: type, domain, objective, basis
- Type-specific required: strategy for active_plan and contingency; nextAction for active_plan and commitment; triggerConditions for contingency
- Optional: constraints, status, progressStage, confidence, commitment, relatedEventIds, relatedCommunityIds, evidenceMessageStart, evidenceMessageEnd, evidenceSummary

VALID GENERATION SHAPE:
{
  "actors": [
    {
      "actorId": "exact_actor_id_from_packet",
      "updates": [],
      "additions": [
        {
          "type": "active_plan",
          "domain": "investigative",
          "objective": "Identify who is leaking the shipment schedule",
          "strategy": "Quietly compare access records and question staff separately without revealing that a breach is suspected",
          "nextAction": "Review the last three shipment-access logs",
          "basis": ["The actor privately decided to investigate the repeated leaks"],
          "constraints": ["Do not alert the suspected insider"],
          "confidence": "high",
          "commitment": "high",
          "evidenceMessageStart": 29,
          "evidenceMessageEnd": 31,
          "evidenceSummary": "The actor chose a covert internal investigation and named the records as the first step."
        }
      ]
    }
  ]
}`;

const RECONCILE_SYSTEM_PROMPT = `${COMMON_SYSTEM_PROMPT}

MODE: RECONCILE EXISTING HIDDEN INTENTIONS
- Your sole task is to maintain records that already exist in the actor packet.
- Every actor's additions array MUST be empty. Do NOT create new records in this mode.
- Review each existing record for preparation, attempts, progress, blocking, failure, revision, fulfillment, abandonment, or staleness.
- A plain wording update still requires evidence or grounding.
- Any lifecycle operation beyond a plain update must include a concise progressNote explaining what changed.
- You may change type or domain when an existing record genuinely matures or is better classified, such as emerging_interest becoming active_plan.
- SCHEMA ENRICHMENT: when an existing active_plan or contingency has a blank strategy, add a grounded strategy even when no lifecycle change occurred. This is a valid plain update. Strategy must state the broad method, not merely repeat the objective or nextAction. Use the existing record's grounding, constraints, triggers, and supplied narrative; do not invent a method unsupported by them.
- Park an unlocked generated record when it remains psychologically valid but no longer belongs in the actor's current top-five working set. Reactivate a parked record when new evidence makes it current again.

UPDATE FIELDS:
- Required: id, operation
- Optional: type, domain, status, progressStage, progressNote, objective, strategy, nextAction, triggerConditions, constraints, basis, confidence, commitment, relatedEventIds, relatedCommunityIds, evidenceMessageStart, evidenceMessageEnd, evidenceSummary

VALID RECONCILIATION SHAPE:
{
  "actors": [
    {
      "actorId": "exact_actor_id_from_packet",
      "updates": [
        {
          "id": "exact_intention_id_from_packet",
          "operation": "progress",
          "progressStage": "attempted",
          "progressNote": "The actor carried out the first inspection but did not identify the intruder.",
          "basis": ["The narrative depicts the inspection taking place"],
          "evidenceMessageStart": 45,
          "evidenceMessageEnd": 48,
          "evidenceSummary": "The workroom was inspected and a discrepancy was found."
        }
      ],
      "additions": []
    }
  ]
}

VALID STRATEGY ENRICHMENT SHAPE:
{
  "actors": [
    {
      "actorId": "exact_actor_id_from_packet",
      "updates": [
        {
          "id": "exact_intention_id_or_ref_from_packet",
          "operation": "update",
          "strategy": "Use indirect records checks and low-visibility surveillance while avoiding contact with the target's professional network",
          "basis": ["The existing record and supplied narrative establish a covert intelligence-gathering method"]
        }
      ],
      "additions": []
    }
  ]
}`;

const BACKFILL_SYSTEM_PROMPT = `${COMMON_SYSTEM_PROMPT}

MODE: SPARSE CHRONOLOGICAL HIDDEN INTENTIONS BACKFILL
- This is a one-time migration for a chat that began before Hidden Intentions existed.
- Process only the supplied chronological segment. Existing records are state carried forward from earlier segments.
- A segment does NOT need to produce a Hidden Intention. Most ordinary exchanges should produce no change. Return {"actors": []} when nothing durable is established, advanced, revised, blocked, completed, abandoned, or made stale.
- Output ONLY actors with actual changes. Do not echo unchanged actors with empty arrays.
- Reconcile existing records when this segment shows progress, blocking, revision, fulfillment, abandonment, staleness, or renewed relevance.
- Add a record only when the segment establishes durable private agency likely to influence behavior beyond the immediate exchange.
- Do NOT promote routine shift duties, one-off purchases, casual outing attendance, momentary reactions, ordinary politeness, or completed micro-tasks unless they carry unresolved stakes or continuing behavioral pressure.
- Lifecycle progress, blocking, revision, completion, abandonment, and staleness must be established by this segment.
- When the automatic-add threshold permits Low confidence, a new emerging_interest may combine this segment with the actor's supplied PRIOR CANDIDATE EVIDENCE from earlier chronological segments. The current segment must add compatible corroboration, clarification, or renewed pressure; never create a record solely because older candidate evidence exists.
- For that narrow low-confidence case, evidenceMessageStart/evidenceMessageEnd may span the supplied prior candidate messages and this segment. Do not use unsupplied history.
- No current end-of-chat Notebook, event, Secret, community, weather, or whereabouts data is supplied during chronological extraction, because later state must not leak backward into earlier segments.
- Keep the user/PC and collective/group entities excluded.
- A newly discovered historical record may begin prepared, attempted, progressed, blocked, failed, or fulfilled when this SAME segment directly proves that stage. Any non-unattempted stage requires a concise progressNote.
- Avoid duplicates by comparing against existing records in the actor state roster.
- Parked records are preserved background history. Use operation "reactivate" when this segment makes one current again. Use operation "park" only when the record remains psychologically valid but no longer belongs in the actor's current top-five working set.
- A full working set does not forbid a stronger addition. Return it only when it clearly outranks an older, less current record; NWST performs deterministic rotation.
- Every lifecycle operation beyond a plain update requires a concise progressNote.
- For an actor you include, provide both updates and additions arrays; either may be empty.
- New additions must not include an id or ref. R1/R2 references identify existing records only.
- If an actor packet has no records, its updates array MUST be empty. Use additions for any genuinely new durable agency.
- Never assign a temporary ID to an addition and then reference that addition from updates in the same response.
- active_plan additions require strategy and nextAction. commitment additions require nextAction. contingency additions require strategy and triggerConditions. When an objective sentence itself states the immediate executable action, repeat a concise version in nextAction rather than omitting it.
- When an existing active_plan or contingency has a blank strategy and this segment reveals the actor's method, enrich that record with a plain update rather than creating a duplicate.
- Do not convert a handler, lieutenant, coworker, relative, or other standing role into a new ongoing priority unless this segment establishes a specific continuing choice or obligation beyond the completed scene action.
`;

const BACKFILL_FINAL_SYSTEM_PROMPT = `${COMMON_SYSTEM_PROMPT}

MODE: FINAL BACKFILL CONSOLIDATION
- This is the single end-state cleanup after chronological extraction.
- Reconcile EXISTING records only. Every additions array must be empty.
- Use the supplied current end-state summary and recent narrative to close, revise, park, reactivate, or progress records left behind by earlier segments.
- Resolve completed or definitively ended plans, but preserve the outcome: use fulfilled only when the objective succeeded and failed when it ended unsuccessfully. Fulfill triggered contingencies only when their intended response actually succeeded. Stale obsolete intentions and merge lifecycle meaning into the surviving current working set.
- Park or stale one-off errands, purchases, casual outings, routine shift duties, and completed micro-tasks that do not carry meaningful unresolved pressure into the current story.
- Do not invent new psychology from structured state.
- Enrich a blank strategy on an existing active_plan or contingency only when the supplied end-state or recent narrative clearly establishes the actor's method.
- Output ONLY actors with actual updates. An actor with no existing records must be omitted entirely. Return {"actors": []} when no cleanup is needed.
- A concise progressNote grounded in the supplied current end-state or recent narrative is sufficient when a separate basis array is omitted.
`;

const COMPACT_RECOVERY_BASE_PROMPT = `You are completing a failed HIDDEN INTENTIONS structured-data request.

COMPACT RECOVERY MODE:
- Return the required JSON object immediately. Output JSON only.
- Do not explain, deliberate, reconsider, compare alternatives, or draft conceptually.
- Make one classification pass and keep the first grounded decision.
- When uncertain whether durable agency exists, omit it.
- Prefer an update to an existing record over a near-duplicate addition.
- Do not infer continuing plans from a completed warning, delivery, conversation, assignment, or role alone.
- Use exact supplied actorId values and exact existing record ids/refs for updates.
- Every included actor must contain both "updates" and "additions" arrays.
- New additions must not include an id or ref.
- type is one of: objective, active_plan, commitment, ongoing_priority, contingency, emerging_interest.
- domain is one of: relational, care_support, duty_responsibility, personal, investigative, logistical, social_factional, protective, opportunistic, adversarial, escape_avoidance.
- status is one of: latent, active, ready, blocked, revised, parked, resolved, abandoned, stale.
- progressStage is one of: unattempted, prepared, attempted, progressed, blocked, failed, fulfilled.
- update operation is one of: update, progress, block, revise, park, reactivate, resolve, abandon, stale.
- active_plan requires strategy and nextAction; commitment requires nextAction; contingency requires strategy and triggerConditions.
- basis, triggerConditions, constraints, relatedEventIds, and relatedCommunityIds are arrays of strings.
- evidenceMessageStart and evidenceMessageEnd are integer message indices.
- If the supplied prompt explicitly enables Low-confidence cross-source synthesis, permit only tentative emerging_interest additions supported by at least one primary actor-specific signal plus compatible corroboration; do not invent strategy or nextAction.
- Return {"actors": []} when no grounded change exists.`;

function compactRecoverySystemPrompt(mode) {
    if (mode === 'generate') {
        return `${COMPACT_RECOVERY_BASE_PROMPT}\n- Generate missing durable records only. Every updates array must be empty.`;
    }
    if (mode === 'final') {
        return `${COMPACT_RECOVERY_BASE_PROMPT}\n- Reconcile existing records only. Every additions array must be empty.`;
    }
    if (mode === 'backfill') {
        return `${COMPACT_RECOVERY_BASE_PROMPT}\n- Process only the supplied chronological segment. Output only actors with actual changes.`;
    }
    return `${COMPACT_RECOVERY_BASE_PROMPT}\n- Reconcile existing records only. Every additions array must be empty.`;
}


function systemPromptForMode(mode) {
    if (mode === 'generate') return GENERATE_SYSTEM_PROMPT;
    if (mode === 'backfill') return BACKFILL_SYSTEM_PROMPT;
    return RECONCILE_SYSTEM_PROMPT;
}

function currentMessageCount() {
    try { return SillyTavern.getContext().chat?.length || 0; } catch (_) { return 0; }
}

function currentElapsedDay(chatId) {
    const day = getWorldState(chatId)?.currentDay;
    return Number.isInteger(day?.elapsedStoryDays) ? day.elapsedStoryDays : 0;
}

function getVisibleChatMessages() {
    try {
        const chat = SillyTavern.getContext().chat || [];
        return chat.map((msg, index) => ({ ...msg, _nwstIndex: index })).filter(msg => {
            if (msg.extra?.hidden || msg.is_hidden === true) return false;
            if (msg.extra?.display === 'none') return false;
            return true;
        });
    } catch (_) { return []; }
}

function narrativeSpeakerLabel(msg) {
    return msg?.is_user ? 'USER/PC' : 'NARRATION';
}

function isPlaceholderActorName(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    const canonical = toCanonicalId(text);
    if (/\b(unnamed|unknown|unspecified|various|multiple|miscellaneous|others?|anonymous|unidentified)\b/i.test(text)) return true;
    if (/^(sillytavern system|system|narrator|assistant|scenario|world narrator|game master|gm|friends? of friends?)$/.test(canonical)) return true;
    if (/\b(rpg|roleplay|scenario|simulator|alternate universe|au)\b/.test(canonical)) return true;
    if (/^(board members?|staff|servants?|employees?|guards?|villagers?|officials?|syndicates?|group)$/.test(canonical)) return true;
    // Hidden Intentions are individual working memory. Operational collectives
    // belong in Communities/world state, not as pseudo-psychological NPCs.
    if (/\b(team|committee|network|circle|operatives?|personnel|members?|associates?|followers?|crowd|management|leadership|department|division|unit|crew|gang|faction|organization|organisation)\b/.test(canonical)) return true;
    return /^(someone|everyone|anyone|nobody|people|they|them|friends?)$/.test(canonical);
}

function normalizeActor(chatId, name, registry = null) {
    const resolver = registry || buildAliasRegistry(chatId);
    const displayInput = String(name || '').trim().replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (isPlaceholderActorName(displayInput)) return null;
    const actorId = resolver.resolve(displayInput) || toCanonicalId(displayInput);
    const display = resolver.getDisplay(actorId) || displayInput || actorId;
    if (!actorId || resolver.isGroup(actorId) || resolver.isUserPc(actorId) || isPlaceholderActorName(display)) return null;
    return { actorId, actor: display };
}

function isPcActor(chatId, actorId, actor, registry = null) {
    const resolver = registry || buildAliasRegistry(chatId);
    const resolvedId = resolver.resolve(actor) || actorId || toCanonicalId(actor);
    if (resolvedId && resolver.isUserPc(resolvedId)) return true;

    // Keep a second safety path independent of the alias resolver. This means
    // an auto-alias blacklist, incomplete manual alias setup, or an older chat
    // with blank Secrets metadata cannot accidentally make the PC eligible.
    const rawNames = [];
    const pc = getUserCharacterIdentity(chatId);
    rawNames.push(pc.name, ...(pc.aliases || []));
    const userPcSecrets = (getNotebook(chatId).secrets || []).filter(secret => secret?.type === 'user_pc');
    if (userPcSecrets.length) {
        const counts = new Map();
        for (const secret of userPcSecrets) {
            const seenInSecret = new Set();
            for (const name of secret.whoKnows || []) {
                const canonical = toCanonicalId(String(name || ''));
                if (canonical) seenInSecret.add(canonical);
            }
            for (const canonical of seenInSecret) counts.set(canonical, (counts.get(canonical) || 0) + 1);
        }
        const shared = Array.from(counts.entries())
            .filter(([, count]) => count === userPcSecrets.length)
            .map(([canonical]) => canonical);
        if (shared.length === 1) rawNames.push(shared[0]);
    }
    try {
        const ctx = SillyTavern.getContext();
        rawNames.push(ctx?.name1, ctx?.user_name, ctx?.userName, ctx?.persona?.name);
        for (const msg of ctx?.chat || []) if (msg?.is_user) rawNames.push(msg?.name);
    } catch (_) { /* Optional outside ST runtime. */ }

    const ids = new Set();
    for (const name of rawNames) {
        const canonical = toCanonicalId(String(name || ''));
        if (!canonical || /^(user|you|me)$/.test(canonical)) continue;
        ids.add(canonical);
        const resolved = resolver.resolve(name);
        if (resolved) ids.add(resolved);
    }
    const actorCanonical = toCanonicalId(actor);
    return ids.has(resolvedId) || ids.has(actorId) || ids.has(actorCanonical);
}

/**
 * Remove protagonist-owned records and runtime queue entries. This is both a
 * migration for early Hidden Intentions builds and a hard safety boundary for
 * future scans. User/PC identity is inferred from configured metadata, ST's
 * active user speaker, and User/PC secrets in the Notebook alias registry.
 */
export async function purgeUserCharacterIntentions(chatId) {
    if (!chatId) return 0;
    const registry = buildAliasRegistry(chatId);
    const current = getHiddenIntentions(chatId);
    const kept = current.filter(item => !isPcActor(chatId, item.actorId, item.actor, registry));
    const removed = current.length - kept.length;
    // Persist normalized records too, so legacy generated entries with invalid
    // lifecycle combinations (for example progressed + blank progressNote) are
    // repaired even when no protagonist record needed removal.
    if (current.length || removed > 0) await saveHiddenIntentions(chatId, kept);

    const state = getHiddenIntentionsState(chatId);
    const dirty = (state.dirtyActors || []).filter(item => !isPcActor(chatId, item.actorId, item.actor, registry));
    const scanned = (state.lastScannedActorIds || []).filter(actorId => !isPcActor(chatId, actorId, registry.getDisplay(actorId), registry));
    if (dirty.length !== (state.dirtyActors || []).length || scanned.length !== (state.lastScannedActorIds || []).length) {
        await saveHiddenIntentionsState(chatId, { ...state, dirtyActors: dirty, lastScannedActorIds: scanned });
    }
    return removed;
}

async function mutateState(chatId, mutator) {
    const run = async () => {
        const state = getHiddenIntentionsState(chatId);
        const next = await mutator(state) || state;
        return saveHiddenIntentionsState(chatId, next);
    };
    stateQueue = stateQueue.then(run, run);
    return stateQueue;
}

export async function markHiddenIntentionsDirty(chatId, actors = [], reason = 'Relevant state changed.', options = {}) {
    if (!chatId) return;
    if (!(Array.isArray(actors) && actors.length) && options.worldDirty !== true) return;
    const registry = buildAliasRegistry(chatId);
    const msgCount = currentMessageCount();
    const day = currentElapsedDay(chatId);
    await mutateState(chatId, state => {
        const byId = new Map((state.dirtyActors || []).map(item => [item.actorId || toCanonicalId(item.actor), item]));
        for (const raw of actors || []) {
            const name = typeof raw === 'string' ? raw : (raw?.actor || raw?.name || raw?.display || '');
            const normalized = normalizeActor(chatId, name, registry);
            if (!normalized || isPcActor(chatId, normalized.actorId, normalized.actor, registry)) continue;
            const existing = byId.get(normalized.actorId) || {
                ...normalized, reasons: [], markedAtMessage: msgCount, markedAtDay: day
            };
            existing.actor = normalized.actor || existing.actor;
            existing.reasons = Array.from(new Set([...(existing.reasons || []), String(reason || '').trim()].filter(Boolean))).slice(-8);
            existing.markedAtMessage = msgCount;
            existing.markedAtDay = day;
            byId.set(normalized.actorId, existing);
        }
        state.dirtyActors = Array.from(byId.values());
        if (options.worldDirty) state.worldDirty = true;
        state.reasons = Array.from(new Set([...(state.reasons || []), String(reason || '').trim()].filter(Boolean))).slice(-12);
        return state;
    });
}

export async function markLatestMessageForHiddenIntentions(chatId) {
    if (!chatId || getHiddenIntentionsConfig().enabled === false) return;
    const messages = getVisibleChatMessages();
    const msg = messages[messages.length - 1];
    if (!msg) return;
    const registry = buildAliasRegistry(chatId);
    const found = new Map();
    for (const actorId of registry.scanProse(msg.mes || '')) {
        if (registry.isGroup(actorId) || registry.isUserPc(actorId)) continue;
        found.set(actorId, { actorId, actor: registry.getDisplay(actorId) });
    }
    if (found.size) {
        await markHiddenIntentionsDirty(chatId, Array.from(found.values()), 'Recent narrative may affect private objectives or plans.');
    }
}

export async function markHiddenIntentionsFromScan(chatId, recentMessages, scanResult = {}, worldCommunityResult = {}) {
    const actors = [];
    const registry = buildAliasRegistry(chatId);
    const addKnownMentions = text => {
        for (const actorId of registry.scanProse(String(text || ''))) {
            if (!registry.isGroup(actorId) && !registry.isUserPc(actorId)) actors.push(registry.getDisplay(actorId));
        }
    };
    for (const msg of recentMessages || []) {
        addKnownMentions(msg?.mes);
    }
    const nb = scanResult?.notebookUpdates || scanResult?.notebook || {};
    for (const section of [nb.core || {}, nb.mystery || {}]) {
        for (const value of Object.values(section)) {
            if (Array.isArray(value)) value.forEach(addKnownMentions);
        }
    }
    for (const event of scanResult?.detectedNPCEvents || []) {
        if (Array.isArray(event?.participants)) actors.push(...event.participants);
    }
    for (const update of worldCommunityResult?.communityUpdates || []) {
        if (typeof update?.members === 'string') actors.push(...update.members.split(',').map(x => x.trim()));
    }
    const worldDirty = Boolean(
        Object.values(worldCommunityResult?.conditionUpdates || {}).some(payload => payload?.update === true)
        || (worldCommunityResult?.communityUpdates || []).some(update => update?.update !== false)
    );
    await markHiddenIntentionsDirty(chatId, actors, 'NWST structured state changed.', { worldDirty });
}

export function queueHiddenIntentionsCadenceCheck({ currentCount = null, isScannerBusy = null } = {}) {
    const expectedChatId = getChatId();
    if (cadenceTimer) clearTimeout(cadenceTimer);
    cadenceTimer = setTimeout(async () => {
        cadenceTimer = null;
        try {
            if (!expectedChatId || getChatId() !== expectedChatId) return;
            if (typeof isScannerBusy === 'function' && isScannerBusy()) return;
            await maybeRunHiddenIntentionsCadence(currentCount);
        } catch (e) {
            console.warn('[NWST HiddenIntentions] Cadence check failed:', e);
        }
    }, 500);
}

export async function maybeRunHiddenIntentionsCadence(currentCount = null) {
    const cfg = getHiddenIntentionsConfig();
    if (!cfg.enabled) return false;
    const chatId = getChatId();
    if (!chatId) return false;
    const count = Number.isInteger(currentCount) ? currentCount : currentMessageCount();
    const state = getHiddenIntentionsState(chatId);
    if (state.scanInProgress) return false;
    if (count < cfg.minimumMessages) return false;
    if (count < (state.cooldownUntilMessage || 0)) return false;
    if (count - (state.lastScanMessageCount || 0) < cfg.cadence) return false;
    const ownerIds = new Set(getHiddenIntentions(chatId).filter(trackableRecord).map(item => item.actorId));
    const hasRelevantDirtyActor = (state.dirtyActors || []).some(item => ownerIds.has(item.actorId));
    if (!hasRelevantDirtyActor && !state.worldDirty) return false;
    return runHiddenIntentionsReconcile({ trigger: 'cadence', expectedChatId: chatId });
}

function actorMentionedInText(actor, registry, text) {
    if (!text) return false;
    const mentioned = registry.scanProse(text);
    return mentioned.includes(actor.actorId);
}

function clipNarrativeText(value, maxChars = 2000) {
    const text = String(value || '');
    if (text.length <= maxChars) return text;
    const half = Math.floor((maxChars - 35) / 2);
    return `${text.slice(0, half)}
…[middle clipped for token control]…
${text.slice(-half)}`;
}

function actorMessagesFromWindow(actor, registry, windowMessages, maxRows = 12) {
    const slice = Array.isArray(windowMessages) ? windowMessages : [];
    const selected = new Set();
    for (let i = 0; i < slice.length; i++) {
        const msg = slice[i];
        if (actorMentionedInText(actor, registry, msg.mes || '')) {
            selected.add(i);
            if (i > 0) selected.add(i - 1);
            if (i + 1 < slice.length) selected.add(i + 1);
        }
    }
    const rows = Array.from(selected).sort((a, b) => a - b).map(i => slice[i]);
    return rows.slice(-Math.max(1, maxRows));
}

function recentActorMessages(actor, registry, scanRange, fullHistory = false) {
    const all = getVisibleChatMessages();
    const slice = fullHistory ? all : all.slice(-scanRange);
    return actorMessagesFromWindow(actor, registry, slice, 8);
}

function priorBackfillCandidateMessages(actor, registry, beforeMessageIndex, maxRows = 4) {
    if (!Number.isInteger(beforeMessageIndex) || beforeMessageIndex <= 0) return [];
    const earlier = getVisibleChatMessages().filter(msg => Number.isInteger(msg._nwstIndex) && msg._nwstIndex < beforeMessageIndex);
    if (!earlier.length) return [];
    // Keep this deliberately small. It is cross-segment candidate memory, not a
    // second full-history transcript. The current segment must still provide
    // corroboration before a Low-confidence emerging interest may be created.
    return actorMessagesFromWindow(actor, registry, earlier, Math.max(1, maxRows)).slice(-Math.max(1, maxRows));
}

const BACKFILL_PLAN_VERSION = 5;
const BACKFILL_NARRATIVE_CHAR_TARGET = 36000;
const BACKFILL_REQUEST_CHAR_LIMIT = 50000;
const BACKFILL_NARRATIVE_RETRY_DEPTH = 2;
const BACKFILL_MAX_ACTORS_PER_REQUEST = 4;
const BACKFILL_PROACTIVE_NARRATIVE_CHAR_TARGET = 24000;
const BACKFILL_MAX_CALLS_PER_SEGMENT = 12;

function compactBackfillMessageText(msg) {
    const sender = narrativeSpeakerLabel(msg);
    const body = String(msg?.mes || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return `[M${msg?._nwstIndex ?? '?'}|${sender}] ${body}`;
}

function messageBackfillText(msg) {
    return compactBackfillMessageText(msg);
}

function chunkVisibleMessagesForBackfill(messages, targetChars = BACKFILL_NARRATIVE_CHAR_TARGET) {
    const charsPerChunk = Math.max(18000, Math.min(BACKFILL_NARRATIVE_CHAR_TARGET, Number(targetChars) || BACKFILL_NARRATIVE_CHAR_TARGET));
    const chunks = [];
    let current = [];
    let chars = 0;
    for (const msg of messages || []) {
        const size = Math.max(1, messageBackfillText(msg).length + 1);
        if (current.length && chars + size > charsPerChunk) {
            chunks.push(current);
            current = [];
            chars = 0;
        }
        current.push(msg);
        chars += size;
    }
    if (current.length) chunks.push(current);
    if (chunks.length > 1 && chunks[chunks.length - 1].length <= 2) {
        const tail = chunks.pop();
        chunks[chunks.length - 1].push(...tail);
    }
    return chunks;
}

function splitBackfillChunkBalanced(chunk) {
    if (!Array.isArray(chunk) || chunk.length < 2) return [chunk || []];
    const total = chunk.reduce((sum, msg) => sum + messageBackfillText(msg).length + 1, 0);
    const target = total / 2;
    let running = 0;
    let splitAt = 1;
    for (let i = 0; i < chunk.length - 1; i++) {
        running += messageBackfillText(chunk[i]).length + 1;
        splitAt = i + 1;
        if (running >= target) break;
    }
    return [chunk.slice(0, splitAt), chunk.slice(splitAt)].filter(part => part.length);
}

function backfillRequestChars(systemPrompt, userPrompt) {
    return String(systemPrompt || '').length + String(userPrompt || '').length;
}

function backfillPlanSignature(messages, chunks) {
    const ranges = (chunks || []).map(chunk => {
        const first = chunk[0]?._nwstIndex ?? -1;
        const last = chunk[chunk.length - 1]?._nwstIndex ?? -1;
        return `${first}-${last}`;
    }).join('|');
    return `v${BACKFILL_PLAN_VERSION}:${messages?.length || 0}:${BACKFILL_NARRATIVE_CHAR_TARGET}:${BACKFILL_REQUEST_CHAR_LIMIT}:${ranges}`;
}


function parseBackfillPlanSignature(signature) {
    const match = /^v(\d+):(\d+):(\d+):(\d+):(.*)$/.exec(String(signature || ''));
    if (!match) return null;
    const ranges = String(match[5] || '').split('|').filter(Boolean).map(value => {
        const rangeMatch = /^(\d+)-(\d+)$/.exec(value);
        return rangeMatch ? { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) } : null;
    });
    if (ranges.some(item => !item)) return null;
    return {
        version: Number(match[1]),
        sourceCount: Number(match[2]),
        charTarget: Number(match[3]),
        requestLimit: Number(match[4]),
        ranges
    };
}

function checkpointCompatibility(state, visibleMessages, messageChunks, currentSignature) {
    if (!state || typeof state !== 'object') return { compatible: false, exact: false, appendCompatible: false, successful: [] };
    const successful = Array.isArray(state.backfillSuccessfulSegments)
        ? Array.from(new Set(state.backfillSuccessfulSegments.filter(Number.isInteger))).filter(index => index >= 0)
        : [];
    const exact = state.backfillPlanSignature === currentSignature
        && Number(state.backfillSourceMessageCount || 0) === visibleMessages.length
        && Number(state.backfillPlanVersion || 0) === BACKFILL_PLAN_VERSION;
    if (exact) return { compatible: true, exact: true, appendCompatible: false, successful };

    const stored = parseBackfillPlanSignature(state.backfillPlanSignature);
    if (!stored) return { compatible: false, exact: false, appendCompatible: false, successful: [] };
    if (stored.version !== BACKFILL_PLAN_VERSION
        || stored.charTarget !== BACKFILL_NARRATIVE_CHAR_TARGET
        || stored.requestLimit !== BACKFILL_REQUEST_CHAR_LIMIT
        || stored.sourceCount <= 0
        || stored.sourceCount > visibleMessages.length) {
        return { compatible: false, exact: false, appendCompatible: false, successful: [] };
    }

    // Appending messages—or changing prompt-only speaker labels—must not
    // invalidate already-paid chronological work. The stored plan remains the
    // canonical segmentation for its original message prefix. Verify that all
    // old range boundaries still exist in the visible chat; the runner will
    // reconstruct those exact chunks and append only genuinely newer messages.
    const visibleIndexes = new Set((visibleMessages || []).map(msg => Number(msg?._nwstIndex)).filter(Number.isInteger));
    const boundariesPresent = stored.ranges.every(range => visibleIndexes.has(range.start) && visibleIndexes.has(range.end));
    if (!boundariesPresent) return { compatible: false, exact: false, appendCompatible: false, successful: [] };
    const reusable = successful.filter(index => Boolean(stored.ranges[index]));
    if (!reusable.length && successful.length) return { compatible: false, exact: false, appendCompatible: false, successful: [] };
    return {
        compatible: true,
        exact: false,
        appendCompatible: true,
        successful: reusable,
        priorSourceCount: stored.sourceCount,
        storedPlan: stored
    };
}

function rebuildChunksFromCheckpoint(visibleMessages, state) {
    const stored = parseBackfillPlanSignature(state?.backfillPlanSignature);
    if (!stored?.ranges?.length) return null;
    const byIndex = new Map((visibleMessages || []).map(msg => [Number(msg?._nwstIndex), msg]));
    const chunks = [];
    for (const range of stored.ranges) {
        const chunk = (visibleMessages || []).filter(msg => {
            const index = Number(msg?._nwstIndex);
            return Number.isInteger(index) && index >= range.start && index <= range.end;
        });
        if (!chunk.length || !byIndex.has(range.start) || !byIndex.has(range.end)) return null;
        chunks.push(chunk);
    }
    const lastStoredIndex = stored.ranges[stored.ranges.length - 1].end;
    const appended = (visibleMessages || []).filter(msg => Number(msg?._nwstIndex) > lastStoredIndex);
    if (appended.length) chunks.push(...chunkVisibleMessagesForBackfill(appended, BACKFILL_NARRATIVE_CHAR_TARGET));
    return chunks;
}

function chooseBestBackfillCheckpoint(chatId, liveState, visibleMessages, messageChunks, currentSignature) {
    const candidates = [{ source: 'live', state: liveState, intentions: null }];
    const durable = getHiddenIntentionsBackfillCheckpoint(chatId);
    if (durable?.runtimeState) candidates.push({ source: 'durable_checkpoint', state: durable.runtimeState, intentions: durable.intentions });
    const repair = getHiddenIntentionsRepairBackup(chatId);
    if (repair?.runtimeState) candidates.push({ source: 'repair_backup', state: repair.runtimeState, intentions: null });

    let best = null;
    for (const candidate of candidates) {
        const compatibility = checkpointCompatibility(candidate.state, visibleMessages, messageChunks, currentSignature);
        if (!compatibility.compatible) continue;
        const score = compatibility.successful.length * 100000
            + Number(candidate.state.backfillMessagesScanned || 0) * 10
            + Number(candidate.state.backfillCompletedCalls || 0);
        if (!best || score > best.score || (score === best.score && candidate.source === 'live')) {
            best = { ...candidate, compatibility, score };
        }
    }
    return best;
}

function collectBackfillActorsFromWindow(chatId, messages, registry) {
    const scores = new Map();
    const direct = new Set();
    const existingOwners = new Set(getHiddenIntentions(chatId).filter(trackableRecord).map(item => {
        return registry.resolve(item.actor) || registry.resolve(item.actorId) || item.actorId;
    }).filter(Boolean));
    const add = (name, score, directSpeaker = false) => {
        const normalized = normalizeActor(chatId, name, registry);
        if (!normalized || isPcActor(chatId, normalized.actorId, normalized.actor, registry)) return;
        const prior = scores.get(normalized.actorId) || { ...normalized, score: 0, mentions: 0 };
        prior.score += score;
        prior.mentions += 1;
        scores.set(normalized.actorId, prior);
        if (directSpeaker) direct.add(normalized.actorId);
    };
    for (const msg of messages || []) {
        for (const actorId of registry.scanProse(msg?.mes || '')) {
            if (registry.isGroup(actorId) || registry.isUserPc(actorId)) continue;
            add(registry.getDisplay(actorId), 30, false);
        }
    }
    // Include individually named one-off NPCs too: a single compact scene can
    // establish durable agency. This no longer creates extra calls because the
    // entire roster shares one segment request. The sparse prompt—not actor
    // omission—is responsible for returning zero when a mention is incidental.
    const all = Array.from(scores.values()).filter(actor => {
        return direct.has(actor.actorId) || actor.mentions >= 1 || existingOwners.has(actor.actorId);
    }).sort((a, b) => b.score - a.score || a.actor.localeCompare(b.actor));

    // One shared segment can safely carry a much broader roster than the old
    // four-actor sub-batches. Keep an upper guard against pathological name
    // extraction while never dropping direct speakers.
    const directActors = all.filter(actor => direct.has(actor.actorId));
    const secondary = all.filter(actor => !direct.has(actor.actorId));
    const maxRoster = 24;
    return [...directActors, ...secondary.slice(0, Math.max(0, maxRoster - directActors.length))];
}


function communityMembers(com) {
    return String(com?.members || '').split(',').map(x => x.trim()).filter(Boolean);
}

function actorInCommunity(actorId, com, registry) {
    return communityMembers(com).some(name => (registry.resolve(name) || toCanonicalId(name)) === actorId);
}

function secretKnownByActor(secret, actorId, registry) {
    return (secret?.whoKnows || []).some(name => (registry.resolve(name) || toCanonicalId(name)) === actorId);
}

function activeRecord(record) {
    return !['parked', 'resolved', 'abandoned', 'stale'].includes(record.status);
}

function trackableRecord(record) {
    return !['resolved', 'abandoned', 'stale'].includes(record.status);
}

function collectCandidateActors(chatId, trigger, state, cfg, mode = 'reconcile', broad = false) {
    const registry = buildAliasRegistry(chatId);
    const existing = getHiddenIntentions(chatId);
    const existingByActor = new Map();
    for (const record of existing) {
        if (!trackableRecord(record)) continue;
        if (!existingByActor.has(record.actorId)) existingByActor.set(record.actorId, []);
        existingByActor.get(record.actorId).push(record);
    }
    const scores = new Map();
    const add = (nameOrActor, score, reason = '') => {
        const rawName = typeof nameOrActor === 'string' ? nameOrActor : (nameOrActor?.actor || nameOrActor?.name || '');
        const normalized = normalizeActor(chatId, rawName, registry);
        if (!normalized || isPcActor(chatId, normalized.actorId, normalized.actor, registry)) return;
        if (mode === 'reconcile' && !existingByActor.has(normalized.actorId)) return;
        const prev = scores.get(normalized.actorId) || { ...normalized, score: 0, reasons: [] };
        prev.score += score;
        if (reason) prev.reasons.push(reason);
        scores.set(normalized.actorId, prev);
    };

    for (const dirty of state.dirtyActors || []) add(dirty, 120, 'dirty');
    for (const record of existing) {
        if (!activeRecord(record)) continue;
        const needsStrategy = strategyRequiredForType(record.type) && !String(record.strategy || '').trim();
        add(record.actor, mode === 'reconcile' && needsStrategy ? 155 : (mode === 'reconcile' ? 100 : 35), needsStrategy ? 'strategy-enrichment' : 'existing');
    }
    for (const event of getTrackedEvents(chatId)) {
        const weight = event.tier === 'immediate' ? 70 : event.tier === 'week' ? 35 : 15;
        for (const name of event.participants || []) add(name, weight, 'event');
    }
    const messages = getVisibleChatMessages().slice(-Math.min(cfg.scanRange, 40));
    for (const msg of messages) {
        for (const id of registry.scanProse(msg.mes || '')) {
            if (!registry.isGroup(id) && !registry.isUserPc(id)) add(registry.getDisplay(id), 15, 'mentioned');
        }
    }
    if (mode === 'generate' || trigger === 'day_advance' || state.worldDirty || broad) {
        for (const com of getAllCommunities(chatId)) {
            for (const member of communityMembers(com)) add(member, broad ? 20 : 8, 'community');
        }
    }
    if (mode === 'generate' && broad && typeof registry.allEntities === 'function') {
        for (const entity of registry.allEntities()) {
            const kinds = entity.kinds || [];
            if (!kinds.includes('character') || kinds.includes('group') || kinds.includes('user_pc')) continue;
            add(entity.display || entity.canonical, 12, 'registry');
        }
        const notebook = getNotebook(chatId);
        for (const secret of notebook.secrets || []) {
            for (const name of [...(secret.whoKnows || []), ...(secret.whoDoesNotKnow || [])]) add(name, 5, 'secret-holder');
        }
    }

    if (mode === 'generate') {
        // Generation should spend its limited actor slots looking for missing
        // agency, not repeatedly re-selecting only actors who already own a
        // healthy ledger. Existing owners remain eligible for genuinely separate
        // threads, but unrepresented named NPCs receive a gap-detection boost.
        for (const candidate of scores.values()) {
            if (!existingByActor.has(candidate.actorId)) {
                candidate.score += broad ? 45 : 24;
                candidate.reasons.push('missing-ledger-gap');
            }
        }
    }

    const limit = broad && mode === 'generate'
        ? Math.min(10, Math.max(cfg.maxActorsPerScan, cfg.maxActorsPerScan * 2))
        : cfg.maxActorsPerScan;
    return Array.from(scores.values())
        .sort((a, b) => b.score - a.score || a.actor.localeCompare(b.actor))
        .slice(0, limit);
}

function formatList(label, list) {
    if (!list?.length) return '';
    return `${label}:\n${list.map(item => `- ${item}`).join('\n')}\n`;
}

function buildActorPacket(chatId, actor, registry, cfg, trigger = 'cadence', options = {}) {
    const notebook = getNotebook(chatId);
    const world = getWorldState(chatId);
    const intentions = getHiddenIntentions(chatId).filter(item => recordMatchesActor(registry, item, actor));
    const communities = getAllCommunities(chatId).filter(com => actorInCommunity(actor.actorId, com, registry) || intentions.some(item => item.relatedCommunityIds?.includes(com.id))).slice(0, 4);
    const eventsAll = getTrackedEvents(chatId);
    const actorEvents = eventsAll.filter(event => (event.participants || []).some(name => (registry.resolve(name) || toCanonicalId(name)) === actor.actorId));
    const worldEvents = eventsAll.filter(event => !event.isNPC && (event.tier === 'immediate' || event.tier === 'week')).slice(0, 5);
    const events = [...actorEvents, ...worldEvents.filter(event => !actorEvents.some(a => a.id === event.id))].slice(0, 8);
    const knownSecrets = (notebook.secrets || []).filter(secret => secretKnownByActor(secret, actor.actorId, registry)).slice(0, 8);
    const fullHistory = trigger === 'batch_scan';
    const hasExplicitWindow = Array.isArray(options.messageWindow);
    const messages = hasExplicitWindow
        ? actorMessagesFromWindow(actor, registry, options.messageWindow, options.maxNarrativeRows || 12)
        : recentActorMessages(actor, registry, cfg.scanRange, fullHistory);

    const unresolvedIntentions = intentions.filter(activeRecord);
    const parkedIntentions = intentions.filter(item => item.status === 'parked');
    const remainingSlots = Math.max(0, cfg.maxActivePerActor - unresolvedIntentions.length);

    let text = `=== ACTOR PACKET: ${actor.actor} ===\n`;
    text += `actorId: ${actor.actorId}\n`;
    text += `Treat this actor independently. Facts omitted from this packet are not available to them.\n`;
    text += `CURRENT WORKING SET: ${unresolvedIntentions.length}/${cfg.maxActivePerActor} used; ${remainingSlots} open slot${remainingSlots === 1 ? '' : 's'}; ${parkedIntentions.length} parked historical record${parkedIntentions.length === 1 ? '' : 's'}.\n`;
    if (remainingSlots === 0) text += `The working set is full. You may still propose a clearly stronger, more current addition; NWST will rotate out the weakest eligible generated record. Do not churn the set for marginal alternatives.\n`;
    text += `\n`;

    text += `EXISTING HIDDEN INTENTIONS:\n`;
    if (!intentions.length) text += `(none)\n`;
    for (const item of intentions) {
        text += `- ID ${item.id} | type=${item.type} | domain=${item.domain} | status=${item.status} | progress=${item.progressStage} | confidence=${item.confidence} | commitment=${item.commitment}${item.locked ? ' | LOCKED wording' : ''}\n`;
        text += `  Objective: ${item.objective || '(blank)'}\n`;
        if (item.strategy) text += `  Strategy: ${item.strategy}\n`;
        else if (strategyRequiredForType(item.type)) text += `  Strategy: (MISSING — REQUIRED SCHEMA ENRICHMENT; provide the broad method without duplicating the next action)\n`;
        if (item.nextAction) text += `  Next action: ${item.nextAction}\n`;
        if (item.triggerConditions?.length) text += `  Triggers: ${item.triggerConditions.join('; ')}\n`;
        if (item.constraints?.length) text += `  Constraints: ${item.constraints.join('; ')}\n`;
        if (item.basis?.length) text += `  Grounding: ${item.basis.slice(0, 4).map(value => clipNarrativeText(value, 360)).join('; ')}\n`;
        if (item.progressNote) text += `  Last progress: ${item.progressNote}\n`;
        if (item.status === 'parked') text += `  Parked reason: ${item.parkedReason || 'Lower current relevance than the active working set.'}\n`;
        text += `  Created: story day ${item.createdDay ?? 'unknown'}, message ${item.createdMessage ?? 'unknown'} | Last reinforced: story day ${item.lastReinforcedDay ?? 'unknown'}, message ${item.lastReinforcedMessage ?? 'unknown'} | Last reviewed: story day ${item.lastReviewedDay ?? 'unknown'}, message ${item.lastReviewedMessage ?? 'unknown'}\n`;
    }
    text += '\n';

    const narrativeLabel = options.narrativeLabel || 'RECENT ACTOR-RELEVANT NARRATIVE';
    text += `${narrativeLabel} (authoritative evidence; use it to detect the actor's own decisions/actions and objective outcomes, but do not grant them knowledge of unwitnessed lines):\n`;
    if (!messages.length) text += `(no actor-relevant narrative in the scan window)\n`;
    for (const msg of messages) {
        const sender = narrativeSpeakerLabel(msg);
        text += `[M${msg._nwstIndex}] [${sender}]: ${clipNarrativeText(msg.mes, 2000)}\n`;
    }
    text += '\n';

    text += `ACTOR-ACCESSIBLE SECRET KNOWLEDGE:\n`;
    if (!knownSecrets.length) text += `(none supplied)\n`;
    for (const secret of knownSecrets) text += `- ${secret.title}: ${clipNarrativeText(secret.secret, 1200)}\n`;
    text += '\n';

    text += `RELEVANT COMMUNITIES (structural context, not verbatim conscious knowledge):\n`;
    if (!communities.length) text += `(none)\n`;
    for (const com of communities) {
        text += `- ID ${com.id} | ${com.name} | Members: ${com.members || '(unknown)'}\n  ${clipNarrativeText(com.summary, 1200)}\n`;
    }
    text += '\n';

    text += `RELEVANT ACTIVE EVENTS / OPPORTUNITIES:\n`;
    text += `Actor-linked events may be treated as directly relevant. Global events are structural pressure only; do not assume the actor knows their precise content.\n`;
    if (!events.length) text += `(none)\n`;
    const actorEventIds = new Set(actorEvents.map(event => event.id));
    for (const event of events) {
        const scope = actorEventIds.has(event.id) ? 'ACTOR-LINKED' : 'GLOBAL-STRUCTURAL';
        text += `- ID ${event.id} | ${scope} | [${event.tier}] [${event.status}] ${event.title}: ${clipNarrativeText(event.description, 700)}\n`;
    }
    text += '\n';

    text += `SELECTED NOTEBOOK PRESSURES (structural context, not automatically conscious knowledge):\n`;
    const actorRelevant = values => (values || []).filter(value => {
        const ids = registry.scanProse(String(value || ''));
        return ids.includes(actor.actorId);
    });
    text += formatList('Actor-linked promises, threats, deadlines', actorRelevant(notebook.core?.promiseThreatDeadline));
    text += formatList('Actor-linked off-screen pressures', actorRelevant(notebook.core?.offscreenPressure));
    text += formatList('Actor-linked whereabouts', actorRelevant(notebook.mystery?.characterWhereabouts));
    if (!actorRelevant(notebook.core?.promiseThreatDeadline).length
        && !actorRelevant(notebook.core?.offscreenPressure).length
        && !actorRelevant(notebook.mystery?.characterWhereabouts).length) text += `(none actor-linked)\n`;
    text += '\n';

    return {
        text,
        intentionIds: intentions.map(x => x.id),
        unresolvedCount: unresolvedIntentions.length,
        remainingSlots,
        eventIds: events.map(x => x.id),
        communityIds: communities.map(x => x.id),
        messageIndices: messages.map(msg => msg._nwstIndex).filter(Number.isInteger)
    };
}

function buildPrompt(chatId, actors, cfg, trigger, mode = 'reconcile', options = {}) {
    const operationLabel = mode === 'generate' ? 'GENERATE NEW RECORDS' : mode === 'backfill' ? 'CHRONOLOGICAL BACKFILL' : 'RECONCILE EXISTING RECORDS';
    let prompt = `OPERATION: ${operationLabel}\n`;
    prompt += `SCAN TRIGGER: ${trigger}\n`;
    prompt += `Current message count: ${currentMessageCount()}\n`;
    prompt += `Current elapsed story day: ${currentElapsedDay(chatId)}\n`;
    prompt += `Automatic-add confidence threshold: ${cfg.autoAddConfidence || 'medium'}\n`;
    if ((cfg.autoAddConfidence || 'medium') === 'low') {
        prompt += `LOW-CONFIDENCE SYNTHESIS IS ENABLED: connect actor-specific narrative evidence with compatible Secrets, Communities, Events, Notebook pressures, or World State context when they jointly support a tentative emerging interest. Structured context may corroborate agency but may not create a concrete plan or next action by itself.\n`;
    }
    if (options.backfillChunk) {
        const meta = options.backfillChunk;
        prompt += `BACKFILL CHUNK: ${meta.chunkIndex}/${meta.totalChunks}`;
        if (Number.isInteger(meta.startMessage) && Number.isInteger(meta.endMessage)) prompt += ` | visible messages M${meta.startMessage}–M${meta.endMessage}`;
        prompt += `\nThis is one chronological segment of a full-history migration. Earlier chunks may already have created records. Use existing records to prevent duplicates; do not infer later events not shown in this chunk.\n`;
    }
    prompt += `\n`;
    const settingContext = getSettingContext(chatId);
    if (settingContext) {
        prompt += `=== SETTING CONTEXT (foundational plausibility constraints) ===\n${clipNarrativeText(settingContext, 7000)}\n\n`;
    }
    const world = getWorldState(chatId);
    prompt += `=== SHARED OBJECTIVE WORLD CONSTRAINTS (not automatically conscious knowledge) ===\n`;
    prompt += `Date: ${world.currentDay?.dateDisplay || '(unset)'} | ${world.currentDay?.dateSub || ''}\n`;
    prompt += `Season: ${world.currentDay?.season || '(unset)'}\n`;
    prompt += `Weather: ${clipNarrativeText(world.currentDay?.weatherToday || '(unset)', 1000)}\n`;
    for (const [key, value] of Object.entries(world.conditions || {})) {
        if (value?.enabled && value.content) prompt += `${key}: ${clipNarrativeText(value.content, 1400)}\n`;
    }
    prompt += `\n`;
    const packets = new Map();
    const registry = buildAliasRegistry(chatId);
    for (const actor of actors) {
        const packet = buildActorPacket(chatId, actor, registry, cfg, trigger, options);
        if (mode === 'backfill') packet.implicitGrounding = 'historical_segment';
        else if (mode === 'reconcile') packet.implicitGrounding = 'recent_scan';
        packets.set(actor.actorId, packet);
        prompt += packet.text + '\n';
    }
    if (mode === 'generate') {
        prompt += `Generate only missing, durable records. Keep every updates array empty. Active Plans and Contingencies must include a distinct broad strategy. Favor a grounded balance of constructive, mundane, professional, relational, protective, and conflict-related agency. When Low confidence is enabled, actively look for nonlinear emerging interests supported by at least one actor-specific signal plus compatible corroboration from another supplied source. Keep such records tentative and omit strategy/nextAction unless directly supported. No prose outside JSON.`;
    } else if (mode === 'backfill') {
        prompt += `Process this chronological chunk as migration state. Reconcile records carried from earlier chunks and add newly supported durable records. Both arrays may be used. Active Plans and Contingencies must include a distinct broad strategy; enrich blank required strategies when this chunk reveals the method. Ground historical changes in this chunk's narrative evidence. No prose outside JSON.`;
    } else {
        prompt += `Reconcile only the existing records shown above. Keep every additions array empty. Prioritize grounded enrichment of blank strategies on Active Plans and Contingencies. No prose outside JSON.`;
    }
    return { prompt, packets };
}

function buildCompactBackfillActorState(chatId, actor, registry, cfg, messageIndices = [], { includeStructuredIds = false, priorCandidateMessages = [] } = {}) {
    const intentions = getHiddenIntentions(chatId).filter(item => recordMatchesActor(registry, item, actor));
    const unresolved = intentions.filter(activeRecord);
    const parked = intentions.filter(item => item.status === 'parked');
    const entity = typeof registry.allEntities === 'function'
        ? registry.allEntities().find(item => item.canonical === actor.actorId)
        : null;
    let text = `ACTOR ${actor.actor} | actorId=${actor.actorId} | working=${unresolved.length}/${cfg.maxActivePerActor} | parked=${parked.length}\n`;
    const recordIdMap = {};
    if (entity?.aliases?.length) text += `aliases=${entity.aliases.slice(0, 8).join(', ')}\n`;
    if (intentions.length) {
        text += `records:\n`;
        // Current records matter most. Include only the two most recent parked
        // records so historical storage cannot make later prompts explode.
        const rows = [
            ...intentions.filter(item => item.status !== 'parked'),
            ...parked.slice().sort((a, b) => Number(b.parkedAtMessage || 0) - Number(a.parkedAtMessage || 0)).slice(0, 2)
        ];
        rows.forEach((item, index) => {
            const ref = `R${index + 1}`;
            recordIdMap[ref.toLowerCase()] = item.id;
            recordIdMap[String(item.id || '').toLowerCase()] = item.id;
            text += `- ref=${ref} | id=${item.id} | ${item.type}/${item.domain} | ${item.status}/${item.progressStage} | c=${item.confidence} k=${item.commitment}${item.locked ? ' LOCKED' : ''}\n`;
            text += `  goal=${clipNarrativeText(item.objective, 260)}\n`;
            if (item.strategy) text += `  strategy=${clipNarrativeText(item.strategy, 180)}\n`;
            else if (strategyRequiredForType(item.type)) text += `  strategy=(MISSING — REQUIRED ENRICHMENT)\n`;
            if (item.nextAction) text += `  next=${clipNarrativeText(item.nextAction, 150)}\n`;
            if (item.triggerConditions?.length) text += `  trigger=${clipNarrativeText(item.triggerConditions.join('; '), 150)}\n`;
            if (item.constraints?.length) text += `  constraints=${clipNarrativeText(item.constraints.join('; '), 160)}\n`;
            if (item.basis?.length) text += `  basis=${clipNarrativeText(item.basis.slice(0, 3).join('; '), 240)}\n`;
            if (item.progressNote) text += `  progress=${clipNarrativeText(item.progressNote, 180)}\n`;
            if (item.status === 'parked' && item.parkedReason) text += `  parked=${clipNarrativeText(item.parkedReason, 140)}\n`;
        });
    }
    const priorRows = Array.isArray(priorCandidateMessages) ? priorCandidateMessages : [];
    if (priorRows.length) {
        text += `prior_candidate_evidence (older actor-relevant narrative; corroboration only, not permission to invent persistence):\n`;
        for (const msg of priorRows) {
            text += `  [M${msg._nwstIndex}|${narrativeSpeakerLabel(msg)}] ${clipNarrativeText(msg.mes, 520)}\n`;
        }
        text += `  A Low-confidence emerging interest may use these rows only if the current segment adds compatible corroboration or renewed pressure.\n`;
    }
    const events = includeStructuredIds ? getTrackedEvents(chatId) : [];
    const communities = includeStructuredIds ? getAllCommunities(chatId) : [];
    const allowedMessageIndices = Array.from(new Set([
        ...messageIndices,
        ...priorRows.map(msg => msg._nwstIndex).filter(Number.isInteger)
    ])).sort((a, b) => a - b);
    return {
        text,
        packet: {
            intentionIds: intentions.map(item => item.id),
            recordIdMap,
            unresolvedCount: unresolved.length,
            remainingSlots: Math.max(0, cfg.maxActivePerActor - unresolved.length),
            eventIds: events.map(item => item.id),
            communityIds: communities.map(item => item.id),
            messageIndices: allowedMessageIndices
        }
    };
}

function buildBackfillSegmentPrompt(chatId, actors, chunk, cfg, meta) {
    const registry = buildAliasRegistry(chatId);
    const messageIndices = (chunk || []).map(msg => msg._nwstIndex).filter(Number.isInteger);
    const packets = new Map();
    let prompt = `OPERATION: SPARSE CHRONOLOGICAL BACKFILL\n`;
    prompt += `SEGMENT: ${meta.chunkIndex}/${meta.totalChunks}`;
    if (Number.isInteger(meta.startMessage) && Number.isInteger(meta.endMessage)) prompt += ` | M${meta.startMessage}–M${meta.endMessage}`;
    prompt += `\nAutomatic-add confidence threshold: ${cfg.autoAddConfidence || 'medium'}.\n`;
    if ((cfg.autoAddConfidence || 'medium') === 'low') {
        prompt += `Low-confidence cross-segment synthesis is enabled only for tentative emerging interests with actor-specific prior evidence plus compatible corroboration in this segment.\n`;
    }
    prompt += `This segment may legitimately produce zero Hidden Intention changes. Do not pad the ledger.\n\n`;
    const settingContext = getSettingContext(chatId);
    if (settingContext) prompt += `=== SETTING CONTEXT (plausibility only) ===\n${clipNarrativeText(settingContext, 1800)}\n\n`;
    prompt += `=== ELIGIBLE INDIVIDUAL NPC ROSTER ===\n`;
    prompt += `SillyTavern character-card titles and assistant speaker labels are never actors. Use only the named individuals in this roster and narrative prose.\n`;
    if (!actors.length) prompt += `(none)\n`;
    const segmentStart = Number.isInteger(meta.startMessage)
        ? meta.startMessage
        : (messageIndices.length ? Math.min(...messageIndices) : null);
    for (const actor of actors) {
        const priorCandidateMessages = (cfg.autoAddConfidence || 'medium') === 'low'
            ? priorBackfillCandidateMessages(actor, registry, segmentStart, 4)
            : [];
        const built = buildCompactBackfillActorState(chatId, actor, registry, cfg, messageIndices, { priorCandidateMessages });
        built.packet.implicitGrounding = 'historical_segment';
        packets.set(actor.actorId, built.packet);
        prompt += built.text + `\n`;
    }
    prompt += `=== SHARED CHRONOLOGICAL NARRATIVE ===\n`;
    prompt += `This narrative is supplied once for the whole segment. Decide separately what each NPC witnessed, knew, chose, attempted, or completed.\n`;
    for (const msg of chunk || []) prompt += `${messageBackfillText(msg)}\n`;
    prompt += `\n=== SPARSE OUTPUT REMINDER ===\n`;
    prompt += `Return only actors with real additions or updates. A fully valid result for an ordinary segment is {"actors": []}. If an actor packet has no records, its updates array MUST be empty and new agency belongs in additions. Do not assign temporary IDs to additions or create an addition and then update it in the same response. Active Plans and Contingencies require a distinct broad strategy. Existing records marked MISSING may receive a plain strategy-enrichment update when this segment establishes the method. For Low-confidence emerging interests, prior candidate evidence may corroborate but the current segment must add a compatible signal; do not invent strategy or nextAction. Do not create records for groups, teams, or the user character.`;
    return { prompt, packets };
}

function buildBackfillFinalPrompt(chatId, actors, cfg) {
    const registry = buildAliasRegistry(chatId);
    const recentMessages = getVisibleChatMessages().slice(-12);
    const messageIndices = recentMessages.map(msg => msg._nwstIndex).filter(Number.isInteger);
    const packets = new Map();
    const world = getWorldState(chatId);
    const notebook = getNotebook(chatId);
    let prompt = `OPERATION: FINAL BACKFILL CONSOLIDATION\n`;
    prompt += `This is the current end-of-chat state. Reconcile existing records only; do not add new intentions.\n\n`;
    const settingContext = getSettingContext(chatId);
    if (settingContext) prompt += `=== SETTING CONTEXT ===\n${clipNarrativeText(settingContext, 1200)}\n\n`;
    prompt += `=== CURRENT OBJECTIVE STATE ===\n`;
    prompt += `Date: ${world.currentDay?.dateDisplay || '(unset)'} | ${world.currentDay?.dateSub || ''}\n`;
    prompt += `Season: ${world.currentDay?.season || '(unset)'}\n`;
    for (const [key, value] of Object.entries(world.conditions || {})) {
        if (value?.enabled && value.content) prompt += `${key}: ${clipNarrativeText(value.content, 320)}\n`;
    }
    prompt += `\nActive tracked events:\n`;
    for (const event of getTrackedEvents(chatId).filter(item => !['resolved','missed','cancelled'].includes(item.status)).slice(0, 10)) {
        const participants = Array.isArray(event.participants) && event.participants.length ? event.participants.join(', ') : '(none labeled)';
        prompt += `- ${event.id} | [${event.status}] ${event.title} | participants=${participants}: ${clipNarrativeText(event.description, 220)}\n`;
    }
    const appendNotebook = (label, values, max = 8) => {
        prompt += `\n${label}:\n`;
        const rows = (values || []).slice(-max);
        if (!rows.length) prompt += `(none)\n`;
        for (const row of rows) prompt += `- ${clipNarrativeText(row, 320)}\n`;
    };
    appendNotebook('Current unresolved details', notebook.core?.unresolvedDetail);
    appendNotebook('Current promises, threats, and deadlines', notebook.core?.promiseThreatDeadline);
    appendNotebook('Current off-screen pressures', notebook.core?.offscreenPressure);
    appendNotebook('Current established facts', notebook.mystery?.establishedFacts);
    appendNotebook('Current whereabouts', notebook.mystery?.characterWhereabouts, 8);
    prompt += `\n=== EXISTING RECORDS BY ACTOR ===\n`;
    for (const actor of actors) {
        const built = buildCompactBackfillActorState(chatId, actor, registry, cfg, messageIndices, { includeStructuredIds: true });
        built.packet.implicitGrounding = 'final_consolidation';
        packets.set(actor.actorId, built.packet);
        prompt += built.text + `\n`;
    }
    prompt += `=== RECENT NARRATIVE ===\n`;
    for (const msg of recentMessages) prompt += `${clipNarrativeText(messageBackfillText(msg), 2200)}\n`;
    prompt += `\nReturn only actors whose existing records require lifecycle cleanup. Every additions array must be empty. {"actors": []} is valid.`;
    return { prompt, packets };
}

function extractJsonCandidate(response) {
    if (!response || typeof response !== 'string') return '';
    let text = response.trim().replace(/^\uFEFF/, '');
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    return text.trim();
}

function stripJsonComments(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (lineComment) {
            if (ch === '\n' || ch === '\r') {
                lineComment = false;
                out += ch;
            }
            continue;
        }
        if (blockComment) {
            if (ch === '*' && next === '/') {
                blockComment = false;
                i++;
            }
            continue;
        }
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === '/' && next === '/') {
            lineComment = true;
            i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            blockComment = true;
            i++;
            continue;
        }
        out += ch;
    }
    return out;
}

function removeTrailingCommas(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === ',') {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            if (text[j] === '}' || text[j] === ']') continue;
        }
        out += ch;
    }
    return out;
}

function insertMissingContainerCommas(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        out += ch;
        if (ch !== '}' && ch !== ']') continue;
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
        // After a completed object/array, another JSON value cannot legally begin
        // without a comma. This repairs the common LLM error `}\n{`.
        if (next && next !== ',' && next !== '}' && next !== ']'
            && (next === '{' || next === '[' || next === '"' || next === '-'
                || /[0-9tfn]/.test(next))) {
            out += ',';
        }
    }
    return out;
}

function repairMismatchedClosersAndBalance(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    const stack = [];
    const openerFor = { '}': '{', ']': '[' };
    const closerFor = { '{': '}', '[': ']' };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === '{' || ch === '[') {
            stack.push(ch);
            out += ch;
            continue;
        }
        if (ch === '}' || ch === ']') {
            // If the model skipped an intermediate closing bracket, insert the
            // required closer(s) before consuming the closer it did provide.
            // Example: additions: [{...} }  -> additions: [{...}] }
            const neededOpener = openerFor[ch];
            const matchingDepth = stack.lastIndexOf(neededOpener);
            if (matchingDepth >= 0) {
                while (stack.length - 1 > matchingDepth) {
                    const missing = stack.pop();
                    out += closerFor[missing];
                }
                stack.pop();
                out += ch;
            } else {
                // Preserve unmatched closers for the parser to report rather
                // than silently deleting potentially meaningful structure.
                out += ch;
            }
            continue;
        }
        out += ch;
    }

    // A model may stop after a fully formed final record but omit only the
    // surrounding array/object closers. Closing those containers is lossless.
    if (!inString) {
        while (stack.length) out += closerFor[stack.pop()];
    }
    return out;
}

function jsonErrorPosition(error) {
    const message = String(error?.message || '');
    const match = message.match(/position\s+(\d+)/i);
    return match ? Number(match[1]) : null;
}

function insertMissingCommaAtError(text, error) {
    const position = jsonErrorPosition(error);
    if (!Number.isInteger(position)) return text;
    let at = Math.min(Math.max(position, 0), text.length);
    while (at < text.length && /\s/.test(text[at])) at++;
    if (at >= text.length) return text;

    let before = at - 1;
    while (before >= 0 && /\s/.test(text[before])) before--;
    if (before < 0) return text;

    const previous = text[before];
    const current = text[at];
    const valueCanEnd = previous === '"' || previous === '}' || previous === ']'
        || /[0-9eElL]/.test(previous);
    const valueCanStart = current === '"' || current === '{' || current === '['
        || current === '-' || /[0-9tfn]/.test(current);
    if (!valueCanEnd || !valueCanStart) return text;
    return `${text.slice(0, at)},${text.slice(at)}`;
}

function repairCommonJsonSyntax(text) {
    if (!text) return '';
    let repaired = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    repaired = stripJsonComments(repaired);
    repaired = removeTrailingCommas(repaired);
    repaired = insertMissingContainerCommas(repaired);
    repaired = repairMismatchedClosersAndBalance(repaired);
    return repaired.trim();
}

function tryParseResponseText(text) {
    try {
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.actors)) {
            return { parsed: null, error: new Error('JSON root must contain an actors array.') };
        }
        return { parsed, error: null };
    } catch (error) {
        return { parsed: null, error };
    }
}

function locallyRepairResponseText(candidate) {
    let repaired = repairCommonJsonSyntax(candidate);
    let latestError = null;
    for (let attempt = 0; attempt < 12; attempt++) {
        const result = tryParseResponseText(repaired);
        if (result.parsed) return { ...result, text: repaired };
        latestError = result.error;

        let next = insertMissingCommaAtError(repaired, result.error);
        next = removeTrailingCommas(next);
        next = insertMissingContainerCommas(next);
        next = repairMismatchedClosersAndBalance(next).trim();
        if (!next || next === repaired) break;
        repaired = next;
    }
    return { parsed: null, error: latestError, text: repaired };
}

function parseResponse(response) {
    const candidate = extractJsonCandidate(response);
    if (!candidate) return { parsed: null, candidate: '', error: new Error('Empty LLM response.'), recovery: '' };

    const strict = tryParseResponseText(candidate);
    if (strict.parsed) return { parsed: strict.parsed, candidate, error: null, recovery: '' };

    const repaired = locallyRepairResponseText(candidate);
    if (repaired.parsed) {
        console.warn('[NWST HiddenIntentions] Recovered malformed JSON locally without another LLM call:', strict.error);
        return { parsed: repaired.parsed, candidate: repaired.text, error: null, recovery: 'local-no-cost' };
    }

    console.warn('[NWST HiddenIntentions] Invalid JSON after local recovery:', repaired.error || strict.error);
    console.warn('[NWST HiddenIntentions] Invalid response preview:', candidate.slice(0, 5000));
    return { parsed: null, candidate, error: repaired.error || strict.error, recovery: 'failed-local' };
}

// Hidden Intentions never spends a second completion on syntax repair. The
// response is repaired locally when safe; otherwise the batch fails and the raw
// model output remains visible in the console for diagnosis/retry.
async function parseResponseWithRecovery(response) {
    return parseResponse(response);
}

function mergeActorPayloads(payloads = []) {
    const actors = [];
    const seen = new Set();
    for (const payload of payloads) {
        for (const actor of payload?.actors || []) {
            const actorId = String(actor?.actorId || actor?.actor || '').trim().toLowerCase();
            if (!actorId || seen.has(actorId)) continue;
            seen.add(actorId);
            actors.push(actor);
        }
    }
    return { actors };
}

function mergePacketMaps(maps = []) {
    const merged = new Map();
    for (const map of maps) {
        if (!(map instanceof Map)) continue;
        for (const [key, value] of map.entries()) merged.set(key, value);
    }
    return merged;
}

function hiddenIntentionsFailureCode(detailed, parseResult = null) {
    if (detailed?.reasoningExhausted) return 'REASONING_BUDGET_EXHAUSTED';
    if (detailed?.empty) return 'EMPTY_TRANSPORT_RESPONSE';
    if (parseResult && !parseResult.parsed) return 'INVALID_MODEL_JSON';
    return 'MODEL_RESPONSE_FAILURE';
}

async function requestHiddenIntentionsJson({
    profile,
    systemPrompt,
    userPrompt,
    compactMode = 'reconcile',
    maxTokens = LLM_TOKEN_BUDGETS.MEDIUM,
    compactMaxTokens = maxTokens,
    onAttempt = null,
    onRecovery = null,
    shouldStop = null,
    abortCheck = null
}) {
    const attempts = [];
    const stopIfRequested = () => {
        if (typeof abortCheck === 'function') {
            const abortError = abortCheck();
            if (abortError) throw abortError;
        }
        if (typeof shouldStop === 'function' && shouldStop()) {
            const error = new Error('Hidden Intentions backfill pause requested.');
            error.code = 'PAUSE_REQUESTED';
            throw error;
        }
    };
    const runAttempt = async ({ label, system, forceNoThink = false, tokenBudget = maxTokens }) => {
        stopIfRequested();
        const detailed = await generateWithProfileDetailed(profile, [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt }
        ], { maxTokens: tokenBudget, forceNoThink });
        if (typeof onAttempt === 'function') onAttempt(detailed, label);
        const parseResult = detailed.empty ? null : await parseResponseWithRecovery(detailed.content);
        attempts.push({ label, detailed, parseResult });
        if (parseResult?.parsed) {
            return {
                parsed: parseResult.parsed,
                recovery: [
                    label === 'compact' ? 'compact-no-think' : '',
                    parseResult.recovery || ''
                ].filter(Boolean).join('+'),
                attempts
            };
        }
        return null;
    };

    const primary = await runAttempt({ label: 'primary', system: systemPrompt, tokenBudget: maxTokens });
    if (primary) return primary;

    const primaryAttempt = attempts[0] || {};
    const primaryFailureCode = hiddenIntentionsFailureCode(primaryAttempt.detailed, primaryAttempt.parseResult);
    if (typeof onRecovery === 'function') {
        onRecovery({
            reason: primaryFailureCode,
            finishReason: primaryAttempt.detailed?.finishReason || '',
            visibleChars: String(primaryAttempt.detailed?.content || '').length,
            reasoningChars: String(primaryAttempt.detailed?.reasoning || '').length,
            requestChars: Number(primaryAttempt.detailed?.requestChars || 0)
        });
    }
    stopIfRequested();
    const compact = await runAttempt({
        label: 'compact',
        system: compactRecoverySystemPrompt(compactMode),
        forceNoThink: true,
        tokenBudget: compactMaxTokens
    });
    if (compact) return compact;
    stopIfRequested();

    const last = attempts[attempts.length - 1] || {};
    const first = attempts[0] || {};
    const code = hiddenIntentionsFailureCode(
        first.detailed?.reasoningExhausted ? first.detailed : last.detailed,
        last.parseResult
    );
    const reason = code === 'REASONING_BUDGET_EXHAUSTED'
        ? 'Model exhausted its completion budget in reasoning before emitting JSON'
        : code === 'EMPTY_TRANSPORT_RESPONSE'
            ? 'Connection returned no visible model text after compact recovery'
            : code === 'INVALID_MODEL_JSON'
                ? 'Model returned invalid JSON after local and compact recovery'
                : 'Model response could not be recovered';
    const error = new Error(`${reason}. ${last.detailed?.diagnostic || first.detailed?.diagnostic || ''}`.trim());
    error.code = code;
    error.calls = attempts.length;
    error.requestChars = Number(last.detailed?.requestChars || first.detailed?.requestChars || 0);
    error.responsePreview = String(last.detailed?.content || first.detailed?.content || '').slice(0, 1200);
    error.diagnostic = last.detailed?.diagnostic || first.detailed?.diagnostic || '';
    error.reasoningChars = Number(first.detailed?.reasoning?.length || last.detailed?.reasoning?.length || 0);
    error.finishReason = first.detailed?.finishReason || last.detailed?.finishReason || '';
    throw error;
}

function coerceStringList(value, { splitDelimiters = false } = {}) {
    const rawItems = Array.isArray(value) ? value : (typeof value === 'string' && value.trim() ? [value] : []);
    const out = [];
    const seen = new Set();
    for (const raw of rawItems) {
        const pieces = splitDelimiters
            ? String(raw || '').split(/\n+|\s*•\s*|;\s+/)
            : [String(raw || '')];
        for (const piece of pieces) {
            const text = String(piece || '').replace(/^[-*]\s*/, '').trim();
            if (!text) continue;
            const key = text.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(text);
        }
    }
    return out;
}

function parseMessageIndex(value) {
    if (Number.isInteger(value)) return value;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    const match = text.match(/^(?:M\s*)?(\d+)$/i);
    return match ? Number(match[1]) : null;
}

function normalizedEvidence(update, packet = null) {
    const summary = String(update?.evidenceSummary || '').trim();
    const start = parseMessageIndex(update?.evidenceMessageStart);
    const parsedEnd = parseMessageIndex(update?.evidenceMessageEnd);
    const end = parsedEnd != null ? parsedEnd : start;
    if (!summary && start == null) return [];
    if (start != null && packet) {
        const allowed = new Set(packet.messageIndices || []);
        if (!allowed.has(start) || (end != null && !allowed.has(end))) return [];
    }
    return [{ start, end, summary }];
}

function nearDuplicate(a, b) {
    const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const aa = norm(a), bb = norm(b);
    if (!aa || !bb) return false;
    if (aa === bb || aa.includes(bb) || bb.includes(aa)) return true;

    // Catch close paraphrases across backfill chunks without treating generic
    // shared words such as names or "project" as equivalence.
    const stop = new Set(['the','a','an','and','or','to','of','in','on','for','with','as','by','from','at','is','are','be','being','their','his','her','its','this','that']);
    const tokens = text => new Set(text.split(' ').filter(word => word.length > 2 && !stop.has(word)));
    const aTokens = tokens(aa), bTokens = tokens(bb);
    if (aTokens.size < 4 || bTokens.size < 4) return false;
    let overlap = 0;
    for (const token of aTokens) if (bTokens.has(token)) overlap += 1;
    return overlap >= 4 && (overlap / Math.min(aTokens.size, bTokens.size)) >= 0.78;
}



const INTENTION_CONCEPT_PATTERNS = Object.freeze({
    surveillance: /\b(?:surveill|monitor|follow|track|tail|observe|watch|dossier on movements)\w*/i,
    relational_pursuit: /\b(?:intrigu|fascinat|obsess|authentic connection|pursue .*connection|drawn to|attachment|learn more about .*person)\w*/i,
    dossier_profile: /\b(?:full dossier|background check|psychological profile|case history|compile .*profile|profile .*vulnerabilit)\w*/i,
    protective_intervention: /\b(?:protect|shield|keep .* safe|intervene|neutralize .*threat|prevent .*harm)\w*/i,
    care_support: /\b(?:care for|support|comfort|check on|bring .*suppl|help .*recover|look after)\w*/i,
    concealment: /\b(?:hide|conceal|keep .* secret|cover up|avoid detection)\w*/i,
    escape_avoidance: /\b(?:escape|flee|avoid capture|withdraw|leave .*behind)\w*/i
});

function intentionConceptTags(value) {
    const text = String(value || '').trim();
    const out = new Set();
    for (const [tag, pattern] of Object.entries(INTENTION_CONCEPT_PATTERNS)) if (pattern.test(text)) out.add(tag);
    return out;
}

function intentionTargetIds(registry, value) {
    const out = new Set();
    try {
        for (const id of registry?.scanProse?.(String(value || '')) || []) out.add(toCanonicalId(id));
    } catch (_) {}
    return out;
}

function primaryConceptTarget(registry, value, tag) {
    const text = String(value || '');
    const patterns = {
        surveillance: /(?:surveill(?:ance|ing)?(?:\s+(?:on|of))?|monitor(?:ing)?|follow(?:ing)?|track(?:ing)?|tail(?:ing)?|observ(?:e|ing)|watch(?:ing)?)\s+(.{0,140})/i,
        dossier_profile: /(?:full\s+dossier|dossier|background\s+checks?|psychological\s+profile|case\s+history|profile)(?:\s+(?:on|of|for))?\s+(.{0,140})/i
    };
    const match = patterns[tag]?.exec(text);
    if (!match) return '';
    try {
        const ids = registry?.scanProse?.(match[1]) || [];
        return ids.length ? toCanonicalId(ids[0]) : '';
    } catch (_) {
        return '';
    }
}

function conceptualDuplicate(registry, left = {}, right = {}) {
    const leftText = [left.objective, left.nextAction, left.strategy].filter(Boolean).join(' ');
    const rightText = [right.objective, right.nextAction, right.strategy].filter(Boolean).join(' ');
    const leftTags = intentionConceptTags(leftText);
    const rightTags = intentionConceptTags(rightText);
    let sharedTags = [...leftTags].filter(tag => rightTags.has(tag));
    if (!sharedTags.length) return false;

    // The same operation directed at different people is not a duplicate. This
    // prevents "monitor the witness while avoiding the detective" from swallowing a
    // separate "compile a dossier on the detective" plan merely because the latter
    // also mentions surveillance in its next step.
    sharedTags = sharedTags.filter(tag => {
        const leftPrimary = primaryConceptTarget(registry, leftText, tag);
        const rightPrimary = primaryConceptTarget(registry, rightText, tag);
        if (leftPrimary && rightPrimary && leftPrimary !== rightPrimary) return false;
        if (leftPrimary && rightPrimary && leftPrimary === rightPrimary) return true;
        return true;
    });
    if (!sharedTags.length) return false;

    const leftTargets = intentionTargetIds(registry, leftText);
    const rightTargets = intentionTargetIds(registry, rightText);
    if (leftTargets.size && rightTargets.size) {
        return [...leftTargets].some(id => rightTargets.has(id));
    }

    // A provider may describe a known person as "the woman", "his friend",
    // or another pronoun after the first segment. When one side lacks a named
    // target, require the same domain plus a strong shared concept instead of
    // relying on generic token overlap.
    return String(left.domain || '') === String(right.domain || '')
        && sharedTags.some(tag => ['surveillance', 'relational_pursuit', 'dossier_profile'].includes(tag));
}

function recordsSemanticallyDuplicate(registry, left = {}, right = {}) {
    return nearDuplicate(left.objective, right.objective)
        || nearDuplicate(left.nextAction, right.nextAction)
        || conceptualDuplicate(registry, left, right);
}

const WORKING_SET_STABILITY_BONUS = 6;

function recordLifecycleRank(record) {
    const statusRank = { active: 8, ready: 8, revised: 7, blocked: 6, latent: 5, parked: 4, resolved: 3, stale: 2, abandoned: 1, pending_review: 9 };
    return (record?.origin === 'manual' ? 100 : 0)
        + (record?.locked ? 80 : 0)
        + (statusRank[record?.status] || 0)
        + Math.max(0, latestRecordMessage(record)) / 1000000;
}

function mergeCanonicalDuplicateRecords(a, b, actorId, actorDisplay) {
    const primary = recordLifecycleRank(a) >= recordLifecycleRank(b) ? a : b;
    const secondary = primary === a ? b : a;
    const newer = latestRecordMessage(a) >= latestRecordMessage(b) ? a : b;
    const chooseLonger = (x, y) => String(x || '').length >= String(y || '').length ? String(x || '') : String(y || '');
    const minInteger = values => {
        const nums = values.filter(Number.isInteger);
        return nums.length ? Math.min(...nums) : null;
    };
    const maxInteger = values => {
        const nums = values.filter(Number.isInteger);
        return nums.length ? Math.max(...nums) : null;
    };
    return normalizeHiddenIntention({
        ...primary,
        actorId,
        actor: actorDisplay,
        objective: chooseLonger(primary.objective, secondary.objective),
        strategy: newer.strategy || primary.strategy || secondary.strategy,
        nextAction: newer.nextAction || primary.nextAction || secondary.nextAction,
        triggerConditions: [...(primary.triggerConditions || []), ...(secondary.triggerConditions || [])],
        constraints: [...(primary.constraints || []), ...(secondary.constraints || [])],
        basis: [...(primary.basis || []), ...(secondary.basis || [])],
        relatedEventIds: [...(primary.relatedEventIds || []), ...(secondary.relatedEventIds || [])],
        relatedCommunityIds: [...(primary.relatedCommunityIds || []), ...(secondary.relatedCommunityIds || [])],
        evidenceRanges: [...(primary.evidenceRanges || []), ...(secondary.evidenceRanges || [])],
        progressNote: newer.progressNote || primary.progressNote || secondary.progressNote,
        progressStage: newer.progressStage || primary.progressStage,
        status: newer.status || primary.status,
        confidence: CONFIDENCE_RANK[primary.confidence] >= CONFIDENCE_RANK[secondary.confidence] ? primary.confidence : secondary.confidence,
        commitment: CONFIDENCE_RANK[primary.commitment] >= CONFIDENCE_RANK[secondary.commitment] ? primary.commitment : secondary.commitment,
        createdDay: minInteger([a.createdDay, b.createdDay]),
        createdMessage: minInteger([a.createdMessage, b.createdMessage]),
        lastReviewedDay: maxInteger([a.lastReviewedDay, b.lastReviewedDay]),
        lastReviewedMessage: maxInteger([a.lastReviewedMessage, b.lastReviewedMessage]),
        lastReinforcedDay: maxInteger([a.lastReinforcedDay, b.lastReinforcedDay]),
        lastReinforcedMessage: maxInteger([a.lastReinforcedMessage, b.lastReinforcedMessage]),
        locked: a.locked === true || b.locked === true,
        origin: a.origin === 'manual' || b.origin === 'manual' ? 'manual' : 'generated'
    });
}

async function canonicalizeStoredIntentions(chatId) {
    const registry = buildAliasRegistry(chatId);
    const source = getHiddenIntentions(chatId);
    const runtime = getHiddenIntentionsState(chatId);
    const redirects = { ...(runtime.recordIdRedirects || {}) };
    const remapped = [];
    let changed = false;
    let redirectsChanged = false;

    const rememberRedirect = (fromId, toId) => {
        const from = String(fromId || '').trim().toLowerCase();
        const to = String(toId || '').trim();
        if (!from || !to || from === to.toLowerCase()) return;
        if (redirects[from] !== to) {
            redirects[from] = to;
            redirectsChanged = true;
        }
        // Collapse older chains that pointed at the record being merged.
        for (const [key, value] of Object.entries(redirects)) {
            if (String(value || '').trim().toLowerCase() === from && redirects[key] !== to) {
                redirects[key] = to;
                redirectsChanged = true;
            }
        }
    };

    for (const record of source) {
        const canonical = registry.resolve(record.actor) || registry.resolve(record.actorId) || toCanonicalId(record.actor || record.actorId);
        const display = registry.getDisplay(canonical) || record.actor || canonical;
        if (!canonical || registry.isGroup(canonical) || isPlaceholderActorName(display) || isPcActor(chatId, canonical, display, registry)) {
            changed = true;
            continue;
        }
        const normalized = normalizeHiddenIntention({ ...record, actorId: canonical, actor: display });
        if (normalized.actorId !== record.actorId || normalized.actor !== record.actor) changed = true;
        const duplicateIndex = remapped.findIndex(existing => existing.actorId === canonical && (
            nearDuplicate(existing.objective, normalized.objective)
            || (existing.nextAction && normalized.nextAction && nearDuplicate(existing.nextAction, normalized.nextAction))
        ));
        if (duplicateIndex >= 0) {
            const existing = remapped[duplicateIndex];
            const merged = mergeCanonicalDuplicateRecords(existing, normalized, canonical, display);
            rememberRedirect(existing.id, merged.id);
            rememberRedirect(normalized.id, merged.id);
            remapped[duplicateIndex] = merged;
            changed = true;
        } else {
            remapped.push(normalized);
        }
    }

    const validIds = new Set(remapped.map(item => String(item.id || '').toLowerCase()));
    const compactRedirects = {};
    for (const [rawFrom, rawTo] of Object.entries(redirects)) {
        const from = String(rawFrom || '').trim().toLowerCase();
        let target = String(rawTo || '').trim();
        const seen = new Set([from]);
        for (let depth = 0; depth < 12; depth += 1) {
            const key = target.toLowerCase();
            if (!redirects[key] || seen.has(key)) break;
            seen.add(key);
            target = String(redirects[key] || '').trim();
        }
        if (from && target && validIds.has(target.toLowerCase()) && from !== target.toLowerCase()) compactRedirects[from] = target;
    }
    if (JSON.stringify(compactRedirects) !== JSON.stringify(runtime.recordIdRedirects || {})) redirectsChanged = true;

    if (changed) await saveHiddenIntentions(chatId, remapped);
    if (redirectsChanged) {
        await saveHiddenIntentionsState(chatId, {
            ...getHiddenIntentionsState(chatId),
            recordIdRedirects: compactRedirects
        });
    }
    return {
        changed,
        mergedOrRemoved: Math.max(0, source.length - remapped.length),
        redirects: compactRedirects,
        list: remapped
    };
}

function isRotationProtected(record) {
    return record?.locked === true || record?.origin === 'manual' || record?.status === 'pending_review';
}

function latestRecordMessage(record) {
    // Reviewing a record is not the same as the narrative reinforcing it.
    // Rotation recency must therefore use actual evidence/creation anchors,
    // otherwise every reconciliation would make old records look brand-new.
    if (Number.isInteger(record?.lastReinforcedMessage)) return record.lastReinforcedMessage;
    if (Number.isInteger(record?.createdMessage)) return record.createdMessage;
    return null;
}

function workingSetScore(record, packet = null, referenceMessage = null, { existing = false } = {}) {
    const typeScores = {
        objective: 12,
        active_plan: 20,
        commitment: 18,
        ongoing_priority: 13,
        contingency: 11,
        emerging_interest: 8
    };
    const statusScores = {
        ready: 12,
        active: 10,
        revised: 9,
        blocked: 4,
        latent: 3,
        pending_review: 10
    };
    const progressScores = {
        unattempted: 0,
        prepared: 4,
        attempted: 6,
        progressed: 8,
        blocked: 2,
        failed: -4,
        fulfilled: 0
    };
    const level = { low: 0, medium: 1, high: 2 };
    let score = Number(typeScores[record?.type] || 8)
        + Number(statusScores[record?.status] || 0)
        + Number(progressScores[record?.progressStage] || 0)
        + Number(level[record?.confidence] || 0) * 4
        + Number(level[record?.commitment] || 0) * 5;

    if (String(record?.nextAction || '').trim()) score += 10;
    if (String(record?.strategy || '').trim()) score += 3;
    score += Math.min(4, Array.isArray(record?.basis) ? record.basis.length : 0);

    const currentEventIds = new Set(packet?.eventIds || []);
    const linkedCurrentEvents = (record?.relatedEventIds || []).filter(id => currentEventIds.has(id)).length;
    score += Math.min(16, linkedCurrentEvents * 8);

    const anchor = latestRecordMessage(record);
    if (Number.isInteger(anchor) && Number.isInteger(referenceMessage)) {
        const age = Math.max(0, referenceMessage - anchor);
        if (age <= 10) score += 24;
        else if (age <= 25) score += 20;
        else if (age <= 50) score += 14;
        else if (age <= 100) score += 8;
        else if (age <= 200) score += 3;
    }
    if (existing) score += WORKING_SET_STABILITY_BONUS;
    return score;
}

function parkWorkingRecord(record, { reason = '', atMessage = null, atDay = null, byIntentionId = '' } = {}) {
    if (!record || isRotationProtected(record)) return record;
    const fromStatus = record.status === 'parked'
        ? (record.parkedFromStatus || 'active')
        : (record.status || 'active');
    return normalizeHiddenIntention({
        ...record,
        status: 'parked',
        parkedFromStatus: fromStatus,
        parkedAtDay: Number.isInteger(atDay) ? atDay : null,
        parkedAtMessage: Number.isInteger(atMessage) ? atMessage : null,
        parkedReason: String(reason || 'Parked because the configured working set contains more current or actionable records.').trim(),
        parkedByIntentionId: String(byIntentionId || '').trim()
    });
}

function rebalanceActorWorkingSet({
    list, actor, candidates = [], packet = null, cfg, messageCount, elapsedDay,
    diagnostics, changed, reject
}) {
    const actorId = actor.actorId;
    const actorRows = list.filter(item => item.actorId === actorId);
    const protectedRows = actorRows.filter(item => activeRecord(item) && isRotationProtected(item));
    const replaceableRows = actorRows.filter(item => activeRecord(item) && !isRotationProtected(item));
    const cap = Math.max(1, Number(cfg.maxActivePerActor || 5));
    const contingencyCap = Math.max(0, Number(cfg.maxContingenciesPerActor || 1));
    const referenceMessage = Math.max(
        Number.isInteger(messageCount) ? messageCount : 0,
        ...((packet?.messageIndices || []).filter(Number.isInteger))
    );

    const selectedIds = new Set(protectedRows.map(item => item.id));
    let remaining = Math.max(0, cap - protectedRows.length);
    let contingenciesUsed = protectedRows.filter(item => item.type === 'contingency').length;

    const pool = [
        ...replaceableRows.map(record => ({ kind: 'existing', record, raw: null, score: workingSetScore(record, packet, referenceMessage, { existing: true }) })),
        ...candidates.map(entry => ({ kind: 'candidate', record: entry.record, raw: entry.raw, score: workingSetScore(entry.record, packet, referenceMessage, { existing: false }) }))
    ].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const bMsg = latestRecordMessage(b.record) ?? -1;
        const aMsg = latestRecordMessage(a.record) ?? -1;
        if (bMsg !== aMsg) return bMsg - aMsg;
        if (a.kind !== b.kind) return a.kind === 'existing' ? -1 : 1;
        return String(a.record.id).localeCompare(String(b.record.id));
    });

    const selectedCandidates = [];
    for (const row of pool) {
        if (remaining <= 0) continue;
        if (row.record.type === 'contingency' && contingenciesUsed >= contingencyCap) continue;
        selectedIds.add(row.record.id);
        remaining -= 1;
        if (row.record.type === 'contingency') contingenciesUsed += 1;
        if (row.kind === 'candidate') selectedCandidates.push(row);
    }

    const highestSelectedCandidate = selectedCandidates[0]?.record || null;
    let parkedCount = 0;
    list = list.map(item => {
        if (item.actorId !== actorId || !activeRecord(item) || isRotationProtected(item) || selectedIds.has(item.id)) return item;
        const displacedBy = highestSelectedCandidate?.id || '';
        const reason = highestSelectedCandidate
            ? `Parked to keep the ${cap}-record working set current; displaced by the more relevant ${highestSelectedCandidate.type.replaceAll('_', ' ')} “${highestSelectedCandidate.objective}”.`
            : `Parked during working-set rebalance because ${cap} more current or actionable records ranked above it.`;
        const parked = parkWorkingRecord(item, {
            reason,
            atMessage: referenceMessage,
            atDay: elapsedDay,
            byIntentionId: displacedBy
        });
        if (parked.status === 'parked' && item.status !== 'parked') {
            parkedCount += 1;
            changed.push(parked.id);
            diagnostics.parked += 1;
            diagnostics.rotations.push({ actor: actor.actor, parkedId: parked.id, parkedObjective: parked.objective, replacementId: displacedBy, reason });
        }
        return parked;
    });

    for (const row of selectedCandidates) {
        list.push(row.record);
        changed.push(row.record.id);
        diagnostics.additionsAccepted += 1;
    }
    for (const entry of candidates) {
        if (selectedIds.has(entry.record.id)) continue;
        const reason = protectedRows.length >= cap
            ? `working set is occupied by ${protectedRows.length} protected manual, locked, or pending-review record(s)`
            : `candidate did not rank above the actor's current top-${cap} working set`;
        reject(actor, 'addition', reason, entry.raw);
    }

    return { list, parkedCount, selectedCandidateIds: selectedCandidates.map(row => row.record.id) };
}

async function enforceStoredWorkingSetCaps(chatId, cfg) {
    let list = getHiddenIntentions(chatId);
    const registry = buildAliasRegistry(chatId);
    const actors = new Map();
    for (const record of list) {
        if (!activeRecord(record)) continue;
        const normalized = normalizeActor(chatId, record.actor || record.actorId, registry);
        if (!normalized || isPcActor(chatId, normalized.actorId, normalized.actor, registry)) continue;
        actors.set(normalized.actorId, normalized);
    }
    const diagnostics = { parked: 0, rotations: [], additionsAccepted: 0, rejected: [] };
    const changed = [];
    const packet = {
        eventIds: getTrackedEvents(chatId).filter(item => !['resolved','missed','cancelled'].includes(item.status)).map(item => item.id),
        messageIndices: [Math.max(0, currentMessageCount() - 1)]
    };
    const reject = () => {};
    for (const actor of actors.values()) {
        const balanced = rebalanceActorWorkingSet({
            list,
            actor,
            candidates: [],
            packet,
            cfg,
            messageCount: currentMessageCount(),
            elapsedDay: currentElapsedDay(chatId),
            diagnostics,
            changed,
            reject
        });
        list = balanced.list;
    }
    if (changed.length) await saveHiddenIntentions(chatId, list);
    return { list, parked: diagnostics.parked, rotations: diagnostics.rotations, changed };
}

function normalizeModelType(value, fallback = 'active_plan') {
    const type = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!type) return fallback;
    if (type === 'intention' || type === 'plan' || type === 'active_intention') return 'active_plan';
    if (type === 'priority' || type === 'maintenance_priority') return 'ongoing_priority';
    if (type === 'interest' || type === 'curiosity') return 'emerging_interest';
    return INTENTION_TYPES.includes(type) ? type : fallback;
}

function strategyRequiredForType(type) {
    return type === 'active_plan' || type === 'contingency';
}

function normalizeModelDomain(value) {
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

function normalizeModelStatus(value) {
    const status = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const aliases = {
        ongoing: 'active',
        in_progress: 'active',
        completed: 'resolved',
        complete: 'resolved',
        cancelled: 'abandoned',
        canceled: 'abandoned'
    };
    const mapped = aliases[status] || status;
    return INTENTION_STATUSES.includes(mapped) ? mapped : '';
}

function normalizeModelProgressStage(value) {
    const stage = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const aliases = {
        not_started: 'unattempted',
        pending: 'unattempted',
        in_progress: 'progressed',
        ongoing: 'progressed',
        underway: 'progressed',
        complete: 'fulfilled',
        completed: 'fulfilled',
        succeeded: 'fulfilled',
        unsuccessful: 'failed'
    };
    const mapped = aliases[stage] || stage;
    return INTENTION_PROGRESS.includes(mapped) ? mapped : '';
}


const MODEL_OPERATIONS = new Set(['update', 'progress', 'block', 'revise', 'park', 'reactivate', 'resolve', 'abandon', 'stale', 'add']);

function firstModelString(...values) {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const text = value.trim();
        if (text) return text;
    }
    return '';
}

function firstModelValue(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
}

function normalizeModelOperation(raw = {}, fallback = 'update') {
    const candidates = [raw.operation, raw.update, raw.op, raw.changeType, raw.change];
    for (const candidate of candidates) {
        const value = String(candidate || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (!value) continue;
        if (['create', 'new', 'addition', 'insert'].includes(value)) return 'add';
        if (['complete', 'completed', 'fulfill', 'fulfilled'].includes(value)) return 'resolve';
        if (['cancel', 'cancelled', 'drop', 'dropped'].includes(value)) return 'abandon';
        if (MODEL_OPERATIONS.has(value)) return value;
    }
    return fallback;
}

function isPlainModelObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameModelIdentity(a, b) {
    const left = toCanonicalId(String(a || '').trim());
    const right = toCanonicalId(String(b || '').trim());
    return Boolean(left && right && left === right);
}

function unwrapNestedModelItem(raw = {}, actorResult = null) {
    const outer = isPlainModelObject(raw) ? { ...raw } : {};
    const nestedContainer = isPlainModelObject(outer.update)
        ? outer.update
        : isPlainModelObject(outer.patch)
            ? outer.patch
            : isPlainModelObject(outer.changes)
                ? outer.changes
                : isPlainModelObject(outer.payload)
                    ? outer.payload
                    : null;
    if (!nestedContainer) return outer;

    let nested = { ...nestedContainer };
    let keyedTarget = '';
    const nestedEntries = Object.entries(nestedContainer);
    if (nestedEntries.length === 1 && isPlainModelObject(nestedEntries[0][1])) {
        const [onlyKey, onlyValue] = nestedEntries[0];
        if (/^(?:r\d+|[0-9a-f]{8}-[0-9a-f-]{27,})$/i.test(String(onlyKey || '').trim())) {
            keyedTarget = String(onlyKey).trim();
            nested = { ...onlyValue };
        }
    }

    const actorHints = [
        actorResult?.actorId, actorResult?.actor, actorResult?.name,
        actorResult?.character, actorResult?.npc
    ].filter(Boolean);
    const outerId = firstModelString(
        outer.id, outer.recordId, outer.record_id, outer.intentionId,
        outer.intention_id, outer.targetId, outer.target_id, outer.existingId,
        outer.existing_id, outer.ref, outer.reference, outer.match,
        outer.matchId, outer.match_id, outer.recordRef, outer.record_ref,
        outer.targetRef, outer.target_ref
    );
    const outerIdIsActor = actorHints.some(hint => sameModelIdentity(outerId, hint));

    // Nested provider shapes occasionally use the outer `id` for the actor and
    // put the actual record patch inside `update: {...}`. Merge the patch first
    // so its explicit UUID/R# target wins. Never reinterpret an actor ID as an
    // intention ID.
    const merged = { ...outer, ...nested };
    if (isPlainModelObject(merged.update)) delete merged.update;
    if (isPlainModelObject(merged.patch)) delete merged.patch;
    if (isPlainModelObject(merged.changes)) delete merged.changes;
    if (isPlainModelObject(merged.payload)) delete merged.payload;

    const nestedTarget = firstModelString(
        nested.id, nested.recordId, nested.record_id, nested.intentionId,
        nested.intention_id, nested.targetId, nested.target_id, nested.existingId,
        nested.existing_id, nested.ref, nested.reference, nested.match,
        nested.matchId, nested.match_id, nested.recordRef, nested.record_ref,
        nested.targetRef, nested.target_ref, keyedTarget
    );
    if (nestedTarget) merged.id = nestedTarget;
    else if (outerIdIsActor) {
        merged.id = '';
        merged._actorWrapperId = outerId;
    }
    merged._nestedModelItem = true;
    return merged;
}

function normalizeModelItemShape(raw = {}, kind = 'addition', actorResult = null) {
    const source = unwrapNestedModelItem(raw, actorResult);
    const details = firstModelString(source.details, source.detail, source.rationale, source.context, source.explanation);
    const objective = firstModelString(
        source.objective, source.goal, source.headline, source.summary,
        source.description, source.intent, source.intention, source.aim, source.target
    );
    const nextAction = firstModelString(
        source.nextAction, source.next, source.nextStep, source.next_step,
        source.plannedAction, source.planned_action, source.immediateAction,
        source.action, source.nextMove, source.next_move, source.plannedNext,
        source.planned_next, source.immediateNextAction, source.immediate_next_action
    );
    const progressNote = firstModelString(
        source.progressNote, source.progress, source.lifecycleNote, source.updateSummary,
        source.result, source.outcome, source.evidenceSummary,
        kind === 'update' ? details : ''
    );
    const operation = normalizeModelOperation(source, kind === 'addition' ? 'add' : 'update');
    const suppliedId = firstModelString(
        source.id, source.recordId, source.record_id, source.intentionId,
        source.intention_id, source.targetId, source.target_id, source.existingId,
        source.existing_id, source.ref, source.reference, source.match,
        source.matchId, source.match_id, source.recordRef, source.record_ref,
        source.targetRef, source.target_ref
    );
    // New additions never own or target an existing record ID. Providers often
    // copy R1/R2 refs into additions even though those refs belong exclusively
    // to the existing-record roster. Discard them before validation so they
    // cannot be confused with update targets.
    const id = kind === 'addition' && operation === 'add' ? '' : suppliedId;
    const basisSeed = firstModelValue(
        source.basis, source.knowledgeBasis, source.knowledge_basis,
        source.evidence, source.grounding, source.reasons, source.reason,
        source.support, source.supportingEvidence,
        kind === 'addition' && details ? [details] : undefined,
        kind === 'addition' && firstModelString(source.evidenceSummary, source.evidence_summary)
            ? [firstModelString(source.evidenceSummary, source.evidence_summary)]
            : undefined,
        kind === 'addition' && progressNote ? [progressNote] : undefined
    );
    const normalized = {
        ...source,
        id,
        operation,
        _providerSuppliedId: suppliedId,
        // Additions may default to Active Plan, but updates must preserve an
        // omitted type as "no type change." Previously a blank update type was
        // normalized to active_plan, which produced false type-conversion
        // warnings and discarded otherwise valid progress updates.
        type: normalizeModelType(firstModelString(
            source.type, source.intentionType, source.intention_type,
            source.recordType, source.record_type, source.kind
        ), kind === 'addition' ? 'active_plan' : ''),
        objective,
        strategy: firstModelString(
            source.strategy, source.approach, source.method, source.responsePlan, source.response_plan,
            source.broadApproach, source.broad_approach, source.executionStrategy, source.execution_strategy,
            source.intendedMethod, source.intended_method, source.responseMethod, source.response_method,
            source.tactic, source.tactics, source.execution, source.implementation
        ),
        nextAction,
        progressNote,
        status: normalizeModelStatus(firstModelString(source.status, source.newStatus, source.new_status)),
        progressStage: normalizeModelProgressStage(firstModelString(source.progressStage, source.newProgressStage, source.new_progress_stage, source.stage)),
        confidence: firstModelString(source.confidence, source.certainty).toLowerCase(),
        commitment: firstModelString(source.commitment, source.resolve, source.dedication).toLowerCase(),
        triggerConditions: firstModelValue(source.triggerConditions, source.trigger_conditions, source.triggers, source.trigger),
        constraints: firstModelValue(source.constraints, source.limitations, source.limits, source.obstacles),
        basis: basisSeed,
        relatedEventIds: firstModelValue(source.relatedEventIds, source.related_event_ids, source.eventIds, source.event_ids),
        relatedCommunityIds: firstModelValue(source.relatedCommunityIds, source.related_community_ids, source.communityIds, source.community_ids),
        evidenceMessageStart: firstModelValue(source.evidenceMessageStart, source.evidence_message_start, source.messageStart, source.message_start, source.startMessage, source.start_message, source.evidenceStart),
        evidenceMessageEnd: firstModelValue(source.evidenceMessageEnd, source.evidence_message_end, source.messageEnd, source.message_end, source.endMessage, source.end_message, source.evidenceEnd),
        evidenceSummary: firstModelString(source.evidenceSummary, source.evidence_summary, source.evidenceNote, source.evidence_note, details)
    };
    return normalized;
}


const DIRECT_ACTION_OBJECTIVE = /^(?:to\s+)?(?:order|arrange|compile|investigate|monitor|follow|track|contact|meet|call|visit|confront|protect|support|help|maintain|continue|prepare|review|gather|ensure|prevent|shield|pursue|seek|find|locate|check|report|complete|finalize|deliver|watch|observe|intervene|resolve|neutralize|rent|secure|keep|learn|assess|determine|build|rebuild|repair|hide|conceal|wait|remain|guide|offer)\b/i;
const EMBEDDED_ACTION_OBJECTIVE = /\b(?:plans?|intends?|aims?|wants?|seeks?|is preparing|is trying|has decided|has ordered|is committed|will)\s+(?:to\s+)?/i;
const BROAD_INTEREST_OBJECTIVE = /\b(?:intrigu|curios|fascinat|obsess|attachment|connection|drawn to|interest in|understand (?:her|him|them)|learn more about)\w*/i;
const MAINTENANCE_OBJECTIVE = /\b(?:maintain|preserve|support|protect|encourage|help|look after|keep .* safe|remain invested|prevent .* deteriorat)\w*/i;
const PAST_ONLY_OBJECTIVE = /^(?:encouraged|helped|asked|told|offered|supported|comforted|checked|visited|advised|suggested)\b/i;
const SPECULATIVE_GROUNDING = /\b(?:likely|may|might|possibly|perhaps|seems?|appears?|suggests?)\b/i;

function objectiveCanServeAsNextAction(value) {
    const text = String(value || '').trim();
    if (!text || PAST_ONLY_OBJECTIVE.test(text)) return false;
    return DIRECT_ACTION_OBJECTIVE.test(text) || EMBEDDED_ACTION_OBJECTIVE.test(text);
}

function recoverAdditionSemantics(raw = {}) {
    const item = { ...raw };
    let type = normalizeModelType(item.type);
    let nextAction = String(item.nextAction || '').trim();
    const objective = String(item.objective || '').trim();
    let recovery = '';

    if ((type === 'active_plan' || type === 'commitment') && !nextAction) {
        if (objectiveCanServeAsNextAction(objective)) {
            // The provider supplied one actionable sentence as the goal but
            // omitted the redundant nearest-action field. Reuse the grounded
            // action rather than discarding the whole record.
            nextAction = objective;
            recovery = `${type}:nextAction-from-objective`;
        } else if (type === 'active_plan' && BROAD_INTEREST_OBJECTIVE.test(objective)) {
            type = 'emerging_interest';
            recovery = 'active_plan-to-emerging_interest';
        } else if (!PAST_ONLY_OBJECTIVE.test(objective) && MAINTENANCE_OBJECTIVE.test(objective)) {
            type = 'ongoing_priority';
            recovery = `${raw.type || type}-to-ongoing_priority`;
        }
    }

    return { ...item, type, nextAction, _semanticRecovery: recovery };
}

function segmentFallbackEvidence(raw = {}, packet = null, mode = 'reconcile') {
    if (mode !== 'backfill') return [];
    const indices = (packet?.messageIndices || []).filter(Number.isInteger).sort((a, b) => a - b);
    if (!indices.length) return [];
    const objective = String(raw.objective || '').trim();
    if (objective.split(/\s+/).filter(Boolean).length < 5) return [];
    const explicitGrounding = firstModelString(raw.progressNote, raw.evidenceSummary);
    // Do not convert a purely speculative inference into historical evidence.
    if (!explicitGrounding && SPECULATIVE_GROUNDING.test(objective)) return [];
    const start = indices[0];
    const end = indices[indices.length - 1];
    return [{
        start,
        end,
        summary: explicitGrounding || `Directly supported by the supplied chronological segment M${start}–M${end}; the provider omitted a separate basis field.`
    }];
}

const MATERIAL_UPDATE_STRING_FIELDS = ['objective', 'strategy', 'nextAction', 'progressNote', 'confidence', 'commitment'];
const MATERIAL_UPDATE_LIST_FIELDS = ['triggerConditions', 'constraints'];
const LIFECYCLE_OPERATIONS = new Set(['progress', 'block', 'revise', 'park', 'reactivate', 'resolve', 'abandon', 'stale']);

function normalizedListSignature(value) {
    return coerceStringList(value, { splitDelimiters: true })
        .map(item => String(item || '').trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join('\u0000');
}

function updateHasSubstantiveDelta(raw = {}, current = {}, operation = 'update') {
    if (LIFECYCLE_OPERATIONS.has(String(operation || '').toLowerCase())) return true;

    const requestedType = normalizeModelType(raw.type, '');
    if (requestedType && requestedType !== current.type) return true;
    const requestedDomain = normalizeModelDomain(raw.domain);
    if (requestedDomain && requestedDomain !== current.domain) return true;
    if (INTENTION_STATUSES.includes(raw.status) && raw.status !== current.status) return true;
    if (INTENTION_PROGRESS.includes(raw.progressStage) && raw.progressStage !== current.progressStage) return true;

    for (const field of MATERIAL_UPDATE_STRING_FIELDS) {
        const next = String(raw[field] || '').trim();
        if (next && next !== String(current[field] || '').trim()) return true;
    }
    for (const field of MATERIAL_UPDATE_LIST_FIELDS) {
        const next = normalizedListSignature(raw[field]);
        if (next && next !== normalizedListSignature(current[field])) return true;
    }
    return false;
}

function summarizeImplicitUpdateGrounding(raw = {}, current = {}, operation = 'update', packet = null) {
    const explicit = firstModelString(raw.progressNote, raw.evidenceSummary);
    if (explicit) return explicit.slice(0, 500);

    const changes = [];
    const requestedType = normalizeModelType(raw.type, '');
    const requestedDomain = normalizeModelDomain(raw.domain);
    if (requestedType && requestedType !== current.type) changes.push(`type to ${requestedType}`);
    if (requestedDomain && requestedDomain !== current.domain) changes.push(`domain to ${requestedDomain}`);
    if (INTENTION_STATUSES.includes(raw.status) && raw.status !== current.status) changes.push(`status to ${raw.status}`);
    if (INTENTION_PROGRESS.includes(raw.progressStage) && raw.progressStage !== current.progressStage) changes.push(`progress to ${raw.progressStage}`);
    if (String(raw.strategy || '').trim() && String(raw.strategy || '').trim() !== String(current.strategy || '').trim()) changes.push('strategy');
    if (String(raw.nextAction || '').trim() && String(raw.nextAction || '').trim() !== String(current.nextAction || '').trim()) changes.push('next action');
    if (String(raw.objective || '').trim() && String(raw.objective || '').trim() !== String(current.objective || '').trim()) changes.push('objective');
    if (normalizedListSignature(raw.triggerConditions) && normalizedListSignature(raw.triggerConditions) !== normalizedListSignature(current.triggerConditions)) changes.push('trigger conditions');
    if (normalizedListSignature(raw.constraints) && normalizedListSignature(raw.constraints) !== normalizedListSignature(current.constraints)) changes.push('constraints');

    const indices = (packet?.messageIndices || []).filter(Number.isInteger).sort((a, b) => a - b);
    const range = indices.length ? ` M${indices[0]}–M${indices[indices.length - 1]}` : '';
    const op = String(operation || 'update').toLowerCase();
    if (op !== 'update') return `The supplied narrative${range} supports the ${op} lifecycle change.`;
    if (changes.length) return `The supplied narrative${range} supports updating the record's ${changes.join(', ')}.`;
    return `The supplied narrative${range} supports this record update.`;
}

function recoverImplicitUpdateGrounding(raw = {}, packet = null, mode = 'reconcile', current = {}, operation = 'update') {
    const scope = String(packet?.implicitGrounding || '');
    const substantive = updateHasSubstantiveDelta(raw, current, operation);
    if (!substantive) return { evidence: [], basis: [], groundedByPacket: false, summary: '', noOp: true };

    const summary = summarizeImplicitUpdateGrounding(raw, current, operation, packet);
    const indices = (packet?.messageIndices || []).filter(Number.isInteger).sort((a, b) => a - b);
    const segmentGrounded = mode === 'backfill' || scope === 'historical_segment' || scope === 'recent_scan';
    if (segmentGrounded && indices.length) {
        return {
            evidence: [{ start: indices[0], end: indices[indices.length - 1], summary }],
            basis: [],
            groundedByPacket: true,
            summary,
            noOp: false
        };
    }
    if (scope === 'final_consolidation') {
        return { evidence: [], basis: [], groundedByPacket: true, summary, noOp: false };
    }
    return { evidence: [], basis: [], groundedByPacket: false, summary, noOp: false };
}

function actorIdentityKeys(registry, ...values) {
    const keys = new Set();
    const add = value => {
        const text = String(value || '').trim();
        if (!text) return;
        keys.add(toCanonicalId(text));
        try {
            const resolved = registry?.resolve?.(text);
            if (resolved) keys.add(toCanonicalId(resolved));
            const display = resolved ? registry?.getDisplay?.(resolved) : '';
            if (display) keys.add(toCanonicalId(display));
        } catch (_) {}
    };
    values.forEach(add);
    return keys;
}

function keySetsOverlap(a, b) {
    for (const key of a || []) if (b?.has?.(key)) return true;
    return false;
}

function findRequestedActorMatch(registry, actors, actorResult = {}) {
    const rawName = firstModelString(actorResult.actorId, actorResult.actor, actorResult.name, actorResult.character, actorResult.npc);
    const rawKeys = actorIdentityKeys(registry, rawName);
    for (const actor of actors) {
        const keys = actorIdentityKeys(registry, actor.actorId, actor.actor);
        if (keySetsOverlap(rawKeys, keys)) return actor;
    }
    return null;
}

function recordMatchesActor(registry, record, actor) {
    return keySetsOverlap(
        actorIdentityKeys(registry, record?.actorId, record?.actor),
        actorIdentityKeys(registry, actor?.actorId, actor?.actor)
    );
}

function resolvePacketRecordId(rawId, packet, list, actor, registry, chatId = '') {
    const text = String(rawId || '').trim();
    if (!text) return '';
    const key = text.toLowerCase().replace(/^id\s*[:#-]?\s*/i, '').trim();
    const mapped = packet?.recordIdMap?.[key] || packet?.recordIdMap?.[text.toLowerCase()];
    if (mapped) return mapped;

    // Preserve continuity when duplicate records were merged after an earlier
    // segment. Providers occasionally repeat the retired UUID even though the
    // current actor packet shows the surviving record.
    if (chatId) {
        const redirects = getHiddenIntentionsState(chatId)?.recordIdRedirects || {};
        let redirected = String(redirects[key] || '').trim();
        const seen = new Set([key]);
        for (let depth = 0; redirected && depth < 12; depth += 1) {
            const redirectKey = redirected.toLowerCase();
            if (!redirects[redirectKey] || seen.has(redirectKey)) break;
            seen.add(redirectKey);
            redirected = String(redirects[redirectKey] || '').trim();
        }
        if (redirected) return redirected;
    }

    // R1/R2/R3 are actor-local references. Recover them from the actor packet's
    // ordered ID list even if a provider used `match` or the explicit ref map
    // was absent. Never resolve a short ref against another actor's ledger.
    const shortRef = key.match(/^r(\d+)$/i);
    if (shortRef) {
        const refIndex = Number(shortRef[1]) - 1;
        const packetId = Array.isArray(packet?.intentionIds) ? packet.intentionIds[refIndex] : '';
        if (packetId) return String(packetId);
    }

    const actorRows = list.filter(item => recordMatchesActor(registry, item, actor));
    const exact = actorRows.find(item => String(item.id || '').toLowerCase() === key);
    if (exact) return exact.id;
    return text;
}


function mergeModelLists(...values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        for (const item of coerceStringList(value, { splitDelimiters: false })) {
            const key = String(item || '').trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(String(item).trim());
        }
    }
    return out;
}

function mergeSameResponseUpdateIntoAddition(addition = {}, update = {}) {
    const merged = { ...addition };
    for (const field of ['type', 'domain', 'objective', 'strategy', 'nextAction', 'progressNote', 'status', 'progressStage', 'confidence', 'commitment']) {
        if (typeof update[field] === 'string' && update[field].trim()) merged[field] = update[field].trim();
    }
    for (const field of ['triggerConditions', 'constraints', 'basis', 'relatedEventIds', 'relatedCommunityIds']) {
        const values = mergeModelLists(merged[field], update[field]);
        if (values.length) merged[field] = values;
    }
    for (const field of ['evidenceMessageStart', 'evidenceMessageEnd', 'evidenceSummary']) {
        if (update[field] !== undefined && update[field] !== null && update[field] !== '') merged[field] = update[field];
    }

    const operation = String(update.operation || 'update');
    if (operation === 'block') {
        merged.status = 'blocked';
        merged.progressStage = 'blocked';
    } else if (operation === 'resolve') {
        merged.status = 'resolved';
        merged.progressStage = 'fulfilled';
    } else if (operation === 'abandon') {
        merged.status = 'abandoned';
    } else if (operation === 'stale') {
        merged.status = 'stale';
    } else if (operation === 'park') {
        merged.status = 'parked';
    } else if (operation === 'revise' && !merged.status) {
        merged.status = 'revised';
    } else if (operation === 'progress' && !merged.progressStage) {
        merged.progressStage = 'progressed';
    }
    merged._foldedSameResponseUpdate = true;
    return merged;
}

function orphanUpdateCanBecomeAddition(item = {}) {
    const type = normalizeModelType(item.type, '');
    const objective = String(item.objective || '').trim();
    const strategy = String(item.strategy || '').trim();
    const nextAction = String(item.nextAction || '').trim();
    const basis = coerceStringList(item.basis);
    const hasEvidence = Number.isInteger(Number(item.evidenceMessageStart))
        || Number.isInteger(Number(item.evidenceMessageEnd))
        || Boolean(String(item.evidenceSummary || item.progressNote || '').trim());
    if (!type || !objective || (!basis.length && !hasEvidence)) return false;
    if (type === 'active_plan' && (!strategy || !nextAction)) return false;
    if (type === 'commitment' && !nextAction) return false;
    if (type === 'contingency' && (!strategy || !coerceStringList(item.triggerConditions, { splitDelimiters: true }).length)) return false;
    return true;
}

function normalizedActorResultItems(actorResult = {}, packet = null) {
    const updates = [];
    const additions = [];
    const updateRows = Array.isArray(actorResult.updates) ? actorResult.updates : [];
    const additionRows = Array.isArray(actorResult.additions) ? actorResult.additions : [];

    for (const raw of additionRows) additions.push(normalizeModelItemShape(raw, 'addition', actorResult));
    for (const raw of updateRows) {
        const item = normalizeModelItemShape(raw, 'update', actorResult);
        if (item.operation === 'add') {
            additions.push(normalizeModelItemShape(raw, 'addition', actorResult));
        } else {
            updates.push(item);
        }
    }

    const providerAdditionIds = new Map();
    additions.forEach((item, index) => {
        const providerId = String(item._providerSuppliedId || '').trim().toLowerCase();
        if (providerId) providerAdditionIds.set(providerId, index);
    });

    const remainingUpdates = [];
    let foldedUpdates = 0;
    let orphanConversions = 0;
    const existingCount = Array.isArray(packet?.intentionIds) ? packet.intentionIds.length : 0;

    for (const update of updates) {
        const target = String(update.id || '').trim().toLowerCase();
        let additionIndex = providerAdditionIds.has(target) ? providerAdditionIds.get(target) : -1;

        // Some providers number newly proposed additions R1/R2 even when the
        // actor packet explicitly contains no existing records. In that one
        // unambiguous case, fold the update into the matching addition instead
        // of treating the short ref as an existing-record target.
        if (additionIndex < 0 && existingCount === 0) {
            const shortRef = target.match(/^r(\d+)$/i);
            if (shortRef) {
                const index = Number(shortRef[1]) - 1;
                if (index >= 0 && index < additions.length) additionIndex = index;
            }
        }

        if (additionIndex >= 0) {
            additions[additionIndex] = mergeSameResponseUpdateIntoAddition(additions[additionIndex], update);
            foldedUpdates += 1;
            continue;
        }

        // When there is no existing ledger at all and the provider mislabeled
        // a fully formed new record as an update, recover it as an addition.
        // Never do this when any existing record could be the intended target.
        if (existingCount === 0 && orphanUpdateCanBecomeAddition(update)) {
            additions.push({
                ...update,
                id: '',
                operation: 'add',
                _providerSuppliedId: String(update._providerSuppliedId || update.id || '').trim(),
                _recoveredOrphanUpdate: true
            });
            orphanConversions += 1;
            continue;
        }

        remainingUpdates.push(update);
    }

    return { updates: remainingUpdates, additions, foldedUpdates, orphanConversions };
}

function applyModelResult(chatId, actors, parsed, packets, cfg, mode = 'reconcile') {
    const messageCount = currentMessageCount();
    const elapsedDay = currentElapsedDay(chatId);
    const registry = buildAliasRegistry(chatId);
    const requested = new Map(actors.map(actor => [actor.actorId, actor]));
    let list = getHiddenIntentions(chatId);
    const changed = [];
    const diagnostics = {
        mode,
        additionsSeen: 0,
        additionsAccepted: 0,
        updatesSeen: 0,
        updatesApplied: 0,
        parked: 0,
        reactivated: 0,
        rotations: [],
        rejected: [],
        suppressed: [],
        duplicatesMerged: 0,
        semanticRecoveries: 0
    };
    const reject = (actor, kind, reason, raw = null) => {
        const entry = { actor: actor?.actor || actor?.actorId || '(unknown)', kind, reason };
        diagnostics.rejected.push(entry);
        console.warn('[NWST HiddenIntentions] Rejected model item:', entry, raw || '');
    };
    const suppress = (actor, kind, reason, raw = null) => {
        const entry = { actor: actor?.actor || actor?.actorId || '(unknown)', kind, reason };
        diagnostics.suppressed.push(entry);
        dlog('[NWST HiddenIntentions] Suppressed non-record item:', entry, raw || '');
    };

    for (const actorResult of parsed.actors || []) {
        const actor = findRequestedActorMatch(registry, actors, actorResult);
        if (!actor) continue;
        const packet = packets.get(actor.actorId) || Array.from(packets.entries()).find(([key]) => keySetsOverlap(
            actorIdentityKeys(registry, key), actorIdentityKeys(registry, actor.actorId, actor.actor)
        ))?.[1];
        if (!packet || isPcActor(chatId, actor.actorId, actor.actor, registry)) continue;

        const matchingRows = () => list.filter(item => recordMatchesActor(registry, item, actor));
        const storedActorId = matchingRows()[0]?.actorId || (registry.resolve(actor.actor) || registry.resolve(actor.actorId) || actor.actorId);
        const actorId = storedActorId;
        const actorRecords = () => list.filter(item => recordMatchesActor(registry, item, actor));
        const normalizedItems = normalizedActorResultItems(actorResult, packet);
        diagnostics.semanticRecoveries += Number(normalizedItems.foldedUpdates || 0) + Number(normalizedItems.orphanConversions || 0);
        diagnostics.updatesSeen += Number(normalizedItems.foldedUpdates || 0);

        for (const raw of normalizedItems.updates) {
            diagnostics.updatesSeen += 1;
            if (mode === 'generate') {
                reject(actor, 'update', 'updates are not allowed during generation', raw);
                continue;
            }
            const resolvedId = resolvePacketRecordId(raw?.id, packet, list, actor, registry, chatId);
            const index = list.findIndex(item => item.id === resolvedId && recordMatchesActor(registry, item, actor));
            const allowedIds = new Set([
                ...(packet.intentionIds || []),
                ...Object.values(packet.recordIdMap || {})
            ].map(id => String(id || '').toLowerCase()).filter(Boolean));
            if (index < 0 || !allowedIds.has(String(resolvedId || '').toLowerCase())) {
                if (!(packet.intentionIds || []).length) {
                    suppress(actor, 'update', 'actor has no existing record; provider should have used additions', { ...raw, resolvedId });
                } else {
                    reject(actor, 'update', 'unknown or mismatched intention ID', { ...raw, resolvedId });
                }
                continue;
            }
            raw.id = resolvedId;
            const current = list[index];
            const updates = {};
            const operation = String(raw.operation || 'update');
            if (raw?.status === 'parked' && operation !== 'park') {
                reject(actor, 'update', 'parked status requires the explicit park operation', raw);
                continue;
            }
            if (current.status === 'parked' && raw?.status && raw.status !== 'parked' && operation !== 'reactivate') {
                reject(actor, 'update', 'a parked record requires the explicit reactivate operation', raw);
                continue;
            }
            let proposedEvidence = normalizedEvidence(raw, packet);
            let proposedBasis = coerceStringList(raw?.basis);
            let groundedByPacket = false;
            let implicitGroundingSummary = '';
            const implicitGroundingNote = firstModelString(raw.progressNote, raw.evidenceSummary);
            const implicitGroundingScope = String(packet?.implicitGrounding || '');
            if (!proposedEvidence.length && !proposedBasis.length && implicitGroundingNote) {
                if ((mode === 'backfill' || implicitGroundingScope === 'historical_segment' || implicitGroundingScope === 'recent_scan') && packet.messageIndices?.length) {
                    proposedEvidence = [{
                        start: Math.min(...packet.messageIndices),
                        end: Math.max(...packet.messageIndices),
                        summary: implicitGroundingNote.slice(0, 500)
                    }];
                    groundedByPacket = true;
                } else if (implicitGroundingScope === 'final_consolidation') {
                    // Final cleanup is grounded in the supplied current end-state
                    // and recent narrative rather than a single historical span.
                    // Preserve the provider's substantive progress explanation as
                    // the grounding basis instead of discarding the lifecycle update.
                    proposedBasis = [implicitGroundingNote.slice(0, 700)];
                    groundedByPacket = true;
                }
            }
            if (!proposedEvidence.length && !proposedBasis.length) {
                const recoveredGrounding = recoverImplicitUpdateGrounding(raw, packet, mode, current, operation);
                if (recoveredGrounding.noOp) {
                    suppress(actor, 'update', 'no substantive change and no new grounding', raw);
                    continue;
                }
                proposedEvidence = recoveredGrounding.evidence;
                proposedBasis = recoveredGrounding.basis;
                groundedByPacket = recoveredGrounding.groundedByPacket;
                implicitGroundingSummary = recoveredGrounding.summary;
                if (groundedByPacket) diagnostics.semanticRecoveries += 1;
            }
            const evidenceMessages = proposedEvidence.flatMap(item => [item?.start, item?.end]).filter(Number.isInteger);
            const evidenceMessage = evidenceMessages.length ? Math.max(...evidenceMessages) : null;
            if (!proposedEvidence.length && !proposedBasis.length && !groundedByPacket) {
                reject(actor, 'update', 'missing evidence or grounding basis', raw);
                continue;
            }
            const lifecycleNote = String(raw?.progressNote || raw?.evidenceSummary || proposedBasis[0] || implicitGroundingSummary || '').trim();
            if (LIFECYCLE_OPERATIONS.has(operation) && !lifecycleNote) {
                reject(actor, 'update', 'lifecycle update missing progress note', raw);
                continue;
            }
            if (LIFECYCLE_OPERATIONS.has(operation)) updates.progressNote = lifecycleNote;
            if (INTENTION_STATUSES.includes(raw.status)) updates.status = raw.status;
            if (INTENTION_PROGRESS.includes(raw.progressStage)) updates.progressStage = raw.progressStage;
            if (operation === 'block') { updates.status = 'blocked'; updates.progressStage = 'blocked'; }
            if (operation === 'resolve') {
                updates.status = 'resolved';
                // Resolution means the record is closed, not necessarily that the
                // actor succeeded. Preserve an explicit failed outcome; default to
                // fulfilled only when the provider supplied no outcome stage.
                if (!updates.progressStage) updates.progressStage = 'fulfilled';
            }
            if (operation === 'abandon') updates.status = 'abandoned';
            if (operation === 'stale') updates.status = 'stale';
            if (operation === 'park') {
                if (isRotationProtected(current)) {
                    reject(actor, 'update', 'manual, locked, or pending-review records cannot be parked automatically', raw);
                    continue;
                }
                updates.status = 'parked';
                updates.parkedFromStatus = current.status === 'parked' ? (current.parkedFromStatus || 'active') : current.status;
                updates.parkedAtDay = elapsedDay;
                updates.parkedAtMessage = mode === 'backfill' && Number.isInteger(evidenceMessage) ? evidenceMessage : messageCount;
                updates.parkedReason = lifecycleNote;
                diagnostics.parked += current.status === 'parked' ? 0 : 1;
            }
            if (operation === 'reactivate') {
                if (current.status !== 'parked') {
                    reject(actor, 'update', 'reactivate requested for a record that is not parked', raw);
                    continue;
                }
                const requestedStatus = INTENTION_STATUSES.includes(raw.status) && !['parked','resolved','abandoned','stale'].includes(raw.status)
                    ? raw.status
                    : (current.parkedFromStatus || 'active');
                updates.status = requestedStatus;
                updates.parkedFromStatus = '';
                updates.parkedAtDay = null;
                updates.parkedAtMessage = null;
                updates.parkedReason = '';
                updates.parkedByIntentionId = '';
                updates.reactivatedAtDay = elapsedDay;
                updates.reactivatedAtMessage = mode === 'backfill' && Number.isInteger(evidenceMessage) ? evidenceMessage : messageCount;
                diagnostics.reactivated += 1;
            }
            if (operation === 'revise' && !updates.status) updates.status = 'revised';
            if (operation === 'progress' && !updates.progressStage) updates.progressStage = 'progressed';
            if (current.status === 'pending_review') {
                updates.status = 'pending_review';
                delete updates.progressStage;
                delete updates.progressNote;
            }
            if (current.status === 'parked' && updates.status && updates.status !== 'parked') {
                updates.parkedFromStatus = '';
                updates.parkedAtDay = null;
                updates.parkedAtMessage = null;
                updates.parkedReason = '';
                updates.parkedByIntentionId = '';
                updates.reactivatedAtDay = elapsedDay;
                updates.reactivatedAtMessage = mode === 'backfill' && Number.isInteger(evidenceMessage) ? evidenceMessage : messageCount;
            }
            const requestedType = normalizeModelType(raw.type, '');
            if (requestedType) updates.type = requestedType;
            const proposedDomain = normalizeModelDomain(raw.domain);
            if (proposedDomain) updates.domain = proposedDomain;
            if (typeof raw.description === 'string' && raw.description.trim() && !raw.objective) {
                updates.objective = raw.description.trim();
            }
            for (const field of ['objective','strategy','nextAction','progressNote','confidence','commitment']) {
                if (current.status === 'pending_review' && field === 'progressNote') continue;
                if (typeof raw[field] === 'string' && raw[field].trim()) updates[field] = raw[field].trim();
            }
            for (const field of ['triggerConditions','constraints','basis']) {
                const values = coerceStringList(raw[field], { splitDelimiters: field !== 'basis' });
                if (!values.length) continue;
                updates[field] = field === 'basis'
                    ? mergeModelLists(current.basis, values)
                    : values;
            }
            if (proposedBasis.length && !coerceStringList(raw?.basis).length) {
                updates.basis = mergeModelLists(current.basis, proposedBasis);
            }
            const resultingStatus = updates.status || current.status;
            const resultingProgress = updates.progressStage || current.progressStage;
            if (['failed', 'fulfilled'].includes(resultingProgress) && !['resolved', 'abandoned', 'stale', 'pending_review'].includes(resultingStatus)) {
                updates.status = 'resolved';
            }
            if (['resolved', 'abandoned', 'stale'].includes(updates.status || current.status)) updates.nextAction = '';
            const resultingType = updates.type || current.type;
            const resultingStrategy = String(updates.strategy || current.strategy || '').trim();
            if (updates.type && updates.type !== current.type && strategyRequiredForType(resultingType) && !resultingStrategy) {
                // Only a real type conversion can trigger this safeguard. An
                // ordinary update that omits `type` must never be interpreted as
                // a conversion to Active Plan.
                reject(actor, 'update', `${resultingType.replace('_', ' ')} type change missing strategy`, raw);
                delete updates.type;
            }
            if (!current.strategy && updates.strategy && strategyRequiredForType(resultingType)) {
                diagnostics.semanticRecoveries += 1;
            }
            if (current.locked) {
                for (const field of ['objective','strategy','nextAction','triggerConditions','constraints','basis','type','domain','actor','actorId']) {
                    delete updates[field];
                }
            }
            const relatedEventIds = coerceStringList(raw.relatedEventIds).filter(id => packet.eventIds.includes(id));
            const relatedCommunityIds = coerceStringList(raw.relatedCommunityIds).filter(id => packet.communityIds.includes(id));
            if (relatedEventIds.length) updates.relatedEventIds = relatedEventIds;
            if (relatedCommunityIds.length) updates.relatedCommunityIds = relatedCommunityIds;
            if (proposedEvidence.length) updates.evidenceRanges = [...(current.evidenceRanges || []), ...proposedEvidence].slice(-6);
            updates.lastReviewedDay = mode === 'backfill' ? current.lastReviewedDay : elapsedDay;
            updates.lastReviewedMessage = mode === 'backfill' && Number.isInteger(evidenceMessage) ? evidenceMessage : messageCount;
            const finalConsolidationOnly = implicitGroundingScope === 'final_consolidation' && !proposedEvidence.length;
            if (!finalConsolidationOnly && (proposedEvidence.length || proposedBasis.length || groundedByPacket || operation !== 'update')) {
                updates.lastReinforcedDay = mode === 'backfill' ? current.lastReinforcedDay : elapsedDay;
                updates.lastReinforcedMessage = Number.isInteger(evidenceMessage)
                    ? evidenceMessage
                    : (mode === 'backfill' ? current.lastReinforcedMessage : messageCount);
            }
            list[index] = normalizeHiddenIntention({ ...current, ...updates });
            changed.push(list[index].id);
            diagnostics.updatesApplied += 1;
        }

        const candidateEntries = [];
        for (const sourceRaw of normalizedItems.additions) {
            diagnostics.additionsSeen += 1;
            if (mode === 'reconcile') {
                reject(actor, 'addition', 'additions are not allowed during reconciliation', sourceRaw);
                continue;
            }
            const raw = recoverAdditionSemantics(sourceRaw);
            if (raw._semanticRecovery) diagnostics.semanticRecoveries += 1;
            const type = normalizeModelType(raw?.type);
            const objective = String(raw?.objective || '').trim();
            const strategy = String(raw?.strategy || '').trim();
            const nextAction = String(raw?.nextAction || '').trim();
            const triggerConditions = coerceStringList(raw?.triggerConditions, { splitDelimiters: true });
            const constraints = coerceStringList(raw?.constraints, { splitDelimiters: true });
            let evidence = normalizedEvidence(raw, packet);
            let basis = coerceStringList(raw?.basis);
            if (!evidence.length) evidence = segmentFallbackEvidence(raw, packet, mode);
            if (!basis.length && evidence.length) {
                basis = evidence.map(item => item.summary || `Narrative evidence M${item.start ?? '?'}–M${item.end ?? item.start ?? '?'}`);
            }
            const confidence = ['low','medium','high'].includes(raw?.confidence) ? raw.confidence : 'medium';
            if (!objective) { reject(actor, 'addition', 'missing objective', raw); continue; }
            if (type === 'commitment' && !nextAction
                && (PAST_ONLY_OBJECTIVE.test(objective) || SPECULATIVE_GROUNDING.test(objective))) {
                suppress(actor, 'addition', 'past or speculative support does not establish a bound future commitment', raw);
                continue;
            }
            if (basis.length === 0) { reject(actor, 'addition', 'missing grounding basis', raw); continue; }
            if (type === 'active_plan' && !nextAction) { reject(actor, 'addition', 'active plan missing next action', raw); continue; }
            if (strategyRequiredForType(type) && !strategy) {
                reject(actor, 'addition', `${type.replace('_', ' ')} missing strategy`, raw);
                continue;
            }
            if (type === 'commitment' && !nextAction) {
                reject(actor, 'addition', 'commitment missing next action', raw);
                continue;
            }
            if (type === 'contingency' && !triggerConditions.length) {
                reject(actor, 'addition', 'contingency missing trigger conditions', raw);
                continue;
            }
            const candidateShape = { type, domain: normalizeModelDomain(raw?.domain) || '', objective, strategy, nextAction };
            const duplicateStored = actorRecords().find(item => recordsSemanticallyDuplicate(registry, item, candidateShape));
            if (duplicateStored) {
                const duplicateIndex = list.findIndex(item => item.id === duplicateStored.id);
                if (duplicateIndex >= 0) {
                    const current = list[duplicateIndex];
                    const proposedProgress = INTENTION_PROGRESS.includes(raw?.progressStage) ? raw.progressStage : '';
                    const proposedNote = String(raw?.progressNote || raw?.evidenceSummary || '').trim();
                    const progressRank = { unattempted: 0, prepared: 1, attempted: 2, progressed: 3, blocked: 3, failed: 4, fulfilled: 5 };
                    const evidenceMessages = evidence.flatMap(item => [item?.start, item?.end]).filter(Number.isInteger);
                    const latestEvidenceMessage = evidenceMessages.length ? Math.max(...evidenceMessages) : null;
                    const merged = {
                        ...current,
                        basis: [...(current.basis || []), ...basis],
                        evidenceRanges: [...(current.evidenceRanges || []), ...evidence],
                        nextAction: current.nextAction || nextAction,
                        strategy: current.strategy || strategy,
                        confidence: CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[current.confidence] ? confidence : current.confidence,
                        commitment: CONFIDENCE_RANK[raw?.commitment] > CONFIDENCE_RANK[current.commitment] ? raw.commitment : current.commitment,
                        lastReviewedMessage: mode === 'backfill' ? current.lastReviewedMessage : messageCount,
                        lastReinforcedMessage: mode === 'backfill'
                            ? (latestEvidenceMessage ?? current.lastReinforcedMessage)
                            : messageCount
                    };
                    if (proposedNote && (progressRank[proposedProgress] ?? -1) >= (progressRank[current.progressStage] ?? 0)) {
                        merged.progressStage = proposedProgress || current.progressStage;
                        merged.progressNote = proposedNote;
                        if (['failed', 'fulfilled'].includes(merged.progressStage)) {
                            merged.status = 'resolved';
                            merged.nextAction = '';
                        }
                    }
                    list[duplicateIndex] = normalizeHiddenIntention(merged);
                    changed.push(current.id);
                    diagnostics.updatesApplied += 1;
                    diagnostics.duplicatesMerged += 1;
                    dlog(`[NWST HiddenIntentions] Merged duplicate addition into ${current.id} for ${actor.actor}.`);
                }
                continue;
            }
            const duplicateCandidate = candidateEntries.find(entry => recordsSemanticallyDuplicate(registry, entry.record, candidateShape));
            if (duplicateCandidate) {
                duplicateCandidate.record = normalizeHiddenIntention({
                    ...duplicateCandidate.record,
                    basis: [...(duplicateCandidate.record.basis || []), ...basis],
                    evidenceRanges: [...(duplicateCandidate.record.evidenceRanges || []), ...evidence],
                    nextAction: duplicateCandidate.record.nextAction || nextAction,
                    strategy: duplicateCandidate.record.strategy || strategy
                });
                diagnostics.duplicatesMerged += 1;
                continue;
            }
            const requiresReview = cfg.reviewNewIntentions === true;
            if (!requiresReview && CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[cfg.autoAddConfidence]) {
                // This is expected threshold behavior, not malformed model output.
                // Keep weak/speculative proposals out of the ledger without
                // inflating warning-level rejection counts.
                suppress(actor, 'addition', `confidence ${confidence} is below auto-add threshold ${cfg.autoAddConfidence}`, raw);
                continue;
            }
            const evidenceMessages = evidence.flatMap(item => [item?.start, item?.end]).filter(Number.isInteger);
            const evidenceMessage = evidenceMessages.length ? Math.max(...evidenceMessages) : null;
            const recordMessage = mode === 'backfill' && Number.isInteger(evidenceMessage) ? evidenceMessage : messageCount;
            const recordDay = mode === 'backfill' ? null : elapsedDay;
            const domainSeed = normalizeModelDomain(raw?.domain) || undefined;
            let initialProgress = 'unattempted';
            let initialProgressNote = '';
            let initialStatus = ['contingency', 'emerging_interest'].includes(type) ? 'latent' : 'active';
            if (mode === 'backfill') {
                const proposedProgress = INTENTION_PROGRESS.includes(raw?.progressStage) ? raw.progressStage : 'unattempted';
                const proposedNote = String(raw?.progressNote || raw?.evidenceSummary || '').trim();
                initialProgress = proposedProgress !== 'unattempted' && proposedNote ? proposedProgress : 'unattempted';
                initialProgressNote = initialProgress !== 'unattempted' ? proposedNote : '';
                const proposedStatus = INTENTION_STATUSES.includes(raw?.status) ? raw.status : '';
                if (proposedStatus && proposedStatus !== 'pending_review' && proposedStatus !== 'parked') initialStatus = proposedStatus;
                if (['failed', 'fulfilled'].includes(initialProgress) && !proposedStatus) initialStatus = 'resolved';
                if (initialProgress === 'blocked' && !proposedStatus) initialStatus = 'blocked';
            }
            const record = normalizeHiddenIntention({
                actorId,
                actor: actor.actor,
                type,
                domain: domainSeed,
                objective,
                strategy,
                nextAction: ['resolved', 'abandoned', 'stale'].includes(requiresReview ? 'pending_review' : initialStatus) ? '' : nextAction,
                triggerConditions,
                constraints,
                basis,
                status: requiresReview ? 'pending_review' : initialStatus,
                progressStage: initialProgress,
                progressNote: initialProgressNote,
                confidence,
                commitment: ['low','medium','high'].includes(raw.commitment) ? raw.commitment : 'medium',
                relatedEventIds: coerceStringList(raw.relatedEventIds).filter(id => packet.eventIds.includes(id)),
                relatedCommunityIds: coerceStringList(raw.relatedCommunityIds).filter(id => packet.communityIds.includes(id)),
                evidenceRanges: evidence,
                createdDay: recordDay,
                createdMessage: recordMessage,
                lastReviewedDay: recordDay,
                lastReviewedMessage: recordMessage,
                lastReinforcedDay: recordDay,
                lastReinforcedMessage: recordMessage,
                origin: 'generated'
            });
            candidateEntries.push({ record, raw });
        }

        const rebalanced = rebalanceActorWorkingSet({
            list,
            actor,
            candidates: candidateEntries,
            packet,
            cfg,
            messageCount,
            elapsedDay,
            diagnostics,
            changed,
            reject
        });
        list = rebalanced.list;

        if (mode === 'reconcile') {
            list = list.map(item => item.actorId === actorId
                ? normalizeHiddenIntention({ ...item, lastReviewedDay: elapsedDay, lastReviewedMessage: messageCount })
                : item);
        }
    }
    list = list.filter(item => !isPcActor(chatId, item.actorId, item.actor, registry));
    return { list, changed: changed.filter(id => list.some(item => item.id === id)), diagnostics };
}

function summarizeValidation(diagnostics = {}) {
    const mode = diagnostics.mode || 'reconcile';
    const seen = mode === 'generate' ? Number(diagnostics.additionsSeen || 0) : Number(diagnostics.updatesSeen || 0);
    const accepted = mode === 'generate' ? Number(diagnostics.additionsAccepted || 0) : Number(diagnostics.updatesApplied || 0);
    const rejected = Array.isArray(diagnostics.rejected) ? diagnostics.rejected : [];
    const unit = mode === 'generate' ? 'addition' : 'update';
    const parked = Number(diagnostics.parked || 0);
    const reactivated = Number(diagnostics.reactivated || 0);
    const merged = Number(diagnostics.duplicatesMerged || 0);
    const recovered = Number(diagnostics.semanticRecoveries || 0);
    const suppressed = Array.isArray(diagnostics.suppressed) ? diagnostics.suppressed.length : 0;
    if (!seen) {
        const base = mode === 'generate' ? 'No additions returned.' : 'No updates returned.';
        return `${base}${parked ? ` ${parked} record${parked === 1 ? '' : 's'} parked.` : ''}${reactivated ? ` ${reactivated} reactivated.` : ''}${merged ? ` ${merged} duplicate proposal${merged === 1 ? '' : 's'} merged.` : ''}${suppressed ? ` ${suppressed} non-record proposal${suppressed === 1 ? '' : 's'} ignored.` : ''}`;
    }
    const reasonCounts = new Map();
    for (const item of rejected) reasonCounts.set(item.reason, (reasonCounts.get(item.reason) || 0) + 1);
    const reasons = Array.from(reasonCounts.entries()).map(([reason, count]) => `${reason} (${count})`).join('; ');
    return `${accepted}/${seen} ${unit}${seen === 1 ? '' : 's'} accepted${parked ? `; ${parked} parked` : ''}${reactivated ? `; ${reactivated} reactivated` : ''}${merged ? `; ${merged} duplicate proposal${merged === 1 ? '' : 's'} merged` : ''}${recovered ? `; ${recovered} schema/semantic recover${recovered === 1 ? 'y' : 'ies'}` : ''}${suppressed ? `; ${suppressed} non-record proposal${suppressed === 1 ? '' : 's'} ignored` : ''}${rejected.length ? `; ${rejected.length} rejected: ${reasons}` : ''}.`;
}

function manualOperation(trigger) {
    return String(trigger || '').startsWith('manual_');
}

async function runHiddenIntentionsOperation({ mode = 'reconcile', trigger = 'manual_reconcile', expectedChatId = null, force = false, broad = false } = {}) {
    const cfg = getHiddenIntentionsConfig();
    if (!cfg.enabled && !force) return false;
    const chatId = expectedChatId || getChatId();
    if (!chatId || getChatId() !== chatId) return false;
    await purgeUserCharacterIntentions(chatId);
    await canonicalizeStoredIntentions(chatId);
    await enforceStoredWorkingSetCaps(chatId, cfg);
    let state = getHiddenIntentionsState(chatId);
    if (state.scanInProgress) {
        const locallyActive = activeHiddenIntentionsOperationChatIds.has(chatId) || activeBackfillChatId === chatId;
        const orphanedGenericLock = !state.backfillInProgress && !locallyActive;
        if (orphanedGenericLock) {
            state = {
                ...state,
                scanInProgress: false,
                lastError: 'Recovered an orphaned Hidden Intentions scan lock left by an interrupted or refreshed operation.'
            };
            await saveHiddenIntentionsState(chatId, state);
            dlog('[NWST HiddenIntentions] Recovered orphaned non-backfill scan lock before starting a new operation.');
        } else {
            if (manualOperation(trigger)) nwstToast('A Hidden Intentions operation is already running.', 'warning');
            return false;
        }
    }

    const trackableRecords = getHiddenIntentions(chatId).filter(trackableRecord);
    if (mode === 'reconcile' && !trackableRecords.length) {
        if (manualOperation(trigger)) nwstToast('There are no existing Hidden Intentions to reconcile. Use Generate new intentions first.', 'info');
        return false;
    }

    const actors = collectCandidateActors(chatId, trigger, state, cfg, mode, broad);
    if (!actors.length) {
        if (manualOperation(trigger)) {
            nwstToast(mode === 'generate'
                ? 'No eligible named NPCs were found for Hidden Intentions generation.'
                : 'No existing intention owners are eligible for reconciliation.', 'info');
        }
        return false;
    }

    const profile = resolveProfile('hiddenIntentionsLLM');
    if (!profile) {
        if (manualOperation(trigger)) nwstToast('No Hidden Intentions LLM profile is configured.', 'warning');
        return false;
    }

    await saveHiddenIntentionsState(chatId, { ...state, scanInProgress: true, lastError: '' });
    activeHiddenIntentionsOperationChatIds.add(chatId);
    try {
        let actorSplitCount = 0;
        const runActorBatch = async (batch) => {
            if (getChatId() !== chatId) throw Object.assign(new Error('Active chat changed.'), { code: 'CHAT_CHANGED' });
            const { prompt, packets } = buildPrompt(chatId, batch, cfg, trigger, mode);
            dlog(`[NWST HiddenIntentions] Running ${mode} (${trigger}) for: ${batch.map(a => a.actor).join(', ')}`);
            try {
                const result = await requestHiddenIntentionsJson({
                    profile,
                    systemPrompt: systemPromptForMode(mode),
                    userPrompt: prompt,
                    compactMode: mode,
                    maxTokens: LLM_TOKEN_BUDGETS.HIDDEN_INTENTIONS_PRIMARY,
                    compactMaxTokens: LLM_TOKEN_BUDGETS.MEDIUM
                });
                if (getChatId() !== chatId) throw Object.assign(new Error('Active chat changed.'), { code: 'CHAT_CHANGED' });
                return { ...result, packets };
            } catch (error) {
                if (error?.code === 'CHAT_CHANGED') throw error;
                if (batch.length > 1) {
                    actorSplitCount += 1;
                    const middle = Math.ceil(batch.length / 2);
                    dlog(`[NWST HiddenIntentions] Splitting ${mode} actor batch after ${error.code || 'response failure'}: ${batch.length} -> ${middle}+${batch.length - middle}.`);
                    const left = await runActorBatch(batch.slice(0, middle));
                    const right = await runActorBatch(batch.slice(middle));
                    return {
                        parsed: mergeActorPayloads([left.parsed, right.parsed]),
                        packets: mergePacketMaps([left.packets, right.packets]),
                        recovery: [left.recovery, right.recovery, 'actor-split'].filter(Boolean).join('; ')
                    };
                }
                throw error;
            }
        };

        const batchResult = await runActorBatch(actors);
        if (getChatId() !== chatId) {
            const staleState = getHiddenIntentionsState(chatId);
            staleState.scanInProgress = false;
            staleState.lastError = `Active chat changed during Hidden Intentions ${mode}; stale result discarded.`;
            await saveHiddenIntentionsState(chatId, staleState);
            return false;
        }
        const applied = applyModelResult(chatId, actors, batchResult.parsed, batchResult.packets, cfg, mode);
        await saveHiddenIntentions(chatId, applied.list);

        const latestState = getHiddenIntentionsState(chatId);
        const scannedIds = new Set(actors.map(a => a.actorId));
        latestState.dirtyActors = (latestState.dirtyActors || []).filter(item => !scannedIds.has(item.actorId));
        latestState.worldDirty = false;
        latestState.reasons = latestState.dirtyActors.length ? latestState.reasons : [];
        latestState.lastScanMessageCount = currentMessageCount();
        latestState.lastScanElapsedDay = currentElapsedDay(chatId);
        latestState.lastScanAt = Date.now();
        latestState.cooldownUntilMessage = currentMessageCount() + cfg.cooldownMessages;
        latestState.lastScannedActorIds = actors.map(a => a.actorId);
        latestState.lastScanTrigger = `${mode}:${trigger}`;
        latestState.lastJsonRecovery = [batchResult.recovery || '', actorSplitCount ? `${actorSplitCount} actor split${actorSplitCount === 1 ? '' : 's'}` : ''].filter(Boolean).join('; ');
        latestState.lastValidationSummary = summarizeValidation(applied.diagnostics);
        latestState.lastWorkingSetRotations = (applied.diagnostics.rotations || []).slice(-20);
        latestState.lastError = '';
        latestState.scanInProgress = false;
        await saveHiddenIntentionsState(chatId, latestState);

        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('notebook');
        const result = {
            ran: true,
            mode,
            trigger,
            actorsScanned: actors.length,
            created: Number(applied.diagnostics.additionsAccepted || 0),
            updated: Number(applied.diagnostics.updatesApplied || 0),
            parked: Number(applied.diagnostics.parked || 0),
            reactivated: Number(applied.diagnostics.reactivated || 0),
            rejected: applied.diagnostics.rejected?.length || 0,
            changedIds: applied.changed,
            validation: latestState.lastValidationSummary,
            recovery: latestState.lastJsonRecovery || ''
        };
        if (manualOperation(trigger)) {
            const recoveryNote = result.recovery ? ' Automatic compact recovery was used.' : '';
            if (mode === 'generate') {
                if (result.created || result.parked) nwstToast(`Generated ${result.created} new Hidden Intention${result.created === 1 ? '' : 's'}${result.parked ? ` and parked ${result.parked} older record${result.parked === 1 ? '' : 's'}` : ''} across ${result.actorsScanned} NPC${result.actorsScanned === 1 ? '' : 's'}.${recoveryNote}`, 'success');
                else if (result.rejected) nwstToast(`Generation completed, but ${result.rejected} proposed record${result.rejected === 1 ? ' was' : 's were'} rejected. Check the status report.`, 'warning');
                else nwstToast(`Generation reviewed ${result.actorsScanned} NPC${result.actorsScanned === 1 ? '' : 's'}; no new grounded records were found.${recoveryNote}`, 'info');
            } else {
                if (result.updated || result.parked || result.reactivated) nwstToast(`Reconciled Hidden Intentions: ${result.updated} updated${result.parked ? `, ${result.parked} parked` : ''}${result.reactivated ? `, ${result.reactivated} reactivated` : ''} across ${result.actorsScanned} NPC${result.actorsScanned === 1 ? '' : 's'}.${recoveryNote}`, 'success');
                else if (result.rejected) nwstToast(`Reconciliation completed, but ${result.rejected} proposed update${result.rejected === 1 ? ' was' : 's were'} rejected. Check the status report.`, 'warning');
                else nwstToast(`Reconciliation reviewed ${result.actorsScanned} NPC${result.actorsScanned === 1 ? '' : 's'}; no existing records changed.${recoveryNote}`, 'info');
            }
        }
        return result;
    } catch (e) {
        console.error(`[NWST HiddenIntentions] ${mode} failed:`, e);
        const latest = getHiddenIntentionsState(chatId);
        latest.scanInProgress = false;
        latest.lastError = e?.message || String(e);
        if (/invalid JSON/i.test(latest.lastError)) latest.lastJsonRecovery = 'failed';
        await saveHiddenIntentionsState(chatId, latest);
        if (manualOperation(trigger)) nwstToast(`Hidden Intentions ${mode} failed: ${latest.lastError}`, 'error');
        return false;
    } finally {
        activeHiddenIntentionsOperationChatIds.delete(chatId);
    }
}

export async function requestHiddenIntentionsBackfillPause(chatId = null) {
    const id = chatId || getChatId();
    if (!id) return false;
    const state = getHiddenIntentionsState(id);
    if (!state.backfillInProgress || !state.scanInProgress) return false;
    await saveHiddenIntentionsState(id, {
        ...state,
        backfillPauseRequested: true,
        lastError: ''
    });
    nwstToast('Hidden Intentions backfill will pause after the current in-flight request or transactional segment. Completed work will remain saved.', 'info');
    return true;
}

export async function runHiddenIntentionsBackfill({ expectedChatId = null, force = true } = {}) {
    const cfg = getHiddenIntentionsConfig();
    if (!cfg.enabled && !force) return false;
    const chatId = expectedChatId || getChatId();
    if (!chatId || getChatId() !== chatId) return false;

    let liveState = getHiddenIntentionsState(chatId);
    const locallyActive = activeHiddenIntentionsOperationChatIds.has(chatId) || activeBackfillChatId === chatId;
    const orphanedGenericLock = liveState.scanInProgress && !liveState.backfillInProgress && !locallyActive;
    const orphanedBackfillFlag = !liveState.scanInProgress && liveState.backfillInProgress && activeBackfillChatId !== chatId;

    if (orphanedGenericLock || orphanedBackfillFlag) {
        liveState = {
            ...liveState,
            scanInProgress: false,
            backfillInProgress: false,
            backfillPauseRequested: false,
            lastError: orphanedGenericLock
                ? 'Recovered an orphaned Hidden Intentions scan lock left by an interrupted or refreshed operation.'
                : 'Recovered an orphaned Hidden Intentions backfill flag and preserved any saved checkpoint.'
        };
        await saveHiddenIntentionsState(chatId, liveState);
        dlog(`[NWST HiddenIntentions] ${liveState.lastError}`);
        nwstToast('Recovered a stale Hidden Intentions operation lock. Starting the requested backfill now.', 'info');
    }

    const staleBackfillLock = liveState.scanInProgress && liveState.backfillInProgress && activeBackfillChatId !== chatId;
    if (liveState.scanInProgress && !staleBackfillLock) {
        nwstToast('A Hidden Intentions operation is already running.', 'warning');
        return false;
    }

    const profile = resolveProfile('hiddenIntentionsLLM');
    if (!profile) {
        nwstToast('No Hidden Intentions LLM profile is configured.', 'warning');
        return false;
    }

    const visibleMessages = getVisibleChatMessages();
    if (!visibleMessages.length) {
        nwstToast('No visible chat messages are available for Hidden Intentions backfill.', 'info');
        return false;
    }

    let messageChunks = chunkVisibleMessagesForBackfill(visibleMessages, BACKFILL_NARRATIVE_CHAR_TARGET);
    let signature = backfillPlanSignature(visibleMessages, messageChunks);
    let totalHistoryChunks = messageChunks.length;

    const durableCheckpoint = getHiddenIntentionsBackfillCheckpoint(chatId);
    const repairBackup = getHiddenIntentionsRepairBackup(chatId);
    const selectedCheckpoint = chooseBestBackfillCheckpoint(chatId, liveState, visibleMessages, messageChunks, signature);
    if (selectedCheckpoint?.compatibility?.appendCompatible) {
        const reconstructed = rebuildChunksFromCheckpoint(visibleMessages, selectedCheckpoint.state);
        if (reconstructed?.length) {
            messageChunks = reconstructed;
            signature = backfillPlanSignature(visibleMessages, messageChunks);
            totalHistoryChunks = messageChunks.length;
            selectedCheckpoint.compatibility = checkpointCompatibility(selectedCheckpoint.state, visibleMessages, messageChunks, signature);
        }
    }
    const priorStates = [liveState, durableCheckpoint?.runtimeState, repairBackup?.runtimeState].filter(Boolean);
    const priorSuccessfulMax = Math.max(0, ...priorStates.map(state => Array.isArray(state.backfillSuccessfulSegments) ? state.backfillSuccessfulSegments.length : 0));

    // Never silently convert a paid partial backfill into a fresh run. If no
    // current or saved checkpoint can be mapped safely, stop before making a
    // provider call and preserve the state for inspection.
    if (!selectedCheckpoint && priorSuccessfulMax > 0) {
        const message = 'Hidden Intentions found prior backfill progress, but its message ranges no longer match this chat. The run was not restarted and no LLM call was made.';
        await saveHiddenIntentionsState(chatId, {
            ...liveState,
            scanInProgress: false,
            backfillInProgress: false,
            backfillPauseRequested: false,
            lastError: message
        });
        nwstToast(message, 'error');
        return false;
    }

    let initialState = selectedCheckpoint?.state ? { ...selectedCheckpoint.state } : liveState;
    const selectedSuccessful = selectedCheckpoint?.compatibility?.successful || [];
    const liveCompatibility = checkpointCompatibility(liveState, visibleMessages, messageChunks, signature);
    const selectedIsAhead = selectedSuccessful.length > (liveCompatibility.successful || []).length;

    // A dedicated transactional checkpoint includes the exact ledger at that
    // segment boundary. Restore it only when it is ahead of live state. Repair
    // backups are used for runtime salvage only because their ledger may be the
    // intentionally pre-repair copy.
    if (selectedCheckpoint?.source === 'durable_checkpoint' && selectedIsAhead && Array.isArray(selectedCheckpoint.intentions)) {
        await saveHiddenIntentions(chatId, selectedCheckpoint.intentions);
    }

    if (staleBackfillLock || initialState.scanInProgress || initialState.backfillInProgress) {
        initialState = {
            ...initialState,
            scanInProgress: false,
            backfillInProgress: false,
            backfillPauseRequested: false,
            lastError: 'Recovered an interrupted Hidden Intentions backfill lock and preserved the saved checkpoint.'
        };
        await saveHiddenIntentionsState(chatId, initialState);
    }

    await purgeUserCharacterIntentions(chatId);
    await canonicalizeStoredIntentions(chatId);
    const initialCapResult = await enforceStoredWorkingSetCaps(chatId, cfg);

    const compatibility = selectedCheckpoint?.compatibility || checkpointCompatibility(initialState, visibleMessages, messageChunks, signature);
    const storedSuccessfulSegments = compatibility.compatible
        ? compatibility.successful.filter(index => index >= 0 && index < totalHistoryChunks)
        : [];
    const storedFailures = compatibility.compatible && Array.isArray(initialState.backfillFailedSegments)
        ? initialState.backfillFailedSegments.filter(item => item && Number.isInteger(item.segmentIndex) && item.segmentIndex >= 0 && item.segmentIndex < totalHistoryChunks && !storedSuccessfulSegments.includes(item.segmentIndex))
        : [];
    const completedSamePlan = compatibility.exact
        && storedSuccessfulSegments.length >= totalHistoryChunks
        && !storedFailures.length
        && initialState.backfillFinalPassCompleted === true
        && initialState.backfillInProgress !== true;

    // A completed matching backfill is a no-op. Starting it over now requires
    // explicitly clearing the ledger/checkpoint instead of one accidental click.
    if (completedSamePlan) {
        nwstToast('Hidden Intentions backfill is already complete for this chat. No LLM calls were made.', 'info');
        return false;
    }

    const resumePlan = compatibility.compatible && (
        storedSuccessfulSegments.length > 0
        || Number(initialState.backfillSourceMessageCount || 0) > 0
        || compatibility.appendCompatible
    );
    const successfulSegments = new Set(resumePlan ? storedSuccessfulSegments : []);
    let failures = resumePlan ? storedFailures : [];

    // Retry failed ranges and continue into never-attempted ranges in the same
    // run. A transport pause must not require one click for the failed segment
    // and a second click for everything that came after it.
    const segmentIndexes = Array.from({ length: totalHistoryChunks }, (_, index) => index)
        .filter(index => !successfulSegments.has(index));

    const startedAt = Date.now();
    activeBackfillChatId = chatId;
    const continuing = resumePlan;
    let created = continuing ? Number(initialState.backfillCreated || 0) : 0;
    let updated = continuing ? Number(initialState.backfillUpdated || 0) : 0;
    let parked = continuing ? Number(initialState.backfillParked || 0) : Number(initialCapResult.parked || 0);
    let reactivated = continuing ? Number(initialState.backfillReactivated || 0) : 0;
    let rejected = continuing ? Number(initialState.backfillRejected || 0) : 0;
    let recoveryCount = continuing ? Number(initialState.backfillJsonRecoveries || 0) : 0;
    let compactRetryCount = continuing ? Number(initialState.backfillCompactRetries || 0) : 0;
    let reasoningExhaustionCount = continuing ? Number(initialState.backfillReasoningExhaustions || 0) : 0;
    let actorSplitCount = continuing ? Number(initialState.backfillActorSplits || 0) : 0;
    let narrativeSplitCount = continuing ? Number(initialState.backfillNarrativeSplits || 0) : 0;
    let rollbackCount = continuing ? Number(initialState.backfillRollbacks || 0) : 0;
    let proactiveActorBatchCount = continuing ? Number(initialState.backfillProactiveActorBatches || 0) : 0;
    let proactiveNarrativeBatchCount = continuing ? Number(initialState.backfillProactiveNarrativeBatches || 0) : 0;
    let recoveryIncidents = continuing && Array.isArray(initialState.backfillRecoveryIncidents) ? [...initialState.backfillRecoveryIncidents] : [];
    let pausedByUser = false;
    let activeSegmentCallStart = 0;
    let completedCalls = continuing ? Number(initialState.backfillCompletedCalls || 0) : 0;
    let emptySegments = continuing ? Number(initialState.backfillEmptySegments || 0) : 0;
    let skippedSegments = continuing ? Number(initialState.backfillSkippedSegments || 0) : 0;
    const uniqueActors = new Set(continuing ? (initialState.lastScannedActorIds || []) : []);
    const rotations = continuing ? [...(initialState.lastWorkingSetRotations || [])] : [...(initialCapResult.rotations || [])];
    let recoveryAbort = false;

    const baselineCalls = segmentIndexes.length;
    await saveHiddenIntentionsState(chatId, {
        ...initialState,
        scanInProgress: true,
        backfillInProgress: true,
        backfillPlanVersion: BACKFILL_PLAN_VERSION,
        backfillPlanSignature: signature,
        backfillSourceMessageCount: visibleMessages.length,
        backfillNarrativeCharTarget: BACKFILL_NARRATIVE_CHAR_TARGET,
        backfillRequestCharLimit: BACKFILL_REQUEST_CHAR_LIMIT,
        backfillTotalChunks: totalHistoryChunks,
        backfillCompletedChunks: successfulSegments.size,
        backfillSuccessfulSegments: Array.from(successfulSegments).sort((a, b) => a - b),
        backfillTotalBatches: baselineCalls,
        backfillPlannedCalls: baselineCalls,
        backfillCompletedBatches: completedCalls,
        backfillCompletedCalls: completedCalls,
        backfillNextChunk: segmentIndexes[0] ?? totalHistoryChunks,
        backfillFinalPassCompleted: false,
        backfillMessagesScanned: Array.from(successfulSegments).reduce((sum, index) => sum + (messageChunks[index]?.length || 0), 0),
        backfillActorsScanned: uniqueActors.size,
        backfillCreated: created,
        backfillUpdated: updated,
        backfillParked: parked,
        backfillReactivated: reactivated,
        backfillRejected: rejected,
        backfillFailedBatches: failures.length,
        backfillFailedSegments: failures,
        backfillEmptySegments: emptySegments,
        backfillSkippedSegments: skippedSegments,
        backfillJsonRecoveries: recoveryCount,
        backfillCompactRetries: compactRetryCount,
        backfillReasoningExhaustions: reasoningExhaustionCount,
        backfillActorSplits: actorSplitCount,
        backfillNarrativeSplits: narrativeSplitCount,
        backfillRollbacks: rollbackCount,
        backfillProactiveActorBatches: proactiveActorBatchCount,
        backfillProactiveNarrativeBatches: proactiveNarrativeBatchCount,
        backfillRecoveryIncidents: recoveryIncidents,
        backfillPauseRequested: false,
        backfillPausedByUser: false,
        backfillStartedAt: startedAt,
        backfillFinishedAt: 0,
        backfillSummary: '',
        lastError: ''
    });

    await saveHiddenIntentionsBackfillCheckpoint(chatId, {
        intentions: getHiddenIntentions(chatId),
        runtimeState: getHiddenIntentionsState(chatId),
        source: selectedCheckpoint?.source === 'repair_backup' ? 'repair_checkpoint_recovery' : (continuing ? 'resume_start' : 'run_start')
    });

    const appendedResume = Boolean(compatibility.appendCompatible && Number(compatibility.priorSourceCount || 0) < visibleMessages.length);
    const checkpointNote = selectedCheckpoint?.source === 'repair_backup'
        ? ' Recovered the saved pre-repair runtime checkpoint.'
        : selectedCheckpoint?.source === 'durable_checkpoint'
            ? ' Recovered the latest transactional checkpoint.'
            : '';
    nwstToast(`Hidden Intentions backfill ${continuing ? 'resuming' : 'starting'}: ${successfulSegments.size}/${totalHistoryChunks} segments already complete; ${visibleMessages.length} visible messages.${appendedResume ? ' Newer appended messages were added without invalidating completed ranges.' : ''}${checkpointNote}`, 'info');

    const persistProgress = async () => {
        const state = getHiddenIntentionsState(chatId);
        const successful = Array.from(successfulSegments).sort((a, b) => a - b);
        const next = Array.from({ length: totalHistoryChunks }, (_, index) => index).find(index => !successfulSegments.has(index)) ?? totalHistoryChunks;
        await saveHiddenIntentionsState(chatId, {
            ...state,
            scanInProgress: true,
            backfillInProgress: true,
            backfillSuccessfulSegments: successful,
            backfillCompletedChunks: successful.length,
            backfillNextChunk: next,
            backfillCompletedBatches: completedCalls,
            backfillCompletedCalls: completedCalls,
            backfillMessagesScanned: successful.reduce((sum, index) => sum + (messageChunks[index]?.length || 0), 0),
            backfillActorsScanned: uniqueActors.size,
            backfillCreated: created,
            backfillUpdated: updated,
            backfillParked: parked,
            backfillReactivated: reactivated,
            backfillRejected: rejected,
            backfillFailedBatches: failures.length,
            backfillFailedSegments: failures.slice(-30),
            backfillEmptySegments: emptySegments,
            backfillSkippedSegments: skippedSegments,
            backfillJsonRecoveries: recoveryCount,
            backfillCompactRetries: compactRetryCount,
            backfillReasoningExhaustions: reasoningExhaustionCount,
            backfillActorSplits: actorSplitCount,
            backfillNarrativeSplits: narrativeSplitCount,
            backfillRollbacks: rollbackCount,
            backfillProactiveActorBatches: proactiveActorBatchCount,
            backfillProactiveNarrativeBatches: proactiveNarrativeBatchCount,
            backfillRecoveryIncidents: recoveryIncidents.slice(-20),
            lastWorkingSetRotations: rotations.slice(-20)
        });
        await saveHiddenIntentionsBackfillCheckpoint(chatId, {
            intentions: getHiddenIntentions(chatId),
            runtimeState: getHiddenIntentionsState(chatId),
            source: 'transactional_progress'
        });
    };

    const cancelForChatChange = async () => {
        const state = getHiddenIntentionsState(chatId);
        const next = Number(state.backfillNextChunk || 0);
        const summary = `Paused after ${completedCalls} LLM call${completedCalls === 1 ? '' : 's'} because the active chat changed. Resume begins at history segment ${Math.min(totalHistoryChunks, next) + 1}.`;
        await saveHiddenIntentionsState(chatId, {
            ...state,
            scanInProgress: false,
            backfillInProgress: false,
            backfillFinishedAt: Date.now(),
            backfillSummary: summary,
            lastError: summary
        });
        activeBackfillChatId = null;
        nwstToast('Hidden Intentions backfill paused because the active chat changed. Completed segments were saved.', 'warning');
        return false;
    };

    const pauseRequested = () => getHiddenIntentionsState(chatId).backfillPauseRequested === true;
    const pauseError = () => Object.assign(new Error('Hidden Intentions backfill pause requested.'), { code: 'PAUSE_REQUESTED' });
    const segmentCallBudgetExceeded = () => completedCalls - activeSegmentCallStart >= BACKFILL_MAX_CALLS_PER_SEGMENT;
    const segmentCallBudgetError = () => Object.assign(
        new Error(`Hidden Intentions recovery reached the ${BACKFILL_MAX_CALLS_PER_SEGMENT}-call safety limit for one chronological segment.`),
        { code: 'SEGMENT_CALL_LIMIT' }
    );
    const noteRecoveryIncident = (incident = {}, context = {}) => {
        recoveryIncidents.push({
            at: Date.now(),
            phase: String(context.phase || 'segment'),
            range: String(context.range || ''),
            actors: Array.isArray(context.actors) ? context.actors.slice(0, 8) : [],
            reason: String(incident.reason || 'MODEL_RESPONSE_FAILURE'),
            finishReason: String(incident.finishReason || ''),
            visibleChars: Number(incident.visibleChars || 0),
            reasoningChars: Number(incident.reasoningChars || 0),
            requestChars: Number(incident.requestChars || 0)
        });
        recoveryIncidents = recoveryIncidents.slice(-20);
    };

    const noteBackfillAttempt = (detailed, label) => {
        completedCalls += 1;
        if (label === 'compact') compactRetryCount += 1;
        if (detailed?.reasoningExhausted) reasoningExhaustionCount += 1;
    };

    const runBackfillActorBatch = async (actors, chunk, meta) => {
        if (getChatId() !== chatId) throw Object.assign(new Error('Active chat changed.'), { code: 'CHAT_CHANGED' });
        if (pauseRequested()) throw pauseError();
        if (segmentCallBudgetExceeded()) throw segmentCallBudgetError();
        if (!actors.length) return { parsed: { actors: [] }, packets: new Map(), recovery: '' };
        const proactiveLimit = Math.max(1, Math.min(BACKFILL_MAX_ACTORS_PER_REQUEST, Number(cfg.maxActorsPerScan || BACKFILL_MAX_ACTORS_PER_REQUEST)));
        if (actors.length > proactiveLimit) {
            const groups = [];
            for (let i = 0; i < actors.length; i += proactiveLimit) groups.push(actors.slice(i, i + proactiveLimit));
            proactiveActorBatchCount += groups.length;
            const results = [];
            for (const group of groups) {
                if (pauseRequested()) throw pauseError();
                if (segmentCallBudgetExceeded()) throw segmentCallBudgetError();
                results.push(await runBackfillActorBatch(group, chunk, meta));
            }
            return {
                parsed: mergeActorPayloads(results.map(item => item.parsed)),
                packets: mergePacketMaps(results.map(item => item.packets)),
                recovery: [...results.map(item => item.recovery).filter(Boolean), 'proactive-actor-batching'].join('; ')
            };
        }
        const { prompt, packets } = buildBackfillSegmentPrompt(chatId, actors, chunk, cfg, meta);
        const requestChars = backfillRequestChars(BACKFILL_SYSTEM_PROMPT, prompt);
        const first = chunk[0]?._nwstIndex;
        const last = chunk[chunk.length - 1]?._nwstIndex;

        if (requestChars > BACKFILL_REQUEST_CHAR_LIMIT) {
            if (actors.length > 1) {
                actorSplitCount += 1;
                const middle = Math.ceil(actors.length / 2);
                dlog(`[NWST HiddenIntentions] Splitting oversized actor roster for M${first}–M${last}: ${actors.length} -> ${middle}+${actors.length - middle}.`);
                const left = await runBackfillActorBatch(actors.slice(0, middle), chunk, meta);
                if (pauseRequested()) throw pauseError();
                const right = await runBackfillActorBatch(actors.slice(middle), chunk, meta);
                return {
                    parsed: mergeActorPayloads([left.parsed, right.parsed]),
                    packets: mergePacketMaps([left.packets, right.packets]),
                    recovery: [left.recovery, right.recovery, 'actor-split'].filter(Boolean).join('; ')
                };
            }
            const error = new Error(`Backfill request for ${actors[0]?.actor || 'actor'} exceeds the ${BACKFILL_REQUEST_CHAR_LIMIT}-character safety limit.`);
            error.code = 'REQUEST_TOO_LARGE';
            error.requestChars = requestChars;
            throw error;
        }

        dlog(`[NWST HiddenIntentions] Sparse backfill M${first}–M${last}: ${actors.map(actor => actor.actor).join(', ')} | request=${requestChars} chars`);
        try {
            const result = await requestHiddenIntentionsJson({
                profile,
                systemPrompt: BACKFILL_SYSTEM_PROMPT,
                userPrompt: prompt,
                compactMode: 'backfill',
                maxTokens: LLM_TOKEN_BUDGETS.HIDDEN_INTENTIONS_PRIMARY,
                compactMaxTokens: LLM_TOKEN_BUDGETS.MEDIUM,
                onAttempt: noteBackfillAttempt,
                abortCheck: () => pauseRequested()
                    ? pauseError()
                    : (segmentCallBudgetExceeded() ? segmentCallBudgetError() : null),
                onRecovery: incident => noteRecoveryIncident(incident, {
                    phase: 'segment',
                    range: `M${first}–M${last}`,
                    actors: actors.map(actor => actor.actor)
                })
            });
            if (getChatId() !== chatId) throw Object.assign(new Error('Active chat changed.'), { code: 'CHAT_CHANGED' });
            if (String(result.recovery || '').includes('local-no-cost')) recoveryCount += 1;
            return { ...result, packets };
        } catch (error) {
            if (['CHAT_CHANGED', 'PAUSE_REQUESTED', 'SEGMENT_CALL_LIMIT'].includes(error?.code)) throw error;
            error.requestChars = Number(error.requestChars || requestChars);
            if (actors.length > 1) {
                actorSplitCount += 1;
                const middle = Math.ceil(actors.length / 2);
                console.warn(`[NWST HiddenIntentions] ${error.code || 'Model response failure'} for M${first}–M${last}. Retrying as ${middle}+${actors.length - middle} actor batches.`);
                const left = await runBackfillActorBatch(actors.slice(0, middle), chunk, meta);
                if (pauseRequested()) throw pauseError();
                const right = await runBackfillActorBatch(actors.slice(middle), chunk, meta);
                return {
                    parsed: mergeActorPayloads([left.parsed, right.parsed]),
                    packets: mergePacketMaps([left.packets, right.packets]),
                    recovery: [left.recovery, right.recovery, 'actor-split'].filter(Boolean).join('; ')
                };
            }
            throw error;
        }
    };

    const applyPart = async (chunk, parentSegmentIndex, depth = 0) => {
        if (getChatId() !== chatId) throw Object.assign(new Error('Active chat changed.'), { code: 'CHAT_CHANGED' });
        if (pauseRequested()) throw pauseError();
        if (segmentCallBudgetExceeded()) throw segmentCallBudgetError();
        const narrativeChars = (chunk || []).reduce((sum, msg) => sum + compactBackfillMessageText(msg).length + 1, 0);
        if (depth === 0 && narrativeChars > BACKFILL_PROACTIVE_NARRATIVE_CHAR_TARGET && chunk.length > 1) {
            const parts = splitBackfillChunkBalanced(chunk);
            proactiveNarrativeBatchCount += parts.length;
            let actorCount = 0;
            for (const part of parts) {
                if (pauseRequested()) throw pauseError();
                if (segmentCallBudgetExceeded()) throw segmentCallBudgetError();
                const result = await applyPart(part, parentSegmentIndex, depth + 1);
                actorCount += result.actors;
            }
            return { actors: actorCount };
        }
        const registry = buildAliasRegistry(chatId);
        const actors = collectBackfillActorsFromWindow(chatId, chunk, registry);
        if (!actors.length) {
            skippedSegments += 1;
            return { actors: 0 };
        }
        const first = chunk[0]?._nwstIndex;
        const last = chunk[chunk.length - 1]?._nwstIndex;
        const meta = {
            chunkIndex: parentSegmentIndex + 1,
            totalChunks: totalHistoryChunks,
            startMessage: Number.isInteger(first) ? first : null,
            endMessage: Number.isInteger(last) ? last : null
        };

        let batchResult;
        try {
            batchResult = await runBackfillActorBatch(actors, chunk, meta);
        } catch (error) {
            if (['CHAT_CHANGED', 'PAUSE_REQUESTED', 'SEGMENT_CALL_LIMIT'].includes(error?.code)) throw error;
            if (depth < BACKFILL_NARRATIVE_RETRY_DEPTH && chunk.length > 1) {
                narrativeSplitCount += 1;
                const parts = splitBackfillChunkBalanced(chunk);
                console.warn(`[NWST HiddenIntentions] ${error.code || 'Model response failure'} for M${first}–M${last}. Retrying as ${parts.length} smaller chronological ranges.`);
                let actorCount = 0;
                for (const part of parts) {
                    const result = await applyPart(part, parentSegmentIndex, depth + 1);
                    actorCount += result.actors;
                }
                return { actors: actorCount };
            }
            throw error;
        }

        actors.forEach(actor => uniqueActors.add(actor.actorId));
        if (!(batchResult.parsed.actors || []).length) emptySegments += 1;
        const applied = applyModelResult(chatId, actors, batchResult.parsed, batchResult.packets, cfg, 'backfill');
        await saveHiddenIntentions(chatId, applied.list);
        await canonicalizeStoredIntentions(chatId);
        created += Number(applied.diagnostics.additionsAccepted || 0);
        updated += Number(applied.diagnostics.updatesApplied || 0);
        parked += Number(applied.diagnostics.parked || 0);
        reactivated += Number(applied.diagnostics.reactivated || 0);
        rejected += applied.diagnostics.rejected?.length || 0;
        rotations.push(...(applied.diagnostics.rotations || []));
        return { actors: actors.length };
    };

    // Final lifecycle cleanup is deterministic and token-free. The manual repair button uses the same engine.

    try {
        for (const segmentIndex of segmentIndexes) {
            if (getChatId() !== chatId) return cancelForChatChange();
            if (pauseRequested()) { pausedByUser = true; break; }
            activeSegmentCallStart = completedCalls;
            const chunk = messageChunks[segmentIndex];
            const first = chunk[0]?._nwstIndex;
            const last = chunk[chunk.length - 1]?._nwstIndex;
            nwstToast(`Backfilling Hidden Intentions segment ${segmentIndex + 1}/${totalHistoryChunks} (M${first}–M${last})...`, 'info');
            const intentionsSnapshot = getHiddenIntentions(chatId);
            const redirectsSnapshot = { ...(getHiddenIntentionsState(chatId).recordIdRedirects || {}) };
            const metricsSnapshot = { created, updated, parked, reactivated, rejected, emptySegments, skippedSegments };
            const actorSnapshot = Array.from(uniqueActors);
            const rotationLength = rotations.length;
            try {
                await applyPart(chunk, segmentIndex, 0);
                successfulSegments.add(segmentIndex);
                failures = failures.filter(item => item.segmentIndex !== segmentIndex);
                await persistProgress();
                if (pauseRequested()) { pausedByUser = true; break; }
            } catch (segmentError) {
                // A chronological segment is one transaction even when internal
                // actor or narrative splitting was required. Roll back every
                // partial sub-result before preserving the checkpoint.
                await saveHiddenIntentions(chatId, intentionsSnapshot);
                await saveHiddenIntentionsState(chatId, {
                    ...getHiddenIntentionsState(chatId),
                    recordIdRedirects: redirectsSnapshot
                });
                created = metricsSnapshot.created;
                updated = metricsSnapshot.updated;
                parked = metricsSnapshot.parked;
                reactivated = metricsSnapshot.reactivated;
                rejected = metricsSnapshot.rejected;
                emptySegments = metricsSnapshot.emptySegments;
                skippedSegments = metricsSnapshot.skippedSegments;
                uniqueActors.clear();
                actorSnapshot.forEach(actorId => uniqueActors.add(actorId));
                rotations.splice(rotationLength);
                rollbackCount += 1;
                if (segmentError?.code === 'PAUSE_REQUESTED') {
                    pausedByUser = true;
                    await persistProgress();
                    break;
                }
                if (segmentError?.code === 'CHAT_CHANGED') {
                    await persistProgress();
                    return cancelForChatChange();
                }
                const failure = {
                    segmentIndex,
                    startMessage: Number.isInteger(first) ? first : null,
                    endMessage: Number.isInteger(last) ? last : null,
                    code: String(segmentError?.code || 'MODEL_RESPONSE_FAILURE'),
                    error: String(segmentError?.message || segmentError).slice(0, 700),
                    responsePreview: String(segmentError?.responsePreview || '').slice(0, 1200),
                    requestChars: Number(segmentError?.requestChars || 0),
                    reasoningChars: Number(segmentError?.reasoningChars || 0),
                    finishReason: String(segmentError?.finishReason || '').slice(0, 120),
                    failedAt: Date.now()
                };
                failures = [...failures.filter(item => item.segmentIndex !== segmentIndex), failure].slice(-30);
                await persistProgress();
                console.warn(`[NWST HiddenIntentions] Backfill segment ${segmentIndex + 1}/${totalHistoryChunks} failed:`, segmentError);
                recoveryAbort = true;
                break;
            }
        }

        let finalPassCompleted = false;
        let localFinalRepairSummary = '';
        const allExtractionComplete = successfulSegments.size >= totalHistoryChunks && failures.filter(item => item.segmentIndex >= 0).length === 0;
        if (allExtractionComplete && !recoveryAbort && !pausedByUser) {
            await canonicalizeStoredIntentions(chatId);
            const repair = await repairHiddenIntentions(chatId, { createBackup: false, source: 'backfill_finalization' });
            localFinalRepairSummary = repair.summary;
            finalPassCompleted = true;
        }

        await canonicalizeStoredIntentions(chatId);
        const finalCapResult = await enforceStoredWorkingSetCaps(chatId, cfg);
        parked += Number(finalCapResult.parked || 0);
        rotations.push(...(finalCapResult.rotations || []));
        await purgeUserCharacterIntentions(chatId);

        const finishedAt = Date.now();
        const completedExtraction = successfulSegments.size;
        const summary = `${created} created; ${updated} updated; ${parked} parked; ${reactivated} reactivated; ${rejected} rejected; ${failures.length} failed call${failures.length === 1 ? '' : 's'}; ${emptySegments} valid empty segment${emptySegments === 1 ? '' : 's'}; ${completedExtraction}/${totalHistoryChunks} history segments completed in ${completedCalls} LLM call${completedCalls === 1 ? '' : 's'}; ${compactRetryCount} compact retr${compactRetryCount === 1 ? 'y' : 'ies'}; ${actorSplitCount} reactive actor split${actorSplitCount === 1 ? '' : 's'}; ${proactiveActorBatchCount} proactive actor batch${proactiveActorBatchCount === 1 ? '' : 'es'}; ${proactiveNarrativeBatchCount} proactive narrative batch${proactiveNarrativeBatchCount === 1 ? '' : 'es'}; ${rollbackCount} rollback${rollbackCount === 1 ? '' : 's'}; final cleanup ${finalPassCompleted ? 'local/no-cost' : 'pending'}${pausedByUser ? '; paused by user' : ''}.`;
        const finalState = getHiddenIntentionsState(chatId);
        const complete = completedExtraction >= totalHistoryChunks && failures.length === 0 && finalPassCompleted;
        await saveHiddenIntentionsState(chatId, {
            ...finalState,
            scanInProgress: false,
            backfillInProgress: false,
            backfillSuccessfulSegments: Array.from(successfulSegments).sort((a, b) => a - b),
            backfillCompletedChunks: completedExtraction,
            backfillNextChunk: Array.from({ length: totalHistoryChunks }, (_, index) => index).find(index => !successfulSegments.has(index)) ?? totalHistoryChunks,
            backfillCompletedBatches: completedCalls,
            backfillCompletedCalls: completedCalls,
            backfillMessagesScanned: Array.from(successfulSegments).reduce((sum, index) => sum + (messageChunks[index]?.length || 0), 0),
            backfillActorsScanned: uniqueActors.size,
            backfillCreated: created,
            backfillUpdated: updated,
            backfillParked: parked,
            backfillReactivated: reactivated,
            backfillRejected: rejected,
            backfillFailedBatches: failures.length,
            backfillFailedSegments: failures,
            backfillEmptySegments: emptySegments,
            backfillSkippedSegments: skippedSegments,
            backfillJsonRecoveries: recoveryCount,
            backfillCompactRetries: compactRetryCount,
            backfillReasoningExhaustions: reasoningExhaustionCount,
            backfillActorSplits: actorSplitCount,
            backfillNarrativeSplits: narrativeSplitCount,
            backfillRollbacks: rollbackCount,
            backfillProactiveActorBatches: proactiveActorBatchCount,
            backfillProactiveNarrativeBatches: proactiveNarrativeBatchCount,
            backfillRecoveryIncidents: recoveryIncidents.slice(-20),
            backfillPauseRequested: false,
            backfillPausedByUser: pausedByUser,
            backfillFinalPassCompleted: finalPassCompleted,
            backfillFinishedAt: finishedAt,
            backfillSummary: summary,
            lastWorkingSetRotations: rotations.slice(-20),
            lastScanMessageCount: complete ? currentMessageCount() : Number(finalState.lastScanMessageCount || 0),
            lastScanElapsedDay: complete ? currentElapsedDay(chatId) : Number(finalState.lastScanElapsedDay || 0),
            lastScanAt: finishedAt,
            cooldownUntilMessage: complete ? currentMessageCount() + cfg.cooldownMessages : Number(finalState.cooldownUntilMessage || 0),
            lastScannedActorIds: Array.from(uniqueActors).slice(-40),
            lastScanTrigger: 'backfill:sparse_v5-recovery',
            lastJsonRecovery: [
                recoveryCount ? `${recoveryCount} response${recoveryCount === 1 ? '' : 's'} repaired locally` : '',
                compactRetryCount ? `${compactRetryCount} compact no-think retr${compactRetryCount === 1 ? 'y' : 'ies'}` : '',
                reasoningExhaustionCount ? `${reasoningExhaustionCount} reasoning-budget exhaustion${reasoningExhaustionCount === 1 ? '' : 's'} detected` : '',
                actorSplitCount ? `${actorSplitCount} reactive actor split${actorSplitCount === 1 ? '' : 's'}` : '',
                proactiveActorBatchCount ? `${proactiveActorBatchCount} proactive actor batch${proactiveActorBatchCount === 1 ? '' : 'es'}` : '',
                proactiveNarrativeBatchCount ? `${proactiveNarrativeBatchCount} proactive narrative batch${proactiveNarrativeBatchCount === 1 ? '' : 'es'}` : '',
                narrativeSplitCount ? `${narrativeSplitCount} narrative split${narrativeSplitCount === 1 ? '' : 's'}` : '',
                rollbackCount ? `${rollbackCount} transactional rollback${rollbackCount === 1 ? '' : 's'}` : '',
                localFinalRepairSummary ? 'final cleanup completed locally with 0 LLM calls' : ''
            ].filter(Boolean).join('; '),
            lastValidationSummary: summary,
            lastError: complete || pausedByUser ? '' : (recoveryAbort
                ? 'Backfill paused only after compact no-think recovery, actor splitting, and smaller chronological retries were exhausted. Completed segments and the failed segment rollback were preserved. Press Debug Backfill to retry the same checkpoint.'
                : `${failures.length} call${failures.length === 1 ? '' : 's'} failed. Press Debug Backfill to retry only failed work.`)
        });
        await saveHiddenIntentionsBackfillCheckpoint(chatId, {
            intentions: getHiddenIntentions(chatId),
            runtimeState: getHiddenIntentionsState(chatId),
            source: complete ? 'complete' : (pausedByUser ? 'paused' : 'incomplete')
        });
        activeBackfillChatId = null;
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('notebook', 'settings');

        if (complete) {
            nwstToast(`Hidden Intentions backfill complete in ${completedCalls} LLM call${completedCalls === 1 ? '' : 's'}: ${created} created, ${updated} updated, ${parked} parked. Final cleanup used 0 additional calls.`, (created + updated + parked + reactivated) ? 'success' : 'info');
        } else if (pausedByUser) {
            nwstToast('Hidden Intentions backfill paused. Completed segments were saved; Debug Backfill resumes from the same checkpoint.', 'info');
        } else if (recoveryAbort) {
            nwstToast('Hidden Intentions backfill paused only after compact recovery and automatic splitting were exhausted. The failed segment was rolled back, completed segments were preserved, and Debug Backfill will retry the same checkpoint.', 'error');
        } else {
            nwstToast(`Hidden Intentions backfill paused with ${failures.length} failed call${failures.length === 1 ? '' : 's'}. Successful segments were saved.`, 'warning');
        }

        return {
            ran: true,
            mode: 'backfill',
            trigger: 'debug_backfill',
            chunks: totalHistoryChunks,
            calls: completedCalls,
            actorsScanned: uniqueActors.size,
            created,
            updated,
            parked,
            reactivated,
            rejected,
            failedBatches: failures.length,
            complete,
            validation: summary
        };
    } catch (error) {
        activeBackfillChatId = null;
        console.error('[NWST HiddenIntentions] Backfill failed:', error);
        const failedState = getHiddenIntentionsState(chatId);
        await saveHiddenIntentionsState(chatId, {
            ...failedState,
            scanInProgress: false,
            backfillInProgress: false,
            backfillFinishedAt: Date.now(),
            backfillPauseRequested: false,
            lastError: error?.message || String(error)
        });
        await saveHiddenIntentionsBackfillCheckpoint(chatId, {
            intentions: getHiddenIntentions(chatId),
            runtimeState: getHiddenIntentionsState(chatId),
            source: 'unexpected_stop'
        });
        nwstToast('Hidden Intentions backfill stopped unexpectedly. Completed segments were preserved; check F12.', 'error');
        return false;
    }
}


export async function runHiddenIntentionsGenerate(options = {}) {
    return runHiddenIntentionsOperation({ mode: 'generate', trigger: 'manual_generate', ...options });
}

export async function runHiddenIntentionsReconcile(options = {}) {
    return runHiddenIntentionsOperation({ mode: 'reconcile', trigger: 'manual_reconcile', ...options });
}

// Compatibility entry point for older internal callers. Batch Scan seeds new
// records; all other legacy scan triggers are maintenance reconciliations.
export async function runHiddenIntentionsScan(options = {}) {
    if (options?.trigger === 'debug_generate' || options?.trigger === 'debug_backfill') {
        return runHiddenIntentionsBackfill(options);
    }
    if (options?.trigger === 'batch_scan' || options?.mode === 'generate') {
        return runHiddenIntentionsGenerate(options);
    }
    return runHiddenIntentionsReconcile(options);
}

export async function runHiddenIntentionsDayAdvance(chatId = null) {
    const cfg = getHiddenIntentionsConfig();
    if (!cfg.enabled || !cfg.dayAdvancement) return false;
    const target = chatId || getChatId();
    if (!target || getChatId() !== target) return false;
    return runHiddenIntentionsReconcile({ trigger: 'day_advance', expectedChatId: target });
}

export function getHiddenIntentionsDebugReport(chatId = null) {
    const id = chatId || getChatId();
    const state = getHiddenIntentionsState(id);
    const intentions = getHiddenIntentions(id);
    const cfg = getHiddenIntentionsConfig();
    const durableCheckpoint = getHiddenIntentionsBackfillCheckpoint(id);
    const checkpointState = durableCheckpoint?.runtimeState || null;
    const unresolvedByActor = new Map();
    for (const item of intentions.filter(activeRecord)) {
        const label = item.actor || item.actorId || '(unknown)';
        unresolvedByActor.set(label, (unresolvedByActor.get(label) || 0) + 1);
    }
    const overCap = Array.from(unresolvedByActor.entries())
        .filter(([, count]) => count > cfg.maxActivePerActor)
        .map(([actor, count]) => `${actor} (${count}/${cfg.maxActivePerActor})`);
    const parkedCount = intentions.filter(item => item.status === 'parked').length;
    const strategyGaps = intentions
        .filter(item => activeRecord(item) && strategyRequiredForType(item.type) && !String(item.strategy || '').trim())
        .map(item => `${item.actor || item.actorId} (${item.type})`);
    const rotationLines = (state.lastWorkingSetRotations || []).slice(-5).map(item => `${item.actor}: ${item.parkedObjective}`).join(' | ');
    return [
        `Hidden Intentions: ${intentions.length} record(s); ${parkedCount} parked`,
        `Current working-set cap: ${cfg.maxActivePerActor} per NPC`,
        `Required strategy gaps: ${strategyGaps.join(', ') || '(none)'}`,
        `Over-cap actors: ${overCap.join(', ') || '(none)'}`,
        `Dirty actors: ${(state.dirtyActors || []).map(x => x.actor).join(', ') || '(none)'}`,
        `World dirty: ${state.worldDirty ? 'yes' : 'no'}`,
        `Last operation: ${state.lastScanTrigger || '(never)'}`,
        `Last operation message: ${state.lastScanMessageCount || 0}`,
        `Last operation elapsed day: ${state.lastScanElapsedDay ?? '(none)'}`,
        `Cooldown until message: ${state.cooldownUntilMessage || 0}`,
        `Last JSON recovery: ${state.lastJsonRecovery || '(none)'}`,
        `Last validation: ${state.lastValidationSummary || '(none)'}`,
        `Recent working-set rotations: ${rotationLines || '(none)'}`,
        `Backfill status: ${state.backfillInProgress ? 'running' : (state.backfillFinalPassCompleted && !(state.backfillFailedSegments || []).length ? 'complete' : (state.backfillSummary ? 'paused/incomplete' : '(never run)'))}`,
        `Backfill progress: ${state.backfillCompletedChunks || 0}/${state.backfillTotalChunks || 0} safe history segments; ${state.backfillPlannedCalls || state.backfillTotalBatches || 0} remaining-plan root call(s); ${state.backfillCompletedCalls || state.backfillCompletedBatches || 0} actual LLM calls`,
        `Durable backfill checkpoint: ${checkpointState ? `${checkpointState.backfillCompletedChunks || 0}/${checkpointState.backfillTotalChunks || 0} segments (${durableCheckpoint.source || 'unknown source'})` : '(none)'}`,
        `Backfill request safety: narrative target ${state.backfillNarrativeCharTarget || 0} chars; hard combined-request limit ${state.backfillRequestCharLimit || 0} chars; per-segment call cap ${BACKFILL_MAX_CALLS_PER_SEGMENT}`,
        `Backfill next segment: ${Math.min((state.backfillTotalChunks || 0) + 1, (state.backfillNextChunk || 0) + 1)}`,
        `Backfill sparse results: ${state.backfillEmptySegments || 0} empty model segment(s); ${state.backfillSkippedSegments || 0} locally skipped segment(s); final cleanup ${state.backfillFinalPassCompleted ? 'complete' : 'not complete'}`,
        `Backfill recovery: ${state.backfillReasoningExhaustions || 0} reasoning exhaustion(s); ${state.backfillCompactRetries || 0} compact no-think retry/retries; ${state.backfillProactiveActorBatches || 0} proactive actor batch(es); ${state.backfillProactiveNarrativeBatches || 0} proactive narrative batch(es); ${state.backfillActorSplits || 0} reactive actor split(s); ${state.backfillNarrativeSplits || 0} narrative split(s); ${state.backfillRollbacks || 0} transactional rollback(s)`,
        `Backfill pause: ${state.backfillPauseRequested ? 'requested' : (state.backfillPausedByUser ? 'paused by user' : 'no')}`,
        `Recent recovery incidents: ${(state.backfillRecoveryIncidents || []).slice(-5).map(item => `${item.phase || 'segment'} ${item.range || ''} [${item.reason || 'unknown'}] visible=${item.visibleChars || 0}, reasoning=${item.reasoningChars || 0}, finish=${item.finishReason || '(none)'}`).join(' | ') || '(none)'}`,
        `Last local repair: ${state.lastRepairSummary || '(none)'}`,
        `Backfill failed calls: ${(state.backfillFailedSegments || []).map(item => {
            const where = item.segmentIndex === -1 ? 'final cleanup' : `segment ${item.segmentIndex + 1}${Number.isInteger(item.startMessage) && Number.isInteger(item.endMessage) ? ` (M${item.startMessage}–M${item.endMessage})` : ''}`;
            const code = item.code ? ` [${item.code}]` : '';
            const reasoning = item.reasoningChars ? `; reasoning=${item.reasoningChars} chars${item.finishReason ? `, finish=${item.finishReason}` : ''}` : '';
            return `${where}${code}: ${item.error || 'unknown error'}${reasoning}`;
        }).join(' | ') || '(none)'}`,
        `Backfill result: ${state.backfillSummary || '(none)'}`,
        `Last error: ${state.lastError || '(none)'}`
    ].join('\n');
}
