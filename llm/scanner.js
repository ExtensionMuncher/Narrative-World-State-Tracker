/* eslint-disable */
// =============================================================================
// NWST Message Scanner — llm/scanner.js
// =============================================================================
// Background scanner that runs every N messages (configurable, default 20).
// Uses the same Planning LLM profile for two focused cadence calls:
//   - Detailed continuity: self-maintaining Notebook, detected plans, Secrets, Event status
//   - Persistent state: World Conditions and Community summaries/membership
//   - Flags NPC detected events (proposed to user, never auto-committed)
//   - Detects new secrets forming in the narrative (auto-created, with dedup)
//
// The scanner does NOT update the Current Day block. Event maintenance
// (resolve/miss/tier corrections via eventUpdates) IS applied automatically —
// conservatively, and never to events awaiting a player decision — feeding the
// normal missed/resolved → compaction lifecycle, so nothing is deleted outright.
// =============================================================================

import { generateWithProfile } from './connections.js';
import { LLM_TOKEN_BUDGETS } from './tokenBudgets.js';
import { getChatId, nwstToast } from '../utils.js';
import { getScanFrequency, getScanMinimumMessages, isPaused, isEnabled } from '../settings.js';
import { chatHasData } from '../data/storage.js';
import { getWorldState, getSettingContext, updateConditionContent, getCalendarConfig } from '../data/worldState.js';
import { getTrackedEvents } from '../data/events.js';
import { getNotebook, addCoreBullet, addMysteryBullet, replaceMysteryField, replaceMysteryFieldDiff, getCoreField, getMysteryField, addSecret, getAllSecrets, flagSecretForArchive, getSecretStatus, getInjectableSecrets } from '../data/notebook.js';
import { beginMutationBatch, recordMutation, commitMutationBatch } from '../data/notebookHistory.js';
import { replaceCoreField as replaceCoreFieldQuiet } from '../data/notebook.js';
import { getAllCommunities, updateCommunitySummary, updateCommunityMembers, addCommunity } from '../data/communities.js';
import { resolveProfile } from './connections.js';
import { runConsistencyCheck } from './narrativeConsistency.js';
import { runNotebookReconcile } from './notebookReconcile.js';
import { getReconcileCadence } from '../settings.js';
import { runSecretsSidecar } from './secretsSidecar.js';
import { getSidecarCadence, getSecretDecayThreshold } from '../settings.js';
import { dlog } from "../lib/debug.js";
import { buildAliasRegistry, toCanonicalId } from '../data/aliasRegistry.js';
import { buildWorldEvidenceSources, formatWorldEvidenceSources, collectRecentCastNames, validateWorldConditionPayload, isLikelySceneContaminatedCondition } from './worldConditionEvidence.js';

// ── Scanner state ─────────────────────────────────────────────────────────
//
// TWO-PHASE SCAN LIFECYCLE:
//
// PHASE 1 — WARMUP (no batch scan has been run for this chat):
//   The scanner counts messages silently until the minimum floor is reached
//   (default 10, configurable). At that point it fires the INITIAL SCAN,
//   which grounds the world state for the first time.
//   The cadence counter does NOT start until the initial scan completes.
//
// PHASE 2 — NORMAL CADENCE (after initial scan OR after batch scan):
//   Scanner fires every N messages as configured. Batch scan completing
//   mid-warmup immediately transitions to Phase 2 — no initial scan needed
//   because batch scan already did the grounding pass.
//
// KEY INVARIANT: messageCountAtLastScan is only set after an actual scan
// completes (either initial or cadence). This ensures the cadence counter
// always starts from a clean boundary, never from the warmup count.

let messageCountAtLastScan = 0;  // Set after each completed scan
let messageCountAtLastSidecar = 0;  // Independent cadence for the secrets sidecar
let warmupMessageCount = 0;      // Counts messages during Phase 1 warmup
let scanPhase = 'warmup';        // 'warmup' | 'cadence'
let scanTimer = null;
let isScanning = false;
// Message count at the last FAILED scan attempt (0 = none) — retry backoff
let _lastScanFailureCount = 0;
let _lastScanFailureReason = '';
let _lastScanFailureAt = 0;
let _lastScanSuccessAt = 0;
let _lastScanSuccessCount = 0;
let _lastScanRangeStart = null;
let _lastScanRangeEnd = null;

// ── Scanner state persistence (survives page reload) ──────────────────────
// Saves the scanner's cadence position to chatMetadata so reloading the page
// doesn't reset the countdown. Without this, every reload restarts the
// 20-message countdown from scratch even if the scanner was at message 18.

const SCANNER_STATE_KEY = 'nwst:scannerState';

function saveScannerState() {
    try {
        const { chatMetadata, saveMetadata } = SillyTavern.getContext();
        if (!chatMetadata) return;
        chatMetadata[SCANNER_STATE_KEY] = {
            messageCountAtLastScan,
            scanPhase,
            lastScanFailureCount: _lastScanFailureCount,
            lastScanFailureReason: _lastScanFailureReason,
            lastScanFailureAt: _lastScanFailureAt,
            lastScanSuccessAt: _lastScanSuccessAt,
            lastScanSuccessCount: _lastScanSuccessCount,
            lastScanRangeStart: _lastScanRangeStart,
            lastScanRangeEnd: _lastScanRangeEnd
        };
        saveMetadata(); // fire-and-forget — non-critical
    } catch (e) { /* non-fatal */ }
}

function loadScannerState() {
    try {
        const { chatMetadata } = SillyTavern.getContext();
        if (!chatMetadata) return null;
        return chatMetadata[SCANNER_STATE_KEY] || null;
    } catch (e) { return null; }
}

function emitScannerHealth() {
    try {
        window.dispatchEvent(new CustomEvent('nwst:scan-health-changed', { detail: getScannerHealth() }));
    } catch (_) { /* UI may not be mounted yet */ }
}

function markScanFailure(reason, rangeStart = null, rangeEnd = null) {
    _lastScanFailureReason = String(reason || 'Scan did not complete.');
    _lastScanFailureAt = Date.now();
    if (Number.isInteger(rangeStart)) _lastScanRangeStart = rangeStart;
    if (Number.isInteger(rangeEnd)) _lastScanRangeEnd = rangeEnd;
    saveScannerState();
    emitScannerHealth();
}

function markScanSuccess(rangeStart, rangeEnd) {
    _lastScanFailureCount = 0;
    _lastScanFailureReason = '';
    _lastScanFailureAt = 0;
    _lastScanSuccessAt = Date.now();
    _lastScanSuccessCount = Number.isInteger(rangeEnd) ? rangeEnd : getCurrentMessageCount();
    _lastScanRangeStart = Number.isInteger(rangeStart) ? rangeStart : null;
    _lastScanRangeEnd = Number.isInteger(rangeEnd) ? rangeEnd : null;
    saveScannerState();
    emitScannerHealth();
}

export function getScannerHealth() {
    const currentCount = getCurrentMessageCount();
    const frequency = Math.max(1, getScanFrequency());
    const backlog = Math.max(0, currentCount - messageCountAtLastScan);
    const messagesSinceWarmup = Math.max(0, currentCount - warmupMessageCount);
    const floor = Math.max(1, getScanMinimumMessages());
    let status = 'healthy';
    let nextIn = Math.max(0, frequency - backlog);

    if (!isEnabled()) status = 'disabled';
    else if (isPaused()) status = 'paused';
    else if (isScanning) status = 'scanning';
    else if (scanPhase === 'warmup') {
        status = 'warmup';
        nextIn = Math.max(0, floor - messagesSinceWarmup);
    } else if (_lastScanFailureReason) {
        status = 'failed';
        nextIn = _lastScanFailureCount > 0 ? Math.max(0, 3 - (currentCount - _lastScanFailureCount)) : 0;
    } else if (backlog >= frequency) {
        status = 'backlog';
        nextIn = 0;
    }

    return {
        status,
        phase: scanPhase,
        isScanning,
        currentMessageCount: currentCount,
        messageCountAtLastScan,
        backlog,
        nextIn,
        scanFrequency: frequency,
        warmupProgress: scanPhase === 'warmup' ? messagesSinceWarmup : null,
        warmupFloor: floor,
        lastSuccessAt: _lastScanSuccessAt,
        lastSuccessMessageCount: _lastScanSuccessCount,
        lastFailureAt: _lastScanFailureAt,
        lastFailureReason: _lastScanFailureReason,
        lastRangeStart: _lastScanRangeStart,
        lastRangeEnd: _lastScanRangeEnd
    };
}

// ── Internal system prompts ───────────────────────────────────────────────
// These are not user-editable. The cadence work is deliberately split into
// focused internal prompts while reusing the same Planning LLM connection.

