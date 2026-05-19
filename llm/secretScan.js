/* eslint-disable */
// =============================================================================
// NWST Secret Scanner — llm/secretScan.js
// =============================================================================
// Scans the FULL chat history to identify and extract hidden knowledge,
// character secrets, dramatic ironies, and unconfirmed suspicions.
//
// Uses the same chunk-and-synthesize pattern as the batch scan:
//   1. Chunk the full chat history into context-window-safe segments
//   2. Process chunks sequentially through the Planning LLM
//   3. Show ST native toast notifications at each stage
//   4. Synthesize all accumulated analysis into a final secrets list
//   5. De-duplicate against existing secrets
//   6. Add new secrets via the notebook CRUD
//
// Unlike the full batch scan, this does NOT overwrite existing data and
// does NOT require chatHasData() to be false — it can be run multiple times.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';;
import { resolveProfile, generateWithProfile } from './connections.js';
import { getNotebook, addSecret } from '../data/notebook.js';

// ── Configuration ──────────────────────────────────────────────────────────

const PLANNING_ROLE = 'planningLLM';

// ── Chunk Analysis Prompt ──────────────────────────────────────────────────
// Focused purely on secrets, hidden knowledge, and information asymmetries.

const SECRET_CHUNK_PROMPT = `You are analyzing a segment of a roleplay chat history to identify secrets, hidden knowledge, and information asymmetries. Read carefully and extract:

1. Any information one character knows that another does NOT know
2. Hidden agendas, undisclosed motivations, or concealed facts
3. Dramatic ironies — information the reader/user knows that characters don't
4. Unconfirmed suspicions — something a character suspects but hasn't verified
5. World-level hidden knowledge — conspiracies, concealed history, forbidden lore
6. Any moment where a character lies, omits, deflects, or misdirects
7. Character relationships with asymmetrical knowledge (e.g. mentor knows more than apprentice)

For each item you find, note:
- What the secret IS (the hidden information)
- Which characters are involved (who knows, who doesn't)
- What type it is (character secret, world secret, dramatic irony, suspicion)
- What evidence has been shown so far
- What might cause it to be revealed

IMPORTANT — Do NOT include the literal label "User" (the real-world person typing at the keyboard) in whoKnows or whoDoesNotKnow lists. That is the out-of-character author, not the PC.
BUT DO include the named {{user}} character (the PC's actual name) when they are involved in a secret — they are a legitimate narrative participant.
When a secret involves the {{user}} character (the PC), classify it as type "user_pc" — NOT "character".

Accumulate your findings. If this is not the final chunk, do not produce final output yet — just summarize what you found in plain text for later synthesis.`;

// ── Final Synthesis System Prompt ──────────────────────────────────────────

const SECRET_SYNTHESIS_SYSTEM_PROMPT = `You are synthesizing the final results of a full-chat secret scan. You have analyzed every message in the roleplay chat history. Now produce a structured JSON array of secret objects.

Each secret object must follow this exact schema:
{
  "title": "Short, descriptive label — e.g. 'Akira's true identity', 'The poisoned wine'",
  "type": "character" | "user_pc" | "world" | "dramatic_irony" | "unconfirmed_suspicion",
  "secret": "Detailed explanation of what the secret IS. 1-3 sentences.",
  "whoKnows": ["Character name who knows this secret"],
  "whoDoesNotKnow": ["Character name who does NOT know this secret"],
  "evidenceShown": "What evidence has been shown in the chat so far (if any)",
  "pressureRisk": "What pressure or risk would be created if this secret were revealed",
  "revealConditions": "Under what circumstances this secret might be revealed",
  "injectionPriority": "high" | "normal" | "low"
}

IMPORTANT RULES:
1. Only generate secrets that are SUPPORTED BY the chat messages. Do not invent unrelated secrets.
2. Do NOT duplicate any secrets already in the "EXISTING SECRETS" list provided to you.
3. A secret must have at least one character who knows it (or be a dramatic irony known only to the reader).
4. "whoKnows" and "whoDoesNotKnow" must reference actual character names from the chat.
5. Do NOT include the literal label "User" (the real-world typist, not the PC) in whoKnows or whoDoesNotKnow. The named {{user}} character IS acceptable — only the fallback "User" label should be excluded.
6. If no new secrets are found, return an empty array [].
7. Quality over quantity — 2-5 high-quality, well-developed secrets are better than 10 shallow ones.
8. Consider secrets from ALL parts of the chat — early messages may contain setup and reveals.

TYPE GUIDE:
- "character": A secret one character keeps from another (e.g. betrayal, hidden identity, true motives)
- "user_pc": A secret the {{user}} character (the PC) is keeping, or a secret about the {{user}} character. Use this when the secret involves the user character as the keeper or subject.
- "world": A world-level secret — conspiracies, concealed history, forbidden knowledge
- "dramatic_irony": The audience/user knows something the characters don't
- "unconfirmed_suspicion": A character suspects something but hasn't confirmed it

INJECTION PRIORITY GUIDE:
- "high" — secrets whose revelation would cause immediate, major consequences (active ticking bomb, imminent betrayal)
- "normal" — standard secrets with clear dramatic potential (default)
- "low" — minor secrets, background details, or secrets with low immediate impact

When the secret involves the {{user}} character, ALWAYS use type "user_pc", NOT "character".

Respond with valid JSON ONLY. No markdown fences. No explanation outside the JSON.`;

