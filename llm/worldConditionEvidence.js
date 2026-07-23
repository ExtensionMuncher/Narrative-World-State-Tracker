// =============================================================================
// NWST World Condition Evidence Guards — llm/worldConditionEvidence.js
// =============================================================================
// Cheap, local validation for Planning-LLM World Condition proposals.
// No extra model calls: grounded conditions cite source IDs, and NWST checks
// the full cited source text for support before accepting high-risk claims.
// Ambient conditions must stay independent of the recent active cast.
// =============================================================================

function canonicalize(text) {
    return String(text || '')
        .normalize('NFKC')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[‐‑‒–—]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

export function buildWorldEvidenceSources(recentMessages = [], currentDay = {}, settingContext = '') {
    const sources = {};

    if (String(settingContext || '').trim()) {
        sources.S1 = {
            label: 'Setting Context',
            text: String(settingContext).trim(),
        };
    }

    const dayParts = [
        currentDay?.dateDisplay ? `Date: ${currentDay.dateDisplay}` : '',
        currentDay?.season ? `Season: ${currentDay.season}` : '',
        currentDay?.weatherToday ? `Weather: ${currentDay.weatherToday}` : '',
        currentDay?.flora ? `Flora: ${currentDay.flora}` : '',
        currentDay?.fauna ? `Fauna: ${currentDay.fauna}` : '',
        currentDay?.spiritualClimate ? `Spiritual Climate: ${currentDay.spiritualClimate}` : '',
    ].filter(Boolean);
    if (dayParts.length > 0) {
        sources.D1 = {
            label: 'Current Date / Season',
            text: dayParts.join('\n'),
        };
    }

    recentMessages.forEach((msg, index) => {
        const sender = msg?.name || (msg?.is_user ? 'User' : 'Character');
        sources[`M${index + 1}`] = {
            label: `Recent Chat — ${sender}`,
            text: String(msg?.mes || '').trim(),
        };
    });

    return sources;
}

export function formatWorldEvidenceSources(sources = {}) {
    const lines = [];
    for (const [ref, source] of Object.entries(sources)) {
        lines.push(`--- ${ref}: ${source.label} ---`);
        lines.push(source.text || '(empty)');
        lines.push('');
    }
    return lines.join('\n');
}

export function collectRecentCastNames(recentMessages = [], communities = []) {
    const names = new Set();
    const generic = new Set(['user', 'assistant', 'character', 'narrator', 'system']);

    for (const msg of recentMessages) {
        const name = String(msg?.name || '').trim();
        if (name && !generic.has(name.toLowerCase())) names.add(name);
    }

    for (const community of communities) {
        const members = String(community?.members || '')
            .split(',')
            .map(part => part.replace(/\([^)]*\)/g, '').trim())
            .filter(Boolean);
        for (const member of members) names.add(member);
    }

    return [...names].sort((a, b) => b.length - a.length);
}

function safeNameToken(token) {
    const value = canonicalize(token);
    if (!value || value.length < 3) return false;
    return !new Set([
        'the','and','for','with','from','user','assistant','character','narrator','system',
        'team','group','staff','family','police','detective','officer','manager','doctor'
    ]).has(value);
}

function buildCastMatchers(recentCastNames = []) {
    const fullNames = [...new Set(recentCastNames.map(canonicalize).filter(Boolean))];
    const tokenOwners = new Map();

    for (const full of fullNames) {
        const parts = full.split(/\s+/).filter(safeNameToken);
        if (parts.length < 2) continue;
        for (const token of [parts[0], parts[parts.length - 1]]) {
            if (!tokenOwners.has(token)) tokenOwners.set(token, new Set());
            tokenOwners.get(token).add(full);
        }
    }

    return fullNames.map(full => {
        const aliases = new Set([full]);
        const parts = full.split(/\s+/).filter(safeNameToken);
        if (parts.length >= 2) {
            for (const token of [parts[0], parts[parts.length - 1]]) {
                if (tokenOwners.get(token)?.size === 1) aliases.add(token);
            }
        }
        return { full, aliases: [...aliases] };
    });
}