const SCANNER_SYSTEM_PROMPT = `You are a narrative continuity scanner for an ongoing roleplay. You review recent chat messages and maintain the detailed story ledger: Notebook, detected future plans, Secrets, and active Event status.

You will receive recent chat messages, the current date/calendar anchor, the current Notebook, existing Secrets, and tracked Events.

WHAT YOU DO:

1. NOTEBOOK MAINTENANCE — keep the Notebook CURRENT, not merely additive.
   - unresolvedDetail: unresolved threads, unanswered questions, dangling mysteries.
   - promiseThreatDeadline: active promises, threats, warnings, or deadlines.
   - offscreenPressure: current pressures building away from the scene, as "Source: pressure". One current pressure per source; replace stale pressure instead of stacking it.
   - doNotForget: durable specific details that must not be dropped (objects, names, revealed facts, enduring context).
   - establishedFacts: confirmed truths — never speculation.
   - plantedDetails: still-live seeds that have not paid off yet.
   - characterWhereabouts: the CURRENT latest-known location/activity of each named character, formatted strictly as "Name: where they are now". One current entry per character.
   - inconsistenciesFlagged: contradictions that are STILL unresolved.
   - currentToneAtmosphere: the SINGLE current emotional register/tension level. One entry only.

   CURRENT-STATE CLEANUP IS PART OF THE JOB:
   - Existing Notebook bullets are labeled (UD#, PT#, OP#, DNF#, EF#, PD#, CW#, IF#, TA#).
   - If recent prose makes an existing bullet obsolete, superseded, contradicted, resolved, paid off, expired, or no longer current, put its label in notebookRetirements.
   - Do NOT retain an old location after the same character is explicitly somewhere else now.
   - Do NOT retain a resolved deadline, paid-off planted detail, superseded pressure, or fixed inconsistency merely because it used to be true.
   - Durable historical facts may remain true even after the scene moves on. Never retire a fact only because it was not mentioned recently.
   - When unsure whether a durable fact is obsolete, preserve it. Be more proactive with explicitly current-state fields.

   MOTIVE / INTERPRETATION GROUNDING — applies to EVERY Notebook field:
   - When narration, dialogue, or internal thought explicitly states WHY a character acted, preserve that stated motive as higher-confidence evidence than the dramatic style of the action.
   - Do NOT upgrade fear, desperation, panic, confusion, impulsiveness, self-preservation, or reactive behavior into confidence, strategy, dominance, bravery, or calculated control unless the prose actually establishes that interpretation.
   - Do NOT make a character "more badass," competent, composed, malicious, romantic, or strategic than the text supports.
   - Distinguish observed fact from interpretation. If the text supports only suspicion, record it as uncertainty rather than certainty.

2. NPC EVENT DETECTION — identify EXPLICIT future plans made by characters.
   Only flag events where a character explicitly states or clearly implies something will happen.
   Do NOT infer or extrapolate a future plan from ordinary actions.

3. SECRET DETECTION & KNOWLEDGE TRACKING — two responsibilities:

   a) CONSIDER EXISTING SECRETS when maintaining the Notebook:
      - Character knowledge states affect what Notebook fields should reflect.
      - A Secret's whoKnows/whoDoesNotKnow lists determine which characters can act on that knowledge.

   b) DETECT NEW SECRETS forming in the recent messages:
      - Identify concealed information, hidden agreements, deliberately withheld truths, hidden pasts, concealed plans, or forbidden relationships.
      - Check the existing Secrets list to avoid duplicates.
      - A new Secret should include title, type, core content, who knows it, and who does NOT know it.
      - injectionPriority: "high" for imminent major consequences, "normal" for standard dramatic potential, "low" for background/minor Secrets.

      TYPE GUIDE:
      "character": about a specific character's nature, past, feelings, or abilities
      "user_pc": a Secret the {{user}} character is keeping, or a Secret about them
      "world": about the setting, factions, institutions, or environment
      "dramatic_irony": audience/reader knows, key characters do not
      "unconfirmed_suspicion": a character's suspicion that is not confirmed true

      DETECTING RESOLVED THREADS:
      - Review unresolvedDetail and promiseThreatDeadline. If recent messages clearly RESOLVE, pay off, or expire one, copy its EXACT text into resolvedThreads.
      - notebookRetirements may also retire other stale Notebook bullets by label.

      DETECTING REVEALED SECRETS:
      - If prose clearly shows an EXISTING Secret becoming known to someone who did not know it, list that exact Secret title under revealedSecrets.
      - A near-miss or suspicion is not a reveal.

      RULES FOR NEW SECRETS:
      - If a character personally discovers evidence and understands the Secret's core fact, they belong in whoKnows even if a finer detail remains inferred.
      - Put only the still-uncertain finer detail into an unconfirmed_suspicion when appropriate.
      - Never put the same character in both whoKnows and whoDoesNotKnow.
      - Never put the literal label "User" in knowledge lists; the named {{user}} character is a valid narrative participant.
      - When a Secret involves the {{user}} character, use type "user_pc".

4. EVENT MAINTENANCE — keep tracked Events truthful.
   - RESOLVED: projected moment clearly happened on-screen.
   - MISSED: its window clearly passed or premise visibly failed.
   - TIER CORRECTIONS: only for active UNDated Events when urgency becomes clear. immediate = today/tomorrow; week = later in current weekday cycle; month = later in current calendar month.
   - Dated Events are placed structurally by the calendar. Do not tier-correct them.
   - "undetermined" is deliberately timeless; never move Events in or out of it, though you may resolve/miss them.
   - Reference Events by their E# labels. Be conservative; most scans should leave Events untouched.

RESPONSE FORMAT — valid JSON only:
{
  "notebookUpdates": {
    "unresolvedDetail": [],
    "promiseThreatDeadline": [],
    "offscreenPressure": [],
    "doNotForget": [],
    "establishedFacts": [],
    "plantedDetails": [],
    "characterWhereabouts": [],
    "inconsistenciesFlagged": [],
    "currentToneAtmosphere": []
  },
  "notebookRetirements": ["UD2", "CW4"],
  "detectedNPCEvents": [
    {
      "title": "Brief label",
      "description": "What was explicitly stated or clearly implied",
      "tier": "immediate" | "week" | "month" | "undetermined",
      "scheduledDate": "Concrete date/day when stated or clearly implied; null otherwise",
      "detectedFrom": "brief grounding reference"
    }
  ],
  "newSecrets": [
    {
      "title": "Secret title",
      "type": "character" | "user_pc" | "world" | "dramatic_irony" | "unconfirmed_suspicion",
      "secret": "Hidden knowledge content",
      "whoKnows": ["Character A"],
      "whoDoesNotKnow": ["Character B"],
      "evidenceShown": "optional evidence",
      "pressureRisk": "specific narrative consequence if revealed/acted upon",
      "revealConditions": "optional reveal conditions",
      "injectionPriority": "high" | "normal" | "low",
      "triggerAnchors": ["3-7 distinctive phrases"]
    }
  ],
  "eventUpdates": {
    "resolved": ["E1"],
    "missed": [],
    "tierChanges": { "E3": "immediate" | "week" | "month" }
  },
  "resolvedThreads": ["EXACT text of a resolved unresolvedDetail/promiseThreatDeadline bullet"],
  "revealedSecrets": [
    {
      "title": "EXACT title of an EXISTING Secret",
      "revealedTo": "who learned it",
      "evidence": "brief grounding evidence"
    }
  ],
  "noChanges": false
}

If nothing meaningful changed, return {"noChanges": true} and nothing else.
For notebookUpdates, include only genuinely new/current bullets. Do not repeat existing bullets unchanged.
For notebookRetirements, use ONLY labels that exist in the supplied current Notebook.
For newSecrets, create only genuinely new Secrets.`;

