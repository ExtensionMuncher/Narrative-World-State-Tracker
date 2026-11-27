// Pure forward-event validation shared by ordinary Event Generation and Time Skip.
// The model is still responsible for creative planning; this module is a hard
// boundary against the two corruption modes that have repeatedly escaped:
//   1) duplicating an event that is already tracked, and
//   2) turning completed/recent narrative into a new future Event.

const STOPWORDS = new Set([
    'a','an','and','at','by','for','from','in','into','of','on','or','the','to','with',
    'event','events','new','next','planned','plan'
]);

const FORWARD_SIGNAL_RE = /\b(?:will|shall|would|may|might|could|can|plans?\s+to|intends?\s+to|scheduled\s+to|expected\s+to|due\s+to|set\s+to|prepar(?:e|es|ed|ing)\s+to|about\s+to|continues?\s+to|remains?\s+(?:set|scheduled|due|expected)|tomorrow|next\s+(?:day|week|month|morning|afternoon|evening|night)|later|afterward|afterwards|upcoming|within\s+\d+|in\s+\d+\s*(?:minutes?|hours?|days?|weeks?|months?))\b/i;

const RETROSPECTIVE_COMPLETION_RE = /\b(?:has|have|had)\s+(?:already\s+)?(?:arrived|begun|bought|completed|departed|discovered|finished|found|gathered|left|met|occurred|opened|purchased|reached|received|returned|sent|started|visited|written|addressed|filed|delivered|resolved|moved|entered|posted|signed|called|texted)\b|\b(?:arrived|began|bought|completed|departed|discovered|finished|found|gathered|happened|left|met|occurred|purchased|reached|received|returned|sent|started|visited|wrote|addressed|filed|delivered|resolved)\b/i;

// Strong present-tense markers that mean the occurrence itself has already
// started at the landing point. These are not future Events; when they match an
// already-tracked Event, Time Skip can advance that existing record to
// `inprogress` instead of creating a replacement.
const CURRENT_OCCURRENCE_RE = /\b(?:is|are)\s+(?:(?:already|currently|now|finally)\s+)?(?:underway|in\s+progress|happening|taking\s+place)\b|\b(?:has|have)\s+(?:(?:already|now|finally)\s+)?(?:gathered|assembled)\b/i;

// Persistent proposals are allowed to describe ongoing states, so the ordinary
// future-event guard cannot protect them from reifying a long-standing state
// that NWST already tracks elsewhere (for example a Secret/HI about the same
// surveillance operation). Use broad topic families plus several distinctive
// shared tokens as a conservative cross-subsystem redundancy check.
const PERSISTENT_TOPIC_GROUPS = {
    surveillance: /\b(?:surveill(?:ance|ed|ing)?|watch(?:es|ed|ing)?|tail(?:s|ed|ing)?|track(?:s|ed|ing)?|monitor(?:s|ed|ing)?)\b/i,
    investigation: /\b(?:investigat(?:e|es|ed|ing|ion)|inquir(?:y|ies)|probe(?:s|d|ing)?|trace(?:s|d|ing)?|search(?:es|ed|ing)?)\b/i,
    blockade: /\b(?:blockade|lockdown|siege|cordon)\b/i,
    audit: /\b(?:audit(?:s|ed|ing)?|inspection|compliance\s+sweep)\b/i,
    pursuit: /\b(?:manhunt|pursuit|hunt(?:s|ed|ing)?)\b/i
};
const PERSISTENT_TOPIC_WORDS = new Set([
    'surveillance','surveilled','surveilling','watch','watches','watched','watching','tail','tails','tailed','tailing','track','tracks','tracked','tracking','monitor','monitors','monitored','monitoring',
    'investigate','investigates','investigated','investigating','investigation','inquiry','inquiries','probe','probes','probed','probing','trace','traces','traced','tracing','search','searches','searched','searching',
    'blockade','lockdown','siege','cordon','audit','audits','audited','auditing','inspection','compliance','sweep','manhunt','pursuit','hunt','hunts','hunted','hunting'
]);
const PERSISTENT_SEMANTIC_STOPWORDS = new Set([
    ...STOPWORDS, 'active','ongoing','persistent','state','pressure','current','currently','continues','continue','continuing','maintains','maintain','remains','remain',
    'someone','something','people','person','operation','operations','operative','operatives','team','teams'
]);

function persistentTopicKeys(text = '') {
    const out = new Set();
    for (const [key, re] of Object.entries(PERSISTENT_TOPIC_GROUPS)) if (re.test(String(text || ''))) out.add(key);
    return out;
}

function persistentSemanticTokens(text = '') {
    return new Set(String(text || '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[’']s\b/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/)
        .map(token => token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token)
        .filter(token => token.length >= 3 && !PERSISTENT_SEMANTIC_STOPWORDS.has(token) && !PERSISTENT_TOPIC_WORDS.has(token)));
}