function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWholeName(haystack, alias) {
    if (!alias || alias.length < 2) return false;
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegex(alias)}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
    return pattern.test(haystack);
}

export function findRecentCastReferences(text, recentCastNames = []) {
    const haystack = canonicalize(text);
    if (!haystack) return [];
    const found = [];
    for (const matcher of buildCastMatchers(recentCastNames)) {
        if (matcher.aliases.some(alias => containsWholeName(haystack, alias))) {
            found.push(matcher.full);
        }
    }
    return found;
}

export function isLikelySceneContaminatedCondition(text, recentCastNames = [], conditionName = '') {
    const castRefs = findRecentCastReferences(text, recentCastNames);
    if (castRefs.length >= 2) return true;
    if (castRefs.length === 0) return false;

    const value = canonicalize(text);
    const categoryPatterns = {
        political: {
            micro: /\b(surveillance operation|restraining order|paperwork|single target|operative|surveillance post|residential observation|individual arrest|one investigation|single investigation)\b/i,
            macro: /\b(policy|posture|governance|government|institution(?:al)?|faction(?:al)?|territor(?:y|ial)|district|regional|leadership|hierarch(?:y|ical)|alliance|regulat(?:ion|ory)|organization[- ]wide|faction[- ]wide|multiple operations|operational doctrine|power structure)\b/i,
        },
        social: {
            micro: /\b(private relationship|personal relationship|visit|friendship|sibling|estrangement|apartment|conversation)\b/i,
            macro: /\b(collective|community|public|cultural|population|neighbou?rhood|workplace|commerce|social space|social norm|routines?|group-level)\b/i,
        },
        spiritual: {
            micro: /\b(aura|emotion|vision|encounter|spell|curse|sensation)\b/i,
            macro: /\b(metaphysical system|spiritual system|supernatural system|regional|faction|ritual cycle|barrier|realm|spiritual environment|metaphysical environment)\b/i,
        },
        environmental: {
            micro: /./,
            macro: /$a/,
        },
    };

    const rule = categoryPatterns[conditionName];
    return !!(rule && rule.micro.test(value) && !rule.macro.test(value));
}

function extractEvidenceRefs(payload, sources) {
    // New format: evidenceRefs: ["M1", "M5"]
    // Legacy format remains accepted so older/custom responses do not crash.
    let rawRefs = [];
    if (Array.isArray(payload?.evidenceRefs)) {
        rawRefs = payload.evidenceRefs;
    } else if (Array.isArray(payload?.evidence)) {
        rawRefs = payload.evidence.map(item => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') return item.sourceRef;
            return '';
        });
    }

    const refs = [...new Set(rawRefs
        .map(ref => String(ref || '').trim().toUpperCase())
        .filter(Boolean))];

    if (refs.length === 0 || refs.length > 4) {
        return { ok: false, reason: 'grounded conditions require 1-4 valid evidence source IDs' };
    }

    for (const ref of refs) {
        if (!sources[ref]) {
            return { ok: false, reason: `invalid evidence source ID ${ref}` };
        }
    }

    return { ok: true, refs };
}

function citedSourceTexts(refs, sources) {
    return refs.map(ref => canonicalize(sources[ref]?.text || ''));
}

function anySourceMatches(texts, pattern) {
    return texts.some(text => pattern.test(text));
}

function anySourceHasBoth(texts, patternA, patternB) {
    return texts.some(text => patternA.test(text) && patternB.test(text));
}

const VALID_SCOPES = {
    political: new Set(['institution', 'faction', 'district', 'regional', 'population']),
    social: new Set(['population', 'community', 'district', 'cultural', 'regional']),
    spiritual: new Set(['spiritual', 'faction', 'regional', 'environmental']),
    environmental: new Set(['environmental', 'district', 'regional']),
};

