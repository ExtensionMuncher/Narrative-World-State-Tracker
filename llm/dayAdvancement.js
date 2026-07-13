/* eslint-disable */
// =============================================================================
// NWST Day Advancement LLM — llm/dayAdvancement.js
// =============================================================================
// Handles the "Next Day" process:
//   1. Calls Day Advancement LLM with current date + setting context + forecast + moon phase
//   2. Receives updated date strings, new 7-day forecast, updated 7-day moon phases
//   3. Saves results to storage
//   4. Then triggers currentDaySynth.js to rewrite the Current Day narrative block
//   5. Rolls event horizon forward
//   6. Saves a per-day snapshot for Previous Day restoration
//
// Previous Day: NO API calls — restores saved snapshot exactly.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { getSetting } from '../index.js';
import { getSettingContext, getCurrentDay, replaceCurrentDay, updateCurrentDay,
         getForecast, replaceForecast, getMoonPhases, replaceMoonPhases,
         saveSnapshot, getLatestSnapshot, getSnapshots, getWorldState,
         getSeasonConfig, getCalendarConfig } from '../data/worldState.js';
import { getAllEvents, saveAllEvents, getActiveEvents, rollEventHorizon, compactEventHorizon } from '../data/events.js';
import { runEventValidityReview } from './eventValidity.js';
import { getNotebook } from '../data/notebook.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { getPlannerPrompt, getScanFrequency } from '../settings.js';
import { computeDayOfYearFromDate } from './batchScan.js';
import { dlog } from "../lib/debug.js";


// ── Moon phase calculation (programmatic — no LLM involvement) ────────────

/**
 * The 8 standard moon phases with their angle ranges and icons.
 * Phase angle is measured from New Moon (0°) through each octant.
 * @constant
 */
const MOON_PHASES = [
    { name: 'New Moon',        icon: '🌑', minAngle: 0,      maxAngle: 22.5 },
    { name: 'Waxing Crescent', icon: '🌒', minAngle: 22.5,   maxAngle: 67.5 },
    { name: 'First Quarter',   icon: '🌓', minAngle: 67.5,   maxAngle: 112.5 },
    { name: 'Waxing Gibbous',  icon: '🌔', minAngle: 112.5,  maxAngle: 157.5 },
    { name: 'Full Moon',       icon: '🌕', minAngle: 157.5,  maxAngle: 202.5 },
    { name: 'Waning Gibbous',  icon: '🌖', minAngle: 202.5,  maxAngle: 247.5 },
    { name: 'Last Quarter',    icon: '🌗', minAngle: 247.5,  maxAngle: 292.5 },
    { name: 'Waning Crescent', icon: '🌘', minAngle: 292.5,  maxAngle: 337.5 },
];

/**
 * Get the configured moon cycle length (degrees per day).
 * Reads from Settings so fantasy worlds can override the 29.53-day default.
 * @returns {number} Degrees of lunar progression per day
 */
export function getDegreesPerDay() {
    const cycleDays = getSetting('moonCycleDays') || 29.53058867;
    return 360 / cycleDays;
}

/**
 * Get the stored lunar angle for the current chat.
 * The lunar angle (0-360) represents the absolute position in the lunar cycle,
 * where 0 = New Moon. This is stored in currentDay.lunarAngle.
 * @param {string} chatId
 * @returns {number} Angle in degrees, defaults to 0 if not yet set
 */
export function getLunarAngle(chatId) {
    const day = getCurrentDay(chatId);
    if (day && typeof day.lunarAngle === 'number' && !isNaN(day.lunarAngle)) {
        return ((day.lunarAngle % 360) + 360) % 360;
    }
    return 0;
}

/**
 * Set the stored lunar angle for the current chat.
 * @param {string} chatId
 * @param {number} angle - Angle in degrees (will be normalized to 0-360)
 */
export async function setLunarAngle(chatId, angle) {
    const normalized = ((angle % 360) + 360) % 360;
    await updateCurrentDay(chatId, { lunarAngle: normalized });
}

/**
 * Get the center angle for a given moon phase name.
 * @param {string} phaseName - e.g. "Waning Gibbous"
 * @returns {number} Center angle in degrees (0-360), defaults to 0 (New Moon) if unknown.
 */
export function getPhaseAngle(phaseName) {
    const phase = MOON_PHASES.find(p => p.name.toLowerCase() === (phaseName || '').toLowerCase());
    if (phase) return (phase.minAngle + phase.maxAngle) / 2;
    return 0;
}

/**
 * Get moon phase name and icon for a given angle in the lunar cycle.
 * @param {number} angle - Angle in degrees (0-360)
 * @returns {{ phaseName: string, icon: string }}
 */
export function getMoonPhaseForAngle(angle) {
    const normalized = ((angle % 360) + 360) % 360;
    const phase = MOON_PHASES.find(p => normalized >= p.minAngle && normalized < p.maxAngle);
    if (phase) return { phaseName: phase.name, icon: phase.icon };
    // Angle >= 337.5 wraps around to New Moon
    return { phaseName: 'New Moon', icon: '🌑' };
}

/**
 * Generate N days of moon phases starting from an anchor angle.
 * Each subsequent day advances by getDegreesPerDay() through the lunar cycle,
 * yielding physically accurate progression (e.g., Full Moon → Waning Gibbous →
 * Last Quarter → Waning Crescent over ~10 days).
 *
 * @param {number} anchorAngle - Absolute angle in degrees (0-360) for day 0
 * @param {number} [numDays=7] - Number of days to generate
 * @param {number} [startOffset=0] - Day offset from anchor for the first entry
 * @returns {Array<{label: string, icon: string, phaseName: string}>}
 */
/**
 * Generate moon phase entries for a range of days, optionally computing phenomena.
 * When phenomenaOptions is provided, phenomena are computed at generation time
 * and stored in the phase entries — this preserves them across day advancements
 * instead of recomputing them fresh at display time (which causes them to change).
 *
 * @param {number} anchorAngle - Starting lunar angle in degrees
 * @param {number} [numDays=7] - Number of days to generate
 * @param {number} [startOffset=0] - Day offset from anchor
 * @param {object|null} [phenomenaOptions=null] - If provided, compute phenomena:
 *   { season, weatherToday, cycleDays }
 * @returns {object[]} Array of { label, icon, phaseName, phenomena? }
 */