export function isRedundantPersistentState(candidate, references = []) {
    const candidateText = `${candidate?.title || ''} ${candidate?.description || ''}`.trim();
    if (!candidateText) return false;
    const candidateTopics = persistentTopicKeys(candidateText);
    if (!candidateTopics.size) return false;
    const candidateTokens = persistentSemanticTokens(candidateText);
    if (!candidateTokens.size) return false;

    for (const reference of references || []) {
        const referenceText = `${reference?.title || ''} ${reference?.description || reference?.secret || reference?.objective || ''}`.trim();
        if (!referenceText) continue;
        const referenceTopics = persistentTopicKeys(referenceText);
        if (![...candidateTopics].some(topic => referenceTopics.has(topic))) continue;
        const referenceTokens = persistentSemanticTokens(referenceText);
        let shared = 0;
        for (const token of candidateTokens) {
            if (referenceTokens.has(token)) shared += 1;
            if (shared >= 3) return true;
        }
    }
    return false;
}

export function normalizeEventTitle(value = '') {
    return String(value || '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[’']s\b/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function meaningfulTitleTokens(value = '') {
    return normalizeEventTitle(value)
        .split(' ')
        .filter(token => token.length >= 3 && !STOPWORDS.has(token));
}

function titleOverlap(a = '', b = '') {
    const aTokens = new Set(meaningfulTitleTokens(a));
    const bTokens = new Set(meaningfulTitleTokens(b));
    if (aTokens.size === 0 || bTokens.size === 0) {
        return { intersection: 0, union: 0, score: 0, containment: 0, sharedTokens: [] };
    }
    const sharedTokens = [...aTokens].filter(token => bTokens.has(token));
    const intersection = sharedTokens.length;
    const union = new Set([...aTokens, ...bTokens]).size;
    const minSize = Math.min(aTokens.size, bTokens.size);
    return {
        intersection,
        union,
        score: union ? intersection / union : 0,
        containment: minSize ? intersection / minSize : 0,
        sharedTokens
    };
}

function normalizeParticipant(value = '') {
    return String(value || '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function participantIdentity(event) {
    return new Set((Array.isArray(event?.participants) ? event.participants : [])
        .map(normalizeParticipant)
        .filter(Boolean));
}

function participantOverlapCoefficient(a, b) {
    const aSet = participantIdentity(a);
    const bSet = participantIdentity(b);
    if (!aSet.size || !bSet.size) return 0;
    let intersection = 0;
    for (const name of aSet) if (bSet.has(name)) intersection++;
    return intersection / Math.min(aSet.size, bSet.size);
}

function participantNameTokens(a, b) {
    const tokens = new Set();
    for (const name of [...participantIdentity(a), ...participantIdentity(b)]) {
        for (const token of name.split(' ')) if (token.length >= 3) tokens.add(token);
    }
    return tokens;
}

function sameScheduledOccurrence(a, b) {
    const aStart = Number.isFinite(a?.scheduledElapsedStart) ? Number(a.scheduledElapsedStart) : null;
    const bStart = Number.isFinite(b?.scheduledElapsedStart) ? Number(b.scheduledElapsedStart) : null;
    const aEnd = Number.isFinite(a?.scheduledElapsedEnd) ? Number(a.scheduledElapsedEnd) : aStart;
    const bEnd = Number.isFinite(b?.scheduledElapsedEnd) ? Number(b.scheduledElapsedEnd) : bStart;
    if (aStart !== null && bStart !== null && aEnd !== null && bEnd !== null) {
        return aStart <= bEnd && bStart <= aEnd;
    }
    const aDate = normalizeCalendarText(a?.scheduledDate || '');
    const bDate = normalizeCalendarText(b?.scheduledDate || '');
    return Boolean(aDate && bDate && aDate === bDate);
}

export function findDuplicateEventCandidate(candidate, referenceEvents = []) {
    const title = normalizeEventTitle(candidate?.title);
    if (!title) return null;
    for (const reference of referenceEvents || []) {
        const other = normalizeEventTitle(reference?.title);
        if (!other) continue;
        if (title === other) return reference;

        const overlap = titleOverlap(title, other);

        // Jaccard catches small rewrites. Containment catches the reported class
        // where the model keeps the event's identity words but appends richer
        // scene detail ("... Karaoke Night — Room 703"), which diluted the old
        // Jaccard score despite clearly being the same occurrence.
        if (overlap.intersection >= 3 && (overlap.score >= 0.58 || overlap.containment >= 0.67)) {
            return reference;
        }

        // A much looser title paraphrase can still be identified when schedule
        // and cast are effectively identical. Require at least one shared title
        // token that is NOT merely a participant name, so two different scenes
        // involving the same people on the same day are not collapsed together.
        if (sameScheduledOccurrence(candidate, reference) && participantOverlapCoefficient(candidate, reference) >= 0.75) {
            const participantTokens = participantNameTokens(candidate, reference);
            const sharedNonParticipantTokens = overlap.sharedTokens.filter(token => !participantTokens.has(token));
            if (sharedNonParticipantTokens.length >= 3) return reference;
        }
    }
    return null;
}

export function isDuplicateEventCandidate(candidate, referenceEvents = []) {
    return Boolean(findDuplicateEventCandidate(candidate, referenceEvents));
}


function normalizeCalendarText(value = '') {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseCalendarPosition(value, calendarConfig = {}) {
    const text = normalizeCalendarText(value);
    if (!text) return null;

    const dayCountMatch = text.match(/\bday\s*(\d{1,4})\b/i);
    if (dayCountMatch) return { dayCount: Number(dayCountMatch[1]), month: null, day: null, year: null };

    const names = Array.isArray(calendarConfig?.monthNames) ? calendarConfig.monthNames : [];
    for (let i = 0; i < names.length; i++) {
        const monthName = normalizeCalendarText(names[i]);
        if (!monthName) continue;
        const at = text.indexOf(monthName);
        if (at < 0) continue;
        const after = text.slice(at + monthName.length);
        const dayMatch = after.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
        if (!dayMatch) continue;
        const yearMatch = text.match(/\b(\d{4})\b/);
        return { month: i + 1, day: Number(dayMatch[1]), year: yearMatch ? Number(yearMatch[1]) : null, dayCount: null };
    }
    return null;
}

/**
 * Generated timed events are not annual recurrence requests. If a model emits a
 * bare month/day or Day # that is already behind the current landing point,
 * treat it as stale history rather than letting the calendar resolver roll it
 * into the following year.
 */
export function isPastScheduledEvent(event, currentDay = {}, calendarConfig = {}) {
    if (!event?.scheduledDate || event?.tier === 'persistent' || event?.tier === 'undetermined') return false;
    const target = parseCalendarPosition(event.scheduledDate, calendarConfig);
    if (!target) return false;

    if (Number.isFinite(target.dayCount) && Number.isFinite(currentDay?.dayCount)) {
        return target.dayCount < Number(currentDay.dayCount);
    }

    const current = parseCalendarPosition(currentDay?.dateDisplay || '', calendarConfig);
    if (!current || !Number.isFinite(target.month) || !Number.isFinite(target.day) || !Number.isFinite(current.month) || !Number.isFinite(current.day)) return false;

    if (Number.isFinite(target.year) && Number.isFinite(current.year) && target.year !== current.year) {
        return target.year < current.year;
    }
    if (target.month !== current.month) return target.month < current.month;
    return target.day < current.day;
}

export function isLikelyCurrentOccurrenceEvent(event) {
    if (!event || event.tier === 'persistent') return false;
    const description = String(event.description || '').replace(/\s+/g, ' ').trim();
    if (!description) return false;
    const firstSentence = (description.match(/^[^.!?]+[.!?]?/)?.[0] || description).slice(0, 700);
    return CURRENT_OCCURRENCE_RE.test(firstSentence);
}

export function isLikelyRetrospectiveEvent(event) {
    if (!event || event.tier === 'persistent') return false;
    const description = String(event.description || '').replace(/\s+/g, ' ').trim();
    if (!description) return false;

    // "The karaoke meetup is finally underway" is not a future event even if
    // later prose mentions someone who has not arrived yet. The occurrence
    // itself has begun and belongs in progression of an existing Event/history.
    if (isLikelyCurrentOccurrenceEvent(event)) return true;

    const firstSentence = (description.match(/^[^.!?]+[.!?]?/)?.[0] || description).slice(0, 700);
    const hasCompletion = RETROSPECTIVE_COMPLETION_RE.test(firstSentence);
    if (!hasCompletion) return false;

    // A sentence can legitimately establish prior context while still defining
    // the next occurrence ("the permit has cleared and inspectors will arrive
    // tomorrow"). In that case the future clause makes it a real horizon event.
    return !FORWARD_SIGNAL_RE.test(firstSentence);
}

/**
 * Fail-closed filter for generated event candidates.
 * Reference events may include concluded history as well as active events: a
 * Time Skip must not resurrect a completed event merely because it left the
 * visible horizon.
 */
export function filterForwardNovelEvents(candidateEvents = [], referenceEvents = [], options = {}) {
    const accepted = [];
    const seenReferences = Array.isArray(referenceEvents) ? [...referenceEvents] : [];
    const onReject = typeof options.onReject === 'function' ? options.onReject : null;

    for (const raw of Array.isArray(candidateEvents) ? candidateEvents : []) {
        const event = raw && typeof raw === 'object' ? raw : null;
        if (!event || !String(event.title || '').trim() || !String(event.description || '').trim()) {
            onReject?.(event, 'malformed');
            continue;
        }
        const duplicateReference = findDuplicateEventCandidate(event, seenReferences);
        if (duplicateReference) {
            onReject?.(event, 'duplicate', { referenceEvent: duplicateReference });
            continue;
        }
        if (options.currentDay && isPastScheduledEvent(event, options.currentDay, options.calendarConfig || {})) {
            onReject?.(event, 'past_schedule');
            continue;
        }
        if (isLikelyRetrospectiveEvent(event)) {
            onReject?.(event, 'retrospective');
            continue;
        }
        accepted.push(event);
        seenReferences.push(event);
    }
    return accepted;
}
