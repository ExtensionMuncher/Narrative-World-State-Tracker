/* eslint-disable */
// =============================================================================
// NWST Temporal State Migration — data/timeMigration.js
// =============================================================================
// Separates cyclical calendar position (currentDay.dayCount) from elapsed
// narrative duration (currentDay.elapsedStoryDays). Calendar/date/season logic
// uses dayCount; event aging and other duration bookkeeping use elapsed days.
// =============================================================================

import { getCurrentDay, updateCurrentDay, getStartDate, getCalendarConfig } from './worldState.js';
import { getAllEvents, saveAllEvents, classifyScheduledEventTier } from './events.js';
import { parseCurrentCalendarDate, dayOfYearFor, daysBetweenCalendarDates, wrapDayCount, extractYearFromText, dateFromDayCount, monthLengthsFor, resolveScheduledElapsedWindow, parseScheduledDayRange, addDaysToDate } from '../lib/calendarMath.js';
import { getSetting } from '../index.js';
import { dlog } from '../lib/debug.js';

const ELAPSED_FIELDS = ['tierSetElapsedDay', 'resolveElapsedDay', 'timingDismissedElapsedDay'];

function deriveElapsedMarker(oldCurrentDayCount, oldMarker, currentElapsed) {
    if (!Number.isFinite(oldCurrentDayCount) || !Number.isFinite(oldMarker)) return null;
    const age = Math.max(0, Math.trunc(oldCurrentDayCount - oldMarker));
    // Legacy events may predate an unknown elapsed-time baseline. Negative
    // markers are intentional here: they preserve the event's relative age
    // until a late Starting Date rebases the timeline to its true origin.
    return currentElapsed - age;
}

function legacyDayNumberRange(text) {
    const range = String(text || '').match(/\bDay\s*(\d+)\s*[-–]\s*(\d+)\b/i);
    if (range) return { start: parseInt(range[1], 10), end: parseInt(range[2], 10) };
    const single = String(text || '').match(/\bDay\s*(\d+)\b/i);
    if (single) {
        const n = parseInt(single[1], 10);
        return { start: n, end: n };
    }
    return null;
}

/**
 * Translate a pre-cyclical event schedule into an elapsed occurrence window.
 * Old "Day N" values were absolute monotonic story-day numbers. Named dates
 * were anchored to scheduledDayAnchor/tierSetDay in P1. This preserves that
 * intended one-time occurrence before the visible schedule is normalized.
 */
function deriveLegacyScheduleWindow(event, oldDayCount, currentElapsed, currentCalendarDate, cfg, currentYear) {
    if (!event?.scheduledDate || !Number.isFinite(oldDayCount)) return null;

    const numeric = legacyDayNumberRange(event.scheduledDate);
    if (numeric) {
        const startDelta = numeric.start - oldDayCount;
        const endDelta = numeric.end - oldDayCount;
        const startDate = addDaysToDate(currentCalendarDate, startDelta, cfg);
        const endDate = addDaysToDate(currentCalendarDate, endDelta, cfg);
        return {
            start: currentElapsed + startDelta,
            end: currentElapsed + endDelta,
            normalizedDate: numeric.start === numeric.end
                ? `Day ${dayOfYearFor(startDate, cfg)}`
                : `Day ${dayOfYearFor(startDate, cfg)}-${dayOfYearFor(endDate, cfg)}`
        };
    }

    // P1's literal-date anchoring used configured raw month lengths rather than
    // dynamic leap-year lengths. Recreate that old placement only to determine
    // which occurrence the existing one-time event meant, then map the result
    // onto the corrected calendar below.
    const legacyCfg = cfg?.enabled ? { ...cfg, leapYears: false } : cfg;
    const range = parseScheduledDayRange(event.scheduledDate, legacyCfg, currentYear);
    if (!range) return null;
    const legacyLengths = cfg?.enabled && Array.isArray(cfg.monthDays) && cfg.monthDays.length
        ? cfg.monthDays : monthLengthsFor(legacyCfg, currentYear);
    const legacyYearLen = legacyLengths.reduce((sum, n) => sum + (Number(n) || 0), 0) || 365;
    const currentLegacyDOY = ((Math.trunc(oldDayCount) - 1) % legacyYearLen + legacyYearLen) % legacyYearLen + 1;

    let startAbsolute;
    if (event.status === 'resolved' || event.status === 'missed') {
        const back = ((currentLegacyDOY - range.startDay) % legacyYearLen + legacyYearLen) % legacyYearLen;
        startAbsolute = oldDayCount - back;
    } else {
        const anchor = Number.isFinite(event.scheduledDayAnchor)
            ? event.scheduledDayAnchor
            : Number.isFinite(event.tierSetDay) ? event.tierSetDay : oldDayCount;
        const anchorDOY = ((Math.trunc(anchor) - 1) % legacyYearLen + legacyYearLen) % legacyYearLen + 1;
        const forward = ((range.startDay - anchorDOY) % legacyYearLen + legacyYearLen) % legacyYearLen;
        startAbsolute = anchor + forward;
    }

    let span = range.endDay - range.startDay;
    if (span < 0) span += legacyYearLen;
    const startDelta = startAbsolute - oldDayCount;
    return { start: currentElapsed + startDelta, end: currentElapsed + startDelta + span, normalizedDate: null };
}