export function generateMoonPhases(anchorAngle, numDays = 7, startOffset = 0, phenomenaOptions = null) {
    const labels = ['Today', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'];
    const degPerDay = getDegreesPerDay();
    const phases = [];

    for (let i = 0; i < numDays; i++) {
        const angle = anchorAngle + (startOffset + i) * degPerDay;
        const { phaseName, icon } = getMoonPhaseForAngle(angle);
        const entry = {
            label: labels[i] || `Day ${i + 1}`,
            icon,
            phaseName
        };

        // Compute and STORE phenomena at generation time so they persist
        // across re-renders and day advancements.
        if (phenomenaOptions) {
            const cycleDays = phenomenaOptions.cycleDays || 29.53;
            entry.phenomena = getMoonPhenomena(angle, i, cycleDays, phenomenaOptions);
        }

        phases.push(entry);
    }

    return phases;
}

/**
 * Compute a lunar angle from a narrative date string by scanning for
 * explicit phase names, partial phase clues, or numeric day-of-month values.
 *
 * This is the key fix for "Regen always starts from New Moon" — instead of
 * defaulting to 0 (New Moon), we try to extract a meaningful position from
 * whatever date text the user or LLM has set.
 *
 * Detection order (first match wins):
 *   1. Explicit phase name (e.g. "Full Moon", "Waning Gibbous")
 *   2. Partial phase clues (e.g. "Waxing" → mid-waxing, "Crescent" → ~45°)
 *   3. "Day {N}" or "Date {N}" patterns — treated as day-of-cycle
 *   4. Numeric dates parsed as month/day/year → uses day-of-month component
 *   5. Any first integer found → mapped through the cycle length
 *   6. Fallback: 0° (New Moon) if nothing can be parsed
 *
 * @param {string} dateDisplay - The narrative date string (e.g. "Chrysanthemum Month · Seventh Day of the Waxing Moon")
 * @returns {number} Angle in degrees (0-360), 0 = New Moon
 */
export function computeLunarAngleFromDate(dateDisplay) {
    if (!dateDisplay) return 0;

    const text = dateDisplay.toLowerCase().trim();
    const cycleDays = getSetting('moonCycleDays') || 29.53058867;

    // ── 1. Explicit phase name (highest priority) ────────────────
    // Build patterns from the MOON_PHASES array for future-proofing
    for (const phase of MOON_PHASES) {
        const phrase = phase.name.toLowerCase();
        if (text.includes(phrase)) {
            return (phase.minAngle + phase.maxAngle) / 2;
        }
    }

    // ── 2. Partial phase clues ───────────────────────────────────
    const partials = [
        { regex: /\bwaxing\b/,     angle: 45 },   // Mid-waxing crescent
        { regex: /\bwaning\b/,     angle: 225 },  // Mid-waning gibbous
        { regex: /\bcrescent\b/,   angle: 45 },   // Waxing crescent
        { regex: /\bgibbous\b/,    angle: 135 },  // Waxing gibbous
        { regex: /\bquarter\b/,    angle: 90 },   // First quarter
        { regex: /\bhalf\s*moon\b/, angle: 90 },  // Half moon = quarter
    ];
    for (const { regex, angle } of partials) {
        if (regex.test(text)) return angle;
    }

    // ── 3. "Day {N}" or "Date {N}" pattern ──────────────────────
    // e.g. "Day 7 of the Waxing Moon" → day 7 of cycle → ~85°
    const dayMatch = text.match(/(?:^|\s)(?:day|date)\s*(\d+)/);
    if (dayMatch) {
        const dayNum = parseInt(dayMatch[1], 10);
        if (dayNum >= 1 && dayNum <= 999) {
            return ((dayNum / cycleDays) * 360) % 360;
        }
    }

    // ── 4. Ordinal date patterns ("Seventh Day", "15th") ────────
    // Common in fantasy date formats
    const ordinals = {
        'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5,
        'sixth': 6, 'seventh': 7, 'eighth': 8, 'ninth': 9, 'tenth': 10,
        'eleventh': 11, 'twelfth': 12, 'thirteenth': 13, 'fourteenth': 14,
        'fifteenth': 15, 'sixteenth': 16, 'seventeenth': 17, 'eighteenth': 18,
        'nineteenth': 19, 'twentieth': 20, 'twenty-first': 21, 'twenty-second': 22,
        'twenty-third': 23, 'twenty-fourth': 24, 'twenty-fifth': 25,
        'twenty-sixth': 26, 'twenty-seventh': 27, 'twenty-eighth': 28,
        'twenty-ninth': 29, 'thirtieth': 30, 'thirty-first': 31,
    };
    for (const [word, num] of Object.entries(ordinals)) {
        if (text.includes(word) && text.includes('day')) {
            return ((num / cycleDays) * 360) % 360;
        }
    }

    // ── 5. Structured numeric dates (month/day/year, day/month/year) ──
    // Try to extract a day-of-month component and map through the cycle
    const datePatterns = [
        // 11/7/1125 or 11-7-1125 — month/day/year or day/month/year
        /(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})\s*[\/\-\.]\s*(\d{2,4})/,
        // "Month 3, Day 14" format
        /(?:month|moon)\s*(\d+)[,\s]+(?:day|date)\s*(\d+)/i,
    ];

    for (const pattern of datePatterns) {
        const m = text.match(pattern);
        if (m) {
            // For month/day/year, day is group 2; for "Month X, Day Y" it's group 2
            const dayOfMonth = parseInt(m[2], 10);
            if (dayOfMonth >= 1 && dayOfMonth <= 31) {
                return ((dayOfMonth / cycleDays) * 360) % 360;
            }
        }
    }

    // ── 6. Any first integer found in the text ───────────────────
    // Broad fallback — treats the first number as a cycle position
    const anyNum = text.match(/\d+/);
    if (anyNum) {
        const num = parseInt(anyNum[0], 10);
        if (num >= 1 && num <= 999) {
            return ((num / cycleDays) * 360) % 360;
        }
    }

    // ── 7. Fallback: New Moon ───────────────────────────────────
    // If nothing matched, return 0 (New Moon position)
    return 0;
}

// ── Seasonal Engine ───────────────────────────────────────────────────────

/**
 * Compute the current season name from an elapsed day count and season config.
 *
 * Modes:
 *   'auto'     — cycles through the configured season map based on dayCount % yearLength
 *   'static'   — always returns the first season name (for timeless settings)
 *   'disabled' — returns null (seasons are entirely LLM-controlled, legacy behavior)
 *
 * @param {number} dayCount - Absolute elapsed days since epoch start
 * @param {object} seasonConfig - Per-chat season configuration { mode, yearLength, seasons[] }
 * @returns {string|null} The computed season name, or null if disabled
 */
export function computeSeason(dayCount, seasonConfig) {
    if (!seasonConfig || seasonConfig.mode === 'disabled') return null;
    if (seasonConfig.mode === 'static') {
        return seasonConfig.seasons?.[0]?.name || null;
    }
    // auto mode: compute day-of-year and find matching season band
    const yearLength = seasonConfig.yearLength || 365;
    const dayOfYear = ((dayCount % yearLength) + yearLength) % yearLength;
    const seasons = seasonConfig.seasons || [];
    for (const s of seasons) {
        if (dayOfYear >= s.startDay && dayOfYear <= s.endDay) return s.name;
    }
    return seasons[0]?.name || null;
}

/**
 * Convenience: get the computed season for a chat by reading dayCount + seasonConfig.
 * @param {string} chatId
 * @returns {string|null} The computed season name, or null if disabled
 */
export function getComputedSeason(chatId) {
    const day = getCurrentDay(chatId);
    const dayCount = (day && typeof day.dayCount === 'number') ? day.dayCount : 0;
    const seasonConfig = getSeasonConfig(chatId);
    return computeSeason(dayCount, seasonConfig);
}

/**
 * Get configured moons from settings (array of moon definitions).
 * Falls back to a single default moon if no configuration exists.
 * @returns {Array<{id: string, name: string, cycleDays: number, enabled: boolean}>}
 */
export function getConfiguredMoons() {
    const enableMoons = getSetting('enableMoons');
    if (enableMoons === false) return []; // Moons disabled entirely

    const moons = getSetting('moons');
    if (moons && moons.length > 0) {
        return moons.filter(m => m.enabled !== false);
    }

    // Fallback: return default single moon using the legacy cycle length
    return [{
        id: 'primary',
        name: 'The Moon',
        cycleDays: getSetting('moonCycleDays') || 29.53058867,
        enabled: true
    }];
}