// World Conditions and Communities intentionally use a second focused call on
// the SAME Planning LLM profile. Keeping macro/durable-state synthesis separate
// prevents detailed Notebook extraction from pulling these summaries down into
// scene recap.
const WORLD_COMMUNITY_SYSTEM_PROMPT = `You maintain the persistent WORLD CONDITIONS and COMMUNITY records for an ongoing roleplay. This is a macro/durable-state task, not a scene-summary task.

GENERAL RULES:
- MOST cadence scans should leave most or all World Conditions and Communities unchanged.
- Treat recent chat as EVIDENCE of possible changes inside a larger world. The chat itself is not "the world."
- Existing saved summaries are state to preserve or revise, NOT examples whose granularity must be imitated. They may already be too scene-focused.
- If an existing World Condition or Community summary is itself clearly a scene recap rather than valid persistent state, correcting that contamination IS a legitimate maintenance update even when no new macro change occurred. Preserve any valid facts while rewriting at the proper scale.
- A dramatic development for the immediate cast is not automatically a change to the surrounding world or a durable Community dynamic.

WORLD CONDITIONS — CADENCE BEHAVIOR:
On automatic cadence, the DEFAULT is to PRESERVE the existing World Condition.
- GROUNDED is allowed only when the supplied evidence establishes a NEW qualifying macro transition since the current saved condition.
- AMBIENT is only a repair/fill path when the current condition is empty or clearly scene-contaminated. Do not use Ambient to refresh healthy state.
- If no qualifying macro transition occurred and the condition is healthy, return update:false.

GROUNDED MODE — NEW MACRO TRANSITIONS ONLY:
- Use this only when the supplied evidence establishes a genuine NEW macro/durable transition, not merely the existence or continuation of an institution/faction/process.
- Static facts such as "the organization conducts surveillance," "law enforcement processes paperwork," or "a faction remains active" are NOT cadence updates.
- Every Grounded update must include transitionType from the category-specific list below.
- Before updating, mentally REMOVE the protagonist and immediate active cast. If the result stops describing a meaningful institution, faction, population, district, region, culture, social pattern, spiritual system, or environment, return update:false.
- A character may CAUSE a World Condition change without BEING the World Condition.
- Named characters MAY be used when identifying the cause of a genuine macro-level shift prevents ambiguity. The SUBJECT must remain the wider institution/faction/population/region/system.
- Supply 1-4 evidence source IDs in evidenceRefs (for example ["M2", "M5"]). Do NOT copy quotes; choose only the source blocks that actually establish the macro claim.
- Every factual claim in the condition must be supported by those cited source blocks or by ONE conservative inference that does not require any new actor, reaction, institution, team, rumor, policy, coordination, awareness, or offscreen development.
- Do not combine unrelated facts from separate source IDs to manufacture a new relationship. Example: a legal/restraining-order source plus a syndicate-surveillance source does NOT establish a law-enforcement surveillance team.
- If the cited source blocks do not establish the macro claim, do not write it as grounded.

AMBIENT MODE:
- Use this when no grounded story-derived macro update is available but a quiet background condition would help establish that the world continues beyond the active cast.
- Ambient content must come from Setting Context, date/season/weather, and ordinary low-stakes setting-consistent background life.
- Do NOT name or causally reference the protagonist or recent active cast.
- Do NOT turn recent scene events into ambient consequences.
- Ambient may introduce modest current developments involving setting-supported institutions/factions/populations/environments when they quietly demonstrate that the world continues beyond the cast.
- AMBIENT PROPORTIONALITY TEST: an invented development must remain something the active cast could plausibly never notice. If it would reasonably force immediate plan changes, urgent follow-up, or substantially rewrite the playable world, it is too consequential unless Setting Context/Current Day already supports that scale.
- Keep it restrained and subordinate to the active story: no gratuitous crises, no parade of unrelated developments, and no casually invented war, coup, state of emergency, martial law, government collapse, sweeping nationwide crackdown/purge, mass civil disorder, economic collapse, catastrophic disaster, mass-casualty event, widespread infrastructure failure, or supernatural/metaphysical catastrophe.
- Prefer one coherent background theme with at most 1-2 closely related developments rather than a bulletin list of unrelated news.
- Evidence may be an empty array in ambient mode.

HARD GROUNDING GUARDS:
- NO INVISIBLE MIDDLE STEPS. Do not invent offscreen meetings, rumor circulation, institutional reactions, coordination, policy shifts, resource strain, public awareness, new teams/details, or faction-wide sentiment to make a local event sound macro.
- Preserve INFORMATION ASYMMETRY. If one side knows about another and the reverse is not explicitly established, do not invent mutual awareness, a détente, reciprocal maneuvering, shared protocols, or coordination.
- Do not confuse a plausible FUTURE consequence with CURRENT world state. Possible escalation belongs in Events or remains unstated until grounded.
- Do not create a new organization, team, task force, policy, institutional practice, rumor network, public reaction, resource shortage, or formal relationship unless the cited source text itself establishes it.
- Avoid unsupported scale inflation. Claims such as "unprecedented," "historic," "no precedent in living memory," "system-wide," or equivalent grandiosity require cited evidence at that scale.
- Conditions should be durable enough to survive many messages when the wider state has not changed.

CATEGORY BOUNDARIES / MACRO THRESHOLDS:
- POLITICAL: concerns wider power structures, institutions, factions, governance, territorial control, policy/regulatory pressure, leadership/hierarchy, organizational posture, or relationships between institutions/factions. A single case, restraining order, piece of paperwork, target, operative, surveillance post, visitor, arrest, or investigation is NOT a Political World Condition unless the evidence establishes a wider change in institutional/faction behavior. Political AMBIENT may introduce modest background institutional motion — routine guidance/procedural updates, staffing or budget pressure, promotion cycles, municipal initiatives, enforcement-priority shifts, or low-key faction/corporate maneuvering — including named overarching institutions when setting-consistent. It must not invent plot-forcing political upheaval or sweeping changes that would demand immediate story response.
- SOCIAL: concerns collective behavior, cultural/social norms, community patterns, public routines, workplaces, commerce, social spaces, population habits, reputation patterns, or group-level pressures. A private relationship or isolated interaction is not Social World State merely because other people could plausibly notice it. In SOCIAL AMBIENT mode, season/weather may EXPLAIN collective behavior, but the paragraph must primarily describe what people, communities, workplaces, or social spaces are doing; do not turn Social into a second Environmental condition.
- SPIRITUAL/SUPERNATURAL: concerns durable metaphysical rules/pressures, supernatural factions, ritual cycles, regional spiritual phenomena, barriers/realms, sacred/profane conditions, or other setting-supported supernatural systems. A single character's aura, emotion, vision, encounter, spell, curse, or spiritual sensation is not a Spiritual World Condition unless it changes the wider metaphysical environment/system. Do not invent a supernatural ontology in AMBIENT mode if the supplied Setting Context/Current Day does not support one. The Current Day spiritualClimate is momentary atmosphere; this World Condition is the more durable metaphysical state behind it.
- ENVIRONMENTAL: concerns durable physical-world conditions such as seasonal transition, climate pattern, ecology, landscape, water/air conditions, regional hazards, flora/fauna shifts, or persistent environmental change. Today's rain, temperature, fog, or one local weather moment belongs in Current Day unless it reflects a broader/persistent environmental pattern. ENVIRONMENTAL AMBIENT content should stay focused on the physical world and ecology rather than social routines.

GROUNDED MACRO TEST:
- A GROUNDED FACT is not automatically a GROUNDED WORLD CONDITION. The cited evidence must establish a wider change/state at the category's macro scale, not merely an accurate case-specific fact.
- The required "change" field must state the macro/durable change WITHOUT naming the protagonist or immediate active cast. If you cannot describe the change without those individuals, return update:false or use AMBIENT when appropriate.
- Political valid scopes: institution, faction, district, regional, population.
- Social valid scopes: population, community, district, cultural, regional.
- Spiritual valid scopes: spiritual, faction, regional, environmental.
- Environmental valid scopes: environmental, district, regional.

VALID GROUNDED transitionType VALUES:
- Political: policy_change | governance_change | hierarchy_change | territorial_change | organization_wide_posture_change | intergroup_relationship_change | regulatory_change
- Social: collective_norm_change | community_behavior_change | public_routine_change | reputation_shift | population_pressure_change | cultural_change
- Spiritual: metaphysical_system_change | ritual_cycle_change | supernatural_faction_change | regional_spiritual_change | barrier_realm_change
- Environmental: seasonal_pattern_change | climate_pattern_change | ecological_change | regional_hazard_change | flora_fauna_change | landscape_change | air_water_change

The change field must describe an actual transition (shifted, expanded, tightened, reorganized, spread, declined, etc.). "Remains," "continues," "maintains," "operates," or other static/continuing facts do not qualify as a cadence Grounded change.

COMMUNITIES:
- A Community summary describes the group's durable structure, relationships, hierarchy, loyalties, fractures, collective pressures, reputation, objectives, and current collective posture.
- Recent events may CHANGE that durable state, but must be absorbed into the group dynamic rather than narrated as a scene recap.
- Update only when something lasting changed: membership/status, trust, hierarchy, alliance, fracture, collective objective, shared pressure, or group posture.
- Include a COMPLETE comma-separated member list when membership/status changed. Preserve useful status annotations such as "(suspended)" when supported.
- Do not remove a member merely because they did not appear in the recent window.
- Avoid duplicate Communities. Similar membership alone does not prove two differently named groups are the same.

MOTIVE / INTERPRETATION GROUNDING — mandatory for Community analysis:
- Explicitly stated motives outrank dramatic stylistic inference.
- Do NOT upgrade fear, desperation, panic, confusion, impulsiveness, self-preservation, or reactive behavior into confidence, strategy, dominance, bravery, or calculated control unless the prose establishes it.
- Do NOT make characters or groups more competent, composed, sinister, romantic, strategic, or "badass" than the evidence supports.

CADENCE PERSISTENCE RULE:
- On automatic cadence, AMBIENT is NOT a reason to refresh a healthy existing condition. If the current condition is already nonempty and valid at the proper category scale, leave it unchanged when no grounded macro shift occurred. Use AMBIENT on cadence mainly to fill an empty condition or repair clearly scene-contaminated state.

FINAL WORLD-STATE CHECK:
Do NOT summarize the latest scene. For every World Condition update, choose GROUNDED with cited source IDs or AMBIENT with no recent-cast causal claims. If neither fits, return update:false.

RESPONSE FORMAT — valid JSON only:
{
  "conditionUpdates": {
    "political": { "update": false, "scope": "none", "mode": "none", "transitionType": "none", "evidenceRefs": [], "change": "", "content": "" },
    "social": { "update": false, "scope": "none", "mode": "none", "transitionType": "none", "evidenceRefs": [], "change": "", "content": "" },
    "spiritual": { "update": false, "scope": "none", "mode": "none", "transitionType": "none", "evidenceRefs": [], "change": "", "content": "" },
    "environmental": { "update": false, "scope": "none", "mode": "none", "transitionType": "none", "evidenceRefs": [], "change": "", "content": "" }
  },
  "communityUpdates": [
    {
      "name": "EXACT existing Community name, or a genuinely new Community name",
      "update": true,
      "members": "complete member list if membership/status changed; otherwise empty string",
      "summary": "Durable collective-state summary, not a plot recap"
    }
  ],
  "noChanges": false
}

A GROUNDED evidence list must look like:
"evidenceRefs": ["M4", "M7"]

If nothing qualifies, return {"noChanges": true}.`;

// ── Community synthesis prompt (dedicated, richer pass) ───────────────────

