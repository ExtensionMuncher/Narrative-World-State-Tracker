// Conservative quotation gate. Semantic matching still requires player review.
import { isNarrativeChatMessage } from './detectedEventValidation.js';
const normalize = value => String(value || '').replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim().toLowerCase();
const uncertain = /\b(?:if|unless|might|may|could|would|perhaps|maybe|probably|hopefully|seems?|appears?|suspects?|assumes?|wishes?|hopes?)\b|\bnot\b|n['’]t\b|\b(?:will|shall)\b/i;
export function hasExplicitNarrativeEvidence(evidence, recentMessages) {
    const needle = normalize(evidence);
    if (needle.length < 12 || needle.split(/\s+/).length < 3) return false;
    return (Array.isArray(recentMessages) ? recentMessages : []).some(message => {
        const text = message?.mes || message?.text || '';
        if (!isNarrativeChatMessage({ ...message, mes: text })) return false;
        const haystack = normalize(text);
        let offset = haystack.indexOf(needle);
        while (offset !== -1) {
            // Check surrounding sentence too: a cropped quote must not hide "if".
            const left = Math.max(haystack.lastIndexOf('.', offset - 1), haystack.lastIndexOf('!', offset - 1), haystack.lastIndexOf('?', offset - 1)) + 1;
            const tail = haystack.slice(offset + needle.length);
            const boundary = tail.search(/[.!?]/);
            const right = boundary < 0 ? haystack.length : offset + needle.length + boundary + 1;
            const sentence = haystack.slice(left, right);
            if (!uncertain.test(sentence) && !sentence.includes('?')) return true;
            offset = haystack.indexOf(needle, offset + 1);
        }
        return false;
    });
}