/**
 * Detect naturally occurring moon phenomena for a given lunar angle and day.
 *
 * Phenomena are rare, special events that appear as tags alongside normal phases:
 *   - 🌟 Solar Eclipse: Occurs near New Moon (~0°), very rare (~1% chance per cycle)
 *   - 🌟 Lunar Eclipse: Occurs near Full Moon (~180°), very rare (~1% chance per cycle)
 *   - 🌟 Blue Moon: Second Full Moon occurrence flagged manually (detected at generation time)
 *   - 🌟 Super Moon: Full Moon within 5° of perigee-simulated position (~1 in 6 chance)
 *   - 🌟 Blood Moon: Full Moon during eclipse season (~1 in 10 chance for Full Moons)
 *
 * @param {number} angle - Lunar angle in degrees
 * @param {number} dayIndex - Position in the generated phase array (0 = today)
 * @param {number} cycleDays - Cycle length for this moon
 * @returns {string[]} Array of phenomenon tags (empty if none apply)
 */
/**
 * Detect moon phenomena (eclipses, super/blood moons, etc.) for a given angle.
 * Phenomena are determined using deterministic seeding — stable across refreshes.
 *
 * @param {number} angle - Lunar angle in degrees (0-360)
 * @param {number} dayIndex - Relative day index (0 = today, for seeding)
 * @param {number} cycleDays - Length of the lunar cycle in days
 * @param {object} [options] - Optional context for weather/season-dependent phenomena
 * @param {string} [options.season] - Current season name (e.g. "Autumn", "Spring")
 * @param {string} [options.weatherToday] - Current weather description text
 * @returns {string[]} Array of detected phenomenon labels (may be empty)
 */
export function getMoonPhenomena(angle, dayIndex, cycleDays, options = {}) {
    const enabled = getSetting('enableMoonPhenomena');
    if (!enabled) return [];

    const normalized = ((angle % 360) + 360) % 360;
    const phenomena = [];
    const isFullMoon = normalized >= 157.5 && normalized <= 202.5;
    const isNewMoon = normalized < 22.5 || normalized >= 337.5;

    // ── Full Moon phenomena (mutually exclusive primary category) ──────
    if (isFullMoon) {
        // Deterministic seed for primary Full Moon categorization
        const seed = (Math.abs(angle * 7 + dayIndex * 13) % 100) / 100;

        if (seed < 0.17) {
            phenomena.push('🌕 Super Moon');       // 17% — perigee full moon
        } else if (seed < 0.27) {
            phenomena.push('🌕 Blood Moon');        // 10% — eclipsed/ruddy full moon
        } else {
            // Micro Moon: Full Moon at apogee (appears smaller)
            // Uses a separate prime combination to avoid shifting existing probabilities
            const microSeed = (Math.abs(angle * 31 + dayIndex * 37) % 100) / 100;
            if (microSeed < 0.17) {
                phenomena.push('🌕 Micro Moon');     // ~12% overall (17% of the 73% remainder)
            }
        }

        // ── Seasonal Full Moon naming ─────────────────────────────
        // Harvest Moon = Full Moon closest to autumn equinox (September).
        // Hunter Moon = next Full Moon after Harvest (October).
        // They are one FULL MOON CYCLE (~29 days) apart, NOT per-day.
        // CRITICAL: Use lunar month window (angle/30 = 12 segments of 30°),
        // NOT per-dayIndex seeding. This prevents alternating Harvest/Hunter
        // when a Full Moon spans multiple days in the 7-day strip.
        const season = (options.season || '').toLowerCase();
        if (season.includes('autumn') || season.includes('fall')) {
            // Group by 30° lunar month segments — all days in the same segment
            // get the SAME seasonal full moon name. No more day-to-day alternation.
            const lunarMonthIndex = Math.floor(angle / 30);
            const seasonSeed = (Math.abs(lunarMonthIndex * 41) % 100) / 100;
            if (seasonSeed < 0.5) {
                phenomena.push('🌾 Harvest Moon');
            } else {
                phenomena.push('🏹 Hunter Moon');
            }
        }
    }

    // ── Eclipses (can stack with other phenomena) ─────────────────
    // Solar Eclipse: rare event near New Moon
    if (isNewMoon) {
        const seed = (Math.abs(angle * 11 + dayIndex * 17) % 100) / 100;
        if (seed < 0.04) phenomena.push('☀️ Solar Eclipse');
    }

    // Lunar Eclipse: rare event near Full Moon
    if (isFullMoon) {
        const seed = (Math.abs(angle * 19 + dayIndex * 23) % 100) / 100;
        if (seed < 0.04) phenomena.push('🌑 Lunar Eclipse');
    }

    // ── Weather-dependent phenomena ───────────────────────────────
    // These require a bright moon AND specific atmospheric conditions.
    // The moon is "bright enough" from Waxing Gibbous through Waning Gibbous
    // (~112.5° to ~247.5°), covering ~37% of the cycle.
    const isBrightMoon = normalized >= 112.5 && normalized <= 247.5;

    if (isBrightMoon && options.weatherToday) {
        const weather = options.weatherToday.toLowerCase();

        // Moonbow (Lunar Rainbow): requires rain/mist + bright moon
        // Rain droplets refract moonlight, creating a faint night rainbow.
        // Rare and magical — requires both moon phase and weather alignment.
        const moonbowKeywords = ['rain', 'shower', 'drizzle', 'mist', 'fog', 'storm', 'thunder', 'humid', 'wet'];
        const hasMoonbowWeather = moonbowKeywords.some(kw => weather.includes(kw));
        if (hasMoonbowWeather) {
            const moonbowSeed = (Math.abs(angle * 53 + dayIndex * 59) % 100) / 100;
            if (moonbowSeed < 0.20) {
                phenomena.push('🌌 Moonbow');
            }
        }

        // Lunar Ring (22° Halo): requires high thin cirrus clouds + bright moon
        // Ice crystals in the upper atmosphere refract moonlight into a ring.
        // Visible on clear/cold nights with high cloud cover.
        const ringKeywords = ['clear', 'cloud', 'cirrus', 'cold', 'crisp', 'frost', 'ice', 'high', 'fair', 'partly'];
        const hasRingWeather = ringKeywords.some(kw => weather.includes(kw));
        if (hasRingWeather) {
            const ringSeed = (Math.abs(angle * 61 + dayIndex * 67) % 100) / 100;
            if (ringSeed < 0.20) {
                phenomena.push('🌙 Lunar Ring');
            }
        }
    }

    return phenomena;
}

/**
 * Manually set the moon phase anchor to a specific phase name.
 * This lets the user pin the moon to e.g. "Full Moon" regardless of date.
 * The lunarAngle is set to the center angle of the chosen phase,
 * then moon phases are regenerated from that anchor.
 *
 * @param {string} chatId
 * @param {string} phaseName - One of the 8 standard phases
 * @returns {boolean} True on success
 */
