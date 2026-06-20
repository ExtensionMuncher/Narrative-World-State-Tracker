/* eslint-disable */
// =============================================================================
// NWST Message Scanner — llm/scanner.js
// =============================================================================
// Background scanner that runs every N messages (configurable, default 20).
// Calls the Planning LLM to review recent chat messages and update:
//   - Notebook fields (adds/modifies bullets)
//   - Community summaries
//   - World conditions
//   - Flags NPC detected events (proposed to user, never auto-committed)
//   - Detects new secrets forming in the narrative (auto-created, with dedup)
//
// The scanner does NOT update the Current Day block or auto-commit event changes.
// =============================================================================

import { generateWithProfile } from './connections.js';
import { getChatId, nwstToast } from '../utils.js';
import { getScanFrequency, getScanMinimumMessages, isPaused, isEnabled } from '../settings.js';
import { chatHasData } from '../data/storage.js';
import { getWorldState, getEnabledConditions, getSettingContext, updateConditionContent, getCalendarConfig } from '../data/worldState.js';
import { getActiveEvents } from '../data/events.js';
import { getNotebook, addCoreBullet, addMysteryBullet, addSecret, getAllSecrets } from '../data/notebook.js';
import { getAllCommunities, updateCommunitySummary, addCommunity } from '../data/communities.js';
import { resolveProfile } from './connections.js';
import { runConsistencyCheck } from './narrativeConsistency.js';
import { detectNPCEventsFromChat } from './eventGen.js';
import { dlog } from "../lib/debug.js";

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
let warmupMessageCount = 0;      // Counts messages during Phase 1 warmup
let scanPhase = 'warmup';        // 'warmup' | 'cadence'
let scanTimer = null;
let isScanning = false;

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
            scanPhase
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

// ── Internal system prompts ───────────────────────────────────────────────
// These are not user-editable. The user-editable planner prompt is passed as
// an additional instruction, not as the primary system prompt.