// ── Message access ─────────────────────────────────────────────────────────
// Reads ALL messages (same exception as batch scan for initial scanning).

function getAllMessagesUnfiltered() {
    try {
        return SillyTavern.getContext().chat || [];
    } catch (e) {
        console.error('[NWST SecretScan] Error accessing chat:', e);
        return [];
    }
}

// ── Chunking ───────────────────────────────────────────────────────────────

function chunkMessages(messages, approxTokensPerChunk) {
    const charsPerChunk = approxTokensPerChunk * 4;
    const chunks = [];
    let currentChunk = [];
    let currentChars = 0;

    for (const msg of messages) {
        const msgText = `[${msg.name || (msg.is_user ? 'User' : 'Character')}]: ${msg.mes || ''}`;
        const msgChars = msgText.length;

        if (currentChars + msgChars > charsPerChunk && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentChars = 0;
        }

        currentChunk.push(msg);
        currentChars += msgChars;
    }

    if (currentChunk.length > 0) chunks.push(currentChunk);
    return chunks;
}

// ── Format a chunk for the LLM ─────────────────────────────────────────────

function formatChunkForLLM(chunk, chunkNum, totalChunks, startMsg, endMsg) {
    let text = `CHUNK ${chunkNum}/${totalChunks} — Messages ${startMsg}–${endMsg}\n`;

    if (chunkNum === 1) {
        text += `This is the BEGINNING of the chat history. Pay special attention to character introductions, relationship dynamics, and any early setup that could imply secrets or hidden knowledge.\n\n`;
    } else if (chunkNum === totalChunks) {
        text += `This is the FINAL chunk — the most recent messages. Look for newly revealed secrets, knowledge that has changed hands, or new hidden information introduced.\n\n`;
    } else {
        text += `Continue building your understanding of secrets and hidden knowledge in the narrative.\n\n`;
    }

    for (const msg of chunk) {
        const sender = msg.name || (msg.is_user ? 'User' : 'Character');
        text += `[${sender}]: ${msg.mes}\n`;
    }

    text += `\n(End of chunk ${chunkNum}/${totalChunks})`;
    return text;
}

// ── Build the synthesis prompt ─────────────────────────────────────────────

