/* eslint-disable */
// =============================================================================
// NWST Prompt Injector — inject/promptInjector.js
// =============================================================================
// Handles injection of world state blocks into the main ST prompt.
// Uses ST's native prompt injection API (extension_prompt_types and roles).
//
// What gets injected:
//   • Current Day block (date, season, weather, flora, fauna, spiritual climate)
//   • 7-day forecast + moon phases
//   • Active upcoming events (pending + in-progress only)
//   • Active world conditions (eye-on only)
//   • Selective secret blocks
//   • Scene-relevant Hidden Intention plan guidance when no active Event owns it
//
// What NEVER gets injected:
//   • Notebook contents (bullets, core fields, mystery fields)
//   • Community summaries
//   • Secrets (except selective scored blocks)
//   • Hidden Intentions except scene-relevant executable plans selected by the dedicated scorer
//
// ── OUTPUT DENSITY MODES ──────────────────────────────────────────────────
//
//   Three modes controlled by injection.densityMode setting:
//
//   'atmospheric' — Full narrative prose. Rich descriptions, evocative
//                   language, full detail on all fields. Current default
//                   behaviour — no changes to existing output.
//                   Estimated injection: 600-1,400 tokens/message.
//
//   'combined'    — Balanced prose. Short paragraphs, 1-2 sentences per
//                   field, events as title + one sentence, conditions
//                   trimmed to 2-3 sentences max. Default for new installs.
//                   Estimated injection: 300-600 tokens/message.
//
//   'token-budget' — Structured key-value format. No prose. All fields
//                    as labeled single-line entries. Conditions truncated
//                    to one sentence. Events as title only or title + brief
//                    clause. Spiritual climate omitted if not set.
//                    Estimated injection: 120-300 tokens/message.
//
// =============================================================================

// setExtensionPrompt is exported by SillyTavern's root module; it is not
// reliably exposed by SillyTavern.getContext(). Import both prompt APIs from
// their authoritative source so a refresh cannot fail before registration.
import { extension_prompt_roles, setExtensionPrompt } from '../../../../../script.js';
import { getCurrentDay, getForecast, getMoonPhases,
         getEnabledConditions, getSeasonConfig, getCalendarConfig } from '../data/worldState.js';
import { getActiveEvents } from '../data/events.js';
import {
    isInjectCurrentDay, isInjectEvents, isInjectWorldConditions,
    getInjectionPlacement, getInjectionDepth, getInjectionDepthRole,
    isEnabled, isPaused, getDensityMode
} from '../settings.js';
import { getChatId } from '../utils.js';
import { buildSecretsInjection } from '../llm/secretsInjection.js';
import { buildHiddenIntentionsInjection } from '../llm/hiddenIntentionsInjection.js';
import { computeSeason, normalizeMoonPhenomena } from '../llm/dayAdvancement.js';
import { getMoonConfig } from '../data/moons.js';
import { buildNagerHolidayPromptBlock } from '../data/nagerDate.js';
import { dlog } from "../lib/debug.js";
import { parseCurrentCalendarDate } from '../lib/calendarMath.js';

// ── Role string → numeric mapper ──────────────────────────────────────────

const ROLE_MAP = {
    'system':    extension_prompt_roles.SYSTEM,
    'user':      extension_prompt_roles.USER,
    'assistant': extension_prompt_roles.ASSISTANT,
};

// ── Utility: trim prose to first N sentences ─────────────────────────────

/**
 * Trim a prose string to at most N sentences.
 * Used by Combined and Token-Budget modes to constrain field length.
 * @param {string} text
 * @param {number} maxSentences
 * @returns {string}
 */
function trimToSentences(text, maxSentences) {
    if (!text) return '';
    // Split on sentence-ending punctuation followed by a space or end of string
    const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
    return sentences.slice(0, maxSentences).join('').trim();
}

/**
 * Trim a prose string to at most N words.
 * Used by Token-Budget mode for single-line field truncation.
 * @param {string} text
 * @param {number} maxWords
 * @returns {string}
 */
function trimToWords(text, maxWords) {
    if (!text) return '';
    const words = text.trim().split(/\s+/);
    if (words.length <= maxWords) return text.trim();
    return words.slice(0, maxWords).join(' ') + '…';
}

// ── Build the injection block ─────────────────────────────────────────────

/**
 * Build the complete world state injection block for the current chat.
 * Called on every message to the main LLM.
 *
 * @param {string} chatId
 * @returns {string} The injection text, or empty string if disabled
 */
