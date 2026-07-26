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
import { getSettingContext, getCurrentDay, updateCurrentDay,
         getForecast, replaceForecast, getMoonPhases, replaceMoonPhases,
         saveSnapshot, getLatestSnapshot, getSnapshots, getWorldState,
         getSeasonConfig, getCalendarConfig, getEraPin,
         getExtraMoons, saveExtraMoons } from '../data/worldState.js';
import { computeDeterministicDate, advanceCurrentCalendarDate, applyForecastLabelsFromWeekday, parseCurrentCalendarDate, weekdayIndexFromDisplay, wrapDayCount, extractYearFromText, dateFromDayCount, resolveScheduledElapsedWindow, addDaysToDate, daysBetweenCalendarDates } from '../lib/calendarMath.js';
import { getAllEvents, saveAllEvents, rollEventHorizon, compactEventHorizon, classifyScheduledEventTier } from '../data/events.js';
import { runEventValidityReview } from './eventValidity.js';
import { getNotebook } from '../data/notebook.js';
import { resolveProfile, generateWithProfile } from './connections.js';
import { LLM_TOKEN_BUDGETS } from './tokenBudgets.js';
import { dlog } from "../lib/debug.js";
import { getMoonConfig, getMoonPhenomenonOverrides, getOverrideDisplayLabel } from '../data/moons.js';
import { ensureNagerHolidayCacheForCurrentWindow } from '../data/nagerDate.js';
import { prepareSevereWeatherAdvance, commitPreparedWeather, formatSystemConstraint, getSevereWeatherConstraint, getWeatherProfileForecastContext } from '../data/severeWeather.js';


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
export function getDegreesPerDay(chatId = getChatId()) {
    const cycleDays = getMoonConfig(chatId).moonCycleDays || 29.53058867;
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
 * Build the shared context used by moon-phenomenon generation.
 * Calendar parsing is intentionally centralized so Blue Moon detection uses
 * the active NWST calendar instead of guessing from prose.
 *
 * @param {string} chatId
 * @param {object|null} [dayOverride]
 * @param {object} [overrides]
 * @returns {object}
 */
export function buildMoonPhenomenaOptions(chatId, dayOverride = null, overrides = {}) {
    const day = dayOverride || getCurrentDay(chatId) || {};
    const calendarConfig = getCalendarConfig(chatId);
    const dmy = getSetting('dateFormatDMY') === true;
    const baseCalendarDate = parseCurrentCalendarDate(
        day.dateDisplay || '',
        day.dateSub || '',
        calendarConfig,
        dmy
    );

    return {
        season: day.season || '',
        weatherToday: day.weatherToday || '',
        forecast: getForecast(chatId) || [],
        cycleDays: getMoonConfig(chatId).moonCycleDays || 29.53058867,
        calendarConfig,
        baseCalendarDate,
        moonId: 'primary',
        chatId,
        enableMoonPhenomena: getMoonConfig(chatId).enableMoonPhenomena !== false,
        manualOverrides: getMoonPhenomenonOverrides(chatId),
        ...overrides
    };
}

/**
 * Normalize stored phenomenon labels from older builds.
 * Removed culture-specific labels are dropped, Lunar Ring is renamed, and a
 * legacy standalone Blood Moon is discarded unless a total lunar eclipse is
 * explicitly present.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeMoonPhenomena(value, options = {}) {
    if (!Array.isArray(value)) return [];

    const normalized = [];
    for (const raw of value) {
        if (typeof raw !== 'string') continue;
        if (raw === '🌾 Harvest Moon' || raw === '🏹 Hunter Moon') continue;
        if (raw === '☀️ Solar Eclipse' || raw === '🌑 Lunar Eclipse') continue;
        const label = raw === '🌙 Lunar Ring' ? '🌙 Lunar Halo' : raw;
        if (!normalized.includes(label)) normalized.push(label);
    }

    const hasTotalLunarEclipse = normalized.includes('🌑 Total Lunar Eclipse');
    return (hasTotalLunarEclipse || options.allowStandaloneBloodMoon === true)
        ? normalized
        : normalized.filter(label => label !== '🌕 Blood Moon');
}

/**
 * Generate moon phase entries for a range of days, optionally computing phenomena.
 * Phenomena are stored at generation time so they remain stable across renders.
 *
 * @param {number} anchorAngle - Starting lunar angle in degrees
 * @param {number} [numDays=7] - Number of days to generate
 * @param {number} [startOffset=0] - Day offset from anchor
 * @param {object|null} [phenomenaOptions=null] - Context from buildMoonPhenomenaOptions()
 * @param {number|null} [cycleDaysOverride=null] - Per-moon cycle override
 * @returns {object[]} Array of { label, icon, phaseName, phenomena? }
 */
export function generateMoonPhases(anchorAngle, numDays = 7, startOffset = 0, phenomenaOptions = null, cycleDaysOverride = null) {
    const labels = ['Today', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'];
    const cycleDays = (Number(cycleDaysOverride) > 0)
        ? Number(cycleDaysOverride)
        : (Number(phenomenaOptions?.cycleDays) > 0 ? Number(phenomenaOptions.cycleDays) : 29.53058867);
    const degPerDay = 360 / cycleDays;
    const phases = [];

    for (let i = 0; i < numDays; i++) {
        const dayOffset = startOffset + i;
        const angle = anchorAngle + dayOffset * degPerDay;
        const { phaseName, icon } = getMoonPhaseForAngle(angle);
        const entry = {
            label: labels[i] || `Day ${i + 1}`,
            icon,
            phaseName
        };

        if (phenomenaOptions) {
            const calendarDate = phenomenaOptions.baseCalendarDate && phenomenaOptions.calendarConfig
                ? addDaysToDate(phenomenaOptions.baseCalendarDate, dayOffset, phenomenaOptions.calendarConfig)
                : null;
            const forecastEntry = Array.isArray(phenomenaOptions.forecast)
                ? phenomenaOptions.forecast[i]
                : null;
            const weatherForDay = forecastEntry?.description
                || forecastEntry?.weather
                || (i === 0 ? phenomenaOptions.weatherToday : '')
                || phenomenaOptions.weatherToday
                || '';

            const dayOptions = {
                ...phenomenaOptions,
                anchorAngle,
                dayOffset,
                calendarDate,
                weatherToday: weatherForDay
            };
            entry.phenomena = getMoonPhenomena(angle, dayOffset, cycleDays, dayOptions);
            const manual = applyManualMoonOverrides(entry.phenomena, dayOptions);
            entry.phenomena = normalizeMoonPhenomena(entry.phenomena, {
                allowStandaloneBloodMoon: manual.labels.includes('🌕 Blood Moon')
            });
            if (manual.labels.length > 0) entry.manualPhenomena = manual.labels;
            if (Object.keys(manual.details).length > 0) entry.phenomenaDetails = manual.details;
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
    const cycleDays = getMoonConfig(getChatId()).moonCycleDays || 29.53058867;

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
 * Compute the current season name from the cyclical calendar day and season config.
 *
 * Modes:
 *   'auto'     — cycles through the configured season map using 1-based cyclical dayCount
 *   'static'   — always returns the first season name (for timeless settings)
 *   'disabled' — returns null (seasons are entirely LLM-controlled, legacy behavior)
 *
 * @param {number} dayCount - 1-based cyclical position within the current calendar year
 * @param {object} seasonConfig - Per-chat season configuration { mode, yearLength, seasons[] }
 * @returns {string|null} The computed season name, or null if disabled
 */
export function computeSeason(dayCount, seasonConfig) {
    if (!seasonConfig || seasonConfig.mode === 'disabled') return null;
    if (seasonConfig.mode === 'static') {
        return seasonConfig.seasons?.[0]?.name || null;
    }
    // dayCount is already the 1-based cyclical position inside the current
    // calendar year. Do not modulo it again: that would turn a leap-year Day
    // 366 into Day 1 when the season map is configured for a 365-day base year.
    // Clamp only as a defensive fallback for a calendar/season-length mismatch.
    // Wrap-around season bands (e.g. Winter 334 -> 58) are supported directly.
    const yearLength = seasonConfig.yearLength || 365;
    const rawDay = Math.max(1, Math.trunc(dayCount) || 1);
    const dayOfYear = Math.min(rawDay, yearLength);
    const seasons = seasonConfig.seasons || [];
    for (const s of seasons) {
        const start = Math.max(1, Number(s.startDay) || 1);
        const end = Math.max(1, Number(s.endDay) || 1);
        const inRange = start <= end
            ? (dayOfYear >= start && dayOfYear <= end)
            : (dayOfYear >= start || dayOfYear <= end);
        if (inRange) return s.name;
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
export function getConfiguredMoons(chatId = getChatId()) {
    const config = getMoonConfig(chatId);
    if (config.enableMoons === false) return [];
    const moons = Array.isArray(config.moons) ? config.moons : [];
    if (moons.length > 0) return moons.filter(m => m.enabled !== false);
    return [{ id: 'primary', name: 'The Moon', cycleDays: config.moonCycleDays || 29.53058867, enabled: true }];
}

/**
 * Regenerate the state of every configured moon beyond the first. The primary
 * moon keeps the legacy single-moon pipeline (lunarAngle + moonPhases)
 * untouched; extras each carry their own angle and 7-day phase strip,
 * advanced by their own cycle length.
 *
 * daysDelta: how many story days to advance each extra moon (0 = recompute
 * phases from the stored angle without advancing — used by regen paths).
 * A moon not seen before is seeded deterministically from the day counter,
 * so two moons with different cycles start at sensibly different phases.
 * Failures never break the caller — the primary moon is unaffected.
 *
 * @param {string} chatId
 * @param {number} daysDelta
 * @param {object|null} phenBase - Base phenomena options (season/weather); per-moon cycleDays is applied here
 */
export async function refreshExtraMoons(chatId, daysDelta = 0, phenBase = null) {
    try {
        const moons = getConfiguredMoons(chatId);
        const extrasCfg = moons.slice(1);
        const stored = getExtraMoons(chatId);
        if (extrasCfg.length === 0) {
            // Config shrank back to one (or zero) moons — clear stale extras
            if (stored.length > 0) await saveExtraMoons(chatId, []);
            return;
        }
        const day = getCurrentDay(chatId);
        const dayCount = (day && typeof day.dayCount === 'number') ? day.dayCount : 0;
        const out = [];
        for (let i = 0; i < extrasCfg.length; i++) {
            const cfg = extrasCfg[i];
            const id = cfg.id || `moon_idx_${i + 1}`;
            const cycle = (Number(cfg.cycleDays) > 0) ? Number(cfg.cycleDays) : 29.53058867;
            const degPerDay = 360 / cycle;
            const prev = stored.find(x => x && x.id === id);
            let angle;
            if (prev && Number.isFinite(prev.angle)) {
                angle = ((prev.angle + (daysDelta || 0) * degPerDay) % 360 + 360) % 360;
            } else {
                angle = ((dayCount * degPerDay) % 360 + 360) % 360;
            }
            const phen = phenBase ? { ...phenBase, cycleDays: cycle, moonId: id, moonName: cfg.name || 'Moon' } : null;
            const phases = generateMoonPhases(angle, 7, 0, phen, cycle);
            out.push({ id, name: cfg.name || 'Moon', cycleDays: cycle, angle, phases });
        }
        await saveExtraMoons(chatId, out);
    } catch (err) {
        console.warn('[NWST DayAdvancement] Extra-moon refresh failed (primary moon unaffected):', err);
    }
}

/**
 * Return the shortest angular distance between two lunar angles.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function moonAngularDistance(a, b) {
    const diff = (((a - b) % 360) + 540) % 360 - 180;
    return Math.abs(diff);
}

/**
 * A phase peak is represented by the single forecast day mathematically
 * closest to the exact alignment. This prevents a broad 3-4 day phase label
 * from rolling the same rare phenomenon several times.
 */
function isMoonAlignmentPeak(angle, targetAngle, cycleDays) {
    const degPerDay = 360 / Math.max(1, Number(cycleDays) || 29.53058867);
    const tolerance = Math.min(22.5, degPerDay / 2 + 0.000001);
    return moonAngularDistance(angle, targetAngle) <= tolerance;
}

/** Stable FNV-1a hash converted to a 0-1 roll. */
function deterministicMoonRoll(key) {
    let hash = 0x811c9dc5;
    const text = String(key);
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) / 0x100000000;
}

function moonPhenomenonRoll(angle, dayIndex, cycleDays, salt, options = {}) {
    const date = options.calendarDate;
    const dateKey = date
        ? `${date.year}:${date.month}:${date.day}`
        : `angle:${Math.round((((angle % 360) + 360) % 360) * 1000)}:day:${dayIndex}`;
    const moonKey = options.moonId || options.moonName || 'primary';
    return deterministicMoonRoll(`${moonKey}|${Number(cycleDays).toFixed(6)}|${dateKey}|${salt}`);
}

function hasAnyKeyword(text, keywords) {
    return keywords.some(keyword => text.includes(keyword));
}

function weightedMoonChoice(candidates, roll) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const total = candidates.reduce((sum, item) => sum + item.weight, 0);
    let cursor = roll * total;
    for (const item of candidates) {
        cursor -= item.weight;
        if (cursor <= 0) return item.label;
    }
    return candidates[candidates.length - 1].label;
}

/**
 * Calendar Blue Moon detection: the current day must be the second (or later)
 * mathematically detected full-moon peak in the same active calendar month.
 * No RNG is involved.
 */
function isCalendarBlueMoon(angle, cycleDays, options = {}) {
    if (!isMoonAlignmentPeak(angle, 180, cycleDays)) return false;

    const currentDate = options.calendarDate;
    const baseDate = options.baseCalendarDate;
    const calendarConfig = options.calendarConfig;
    if (!currentDate || !baseDate || !calendarConfig) return false;

    const monthStart = { year: currentDate.year, month: currentDate.month, day: 1 };
    const firstOffset = daysBetweenCalendarDates(baseDate, monthStart, calendarConfig);
    const currentOffset = Number.isInteger(options.dayOffset)
        ? options.dayOffset
        : daysBetweenCalendarDates(baseDate, currentDate, calendarConfig);
    if (!Number.isInteger(firstOffset) || !Number.isInteger(currentOffset) || firstOffset > currentOffset) {
        return false;
    }

    const anchorAngle = Number.isFinite(Number(options.anchorAngle))
        ? Number(options.anchorAngle)
        : angle - currentOffset * (360 / cycleDays);
    const degPerDay = 360 / cycleDays;
    let fullMoonPeaks = 0;

    for (let offset = firstOffset; offset <= currentOffset; offset++) {
        const testAngle = anchorAngle + offset * degPerDay;
        if (isMoonAlignmentPeak(testAngle, 180, cycleDays)) fullMoonPeaks++;
    }

    return fullMoonPeaks >= 2;
}

function isDateWithinOverride(calendarDate, override, calendarConfig) {
    if (!calendarDate || !override?.startDate || !override?.endDate || !calendarConfig) return false;
    const fromStart = daysBetweenCalendarDates(override.startDate, calendarDate, calendarConfig);
    const fullSpan = daysBetweenCalendarDates(override.startDate, override.endDate, calendarConfig);
    return Number.isInteger(fromStart) && Number.isInteger(fullSpan) && fullSpan >= 0 && fromStart >= 0 && fromStart <= fullSpan;
}

function applyManualMoonOverrides(phenomena, options = {}) {
    const overrides = Array.isArray(options.manualOverrides) ? options.manualOverrides : [];
    const details = {};
    const labels = [];
    for (const override of overrides) {
        if (!override || override.enabled === false) continue;
        if (override.moonId && override.moonId !== 'all' && override.moonId !== (options.moonId || 'primary')) continue;
        if (!isDateWithinOverride(options.calendarDate, override, options.calendarConfig)) continue;
        const label = getOverrideDisplayLabel(override);
        if (!label) continue;
        if (!phenomena.includes(label)) phenomena.push(label);
        if (!labels.includes(label)) labels.push(label);
        if (override.description) details[label] = override.description;
    }
    return { details, labels };
}

/**
 * Detect rare visible moon phenomena for a given day.
 *
 * Rules:
 * - Orbital phenomena and eclipses roll only on the single day closest to the
 *   exact new/full alignment.
 * - Blue Moon is calendar-detected, never randomly assigned.
 * - Eclipse type is chosen by a deterministic sub-roll.
 * - Blood Moon appears only with a total lunar eclipse.
 * - At most one weather-optics phenomenon is selected per day.
 * - All rolls are deterministic for the moon/date so regeneration is stable.
 *
 * @param {number} angle - Lunar angle in degrees (may be unwrapped)
 * @param {number} dayIndex - Relative day offset
 * @param {number} cycleDays - Length of this moon's cycle in days
 * @param {object} [options]
 * @returns {string[]}
 */
export function getMoonPhenomena(angle, dayIndex, cycleDays, options = {}) {
    if (options.enableMoonPhenomena === false || getMoonConfig(options.chatId || getChatId()).enableMoonPhenomena === false) return [];

    const normalized = ((angle % 360) + 360) % 360;
    const phenomena = [];
    const isFullPeak = isMoonAlignmentPeak(angle, 180, cycleDays);
    const isNewPeak = isMoonAlignmentPeak(angle, 0, cycleDays);
    const isWaxingCrescent = normalized >= 22.5 && normalized < 67.5;
    const isWaningCrescent = normalized >= 292.5 && normalized < 337.5;
    const isCrescent = isWaxingCrescent || isWaningCrescent;
    const isBrightMoon = normalized >= 112.5 && normalized <= 247.5;
    const isVisibleMoon = normalized >= 22.5 && normalized < 337.5;

    // ── Calendar and orbital full-moon phenomena ──────────────────
    if (isFullPeak) {
        if (isCalendarBlueMoon(angle, cycleDays, options)) {
            phenomena.push('🔵 Blue Moon');
        }

        // Mutually exclusive simulated perigee/apogee appearance.
        const distanceRoll = moonPhenomenonRoll(angle, dayIndex, cycleDays, 'distance-class', options);
        if (distanceRoll < 0.08) {
            phenomena.push('🌕 Super Moon');
        } else if (distanceRoll < 0.14) {
            phenomena.push('🌕 Micro Moon');
        }
    }

    // ── Solar eclipse + subtype (single New Moon peak only) ───────
    if (isNewPeak && moonPhenomenonRoll(angle, dayIndex, cycleDays, 'solar-eclipse-trigger', options) < 0.018) {
        const subtype = moonPhenomenonRoll(angle, dayIndex, cycleDays, 'solar-eclipse-subtype', options);
        if (subtype < 0.35) {
            phenomena.push('☀️ Partial Solar Eclipse');
        } else if (subtype < 0.68) {
            phenomena.push('☀️ Annular Solar Eclipse');
        } else if (subtype < 0.95) {
            phenomena.push('☀️ Total Solar Eclipse');
        } else {
            phenomena.push('☀️ Hybrid Solar Eclipse');
        }
    }

    // ── Lunar eclipse + subtype (single Full Moon peak only) ──────
    if (isFullPeak && moonPhenomenonRoll(angle, dayIndex, cycleDays, 'lunar-eclipse-trigger', options) < 0.018) {
        const subtype = moonPhenomenonRoll(angle, dayIndex, cycleDays, 'lunar-eclipse-subtype', options);
        if (subtype < 0.45) {
            phenomena.push('🌑 Penumbral Lunar Eclipse');
        } else if (subtype < 0.80) {
            phenomena.push('🌑 Partial Lunar Eclipse');
        } else {
            phenomena.push('🌑 Total Lunar Eclipse');
            phenomena.push('🌕 Blood Moon');
        }
    }

    const weather = String(options.weatherToday || '').toLowerCase();
    const obscuredWeather = hasAnyKeyword(weather, ['overcast', 'heavy rain', 'downpour', 'blizzard', 'whiteout', 'dense fog']);
    const wetWeather = hasAnyKeyword(weather, ['rain', 'shower', 'drizzle', 'mist', 'spray', 'waterfall', 'humid', 'wet']);
    const thinCloudWeather = hasAnyKeyword(weather, ['thin cloud', 'high cloud', 'cirrus', 'wispy', 'partly cloudy', 'fair clouds', 'haze', 'mist', 'humid']);
    const iceCrystalWeather = hasAnyKeyword(weather, ['cirrus', 'ice crystal', 'frost', 'freezing', 'cold', 'crisp', 'snow', 'wintry']);
    const horizonTintWeather = hasAnyKeyword(weather, ['haze', 'smoke', 'dust', 'mist', 'humid', 'pollution', 'smog', 'fog']);

    // ── Earthshine: crescent moon, clear enough to see the dark face ─
    if (isCrescent && !obscuredWeather
        && moonPhenomenonRoll(angle, dayIndex, cycleDays, 'earthshine', options) < 0.025) {
        phenomena.push('🌘 Earthshine');
    }

    // ── One atmospheric-optics phenomenon at most per day ─────────
    const opticalCandidates = [];
    if (isBrightMoon && wetWeather) {
        opticalCandidates.push({ label: '🌌 Moonbow', weight: 10 });
    }
    if (isBrightMoon && thinCloudWeather) {
        opticalCandidates.push({ label: '🌈 Lunar Corona', weight: 24 });
    }
    if (isBrightMoon && thinCloudWeather) {
        opticalCandidates.push({ label: '🌙 Lunar Halo', weight: 26 });
    }
    if (isBrightMoon && thinCloudWeather && iceCrystalWeather) {
        opticalCandidates.push({ label: '✨ Moondogs', weight: 8 });
    }
    if (isBrightMoon && iceCrystalWeather) {
        opticalCandidates.push({ label: '🕯️ Moon Pillar', weight: 7 });
    }
    if (isBrightMoon && horizonTintWeather) {
        opticalCandidates.push({ label: '🟠 Amber Moonrise', weight: 15 });
    }

    if (opticalCandidates.length > 0
        && moonPhenomenonRoll(angle, dayIndex, cycleDays, 'optical-trigger', options) < 0.025) {
        const label = weightedMoonChoice(
            opticalCandidates,
            moonPhenomenonRoll(angle, dayIndex, cycleDays, 'optical-subtype', options)
        );
        if (label) phenomena.push(label);
    }

    // Moon illusion is common in reality but intentionally rare as a forecast
    // tag so it remains notable rather than appearing every bright-moon week.
    if (isBrightMoon && !obscuredWeather
        && moonPhenomenonRoll(angle, dayIndex, cycleDays, 'moon-illusion', options) < 0.010) {
        phenomena.push('🌕 Moon Illusion');
    }

    // Occultations are positional events rather than weather effects.
    if (isVisibleMoon
        && moonPhenomenonRoll(angle, dayIndex, cycleDays, 'lunar-occultation', options) < 0.003) {
        phenomena.push('✨ Lunar Occultation');
    }

    return normalizeMoonPhenomena(phenomena);
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

    // Compute phenomena in context of the active calendar and forecast.
    const cycleDays = getMoonConfig(chatId).moonCycleDays || 29.53058867;
    const phenOptions = buildMoonPhenomenaOptions(chatId, null, { cycleDays });
    const newMoonPhases = generateMoonPhases(angle, 7, 0, phenOptions);
    await replaceMoonPhases(chatId, newMoonPhases);
    // Recompute extra moons' strips from their stored angles (no advance)
    await refreshExtraMoons(chatId, 0, phenOptions);

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
        return await regenerateMoonPhasesOnly();
    }

    // Compute angle from date text
    const angle = computeLunarAngleFromDate(text);
    await setLunarAngle(chatId, angle);

    // Generate new phases from this position using calendar-aware phenomena.
    const cycleDays = getMoonConfig(chatId).moonCycleDays || 29.53058867;
    const phenOptions = buildMoonPhenomenaOptions(chatId, null, { cycleDays });
    const newMoonPhases = generateMoonPhases(angle, 7, 0, phenOptions);
    await replaceMoonPhases(chatId, newMoonPhases);
    // Recompute extra moons' strips from their stored angles (no advance)
    await refreshExtraMoons(chatId, 0, phenOptions);

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
 * Deterministic-date variant: used when a Starting Date anchor exists. The
 * system computes the new date itself — the LLM only supplies the era label
 * (cultural knowledge like "Meiji 12" that pure math can't know) plus the
 * forecast. It never writes the date, so it can never mangle it.
 */
const DAY_ADVANCEMENT_DETERMINISTIC_SYSTEM_PROMPT = `You are a day advancement assistant for a narrative roleplay. The system has ALREADY computed the new date deterministically. Your job is ONLY to provide the era label and an updated 7-day weather forecast.

You will receive:
- The system-computed new date (authoritative — do not alter or restate it differently)
- The previous era/sub-date line
- The setting context (world climate/geography description)
- The current 7-day forecast

Respond with a JSON object containing:
{
  "dateSub": "era context for the computed date, in whatever era system fits the SETTING — e.g. 'Reiwa 8', 'Kank\u014d 4', 'Tang Dynasty \u00b7 Kaiyuan 5', 'Reign of Augustus \u00b7 Year 12', 'Victorian Era', 'Umayyad Caliphate \u00b7 97 AH', '1st Century BC'. Keep the previous era label unless the computed date crosses an era boundary. Use an empty string if no era system applies to this setting.",
  "season": "the current season for the computed date",
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

IMPORTANT: Do NOT include a dateDisplay field — the date is system-computed. Write the weather with atmospheric, narrative-appropriate detail grounded in the setting context.

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
            await setLunarAngle(chatId, anchorAngle);

            const cycleDays = getMoonConfig(chatId).moonCycleDays || 29.53058867;
            const phenOptions = buildMoonPhenomenaOptions(chatId, currentDay, { cycleDays });
            const newMoonPhases = generateMoonPhases(anchorAngle, 7, 0, phenOptions);
            await replaceMoonPhases(chatId, newMoonPhases);
            // Recompute extra moons' strips from their stored angles (no advance)
            await refreshExtraMoons(chatId, 0, phenOptions);
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
            const weatherProfileContext = getWeatherProfileForecastContext(chatId);
            const weatherConstraint = getSevereWeatherConstraint(chatId, currentDay?.elapsedStoryDays || 0);
            const userPrompt = buildForecastOnlyPrompt(currentDay, settingContext, currentForecast, computedSeason, weatherConstraint, weatherProfileContext);

            const response = await callLLM(profile, systemPrompt, userPrompt);
            if (!response) {
                throw new Error('LLM returned empty response.');
            }

            let forecast = parseForecastOnlyField(response, 'forecast');
            if (!forecast || forecast.length === 0) {
                throw new Error('Failed to parse weather forecast from LLM response.');
            }
            // If the current LLM-written date exposes one of the configured
            // weekdays, keep regenerated forecast labels on that same custom
            // weekday cycle. This is independent of Starting Date setup.
            const calCfgFc = getCalendarConfig(chatId);
            const currentWeekdayIndex = weekdayIndexFromDisplay(currentDay?.dateDisplay || '', calCfgFc);
            if (Number.isInteger(currentWeekdayIndex)) {
                forecast = applyForecastLabelsFromWeekday(forecast, currentWeekdayIndex, calCfgFc);
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

        // Calendar position is cyclical and comes from the configured calendar.
        // elapsedStoryDays is a separate duration counter and never drives the
        // calendar. When the current LLM-written date can be parsed, advance the
        // actual calendar date directly by one configured day.
        const seasonConfig = getSeasonConfig(chatId);
        const calendarConfig = getCalendarConfig(chatId);
        const eraPin = !calendarConfig.enabled ? getEraPin(chatId) : '';
        const dmy = getSetting('dateFormatDMY') === true;
        const detDate = advanceCurrentCalendarDate(currentDay, 1, calendarConfig, dmy);
        const currentYear = parseCurrentCalendarDate(currentDay.dateDisplay || '', currentDay.dateSub || '', calendarConfig, dmy)?.year
            ?? extractYearFromText(currentDay.dateSub || '')
            ?? extractYearFromText(currentDay.dateDisplay || '')
            ?? 1;
        const nextDayCount = detDate
            ? detDate.dayOfYear
            : wrapDayCount((currentDay.dayCount || 0) + 1, calendarConfig, currentYear);
        const nextComputedSeason = computeSeason(nextDayCount, seasonConfig);
        const newElapsedStoryDays = (Number.isInteger(currentDay.elapsedStoryDays) ? currentDay.elapsedStoryDays : 0) + 1;

        // Severe weather is decided BEFORE the forecast LLM call, but not persisted
        // until the day advancement succeeds. This prevents failed API calls from
        // advancing the weather simulation without advancing the story date.
        const preparedWeather = prepareSevereWeatherAdvance(chatId, {
            targetElapsedDay: newElapsedStoryDays,
            season: nextComputedSeason || currentDay.season || '',
            dayCount: nextDayCount,
        });
        const preparedProfile = preparedWeather?.state?.profiles?.find(p => p.id === preparedWeather.state.activeProfileId) || null;
        const weatherConstraint = preparedWeather?.system
            ? formatSystemConstraint(preparedWeather.system, newElapsedStoryDays, preparedProfile)
            : '';

        // 3. Build the LLM prompt (moon phases excluded — calculated programmatically)
        const weatherProfileContext = getWeatherProfileForecastContext(chatId);
        const userPrompt = buildDayAdvancementPrompt(currentDay, settingContext, currentForecast, nextComputedSeason, detDate, eraPin, weatherConstraint, weatherProfileContext);

        // 4. Call the Day Advancement LLM
        const systemPrompt = detDate ? DAY_ADVANCEMENT_DETERMINISTIC_SYSTEM_PROMPT : DAY_ADVANCEMENT_SYSTEM_PROMPT;
        const response = await callLLM(profile, systemPrompt, userPrompt);

        // 5. Parse the JSON response
        const result = parseDayAdvancementResponse(response, !!detDate);
        if (!result) {
            throw new Error('Failed to parse Day Advancement LLM response.');
        }

        // Deterministic mode: the code-computed date is authoritative. The LLM
        // contributes only the era label; if it gave none, fall back to the
        // code-computed era line (custom calendar eraName or Gregorian century).
        if (detDate) {
            result.dateDisplay = detDate.dateDisplay;
            // Era precedence: a custom calendar with an Era name is fully
            // player-authored — the code's era line wins and the LLM cannot
            // override it. Real-world calendars take the LLM's cultural label
            // first, falling back to the code-computed century.
            const codeEraWins = calendarConfig.enabled && (calendarConfig.eraName || '').trim();
            const llmEra = (typeof result.dateSub === 'string') ? result.dateSub.trim() : '';
            const legacyEra = computeDeterministicDate(detDate.date, nextDayCount, nextDayCount, calendarConfig).eraSub || '';
            result.dateSub = codeEraWins ? legacyEra : (llmEra || legacyEra);
            // Forecast weekday labels advance on the configured weekday cycle,
            // independent of the annual dayCount reset.
            result.forecast = applyForecastLabelsFromWeekday(result.forecast, detDate.weekdayIndex, calendarConfig);
        }

        // 6. Save the results (date + forecast from LLM)
        //    When the seasonal engine is active (mode 'auto' or 'static'), the
        //    computed season OVERRIDES whatever the LLM wrote for the season field.
        //    The LLM receives the computed season as context and writes evocative
        //    prose *about* that season — the engine is the authority.
        const newDayCount = nextDayCount;
        // seasonConfig was already declared above — reuse it. nextComputedSeason
        // was computed from the cyclical calendar position for this same day.
        const computedSeason = nextComputedSeason;
        const finalSeason = computedSeason !== null ? computedSeason : (result.season || '');

        await updateCurrentDay(chatId, {
            dateDisplay: result.dateDisplay,
            dateSub: result.dateSub,
            season: finalSeason,
            dayCount: newDayCount,
            elapsedStoryDays: newElapsedStoryDays
        });

        await commitPreparedWeather(chatId, preparedWeather);
        if (preparedWeather?.toast) nwstToast(preparedWeather.toast, preparedWeather.system?.source === 'override' ? 'info' : 'warning');

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
        const newAngle = (currentAngle + getDegreesPerDay(chatId)) % 360;

        // Read old moon phases to carry forward overlapping phenomena
        const oldMoonPhases = getMoonPhases(chatId);
        const cycleDays = getMoonConfig(chatId).moonCycleDays || 29.53;

        // Build calendar-aware phenomena options from the newly saved day and
        // forecast, not the stale pre-advancement Current Day.
        const updatedDay = getCurrentDay(chatId);
        const effectiveForecast = (result.forecast && result.forecast.length > 0)
            ? result.forecast
            : currentForecast;
        const phenOptions = buildMoonPhenomenaOptions(chatId, updatedDay, {
            cycleDays,
            forecast: effectiveForecast
        });

        // ★ MIGRATION: backfill old entries without phenomenon arrays and
        // normalize deprecated labels before carry-forward.
        if (oldMoonPhases && oldMoonPhases.length > 0) {
            const regeneratedOld = generateMoonPhases(currentAngle, oldMoonPhases.length, 0, {
                ...phenOptions,
                baseCalendarDate: parseCurrentCalendarDate(
                    currentDay.dateDisplay || '',
                    currentDay.dateSub || '',
                    getCalendarConfig(chatId),
                    getSetting('dateFormatDMY') === true
                ),
                forecast: currentForecast
            });
            oldMoonPhases.forEach((phase, idx) => {
                if (!Array.isArray(phase.phenomena)) {
                    const regenerated = regeneratedOld[idx] || {};
                    phase.phenomena = regenerated.phenomena || [];
                    if (Array.isArray(regenerated.manualPhenomena)) phase.manualPhenomena = [...regenerated.manualPhenomena];
                    if (regenerated.phenomenaDetails && typeof regenerated.phenomenaDetails === 'object') {
                        phase.phenomenaDetails = { ...regenerated.phenomenaDetails };
                    }
                } else {
                    const manualLabels = Array.isArray(phase.manualPhenomena) ? phase.manualPhenomena : [];
                    phase.phenomena = normalizeMoonPhenomena(phase.phenomena, {
                        allowStandaloneBloodMoon: manualLabels.includes('🌕 Blood Moon')
                    });
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
                    // Preserve normalized stored phenomena so rare events stay
                    // stable while removed/renamed legacy labels do not linger.
                    const manualLabels = Array.isArray(oldPhase.manualPhenomena) ? oldPhase.manualPhenomena : [];
                    newPhase.phenomena = normalizeMoonPhenomena(oldPhase.phenomena, {
                        allowStandaloneBloodMoon: manualLabels.includes('🌕 Blood Moon')
                    });
                    if (manualLabels.length > 0) newPhase.manualPhenomena = [...manualLabels];
                    if (oldPhase.phenomenaDetails && typeof oldPhase.phenomenaDetails === 'object') {
                        newPhase.phenomenaDetails = { ...oldPhase.phenomenaDetails };
                    }
                }
            }
        }

        await replaceMoonPhases(chatId, newMoonPhases);
        await setLunarAngle(chatId, newAngle);

        // Every additional configured moon advances by one day of its OWN cycle
        await refreshExtraMoons(chatId, 1, phenOptions);

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

        // 9.3 Real-world holiday cache. Failed requests remain uncached by
        // design, so the next story-day advancement retries automatically.
        // Near New Year this may fetch both years so the 7-day prompt window
        // can see early-January holidays while the story is still in December.
        try {
            const holidayResult = await ensureNagerHolidayCacheForCurrentWindow(chatId);
            if (!holidayResult.ok && holidayResult.failedYears?.length) {
                nwstToast(`Nager.Date holiday fetch failed for ${holidayResult.failedYears.join(', ')}. NWST will retry on the next story-day advance. Check F12 for details.`, 'error');
            } else if (holidayResult.fetchedYears?.length) {
                dlog(`[NWST Nager.Date] Cached holiday data for ${holidayResult.fetchedYears.join(', ')}.`);
            }
        } catch (holidayErr) {
            console.error('[NWST Nager.Date] Holiday refresh failed:', holidayErr);
            nwstToast('Nager.Date holiday fetch failed. NWST will retry on the next story-day advance. Check F12 for details.', 'error');
        }

        // 9.5 Event validity review — the Planning LLM checks whether the story
        //     has made any surviving event's premise impossible or moot (e.g. a
        //     catalyst character permanently removed). Findings only FLAG events
        //     for the player's Keep / Mark-resolved / Mark-missed decision in the Events tab —
        //     nothing is removed automatically. Skips itself when there are no
        //     active events or the setting is off.
        await runEventValidityReview(chatId);

        // 10. Event Horizon Compaction — elapsed-duration-tracked events that were
        //     resolved/missed more than `eventCompactionThreshold` story days
        //     ago get compacted into the Notebook's `doNotForget` section as
        //     concise summaries, then removed from the active events array.
        //     This keeps the events list lean without losing narrative context.
        const compactionThreshold = getSetting('eventCompactionThreshold') ?? 0;
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

        // Restore the manually selected context/weather regions when the
        // snapshot recorded them. Older snapshots simply omit these fields.
        if (snapshot.activeSettingContextProfileId) {
            try {
                const { setActiveSettingContextProfile } = await import('../data/worldState.js');
                await setActiveSettingContextProfile(chatId, snapshot.activeSettingContextProfileId);
            } catch (e) { console.warn('[NWST DayAdvancement] Could not restore Setting Context profile:', e); }
        }
        if (snapshot.weatherSimulationSnapshot) {
            try {
                const { getWeatherProfilesState, saveWeatherProfilesState } = await import('../data/severeWeather.js');
                const weather = getWeatherProfilesState(chatId);
                const snapWeather = snapshot.weatherSimulationSnapshot;
                if (snapWeather.activeProfileId && weather.profiles.some(p => p.id === snapWeather.activeProfileId)) {
                    weather.activeProfileId = snapWeather.activeProfileId;
                }
                for (const saved of (snapWeather.profileStates || [])) {
                    const profile = weather.profiles.find(p => p.id === saved.id);
                    if (!profile) continue;
                    profile.activeSystem = saved.activeSystem || null;
                    profile.history = Array.isArray(saved.history) ? saved.history : [];
                }
                await saveWeatherProfilesState(chatId, weather);
            } catch (e) { console.warn('[NWST DayAdvancement] Could not restore severe-weather simulation state:', e); }
        } else if (snapshot.activeWeatherProfileId) {
            try {
                const { setActiveWeatherProfile } = await import('../data/severeWeather.js');
                await setActiveWeatherProfile(chatId, snapshot.activeWeatherProfileId);
            } catch (e) { console.warn('[NWST DayAdvancement] Could not restore Weather Profile:', e); }
        }

        // Older snapshots predate elapsedStoryDays and elapsed event markers.
        // Normalize immediately after restoration so rewinding into legacy data
        // cannot reset duration bookkeeping or leave dayCount monotonic.
        const { migrateEventData } = await import('../data/events.js');
        await migrateEventData(chatId);
        const { migrateTemporalState } = await import('../data/timeMigration.js');
        await migrateTemporalState(chatId);

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

function buildDayAdvancementPrompt(currentDay, settingContext, forecast, computedSeason, detDate = null, eraPin = '', weatherConstraint = '', weatherProfileContext = '') {
    let prompt = '';

    prompt += `Current Date Display: ${currentDay.dateDisplay || '(not set)'}\n`;
    prompt += `Sub-Date: ${currentDay.dateSub || '(not set)'}\n`;
    if (detDate) {
        prompt += `System-computed NEW date (authoritative): ${detDate.dateDisplay}\n`;
        prompt += `Provide the dateSub era label for this new date, using whatever era system fits the setting (any culture or period). Previous era line: "${currentDay.dateSub || '(none)'}" — keep it unless the new date crosses an era boundary; empty string if no era system applies.\n`;
        if (eraPin) {
            prompt += `PLAYER-VERIFIED ERA: the player manually confirmed the era system ("${eraPin}"). The previous era line descends from that confirmation — do NOT replace it with a different era system. Maintain it: update era-relative year numbers as years roll (e.g. era-year 4 becomes era-year 5 at a new year), and change the era name only at a genuine historical boundary within the same system.\n`;
        }
    }
    prompt += `Current Season: ${currentDay.season || '(not set)'}\n`;
    if (computedSeason) {
        prompt += `System-computed season for the next day: ${computedSeason}\n`;
    }
    prompt += '\n';

    if (settingContext) {
        prompt += `Setting Context (world climate/geography):\n${settingContext}\n\n`;
    }
    if (weatherProfileContext) {
        prompt += `${weatherProfileContext}\n\n`;
    }
    if (weatherConstraint) {
        prompt += `${weatherConstraint}\n\n`;
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

    if (detDate) {
        prompt += `\nThe new date is already computed above — do NOT generate a dateDisplay. Provide the dateSub era label and the updated forecast. Moon phases are calculated automatically by the system. Respond with valid JSON only.`;
    } else {
        prompt += `\nAdvance the date by ONE day and generate the updated forecast. Moon phases are calculated automatically by the system. Respond with valid JSON only.`;
    }

    return prompt;
}

/**
 * Build a prompt for regenerating ONLY the weather forecast.
 * Excludes moon phase data entirely.
 */
function buildForecastOnlyPrompt(currentDay, settingContext, forecast, computedSeason, weatherConstraint = '', weatherProfileContext = '') {
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
    if (weatherProfileContext) {
        prompt += `${weatherProfileContext}\n\n`;
    }
    if (weatherConstraint) {
        prompt += `${weatherConstraint}\n\n`;
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
    const result = await generateWithProfile(profile, messages, { maxTokens: LLM_TOKEN_BUDGETS.HEAVY });

    return result || '';
}

// ── Response parsing ──────────────────────────────────────────────────────

function parseDayAdvancementResponse(response, deterministic = false) {
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

        // Validate required fields. In deterministic mode the date is
        // system-computed and the LLM is told NOT to send one — its absence
        // is correct, and the caller overwrites dateDisplay regardless.
        if (!parsed.dateDisplay && !deterministic) {
            console.warn('[NWST DayAdvancement] Response missing dateDisplay');
            return null;
        }

        return {
            dateDisplay: parsed.dateDisplay || '',
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
    // Structural event-horizon roll. Calendar position is cyclical; one-time
    // event occurrence windows are stored in elapsedStoryDays so an annual
    // date does not silently roll forward to next year's occurrence after it
    // passes. Duration bookkeeping never drives the calendar itself.
    const events = getAllEvents(chatId);
    const currentDay = getCurrentDay(chatId);
    const elapsedStoryDays = Number.isInteger(currentDay.elapsedStoryDays) ? currentDay.elapsedStoryDays : 0;
    const calendarConfig = getCalendarConfig(chatId);
    const changes = {};

    for (const event of events) {
        if (event.status !== 'pending') continue;
        if (event.validityFlag || event.promotionFlag || event.timingFlag) continue;

        const range = getScheduledElapsedRange(event, calendarConfig, currentDay);

        if (!range) {
            if (event.tier === 'immediate') changes[event.id] = 'missed';
            continue;
        }

        if (event.tier === 'undetermined') {
            if (elapsedStoryDays > range.endElapsed) changes[event.id] = 'missed';
            continue;
        }

        const target = classifyScheduledEventTier(chatId, range.startElapsed, range.endElapsed) || event.tier;

        if (target === 'missed') changes[event.id] = 'missed';
        else if (event.tier !== target) changes[event.id] = target;
    }

    if (Object.keys(changes).length > 0) {
        await rollEventHorizon(chatId, changes);
        dlog(`[NWST DayAdvancement] Event horizon roll applied ${Object.keys(changes).length} change(s).`);
    }
}

/**
 * Resolve an event's schedule to a one-time elapsed-story-day window.
 * New and migrated events carry scheduledElapsedStart/End. The fallback below
 * keeps manually imported/legacy events usable until migration stamps them.
 */
function getScheduledElapsedRange(event, calendarConfig, currentDay) {
    if (!event || !event.scheduledDate) return null;
    if (typeof event.scheduledElapsedStart === 'number') {
        return {
            startElapsed: event.scheduledElapsedStart,
            endElapsed: typeof event.scheduledElapsedEnd === 'number' ? event.scheduledElapsedEnd : event.scheduledElapsedStart
        };
    }

    const elapsed = Number.isInteger(currentDay?.elapsedStoryDays) ? currentDay.elapsedStoryDays : 0;
    const currentDOY = Number.isInteger(currentDay?.dayCount) && currentDay.dayCount > 0 ? currentDay.dayCount : 1;
    const parsedDate = parseCurrentCalendarDate(currentDay?.dateDisplay || '', currentDay?.dateSub || '', calendarConfig, getSetting('dateFormatDMY') === true);
    const year = parsedDate?.year ?? extractYearFromText(currentDay?.dateSub || '') ?? extractYearFromText(currentDay?.dateDisplay || '') ?? 1;
    const currentDate = parsedDate || dateFromDayCount(currentDOY, year, calendarConfig);
    const resolved = resolveScheduledElapsedWindow(
        event.scheduledDate, currentDate, currentDOY, elapsed, calendarConfig
    );
    if (!resolved) return null;
    return { startElapsed: resolved.start, endElapsed: resolved.end };
}

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