/**
 * One-time/lazy migration for an existing chat.
 * - Parses the currently displayed date against the chat's own Calendar Config.
 * - Converts dayCount to the current year's cyclical day position.
 * - Initializes elapsedStoryDays from Starting Date -> Current Date when both
 *   are trustworthy; otherwise starts at 0 rather than inventing history.
 * - Preserves event ages by translating legacy monotonic markers into elapsed
 *   markers before dayCount becomes cyclical.
 */
export async function migrateTemporalState(chatId) {
    const current = getCurrentDay(chatId);
    if (!current) return { changed: false, parsedDate: null, elapsedStoryDays: 0 };

    const cfg = getCalendarConfig(chatId);
    const dmy = getSetting('dateFormatDMY') === true;
    const parsedDate = parseCurrentCalendarDate(current.dateDisplay || '', current.dateSub || '', cfg, dmy);
    const oldDayCount = Number.isFinite(current.dayCount) ? Number(current.dayCount) : 0;

    let elapsed = Number.isInteger(current.elapsedStoryDays) && current.elapsedStoryDays >= 0
        ? current.elapsedStoryDays
        : null;

    if (elapsed === null) {
        const startDate = getStartDate(chatId);
        if (startDate && parsedDate) {
            const diff = daysBetweenCalendarDates(
                { year: startDate.year, month: startDate.month, day: startDate.day },
                parsedDate,
                cfg
            );
            elapsed = Number.isInteger(diff) && diff >= 0 ? diff : 0;
        } else {
            elapsed = 0;
        }
    }

    // Translate duration markers BEFORE changing dayCount. Existing builds used
    // the old monotonically increasing dayCount for these ages.
    const events = getAllEvents(chatId);
    let eventsChanged = false;
    for (const event of events) {
        const mappings = [
            ['tierSetElapsedDay', 'tierSetDay'],
            ['resolveElapsedDay', 'resolveDay'],
            ['timingDismissedElapsedDay', 'timingDismissedDay']
        ];
        for (const [newField, oldField] of mappings) {
            if (typeof event[newField] === 'number' || typeof event[oldField] !== 'number') continue;
            const value = deriveElapsedMarker(oldDayCount, event[oldField], elapsed);
            if (value !== null) {
                event[newField] = value;
                eventsChanged = true;
            }
        }

        const currentYear = parsedDate?.year ?? extractYearFromText(current.dateSub || '') ?? extractYearFromText(current.dateDisplay || '') ?? 1;
        const currentDOY = parsedDate ? dayOfYearFor(parsedDate, cfg) : wrapDayCount(oldDayCount || 1, cfg, currentYear);
        const currentCalendarDate = parsedDate || dateFromDayCount(currentDOY, currentYear, cfg);

        // Resolve legacy one-time schedules against the corrected calendar.
        // Prefer the old monotonic/anchor bookkeeping when available so a past
        // concluded event is not accidentally retargeted to next year's date.
        if (event.scheduledDate && typeof event.scheduledElapsedStart !== 'number' && !event.sourceSpecialDayId) {
            const legacyResolved = deriveLegacyScheduleWindow(
                event, oldDayCount, elapsed, currentCalendarDate, cfg, currentYear
            );
            const resolved = legacyResolved || resolveScheduledElapsedWindow(
                event.scheduledDate, currentCalendarDate, currentDOY, elapsed, cfg
            );
            if (resolved) {
                event.scheduledElapsedStart = resolved.start;
                event.scheduledElapsedEnd = resolved.end;
                if (legacyResolved?.normalizedDate && event.scheduledDate !== legacyResolved.normalizedDate) {
                    event.scheduledDate = legacyResolved.normalizedDate;
                }
                eventsChanged = true;
            }
        }

        // Rebuild materialized Special Day timing from its source calendar entry.
        // Legacy Special Day events stored an absolute-ish occurrenceDay based
        // on the old monotonically increasing dayCount. Preserve whether that
        // occurrence was ahead of or behind the current story date so migration
        // never silently retargets an already-materialized event to next year.
        if (event.sourceSpecialDayId) {
            const source = Array.isArray(cfg.specialDays)
                ? cfg.specialDays.find(sd => sd && sd.id === event.sourceSpecialDayId)
                : null;
            if (source && Number.isInteger(source.month) && Number.isInteger(source.day)) {
                const nextYear = (y) => y === -1 ? 1 : y + 1;
                const prevYear = (y) => y === 1 ? -1 : y - 1;
                const validInYear = (y, month, day) => {
                    const lengths = monthLengthsFor(cfg, y);
                    return month >= 1 && month <= lengths.length && day >= 1 && day <= lengths[month - 1];
                };
                const candidateForYear = (y) => validInYear(y, source.month, source.day)
                    ? { year: y, month: source.month, day: source.day }
                    : null;

                let occurrenceYear = null;
                const keyYearMatch = String(event.occurrenceKey || '').match(/^[^:]+:(-?\d+):/);
                if (keyYearMatch) occurrenceYear = parseInt(keyYearMatch[1], 10);

                const legacyDelta = (typeof event.occurrenceDay === 'number' && Number.isFinite(oldDayCount))
                    ? event.occurrenceDay - oldDayCount
                    : null;
                const thisYearDate = candidateForYear(currentYear);
                const thisYearDelta = thisYearDate
                    ? daysBetweenCalendarDates(currentCalendarDate, thisYearDate, cfg)
                    : null;

                if (!Number.isInteger(occurrenceYear)) {
                    if (Number.isFinite(legacyDelta)) {
                        // Old data tells us whether this materialized occurrence
                        // was still upcoming or had already passed.
                        if (legacyDelta >= 0) {
                            occurrenceYear = Number.isInteger(thisYearDelta) && thisYearDelta >= 0
                                ? currentYear : nextYear(currentYear);
                        } else {
                            occurrenceYear = Number.isInteger(thisYearDelta) && thisYearDelta <= 0
                                ? currentYear : prevYear(currentYear);
                        }
                    } else if (event.status === 'resolved' || event.status === 'missed') {
                        occurrenceYear = Number.isInteger(thisYearDelta) && thisYearDelta <= 0
                            ? currentYear : prevYear(currentYear);
                    } else {
                        occurrenceYear = Number.isInteger(thisYearDelta) && thisYearDelta >= 0
                            ? currentYear : nextYear(currentYear);
                    }
                }

                const startDate = candidateForYear(occurrenceYear);
                if (startDate) {
                    const occurrenceDay = dayOfYearFor(startDate, cfg);
                    let endDate = startDate;
                    if (source.endMonth != null && source.endDay != null) {
                        let endYear = occurrenceYear;
                        if (source.endMonth < source.month || (source.endMonth === source.month && source.endDay < source.day)) {
                            endYear = nextYear(endYear);
                        }
                        if (validInYear(endYear, source.endMonth, source.endDay)) {
                            endDate = { year: endYear, month: source.endMonth, day: source.endDay };
                        }
                    }
                    const occurrenceEndDay = dayOfYearFor(endDate, cfg);
                    const delta = daysBetweenCalendarDates(currentCalendarDate, startDate, cfg);
                    const span = daysBetweenCalendarDates(startDate, endDate, cfg);
                    const scheduledDate = span > 0
                        ? `Day ${occurrenceDay}-${occurrenceEndDay}`
                        : `Day ${occurrenceDay}`;
                    const key = `${event.sourceSpecialDayId}:${occurrenceYear}:${occurrenceDay}`;

                    if (event.occurrenceDay !== occurrenceDay) { event.occurrenceDay = occurrenceDay; eventsChanged = true; }
                    if (event.occurrenceKey !== key) { event.occurrenceKey = key; eventsChanged = true; }
                    if (event.scheduledDate !== scheduledDate) { event.scheduledDate = scheduledDate; eventsChanged = true; }
                    if (Number.isInteger(delta) && Number.isInteger(span)) {
                        const startElapsed = elapsed + delta;
                        const endElapsed = startElapsed + Math.max(0, span);
                        if (event.scheduledElapsedStart !== startElapsed) { event.scheduledElapsedStart = startElapsed; eventsChanged = true; }
                        if (event.scheduledElapsedEnd !== endElapsed) { event.scheduledElapsedEnd = endElapsed; eventsChanged = true; }
                    }
                }
            }
        }
    }
    if (eventsChanged) await saveAllEvents(chatId, events);

    const year = parsedDate?.year ?? extractYearFromText(current.dateSub || '') ?? extractYearFromText(current.dateDisplay || '') ?? 1;
    const cyclicalDayCount = parsedDate
        ? dayOfYearFor(parsedDate, cfg)
        : wrapDayCount(oldDayCount || 1, cfg, year);

    const updates = {};
    if (current.dayCount !== cyclicalDayCount) updates.dayCount = cyclicalDayCount;
    if (current.elapsedStoryDays !== elapsed) updates.elapsedStoryDays = elapsed;
    const changed = Object.keys(updates).length > 0 || eventsChanged;
    if (Object.keys(updates).length > 0) await updateCurrentDay(chatId, updates);

    // Classify dated active events only after the corrected cyclical/elapsed
    // clocks have been saved, so structural placement uses the migrated current
    // date and elapsed baseline rather than stale legacy values.
    const migratedEvents = getAllEvents(chatId);
    let tierPlacementChanged = false;
    for (const event of migratedEvents) {
        if (event.status !== 'pending' && event.status !== 'inprogress') continue;
        if (typeof event.scheduledElapsedStart !== 'number') continue;
        const structuralTier = classifyScheduledEventTier(chatId, event.scheduledElapsedStart, event.scheduledElapsedEnd);
        if (structuralTier && structuralTier !== 'missed' && event.tier !== structuralTier) {
            event.tier = structuralTier;
            tierPlacementChanged = true;
        }
    }
    if (tierPlacementChanged) await saveAllEvents(chatId, migratedEvents);

    const finalChanged = changed || tierPlacementChanged;
    if (finalChanged) dlog(`[NWST TimeMigration] dayCount=${cyclicalDayCount}, elapsedStoryDays=${elapsed}${parsedDate ? ' (current date parsed)' : ' (date fallback)'}.`);
    return { changed: finalChanged, parsedDate, elapsedStoryDays: elapsed, dayCount: cyclicalDayCount };
}

