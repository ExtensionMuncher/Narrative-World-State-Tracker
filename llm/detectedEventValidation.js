// Pure, side-effect-free guard for cadence-scanner event proposals.
// Detection intentionally fails closed: a missed proposal can be added later,
// while a recap admitted as a future Event corrupts the event horizon.

const FUTURE_SIGNAL_RE = /(?:\b(?:will|shall|would|going to|plans? to|intends? to|promis(?:e|es|ed) to|agrees? to|scheduled to|due to|expected to|must|needs? to|later|tomorrow|next|after (?:the|a|an|i|we|he|she|they)|in \d+\s*(?:minutes?|hours?|days?|weeks?|months?)|within \d+\s*(?:minutes?|hours?|days?|weeks?|months?))\b|\b(?:i|we|he|she|they)[’']ll\b)/i;

export function isForwardDetectedEvent(event) {
    if (!event || typeof event !== 'object') return false;
    if (!String(event.title || '').trim() || !String(event.description || '').trim()) return false;
    const evidence = String(event.futureEvidence || '').trim();
    if (!evidence) return false;
    return FUTURE_SIGNAL_RE.test(`${evidence} ${event.title || ''} ${event.description || ''}`);
}

export function isNarrativeChatMessage(message) {
    if (!message || typeof message !== 'object') return false;
    if (message.is_system && message.extra?.hidden) return false;
    if (message.extra?.display === 'none') return false;

    // Extension-produced analysis can be visible in the chat transcript but
    // is not story canon. Feeding it back to NWST turns tracker speculation,
    // status reports, and internal-thought aids into false plot events.
    const type = String(message.extra?.type || '').trim().toLowerCase();
    if (type && /(?:situational|thinking|memory|summary|tracker|utility)/.test(type)) return false;
    if (message.extra?.isSmallSys === true) return false;
    const model = String(message.extra?.model || '').trim().toLowerCase();
    if (model && /tracker\s*system|situational\s*tracker/.test(model)) return false;
    return typeof message.mes === 'string' && message.mes.trim().length > 0;
}
