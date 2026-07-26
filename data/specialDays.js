/* eslint-disable */
// =============================================================================
// NWST Special Days — data/specialDays.js
// =============================================================================
// Player-defined recurring calendar days (birthdays, holidays, festivals,
// deadlines, and more) stored inside the per-chat Calendar Config as
// `specialDays`. Each entry:
//
//   {
//     id: string,
//     name: string,
//     month: number,        // 1-based month index
//     day: number,          // 1-based day within month
//     endMonth: number|null, // optional range end (null = single day)
//     endDay: number|null,
//     category: string,      // key from SPECIAL_DAY_CATEGORIES, or free text
//     description: string,   // optional player-authored lore; injected via the
//                            // materialized event so the roleplay LLM can use it
//   }
//
// Materialization is purely structural (zero API calls): when a special day's
// next occurrence enters the current calendar month — or is already inside
// the anchored week / tomorrow for last-minute additions — a real, dated
// event is created (origin "special_day"), and from then on the normal
// anchored placement ladder walks it month → week → immediate. A
// per-occurrence dedup key guarantees exactly one event per occurrence per
// year: resolving, missing, or deleting it will not resurrect it until the
// next annual occurrence.
//
// dayCount ≡ day-of-year convention: the batch scan seeds dayCount from the
// parsed date display, and day advancement increments it by one — so
// day-of-year for any dayCount is ((dayCount - 1) mod yearLength) + 1. All
// occurrence math below rests on that.
// =============================================================================

import { getAllEvents, addEvent } from './events.js';
import { getCurrentDay, getCalendarConfig } from './worldState.js';
import { dlog } from '../lib/debug.js';
import { monthLengthsFor, parseCurrentCalendarDate, weekdayIndexFromDisplay, dateFromDayCount, daysBetweenCalendarDates, extractYearFromText, calendarDateForBaseMonthDay, dayOfYearFor } from '../lib/calendarMath.js';

/**
 * Category registry: key → { label, chip }. The chip renders on the event
 * card in the Events tab. "custom" is the fallback for free-text categories.
 */
export const SPECIAL_DAY_CATEGORIES = {
    birthday:      { label: 'Birthday',            chip: '🎂' },
    anniversary:   { label: 'Anniversary',         chip: '💍' },
    holiday:       { label: 'Holiday',             chip: '🎉' },
    festival:      { label: 'Festival',            chip: '🎪' },
    feast:         { label: 'Feast Day',           chip: '🍖' },
    memorial:      { label: 'Memorial',            chip: '🕯️' },
    ritual:        { label: 'Ritual Day',          chip: '🔮' },
    ceremony:      { label: 'Ceremony',            chip: '👑' },
    observance:    { label: 'Religious Observance', chip: '⛪' },
    wedding:       { label: 'Wedding',             chip: '💒' },
    market_day:    { label: 'Market Day',          chip: '🛒' },
    tournament:    { label: 'Tournament',          chip: '⚔️' },
    performance:   { label: 'Performance',         chip: '🎭' },
    deadline:      { label: 'Deadline',            chip: '⏳' },
    appointment:   { label: 'Appointment',         chip: '🗓️' },
    payment_due:   { label: 'Payment Due',         chip: '💰' },
    election:      { label: 'Election',            chip: '🗳️' },
    founding_day:  { label: 'Founding Day',        chip: '🏛️' },
    harvest:       { label: 'Harvest',             chip: '🌾' },
    astronomical:  { label: 'Astronomical',        chip: '🌘' },
    pilgrimage:    { label: 'Pilgrimage',          chip: '🚶' },
    school_term:   { label: 'School / Exams',      chip: '🎓' },
    custom:        { label: 'Custom',              chip: '📌' }
};

/** Resolve a stored category value to { label, chip }. Free text → custom chip with the text as label. */
export function resolveSpecialDayCategory(category) {
    if (typeof category === 'string' && SPECIAL_DAY_CATEGORIES[category]) {
        return SPECIAL_DAY_CATEGORIES[category];
    }
    const text = (typeof category === 'string' && category.trim()) ? category.trim() : 'Special Day';
    return { label: text.slice(0, 40), chip: SPECIAL_DAY_CATEGORIES.custom.chip };
}

/** Sum of configured month lengths for a specific calendar year. */
function getYearLength(cfg, year = 1) {
    return monthLengthsFor(cfg, year).reduce((a, b) => a + (parseInt(b, 10) || 0), 0) || 365;
}

/**
 * Day-of-year (1-based) for a stored Special Day month + day. Stored month
 * numbers always mean the regular/base month, so an intercalary month inserted
 * earlier in a lunisolar year never shifts birthdays or recurring observances.
 */
export function dayOfYearFromMonthDay(month, day, cfg, year = 1) {
    const date = calendarDateForBaseMonthDay(year, parseInt(month, 10), parseInt(day, 10), cfg, false);
    return date ? dayOfYearFor(date, cfg) : null;
}

