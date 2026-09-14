/* eslint-disable */
// =============================================================================
// NWST Event Participant Completion — llm/eventParticipants.js
// =============================================================================
// Central participant normalization/completion used by Batch Scan, Generate
// Events, and the Debug participant-review command.
//
// Rules:
//   • NPC events MUST be completed with at least one named participant whenever possible.
//   • Non-NPC events still receive participants when named actors directly
//     attend, organize, carry out, or are assigned responsibility for them.
//   • Empty arrays are reserved for genuinely ambient world events.
//   • Existing participants are preserved; completion only adds grounded names.
// =============================================================================

import { buildAliasRegistry, toCanonicalId } from '../data/aliasRegistry.js';
import { getAllCommunities } from '../data/communities.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { LLM_TOKEN_BUDGETS } from './tokenBudgets.js';

const PARTICIPANT_BATCH_SIZE = 12;

function isNpcEventValue(value) {
    if (typeof value === 'string') return /^(true|1|yes|npc)$/i.test(value.trim());
    return value === true || value === 1;
}

const GENERIC_PARTICIPANT_RE = /^(?:unknown|unnamed|someone|anyone|everyone|various|multiple|several|the\s+)?(?:operatives?|staff|employees?|lieutenants?|members?|team|group|crowd|public|attendees?|participants?|officials?|agents?|guards?|workers?|customers?)$/i;

function cleanParticipantName(raw) {
    let name = String(raw || '').trim();
    if (!name) return '';
    // Community member strings sometimes append status notes such as
    // "Yamamoto Ichirō (suspended)". Status is not part of the identity.
    name = name.replace(/\s*\([^)]{1,60}\)\s*$/, '').trim();
    if (!name || name.length > 100 || GENERIC_PARTICIPANT_RE.test(name)) return '';
    if (/^(?:unknown|unnamed|someone|anyone|everyone|various|multiple|several)\b/i.test(name)) return '';
    return name;
}

export function normalizeEventParticipants(values) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(values) ? values : []) {
        const name = cleanParticipantName(raw);
        const key = toCanonicalId(name);
        if (!name || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}

function splitCommunityMembers(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    return value.split(/[,;\n]/g).map(v => v.trim()).filter(Boolean);
}

function extractWhereaboutNames(notebook) {
    const out = [];
    for (const line of notebook?.mystery?.characterWhereabouts || []) {
        const text = String(line || '').trim();
        const idx = text.indexOf(':');
        if (idx > 0) out.push(text.slice(0, idx).trim());
    }
    return out;
}

function collectExtraNames(options = {}) {
    const names = [];
    names.push(...(options.extraNames || []));
    names.push(...extractWhereaboutNames(options.notebook));

    for (const secret of options.secrets || []) {
        names.push(...(secret?.whoKnows || []), ...(secret?.whoDoesNotKnow || []));
    }
    for (const community of options.communities || []) {
        names.push(...splitCommunityMembers(community?.members));
    }
    return normalizeEventParticipants(names);
}

function buildRoster(chatId, options = {}) {
    const registry = buildAliasRegistry(chatId);
    const existingCommunities = getAllCommunities(chatId) || [];
    const extraCommunities = options.communities || [];
    const extraNames = collectExtraNames({ ...options, communities: [...existingCommunities, ...extraCommunities] });

    const byCanonical = new Map();
    for (const entity of registry.allEntities()) {
        if (entity.kinds?.includes('group') || entity.kinds?.includes('organization')) continue;
        const key = entity.canonical || toCanonicalId(entity.display);
        if (key) byCanonical.set(key, entity.display || key);
    }
    for (const name of extraNames) {
        const resolved = registry.resolve(name) || toCanonicalId(name);
        if (resolved && !byCanonical.has(resolved)) byCanonical.set(resolved, name);
    }

    return {
        registry,
        byCanonical,
        displays: Array.from(byCanonical.values())
    };
}

function directMentionParticipants(event, roster) {
    const text = `${event?.title || ''}\n${event?.description || ''}`;
    const found = new Set(roster.registry.scanProse(text));
    const normalizedText = ` ${toCanonicalId(text)} `;

    // The registry may not yet contain names generated in the same Batch Scan.
    for (const [canonical] of roster.byCanonical) {
        if (canonical.length >= 3 && normalizedText.includes(` ${canonical} `)) found.add(canonical);
    }

    return Array.from(found)
        .filter(canonical => roster.byCanonical.has(canonical))
        .map(canonical => roster.byCanonical.get(canonical))
        .filter(Boolean);
}

function canonicalizeCandidate(rawName, event, roster) {
    const name = String(rawName || '').trim();
    if (!name) return '';
    const resolved = roster.registry.resolve(name) || toCanonicalId(name);
    if (!resolved) return '';
    if (roster.byCanonical.has(resolved)) return roster.byCanonical.get(resolved);

    // Allow a same-response proper name only when it is written directly in
    // the event itself. This prevents the completion pass from inventing cast.
    const eventText = toCanonicalId(`${event?.title || ''} ${event?.description || ''}`);
    if (eventText && (` ${eventText} `).includes(` ${resolved} `)) return name;
    return '';
}

function participantContextBlock(options = {}, roster) {
    const communities = [
        ...(getAllCommunities(options.chatId) || []),
        ...(options.communities || [])
    ];
    const communityText = communities.slice(0, 12).map(com => {
        const members = splitCommunityMembers(com?.members).join(', ') || '(members unknown)';
        return `- ${com?.name || 'Unnamed group'}: ${members}`;
    }).join('\n');

    return [
        'KNOWN CHARACTER ROSTER:',
        roster.displays.length ? roster.displays.join(', ') : '(no roster available)',
        '',
        'COMMUNITY MEMBERSHIP REFERENCE:',
        communityText || '(no communities available)'
    ].join('\n');
}

function parseParticipantResponse(response) {
    if (!response || typeof response !== 'string') return [];
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) jsonStr = objectMatch[0];
    try {
        const parsed = JSON.parse(jsonStr);
        return Array.isArray(parsed?.events) ? parsed.events : [];
    } catch (error) {
        console.warn('[NWST EventParticipants] Could not parse participant completion response:', error);
        return [];
    }
}

