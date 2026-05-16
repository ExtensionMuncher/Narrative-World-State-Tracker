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
//   • Notebook contents
//   • Community summaries
//   • Secrets (except selective blocks from narrativeConsistency.js)
// =============================================================================

import { getSettingContext, getCurrentDay, getForecast, getMoonPhases,
         getEnabledConditions } from '../data/worldState.js';
import { getActiveEvents, getEventsGroupedByTier } from '../data/events.js';
import {
    isInjectCurrentDay, isInjectEvents, isInjectWorldConditions,
    getInjectionPlacement, getInjectionDepth, getInjectionDepthRole,
    isEnabled
} from '../settings.js';
import { getChatId } from '../index.js';
// Selective secret injection runs on EVERY message — no API call needed.
// It checks which characters are in the current scene and injects only
// the secrets whose whoKnows characters are scene-present.
import { getSelectiveSecretInjection } from '../llm/narrativeConsistency.js';

// We'll be called by ST's generate_interceptor or through extension_prompt_types
// See manifest.json for the generate_interceptor registration

// ── Build the injection block ─────────────────────────────────────────────

/**
 * Build the complete world state injection block for the current chat.
 * This is called on every message to the main LLM.
 *
 * @param {string} chatId - The current chat ID
 * @returns {string} The injection text, or empty string if extension disabled
 */
export function buildInjectionBlock(chatId) {
    if (!isEnabled()) return '';
    if (!chatId) chatId = getChatId();
    if (!chatId) return '';

    const parts = [];

    // ── Current Day ────────────────────────────────────────────
    if (isInjectCurrentDay()) {
        const day = getCurrentDay(chatId);
        const dayBlock = buildCurrentDayBlock(day, chatId);
        if (dayBlock) parts.push(dayBlock);
    }

    // ── Forecast + Moon Phases ─────────────────────────────────
    if (isInjectCurrentDay()) {
        const forecast = getForecast(chatId);
        const moonPhases = getMoonPhases(chatId);
        const weatherBlock = buildWeatherBlock(forecast, moonPhases);
        if (weatherBlock) parts.push(weatherBlock);
    }

    // ── Active Events ──────────────────────────────────────────
    if (isInjectEvents()) {
        const events = getActiveEvents(chatId);
        const eventsBlock = buildEventsBlock(events);
        if (eventsBlock) parts.push(eventsBlock);
    }

    // ── World Conditions ───────────────────────────────────────
    if (isInjectWorldConditions()) {
        const conditions = getEnabledConditions(chatId);
        const conditionsBlock = buildConditionsBlock(conditions);
        if (conditionsBlock) parts.push(conditionsBlock);
    }

    // ── Selective Secret Injection ─────────────────────────────
    // Runs on EVERY message — no API call. Checks current scene characters
    // against all secret whoKnows lists. Only injects secrets whose
    // whoKnows characters are detected as scene-present. This is instant
    // and does NOT wait for the Narrative Consistency LLM scan cadence.
    const secretBlock = getSelectiveSecretInjection(chatId);
    if (secretBlock) parts.push(secretBlock);

    if (parts.length === 0) return '';

    // Join all blocks with separators
    return `\n[WORLD STATE]\n${parts.join('\n')}\n[/WORLD STATE]\n`;
}

// ── Individual block builders ─────────────────────────────────────────────

function buildCurrentDayBlock(day, chatId) {
    if (!day || (!day.dateDisplay && !day.season && !day.weatherToday)) return '';

    let block = '';
    if (day.dateDisplay) block += `Date: ${day.dateDisplay}\n`;
    if (day.season) block += `Season: ${day.season}\n`;
    if (day.weatherToday) block += `Weather: ${day.weatherToday}\n`;
    if (day.flora) block += `Flora: ${day.flora}\n`;
    if (day.fauna) block += `Fauna: ${day.fauna}\n`;

    // Only include Spiritual Climate if the condition is enabled
    if (day.spiritualClimate) {
        const conditions = getEnabledConditions(chatId);
        if (conditions.spiritual?.enabled !== false) {
            block += `Spiritual Climate: ${day.spiritualClimate}\n`;
        }
    }

    return block.trim();
}