/** 1-based month index containing a given day-of-year. */
function monthOfDayOfYear(doy, cfg, year = 1) {
    const monthDays = monthLengthsFor(cfg, year);
    let acc = 0;
    for (let i = 0; i < monthDays.length; i++) {
        acc += parseInt(monthDays[i], 10) || 0;
        if (doy <= acc) return i + 1;
    }
    return monthDays.length;
}

function nextCalendarYear(year) { return year === -1 ? 1 : year + 1; }
function prevCalendarYear(year) { return year === 1 ? -1 : year - 1; }

/** Build a concrete Special Day occurrence range for one calendar year. */
function buildOccurrenceRange(specialDay, startYear, cfg) {
    const startDate = calendarDateForBaseMonthDay(startYear, specialDay.month, specialDay.day, cfg, false);
    if (!startDate) return null;
    const startDOY = dayOfYearFor(startDate, cfg);

    let endYear = startYear;
    let endDate = startDate;
    if (specialDay.endMonth != null && specialDay.endDay != null) {
        if (specialDay.endMonth < specialDay.month
            || (specialDay.endMonth === specialDay.month && specialDay.endDay < specialDay.day)) {
            endYear = nextCalendarYear(startYear);
        }
        const candidateEnd = calendarDateForBaseMonthDay(endYear, specialDay.endMonth, specialDay.endDay, cfg, false);
        if (candidateEnd) endDate = candidateEnd;
    }

    const rangeLen = daysBetweenCalendarDates(startDate, endDate, cfg);
    if (!Number.isInteger(rangeLen) || rangeLen < 0) return null;
    return {
        startDate,
        endDate,
        startDOY,
        endDOY: dayOfYearFor(endDate, cfg),
        rangeLen,
        occurrenceYear: startYear
    };
}

/**
 * Next annual occurrence relative to the current calendar date. dayCount stays
 * cyclical; the concrete occurrence year keeps annual dedup and leap-year math
 * correct across December/January and other year boundaries.
 */
export function computeNextOccurrence(specialDay, dayCount, cfg, currentYear = 1, currentDate = null) {
    const baseDate = currentDate || dateFromDayCount(dayCount || 1, currentYear, cfg);

    // First check whether a range that began this year or the previous year is
    // currently in progress. This matters for multi-day observances that cross
    // a calendar-year boundary.
    for (const startYear of [prevCalendarYear(currentYear), currentYear]) {
        const occ = buildOccurrenceRange(specialDay, startYear, cfg);
        if (!occ) continue;
        const sinceStart = daysBetweenCalendarDates(occ.startDate, baseDate, cfg);
        const untilEnd = daysBetweenCalendarDates(baseDate, occ.endDate, cfg);
        if (Number.isInteger(sinceStart) && Number.isInteger(untilEnd) && sinceStart >= 0 && untilEnd >= 0) {
            return {
                ...occ,
                delta: -sinceStart,
                occurrenceKey: `${specialDay.id}:${occ.occurrenceYear}:${occ.startDOY}`
            };
        }
    }

    // Otherwise choose the next start date in the current or following year.
    for (const startYear of [currentYear, nextCalendarYear(currentYear)]) {
        const occ = buildOccurrenceRange(specialDay, startYear, cfg);
        if (!occ) continue;
        const delta = daysBetweenCalendarDates(baseDate, occ.startDate, cfg);
        if (Number.isInteger(delta) && delta >= 0) {
            return {
                ...occ,
                delta,
                occurrenceKey: `${specialDay.id}:${occ.occurrenceYear}:${occ.startDOY}`
            };
        }
    }

    return null;
}

/** Human date text like "Emberfall 14" or "Emberfall 14 – Frosthold 2". */
function formatMonthDayText(specialDay, cfg) {
    const names = (cfg && Array.isArray(cfg.monthNames)) ? cfg.monthNames : [];
    const nameOf = (m) => names[m - 1] || `Month ${m}`;
    let text = `${nameOf(specialDay.month)} ${specialDay.day}`;
    if (specialDay.endMonth != null && specialDay.endDay != null) {
        text += (specialDay.endMonth === specialDay.month)
            ? `–${specialDay.endDay}`
            : ` – ${nameOf(specialDay.endMonth)} ${specialDay.endDay}`;
    }
    return text;
}

/**
 * Materialize any special days whose next occurrence has come into range.
 * Trigger: the occurrence's calendar month is the current month, OR the
 * occurrence starts within the anchored week / tomorrow (covers month-end
 * boundaries and last-minute additions). New events start in the "This
 * month" tier unless they must surface closer (week / immediate) so the
 * placement ladder is never violated. Structural — zero API calls; safe to
 * call repeatedly (per-occurrence dedup).
 *
 * @param {string} chatId
 * @returns {Promise<number>} how many events were created
 */