const COMMUNITY_SYNTHESIS_PROMPT = `You are a community analyst for an ongoing narrative roleplay. Your job is to write community summaries that combine atmospheric narrative voice with sharp, specific analytical observations — the way a perceptive human observer would describe a social dynamic they have been watching closely.

CRITICAL — AVOID DUPLICATE COMMUNITIES: You will receive a list of EXISTING COMMUNITIES above. Before creating a NEW community in your output, carefully check every existing community name. If an existing community covers the same social group under a different name (e.g., "The Servants" vs "Household Staff"), UPDATE ITS SUMMARY instead of creating a duplicate. Pay attention to member overlap and thematic similarity. Duplicate communities fragment the analysis and must be prevented. When in doubt, merge into the existing entry rather than creating a new one.

Your summaries always include the overview paragraph. Analytical bullets are optional and should appear only when the community genuinely warrants distinct group-level observations.

PART 1 — OVERVIEW PARAGRAPH (2-4 sentences):
Write with narrative voice and atmosphere. Capture the emotional texture, underlying pressure, and defining dynamic of this group. Name the key players and their roles. Be specific about what makes this group distinctive — not just that tension exists, but what KIND of tension, what SHAPE the dynamic takes, what is at stake. This should read like a perceptive narrator sizing up a room, not a journalist listing facts.

GOOD overview: "A family where the cracks are widening. Lena is too observant for her age and suspects Adrian is hiding serious injuries. Marcus, the usually boisterous father, has become eerily quiet — he knows more than he lets on. The household is a pressure cooker of unspoken worry, and Adrian's evasions are beginning to strain a family that loves him."

BAD overview: "The Vale family consists of Adrian, his siblings, and their father. There is tension because Adrian is keeping secrets." (roster and vague summary — not analysis)

PART 2 — ANALYTICAL OBSERVATIONS (variable count — determined by the community):
Each bullet must be a specific, concrete observation tied to an actual moment, detail, pattern, or choice from the chat. These are interpretations — what does a specific thing REVEAL about the dynamic? What is being avoided, performed, or withheld? What does a small choice signal about a larger truth?

BULLET COUNT IS A TEST OF ANALYTICAL RIGOR. Do not aim for any specific number. Let the community dictate the count. A simple, peripheral community might warrant only 1-2 bullets. A deeply entangled community might warrant more. A community with no meaningful additional group-level dynamics warrants 0 bullets and should return only the overview paragraph. Padding by aiming for a specific number is a failure — each bullet must earn its place.

Self-critique (perform silently before finalizing): read each bullet — is it revealing something non-obvious? Is it tied to a specific detail rather than generic? If any bullet fails, delete it. If pruning leaves 0-2 bullets, that is correct. Do not add filler to reach a count.

GOOD bullet (2 sentences max): "Nadia's shift from cold tactical assessment to visible concern — bringing food, giving space instead of orders — marks a structural change in how she processes Mira's role in the network. The operational detachment she uses as a shield is failing against something she cannot categorize as a variable."
BAD bullet (too long): same content sprawling across 4 sentences with explanation appended
BAD bullet (summary): "Nadia brought food to Mira" — states what happened, not what it reveals
BAD bullet (generic): "There is tension between characters" — reveals nothing

BULLET LENGTH LIMIT — STRICTLY ENFORCED:
Each bullet must be a MAXIMUM of 2 sentences. First sentence: the observation. Second sentence (optional): what it reveals. Cut everything else. If you cannot fit the insight in 2 sentences, you have not distilled it yet.

CRITICAL RULES:
- Characters CAN and SHOULD be named when specificity is useful, but the SUBJECT of each observation must remain the community's durable collective state.
- No plot recaps — recent actions are evidence, not the summary itself.
- No generic observations — every bullet must surface something not obvious from the surface.
- Explicitly stated motives outrank dramatic stylistic inference. Do NOT turn fear, desperation, panic, confusion, impulsiveness, self-preservation, or reactive behavior into confidence, strategy, dominance, bravery, or calculated control unless the prose establishes it.
- Do not make a person or group more competent, composed, sinister, romantic, strategic, or "badass" than the evidence supports.
- Membership/status changes are part of community maintenance. Return the COMPLETE current member list when it changed; do not drop absent members merely because they did not appear in the latest scene.
- MAXIMUM 2 sentences per bullet — hard limit, no exceptions.
- Quality over quantity — fewer tight bullets beat padded ones. Cut anything that does not earn its length.

OUTPUT FORMAT — respond with a JSON array only, no markdown fences, no explanation:
[
  {
    "name": "Community name",
    "members": "comma-separated character names",
    "summary": "Overview paragraph here\n\n• Observation tied to a specific moment or pattern\n• Observation tied to a specific moment or pattern\n• Observation tied to a specific moment or pattern"
  }
]`;

export function startScanner() {
    if (scanTimer) return;

    const chatId = getChatId();
    // Module state survives chat switches, so clear the previous chat's health
    // before loading the active chat's persisted scanner state.
    messageCountAtLastScan = 0;
    messageCountAtLastSidecar = 0;
    warmupMessageCount = 0;
    scanPhase = 'warmup';
    _lastScanFailureCount = 0;
    _lastScanFailureReason = '';
    _lastScanFailureAt = 0;
    _lastScanSuccessAt = 0;
    _lastScanSuccessCount = 0;
    _lastScanRangeStart = null;
    _lastScanRangeEnd = null;

    // Determine starting phase:
    // If batch scan has already been run (chatHasData returns true),
    // skip warmup and go straight to normal cadence.
    // Otherwise start in warmup phase.
    if (chatHasData(chatId)) {
        // Try to restore persisted cadence position from before the reload
        const savedState = loadScannerState();
        if (savedState && savedState.scanPhase === 'cadence') {
            scanPhase = 'cadence';
            messageCountAtLastScan = savedState.messageCountAtLastScan;
            _lastScanFailureCount = savedState.lastScanFailureCount || 0;
            _lastScanFailureReason = savedState.lastScanFailureReason || '';
            _lastScanFailureAt = savedState.lastScanFailureAt || 0;
            _lastScanSuccessAt = savedState.lastScanSuccessAt || 0;
            _lastScanSuccessCount = savedState.lastScanSuccessCount || 0;
            _lastScanRangeStart = Number.isInteger(savedState.lastScanRangeStart) ? savedState.lastScanRangeStart : null;
            _lastScanRangeEnd = Number.isInteger(savedState.lastScanRangeEnd) ? savedState.lastScanRangeEnd : null;
            dlog(`[NWST Scanner] Restored cadence position from before reload (last scan at msg ${messageCountAtLastScan}).`);
        } else {
            // No persisted state — first load after the patch was installed,
            // or state was cleared. Position the cadence counter at the most
            // recent scan boundary so the next scan fires at the correct interval
            // rather than immediately. No catch-up scan — the next message after
            // the next boundary will trigger naturally.
            scanPhase = 'cadence';
            const currentCount = getCurrentMessageCount();
            const frequency = getScanFrequency();
            const estimatedLastScan = currentCount - (currentCount % frequency);
            messageCountAtLastScan = estimatedLastScan;
            dlog(`[NWST Scanner] No persisted state — positioning cadence at msg ${estimatedLastScan}, next scan at msg ${estimatedLastScan + frequency}.`);
        }
    } else {
        scanPhase = 'warmup';
        warmupMessageCount = getCurrentMessageCount();
        dlog(`[NWST Scanner] No batch scan data — starting in warmup phase (floor: ${getScanMinimumMessages()} messages).`);
    }

    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.MESSAGE_RECEIVED, checkAndScan);
    scanTimer = 'event-driven';
    dlog(`[NWST Scanner] Started (cadence: every ${getScanFrequency()} messages).`);
    emitScannerHealth();
}

export function stopScanner() {
    if (!scanTimer) return;
    try {
        const { eventSource, event_types } = SillyTavern.getContext();
        eventSource.removeListener(event_types.MESSAGE_RECEIVED, checkAndScan);
    } catch (e) {
        console.warn('[NWST Scanner] Error detaching listeners:', e);
    }
    scanTimer = null;
    dlog('[NWST Scanner] Stopped.');
    emitScannerHealth();
}

export function restartScanner() {
    stopScanner();
    startScanner();
}

/**
 * Called externally when the user completes a batch scan mid-warmup.
 * Immediately transitions to cadence phase without running an initial scan —
 * batch scan already did the grounding pass.
 */
export function notifyBatchScanComplete() {
    if (scanPhase === 'warmup') {
        scanPhase = 'cadence';
        messageCountAtLastScan = getCurrentMessageCount();
        dlog('[NWST Scanner] Batch scan completed during warmup — transitioning to cadence phase.');
        saveScannerState();
        emitScannerHealth();
    }
}

// ── Scan check ────────────────────────────────────────────────────────────

async function checkAndScan() {
    if (!isEnabled() || isPaused() || isScanning) { emitScannerHealth(); return; }

    const currentCount = getCurrentMessageCount();
    emitScannerHealth();

    // ── SECRETS SIDECAR — independent cadence ────────────────────────────
    // The sidecar runs on its own interval (default 10 msgs), separate from
    // the main scanner cadence. It only fires if there are secrets to analyze
    // (the sidecar itself no-ops cheaply when there are none). Runs in all
    // phases — secrets matter even early in a chat.
    const sidecarCadence = getSidecarCadence();
    if (currentCount - messageCountAtLastSidecar >= sidecarCadence) {
        messageCountAtLastSidecar = currentCount;
        // Fire-and-forget — do not block the main scan path on the sidecar
        runSecretsSidecar().catch(e =>
            dlog('[NWST Scanner] Secrets sidecar error (non-fatal):', e)
        );
    }

    // ── PHASE 1: WARMUP ──────────────────────────────────────────────────
    // Count messages silently until the minimum floor is reached.
    // Do not fire any LLM calls during warmup.
    if (scanPhase === 'warmup') {
        const messagesSinceStart = currentCount - warmupMessageCount;
        const floor = getScanMinimumMessages();

        // Check if batch scan was run externally mid-warmup
        // (e.g. user clicked Run Batch Scan before the floor was hit)
        const chatId = getChatId();
        if (chatHasData(chatId)) {
            // Batch scan done — skip initial scan, go straight to cadence
            scanPhase = 'cadence';
            messageCountAtLastScan = currentCount;
            dlog('[NWST Scanner] Batch scan detected mid-warmup — skipping initial scan, entering cadence.');
            saveScannerState();
            emitScannerHealth();
            return;
        }

        if (messagesSinceStart < floor) {
            dlog(`[NWST Scanner] Warmup: ${messagesSinceStart}/${floor} messages.`);
            return; // Not ready yet
        }

        // Floor reached — fire the initial scan over the whole warmup gap
        dlog(`[NWST Scanner] Warmup complete (${messagesSinceStart} messages). Running initial scan...`);
        nwstToast('Running initial world state scan...', 'info');
        const initialWindow = Math.min(messagesSinceStart, 60);
        const initialOk = await runScan(initialWindow, warmupMessageCount);

        // Transition to cadence phase. If the warmup gap somehow exceeded the
        // 60-message safety window, advance only through the slice we actually
        // processed; the remaining backlog is retained for the cadence pass.
        // On failure the counter stays at the warmup boundary for re-coverage.
        scanPhase = 'cadence';
        if (initialOk) {
            messageCountAtLastScan = warmupMessageCount + initialWindow;
        } else {
            messageCountAtLastScan = warmupMessageCount;
            dlog('[NWST Scanner] Initial scan did not complete — counter held at warmup boundary for re-coverage.');
        }
        saveScannerState(); // Persist immediately after initial scan
        emitScannerHealth();
        dlog('[NWST Scanner] Initial scan complete. Entering cadence phase.');
        return;
    }

    // ── PHASE 2: NORMAL CADENCE ──────────────────────────────────────────
    // Fire every N messages as configured. The counter advances ONLY when a
    // scan actually succeeds — a failed or skipped scan used to burn its
    // whole window permanently (messages in it were never looked at again).
    // On failure the counter holds and the scan retries after 3 more
    // messages, with the gap-sized window covering everything missed.
    const messagesSinceLastScan = currentCount - messageCountAtLastScan;
    if (messagesSinceLastScan >= getScanFrequency()) {
        if (_lastScanFailureCount > 0 && (currentCount - _lastScanFailureCount) < 3) {
            return; // backoff: wait for a few more messages before retrying
        }
        // Process the OLDEST unscanned slice first. The previous implementation
        // capped the prompt at 60 but read the newest 60, then jumped the saved
        // position to the current message count — permanently discarding any
        // older backlog. Advance the counter only by the raw messages covered.
        const scanWindow = Math.min(messagesSinceLastScan, 60);
        const scanStart = messageCountAtLastScan;
        const success = await runScan(scanWindow, scanStart);
        if (success) {
            _lastScanFailureCount = 0;
            messageCountAtLastScan += scanWindow;
            if (messageCountAtLastScan < currentCount) {
                dlog(`[NWST Scanner] Backlog preserved — ${currentCount - messageCountAtLastScan} message(s) remain for the next scan pass.`);
            }
            saveScannerState(); // Persist so reload doesn't reset the countdown
            emitScannerHealth();
        } else {
            _lastScanFailureCount = currentCount;
            saveScannerState();
            if (!_lastScanFailureReason) markScanFailure('Cadence scan did not complete.', scanStart, scanStart + scanWindow);
            dlog('[NWST Scanner] Scan did not complete — counter held; will retry with the full gap.');
            emitScannerHealth();
        }
    }
}

