/* eslint-disable */
// =============================================================================
// NWST Nager.Date holiday integration — data/nagerDate.js
// =============================================================================
// Optional real-world holiday layer for Gregorian-compatible calendars.
//
// Design rules:
// - Configuration and raw holiday cache live inside per-chat calendarConfig.
// - Renamed Gregorian calendars may use Nager.Date; structurally non-Gregorian
//   calendars never call it.
// - Raw data is cached once per country + year. Region/type filters are applied
//   locally so changing filters does not cause another network request.
// - Prompt injection is synchronous and cache-only. Network fetches happen when
//   settings are saved, after warmup establishes a date, and when story time
//   advances (day advance / time skip).
// - A failed fetch is NOT cached. The next story-day advancement therefore
//   retries automatically until data is obtained.
// =============================================================================

import { getCalendarConfig, saveCalendarConfig, getCurrentDay } from './worldState.js';
import { parseCurrentCalendarDate, addDaysToDate, daysBetweenCalendarDates, monthNamesFor, isGregorianCompatibleCalendar } from '../lib/calendarMath.js';

export const NAGER_HOLIDAY_TYPES = ['Public', 'Bank', 'School', 'Authorities', 'Optional', 'Observance'];
export const NAGER_DEFAULT_UPCOMING_DAYS = 7;

const API_BASE = 'https://date.nager.at/api/v3/PublicHolidays';

function normalizeCode(value) {
    return String(value || '').trim().toUpperCase();
}

function parseIsoHolidayDate(value) {
    const match = String(value || '').match(/^(-?\d{1,6})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isInteger(year) || year === 0 || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    return { year, month, day };
}

function currentStoryDate(chatId, calendarConfig = null) {
    const cfg = calendarConfig || getCalendarConfig(chatId);
    if (!isGregorianCompatibleCalendar(cfg)) return null;
    const day = getCurrentDay(chatId);
    if (!day) return null;
    // Deterministic real-world displays normally parse identically either way.
    // Trying both keeps numeric legacy dates compatible with the user's D/M/Y
    // preference without importing global UI settings into this data module.
    return parseCurrentCalendarDate(day.dateDisplay || '', day.dateSub || '', cfg, false)
        || parseCurrentCalendarDate(day.dateDisplay || '', day.dateSub || '', cfg, true);
}

export function isNagerDateAvailable(calendarConfig) {
    return !!calendarConfig && isGregorianCompatibleCalendar(calendarConfig);
}

export function getNagerDateConfig(chatId) {
    const cfg = getCalendarConfig(chatId);
    return cfg.nagerDate || {};
}

function cacheKey(countryCode, year) {
    return `${normalizeCode(countryCode)}:${year}`;
}

function getCachedBucket(calendarConfig, countryCode, year) {
    const cache = calendarConfig?.nagerDate?.cache;
    if (!cache || typeof cache !== 'object') return null;
    const bucket = cache[cacheKey(countryCode, year)];
    return bucket && Array.isArray(bucket.holidays) ? bucket : null;
}

function normalizeHoliday(raw) {
    const date = String(raw?.date || '').trim();
    if (!parseIsoHolidayDate(date)) return null;

    // Web API v3 uses `types`, `counties`, and `global`. Keep accepting the
    // v4 names too so any already-normalized/cached holiday objects remain
    // readable if a user upgrades from an earlier NWST Nager.Date build.
    const rawTypes = Array.isArray(raw?.types)
        ? raw.types
        : (Array.isArray(raw?.holidayTypes) ? raw.holidayTypes : []);
    const holidayTypes = rawTypes.filter(type => NAGER_HOLIDAY_TYPES.includes(type));

    const rawSubdivisions = Array.isArray(raw?.counties)
        ? raw.counties
        : (Array.isArray(raw?.subdivisionCodes) ? raw.subdivisionCodes : []);
    const subdivisionCodes = rawSubdivisions.map(normalizeCode).filter(Boolean);

    const nationalHoliday = typeof raw?.global === 'boolean'
        ? raw.global
        : raw?.nationalHoliday === true;

    return {
        date,
        name: String(raw?.name || 'Holiday').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160),
        countryCode: normalizeCode(raw?.countryCode),
        subdivisionCodes,
        nationalHoliday,
        holidayTypes: holidayTypes.length > 0 ? holidayTypes : ['Public']
    };
}

/**
 * Fetch one country/year bucket if it is not already cached.
 * Failed responses are intentionally left uncached so the next story-day
 * advancement retries automatically.
 */