const VALID_TRANSITIONS = {
    political: new Set([
        'policy_change', 'governance_change', 'hierarchy_change', 'territorial_change',
        'organization_wide_posture_change', 'intergroup_relationship_change', 'regulatory_change'
    ]),
    social: new Set([
        'collective_norm_change', 'community_behavior_change', 'public_routine_change',
        'reputation_shift', 'population_pressure_change', 'cultural_change'
    ]),
    spiritual: new Set([
        'metaphysical_system_change', 'ritual_cycle_change', 'supernatural_faction_change',
        'regional_spiritual_change', 'barrier_realm_change'
    ]),
    environmental: new Set([
        'seasonal_pattern_change', 'climate_pattern_change', 'ecological_change',
        'regional_hazard_change', 'flora_fauna_change', 'landscape_change', 'air_water_change'
    ]),
};

function validateTransitionType(payload, conditionName) {
    if (!conditionName || !VALID_TRANSITIONS[conditionName]) return { ok: true };
    const transitionType = canonicalize(payload?.transitionType || '').replace(/\s+/g, '_');
    if (!VALID_TRANSITIONS[conditionName].has(transitionType)) {
        return { ok: false, reason: `${conditionName} grounded update has invalid/non-macro transitionType "${transitionType || '(empty)'}"` };
    }
    return { ok: true, transitionType };
}

function validateTransitionLanguage(change) {
    const value = canonicalize(change);
    // Cadence Grounded updates represent a NEW macro transition. Static truths,
    // continued operations, or mere coexistence belong in existing state/Ambient.
    const transition = /\b(chang(?:e|ed|es|ing)|shift(?:ed|s|ing)?|expand(?:ed|s|ing)?|contract(?:ed|s|ing)?|tighten(?:ed|s|ing)?|relax(?:ed|es|ing)?|adopt(?:ed|s|ing)?|reorgan(?:ize|ized|izes|izing)|restructur(?:e|ed|es|ing)|form(?:ed|s|ing)?|fractur(?:e|ed|es|ing)|end(?:ed|s|ing)?|begin(?:s|ning)?|began|increase(?:d|s|ing)?|decrease(?:d|s|ing)?|escalat(?:e|ed|es|ing)|de-escalat(?:e|ed|es|ing)|widen(?:ed|s|ing)?|narrow(?:ed|s|ing)?|spread(?:s|ing)?|declin(?:e|ed|es|ing)|rise|rose|rises|emerg(?:e|ed|es|ing)|deteriorat(?:e|ed|es|ing)|stabiliz(?:e|ed|es|ing)|strengthen(?:ed|s|ing)?|weaken(?:ed|s|ing)?|formaliz(?:e|ed|es|ing)|dissolv(?:e|ed|es|ing)|disrupt(?:ed|s|ing)?)\b/i;
    const staticOnly = /\b(remains?|continues?|maintains?|exists?|operates?|conducts?|processes?|is|are|has|have)\b/i;
    if (!transition.test(value) && staticOnly.test(value)) {
        return { ok: false, reason: 'grounded change describes a static/continuing fact rather than a new macro transition' };
    }
    if (!transition.test(value)) {
        return { ok: false, reason: 'grounded change does not clearly describe a new macro transition' };
    }
    return { ok: true };
}

function validateMacroEvidenceScale(conditionName, sourceTexts) {
    const patterns = {
        political: /\b(all|across|multiple|organization[- ]wide|faction[- ]wide|district|citywide|regional|policy|protocols?|directive|leadership|hierarch(?:y|ical)|territor(?:y|ial)|alliance|regulat(?:ion|ory)|governance|institution[- ]wide|operational doctrine)\b/i,
        social: /\b(community|communities|public|population|residents?|workers?|customers?|neighbou?rhood|district|citywide|regional|collective|widespread|across|many|norms?|routines?|workplaces?|reputation|cultural)\b/i,
        spiritual: /\b(regional|widespread|across|multiple|system|ritual cycle|barriers?|realms?|faction|metaphysical|spiritual environment|supernatural environment|sacred|profane)\b/i,
        environmental: /\b(seasonal|persistent|multi[- ]day|regional|across|climate|ecolog(?:y|ical)|ecosystem|landscape|air quality|water|watershed|flora|fauna|vegetation|wildlife|drought|flood|storm system|long[- ]term|ongoing pattern)\b/i,
    };
    const pattern = patterns[conditionName];
    if (pattern && !anySourceMatches(sourceTexts, pattern)) {
        return { ok: false, reason: `${conditionName} cited evidence does not itself show macro-scale reach; it appears case/local rather than world-state scale` };
    }
    return { ok: true };
}