export async function materializeSpecialDays(chatId) {
    const cfg = getCalendarConfig(chatId);
    const specialDays = (cfg && Array.isArray(cfg.specialDays)) ? cfg.specialDays : [];
    if (specialDays.length === 0) return 0;

    const currentDay = getCurrentDay(chatId);
    const dayCount = (currentDay && typeof currentDay.dayCount === 'number') ? currentDay.dayCount : null;
    if (dayCount === null) return 0;

    const parsedCurrentDate = parseCurrentCalendarDate(currentDay?.dateDisplay || '', currentDay?.dateSub || '', cfg, false);
    const currentYear = parsedCurrentDate?.year
        ?? extractYearFromText(currentDay?.dateSub || '')
        ?? extractYearFromText(currentDay?.dateDisplay || '')
        ?? 1;
    const yearLength = getYearLength(cfg, currentYear);
    const currentDOY = ((dayCount - 1) % yearLength + yearLength) % yearLength + 1;
    // dayCount is authoritative for annual position after temporal migration.
    // Rebuild the concrete date from it so numeric DMY displays do not need to
    // be reparsed here just to materialize Special Days.
    const currentDate = dateFromDayCount(currentDOY, currentYear, cfg);
    const currentMonth = monthOfDayOfYear(currentDOY, cfg, currentYear);

    // Week boundaries follow the configured weekday cycle written in the
    // current date display; they do not reset when the annual dayCount wraps.
    const weekLength = (Array.isArray(cfg.weekDays) && cfg.weekDays.length > 0) ? cfg.weekDays.length : 7;
    const currentWeekdayIndex = weekdayIndexFromDisplay(currentDay?.dateDisplay || '', cfg);
    const daysUntilWeekEnd = Number.isInteger(currentWeekdayIndex)
        ? (weekLength - 1 - currentWeekdayIndex)
        : (weekLength - 1);

    const existing = getAllEvents(chatId);
    let created = 0;

    for (const sd of specialDays) {
        if (!sd || !sd.name || !sd.id) continue;
        const occ = computeNextOccurrence(sd, dayCount, cfg, currentYear, currentDate);
        if (!occ) continue;

        // Days remaining in the current calendar month (through its last day).
        const monthDaysArr = monthLengthsFor(cfg, currentYear);
        let monthEndDOY = 0;
        for (let i = 0; i < currentMonth; i++) monthEndDOY += parseInt(monthDaysArr[i], 10) || 0;
        const daysUntilMonthEnd = monthEndDOY - currentDOY;

        const delta = occ.delta;
        // Materialize when the occurrence falls inside the current calendar
        // month ("This month" is when it first appears), or is near-term —
        // within the anchored week / tomorrow / already running — which
        // covers month-end boundaries and last-minute additions.
        const withinCurrentMonth = delta >= 0 && delta <= daysUntilMonthEnd;
        const nearTerm = delta <= 1 || delta <= daysUntilWeekEnd;

        if (!withinCurrentMonth && !nearTerm) continue;

        // Per-occurrence dedup — one event per special day per annual occurrence.
        const dedupHit = existing.some(ev =>
            ev.sourceSpecialDayId === sd.id && ev.occurrenceKey === occ.occurrenceKey);
        if (dedupHit) continue;

        // Tier: normally "This month"; last-minute occurrences surface closer
        // so the anchored ladder is never violated.
        let tier = 'month';
        if (delta <= 1) tier = 'immediate';
        else if (delta <= daysUntilWeekEnd) tier = 'week';

        const catInfo = resolveSpecialDayCategory(sd.category);
        const scheduledDate = occ.rangeLen > 0
            ? `Day ${occ.startDOY}-${occ.endDOY}`
            : `Day ${occ.startDOY}`;

        // Player-authored lore leads the description; the structural tag
        // (category + calendar date) rides behind it so both the player and
        // the LLM always know what kind of day this is and when it falls.
        const loreText = (typeof sd.description === 'string' && sd.description.trim())
            ? sd.description.trim().slice(0, 500) + ' '
            : '';
        const currentElapsed = Number.isInteger(currentDay?.elapsedStoryDays) ? currentDay.elapsedStoryDays : 0;
        await addEvent(chatId, {
            title: sd.name,
            description: `${loreText}[${catInfo.label} — recurring calendar day: ${formatMonthDayText(sd, cfg)}]`,
            tier,
            status: 'pending',
            origin: 'special_day',
            scheduledDate,
            scheduledElapsedStart: currentElapsed + occ.delta,
            scheduledElapsedEnd: currentElapsed + occ.delta + occ.rangeLen,
            specialDayCategory: (typeof sd.category === 'string' && sd.category.trim()) ? sd.category.trim() : 'custom',
            sourceSpecialDayId: sd.id,
            occurrenceDay: occ.startDOY,
            occurrenceKey: occ.occurrenceKey
        });
        created++;
        dlog(`[NWST SpecialDays] Materialized "${sd.name}" (${catInfo.label}) as ${tier}: ${scheduledDate}`);
    }

    return created;
}