export async function runScan(windowSize = 0, startIndex = null) {
    isScanning = true;
    emitScannerHealth();
    dlog('[NWST Scanner] Running scan...');

    try {
        const chatId = getChatId();
        if (!chatId) { markScanFailure('No active chat detected.'); return false; }

        const profile = resolveProfile('planningLLM');
        if (!profile) {
            dlog('[NWST Scanner] No Planning LLM profile — skipping scan.');
            markScanFailure('No Planning LLM profile configured.', startIndex, Number.isInteger(startIndex) ? startIndex + windowSize : null);
            return false;
        }

        // Keep each individual prompt bounded at 60 messages. When startIndex
        // is supplied by the cadence controller, read that exact oldest backlog
        // slice instead of the newest messages so no unscanned gap is skipped.
        const effectiveWindow = Math.min(Math.max(windowSize || 0, getScanFrequency()), 60);
        const recentMessages = Number.isInteger(startIndex)
            ? getMessagesFromRange(startIndex, effectiveWindow)
            : getRecentMessages(effectiveWindow);
        const worldState = getWorldState(chatId);
        const notebook = getNotebook(chatId);
        const communities = getAllCommunities(chatId);
        const activeEvents = getTrackedEvents(chatId);
        const settingContext = getSettingContext(chatId);

        const userPrompt = buildScannerPrompt(recentMessages, worldState, notebook, activeEvents, settingContext);
        const worldEvidenceSources = buildWorldEvidenceSources(recentMessages, worldState.currentDay, settingContext);
        const worldCommunityPrompt = buildWorldCommunityPrompt(recentMessages, worldState, communities, settingContext, worldEvidenceSources);

        dlog('[NWST Scanner] Calling Planning LLM for detailed continuity...');
        const response = await generateWithProfile(profile, [
            { role: 'system', content: SCANNER_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ], { maxTokens: LLM_TOKEN_BUDGETS.HEAVY });
        if (!response) {
            dlog('[NWST Scanner] Empty detailed-continuity response.');
            markScanFailure('Planning LLM returned an empty detailed-continuity response.', Number.isInteger(startIndex) ? startIndex : null, Number.isInteger(startIndex) ? startIndex + effectiveWindow : null);
            return false;
        }

        dlog('[NWST Scanner] Calling Planning LLM for World/Community maintenance...');
        const worldCommunityResponse = await generateWithProfile(profile, [
            { role: 'system', content: WORLD_COMMUNITY_SYSTEM_PROMPT },
            { role: 'user', content: worldCommunityPrompt }
        ], { maxTokens: LLM_TOKEN_BUDGETS.HEAVY });
        if (!worldCommunityResponse) {
            dlog('[NWST Scanner] Empty World/Community response.');
            markScanFailure('Planning LLM returned an empty World/Community response.', Number.isInteger(startIndex) ? startIndex : null, Number.isInteger(startIndex) ? startIndex + effectiveWindow : null);
            return false;
        }

        // Parse BOTH calls before applying either one. This keeps the cadence
        // window transactional: a malformed second response cannot leave the
        // detailed ledger half-applied and then force the same window to retry.
        const parsedScan = parseJsonObjectResponse(response, 'detailed continuity');
        const parsedWorldCommunity = parseJsonObjectResponse(worldCommunityResponse, 'World/Community');
        if (parsedScan === null || parsedWorldCommunity === null) {
            markScanFailure('Malformed JSON in cadence scan response.', Number.isInteger(startIndex) ? startIndex : null, Number.isInteger(startIndex) ? startIndex + effectiveWindow : null);
            return false;
        }

        const detailedUpdates = await applyScanResults(chatId, parsedScan, recentMessages);
        const worldCommunityUpdates = await applyWorldCommunityResults(chatId, parsedWorldCommunity, worldEvidenceSources, recentMessages, communities);
        const hadUpdates = detailedUpdates || worldCommunityUpdates;

        if (hadUpdates) {
            nwstToast('World state updated.', 'info');
            if (typeof window?.nwstRefreshTabs === 'function') {
                window.nwstRefreshTabs('home', 'world', 'notebook', 'events');
            }
        }

        // Run narrative consistency check (secrets monitoring)
        await runConsistencyCheck();

        // ── Auto-reconcile cadence (Tier 3) ────────────────────────────────
        // Runs the notebook tidy pass every N scans, if enabled (0 = off, manual
        // only). Counted in chatMetadata so it survives reloads.
        try {
            const reconcileCadence = getReconcileCadence();
            if (reconcileCadence > 0) {
                const ctx = SillyTavern.getContext();
                const meta = ctx?.chatMetadata;
                if (meta) {
                    const count = (meta['nwst:scansSinceReconcile'] || 0) + 1;
                    if (count >= reconcileCadence) {
                        meta['nwst:scansSinceReconcile'] = 0;
                        if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
                        await runNotebookReconcile(chatId);
                        if (typeof window?.nwstRefreshTabs === 'function') {
                            window.nwstRefreshTabs('notebook');
                        }
                    } else {
                        meta['nwst:scansSinceReconcile'] = count;
                        if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
                    }
                }
            }
        } catch (e) {
            console.error('[NWST Scanner] Auto-reconcile failed:', e);
        }

        dlog('[NWST Scanner] Scan complete.');
        const rangeStart = Number.isInteger(startIndex) ? startIndex : Math.max(0, getCurrentMessageCount() - effectiveWindow);
        markScanSuccess(rangeStart, rangeStart + effectiveWindow);
        return true;

    } catch (err) {
        console.error('[NWST Scanner] Scan failed:', err);
        markScanFailure(err?.message || 'Unexpected cadence scan error.', Number.isInteger(startIndex) ? startIndex : null, Number.isInteger(startIndex) ? startIndex + (windowSize || 0) : null);
        return false;
    } finally {
        isScanning = false;
        emitScannerHealth();
    }
}

// ── Context gathering ─────────────────────────────────────────────────────

function getCurrentMessageCount() {
    try {
        return SillyTavern.getContext().chat?.length || 0;
    } catch (e) { return 0; }
}

function getRecentMessages(count) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const start = Math.max(0, chat.length - count);
        return chat.slice(start).filter(msg => {
            // Respect ST's message visibility flags
            // Hidden: is_system + extra.hidden, or extra.display === 'none'
            if (msg.is_system && msg.extra?.hidden) return false;
            if (msg.extra?.display === 'none') return false;
            return true;
        });
    } catch (e) { return []; }
}

function getMessagesFromRange(startIndex, count) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const start = Math.max(0, startIndex || 0);
        return chat.slice(start, start + count).filter(msg => {
            if (msg.is_system && msg.extra?.hidden) return false;
            if (msg.extra?.display === 'none') return false;
            return true;
        });
    } catch (e) { return []; }
}