const SCANNER_SYSTEM_PROMPT = `You are a narrative world state scanner for an ongoing roleplay. You review recent chat messages and update the living world state — the notebook, world conditions, and community summaries.

You will receive the recent chat messages, current world state, current notebook, active community summaries, and active events.

WHAT YOU DO:

1. NOTEBOOK UPDATES — add or update bullets in notebook fields based on what happened:
   - unresolvedDetail: new unresolved threads, unanswered questions, things left dangling
   - promiseThreatDeadline: explicit or implied promises, threats, warnings, or deadlines set in the scene
   - offscreenPressure: pressures building away from the scene — other characters' plans, external forces
   - doNotForget: specific important details that must not be dropped (an object, a name, a revealed fact)
   - establishedFacts: things now confirmed as true in this world — do not add speculation
   - plantedDetails: seeds placed in the scene that haven't paid off yet (a meaningful glance, an unexplained object, a subtle shift)
   - characterWhereabouts: where named characters are or were last confirmed to be
   - inconsistenciesFlagged: anything in the recent messages that contradicts established facts
   - currentToneAtmosphere: the current emotional register and tension level of the story

2. WORLD CONDITION UPDATES — update only conditions that meaningfully shifted in the recent messages:
   CRITICAL: World conditions are ATMOSPHERIC NARRATIVES, not factual summaries. They must:
   - Describe the condition's CURRENT MOOD, SUBTEXT, and IMPLICATIONS — not just facts
   - Read the space between what is stated and what is left unsaid
   - Convey tension, movement, or stasis with specificity and texture
   - Sound like a thoughtful narrator interpreting the world, not a journalist listing events
   - Characters and factions MAY be named when their presence shapes the world condition — use names when it adds clarity and grounding. What must NOT appear is: specific character actions that belong in the chat log, personal emotional states, or story events framed as current facts. Describe what the world looks like as a result of forces at work, not what a specific character did or feels right now.

   Example of BAD world condition (factual summary):
   "Sukuna has left for a nearby village. The harem concubines are watching Sachiko."

   Example of GOOD world condition (atmospheric narrative):
   "Sukuna's absence has shifted the gravitational center of the fortress. The concubines move more openly now — assessing, circling, recalibrating. Whatever fragile equilibrium his presence imposed has dissolved into something more volatile and less predictable."

   Only update a condition if something in the recent messages genuinely changes it. If a condition is stable, leave it unchanged.

3. COMMUNITY SUMMARY UPDATES — update community summaries if social dynamics shifted:
   Community summaries must be ANALYTICAL and NUANCED. They are not plot recaps. They should:
   - Read between the lines of character interactions and identify the underlying power dynamics
   - Surface what is unspoken — what characters are maneuvering around, avoiding, or competing for
   - Note specific details that carry weight (a particular choice, a significant omission, a gesture)
   - Describe the internal tensions and pressures within the group, not just the surface events
   - Be dense with insight, not long with description
   - Use bullet points (•) for observations, each a specific concrete observation. Do not pad — output only as many bullets as the community genuinely warrants. An optional 1-2 sentence overview paragraph may precede the bullets.

   CRITICAL — AVOID DUPLICATE COMMUNITIES: Before suggesting a NEW community in communityUpdates, check every existing community name. If an existing community covers the same social group under a different name (e.g., "The Servants" vs "Household Staff"), UPDATE ITS SUMMARY instead of creating a duplicate. Pay attention to member overlap and thematic similarity. Duplicate communities fragment the analysis and must be prevented.

   CRITICAL — AVOID DUPLICATE COMMUNITIES: Before suggesting a NEW community in communityUpdates, check every existing community name. If an existing community covers the same social group under a different name (e.g., "The Servants" vs "Household Staff"), UPDATE ITS SUMMARY instead of creating a duplicate. Pay attention to member overlap and thematic similarity. Duplicate communities fragment the analysis and must be prevented.

4. NPC EVENT DETECTION — identify any EXPLICIT future plans made by characters:
   Only flag events where a character explicitly states or clearly implies something will happen.
   Do NOT infer or extrapolate — only flag what is directly stated.

5. SECRET DETECTION & KNOWLEDGE TRACKING — Two responsibilities:

   a) CONSIDER EXISTING SECRETS when making notebook updates:
      - Character knowledge states affect what notebook fields should reflect (e.g., concealment pressure → offscreenPressure; a secret revealed on-screen → establishedFacts; ongoing concealment → unresolvedDetail)
      - A secret's whoKnows/whoDoesNotKnow lists determine which characters can act on that knowledge

   b) DETECT NEW SECRETS forming in the recent messages:
      - Identify when a character is actively concealing something, makes a hidden agreement, or when information is deliberately withheld
      - Detect secrets that form organically from the narrative (hidden past, concealed plan, forbidden relationship)
      - Check the existing secrets list to avoid duplicates — do NOT recreate secrets that already exist
      - A new secret should include: title, type, core content, who knows it, who does NOT know it
      - Set injectionPriority based on narrative urgency:
        "high" — secrets whose revelation would cause immediate, major consequences (active ticking bomb, imminent betrayal)
        "normal" — standard secrets with clear dramatic potential (default)
        "low" — minor secrets, background details, or secrets with low immediate impact

      TYPE GUIDE:
      "npc": A secret kept by an NPC (default)
      "character": A secret about a character's nature, past, or abilities
      "user_pc": A secret the {{user}} character (the PC) is keeping, or a secret about them
      "environmental": A secret about the world or setting

      RULES for new secrets:
      - Do NOT include the literal label "User" (the real-world person at the keyboard) in whoKnows or whoDoesNotKnow lists — "User" is the OOC author, not a narrative participant
      - The named {{user}} character (the PC) IS a legitimate narrative participant and CAN appear in whoKnows/whoDoesNotKnow
      - When a secret involves the {{user}} character, use type "user_pc", NOT "character"

RESPONSE FORMAT — respond with a JSON object:
{
  "notebookUpdates": {
    "unresolvedDetail": ["new bullet 1", "new bullet 2"],
    "promiseThreatDeadline": [],
    "offscreenPressure": [],
    "doNotForget": [],
    "establishedFacts": [],
    "plantedDetails": [],
    "characterWhereabouts": [],
    "inconsistenciesFlagged": [],
    "currentToneAtmosphere": []
  },
  "conditionUpdates": {
    "political": "Updated atmospheric narrative, or null if unchanged",
    "social": null,
    "spiritual": null,
    "environmental": null
  },
  "communityUpdates": [
    {
      "name": "Community name (must match existing name exactly, or new name if new community)",
      "members": "member list if changed",
      "summary": "Updated analytical summary using bullet points (•) for observations. Do not pad — only as many bullets as the community warrants. An optional 1-2 sentence overview paragraph may precede the bullets."
    }
  ],
  "detectedNPCEvents": [
    {
      "title": "Brief label",
      "description": "What was explicitly stated or clearly implied",
      "tier": "immediate" | "week" | "month" | "undetermined",
      "detectedFrom": "brief reference to what in the chat indicates this"
    }
  ],
  "newSecrets": [
    {
      "title": "Secret title",
      "type": "npc" | "character" | "user_pc" | "environmental",
      "secret": "The hidden knowledge content",
      "whoKnows": ["Character A"],
      "whoDoesNotKnow": ["Character B"],
      "evidenceShown": "optional evidence visible in chat",
      "pressureRisk": "optional risk level",
      "revealConditions": "optional conditions for reveal",
      "injectionPriority": "high" | "normal" | "low"
    }
  ],
  "noChanges": false
}

If nothing meaningful changed, return {"noChanges": true} and nothing else.
Only include fields that have actual updates — empty arrays and null values are fine for unchanged fields.
For notebookUpdates: only include NEW bullets to add. Do not repeat bullets already in the notebook.
For newSecrets: only include secrets that are genuinely new. Do not recreate secrets that already exist in the provided list.`;