export function buildInjectionBlock(chatId) {
    if (!isEnabled()) return '';
    if (!chatId) chatId = getChatId();
    if (!chatId) return '';

    const mode = getDensityMode();
    const parts = [];

    // ── Current Day ──────────────────────────────────────────────
    const day = isInjectCurrentDay() ? getCurrentDay(chatId) : null;
    if (day) {
        const dayBlock = buildCurrentDayBlock(day, chatId, mode);
        if (dayBlock) parts.push(dayBlock);
    }

    // Real-world holidays have their own per-chat injection toggle. They are
    // intentionally independent of the broader Current Day injection switch.
    const holidayBlock = buildNagerHolidayPromptBlock(chatId);
    if (holidayBlock) parts.push(holidayBlock);

    // ── Forecast + Moon Phases ───────────────────────────────────
    // Token-Budget: stripped to today only + phase name
    // Combined: today + 3-day outlook, moon phases as strip
    // Atmospheric: full 7-day with phenomena (current behavior)
    if (day) {
        const forecast  = getForecast(chatId);
        const moonPhases = getMoonPhases(chatId);
        const weatherBlock = buildWeatherBlock(forecast, moonPhases, chatId, mode);
        if (weatherBlock) parts.push(weatherBlock);
    }

    // ── Active Events ────────────────────────────────────────────
    if (isInjectEvents()) {
        const events = getActiveEvents(chatId);
        const eventsBlock = buildEventsBlock(events, mode);
        if (eventsBlock) parts.push(eventsBlock);
    }

    // ── World Conditions ─────────────────────────────────────────
    if (isInjectWorldConditions()) {
        const conditions = getEnabledConditions(chatId);
        const conditionsBlock = buildConditionsBlock(conditions, mode);
        if (conditionsBlock) parts.push(conditionsBlock);
    }

    // ── Scene-relevant Hidden Intention plan injection ───────────
    // Pure-JS relevance selection. Active Events generated from the same
    // intention suppress this path to prevent duplicate narrative pressure.
    const hiddenIntentionsBlock = buildHiddenIntentionsInjection(chatId);
    if (hiddenIntentionsBlock) parts.push(hiddenIntentionsBlock);

    // ── Selective Secret Injection ───────────────────────────────
    // Always instant JS lookup — no API call, no density difference.
    // Secrets are injected as-is in all modes; they're already concise.
    const secretBlock = buildSecretsInjection(chatId);
    if (secretBlock) parts.push(secretBlock);

    if (parts.length === 0) return '';

    // Token-Budget uses a compact wrapper; others use the full header
    return `---\n\n# WORLD STATE\n\n${parts.join('\n\n')}\n\n---`;
}

// ── Current Day block builders ────────────────────────────────────────────

function buildCurrentDayBlock(day, chatId, mode) {
    if (!day || (!day.dateDisplay && !day.season && !day.weatherToday)) return '';

    const seasonConfig  = getSeasonConfig(chatId);
    const calendarConfig = getCalendarConfig(chatId);
    const parsedDate = parseCurrentCalendarDate(day.dateDisplay || '', day.dateSub || '', calendarConfig, false);
    const computedSeason = computeSeason(day.dayCount || 0, seasonConfig);
    const displaySeason  = (computedSeason !== null && computedSeason !== undefined)
        ? computedSeason : day.season;

    const spiritualEnabled = (() => {
        const conditions = getEnabledConditions(chatId);
        return Object.prototype.hasOwnProperty.call(conditions, 'spiritual');
    })();

    if (mode === 'token-budget') {
        // Minimal key: value lines — no prose, no flavor
        let block = '';
        if (day.dateDisplay)    block += `Date: ${day.dateDisplay}\n`;
        if (day.dateSub)        block += `Era: ${day.dateSub}\n`;
        if (displaySeason)      block += `Season: ${displaySeason}\n`;
        if (day.weatherToday)   block += `Weather: ${trimToWords(day.weatherToday, 15)}\n`;
        // Flora and fauna omitted in token-budget — low narrative value per token
        if (day.spiritualClimate && spiritualEnabled) {
            block += `Spiritual: ${trimToWords(day.spiritualClimate, 15)}\n`;
        }
        return block.trim();

    } else if (mode === 'combined') {
        // Short labeled fields — 1 sentence max per prose field
        let block = '';
        if (day.dateDisplay) block += `Date: ${day.dateDisplay}\n`;
        if (day.dateSub)     block += `Era: ${day.dateSub}\n`;
        if (displaySeason)   block += `Season: ${displaySeason}\n`;
        if (day.weatherToday) block += `Weather: ${trimToSentences(day.weatherToday, 1)}\n`;
        if (day.flora)        block += `Flora: ${trimToSentences(day.flora, 1)}\n`;
        if (day.fauna)        block += `Fauna: ${trimToSentences(day.fauna, 1)}\n`;
        if (day.spiritualClimate && spiritualEnabled) {
            block += `Spiritual Climate: ${trimToSentences(day.spiritualClimate, 1)}\n`;
        }
        return block.trim();

    } else {
        // Atmospheric — full prose (current behavior, unchanged)
        let block = '';
        if (day.dateDisplay)    block += `Date: ${day.dateDisplay}\n`;
        if (day.dateSub)        block += `Era: ${day.dateSub}\n`;
        if (displaySeason)      block += `Season: ${displaySeason}\n`;
        if (day.weatherToday)   block += `Weather: ${day.weatherToday}\n`;
        if (day.flora)          block += `Flora: ${day.flora}\n`;
        if (day.fauna)          block += `Fauna: ${day.fauna}\n`;
        if (day.spiritualClimate && spiritualEnabled) {
            block += `Spiritual Climate: ${day.spiritualClimate}\n`;
        }
        return block.trim();
    }
}