function validateCategoryScope(payload, conditionName) {
    if (!conditionName || !VALID_SCOPES[conditionName]) return { ok: true };
    const scope = canonicalize(payload?.scope || '');
    if (!VALID_SCOPES[conditionName].has(scope)) {
        return { ok: false, reason: `${conditionName} condition has invalid/non-macro scope "${scope || '(empty)'}"` };
    }
    return { ok: true, scope };
}

function validateMacroChangeThreshold(conditionName, change) {
    if (!conditionName || !change) return { ok: true };

    const rules = {
        political: {
            micro: /\b(surveillance operation|single operation|single case|case-specific|paperwork|restraining order|single target|one target|operative|surveillance post|residential observation|one investigation|single investigation|individual arrest)\b/i,
            macro: /\b(policy|posture|governance|government|institution(?:al)?|faction(?:al)?|territor(?:y|ial)|district|regional|population|leadership|hierarch(?:y|ical)|alliance|regulat(?:ion|ory)|organization[- ]wide|faction[- ]wide|multiple operations|operational doctrine|procedures?|power structure|intergroup relationship)\b/i,
        },
        social: {
            micro: /\b(private relationship|personal relationship|one visit|single visit|individual friendship|family estrangement|sibling estrangement|one conversation|single conversation)\b/i,
            macro: /\b(collective|community|communities|public|cultural|culture|population|neighbou?rhood|workplace|commerce|social space|social norm|social norms|routine|routines|group-level|shared behavior|shared behaviour)\b/i,
        },
        spiritual: {
            micro: /\b(one character|single character|one encounter|single encounter|individual aura|individual emotion|single vision|one vision)\b/i,
            macro: /\b(metaphysical system|spiritual system|supernatural system|regional|faction|ritual cycle|ritual cycles|barrier|barriers|realm|realms|sacred|spiritual environment|metaphysical environment|wider spiritual|wider supernatural)\b/i,
        },
        environmental: {
            micro: /\b(today|tonight|this morning|this afternoon|one storm|single storm|current rain|current weather|rain today|temperature today)\b/i,
            macro: /\b(pattern|persistent|seasonal|climate|regional|ecolog(?:y|ical)|ecosystem|landscape|watershed|river|air quality|drought|flood|storm system|flora|fauna|vegetation|wildlife|long-term|ongoing)\b/i,
        },
    };

    const rule = rules[conditionName];
    if (rule && rule.micro.test(change) && !rule.macro.test(change)) {
        return { ok: false, reason: `${conditionName} grounded change is accurate but still case/moment-specific rather than macro/durable` };
    }
    return { ok: true };
}