export async function setMoonPhaseAnchor(chatId, phaseName) {
    if (!chatId || !phaseName) return false;

    const angle = getPhaseAngle(phaseName);
    await setLunarAngle(chatId, angle);

    // Compute phenomena in context of the current day
    const day = getCurrentDay(chatId);
    const cycleDays = getSetting('moonCycleDays') || 29.53;
    const phenOptions = {
        season: day?.season || '',
        weatherToday: day?.weatherToday || '',
        cycleDays
    };
    const newMoonPhases = generateMoonPhases(angle, 7, 0, phenOptions);
    await replaceMoonPhases(chatId, newMoonPhases);

    return true;
}

/**
 * Regenerate moon phases from the current date display text.
 * This computes the lunar angle by parsing the date string semantically,
 * then generates a fresh 7-day phase sequence from that position.
 *
 * This is the "Regen from current date" fix — instead of defaulting
 * to New Moon (angle=0), it reads the date display and computes a
 * meaningful starting position.
 *
 * @param {string} chatId
 * @returns {boolean} True on success
 */
/**
 * Regenerate moon phases from a date text input.
 * If dateText is provided, parses that text. Otherwise falls back to currentDay.dateDisplay.
 * This lets the user type any date/phase text in the regen popup instead of relying
 * on the existing date display (which may contain ambiguous era names).
 *
 * @param {string} chatId
 * @param {string} [dateText] - Optional custom date text. If omitted, reads from currentDay.dateDisplay.
 * @returns {boolean} True on success
 */
export async function regenerateMoonPhasesFromDate(chatId, dateText) {
    if (!chatId) return false;

    // Use provided text, or fall back to the stored date display
    const text = dateText || getCurrentDay(chatId)?.dateDisplay || '';

    if (!text) {
        nwstToast('No date text provided. Using stored angle.', 'warning');
        regenerateMoonPhasesOnly();
        return false;
    }

    // Compute angle from date text
    const angle = computeLunarAngleFromDate(text);
    await setLunarAngle(chatId, angle);

    // Generate new phases from this position (with phenomena computed at generation time)
    const currentDay = getCurrentDay(chatId);
    const cycleDays = getSetting('moonCycleDays') || 29.53;
    const phenOptions = {
        season: currentDay?.season || '',
        weatherToday: currentDay?.weatherToday || '',
        cycleDays
    };
    const newMoonPhases = generateMoonPhases(angle, 7, 0, phenOptions);
    await replaceMoonPhases(chatId, newMoonPhases);

    const phaseName = getMoonPhaseForAngle(angle).phaseName;
    nwstToast(`Moon phases regenerated from "${text}". Anchored as "${phaseName}" (${angle.toFixed(1)}°).`, 'success');

    return true;
}

/**
 * Get the available moon phase names (from the MOON_PHASES array).
 * Useful for building phase picker dropdowns in the UI.
 * @returns {string[]}
 */
export function getMoonPhaseNames() {
    return MOON_PHASES.map(p => p.name);
}


// ── Internal prompts (NOT user-editable) ──────────────────────────────────

const DAY_ADVANCEMENT_SYSTEM_PROMPT = `You are a day advancement assistant for a narrative roleplay. Your job is to advance the in-game date by ONE day and generate an updated 7-day weather forecast.

You will receive:
- The current date display and sub-date
- The setting context (world climate/geography description)
- The current 7-day forecast

Respond with a JSON object containing:
{
  "dateDisplay": "the new date display string (advance by one day)",
  "dateSub": "the sub-date string (era/year, unchanged unless a year boundary is crossed)",
  "season": "the current season (update if the day advancement crosses a seasonal boundary)",
  "forecast": [
    {
      "label": "Today",
      "icon": "emoji for weather",
      "description": "short weather description",
      "highF": number,
      "lowF": number,
      "highC": number,
      "lowC": number,
      "precipChance": number (0-100)
    },
    ... 7 entries total, shifted forward by one day
  ]
}

IMPORTANT: Write the date display and weather with atmospheric, narrative-appropriate detail. The forecast must be grounded in the setting context provided.

NOTE: Moon phases are calculated automatically by the system. Do NOT include moonPhases in the response.`;

/**
 * System prompt for forecast AND moon phases regeneration (no day advancement).
 * Used by the Forecast Regen button's "Both" option and to seed initial forecast after batch scan.
 */
const FORECAST_REGEN_SYSTEM_PROMPT = `You are a weather forecasting assistant for a narrative roleplay. Your job is to regenerate the 7-day weather forecast for the current in-game date.

You will receive:
- The current date display, sub-date, and season
- The setting context (world climate/geography description)
- The current 7-day forecast (may be empty if none exists yet)

Respond with a JSON object containing:
{
  "forecast": [
    {
      "label": "Today",
      "icon": "emoji for weather",
      "description": "short weather description",
      "highF": number,
      "lowF": number,
      "highC": number,
      "lowC": number,
      "precipChance": number (0-100)
    },
    ... 7 entries total
  ]
}

IMPORTANT: Do NOT change the date. Regenerate only the forecast. Write the forecast with atmospheric, narrative-appropriate detail grounded in the setting context.

NOTE: Moon phases are calculated automatically by the system. Do NOT include moonPhases in the response.`;

/**
 * System prompt for weather-ONLY regeneration.
 */
const FORECAST_ONLY_SYSTEM_PROMPT = `You are a weather forecasting assistant for a narrative roleplay. Your job is to regenerate ONLY the 7-day weather forecast for the current in-game date.

You will receive:
- The current date display, sub-date, and season
- The setting context (world climate/geography description)
- The current 7-day forecast (may be empty if none exists yet)

Respond with a JSON object containing:
{
  "forecast": [
    {
      "label": "Today",
      "icon": "emoji for weather",
      "description": "short weather description",
      "highF": number,
      "lowF": number,
      "highC": number,
      "lowC": number,
      "precipChance": number (0-100)
    },
    ... 7 entries total
  ]
}

IMPORTANT: Do NOT change the date. Regenerate ONLY the weather forecast. Write with atmospheric, narrative-appropriate detail grounded in the setting context.`;

// ── Forecast/Moon Regeneration (no day advancement) ────────────────────────

/**
 * Regenerate forecast and/or moon phases WITHOUT advancing the day.
 * Moon phases are calculated programmatically using real lunar cycle math
 * (~12.19° per day through the 8-phase cycle) — the LLM is only used for
 * creative weather text.
 *
 * @param {'all'|'forecast'|'moonPhases'} mode - What to regenerate
 * @returns {Promise<boolean>} True on success
 */