// ── Weather / Moon block builders ─────────────────────────────────────────

function buildWeatherBlock(forecast, moonPhases, chatId, mode) {
    let block = '';

    if (mode === 'token-budget') {
        // Today's moon phase only — no forecast table, header preserved
        if (moonPhases && moonPhases.length > 0) {
            const today = moonPhases[0];
            block += `## Moon Phases:\n  Today: ${today.phaseName} ${today.icon}\n`;
        }
        return block.trim();

    } else if (mode === 'combined') {
        // 3-day forecast + 4-day moon strip, markdown headers preserved
        if (forecast && forecast.length > 0) {
            block += '## 7-Day Forecast:\n';
            const days = forecast.slice(0, 3);
            for (const day of days) {
                block += `  ${day.label}: ${day.description || ''} (${day.highF}°F/${day.lowF}°F)\n`;
            }
            if (forecast.length > 3) {
                block += `  (+ ${forecast.length - 3} more days)\n`;
            }
        }
        if (moonPhases && moonPhases.length > 0) {
            if (block) block += '\n';
            block += '## Moon Phases:\n';
            for (const moon of moonPhases.slice(0, 4)) {
                block += `  ${moon.label}: ${moon.phaseName} ${moon.icon}\n`;
            }
        }
        return block.trim();

    } else {
        // Atmospheric — full 7-day with phenomena (current behavior, unchanged)
        if (forecast && forecast.length > 0) {
            block += '## 7-Day Forecast:\n';
            for (const day of forecast) {
                block += `  ${day.label}: ${day.description || ''} (${day.highF}°F/${day.lowF}°F, precip: ${day.precipChance}%)\n`;
            }
        }
        if (moonPhases && moonPhases.length > 0) {
            if (block) block += '\n';
            block += '## Moon Phases:\n';
            const moonConfig = getMoonConfig(chatId);
            for (let i = 0; i < moonPhases.length; i++) {
                const moon = moonPhases[i];
                const phenomena = moonConfig.enableMoonPhenomena === false
                    ? []
                    : normalizeMoonPhenomena(moon.phenomena || [], {
                        allowStandaloneBloodMoon: Array.isArray(moon.manualPhenomena) && moon.manualPhenomena.includes('🌕 Blood Moon')
                    });
                let line = `  ${moon.label}: ${moon.phaseName} ${moon.icon}`;
                if (phenomena.length > 0) {
                    line += `\n         ⚡ ${phenomena.join(' | ')}`;
                }
                block += line + '\n';
            }
        }
        return block.trim();
    }
}

// ── Events block builders ─────────────────────────────────────────────────

