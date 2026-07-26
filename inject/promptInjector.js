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
//   • Selective secret blocks (from narrativeConsistency.js)
//
// What NEVER gets injected:
//   • Notebook contents (bullets, core fields, mystery fields)
//   • Community summaries
//   • Secrets (except selective blocks from narrativeConsistency.js)
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

import { extension_prompt_roles } from '../../../../../script.js';
import { getCurrentDay, getForecast, getMoonPhases,
         getEnabledConditions, getSeasonConfig } from '../data/worldState.js';
import { getActiveEvents } from '../data/events.js';
import {
    isInjectCurrentDay, isInjectEvents, isInjectWorldConditions,
    getInjectionPlacement, getInjectionDepth, getInjectionDepthRole,
    isEnabled, isPaused, getDensityMode
} from '../settings.js';
import { getChatId } from '../index.js';
import { buildSecretsInjection } from '../llm/secretsInjection.js';
import { computeSeason, normalizeMoonPhenomena } from '../llm/dayAdvancement.js';
import { getMoonConfig } from '../data/moons.js';
import { buildNagerHolidayPromptBlock } from '../data/nagerDate.js';
import { dlog } from "../lib/debug.js";

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
    const computedSeason = computeSeason(day.dayCount || 0, seasonConfig);
    const displaySeason  = (computedSeason !== null && computedSeason !== undefined)
        ? computedSeason : day.season;

    const spiritualEnabled = (() => {
        const conditions = getEnabledConditions(chatId);
        return conditions.spiritual?.enabled !== false;
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
        undetermined: events.filter(e => e.tier === 'undetermined')
    };

    const tierLabels = {
        immediate: 'Immediate', week: 'This Week',
        month: 'This Month',   undetermined: 'Undetermined'
    };

    if (mode === 'token-budget') {
        // Title only — no descriptions, but markdown headers preserved
        let block = '## Active Events:\n';
        for (const [tier, tierEvents] of Object.entries(grouped)) {
            if (tierEvents.length === 0) continue;
            block += `### ${tierLabels[tier]}:\n`;
            block += tierEvents.map(e => `    - ${e.title}`).join('\n') + '\n';
        }
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
                block += `    - ${event.title}${desc}\n`;
            }
        }
        return block.trim();

    } else {
        // Atmospheric — full title + full description (current behavior)
        let block = '## Active Events:\n';
        for (const [tier, tierEvents] of Object.entries(grouped)) {
            if (tierEvents.length === 0) continue;
            block += `### ${tierLabels[tier]}:\n`;
            for (const event of tierEvents) {
                block += `    - ${event.title}: ${event.description}\n`;
            }
        }
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

const INJECTION_KEY = 'nwst_world_state';
const PREVIEW_KEY   = 'nwst_world_state_preview';

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
    if (!chatId) return;

    const config = getInjectionConfig();
    const { setExtensionPrompt } = SillyTavern.getContext();

    if (!config) {
        setExtensionPrompt(INJECTION_KEY, '', 0, 0, false, extension_prompt_roles.SYSTEM);
        setExtensionPrompt(PREVIEW_KEY,   '', 0, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }

    setExtensionPrompt(
        INJECTION_KEY, config.content, config.position,
        config.depth || 0, false, config.role ?? extension_prompt_roles.SYSTEM
    );
    // The preview key carries the SAME content at position 0 (IN_PROMPT) so the
    // world-state block is visible in ST's Prompt List / Inspect view (the same
    // pattern other extensions use, e.g. rst_stat_block_preview). When the main
    // injection is placed at-depth, the preview key is what surfaces it in the
    // prompt manager UI. This is intentional visibility, not duplicate content
    // in the sense of two independent blocks — they share one logical injection.
    setExtensionPrompt(
        PREVIEW_KEY, config.content, 0, 0, false, extension_prompt_roles.SYSTEM
    );
}

export function registerPromptInjection() {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.MESSAGE_SENT,    () => updateInjection());
    eventSource.on(event_types.MESSAGE_RECEIVED, () => updateInjection());
    eventSource.on(event_types.CHAT_CHANGED,    () => updateInjection());
    updateInjection();
    cleanupStalePromptManagerEntry();

    dlog('[NWST PromptInjector] Prompt injection registered.');
    dlog(`  - Density mode: ${getDensityMode()}`);
    dlog(`  - Inject Current Day: ${isInjectCurrentDay()}`);
    dlog(`  - Inject Events: ${isInjectEvents()}`);
    dlog(`  - Inject World Conditions: ${isInjectWorldConditions()}`);
    dlog(`  - Placement: ${getInjectionPlacement()}`);
}

function cleanupStalePromptManagerEntry() {
    try {
        const { chatCompletionSettings, saveSettingsDebounced } = SillyTavern.getContext();
        if (!chatCompletionSettings || !Array.isArray(chatCompletionSettings.prompts)) return;
        let changed = false;
        // Remove stale prompt manager entries for BOTH the injection key and the
        // preview key.
        for (const key of [INJECTION_KEY, PREVIEW_KEY]) {
            const promptIdx = chatCompletionSettings.prompts.findIndex(p => p?.identifier === key);
            if (promptIdx !== -1) { chatCompletionSettings.prompts.splice(promptIdx, 1); changed = true; }
            if (Array.isArray(chatCompletionSettings.prompt_order)) {
                for (const charOrder of chatCompletionSettings.prompt_order) {
                    if (Array.isArray(charOrder?.order)) {
                        const orderIdx = charOrder.order.findIndex(e => e?.identifier === key);
                        if (orderIdx !== -1) { charOrder.order.splice(orderIdx, 1); changed = true; }
                    }
                }
            }
        }
        if (changed) saveSettingsDebounced();
    } catch (e) { /* non-fatal */ }
}

export function getInjectionConfig() {
    if (!isEnabled()) return null;
    const placement = getInjectionPlacement();
    const chatId    = getChatId();
    const content   = buildInjectionBlockWithState(chatId);
    if (!content) return null;

    const config = { content };
    switch (placement) {
        case 'before_main': config.position = 2; config.role = extension_prompt_roles.SYSTEM; break;
        case 'after_main':  config.position = 0; config.role = extension_prompt_roles.SYSTEM; break;
        case 'top_an':      config.position = 1; config.depth = 0;   config.role = extension_prompt_roles.SYSTEM; break;
        case 'bottom_an':   config.position = 1; config.depth = 999; config.role = extension_prompt_roles.SYSTEM; break;
        case 'at_depth':
            config.position = 1;
            config.depth    = getInjectionDepth();
            config.role     = ROLE_MAP[getInjectionDepthRole()] ?? extension_prompt_roles.SYSTEM;
            break;
        default: config.position = 0; config.role = extension_prompt_roles.SYSTEM;
    }
    return config;
}