export async function regenerateForecast(mode = 'all') {
    const chatId = getChatId();
    if (!chatId) {
        nwstToast('No active chat detected.', 'error');
        return false;
    }

    showLoading(true);

    try {
        const currentDay = getCurrentDay(chatId);
        const settingContext = getSettingContext(chatId);
        const currentForecast = getForecast(chatId);
        const currentMoonPhases = getMoonPhases(chatId);

        // ── Moon phases are ALWAYS calculated programmatically ──────────
        if (mode === 'moonPhases' || mode === 'all') {
            let anchorAngle;

            // PRIORITY 1: Compute angle from the date display text (semantic parsing)
            // This is the "Regen from date" fix — reads "Seventh Day of the Waxing Moon"
            // or "11/7/1125" and computes a meaningful angle instead of defaulting to 0 (New Moon).
            if (currentDay?.dateDisplay) {
                anchorAngle = computeLunarAngleFromDate(currentDay.dateDisplay);
            }

            // PRIORITY 2: If date parsing returned 0 (no phase clues found),
            // fall back to the stored lunar angle
            if (anchorAngle === 0 || anchorAngle === undefined) {
                anchorAngle = getLunarAngle(chatId);
            }

            // PRIORITY 3: If stored angle is 0, try migrating from existing phase names
            if (anchorAngle === 0 && currentMoonPhases && currentMoonPhases.length > 0) {
                const computedAngle = getPhaseAngle(currentMoonPhases[0].phaseName);
                if (computedAngle !== 0) {
                    anchorAngle = computedAngle;
                }
            }

            // Normalize and store the computed angle
            anchorAngle = ((anchorAngle % 360) + 360) % 360;
            setLunarAngle(chatId, anchorAngle);

            const cycleDays = getSetting('moonCycleDays') || 29.53;
            const phenOptions = {
                season: currentDay?.season || '',
                weatherToday: currentDay?.weatherToday || '',
                cycleDays
            };
            const newMoonPhases = generateMoonPhases(anchorAngle, 7, 0, phenOptions);
            await replaceMoonPhases(chatId, newMoonPhases);
        }

        // ── Weather forecast is LLM-generated ──────────────────────────
        if (mode === 'forecast' || mode === 'all') {
            const profile = resolveProfile('dayAdvancementLLM');
            if (!profile) {
                throw new Error('No Day Advancement LLM connection profile configured. Set one in Settings.');
            }

            const systemPrompt = (mode === 'forecast')
                ? FORECAST_ONLY_SYSTEM_PROMPT
                : FORECAST_REGEN_SYSTEM_PROMPT;
            // Pass computed season so the LLM knows what season the system has determined
            const computedSeason = getComputedSeason(chatId);
            const userPrompt = buildForecastOnlyPrompt(currentDay, settingContext, currentForecast, computedSeason);

            const response = await callLLM(profile, systemPrompt, userPrompt);
            if (!response) {
                throw new Error('LLM returned empty response.');
            }

            const forecast = parseForecastOnlyField(response, 'forecast');
            if (!forecast || forecast.length === 0) {
                throw new Error('Failed to parse weather forecast from LLM response.');
            }
            await replaceForecast(chatId, forecast);
        }

        // ── Feedback ───────────────────────────────────────────────────
        if (mode === 'forecast') {
            nwstToast('Weather forecast regenerated.', 'success');
            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
        } else if (mode === 'moonPhases') {
            nwstToast('Moon phases regenerated (calculated from lunar cycle).', 'success');
        } else {
            nwstToast('Forecast regenerated. Moon phases recalculated from lunar cycle.', 'success');
            if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');
        }

        return true;

    } catch (err) {
        console.error('[NWST DayAdvancement] Regeneration failed:', err);
        nwstToast(`Regeneration failed: ${err.message}`, 'error');
        return false;
    } finally {
        showLoading(false);
    }
}

/**
 * Regenerate only the weather forecast (preserves existing moon phases).
 * @returns {Promise<boolean>}
 */
export async function regenerateForecastOnly() {
    return regenerateForecast('forecast');
}

/**
 * Regenerate only the moon phases (preserves existing weather forecast).
 * @returns {Promise<boolean>}
 */
export async function regenerateMoonPhasesOnly() {
    return regenerateForecast('moonPhases');
}

// ── Next Day ──────────────────────────────────────────────────────────────

/**
 * Advance the world by one day.
 * Calls Day Advancement LLM → saves results → triggers Current Day synthesis.
 *
 * @returns {Promise<boolean>} True on success, false on failure
 */