function buildEventsBlock(events, mode) {
    if (!events || events.length === 0) return '';

    const grouped = {
        immediate:    events.filter(e => e.tier === 'immediate'),
        week:         events.filter(e => e.tier === 'week'),
        month:        events.filter(e => e.tier === 'month'),
        undetermined: events.filter(e => e.tier === 'undetermined'),
        persistent:   events.filter(e => e.tier === 'persistent')
    };

    const tierLabels = {
        immediate: 'Immediate', week: 'This Week',
        month: 'This Month',   undetermined: 'Narratively Timed — Introduce When Appropriate',
        persistent: 'Persistent — Remains Active Until Explicitly Resolved'
    };

    const narrativeTimingInstruction = 'Events under "Narratively Timed" have no fixed schedule. You may introduce or advance them whenever doing so is narratively appropriate, guided by pacing, character agency, and current circumstances.';
    const persistentInstruction = 'Persistent events represent ongoing pressures or states. Keep them active until the listed resolution condition is explicitly shown in the narrative; the passage of time alone does not resolve them.';

    if (mode === 'token-budget') {
        // Title only — no descriptions, but markdown headers preserved
        let block = '## Active Events:\n';
        for (const [tier, tierEvents] of Object.entries(grouped)) {
            if (tierEvents.length === 0) continue;
            block += `### ${tierLabels[tier]}:\n`;
            block += tierEvents.map(e => tier === 'persistent'
                ? `    - ${e.title}${e.resolutionCondition ? ` [Resolves when: ${trimToWords(e.resolutionCondition, 24)}]` : ''}`
                : `    - ${e.title}`).join('\n') + '\n';
        }
        if (grouped.undetermined.length > 0) block += `${narrativeTimingInstruction}\n`;
        if (grouped.persistent.length > 0) block += `${persistentInstruction}\n`;
        return block.trim();

    } else if (mode === 'combined') {
        // Title + one-sentence description max, markdown headers preserved
        let block = '## Active Events:\n';
        for (const [tier, tierEvents] of Object.entries(grouped)) {
            if (tierEvents.length === 0) continue;
            block += `### ${tierLabels[tier]}:\n`;
            for (const event of tierEvents) {
                const desc = event.description
                    ? ` — ${trimToSentences(event.description, 1)}`
                    : '';
                const resolution = tier === 'persistent' && event.resolutionCondition
                    ? ` [Resolves when: ${trimToSentences(event.resolutionCondition, 1)}]`
                    : '';
                block += `    - ${event.title}${desc}${resolution}\n`;
            }
        }
        if (grouped.undetermined.length > 0) block += `${narrativeTimingInstruction}\n`;
        if (grouped.persistent.length > 0) block += `${persistentInstruction}\n`;
        return block.trim();

    } else {
        // Atmospheric — full title + full description (current behavior)
        let block = '## Active Events:\n';
        for (const [tier, tierEvents] of Object.entries(grouped)) {
            if (tierEvents.length === 0) continue;
            block += `### ${tierLabels[tier]}:\n`;
            for (const event of tierEvents) {
                const resolution = tier === 'persistent' && event.resolutionCondition
                    ? ` [Resolves when: ${event.resolutionCondition}]`
                    : '';
                block += `    - ${event.title}: ${event.description}${resolution}\n`;
            }
        }
        if (grouped.undetermined.length > 0) block += `${narrativeTimingInstruction}\n`;
        if (grouped.persistent.length > 0) block += `${persistentInstruction}\n`;
        return block.trim();
    }
}

// ── World Conditions block builders ───────────────────────────────────────

function buildConditionsBlock(conditions, mode) {
    if (!conditions || Object.keys(conditions).length === 0) return '';

    const labels = {
        political:   'Political',
        social:      'Social',
        spiritual:   'Spiritual/Supernatural',
        environmental: 'Environmental'
    };

    if (mode === 'token-budget') {
        // One sentence per condition max, markdown header preserved
        let block = '## World Conditions:\n';
        for (const [key, condition] of Object.entries(conditions)) {
            if (condition.content) {
                block += `  ${labels[key] || key}: ${trimToSentences(condition.content, 1)}\n`;
            }
        }
        return block.trim();

    } else if (mode === 'combined') {
        // Two sentences per condition max, markdown header preserved
        let block = '## World Conditions:\n';
        for (const [key, condition] of Object.entries(conditions)) {
            if (condition.content) {
                block += `  ${labels[key] || key}: ${trimToSentences(condition.content, 2)}\n`;
            }
        }
        return block.trim();

    } else {
        // Atmospheric — full prose (current behavior)
        let block = '## World Conditions:\n';
        for (const [key, condition] of Object.entries(conditions)) {
            if (condition.content) {
                block += `  ${labels[key] || key}: ${condition.content}\n`;
            }
        }
        return block.trim();
    }
}

// ── ST Integration ────────────────────────────────────────────────────────

// Use a fresh native extension-prompt key. v1.3.42 accidentally persisted
// `nwst_world_state` into Prompt Manager, so reusing that identifier can leave
// the host with a stale saved-prompt/runtime collision that Prompt Inspector
// does not reliably represent. Legacy identifiers are actively cleared below.
const INJECTION_KEY = 'nwst_world_state_runtime';
const LEGACY_PROMPT_KEYS = Object.freeze([
    'nwst_world_state',
    'nwst_world_state_preview',
    'nwst-world-state-preview',
]);

function clearLegacyRuntimePrompts() {
    for (const key of LEGACY_PROMPT_KEYS) {
        setExtensionPrompt(key, '', 0, 0, false, extension_prompt_roles.SYSTEM);
    }
}