// ── Community synthesis prompt (dedicated, richer pass) ───────────────────

const COMMUNITY_SYNTHESIS_PROMPT = `You are a community analyst for an ongoing narrative roleplay. Your job is to write community summaries that combine atmospheric narrative voice with sharp, specific analytical observations — the way a perceptive human observer would describe a social dynamic they have been watching closely.

CRITICAL — AVOID DUPLICATE COMMUNITIES: You will receive a list of EXISTING COMMUNITIES above. Before creating a NEW community in your output, carefully check every existing community name. If an existing community covers the same social group under a different name (e.g., "The Servants" vs "Household Staff"), UPDATE ITS SUMMARY instead of creating a duplicate. Pay attention to member overlap and thematic similarity. Duplicate communities fragment the analysis and must be prevented. When in doubt, merge into the existing entry rather than creating a new one.

Your summaries have two parts. Both must always be present.

PART 1 — OVERVIEW PARAGRAPH (2-4 sentences):
Write with narrative voice and atmosphere. Capture the emotional texture, underlying pressure, and defining dynamic of this group. Name the key players and their roles. Be specific about what makes this group distinctive — not just that tension exists, but what KIND of tension, what SHAPE the dynamic takes, what is at stake. This should read like a perceptive narrator sizing up a room, not a journalist listing facts.

GOOD overview: "A family where the cracks are widening. Yuzu is too observant for her age and suspects Ichigo is hiding serious injuries. Isshin, the boisterous father, has become eerily quiet — he knows more than he lets on. The household is a pressure cooker of unspoken worry, and the lies Ichigo tells will soon break against the walls of a family that loves him."

BAD overview: "The Kurosaki family consists of Ichigo, his sisters, and their father. There is tension because Ichigo is keeping secrets." (roster and vague summary — not analysis)

PART 2 — ANALYTICAL OBSERVATIONS (variable count — determined by the community):
Each bullet must be a specific, concrete observation tied to an actual moment, detail, pattern, or choice from the chat. These are interpretations — what does a specific thing REVEAL about the dynamic? What is being avoided, performed, or withheld? What does a small choice signal about a larger truth?

BULLET COUNT IS A TEST OF ANALYTICAL RIGOR. Do not aim for any specific number. Let the community dictate the count. A simple, peripheral community might warrant only 1-2 bullets. A deeply entangled community might warrant more. Padding by aiming for a specific number is a failure — each bullet must earn its place.

Self-critique (perform silently before finalizing): read each bullet — is it revealing something non-obvious? Is it tied to a specific detail rather than generic? If any bullet fails, delete it. If pruning leaves 1-2 bullets, that is correct. Do not add filler to reach a count.

GOOD bullet (2 sentences max): "Rukia's shift from cold tactical assessment to visible concern — bringing food, giving space instead of orders — marks a structural change in how she processes Sachiko's role in the network. The operational detachment she uses as a shield is failing against something she cannot categorize as a variable."
BAD bullet (too long): same content sprawling across 4 sentences with explanation appended
BAD bullet (summary): "Rukia brought food to Sachiko" — states what happened, not what it reveals
BAD bullet (generic): "There is tension between characters" — reveals nothing

BULLET LENGTH LIMIT — STRICTLY ENFORCED:
Each bullet must be a MAXIMUM of 2 sentences. First sentence: the observation. Second sentence (optional): what it reveals. Cut everything else. If you cannot fit the insight in 2 sentences, you have not distilled it yet.

CRITICAL RULES:
- Characters CAN and SHOULD be named in both the paragraph and bullets — specificity is what separates analysis from vague writing
- No plot recaps — interpret what happened, do not summarize it
- No generic observations — every bullet must surface something not obvious from the surface
- MAXIMUM 2 sentences per bullet — hard limit, no exceptions
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
    }
}

// ── Scan check ────────────────────────────────────────────────────────────

async function checkAndScan() {
    if (!isEnabled() || isPaused() || isScanning) return;

    const currentCount = getCurrentMessageCount();

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
            return;
        }

        if (messagesSinceStart < floor) {
            dlog(`[NWST Scanner] Warmup: ${messagesSinceStart}/${floor} messages.`);
            return; // Not ready yet
        }

        // Floor reached — fire the initial scan
        dlog(`[NWST Scanner] Warmup complete (${messagesSinceStart} messages). Running initial scan...`);
        nwstToast('Running initial world state scan...', 'info');
        await runScan();

        // Transition to cadence phase — cadence counter starts fresh from here
        scanPhase = 'cadence';
        messageCountAtLastScan = getCurrentMessageCount();
        saveScannerState(); // Persist immediately after initial scan
        dlog('[NWST Scanner] Initial scan complete. Entering cadence phase.');
        return;
    }

    // ── PHASE 2: NORMAL CADENCE ──────────────────────────────────────────
    // Fire every N messages as configured.
    const messagesSinceLastScan = currentCount - messageCountAtLastScan;
    if (messagesSinceLastScan >= getScanFrequency()) {
        await runScan();
        messageCountAtLastScan = getCurrentMessageCount();
        saveScannerState(); // Persist so reload doesn't reset the countdown
    }
}

export async function runScan() {
    isScanning = true;
    dlog('[NWST Scanner] Running scan...');

    try {
        const chatId = getChatId();
        if (!chatId) return;

        const profile = resolveProfile('planningLLM');
        if (!profile) {
            dlog('[NWST Scanner] No Planning LLM profile — skipping scan.');
            return;
        }

        const recentMessages = getRecentMessages(getScanFrequency());
        const worldState = getWorldState(chatId);
        const notebook = getNotebook(chatId);
        const communities = getAllCommunities(chatId);
        const activeEvents = getActiveEvents(chatId);
        const settingContext = getSettingContext(chatId);

        const userPrompt = buildScannerPrompt(recentMessages, worldState, notebook, communities, activeEvents, settingContext);

        const messages = [
            { role: 'system', content: SCANNER_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        dlog('[NWST Scanner] Calling Planning LLM...');
        const response = await generateWithProfile(profile, messages);

        if (!response) {
            dlog('[NWST Scanner] Empty response.');
            return;
        }

        const hadUpdates = await applyScanResults(chatId, response, recentMessages);

        if (hadUpdates) {
            nwstToast('World state updated.', 'info');
            if (typeof window?.nwstRefreshTabs === 'function') {
                window.nwstRefreshTabs('home', 'world', 'notebook', 'events');
            }
        }

        // Run narrative consistency check (secrets monitoring)
        await runConsistencyCheck();

        dlog('[NWST Scanner] Scan complete.');

    } catch (err) {
        console.error('[NWST Scanner] Scan failed:', err);
    } finally {
        isScanning = false;
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


function buildScannerPrompt(recentMessages, worldState, notebook, communities, activeEvents, settingContext) {
    let prompt = '';

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
    prompt += `Story day: ${typeof worldState.currentDay?.dayCount === 'number' ? `Day ${worldState.currentDay.dayCount}` : '(not set)'}\n\n`;

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
        prompt += `  Use these month and day names when generating scheduledDate values.\n\n`;
    }

    // Existing world conditions (so the LLM knows what's already there)
    const conditions = worldState.conditions || {};
    const hasConditions = Object.values(conditions).some(c => c.enabled && c.content);
    if (hasConditions) {
        prompt += `=== CURRENT WORLD CONDITIONS (update only if changed) ===\n`;
        for (const [key, cond] of Object.entries(conditions)) {
            if (cond.enabled) {
                prompt += `[${key.toUpperCase()}]: ${cond.content || '(not yet set)'}\n`;
            }
        }
        prompt += '\n';
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

    // Community summaries
    if (communities.length > 0) {
        prompt += `=== CURRENT COMMUNITY SUMMARIES (update only if dynamics shifted) ===\n`;
        for (const com of communities) {
            prompt += `--- ${com.name} (${com.members || 'members unknown'}) ---\n`;
            prompt += `${com.summary || '(no summary yet)'}\n\n`;
        }
    }

    // Active events (for reference only)
    if (activeEvents.length > 0) {
        prompt += `=== ACTIVE EVENTS ===\n`;
        for (const ev of activeEvents) {
            const dateStr = ev.scheduledDate ? ` [${ev.scheduledDate}]` : '';
            prompt += `- [${ev.tier}]${dateStr} ${ev.title}\n`;
        }
        prompt += '\n';
    }

    if (settingContext) {
        prompt += `=== SETTING CONTEXT ===\n${settingContext}\n\n`;
    }

    prompt += `Review the recent messages and produce your JSON update response.`;

    return prompt;
}
function formatNotebookForPrompt(notebook) {
    let text = '';
    const core = notebook?.core || {};
    const mystery = notebook?.mystery || {};

    if (core.unresolvedDetail?.length)       text += `Unresolved Details:\n${core.unresolvedDetail.map(b => `  - ${b}`).join('\n')}\n`;
    if (core.promiseThreatDeadline?.length)   text += `Promises/Threats:\n${core.promiseThreatDeadline.map(b => `  - ${b}`).join('\n')}\n`;
    if (core.offscreenPressure?.length)       text += `Offscreen Pressure:\n${core.offscreenPressure.map(b => `  - ${b}`).join('\n')}\n`;
    if (core.doNotForget?.length)             text += `Do Not Forget:\n${core.doNotForget.map(b => `  - ${b}`).join('\n')}\n`;
    if (mystery.establishedFacts?.length)     text += `Established Facts:\n${mystery.establishedFacts.map(b => `  - ${b}`).join('\n')}\n`;
    if (mystery.plantedDetails?.length)       text += `Planted Details:\n${mystery.plantedDetails.map(b => `  - ${b}`).join('\n')}\n`;
    if (mystery.characterWhereabouts?.length) text += `Character Whereabouts:\n${mystery.characterWhereabouts.map(b => `  - ${b}`).join('\n')}\n`;
    if (mystery.inconsistenciesFlagged?.length) text += `Inconsistencies Flagged:\n${mystery.inconsistenciesFlagged.map(b => `  - ${b}`).join('\n')}\n`;
    if (mystery.currentToneAtmosphere?.length)  text += `Current Tone/Atmosphere:\n${mystery.currentToneAtmosphere.map(b => `  - ${b}`).join('\n')}\n`;

    return text || '(notebook is empty)\n';
}

// ── Apply scan results ────────────────────────────────────────────────────

/**
 * Parse the Planning LLM's JSON response and apply updates to storage.
 *
 * @param {string} chatId
 * @param {string} response - LLM response text
 * @param {object[]} recentMessages - Recent messages (for NPC detection pass)
 * @returns {Promise<boolean>} True if any updates were applied
 */
async function applyScanResults(chatId, response, recentMessages) {
    if (!response || typeof response !== 'string') return false;

    let result = null;
    let jsonStr = response.trim();

    // Strip markdown code fences
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Find outermost JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];

    try {
        result = JSON.parse(jsonStr);
    } catch (e) {
        console.warn('[NWST Scanner] Could not parse scan response as JSON. Logging raw response.');
        dlog('[NWST Scanner] Raw response:', response.substring(0, 800));
        return false;
    }

    if (!result || result.noChanges === true) {
        dlog('[NWST Scanner] LLM indicated no changes needed.');
        return false;
    }

    let hadUpdates = false;

    // ── Apply notebook updates ────────────────────────────────────────────
    const nbUpdates = result.notebookUpdates || {};
    const coreFields = ['unresolvedDetail', 'promiseThreatDeadline', 'offscreenPressure', 'doNotForget'];
    const mysteryFields = ['establishedFacts', 'plantedDetails', 'characterWhereabouts', 'inconsistenciesFlagged', 'currentToneAtmosphere'];

    for (const field of coreFields) {
        const bullets = nbUpdates[field];
        if (Array.isArray(bullets) && bullets.length > 0) {
            for (const bullet of bullets) {
                if (bullet && typeof bullet === 'string' && bullet.trim()) {
                    await addCoreBullet(chatId, field, bullet.trim());
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
                    await addMysteryBullet(chatId, field, bullet.trim());
                    hadUpdates = true;
                }
            }
        }
    }

    // ── Apply world condition updates ─────────────────────────────────────
    const condUpdates = result.conditionUpdates || {};
    for (const [condName, content] of Object.entries(condUpdates)) {
        if (content && typeof content === 'string' && content.trim() &&
            ['political', 'social', 'spiritual', 'environmental'].includes(condName)) {
            await updateConditionContent(chatId, condName, content.trim());
            hadUpdates = true;
            dlog(`[NWST Scanner] Updated world condition: ${condName}`);
        }
    }

    // ── Apply community summary updates ───────────────────────────────────
    const comUpdates = result.communityUpdates || [];
    const existingCommunities = getAllCommunities(chatId);

    for (const update of comUpdates) {
        if (!update.name || !update.summary) continue;
        const existing = existingCommunities.find(c => c.name.toLowerCase() === update.name.toLowerCase());
        if (existing) {
            await updateCommunitySummary(chatId, existing.id, update.summary.trim());
        } else {
            // New community detected — create it
            await addCommunity(chatId, {
                name: update.name,
                members: update.members || '',
                summary: update.summary.trim()
            });
        }
        hadUpdates = true;
        dlog(`[NWST Scanner] Updated community: ${update.name}`);
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
                type: secretData.type || 'npc',
                secret: secretData.secret.trim(),
                evidenceShown: secretData.evidenceShown || '',
                pressureRisk: secretData.pressureRisk || '',
                revealConditions: secretData.revealConditions || '',
                whoKnows: Array.isArray(secretData.whoKnows) ? secretData.whoKnows : [],
                whoDoesNotKnow: Array.isArray(secretData.whoDoesNotKnow) ? secretData.whoDoesNotKnow : [],
                injectionPriority: secretData.injectionPriority || 'normal'
            });

            existingTitles.add(titleLower);
            hadUpdates = true;
            dlog(`[NWST Scanner] Detected new secret: "${secretData.title}" (${secretData.type})`);
        }
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
        const notebook = getNotebook(chatId);
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
                userPrompt += `${com.name}: ${com.summary || '(no summary)'}\n`;
            }
            userPrompt += '\n';
        }

        // Key notebook facts for community analysis
        const facts = notebook?.mystery?.establishedFacts || [];
        if (facts.length > 0) {
            userPrompt += `=== ESTABLISHED FACTS ===\n${facts.map(f => `  - ${f}`).join('\n')}\n\n`;
        }

        userPrompt += `Analyze the character interactions and produce rich, analytical community summaries. Identify social groupings, power dynamics, unspoken tensions, and what is really happening beneath the surface. Use bullet points (•) for observations, with each bullet being a specific, concrete observation. Do not pad — output only as many bullets as each community genuinely warrants. An optional 1-2 sentence overview paragraph may precede the bullets.`;

        const llmMessages = [
            { role: 'system', content: COMMUNITY_SYNTHESIS_PROMPT },
            { role: 'user', content: userPrompt }
        ];

        const response = await generateWithProfile(profile, llmMessages);
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