export async function advanceToNextDay() {
    const chatId = getChatId();
    if (!chatId) {
        nwstToast('No active chat detected.', 'error');
        return false;
    }

    // Show loading indicators
    showLoading(true);
    nwstToast('Generating forecast...', 'info');

    try {
        // 1. Resolve the Day Advancement LLM profile
        const profile = resolveProfile('dayAdvancementLLM');
        if (!profile) {
            throw new Error('No Day Advancement LLM connection profile configured. Set one in Settings.');
        }

        // 2. Gather current data AND save snapshot BEFORE any mutations.
        //    This preserves the pre-advancement state (forecast, moon phases,
        //    events with 'pending' status) so Restore Previous Day works correctly.
        const currentDay = getCurrentDay(chatId);
        const settingContext = getSettingContext(chatId);
        const currentForecast = getForecast(chatId);
        const currentMoonPhases = getMoonPhases(chatId);

        // ★ SNAPSHOT FIRST — capture pre-mutation state before anything changes
        await saveDayBoundarySnapshot(chatId);

        // Compute the next season (for the day we're advancing TO) so we can
        // inform the Day Advancement LLM what season the system has determined.
        // The LLM can then write weather/date context appropriate to that season.
        const nextDayCount = (currentDay.dayCount || 0) + 1;
        const seasonConfig = getSeasonConfig(chatId);
        const nextComputedSeason = computeSeason(nextDayCount, seasonConfig);

        // 3. Build the LLM prompt (moon phases excluded — calculated programmatically)
        const userPrompt = buildDayAdvancementPrompt(currentDay, settingContext, currentForecast, nextComputedSeason);

        // 4. Call the Day Advancement LLM
        const response = await callLLM(profile, DAY_ADVANCEMENT_SYSTEM_PROMPT, userPrompt);

        // 5. Parse the JSON response
        const result = parseDayAdvancementResponse(response);
        if (!result) {
            throw new Error('Failed to parse Day Advancement LLM response.');
        }

        // 6. Save the results (date + forecast from LLM)
        //    When the seasonal engine is active (mode 'auto' or 'static'), the
        //    computed season OVERRIDES whatever the LLM wrote for the season field.
        //    The LLM receives the computed season as context and writes evocative
        //    prose *about* that season — the engine is the authority.
        const newDayCount = (currentDay.dayCount || 0) + 1;
        // seasonConfig was already declared above — reuse it
        const computedSeason = computeSeason(newDayCount, seasonConfig);
        const finalSeason = computedSeason !== null ? computedSeason : (result.season || '');

        await updateCurrentDay(chatId, {
            dateDisplay: result.dateDisplay,
            dateSub: result.dateSub,
            season: finalSeason,
            dayCount: newDayCount
        });

        // ★ PRESERVE EXISTING FORECAST if LLM returned empty/invalid
        if (result.forecast && result.forecast.length > 0) {
            await replaceForecast(chatId, result.forecast);
        } else {
            console.warn('[NWST DayAdvancement] LLM returned empty/invalid forecast — preserving existing forecast');
            // keep existing forecast (snapshot already saved above)
        }

        // 7. Calculate moon phases programmatically with stored phenomena
        //    Advance the stored lunar angle by one day's progression,
        //    then generate the new 7-day view from that position.
        //    CRITICAL: Phenomena are NOW stored in the phase data (not computed at display time),
        //    so they persist across day advancements instead of being randomly reassigned.
        const currentAngle = getLunarAngle(chatId);
        const newAngle = (currentAngle + getDegreesPerDay()) % 360;

        // Read old moon phases to carry forward overlapping phenomena
        const oldMoonPhases = getMoonPhases(chatId);
        const cycleDays = getSetting('moonCycleDays') || 29.53;

        // Build phenomena options from current day context
        const phenOptions = {
            season: currentDay.season || '',
            weatherToday: currentDay.weatherToday || '',
            cycleDays
        };

        // ★ MIGRATION: Backfill phenomena for old phases that lack them.
        //    This handles pre-fix data where moon phases were stored without a `phenomena` field.
        //    Without this, carry-forward would find no phenomena to preserve.
        if (oldMoonPhases && oldMoonPhases.length > 0) {
            const degPerDay = getDegreesPerDay();
            oldMoonPhases.forEach((phase, idx) => {
                if (!phase.phenomena || !Array.isArray(phase.phenomena)) {
                    const phaseAngle = (currentAngle + idx * degPerDay) % 360;
                    phase.phenomena = getMoonPhenomena(phaseAngle, idx, cycleDays, phenOptions);
                }
            });
        }

        const newMoonPhases = generateMoonPhases(newAngle, 7, 0, phenOptions);

        // Carry forward phenomena for overlapping days:
        //   new Today (idx 0) ← old Day 2 (idx 1) phenomena
        //   new Day 2  (idx 1) ← old Day 3 (idx 2) phenomena
        //   ...
        //   new Day 6  (idx 5) ← old Day 7 (idx 6) phenomena
        //   new Day 7  (idx 6) — NO overlap, keeps freshly computed phenomena
        if (oldMoonPhases && oldMoonPhases.length >= 2) {
            const carryCount = Math.min(6, oldMoonPhases.length - 1);
            for (let i = 0; i < carryCount; i++) {
                const oldPhase = oldMoonPhases[i + 1];
                const newPhase = newMoonPhases[i];
                if (oldPhase && newPhase && oldPhase.phenomena && Array.isArray(oldPhase.phenomena)) {
                    // Preserve the old phenomena so Moonbows, Blood Moons, etc.
                    // don't get randomly reassigned on day advancement.
                    newPhase.phenomena = [...oldPhase.phenomena];
                }
            }
        }

        await replaceMoonPhases(chatId, newMoonPhases);
        setLunarAngle(chatId, newAngle);

        nwstToast('Forecast updated. Moon phases recalculated from lunar cycle.', 'success');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home');

        // 8. Trigger Current Day synthesis (via its own Planning LLM profile)
        nwstToast('Updating current day...', 'info');
        try {
            const { synthesizeCurrentDay } = await import('./currentDaySynth.js');
            // Do NOT pass profile — let synthesizeCurrentDay() use its own
            // default Planning LLM profile, which has the correct system prompt
            // for the markdown/JSON output format.
            await synthesizeCurrentDay(chatId);
        } catch (synthErr) {
            console.warn('[NWST DayAdvancement] Current Day synthesis failed (non-fatal):', synthErr);
        }

        // 9. Roll event horizon forward (mark missed, adjust tiers)
        //    This runs AFTER snapshot, so the saved snapshot still has 'pending' events.
        await rollEventHorizonForward(chatId);

        // 9.25 Materialize player-defined special days whose occurrence has
        //      come into range (entered the current calendar month, or is
        //      near-term). Structural, zero API calls; per-occurrence dedup
        //      means repeat runs create nothing. New events start in "This
        //      month" and the ladder walks them forward on later advances.
        try {
            const { materializeSpecialDays } = await import('../data/specialDays.js');
            const createdSpecial = await materializeSpecialDays(chatId);
            if (createdSpecial > 0) {
                dlog(`[NWST DayAdvancement] Materialized ${createdSpecial} special day event(s).`);
            }
        } catch (sdErr) {
            console.warn('[NWST DayAdvancement] Special day materialization failed (non-fatal):', sdErr);
        }

        // 9.5 Event validity review — the Planning LLM checks whether the story
        //     has made any surviving event's premise impossible or moot (e.g. a
        //     catalyst character permanently removed). Findings only FLAG events
        //     for the player's Keep / Mark-missed decision in the Events tab —
        //     nothing is removed automatically. Skips itself when there are no
        //     active events or the setting is off.
        await runEventValidityReview(chatId);

        // 10. Event Horizon Compaction — resolveDay-tracked events that were
        //     resolved/missed more than `eventCompactionThreshold` story days
        //     ago get compacted into the Notebook's `doNotForget` section as
        //     concise summaries, then removed from the active events array.
        //     This keeps the events list lean without losing narrative context.
        const compactionThreshold = getSetting('eventCompactionThreshold') ?? 3;
        const compactResult = await compactEventHorizon(chatId, compactionThreshold);
        if (compactResult.compacted > 0) {
            dlog(`[NWST DayAdvancement] Compacted ${compactResult.compacted} stale events.`);
        }

        // 11. World event top-up — if the active world event pool is thin after
        //     rolling forward, generate a small supplementary batch silently.
        //     This keeps world events populated without requiring manual regen.
        //     Fires asynchronously so it doesn't block the day advance completion.
        topUpWorldEvents(chatId).catch(e =>
            console.warn('[NWST DayAdvancement] World event top-up failed (non-fatal):', e)
        );

        nwstToast('Day advanced successfully.', 'success');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'events');
        return true;

    } catch (err) {
        console.error('[NWST DayAdvancement] Failed:', err);
        nwstToast(`Day advancement failed: ${err.message}`, 'error');
        return false;
    } finally {
        showLoading(false);
    }
}

// ── Previous Day ──────────────────────────────────────────────────────────

/**
 * Restore the previous day's state from the most recent snapshot.
 * NO API calls are made — this is a pure data restoration.
 *
 * @returns {Promise<boolean>} True on success
 */
/**
 * Restore state from a day-boundary snapshot.
 * If no snapshotKey is provided, restores the most recent snapshot.
 * @param {string} [snapshotKey] - Optional specific snapshot key to restore from
 * @returns {Promise<boolean>}
 */
export async function restorePreviousDay(snapshotKey) {
    const chatId = getChatId();
    if (!chatId) {
        nwstToast('No active chat detected.', 'error');
        return false;
    }

    let snapshot;
    if (snapshotKey) {
        const snapshots = getSnapshots(chatId);
        snapshot = snapshots[snapshotKey];
        if (!snapshot) {
            nwstToast(`Snapshot "${snapshotKey}" not found.`, 'error');
            return false;
        }
    } else {
        snapshot = getLatestSnapshot(chatId);
        if (!snapshot) {
            nwstToast('No previous day snapshot found. Nothing to restore.', 'warning');
            return false;
        }
    }

    try {
        // Restore world state
        if (snapshot.worldStateSnapshot) {
            const wsModule = await import('../data/worldState.js');
            await wsModule.saveWorldState(chatId, snapshot.worldStateSnapshot);
        }

        // Restore events
        if (snapshot.eventsSnapshot) {
            await saveAllEvents(chatId, snapshot.eventsSnapshot);
        }

        // Restore notebook
        if (snapshot.notebookSnapshot) {
            const nbModule = await import('../data/notebook.js');
            await nbModule.saveNotebook(chatId, snapshot.notebookSnapshot);
        }

        nwstToast('Previous day restored from snapshot.', 'info');
        if (typeof window?.nwstRefreshTabs === 'function') window.nwstRefreshTabs('home', 'events');
        return true;
    } catch (err) {
        console.error('[NWST DayAdvancement] Previous day restore failed:', err);
        nwstToast('Failed to restore previous day.', 'error');
        return false;
    }
}

// ── Prompt building ───────────────────────────────────────────────────────