function validateAmbientProportionality(conditionName, content, sources) {
    if (!conditionName) return { ok: true };

    const worldFrame = canonicalize(`${sources?.S1?.text || ''} ${sources?.D1?.text || ''}`);
    const highImpact = {
        political: /\b(state of emergency|martial law|coup(?: d['’]etat)?|government collapse|regime change|declaration of war|war declared|nationwide crackdown|mass arrests?|political purge|nationwide purge|sweeping (?:new )?(?:law|legislation|ban)|major (?:new )?(?:law|legislation)|nationwide (?:law|legislation|ban)|national ban|emergency decree|national emergency|dissolution of parliament|assassination crisis|citywide curfew|nationwide curfew)\b/i,
        social: /\b(citywide riots?|mass riots?|mass panic|mass unrest|widespread civil disorder|general strike|mass exodus|societal collapse|nationwide protests?|large-scale evacuation)\b/i,
        spiritual: /\b(supernatural invasion|metaphysical collapse|spiritual apocalypse|apocalypse|barriers? (?:collapse|fail|failed|fell|fall|shatter|shattered)|realm rupture|mass possession|widespread possession|supernatural outbreak|curse outbreak|catastrophic spiritual event)\b/i,
        environmental: /\b(catastrophic flood|major earthquake|devastating earthquake|tsunami|major typhoon|severe typhoon|typhoon landfall|volcanic eruption|wildfire emergency|catastrophic wildfire|mass evacuation|severe regional drought|widespread infrastructure failure|catastrophic storm)\b/i,
    };

    const pattern = highImpact[conditionName];
    if (pattern && pattern.test(content) && !pattern.test(worldFrame)) {
        return {
            ok: false,
            reason: `ambient ${conditionName} condition invents a plot-forcing high-impact development not supported by Setting Context/Current Day`,
        };
    }

    const globalImpact = /\b(mass-casualty|mass casualty|thousands killed|hundreds killed|widespread blackout|infrastructure collapse|economic collapse|financial collapse|pandemic emergency)\b/i;
    if (globalImpact.test(content) && !globalImpact.test(worldFrame)) {
        return {
            ok: false,
            reason: 'ambient condition invents a high-impact development that would substantially rewrite the playable world',
        };
    }

    return { ok: true };
}

function validateCategoryBoundaries(mode, conditionName, content, sources) {
    if (!conditionName) return { ok: true };

    if (mode === 'ambient') {
        const markers = {
            political: /\b(institutions?|institutional|government|governance|authority|authorities|faction|factions|political|politics|policy|regulation|regulatory|leadership|hierarchy|territor(?:y|ial)|administration|bureaucracy|civic|law enforcement|public office|power structure|martial law|state of emergency)\b/i,
            social: /\b(people|community|communities|public|social|cultural|culture|workplace|workplaces|workers|commuters|customers|commerce|business|businesses|shops?|stores?|restaurants?|caf[eé]s?|schools?|neighbou?rhoods?|routines?|gatherings?|crowds?|households?|families|residents?|norms?|habits?|social spaces?)\b/i,
            spiritual: /\b(spiritual|supernatural|metaphysical|ritual|rituals|sacred|profane|spirit|spirits|ghost|ghosts|haunting|hauntings|curse|curses|cursed|magic|magical|divine|occult|omen|omens|barrier|barriers|realm|realms|energy|energies|aura|auras)\b/i,
            environmental: /\b(environment|environmental|climate|season|seasonal|weather|rain|snow|fog|wind|temperature|humidity|air|water|river|rivers|coast|coastal|landscape|terrain|ecology|ecological|ecosystem|flora|fauna|foliage|vegetation|wildlife|drought|flood|storm|storms|precipitation|daylight|earthquake|tsunami|typhoon|volcanic|volcano|eruption|wildfire)\b/i,
        };
        if (markers[conditionName] && !markers[conditionName].test(content)) {
            return { ok: false, reason: `ambient ${conditionName} condition does not clearly stay within its category` };
        }
    }

    if (mode === 'ambient' && conditionName === 'social') {
        const social = /\b(people|community|communities|public|social|cultural|culture|workplace|workplaces|workers|commuters|customers|commerce|business|businesses|shops?|stores?|restaurants?|caf[eé]s?|schools?|neighbou?rhoods?|routines?|gatherings?|crowds?|households?|families|residents?|norms?|habits?|social spaces?)\b/i;
        const environmental = /\b(weather|rain|snow|fog|wind|temperature|humidity|sunlight|daylight|season|autumn|winter|spring|summer|climate|damp|cold|warm|heat)\b/i;
        if (environmental.test(content) && !social.test(content)) {
            return { ok: false, reason: 'ambient social condition is dominated by environmental description without collective social behavior' };
        }
    }

    if (mode === 'ambient' && conditionName === 'spiritual') {
        const worldFrame = canonicalize(`${sources?.S1?.text || ''} ${sources?.D1?.text || ''}`);
        const explicitAbsence = /\b(no|without) (?:spiritual|supernatural|metaphysical|magical|magic) (?:elements?|forces?|phenomena?|system|systems|activity)\b/i.test(worldFrame)
            || /\bnon[- ]supernatural\b/i.test(worldFrame);
        const supported = /\b(spiritual climate:|spiritual|supernatural|metaphysical|ritual|sacred|profane|spirit|ghost|haunting|curse|cursed|magic|magical|divine|occult|omen|barrier|realm|energy|aura)\b/i.test(worldFrame);
        if (explicitAbsence || !supported) {
            return { ok: false, reason: 'ambient spiritual condition lacks positive setting/current-day support for a supernatural or spiritual world frame' };
        }
    }

    return { ok: true };
}

const FAMILY = {
    law: /\b(law enforcement|police|detective|tmpd|organized crime division|restraining order|court|legal process)\b/i,
    syndicate: /\b(syndicate|yakuza|oyabun|operative|crime family|criminal organization)\b/i,
    surveillance: /\b(surveillance|observation|observe|watch|watching|tail|tracking|monitor|monitoring)\b/i,
    formalTeam: /\b(task force|special unit|police detail|law[- ]enforcement detail|observation team|surveillance team|parallel (?:observation|surveillance) teams?)\b/i,
    mutual: /\b(mutual(?:ly)?|both sides|each side|reciprocal(?:ly)?|coordination|coordinate(?:d|s|ing)?|d[eé]tente|unspoken coordination|formal acknowledgment|without formal acknowledgment)\b/i,
    rumor: /\b(rumou?r(?:s|ed|ing)?|circulat(?:e|es|ed|ing|ion)|discussion among|widely known|public awareness|institutional memory|informal record)\b/i,
    management: /\b(mid[- ]ranking lieutenants?|middle management)\b/i,
    resource: /\b(resource strain|strains? resources|resource pressure|operational bandwidth|diverts? .* resources|compressing .* bandwidth)\b/i,
    grandiose: /\b(unprecedented|historic(?:al)?|no precedent|system[- ]wide|in living memory)\b/i,
};

function validateHighRiskClaims(content, sourceTexts) {
    const checks = [
        {
            label: 'mutual/reciprocal awareness or coordination',
            contentPattern: FAMILY.mutual,
            supported: () => anySourceMatches(sourceTexts, FAMILY.mutual),
        },
        {
            label: 'new formal team/detail/task-force structure',
            contentPattern: FAMILY.formalTeam,
            supported: () => anySourceMatches(sourceTexts, FAMILY.formalTeam),
        },
        {
            label: 'offscreen rumor/discussion/public-propagation claim',
            contentPattern: FAMILY.rumor,
            supported: () => anySourceMatches(sourceTexts, FAMILY.rumor),
        },
        {
            label: 'organizational middle-management claim',
            contentPattern: FAMILY.management,
            supported: () => anySourceMatches(sourceTexts, FAMILY.management),
        },
        {
            label: 'resource-strain/bandwidth claim',
            contentPattern: FAMILY.resource,
            supported: () => anySourceMatches(sourceTexts, FAMILY.resource),
        },
        {
            label: 'grandiose scale claim',
            contentPattern: FAMILY.grandiose,
            supported: () => anySourceMatches(sourceTexts, FAMILY.grandiose),
        },
    ];

    for (const check of checks) {
        if (check.contentPattern.test(content) && !check.supported()) {
            return { ok: false, reason: `${check.label} is not established in any cited source` };
        }
    }

    // DeepSeek's recurring failure: combine one police/legal fact from one
    // message with one syndicate-surveillance fact from another and invent a
    // law-enforcement observation team. If content couples LAW + SURVEILLANCE,
    // at least one cited source must itself establish both concepts together.
    if (FAMILY.law.test(content) && FAMILY.surveillance.test(content)
        && !anySourceHasBoth(sourceTexts, FAMILY.law, FAMILY.surveillance)) {
        return {
            ok: false,
            reason: 'law-enforcement surveillance/observation claim is assembled from separate facts rather than established by a cited source',
        };
    }

    // Likewise, a claimed bilateral syndicate/law-enforcement relationship
    // needs at least one cited source that actually places both institutions in
    // the same established fact. Separate source refs cannot be stitched into
    // a new relationship by implication.
    const bilateralLanguage = /\b(parallel|overlapping|both|neither side|each side|mutual|reciprocal|coordination|d[eé]tente|unacknowledged awareness|unspoken coordination)\b/i;
    if (FAMILY.law.test(content) && FAMILY.syndicate.test(content) && bilateralLanguage.test(content)
        && !anySourceHasBoth(sourceTexts, FAMILY.law, FAMILY.syndicate)) {
        return {
            ok: false,
            reason: 'bilateral syndicate/law-enforcement relationship is not established within any cited source',
        };
    }

    return { ok: true };
}

export function validateWorldConditionPayload(payload, sources, recentCastNames = [], conditionName = '') {
    if (!payload || typeof payload !== 'object') {
        return { ok: false, reason: 'payload is not an object' };
    }

    const mode = String(payload.mode || '').toLowerCase().trim();
    const content = typeof payload.content === 'string' ? payload.content.trim() : '';
    if (!content) return { ok: false, reason: 'empty condition content' };

    const scopeCheck = validateCategoryScope(payload, conditionName);
    if (!scopeCheck.ok) return scopeCheck;

    if (mode === 'ambient') {
        const castRefs = findRecentCastReferences(content, recentCastNames);
        if (castRefs.length > 0) {
            return { ok: false, reason: `ambient condition names/references recent cast member "${castRefs[0]}"` };
        }
        const boundaryCheck = validateCategoryBoundaries(mode, conditionName, content, sources);
        if (!boundaryCheck.ok) return boundaryCheck;
        const proportionalityCheck = validateAmbientProportionality(conditionName, content, sources);
        if (!proportionalityCheck.ok) return proportionalityCheck;
        return { ok: true, mode, scope: scopeCheck.scope || '', evidenceRefs: [] };
    }

    if (mode !== 'grounded') {
        return { ok: false, reason: `invalid mode "${mode || '(empty)'}"` };
    }

    const change = typeof payload?.change === 'string' ? payload.change.trim() : '';
    if (!change) {
        return { ok: false, reason: 'grounded condition is missing a concise cast-independent macro change statement' };
    }
    const changeCastRefs = findRecentCastReferences(change, recentCastNames);
    if (changeCastRefs.length > 0) {
        return { ok: false, reason: `grounded macro change still depends on recent cast member "${changeCastRefs[0]}"` };
    }
    const macroCheck = validateMacroChangeThreshold(conditionName, change);
    if (!macroCheck.ok) return macroCheck;
    const transitionTypeCheck = validateTransitionType(payload, conditionName);
    if (!transitionTypeCheck.ok) return transitionTypeCheck;
    const transitionLanguageCheck = validateTransitionLanguage(change);
    if (!transitionLanguageCheck.ok) return transitionLanguageCheck;

    const contentCastRefs = findRecentCastReferences(content, recentCastNames);
    if (contentCastRefs.length > 1) {
        return { ok: false, reason: 'grounded condition is still centered on multiple recent cast members rather than a wider world subject' };
    }

    const evidenceCheck = extractEvidenceRefs(payload, sources);
    if (!evidenceCheck.ok) return evidenceCheck;

    const sourceTexts = citedSourceTexts(evidenceCheck.refs, sources);
    const scaleCheck = validateMacroEvidenceScale(conditionName, sourceTexts);
    if (!scaleCheck.ok) return scaleCheck;
    const claimCheck = validateHighRiskClaims(content, sourceTexts);
    if (!claimCheck.ok) return claimCheck;

    const boundaryCheck = validateCategoryBoundaries(mode, conditionName, content, sources);
    if (!boundaryCheck.ok) return boundaryCheck;

    return { ok: true, mode, scope: scopeCheck.scope || '', evidenceRefs: evidenceCheck.refs };
}