async function requestParticipantCompletion(chatId, events, options, roster) {
    const profile = options.profile || resolveProfile('planningLLM');
    if (!profile || !events.length) return [];

    const system = {
        role: 'system',
        content: [
            'You assign named character participants to upcoming narrative events.',
            'Return only valid JSON. Do not explain your reasoning.',
            'Participant means a character who directly attends, organizes, performs, is assigned responsibility for, contests, receives, or is the explicit target/subject of the event.',
            'Do not list people who are merely mentioned as background, indirectly affected, or only thematically relevant.',
            'NPC events MUST have at least one named participant. Exhaust the supplied roster and community membership before leaving the list empty.',
            'If no named participant can be responsibly resolved, preserve the event with participants=[] and mark invalidNPC=true. Never invent a name and never omit the event solely because participant completion failed.',
            'Non-NPC events must still list named participants when the event assigns attendance, action, responsibility, review, inspection, meeting duty, or a scheduled obligation to them.',
            'Use [] only for truly ambient world events with no direct named character involvement.',
            'Carry the list all the way out: include the other party to a call or meeting, the target of surveillance/confrontation, and every explicitly named expected attendee. Do not stop after identifying one obvious actor.',
            'The named user character is a valid participant when directly involved, even though events must not invent mundane plans for them.',
            'Use names from the supplied roster/community membership or names written directly in the event. Never invent a new character.'
        ].join('\n')
    };

    const eventText = events.map((event, index) => {
        const existing = normalizeEventParticipants(event.participants);
        return [
            `[${index + 1}] ${isNpcEventValue(event.isNPC) ? 'NPC' : 'NON-NPC'} EVENT`,
            `Title: ${event.title || '(untitled)'}`,
            `Description: ${event.description || '(none)'}`,
            `Scheduled: ${event.scheduledDate || '(unspecified)'}`,
            `Existing participants: ${existing.length ? existing.join(', ') : '(none)'}`
        ].join('\n');
    }).join('\n\n');

    const user = {
        role: 'user',
        content: [
            participantContextBlock({ ...options, chatId }, roster),
            '',
            'EVENTS TO COMPLETE:',
            eventText,
            '',
            'Return exactly:',
            '{"events":[{"index":1,"participants":["Exact Name"],"invalidNPC":false}]}',
            'Include one result for every event index. Return the COMPLETE final participant list. Remove any existing name that is not a direct participant.'
        ].join('\n')
    };

    try {
        const response = await generateWithProfile(profile, [system, user], {
            maxTokens: LLM_TOKEN_BUDGETS.SMALL
        });
        return parseParticipantResponse(response);
    } catch (error) {
        console.warn('[NWST EventParticipants] Participant completion call failed:', error);
        return [];
    }
}

/**
 * Complete participant lists for an event set.
 *
 * @returns {Promise<{events: object[], repaired: number, invalidNPC: object[]}>}
 */
export async function completeEventParticipants(chatId, rawEvents, options = {}) {
    const events = Array.isArray(rawEvents) ? rawEvents : [];
    if (!chatId || !events.length) return { events, repaired: 0, invalidNPC: [] };

    const roster = buildRoster(chatId, options);
    let repaired = 0;

    for (const event of events) {
        event.isNPC = isNpcEventValue(event.isNPC);
        const before = normalizeEventParticipants(event.participants);
        const mentions = directMentionParticipants(event, roster);
        const merged = normalizeEventParticipants([...before, ...mentions]);
        if (merged.length !== before.length) repaired++;
        event.participants = merged;
    }

    // Full generation/review paths can request reviewAll=true so partially
    // populated institutional meetings are completed from community context.
    // Lightweight cadence/approval paths call the LLM only for still-empty lists.
    const reviewTargets = options.reviewAll === true
        ? events
        : events.filter(event => !Array.isArray(event.participants) || event.participants.length === 0);
    for (let start = 0; start < reviewTargets.length; start += PARTICIPANT_BATCH_SIZE) {
        const batch = reviewTargets.slice(start, start + PARTICIPANT_BATCH_SIZE);
        const responses = await requestParticipantCompletion(chatId, batch, options, roster);
        for (const entry of responses) {
            const index = Number(entry?.index) - 1;
            if (!Number.isInteger(index) || index < 0 || index >= batch.length) continue;
            const event = batch[index];
            const existing = normalizeEventParticipants(event.participants);
            const candidates = Array.isArray(entry?.participants) ? entry.participants : [];
            const accepted = candidates
                .map(name => canonicalizeCandidate(name, event, roster))
                .filter(Boolean);
            const deterministic = directMentionParticipants(event, roster);
            const base = options.reviewAll === true ? deterministic : existing;
            const merged = normalizeEventParticipants([...base, ...accepted]);
            if (JSON.stringify(merged) !== JSON.stringify(existing)) repaired++;
            event.participants = merged;
        }
    }

    const invalidNPC = events.filter(event => isNpcEventValue(event?.isNPC) && (!Array.isArray(event.participants) || event.participants.length === 0));
    return { events, repaired, invalidNPC };
}