function buildWeatherBlock(forecast, moonPhases) {
    let block = '';

    if (forecast && forecast.length > 0) {
        block += '7-Day Forecast:\n';
        for (const day of forecast) {
            block += `  ${day.label}: ${day.description || ''} (${day.highF}°F/${day.lowF}°F, precip: ${day.precipChance}%)\n`;
        }
    }

    if (moonPhases && moonPhases.length > 0) {
        if (block) block += '\n';
        block += 'Moon Phases:\n';
        for (const moon of moonPhases) {
            block += `  ${moon.label}: ${moon.phaseName} ${moon.icon}\n`;
        }
    }

    return block.trim();
}

function buildEventsBlock(events) {
    if (!events || events.length === 0) return '';

    const grouped = {
        immediate: events.filter(e => e.tier === 'immediate'),
        week: events.filter(e => e.tier === 'week'),
        month: events.filter(e => e.tier === 'month'),
        undetermined: events.filter(e => e.tier === 'undetermined')
    };

    let block = 'Upcoming Events:\n';
    const tierLabels = { immediate: 'Immediate', week: 'This Week', month: 'This Month', undetermined: 'Undetermined' };

    for (const [tier, tierEvents] of Object.entries(grouped)) {
        if (tierEvents.length === 0) continue;
        block += `  ${tierLabels[tier]}:\n`;
        for (const event of tierEvents) {
            block += `    - ${event.title}: ${event.description}\n`;
        }
    }

    return block.trim();
}

function buildConditionsBlock(conditions) {
    if (!conditions || Object.keys(conditions).length === 0) return '';

    let block = 'Active World Conditions:\n';
    const labels = {
        political: 'Political',
        social: 'Social',
        spiritual: 'Spiritual/Supernatural',
        environmental: 'Environmental'
    };

    for (const [key, condition] of Object.entries(conditions)) {
        if (condition.content) {
            block += `  ${labels[key] || key}: ${condition.content}\n`;
        }
    }

    return block.trim();
}

// ── ST Integration ────────────────────────────────────────────────────────

/**
 * Register the prompt injection with ST's native prompt system.
 * Called during extension initialization.
 *
 * ST provides several injection mechanisms:
 * - extension_prompt_types.IN_PROMPT (before/after main prompt)
 * - extension_prompt_types.AFTER_CHAR (after character definition)
 * - extension_prompt_types.AUTHOR_NOTE (in author's note)
 * - At depth (injects at a specific message depth)
 */
export function registerPromptInjection() {
    // The actual injection is configured in index.js using ST's settings
    // This function validates the configuration and sets up the injection hook.

    console.log('[NWST PromptInjector] Prompt injection registered.');
    console.log(`  - Inject Current Day: ${isInjectCurrentDay()}`);
    console.log(`  - Inject Events: ${isInjectEvents()}`);
    console.log(`  - Inject World Conditions: ${isInjectWorldConditions()}`);
    console.log(`  - Placement: ${getInjectionPlacement()}`);

    if (getInjectionPlacement() === 'at_depth') {
        console.log(`  - Depth: ${getInjectionDepth()}, Role: ${getInjectionDepthRole()}`);
    }
}

/**
 * Get the injection configuration as an object ST can use.
 * Maps our settings to ST's extension_prompt_types and extension_prompt_roles.
 *
 * @returns {object} { position, depth, role, content } or null if disabled
 */
export function getInjectionConfig() {
    if (!isEnabled()) return null;

    const placement = getInjectionPlacement();
    const chatId = getChatId();
    const content = buildInjectionBlock(chatId);

    if (!content) return null;

    // Map our placement strings to ST's extension_prompt_types values
    // These will be verified during integration testing
    const config = {
        content: content
    };

    switch (placement) {
        case 'before_main':
            config.position = 0; // extension_prompt_types.IN_PROMPT (before)
            break;
        case 'after_main':
            config.position = 1; // extension_prompt_types.IN_PROMPT (after)
            break;
        case 'top_an':
            config.position = 2; // extension_prompt_types.AUTHOR_NOTE (top)
            break;
        case 'bottom_an':
            config.position = 3; // extension_prompt_types.AUTHOR_NOTE (bottom)
            break;
        case 'at_depth':
            config.position = 4; // At depth
            config.depth = getInjectionDepth();
            config.role = getInjectionDepthRole();
            break;
        default:
            config.position = 0;
    }

    return config;
}