function buildInjectionBlockWithState(chatId) {
    if (!isEnabled()) return '';

    if (isPaused()) {
        const mode  = getDensityMode();
        const parts = [];

        if (isInjectCurrentDay()) {
            const day = getCurrentDay(chatId);
            const dayBlock = buildCurrentDayBlock(day, chatId, mode);
            if (dayBlock) parts.push(dayBlock);
            const forecast   = getForecast(chatId);
            const moonPhases = getMoonPhases(chatId);
            const weatherBlock = buildWeatherBlock(forecast, moonPhases, chatId, mode);
            if (weatherBlock) parts.push(weatherBlock);
        }
        if (isInjectEvents()) {
            const eventsBlock = buildEventsBlock(getActiveEvents(chatId), mode);
            if (eventsBlock) parts.push(eventsBlock);
        }
        if (isInjectWorldConditions()) {
            const conditionsBlock = buildConditionsBlock(getEnabledConditions(chatId), mode);
            if (conditionsBlock) parts.push(conditionsBlock);
        }

        if (parts.length === 0) return '';
        return `---\n\n# WORLD STATE\n\n${parts.join('\n\n')}\n\n---`;
    }

    return buildInjectionBlock(chatId);
}

export function updateInjection() {
    const chatId = getChatId();

    // Always clear every identifier used by the broken/preview implementations.
    // A live legacy extension prompt is a second paid prompt entry and may also
    // mask the current entry in Prompt Inspector depending on host state.
    clearLegacyRuntimePrompts();

    // A chat can briefly be absent while SillyTavern is loading or switching.
    // Do not leave the previous chat's world state registered during that gap.
    if (!chatId) {
        setExtensionPrompt(INJECTION_KEY, '', 0, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }

    const config = getInjectionConfig();
    if (!config) {
        setExtensionPrompt(INJECTION_KEY, '', 0, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }

    setExtensionPrompt(
        INJECTION_KEY, config.content, config.position,
        config.depth || 0, false, config.role ?? extension_prompt_roles.SYSTEM
    );
}

export function registerPromptInjection() {
    const { eventSource, event_types } = SillyTavern.getContext();
    // Keep the prior module instance's handler reference on window so a true
    // hot reload can detach it; a new import has a different function identity.
    const prior = typeof window !== 'undefined' ? window.__nwstPromptInjectionHandler : null;
    const events = [event_types.MESSAGE_SENT, event_types.MESSAGE_RECEIVED,
        event_types.CHAT_CHANGED, event_types.GENERATION_STARTED,
        event_types.OAI_PRESET_CHANGED_AFTER, event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.APP_READY].filter(Boolean);
    for (const event of new Set(events)) {
        if (prior) eventSource.removeListener?.(event, prior);
        eventSource.on(event, updateInjection);
    }
    if (typeof window !== 'undefined') window.__nwstPromptInjectionHandler = updateInjection;
    updateInjection();

    dlog('[NWST PromptInjector] Prompt injection registered.');
    dlog(`  - Density mode: ${getDensityMode()}`);
    dlog(`  - Inject Current Day: ${isInjectCurrentDay()}`);
    dlog(`  - Inject Events: ${isInjectEvents()}`);
    dlog(`  - Inject World Conditions: ${isInjectWorldConditions()}`);
    dlog(`  - Placement: ${getInjectionPlacement()}`);
}

export function getInjectionConfig() {
    if (!isEnabled()) return null;
    const placement = getInjectionPlacement();
    const chatId    = getChatId();
    const content   = buildInjectionBlockWithState(chatId);
    if (!content) return null;

    const config = { content, depth: 0 };
    switch (placement) {
        // Static extension-prompt positions become named Prompt Inspector entries
        // in Chat Completion, matching RST/Memory Loom's main injections.
        case 'before_main':
        case 'top_an': // legacy value; settings migration rewrites this to before_main
            config.position = 2;
            config.role = extension_prompt_roles.SYSTEM;
            break;
        case 'after_main':
        case 'bottom_an': // legacy value; settings migration rewrites this to after_main
            config.position = 0;
            config.role = extension_prompt_roles.SYSTEM;
            break;
        case 'at_depth': {
            config.position = 1;
            const requestedDepth = Number(getInjectionDepth());
            config.depth = Number.isFinite(requestedDepth)
                ? Math.max(0, Math.min(999, Math.trunc(requestedDepth)))
                : 2;
            config.role = ROLE_MAP[getInjectionDepthRole()] ?? extension_prompt_roles.SYSTEM;
            break;
        }
        default:
            config.position = 2;
            config.role = extension_prompt_roles.SYSTEM;
    }
    return config;
}