function buildSynthesisPrompt(accumulatedContext, existingSecrets) {
    let prompt = `You have analyzed the full chat history for secrets and hidden knowledge. Here is your accumulated analysis:\n\n`;
    prompt += accumulatedContext;
    prompt += `\n\nNow synthesize the COMPLETE set of new secrets as a JSON array of objects.\n\n`;

    // Feed existing secrets for de-duplication
    if (existingSecrets.length > 0) {
        prompt += `=== EXISTING SECRETS (DO NOT DUPLICATE) ===\n`;
        for (const s of existingSecrets) {
            prompt += `- [${s.type}] "${s.title}": ${s.secret}\n`;
            if (s.whoKnows?.length) prompt += `  Who knows: ${s.whoKnows.join(', ')}\n`;
            if (s.whoDoesNotKnow?.length) prompt += `  Who does NOT know: ${s.whoDoesNotKnow.join(', ')}\n`;
        }
        prompt += `\n`;
    } else {
        prompt += `No existing secrets.\n\n`;
    }

    prompt += `Use this EXACT JSON structure — an array of secret objects:\n\n`;
    prompt += `[
  {
    "title": "Short descriptive label",
    "type": "character|user_pc|world|dramatic_irony|unconfirmed_suspicion",
    "secret": "Detailed explanation of the secret",
    "whoKnows": ["CharacterName"],
    "whoDoesNotKnow": ["CharacterName"],
    "evidenceShown": "What evidence has been shown",
    "pressureRisk": "Risk if revealed",
    "revealConditions": "When it might be revealed",
    "injectionPriority": "high|normal|low"
  }
]\n\n`;
    prompt += `CRITICAL — QUALITY CHECKLIST:\n`;
    prompt += `  ✓ Every secret's title and secret field are filled in\n`;
    prompt += `  ✓ whoKnows and whoDoesNotKnow contain actual character names from the chat\n`;
    prompt += `  ✓ No duplicates with the EXISTING SECRETS list above\n`;
    prompt += `  ✓ Each secret is genuinely supported by the chat content\n`;
    prompt += `  ✓ Types are correctly assigned based on the TYPE GUIDE\n`;
    prompt += `  ✓ If no new secrets, return []\n\n`;
    prompt += `Respond with valid JSON ONLY. No markdown fences. No explanation outside the JSON.`;

    return prompt;
}

// ── Parse LLM response ────────────────────────────────────────────────────

function parseSecretsResponse(response) {
    if (!response || typeof response !== 'string') return [];

    let jsonStr = response.trim();

    // Strip markdown fences
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Find outermost array or object wrapper
    const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrMatch) jsonStr = arrMatch[0];

    try {
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
            return parsed.filter(s => s && s.title && s.secret);
        }
        return [];
    } catch (e) {
        // Try extracting from object wrapper
        try {
            const obj = JSON.parse(jsonStr);
            if (obj.secrets && Array.isArray(obj.secrets)) {
                return obj.secrets.filter(s => s && s.title && s.secret);
            }
            if (obj.newSecrets && Array.isArray(obj.newSecrets)) {
                return obj.newSecrets.filter(s => s && s.title && s.secret);
            }
        } catch (e2) {
            console.warn('[NWST SecretScan] Could not parse response:', e2);
        }
        return [];
    }
}

// ── De-duplicate against existing secrets ──────────────────────────────────

function deduplicateSecrets(candidates, existingSecrets) {
    const existingLower = existingSecrets.map(s => ({
        title: (s.title || '').toLowerCase().trim(),
        secret: (s.secret || '').toLowerCase().trim()
    }));

    return candidates.filter(candidate => {
        const title = (candidate.title || '').toLowerCase().trim();
        const secret = (candidate.secret || '').toLowerCase().trim();

        const isDuplicate = existingLower.some(ex => {
            if (ex.title === title) return true;
            if (title.length > 5 && ex.title.length > 5) {
                if (title.includes(ex.title) || ex.title.includes(title)) return true;
            }
            if (secret.length > 10 && ex.secret.length > 10) {
                if (secret.includes(ex.secret) || ex.secret.includes(secret)) return true;
            }
            return false;
        });

        return !isDuplicate;
    });
}

// ── Main scan function ─────────────────────────────────────────────────────

/**
 * Scan the FULL chat history for secrets via the Planning LLM.
 * Uses the same chunk-and-synthesize pattern as batch scan.
 * Adds new secrets to the notebook and returns the count added.
 *
 * Can be run multiple times — does NOT overwrite existing data.
 *
 * @param {string} chatId - The chat ID to scan
 * @returns {Promise<number>} Number of new secrets added
 */