function buildScannerPrompt(recentMessages, worldState, notebook, activeEvents, settingContext) {
    let prompt = '';

    if (settingContext) {
        prompt += `=== SETTING / WORLD FRAME ===\n${settingContext}\n\n`;
    }

    // Recent messages — the primary input
    prompt += `=== RECENT CHAT MESSAGES ===\n`;
    for (const msg of recentMessages) {
        const sender = msg.name || (msg.is_user ? 'User' : 'Character');
        prompt += `[${sender}]: ${msg.mes}\n`;
    }
    prompt += '\n';

    // Current world state anchor
    prompt += `=== CURRENT WORLD STATE ===\n`;
    prompt += `Date: ${worldState.currentDay?.dateDisplay || '(not set)'}\n`;
    prompt += `Season: ${worldState.currentDay?.season || '(not set)'}\n`;
    prompt += `Weather: ${worldState.currentDay?.weatherToday || '(not set)'}\n`;
    prompt += `Calendar day-of-year: ${typeof worldState.currentDay?.dayCount === 'number' ? `Day ${worldState.currentDay.dayCount}` : '(not set)'}\n\n`;

    // ── CALENDAR SYSTEM (date format reference) ─────────────────
    const calConfig = getCalendarConfig(getChatId());
    if (calConfig.enabled) {
        const monthList = calConfig.monthNames.map((name, i) =>
            `${name} (${calConfig.monthDays[i]} days)`
        ).join(', ');
        const dayList = calConfig.weekDays.join(', ');
        prompt += `=== CALENDAR SYSTEM ===\n`;
        prompt += `  Months (${calConfig.months} total): ${monthList}\n`;
        prompt += `  Days of the week (${calConfig.weekDays.length} total): ${dayList}\n`;
        if (Array.isArray(calConfig.specialDays) && calConfig.specialDays.length > 0) {
            prompt += `  Known recurring Special Days:\n`;
            for (const sd of calConfig.specialDays) {
                if (!sd?.name || !Number.isInteger(sd.month) || !Number.isInteger(sd.day)) continue;
                const monthName = calConfig.monthNames[sd.month - 1] || `Month ${sd.month}`;
                prompt += `    - ${sd.name}: ${monthName} ${sd.day}\n`;
            }
        }
        prompt += `  Use these month/day names and Special Day dates when generating scheduledDate values. If an event is tied to a known birthday, holiday, anniversary, or other listed Special Day, attach that concrete date; the calendar will place it into the correct visible horizon or future queue.\n\n`;
    }

    // Existing notebook
    prompt += `=== CURRENT NOTEBOOK ===\n`;
    prompt += formatNotebookForPrompt(notebook);
    prompt += '\n';

    // Existing secrets (for knowledge-aware tracking)
    const allSecrets = notebook.secrets || [];
    if (allSecrets.length > 0) {
        prompt += `=== EXISTING SECRETS & HIDDEN KNOWLEDGE ===\n`;
        for (const secret of allSecrets) {
            prompt += `- "${secret.title}" (${secret.type})\n`;
            prompt += `  Known by: ${secret.whoKnows?.join(', ') || '(none)'}\n`;
            prompt += `  NOT known by: ${secret.whoDoesNotKnow?.join(', ') || '(none)'}\n`;
            if (secret.secret) prompt += `  Details: ${secret.secret}\n`;
            if (secret.revealConditions) prompt += `  Reveal conditions: ${secret.revealConditions}\n`;
            prompt += '\n';
        }
    }

    // Tracked events (including hidden Future Scheduled entries) — listed with stable E# labels so the scan can report
    // event maintenance (resolved / missed / tier corrections) in eventUpdates.
    // The applier rebuilds the same list in the same order to map E# → event.
    if (activeEvents.length > 0) {
        prompt += `=== TRACKED EVENTS (future-scheduled entries may be hidden from the player until they enter range) ===\n`;
        activeEvents.forEach((ev, i) => {
            const dateStr = ev.scheduledDate ? ` [${ev.scheduledDate}]` : '';
            prompt += `E${i + 1}: [${ev.tier}]${dateStr} (${ev.status}) ${ev.title}\n`;
        });
        prompt += '\n';
    }

    prompt += `Review the recent messages and produce your JSON update response. Keep the Notebook self-maintaining: add current information and retire labeled bullets that the new prose has made stale, resolved, contradicted, or superseded.`;

    return prompt;
}

function buildWorldCommunityPrompt(recentMessages, worldState, communities, settingContext, evidenceSources) {
    let prompt = '';

    prompt += `=== LABELED WORLD EVIDENCE SOURCES ===\n`;
    prompt += `For GROUNDED conditions, cite only 1-4 of these source IDs in evidenceRefs. Do not quote them. Current saved conditions below are NOT valid evidence sources.\n\n`;
    prompt += `${formatWorldEvidenceSources(evidenceSources)}\n`;


    const conditions = worldState.conditions || {};
    prompt += `=== CURRENT WORLD CONDITIONS — PERSISTENT STATE, NOT STYLE EXAMPLES ===\n`;
    for (const [key, cond] of Object.entries(conditions)) {
        if (!cond?.enabled) continue;
        prompt += `[${key.toUpperCase()}]: ${cond.content || '(empty)'}\n`;
    }
    prompt += `These saved conditions may already be overly scene-focused. Preserve their valid WORLD-LEVEL facts, but do not imitate scene-level granularity.\n\n`;

    prompt += `=== CURRENT COMMUNITIES — DURABLE GROUP STATE ===\n`;
    if (communities.length === 0) {
        prompt += `(none tracked yet)\n\n`;
    } else {
        for (const com of communities) {
            prompt += `--- ${com.name} ---\n`;
            prompt += `Members: ${com.members || '(unknown)'}\n`;
            prompt += `Summary: ${com.summary || '(empty)'}\n\n`;
        }
    }

    prompt += `Determine whether the WIDER WORLD or any COMMUNITY'S DURABLE COLLECTIVE STATE actually changed. For World Conditions, PRESERVE is the default. Use GROUNDED only for a NEW qualifying macro transition with a valid transitionType and cited source IDs. Use AMBIENT only to fill an empty condition or repair clearly scene-contaminated state; otherwise return update:false. A static fact, continuing operation, ordinary case, or routine institutional process is NOT a Grounded cadence update. Most fields should remain unchanged. Return the required JSON only.`;
    return prompt;
}

const NOTEBOOK_LEDGER_FIELDS = [
    ['core', 'unresolvedDetail', 'UD', 'Unresolved Details'],
    ['core', 'promiseThreatDeadline', 'PT', 'Promises/Threats/Deadlines'],
    ['core', 'offscreenPressure', 'OP', 'Offscreen Pressure'],
    ['core', 'doNotForget', 'DNF', 'Do Not Forget'],
    ['mystery', 'establishedFacts', 'EF', 'Established Facts'],
    ['mystery', 'plantedDetails', 'PD', 'Planted Details'],
    ['mystery', 'characterWhereabouts', 'CW', 'Character Whereabouts'],
    ['mystery', 'inconsistenciesFlagged', 'IF', 'Inconsistencies Flagged'],
    ['mystery', 'currentToneAtmosphere', 'TA', 'Current Tone/Atmosphere']
];

function getNotebookLedger(notebook) {
    const ledger = [];
    for (const [section, field, prefix, label] of NOTEBOOK_LEDGER_FIELDS) {
        const bullets = notebook?.[section]?.[field] || [];
        if (!Array.isArray(bullets)) continue;
        bullets.forEach((text, index) => {
            ledger.push({ id: `${prefix}${index + 1}`, section, field, label, text });
        });
    }
    return ledger;
}

function formatNotebookForPrompt(notebook) {
    const ledger = getNotebookLedger(notebook);
    if (ledger.length === 0) return '(notebook is empty)\n';

    let text = '';
    for (const [, , prefix, label] of NOTEBOOK_LEDGER_FIELDS) {
        const rows = ledger.filter(entry => entry.id.startsWith(prefix));
        if (rows.length === 0) continue;
        text += `${label}:\n`;
        for (const entry of rows) text += `  ${entry.id}: ${entry.text}\n`;
    }
    text += '\nUse these labels in notebookRetirements when recent prose makes an existing bullet stale, superseded, contradicted, resolved, paid off, expired, or no longer current.\n';
    return text;
}

// ── Apply scan results ────────────────────────────────────────────────────

/**
 * Parse a JSON object returned by one of the cadence Planning calls.
 * Parsing happens before either call is applied so one malformed response
 * cannot leave the cadence window half-processed.
 */
function parseJsonObjectResponse(response, label = 'scan') {
    if (!response || typeof response !== 'string') return null;
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        console.warn(`[NWST Scanner] Could not parse ${label} response as JSON.`);
        dlog(`[NWST Scanner] Raw ${label} response:`, response.substring(0, 800));
        return null;
    }
}

function namedBulletPrefix(text) {
    const idx = String(text || '').indexOf(':');
    return idx > 0 ? String(text).slice(0, idx).trim() : '';
}

function sameNamedEntity(chatId, a, b) {
    const aName = namedBulletPrefix(a);
    const bName = namedBulletPrefix(b);
    if (!aName || !bName) return false;
    const registry = buildAliasRegistry(chatId);
    const ar = registry.resolve(aName);
    const br = registry.resolve(bName);
    if (ar && br) return ar === br;
    const ac = toCanonicalId(aName);
    const bc = toCanonicalId(bName);
    return !!ac && ac === bc;
}

function uniqueShortFullMatch(current, existing, incoming) {
    const a = toCanonicalId(namedBulletPrefix(existing));
    const b = toCanonicalId(namedBulletPrefix(incoming));
    if (!a || !b || a === b) return false;
    const aTokens = a.split(' ').filter(Boolean);
    const bTokens = b.split(' ').filter(Boolean);
    let short = null;
    let full = null;
    if (aTokens.length === 1 && aTokens[0].length >= 3 && bTokens.includes(aTokens[0])) { short = aTokens[0]; full = b; }
    if (bTokens.length === 1 && bTokens[0].length >= 3 && aTokens.includes(bTokens[0])) { short = bTokens[0]; full = a; }
    if (!short || !full) return false;
    const candidates = current.filter(item => {
        const c = toCanonicalId(namedBulletPrefix(item));
        return c && c.split(' ').includes(short);
    });
    return candidates.length === 1;
}

async function upsertAliasAwareCoreBullet(chatId, field, bullet) {
    const current = getCoreField(chatId, field) || [];
    const removed = current.filter(existing => sameNamedEntity(chatId, existing, bullet) || uniqueShortFullMatch(current, existing, bullet));
    const kept = current.filter(existing => !removed.includes(existing));
    if (!kept.includes(bullet)) kept.push(bullet);
    if (removed.length === 0 && current.includes(bullet)) return { removed: [], added: [] };
    await replaceCoreFieldQuiet(chatId, field, kept);
    return { removed, added: current.includes(bullet) ? [] : [bullet] };
}

async function upsertAliasAwareMysteryBullet(chatId, field, bullet) {
    const current = getMysteryField(chatId, field) || [];
    const removed = current.filter(existing => sameNamedEntity(chatId, existing, bullet) || uniqueShortFullMatch(current, existing, bullet));
    const kept = current.filter(existing => !removed.includes(existing));
    if (!kept.includes(bullet)) kept.push(bullet);
    return await replaceMysteryFieldDiff(chatId, field, kept);
}