export async function fetchNagerHolidayYear(chatId, year) {
    const cfg = getCalendarConfig(chatId);
    const nager = cfg.nagerDate || {};
    const countryCode = normalizeCode(nager.countryCode);

    if (!isNagerDateAvailable(cfg) || nager.enabled !== true) {
        return { ok: true, skipped: true, reason: 'disabled', year };
    }
    if (!/^([A-Z]{2})$/.test(countryCode)) {
        return { ok: false, skipped: true, reason: 'country', year, error: new Error('A valid 2-letter country code is required.') };
    }
    if (!Number.isInteger(year) || year === 0) {
        return { ok: false, skipped: true, reason: 'year', year, error: new Error('The current story year could not be determined.') };
    }

    const key = cacheKey(countryCode, year);
    if (getCachedBucket(cfg, countryCode, year)) {
        return { ok: true, cached: true, year, key };
    }

    try {
        // Supported Web API v3 route is /PublicHolidays/{year}/{countryCode}.
        const response = await fetch(`${API_BASE}/${encodeURIComponent(year)}/${encodeURIComponent(countryCode)}`, {
            method: 'GET',
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) {
            throw new Error(`Nager.Date returned HTTP ${response.status} ${response.statusText || ''}`.trim());
        }

        const payload = await response.json();
        if (!Array.isArray(payload)) throw new Error('Nager.Date returned an unexpected response shape.');
        const holidays = payload.map(normalizeHoliday).filter(Boolean);

        // Re-read before saving so unrelated settings edits made while the
        // request was in flight are preserved.
        const latest = getCalendarConfig(chatId);
        const latestNager = latest.nagerDate || {};
        if (normalizeCode(latestNager.countryCode) !== countryCode) {
            return { ok: true, skipped: true, reason: 'country-changed', year };
        }
        latestNager.cache = (latestNager.cache && typeof latestNager.cache === 'object') ? latestNager.cache : {};
        latestNager.cache[key] = {
            countryCode,
            year,
            fetchedAt: new Date().toISOString(),
            holidays
        };
        latest.nagerDate = latestNager;
        await saveCalendarConfig(chatId, latest);

        return { ok: true, fetched: true, year, key, count: holidays.length };
    } catch (error) {
        console.error(`[NWST Nager.Date] Failed to fetch ${countryCode} holidays for ${year}:`, error);
        return { ok: false, year, key, error };
    }
}

/**
 * Ensure the raw holiday cache covers today's prompt horizon. Normally this is
 * one year; near New Year it may fetch both the current and following year so
 * a Jan 1 holiday can begin injecting while the story is still in December.
 */
export async function ensureNagerHolidayCacheForCurrentWindow(chatId) {
    const cfg = getCalendarConfig(chatId);
    const nager = cfg.nagerDate || {};
    if (!isNagerDateAvailable(cfg) || nager.enabled !== true) {
        return { ok: true, skipped: true, reason: 'disabled', fetchedYears: [], cachedYears: [], failedYears: [] };
    }

    const currentDate = currentStoryDate(chatId, cfg);
    if (!currentDate) {
        return { ok: true, skipped: true, reason: 'no-date', fetchedYears: [], cachedYears: [], failedYears: [] };
    }

    const horizon = Number.isInteger(nager.upcomingDays)
        ? Math.max(0, Math.min(30, nager.upcomingDays))
        : NAGER_DEFAULT_UPCOMING_DAYS;
    const endDate = addDaysToDate(currentDate, horizon, cfg);
    const years = [...new Set([currentDate.year, endDate.year])];
    const fetchedYears = [];
    const cachedYears = [];
    const failedYears = [];

    for (const year of years) {
        const result = await fetchNagerHolidayYear(chatId, year);
        if (result.fetched) fetchedYears.push(year);
        else if (result.cached) cachedYears.push(year);
        else if (!result.ok && result.reason !== 'country' && result.reason !== 'year') failedYears.push(year);
        else if (!result.ok) failedYears.push(year);
    }

    return {
        ok: failedYears.length === 0,
        currentDate,
        endDate,
        fetchedYears,
        cachedYears,
        failedYears
    };
}

function holidayMatchesFilters(holiday, nager) {
    const selectedTypes = Array.isArray(nager.holidayTypes) && nager.holidayTypes.length > 0
        ? nager.holidayTypes
        : ['Public'];
    if (!holiday.holidayTypes.some(type => selectedTypes.includes(type))) return false;

    const subdivision = normalizeCode(nager.subdivisionCode);
    if (!subdivision) {
        // No subdivision selected means country-wide holidays only; otherwise a
        // user in one region would see every regional holiday in the country.
        return holiday.nationalHoliday === true || holiday.subdivisionCodes.length === 0;
    }

    return holiday.nationalHoliday === true
        || holiday.subdivisionCodes.length === 0
        || holiday.subdivisionCodes.includes(subdivision);
}

function holidaysInWindow(chatId, maxDays) {
    const cfg = getCalendarConfig(chatId);
    const nager = cfg.nagerDate || {};
    if (!isNagerDateAvailable(cfg) || nager.enabled !== true) return [];

    const currentDate = currentStoryDate(chatId, cfg);
    if (!currentDate) return [];
    const horizon = Math.max(0, Math.min(30, Number.isInteger(maxDays) ? maxDays : NAGER_DEFAULT_UPCOMING_DAYS));
    const endDate = addDaysToDate(currentDate, horizon, cfg);
    const years = [...new Set([currentDate.year, endDate.year])];
    const results = [];

    for (const year of years) {
        const bucket = getCachedBucket(cfg, nager.countryCode, year);
        if (!bucket) continue;
        for (const holiday of bucket.holidays) {
            if (!holidayMatchesFilters(holiday, nager)) continue;
            const date = parseIsoHolidayDate(holiday.date);
            if (!date) continue;
            const delta = daysBetweenCalendarDates(currentDate, date, cfg);
            if (!Number.isInteger(delta) || delta < 0 || delta > horizon) continue;
            results.push({ ...holiday, dateParts: date, daysAway: delta });
        }
    }

    const seen = new Set();
    return results
        .sort((a, b) => a.daysAway - b.daysAway || a.name.localeCompare(b.name))
        .filter(holiday => {
            const key = `${holiday.date}\u0000${holiday.name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

export function getNagerHolidaysForCurrentDate(chatId) {
    const cfg = getCalendarConfig(chatId);
    const nager = cfg.nagerDate || {};
    if (nager.showOnCalendar !== true) return [];
    return holidaysInWindow(chatId, 0);
}

export function getNagerSubdivisionOptions(chatId) {
    const cfg = getCalendarConfig(chatId);
    const nager = cfg.nagerDate || {};
    const currentDate = currentStoryDate(chatId, cfg);
    if (!currentDate) return [];
    const bucket = getCachedBucket(cfg, nager.countryCode, currentDate.year);
    if (!bucket) return [];
    const codes = new Set();
    for (const holiday of bucket.holidays) {
        for (const code of holiday.subdivisionCodes || []) codes.add(normalizeCode(code));
    }
    return [...codes].filter(Boolean).sort();
}

export function getNagerCacheStatus(chatId) {
    const cfg = getCalendarConfig(chatId);
    const nager = cfg.nagerDate || {};
    const currentDate = currentStoryDate(chatId, cfg);
    if (!currentDate) return { currentDate: null, currentYearCached: false, cachedYears: [] };
    const prefix = `${normalizeCode(nager.countryCode)}:`;
    const cache = nager.cache && typeof nager.cache === 'object' ? nager.cache : {};
    const cachedYears = Object.keys(cache)
        .filter(key => key.startsWith(prefix))
        .map(key => Number(key.slice(prefix.length)))
        .filter(Number.isInteger)
        .sort((a, b) => a - b);
    return {
        currentDate,
        currentYearCached: !!getCachedBucket(cfg, nager.countryCode, currentDate.year),
        cachedYears
    };
}

function formatHolidayDate(dateParts, cfg) {
    const names = monthNamesFor(cfg);
    const month = names[dateParts.month - 1] || `Month ${dateParts.month}`;
    return `${month} ${dateParts.day}`;
}

/**
 * Cache-only holiday block for the main prompt. Holidays enter context exactly
 * `upcomingDays` before their scheduled date (default 7), including today.
 */
export function buildNagerHolidayPromptBlock(chatId) {
    const cfg = getCalendarConfig(chatId);
    const nager = cfg.nagerDate || {};
    if (!isNagerDateAvailable(cfg) || nager.enabled !== true || nager.includeInPrompt !== true) return '';

    const horizon = Number.isInteger(nager.upcomingDays)
        ? Math.max(0, Math.min(30, nager.upcomingDays))
        : NAGER_DEFAULT_UPCOMING_DAYS;
    const holidays = holidaysInWindow(chatId, horizon);
    if (holidays.length === 0) return '';

    const today = holidays.filter(h => h.daysAway === 0);
    const upcoming = holidays.filter(h => h.daysAway > 0);
    const lines = ['## Holidays'];
    if (today.length > 0) {
        lines.push(`Today: ${today.map(h => h.name).join('; ')}`);
    }
    if (upcoming.length > 0) {
        lines.push('Upcoming holidays:');
        for (const holiday of upcoming) {
            lines.push(`- ${formatHolidayDate(holiday.dateParts, cfg)} — ${holiday.name}`);
        }
    }
    return lines.join('\n');
}
