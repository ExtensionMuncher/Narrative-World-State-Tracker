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

/** Sum of monthDays — the length of a story year. */
function getYearLength(cfg) {
    if (cfg && Array.isArray(cfg.monthDays) && cfg.monthDays.length > 0) {
        return cfg.monthDays.reduce((a, b) => a + (parseInt(b, 10) || 0), 0) || 365;
    }
    return 365;
}

/** Day-of-year (1-based) for a 1-based month + day-in-month. Null if invalid. */
export function dayOfYearFromMonthDay(month, day, cfg) {
    const monthDays = (cfg && Array.isArray(cfg.monthDays) && cfg.monthDays.length > 0)
        ? cfg.monthDays : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const m = parseInt(month, 10), d = parseInt(day, 10);
    if (!Number.isInteger(m) || m < 1 || m > monthDays.length) return null;
    if (!Number.isInteger(d) || d < 1 || d > (parseInt(monthDays[m - 1], 10) || 0)) return null;
    let doy = d;
    for (let i = 0; i < m - 1; i++) doy += parseInt(monthDays[i], 10) || 0;
    return doy;
}

/** 1-based month index containing a given day-of-year. */
function monthOfDayOfYear(doy, cfg) {
    const monthDays = (cfg && Array.isArray(cfg.monthDays) && cfg.monthDays.length > 0)
        ? cfg.monthDays : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let acc = 0;
    for (let i = 0; i < monthDays.length; i++) {
        acc += parseInt(monthDays[i], 10) || 0;
        if (doy <= acc) return i + 1;
    }
    return monthDays.length;
}

/**
 * Next occurrence of a special day, in dayCount terms (0 = today).
 * Returns { startDayCount, endDayCount, startDOY, endDOY } or null.
 * Ranges that wrap the year end (e.g. a festival spanning New Year) are
 * handled by measuring the range length modulo the year.
 */
export function computeNextOccurrence(specialDay, dayCount, cfg) {
    const yearLength = getYearLength(cfg);
    const startDOY = dayOfYearFromMonthDay(specialDay.month, specialDay.day, cfg);
    if (startDOY === null) return null;

    let rangeLen = 0;
    if (specialDay.endMonth != null && specialDay.endDay != null) {
        const endDOY = dayOfYearFromMonthDay(specialDay.endMonth, specialDay.endDay, cfg);
        if (endDOY !== null) rangeLen = ((endDOY - startDOY) % yearLength + yearLength) % yearLength;
    }

    const currentDOY = ((dayCount - 1) % yearLength + yearLength) % yearLength + 1;
    // If we are currently INSIDE an ongoing range, anchor to the occurrence
    // that already started rather than skipping to next year.
    let delta = ((startDOY - currentDOY) % yearLength + yearLength) % yearLength;
    const deltaFromLastStart = ((currentDOY - startDOY) % yearLength + yearLength) % yearLength;
    if (rangeLen > 0 && deltaFromLastStart > 0 && deltaFromLastStart <= rangeLen) {
        delta = -deltaFromLastStart; // occurrence started deltaFromLastStart days ago and is still running
    }

    const startDayCount = dayCount + delta;
    return {
        startDayCount,
        endDayCount: startDayCount + rangeLen,
        startDOY,
        endDOY: ((startDOY - 1 + rangeLen) % yearLength) + 1
    };
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

    const yearLength = getYearLength(cfg);
    const currentDOY = ((dayCount - 1) % yearLength + yearLength) % yearLength + 1;
    const currentMonth = monthOfDayOfYear(currentDOY, cfg);

    // Anchored-week end (same formula as the structural roll in dayAdvancement).
    const weekLength = (Array.isArray(cfg.weekDays) && cfg.weekDays.length > 0) ? cfg.weekDays.length : 7;
    const startWeekday = (Number.isInteger(cfg.startWeekday) && cfg.startWeekday >= 1)
        ? ((cfg.startWeekday - 1) % weekLength) + 1 : 1;
    const weekdayToday = ((dayCount - 1 + (startWeekday - 1)) % weekLength) + 1;
    const weekEndDay = dayCount + (weekLength - weekdayToday);

    const existing = getAllEvents(chatId);
    let created = 0;

    for (const sd of specialDays) {
        if (!sd || !sd.name || !sd.id) continue;
        const occ = computeNextOccurrence(sd, dayCount, cfg);
        if (!occ) continue;

        // Days remaining in the current calendar month (through its last day).
        const monthDaysArr = (Array.isArray(cfg.monthDays) && cfg.monthDays.length > 0)
            ? cfg.monthDays : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let monthEndDOY = 0;
        for (let i = 0; i < currentMonth; i++) monthEndDOY += parseInt(monthDaysArr[i], 10) || 0;
        const daysUntilMonthEnd = monthEndDOY - currentDOY;

        const delta = occ.startDayCount - dayCount;
        // Materialize when the occurrence falls inside the current calendar
        // month ("This month" is when it first appears), or is near-term —
        // within the anchored week / tomorrow / already running — which
        // covers month-end boundaries and last-minute additions.
        const withinCurrentMonth = delta >= 0 && delta <= daysUntilMonthEnd;
        const nearTerm = delta <= 1 || occ.startDayCount <= weekEndDay;

        if (!withinCurrentMonth && !nearTerm) continue;

        // Per-occurrence dedup — one event per special day per annual occurrence.
        const dedupHit = existing.some(ev =>
            ev.sourceSpecialDayId === sd.id && ev.occurrenceDay === occ.startDayCount);
        if (dedupHit) continue;

        // Tier: normally "This month"; last-minute occurrences surface closer
        // so the anchored ladder is never violated.
        let tier = 'month';
        if (occ.startDayCount - dayCount <= 1) tier = 'immediate';
        else if (occ.startDayCount <= weekEndDay) tier = 'week';

        const catInfo = resolveSpecialDayCategory(sd.category);
        const scheduledDate = (occ.endDayCount > occ.startDayCount)
            ? `Day ${occ.startDayCount}-${occ.endDayCount}`
            : `Day ${occ.startDayCount}`;

        // Player-authored lore leads the description; the structural tag
        // (category + calendar date) rides behind it so both the player and
        // the LLM always know what kind of day this is and when it falls.
        const loreText = (typeof sd.description === 'string' && sd.description.trim())
            ? sd.description.trim().slice(0, 500) + ' '
            : '';
        await addEvent(chatId, {
            title: sd.name,
            description: `${loreText}[${catInfo.label} — recurring calendar day: ${formatMonthDayText(sd, cfg)}]`,
            tier,
            status: 'pending',
            origin: 'special_day',
            scheduledDate,
            specialDayCategory: (typeof sd.category === 'string' && sd.category.trim()) ? sd.category.trim() : 'custom',
            sourceSpecialDayId: sd.id,
            occurrenceDay: occ.startDayCount
        });
        created++;
        dlog(`[NWST SpecialDays] Materialized "${sd.name}" (${catInfo.label}) as ${tier}: ${scheduledDate}`);
    }

    return created;
}