/** Apply the detailed continuity result after both cadence calls parsed. */
async function applyScanResults(chatId, result, recentMessages) {
    if (!result || result.noChanges === true) {
        dlog('[NWST Scanner] Detailed continuity call indicated no changes needed.');
        return false;
    }

    let hadUpdates = false;
    beginMutationBatch('Scan update');  // collect destructive ops for undo/redo

    // ── Retire stale/superseded Notebook state before adding replacements ──
    // Labels refer to the exact Notebook snapshot supplied to the LLM.
    const retirementIds = Array.isArray(result.notebookRetirements)
        ? new Set(result.notebookRetirements.map(id => String(id || '').trim().toUpperCase()).filter(Boolean))
        : new Set();
    if (retirementIds.size > 0) {
        const before = getNotebook(chatId);
        const ledger = getNotebookLedger(before);
        const selected = ledger.filter(entry => retirementIds.has(entry.id.toUpperCase()));
        const grouped = new Map();
        for (const entry of selected) {
            const key = `${entry.section}:${entry.field}`;
            if (!grouped.has(key)) grouped.set(key, { section: entry.section, field: entry.field, entries: [] });
            grouped.get(key).entries.push(entry);
        }
        for (const { section, field, entries } of grouped.values()) {
            const removedTexts = entries.map(entry => entry.text);
            if (section === 'core') {
                const current = getCoreField(chatId, field) || [];
                const kept = current.filter(text => !removedTexts.includes(text));
                if (kept.length !== current.length) {
                    await replaceCoreFieldQuiet(chatId, field, kept);
                    recordMutation('core', field, removedTexts, []);
                    hadUpdates = true;
                }
            } else {
                const current = getMysteryField(chatId, field) || [];
                const kept = current.filter(text => !removedTexts.includes(text));
                if (kept.length !== current.length) {
                    const diff = await replaceMysteryFieldDiff(chatId, field, kept);
                    if (diff && diff.removed.length) recordMutation('mystery', field, diff.removed, diff.added);
                    hadUpdates = true;
                }
            }
        }
    }

    // ── Apply notebook updates ────────────────────────────────────────────
    const nbUpdates = result.notebookUpdates || {};
    const coreFields = ['unresolvedDetail', 'promiseThreatDeadline', 'offscreenPressure', 'doNotForget'];
    const mysteryFields = ['establishedFacts', 'plantedDetails', 'characterWhereabouts', 'inconsistenciesFlagged', 'currentToneAtmosphere'];

    for (const field of coreFields) {
        const bullets = nbUpdates[field];
        if (Array.isArray(bullets) && bullets.length > 0) {
            for (const bullet of bullets) {
                if (bullet && typeof bullet === 'string' && bullet.trim()) {
                    if (field === 'offscreenPressure') {
                        // Source-keyed and alias-aware: "Daniel" and "Daniel Rowan"
                        // cannot accumulate two concurrent pressure entries.
                        const diff = await upsertAliasAwareCoreBullet(chatId, field, bullet.trim());
                        if (diff && (diff.removed.length || diff.added.length)) recordMutation('core', field, diff.removed, diff.added);
                    } else {
                        await addCoreBullet(chatId, field, bullet.trim());
                    }
                    hadUpdates = true;
                }
            }
        }
    }

    for (const field of mysteryFields) {
        const bullets = nbUpdates[field];
        if (Array.isArray(bullets) && bullets.length > 0) {
            for (const bullet of bullets) {
                if (bullet && typeof bullet === 'string' && bullet.trim()) {
                    if (field === 'characterWhereabouts') {
                        // A character has ONE latest-known location. Resolve aliases and
                        // short/full-name variants before replacing the old entry.
                        const diff = await upsertAliasAwareMysteryBullet(chatId, field, bullet.trim());
                        if (diff && (diff.removed.length || diff.added.length)) recordMutation('mystery', field, diff.removed, diff.added);
                    } else if (field === 'currentToneAtmosphere') {
                        // There is ONE current tone — replace, don't accumulate a
                        // history of every tone the story has ever had.
                        const diff = await replaceMysteryFieldDiff(chatId, field, [bullet.trim()]);
                        if (diff && (diff.removed.length || diff.added.length)) recordMutation('mystery', field, diff.removed, diff.added);
                    } else {
                        await addMysteryBullet(chatId, field, bullet.trim());
                    }
                    hadUpdates = true;
                }
            }
        }
    }

    // ── Remove resolved threads (Tier 2) ──────────────────────────────────
    const resolvedThreads = result.resolvedThreads || [];
    if (Array.isArray(resolvedThreads) && resolvedThreads.length > 0) {
        for (const threadField of ['unresolvedDetail', 'promiseThreatDeadline']) {
            const current = getCoreField(chatId, threadField) || [];
            if (current.length === 0) continue;
            // Match resolved bullets (case-insensitive, trimmed) against current
            const resolvedLower = resolvedThreads.map(t => (t || '').toLowerCase().trim());
            const removed = current.filter(b => resolvedLower.includes((b || '').toLowerCase().trim()));
            if (removed.length > 0) {
                const kept = current.filter(b => !removed.includes(b));
                await replaceCoreFieldQuiet(chatId, threadField, kept);
                recordMutation('core', threadField, removed, []);
                hadUpdates = true;
                dlog(`[NWST Scanner] Removed ${removed.length} resolved thread(s) from ${threadField}`);
            }
        }
    }

    // ── Apply event maintenance (resolved / missed / tier corrections) ────
    // E# labels map to the same getTrackedEvents() ordering used when the
    // prompt was built; nothing between build and apply mutates the events
    // array, so the mapping is stable. Flagged events awaiting a player
    // decision are never touched.
    const evUpdates = result.eventUpdates || null;
    if (evUpdates && typeof evUpdates === 'object') {
        try {
            const { updateEvent: updateEvt, setEventStatus: setEvtStatus } = await import('../data/events.js');
            // Identical call to the prompt builder's — same list, same order.
            const activeList = getTrackedEvents(chatId);
            const byRef = new Map();
            activeList.forEach((ev, i) => byRef.set(`e${i + 1}`, ev));
            const refToEvent = (ref) => byRef.get(String(ref).trim().toLowerCase()) || null;
            // Undetermined is protected: neither a valid source nor target
            // for automated tier changes (status changes remain allowed).
            const VALID_TIERS = ['immediate', 'week', 'month'];

            for (const ref of (Array.isArray(evUpdates.resolved) ? evUpdates.resolved : [])) {
                const ev = refToEvent(ref);
                if (!ev || ev.validityFlag || ev.promotionFlag || ev.timingFlag) continue;
                await setEvtStatus(chatId, ev.id, 'resolved');
                dlog(`[NWST Scanner] Event resolved by scan: "${ev.title}"`);
                hadUpdates = true;
            }
            for (const ref of (Array.isArray(evUpdates.missed) ? evUpdates.missed : [])) {
                const ev = refToEvent(ref);
                if (!ev || ev.validityFlag || ev.promotionFlag || ev.timingFlag) continue;
                await setEvtStatus(chatId, ev.id, 'missed');
                dlog(`[NWST Scanner] Event marked missed by scan: "${ev.title}"`);
                hadUpdates = true;
            }
            const tierChanges = (evUpdates.tierChanges && typeof evUpdates.tierChanges === 'object') ? evUpdates.tierChanges : {};
            for (const [ref, tier] of Object.entries(tierChanges)) {
                const ev = refToEvent(ref);
                if (!ev || ev.validityFlag || ev.promotionFlag || ev.timingFlag) continue;
                if (ev.tier === 'undetermined') continue;
                if (ev.scheduledDate || typeof ev.scheduledElapsedStart === 'number') continue;
                if (!VALID_TIERS.includes(tier) || ev.tier === tier) continue;
                await updateEvt(chatId, ev.id, { tier });
                dlog(`[NWST Scanner] Event tier corrected by scan: "${ev.title}" → ${tier}`);
                hadUpdates = true;
            }
        } catch (e) {
            console.warn('[NWST Scanner] Failed to apply event updates:', e);
        }
    }

    // ── Store detected NPC events for user review ─────────────────────────
    // These are proposed, NOT auto-committed — stored as pendingEvents for UI review
    const detectedEvents = result.detectedNPCEvents || [];
    if (detectedEvents.length > 0) {
        // Store proposed events in a staging area for UI review
        // The UI will display these with approve/dismiss options
        try {
            const { chatMetadata, saveMetadata } = SillyTavern.getContext();
            const existing = chatMetadata['nwst:pendingEvents'] || [];
            const existingTitles = new Set(existing.map(e => e.title?.toLowerCase().trim()));
            for (const ev of detectedEvents) {
                if (ev.title && ev.description && !existingTitles.has(ev.title.toLowerCase().trim())) {
                    existing.push({
                        ...ev,
                        id: `pending_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                        isNPC: true,
                        npcOrigin: 'detected',
                        origin: 'detected',
                        status: 'pending',
                        proposedAt: Date.now()
                    });
                    existingTitles.add(ev.title.toLowerCase().trim());
                }
            }
            chatMetadata['nwst:pendingEvents'] = existing;
            await saveMetadata();
            hadUpdates = true;
            dlog(`[NWST Scanner] ${detectedEvents.length} NPC event(s) proposed for review.`);
        } catch (e) {
            console.error('[NWST Scanner] Failed to store pending events:', e);
        }
    }

    // ── Apply new secret creation ──────────────────────────────────────────
    const newSecrets = result.newSecrets || [];
    if (newSecrets.length > 0) {
        const existingSecrets = getAllSecrets(chatId);
        const existingTitles = new Set(existingSecrets.map(s => s.title?.toLowerCase().trim()));

        for (const secretData of newSecrets) {
            if (!secretData.title || !secretData.secret) continue;

            // Deduplicate by title
            const titleLower = secretData.title.toLowerCase().trim();
            if (existingTitles.has(titleLower)) continue;

            // Also check fuzzy overlap on core secret text
            const secretLower = secretData.secret.toLowerCase().trim();
            const isDuplicate = existingSecrets.some(s =>
                (s.secret?.toLowerCase() || '').includes(secretLower) ||
                secretLower.includes(s.secret?.toLowerCase() || '')
            );
            if (isDuplicate) continue;

            await addSecret(chatId, {
                title: secretData.title.trim(),
                type: secretData.type || 'character',
                secret: secretData.secret.trim(),
                evidenceShown: secretData.evidenceShown || '',
                pressureRisk: secretData.pressureRisk || '',
                revealConditions: secretData.revealConditions || '',
                whoKnows: Array.isArray(secretData.whoKnows) ? secretData.whoKnows : [],
                whoDoesNotKnow: Array.isArray(secretData.whoDoesNotKnow) ? secretData.whoDoesNotKnow : [],
                injectionPriority: secretData.injectionPriority || 'normal',
                triggerAnchors: Array.isArray(secretData.triggerAnchors) && secretData.triggerAnchors.length
                    ? { phrases: secretData.triggerAnchors.filter(a => typeof a === 'string' && a.trim()) }
                    : undefined
            });

            existingTitles.add(titleLower);
            hadUpdates = true;
            dlog(`[NWST Scanner] Detected new secret: "${secretData.title}" (${secretData.type})`);
        }
    }

    // ── Handle LLM-detected revealed secrets → flag for archive ─────────────
    const revealedSecrets = result.revealedSecrets || [];
    let flaggedCount = 0;
    if (revealedSecrets.length > 0) {
        const allSecrets = getAllSecrets(chatId);
        const currentMsgIndex = getCurrentMessageCount();
        for (const rev of revealedSecrets) {
            if (!rev || !rev.title) continue;
            const titleLower = rev.title.toLowerCase().trim();
            const match = allSecrets.find(s => (s.title || '').toLowerCase().trim() === titleLower);
            if (match && getSecretStatus(match) === 'active') {
                await flagSecretForArchive(chatId, match.id, 'revealed', currentMsgIndex);
                flaggedCount++;
                dlog(`[NWST Scanner] Secret flagged as revealed: "${match.title}"`);
            }
        }
    }

    // ── Dormancy decay: flag long-dormant secrets for archive review ────────
    // A secret that hasn't injected in a long time has demonstrated irrelevance.
    // High/Critical secrets are EXEMPT — the player marked them important.
    {
        const decayThreshold = getSecretDecayThreshold();
        if (decayThreshold > 0) {
            const currentMsgIndex = getCurrentMessageCount();
            for (const s of getInjectableSecrets(chatId)) {
                if (getSecretStatus(s) !== 'active') continue;
                const pri = (s.injectionPriority || 'normal').toLowerCase();
                if (pri === 'high' || pri === 'critical') continue; // exempt
                const lastInj = s.lastInjectionMsgIndex ?? -1;
                // Never-injected secrets use their creation point if available, else skip
                if (lastInj < 0) continue;
                if (currentMsgIndex - lastInj >= decayThreshold) {
                    await flagSecretForArchive(chatId, s.id, 'dormant', currentMsgIndex);
                    flaggedCount++;
                    dlog(`[NWST Scanner] Secret flagged as dormant: "${s.title}"`);
                }
            }
        }
    }

    // ── Toast the player if anything was flagged for archive review ─────────
    if (flaggedCount > 0) {
        hadUpdates = true;
        nwstToast(
            `${flaggedCount} secret${flaggedCount > 1 ? 's' : ''} flagged for archive review — open the Notebook to decide.`,
            'info'
        );
    }

    await commitMutationBatch();  // finalize undo/redo entry for this scan
    return hadUpdates;
}

async function applyWorldCommunityResults(chatId, result, evidenceSources, recentMessages, communities) {
    if (!result || result.noChanges === true) {
        dlog('[NWST Scanner] World/Community call indicated no changes needed.');
        return false;
    }

    let hadUpdates = false;
    const allowedConditions = new Set(['political', 'social', 'spiritual', 'environmental']);
    const allowedScopes = new Set([
        'institution', 'faction', 'population', 'community', 'district', 'regional',
        'cultural', 'environmental', 'spiritual'
    ]);
    const recentCastNames = collectRecentCastNames(recentMessages, communities);

    const condUpdates = result.conditionUpdates || {};
    const currentConditions = getWorldState(chatId).conditions || {};
    for (const [condName, payload] of Object.entries(condUpdates)) {
        if (!allowedConditions.has(condName) || !payload || typeof payload !== 'object') continue;
        if (!currentConditions[condName]?.enabled) continue; // disabled conditions are not tracked
        if (payload.update !== true) continue;
        const scope = String(payload.scope || '').toLowerCase().trim();
        const content = typeof payload.content === 'string' ? payload.content.trim() : '';
        if (!allowedScopes.has(scope) || !content) {
            dlog(`[NWST Scanner] Rejected ${condName} condition update with invalid scope/content.`);
            continue;
        }
        const validation = validateWorldConditionPayload(payload, evidenceSources, recentCastNames, condName);
        if (!validation.ok) {
            console.warn(`[NWST Scanner] Rejected ${condName} World Condition: ${validation.reason}`);
            continue;
        }
        if (validation.mode === 'ambient') {
            const existingContent = String(currentConditions[condName]?.content || '').trim();
            if (existingContent && !isLikelySceneContaminatedCondition(existingContent, recentCastNames, condName)) {
                dlog(`[NWST Scanner] Preserved existing ${condName} condition; cadence ambient does not churn healthy nonempty state.`);
                continue;
            }
        }
        await updateConditionContent(chatId, condName, content);
        hadUpdates = true;
        dlog(`[NWST Scanner] Updated world condition: ${condName} (${scope}, ${validation.mode})`);
    }

    const comUpdates = Array.isArray(result.communityUpdates) ? result.communityUpdates : [];
    for (const update of comUpdates) {
        if (!update || update.update === false || !update.name || !update.summary) continue;
        const currentList = getAllCommunities(chatId);
        const existing = currentList.find(c => c.name.toLowerCase() === String(update.name).toLowerCase());
        if (existing) {
            await updateCommunitySummary(chatId, existing.id, String(update.summary).trim());
            if (typeof update.members === 'string' && update.members.trim()
                && update.members.trim() !== (existing.members || '').trim()) {
                await updateCommunityMembers(chatId, existing.id, update.members.trim());
                dlog(`[NWST Scanner] Updated members for community: ${update.name}`);
            }
        } else {
            await addCommunity(chatId, {
                name: String(update.name).trim(),
                members: typeof update.members === 'string' ? update.members.trim() : '',
                summary: String(update.summary).trim()
            });
        }
        hadUpdates = true;
        dlog(`[NWST Scanner] Updated community durable state: ${update.name}`);
    }

    return hadUpdates;
}

// ── Community synthesis (dedicated richer pass) ───────────────────────────

/**
 * Run a dedicated community synthesis pass using the richer community prompt.
 * This produces higher-quality community summaries than the inline scanner update.
 * Call this from the batch scan or manually when communities need deep analysis.
 *
 * @param {string} chatId
 * @param {object[]} messages - Messages to analyze
 * @returns {Promise<boolean>} True if communities were updated
 */
export async function synthesizeCommunities(chatId, messages) {
    try {
        const profile = resolveProfile('planningLLM');
        if (!profile) return false;

        const existingCommunities = getAllCommunities(chatId);
        const settingContext = getSettingContext(chatId);

        let userPrompt = '';

        // Provide full message history for community analysis
        userPrompt += `=== CHAT MESSAGES ===\n`;
        for (const msg of messages) {
            const sender = msg.name || (msg.is_user ? 'User' : 'Character');
            userPrompt += `[${sender}]: ${msg.mes}\n`;
        }
        userPrompt += '\n';

        if (settingContext) {
            userPrompt += `=== SETTING CONTEXT ===\n${settingContext}\n\n`;
        }

        if (existingCommunities.length > 0) {
            userPrompt += `=== EXISTING COMMUNITIES (update or add as needed) ===\n`;
            for (const com of existingCommunities) {
                userPrompt += `${com.name} | Members: ${com.members || '(unknown)'}\n`;
                userPrompt += `${com.summary || '(no summary)'}\n`;
            }
            userPrompt += '\n';
        }

        userPrompt += `Analyze the character interactions and produce rich, analytical community summaries. Identify social groupings, power dynamics, unspoken tensions, and what is really happening beneath the surface. Use bullet points (•) for observations, with each bullet being a specific, concrete observation. Do not pad — output only as many bullets as each community genuinely warrants. An optional 1-2 sentence overview paragraph may precede the bullets.`;

        const llmMessages = [
            { role: 'system', content: COMMUNITY_SYNTHESIS_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, llmMessages, { maxTokens: LLM_TOKEN_BUDGETS.HEAVY });
        if (!response) return false;

        // Parse response
        let jsonStr = response.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();
        const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
        if (arrMatch) jsonStr = arrMatch[0];

        const communities = JSON.parse(jsonStr);
        if (!Array.isArray(communities)) return false;

        const existingList = getAllCommunities(chatId);
        for (const com of communities) {
            if (!com.name || !com.summary) continue;
            const existing = existingList.find(c => c.name.toLowerCase() === com.name.toLowerCase());
            if (existing) {
                await updateCommunitySummary(chatId, existing.id, com.summary.trim());
                if (typeof com.members === 'string' && com.members.trim()
                    && com.members.trim() !== (existing.members || '').trim()) {
                    await updateCommunityMembers(chatId, existing.id, com.members.trim());
                }
            } else {
                await addCommunity(chatId, {
                    name: com.name,
                    members: com.members || '',
                    summary: com.summary.trim()
                });
            }
        }

        return true;

    } catch (err) {
        console.error('[NWST Scanner] Community synthesis failed:', err);
        return false;
    }
}