function buildDayAdvancementPrompt(currentDay, settingContext, forecast, computedSeason) {
    let prompt = '';

    prompt += `Current Date Display: ${currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Sub-Date: ${currentDay.dateSub || '(not set)'}\n`;
    prompt += `Current Season: ${currentDay.season || '(not set)'}\n`;
    if (computedSeason) {
        prompt += `System-computed season for the next day: ${computedSeason}\n`;
    }
    prompt += '\n';

    if (settingContext) {
        prompt += `Setting Context (world climate/geography):\n${settingContext}\n\n`;
    }

    // Inject calendar config (months + week days) if configured
    const calConfig = getCalendarConfig(getChatId());
    if (calConfig.enabled) {
        const monthList = calConfig.monthNames.map((name, i) =>
            `${name} (${calConfig.monthDays[i]} days)`
        ).join(', ');
        const dayList = calConfig.weekDays.join(', ');
        prompt += `Calendar System:\n  Months (${calConfig.months} total): ${monthList}\n  Days of the week (${calConfig.weekDays.length} total): ${dayList}\n  Use these month and day names when generating or displaying dates.\n\n`;
    }

    prompt += `Current 7-Day Forecast:\n`;
    if (forecast.length > 0) {
        for (const day of forecast) {
            prompt += `  ${day.label}: ${day.description || ''} | High: ${day.highF}°F / ${day.highC}°C | Low: ${day.lowF}°F / ${day.lowC}°C | Precip: ${day.precipChance}% | Icon: ${day.icon}\n`;
        }
    } else {
        prompt += `  (no forecast data)\n`;
    }

    prompt += `\nAdvance the date by ONE day and generate the updated forecast. Moon phases are calculated automatically by the system. Respond with valid JSON only.`;

    return prompt;
}

/**
 * Build a prompt for regenerating ONLY the weather forecast.
 * Excludes moon phase data entirely.
 */
function buildForecastOnlyPrompt(currentDay, settingContext, forecast, computedSeason) {
    let prompt = '';

    prompt += `Current Date Display: ${currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Sub-Date: ${currentDay.dateSub || '(not set)'}\n`;
    prompt += `Current Season: ${currentDay.season || '(not set)'}\n`;
    if (computedSeason) {
        prompt += `System-computed current season: ${computedSeason}\n`;
    }
    prompt += '\n';

    if (settingContext) {
        prompt += `Setting Context (world climate/geography):\n${settingContext}\n\n`;
    }

    // Inject calendar config (months + week days) if configured
    const calConfig = getCalendarConfig(getChatId());
    if (calConfig.enabled) {
        const monthList = calConfig.monthNames.map((name, i) =>
            `${name} (${calConfig.monthDays[i]} days)`
        ).join(', ');
        const dayList = calConfig.weekDays.join(', ');
        prompt += `Calendar System:\n  Months (${calConfig.months} total): ${monthList}\n  Days of the week (${calConfig.weekDays.length} total): ${dayList}\n  Use these month and day names when generating or displaying dates.\n\n`;
    }

    prompt += `Current 7-Day Forecast:\n`;
    if (forecast && forecast.length > 0) {
        for (const day of forecast) {
            prompt += `  ${day.label}: ${day.description || ''} | High: ${day.highF}°F / ${day.highC}°C | Low: ${day.lowF}°F / ${day.lowC}°C | Precip: ${day.precipChance}% | Icon: ${day.icon}\n`;
        }
    } else {
        prompt += `  (no forecast data)\n`;
    }

    prompt += `\nRegenerate ONLY the 7-day weather forecast. Keep the same date. Respond with valid JSON containing only a "forecast" array.`;

    return prompt;
}

/**
 * Parse a single field from an LLM JSON response.
 * Works for both 'forecast' and 'moonPhases' fields.
 *
 * @param {string} response - Raw LLM response text
 * @param {'forecast'|'moonPhases'} fieldName - Which field to extract
 * @returns {Array|null} The parsed array, or null on failure
 */
function parseForecastOnlyField(response, fieldName) {
    if (!response || typeof response !== 'string') return null;

    let jsonStr = response.trim();

    // Remove markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
    }

    // Try to find a JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
        jsonStr = objMatch[0];
    }

    try {
        const parsed = JSON.parse(jsonStr);
        return Array.isArray(parsed[fieldName]) ? parsed[fieldName].slice(0, 7) : null;
    } catch (e) {
        console.error(`[NWST DayAdvancement] Parse ${fieldName} JSON error:`, e);
        dlog('Raw response:', response);
        return null;
    }
}

// ── LLM call ──────────────────────────────────────────────────────────────

async function callLLM(profile, systemPrompt, userPrompt) {
    // Build a minimal message array for the LLM call
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];

    // Use generateWithProfile to call the LLM via the connection profile
    // This uses the connection-manager's dedicated profile-aware request service,
    // which applies all profile settings (endpoint, key, model, preset) without
    // modifying any global ST state.
    const result = await generateWithProfile(profile, messages);

    return result || '';
}

// ── Response parsing ──────────────────────────────────────────────────────

function parseDayAdvancementResponse(response) {
    if (!response || typeof response !== 'string') return null;

    // Try to extract JSON from the response (may be wrapped in markdown or text)
    let jsonStr = response.trim();

    // Remove markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
    }

    // Try to find a JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
        jsonStr = objMatch[0];
    }

    try {
        const parsed = JSON.parse(jsonStr);

        // Validate required fields
        if (!parsed.dateDisplay) {
            console.warn('[NWST DayAdvancement] Response missing dateDisplay');
            return null;
        }

        return {
            dateDisplay: parsed.dateDisplay,
            dateSub: parsed.dateSub || '',
            season: parsed.season || '',
            forecast: Array.isArray(parsed.forecast) ? parsed.forecast.slice(0, 7) : []
        };
    } catch (e) {
        console.error('[NWST DayAdvancement] JSON parse error:', e);
        dlog('Raw response:', response);
        return null;
    }
}

// ── Event horizon roll ────────────────────────────────────────────────────

/**
 * Silently top up world events after day advancement if the pool is thin.
 * Fires asynchronously — does not block day advance completion.
 * Only generates world events (not NPC) and applies the world event cap (max 2 per tier).
 * Threshold: if fewer than 2 active world events remain, generate a top-up pass.
 *
 * @param {string} chatId
 */
async function topUpWorldEvents(chatId) {
    try {
        const { getActiveEvents } = await import('../data/events.js');
        const activeEvents = getActiveEvents(chatId);

        // Count active world events (non-NPC)
        const activeWorldEvents = activeEvents.filter(e =>
            !e.isNPC &&
            e.status !== 'missed' &&
            e.status !== 'resolved'
        );

        // Check per-tier: immediate events were just rolled (marked missed),
        // so the immediate tier is almost certainly empty. Generate fresh
        // immediate events if that tier is empty, regardless of total pool size.
        const immediateWorldEvents = activeWorldEvents.filter(e => e.tier === 'immediate');
        const weekWorldEvents = activeWorldEvents.filter(e => e.tier === 'week');

        dlog(`[NWST DayAdvancement] World event pool: ${activeWorldEvents.length} active (immediate: ${immediateWorldEvents.length}, week: ${weekWorldEvents.length})`);

        // Import and call event gen for world events only
        const { regenerateTierEvents } = await import('./eventGen.js');

        // ★ Always top up the immediate tier if it's empty — day advancement
        //    rolls immediate events as missed, so a fresh batch is expected.
        if (immediateWorldEvents.length < 1) {
            dlog('[NWST DayAdvancement] Immediate tier empty — generating fresh batch...');
            await regenerateTierEvents('immediate');
        }

        // ★ Top up the week tier if it's empty (less aggressive — week events
        //    survive day advancement, so they only need filling when genuinely thin).
        if (weekWorldEvents.length < 1) {
            dlog('[NWST DayAdvancement] Week tier empty — generating fresh batch...');
            await regenerateTierEvents('week');
        }

        if (typeof window?.nwstRefreshTabs === 'function') {
            window.nwstRefreshTabs('home', 'events');
        }

        dlog('[NWST DayAdvancement] World event top-up complete.');
    } catch (e) {
        console.warn('[NWST DayAdvancement] topUpWorldEvents error:', e);
    }
}