export async function scanForSecrets(chatId) {
    // ── 1. Resolve Planning LLM profile ───────────────────────────────────
    const profile = resolveProfile(PLANNING_ROLE);
    if (!profile) {
        nwstToast(
            'Secret scan requires a Planning LLM profile. Configure one in Settings → Connection Profiles.',
            'warning'
        );
        return 0;
    }

    nwstToast('Secret scan started — analyzing chat history...', 'info');

    // ── 2. Get ALL messages (same exception as batch scan) ─────────────────
    const allMessages = getAllMessagesUnfiltered();
    if (allMessages.length === 0) {
        nwstToast('No chat messages found to scan.', 'warning');
        return 0;
    }

    // ── 3. Get existing secrets for de-duplication ─────────────────────────
    const nb = getNotebook(chatId);
    const existingSecrets = Array.isArray(nb.secrets) ? nb.secrets : [];

    // ── 4. Chunk messages ──────────────────────────────────────────────────
    const maxContext = SillyTavern.getContext().maxContext || 8000;
    const chunkSize = Math.floor(maxContext * 0.6);
    const chunks = chunkMessages(allMessages, chunkSize);

    console.log(`[NWST SecretScan] Scanning ${allMessages.length} messages in ${chunks.length} chunks...`);

    // ── 5. Process each chunk sequentially ─────────────────────────────────
    let accumulatedContext = '';

    for (let i = 0; i < chunks.length; i++) {
        const messagesPerChunk = Math.ceil(allMessages.length / chunks.length);
        const startMsg = i * messagesPerChunk + 1;
        const endMsg = Math.min((i + 1) * messagesPerChunk, allMessages.length);

        nwstToast(`Secret scan: processing messages ${startMsg}–${endMsg}...`, 'info');

        const chunkText = formatChunkForLLM(chunks[i], i + 1, chunks.length, startMsg, endMsg);

        const llmMessages = [
            { role: 'system', content: SECRET_CHUNK_PROMPT },
            { role: 'user', content: chunkText }
        ];

        const response = await generateWithProfile(profile, llmMessages);
        if (response) {
            accumulatedContext += `\n--- Chunk ${i + 1}/${chunks.length} Analysis ---\n${response}\n`;
        }
    }

    // ── 6. Synthesize final secrets list ───────────────────────────────────
    nwstToast('Secret scan: synthesizing results...', 'info');

    const synthesisPrompt = buildSynthesisPrompt(accumulatedContext, existingSecrets);

    const synthMessages = [
        { role: 'system', content: SECRET_SYNTHESIS_SYSTEM_PROMPT },
        { role: 'user', content: synthesisPrompt }
    ];

    const response = await generateWithProfile(profile, synthMessages, { maxTokens: 4096 });

    if (!response) {
        nwstToast('Secret scan completed but no structured data was returned.', 'warning');
        return 0;
    }

    // ── 7. Parse ───────────────────────────────────────────────────────────
    const candidates = parseSecretsResponse(response);

    if (candidates.length === 0) {
        nwstToast('No new secrets detected in the chat history.', 'info');
        return 0;
    }

    // ── 8. De-duplicate ───────────────────────────────────────────────────
    const newSecrets = deduplicateSecrets(candidates, existingSecrets);

    if (newSecrets.length === 0) {
        nwstToast('All detected secrets already exist in the notebook.', 'info');
        return 0;
    }

    // ── 9. Add new secrets ────────────────────────────────────────────────
    let addedCount = 0;
    for (const secret of newSecrets) {
        try {
            await addSecret(chatId, {
                title: secret.title || 'Untitled secret',
                type: secret.type || 'character',
                secret: secret.secret || '',
                whoKnows: Array.isArray(secret.whoKnows) ? secret.whoKnows : [],
                whoDoesNotKnow: Array.isArray(secret.whoDoesNotKnow) ? secret.whoDoesNotKnow : [],
                evidenceShown: secret.evidenceShown || '',
                pressureRisk: secret.pressureRisk || '',
                revealConditions: secret.revealConditions || '',
                injectionPriority: secret.injectionPriority || 'normal'
            });
            addedCount++;
        } catch (err) {
            console.error('[NWST SecretScan] Failed to add secret:', err, secret);
        }
    }

    console.log(`[NWST SecretScan] Added ${addedCount} new secret(s) (${candidates.length} detected, ${newSecrets.length} after dedup).`);

    if (typeof window?.nwstRefreshTabs === 'function') {
        window.nwstRefreshTabs('notebook');
    }

    return addedCount;
}