/**
 * Rebase elapsedStoryDays after a late Starting Date entry while preserving all
 * existing event ages. Calendar date/dayCount are intentionally untouched.
 */
export async function rebaseElapsedStoryDays(chatId, newElapsed) {
    const current = getCurrentDay(chatId);
    if (!current || !Number.isInteger(newElapsed) || newElapsed < 0) return false;
    const oldElapsed = Number.isInteger(current.elapsedStoryDays) && current.elapsedStoryDays >= 0 ? current.elapsedStoryDays : 0;
    const delta = newElapsed - oldElapsed;

    if (delta !== 0) {
        const events = getAllEvents(chatId);
        let changed = false;
        for (const event of events) {
            for (const field of ELAPSED_FIELDS) {
                if (typeof event[field] === 'number') {
                    event[field] = event[field] + delta;
                    changed = true;
                }
            }
            if (typeof event.scheduledElapsedStart === 'number') {
                event.scheduledElapsedStart = event.scheduledElapsedStart + delta;
                changed = true;
            }
            if (typeof event.scheduledElapsedEnd === 'number') {
                event.scheduledElapsedEnd = event.scheduledElapsedEnd + delta;
                changed = true;
            }
        }
        if (changed) await saveAllEvents(chatId, events);
    }

    await updateCurrentDay(chatId, { elapsedStoryDays: newElapsed });
    dlog(`[NWST TimeMigration] Rebased elapsedStoryDays ${oldElapsed} -> ${newElapsed} (delta ${delta}).`);
    return true;
}