async function rollEventHorizonForward(chatId) {
    // Structural event-horizon roll. Date-parseable events move between tiers on
    // schedule; undated events are handled by the Planning LLM instead (the
    // recurring scan's eventUpdates and the day-advance event review), so
    // nothing here guesses at narrative urgency.
    const events = getAllEvents(chatId);
    const currentDay = getCurrentDay(chatId);
    const dayCount = currentDay.dayCount || 0;
    const calendarConfig = getCalendarConfig(chatId); // Needed for literal date parsing
    const changes = {};

    // Anchored week math: weekday #1 is weekDays[0] and the current week ends
    // on weekday #N (N = weekDays.length, config-driven — not hardcoded to 7).
    // startWeekday says which weekday story Day 1 fell on (config, default 1),
    // so the weekday of any day number is pure arithmetic — no boundary
    // tracking, no drift.
    const weekLength = (calendarConfig && Array.isArray(calendarConfig.weekDays) && calendarConfig.weekDays.length > 0)
        ? calendarConfig.weekDays.length : 7;
    const startWeekday = (calendarConfig && Number.isInteger(calendarConfig.startWeekday) && calendarConfig.startWeekday >= 1)
        ? ((calendarConfig.startWeekday - 1) % weekLength) + 1 : 1;
    const weekdayToday = ((dayCount - 1 + (startWeekday - 1)) % weekLength) + 1;
    const weekEndDay = dayCount + (weekLength - weekdayToday);

    for (const event of events) {
        if (event.status !== 'pending') continue;
        // Events awaiting a player decision are left untouched so the roll
        // cannot preempt a Keep / Mark-missed / Promote / Timing choice.
        if (event.validityFlag || event.promotionFlag || event.timingFlag) continue;

        const range = getScheduledDayRange(event.scheduledDate, calendarConfig);

        if (!range) {
            // Undated: only the daily-expiry rule applies — an undated
            // immediate event that didn't happen today is missed. Undated
            // week/month events are aged by the LLM review instead.
            if (event.tier === 'immediate') changes[event.id] = 'missed';
            continue;
        }

        // Undetermined is a protected tier — deliberately timeless. Events
        // leave it only by the player's hand or by concluding. A dated
        // undetermined event whose window objectively passed still goes
        // missed (a status change), but it is never re-tiered.
        if (event.tier === 'undetermined') {
            if (dayCount > range.endDay) changes[event.id] = 'missed';
            continue;
        }

        // Dated: full anchored placement ladder.
        let target;
        if (dayCount > range.endDay) {
            target = 'missed';        // window came and went
        } else if (range.startDay - dayCount <= 1) {
            // Today or tomorrow — distance-based on purpose, so a "tomorrow"
            // event never hides behind a week boundary.
            target = 'immediate';
        } else if (range.startDay <= weekEndDay) {
            target = 'week';          // before this weekday cycle ends
        } else {
            target = 'month';         // beyond this week
        }

        if (target === 'missed') changes[event.id] = 'missed';
        else if (event.tier !== target) changes[event.id] = target;
    }

    if (Object.keys(changes).length > 0) {
        await rollEventHorizon(chatId, changes);
        dlog(`[NWST DayAdvancement] Event horizon roll applied ${Object.keys(changes).length} change(s).`);
    }
}

/**
 * Parse a scheduledDate string into story-day numbers where possible.
 * Handles "Day 12", "Day 10-14" ranges, and literal calendar dates via
 * computeDayOfYearFromDate(). Returns { startDay, endDay } or null when the
 * format is unrecognisable — those events are left to the LLM review passes.
 *
 * @param {string} scheduledDate
 * @param {object|null} calendarConfig
 * @returns {{startDay:number, endDay:number}|null}
 */
function getScheduledDayRange(scheduledDate, calendarConfig) {
    if (!scheduledDate || typeof scheduledDate !== 'string') return null;

    const rangeMatch = scheduledDate.match(/Day\s*(\d+)\s*[-–]\s*(\d+)/i);
    if (rangeMatch) {
        return { startDay: parseInt(rangeMatch[1], 10), endDay: parseInt(rangeMatch[2], 10) };
    }

    const dayMatch = scheduledDate.match(/Day\s*(\d+)/i);
    if (dayMatch) {
        const d = parseInt(dayMatch[1], 10);
        return { startDay: d, endDay: d };
    }

    if (calendarConfig) {
        const dayOfYear = computeDayOfYearFromDate(scheduledDate, calendarConfig);
        if (dayOfYear !== null && dayOfYear > 0) {
            return { startDay: dayOfYear, endDay: dayOfYear };
        }
    }

    return null;
}

/**
 * Check if a scheduledDate string refers to a day in the future, relative to
 * the current dayCount.
 *
 * Parses the primary "Day #" format (e.g. "Day 105", "Day 14").
 * For other formats (e.g. "Month 3/15"), returns false — the event will
 * be subject to normal rolling since we can't reliably compare without
 * full calendar config context.
 *
 * @param {string} scheduledDate - Free-form date string from the event
 * @param {number} currentDayCount - The current story day number
 * @returns {boolean} true if the event is scheduled for a future day
 */
// ── Snapshot ──────────────────────────────────────────────────────────────

async function saveDayBoundarySnapshot(chatId) {
    try {
        const worldState = getWorldState(chatId);
        const events = getAllEvents(chatId);
        const notebook = getNotebook(chatId);

        // Use a simple timestamp-based key for day boundary snapshots
        const rangeKey = `day_${Date.now()}`;
        await saveSnapshot(chatId, rangeKey, worldState, events, notebook);
        dlog('[NWST DayAdvancement] Day boundary snapshot saved.');
    } catch (e) {
        console.warn('[NWST DayAdvancement] Failed to save snapshot:', e);
    }
}

// ── Loading UI helpers ────────────────────────────────────────────────────

function showLoading(show) {
    // Update forecast and moon phase strips with spinner
    const forecastStrip = document.getElementById('nwst-forecast-strip');
    const moonStrip = document.getElementById('nwst-moon-strip');

    if (show) {
        if (forecastStrip) forecastStrip.classList.add('nwst-loading');
        if (moonStrip) moonStrip.classList.add('nwst-loading');
    } else {
        if (forecastStrip) forecastStrip.classList.remove('nwst-loading');
        if (moonStrip) moonStrip.classList.remove('nwst-loading');
    }
}
