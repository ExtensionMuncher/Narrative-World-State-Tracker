// lib/calendarMath.js
// Calendar math helpers for NWST. Current calendar progression advances from
// the currently displayed canonical date using the configured month/year cycle.
// Starting Date is an elapsed-story baseline, not the calendar clock. Legacy
// anchor helpers remain for backward compatibility and date normalization tools.
//
// Design notes:
// - Years are signed integers with NO year zero: ... -2 (2 BC), -1 (1 BC),
//   1 (1 AD), 2 ... Negative years render as "44 BC".
// - Current weekday progression follows the configured weekday list independently
//   of the annual dayCount reset. Legacy dayCount/startWeekday helpers remain for
//   old exports and normalization tools, but normal Next Day progression advances
//   from the weekday already written in the canonical Current Day.
// - Custom calendars use configured month names/lengths. Gregorian-compatible
//   renamed 12-month calendars may honor the leap-year toggle; calendars with
//   other month structures use exactly the configured month lengths.

const GREGORIAN_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const GREGORIAN_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const MONTH_NAME_LOOKUP = (() => {
    const map = {};
    GREGORIAN_MONTH_NAMES.forEach((name, i) => {
        map[name.toLowerCase()] = i + 1;
        map[name.toLowerCase().slice(0, 3)] = i + 1; // jan, feb, sept handled below
    });
    map['sept'] = 9;
    return map;
})();

/**
 * Proleptic Gregorian leap-year rule. Years before 1 AD never leap here —
 * historical leap rules that far back are a mess of Julian drift, and no
 * roleplay hinges on Feb 29, 45 BC.
 * @param {number} year - Signed year (no year zero)
 * @returns {boolean}
 */
export function isGregorianLeapYear(year) {
    if (year < 1) return false;
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Month lengths for a given year under the active calendar.
 * @param {object} calendarConfig - From getCalendarConfig()
 * @param {number} year - Signed year
 * @returns {number[]}
 */
export function monthLengthsFor(calendarConfig, year) {
    if (calendarConfig?.enabled && Array.isArray(calendarConfig.monthDays) && calendarConfig.monthDays.length > 0) {
        // Gregorian-compatible custom calendars (12 months, 28-day second
        // month — i.e. a renamed Earth calendar) honor the leap toggle:
        // their second month gets a 29th day in leap years. Any other shape
        // (extra months, different lengths) never leaps.
        if (calendarConfig.leapYears !== false
            && calendarConfig.monthDays.length === 12
            && calendarConfig.monthDays[1] === 28
            && isGregorianLeapYear(year)) {
            const days = [...calendarConfig.monthDays];
            days[1] = 29;
            return days;
        }
        return calendarConfig.monthDays;
    }
    const days = [...GREGORIAN_MONTH_DAYS];
    if (calendarConfig?.leapYears !== false && isGregorianLeapYear(year)) {
        days[1] = 29; // February 29th
    }
    return days;
}

/**
 * Month names under the active calendar.
 * @param {object} calendarConfig
 * @returns {string[]}
 */
export function monthNamesFor(calendarConfig) {
    if (calendarConfig?.enabled && Array.isArray(calendarConfig.monthNames) && calendarConfig.monthNames.length > 0) {
        return calendarConfig.monthNames;
    }
    return GREGORIAN_MONTH_NAMES;
}

/** Advance a signed no-year-zero year by one. */
function nextYear(year) { return year === -1 ? 1 : year + 1; }
/** Step a signed no-year-zero year back by one. */
function prevYear(year) { return year === 1 ? -1 : year - 1; }

/**
 * Add (or subtract) whole days to an anchor date under the active calendar.
 * Month-stepping walk — fast for any realistic roleplay span.
 * @param {{year:number, month:number, day:number}} anchor - month is 1-based
 * @param {number} elapsedDays - May be negative
 * @param {object} calendarConfig
 * @returns {{year:number, month:number, day:number}} month 1-based
 */
export function addDaysToDate(anchor, elapsedDays, calendarConfig) {
    let year = anchor.year;
    let monthIdx = Math.max(0, (anchor.month || 1) - 1);
    let day = Math.max(1, anchor.day || 1);
    let remaining = Math.trunc(elapsedDays) || 0;

    // Clamp anchor into the calendar's real bounds first (defensive)
    let lengths = monthLengthsFor(calendarConfig, year);
    if (monthIdx >= lengths.length) monthIdx = lengths.length - 1;
    if (day > lengths[monthIdx]) day = lengths[monthIdx];

    while (remaining > 0) {
        const monthLen = monthLengthsFor(calendarConfig, year)[monthIdx];
        const daysLeftInMonth = monthLen - day;
        if (remaining <= daysLeftInMonth) {
            day += remaining;
            remaining = 0;
        } else {
            remaining -= (daysLeftInMonth + 1);
            day = 1;
            monthIdx += 1;
            if (monthIdx >= monthLengthsFor(calendarConfig, year).length) {
                monthIdx = 0;
                year = nextYear(year);
            }
        }
    }
    while (remaining < 0) {
        if (day > 1) {
            const step = Math.min(day - 1, -remaining);
            day -= step;
            remaining += step;
        } else {
            monthIdx -= 1;
            if (monthIdx < 0) {
                year = prevYear(year);
                monthIdx = monthLengthsFor(calendarConfig, year).length - 1;
            }
            day = monthLengthsFor(calendarConfig, year)[monthIdx];
            remaining += 1;
        }
    }

    return { year, month: monthIdx + 1, day };
}

/**
 * 1-based day-of-year for a date under the active calendar.
 * @param {{year:number, month:number, day:number}} date
 * @param {object} calendarConfig
 * @returns {number}
 */
export function dayOfYearFor(date, calendarConfig) {
    const lengths = monthLengthsFor(calendarConfig, date.year);
    let doy = Math.max(1, date.day || 1);
    const monthIdx = Math.max(0, Math.min((date.month || 1) - 1, lengths.length - 1));
    for (let i = 0; i < monthIdx; i++) doy += lengths[i];
    return doy;
}

/**
 * True Gregorian weekday for a real-world date, Monday-first (0 = Monday …
 * 6 = Sunday). Uses the Julian Day Number so it's valid for any signed year.
 * @param {number} year - Signed, no year zero
 * @param {number} month - 1-based
 * @param {number} day
 * @returns {number} 0..6, Monday-first
 */
export function gregorianWeekdayIndex(year, month, day) {
    const astroYear = year < 0 ? year + 1 : year; // astronomical numbering has a year 0
    const a = Math.floor((14 - month) / 12);
    const y = astroYear + 4800 - a;
    const m = month + 12 * a - 3;
    const jdn = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
    return ((jdn % 7) + 7) % 7; // JDN 0 was a Monday
}

/**
 * Display weekday index for a story day — THE anchored-week formula, identical
 * to the event-scheduling math in llm/dayAdvancement.js. Keeping one formula
 * guarantees the printed weekday and event timing can never disagree.
 * @param {number} dayCount - Story day counter
 * @param {object} calendarConfig - Uses weekDays + startWeekday
 * @returns {number} 0-based index into calendarConfig.weekDays
 */
export function weekdayIndexForDayCount(dayCount, calendarConfig) {
    const weekLength = (Array.isArray(calendarConfig?.weekDays) && calendarConfig.weekDays.length > 0)
        ? calendarConfig.weekDays.length : 7;
    const startWeekday = (Number.isInteger(calendarConfig?.startWeekday) && calendarConfig.startWeekday >= 1)
        ? ((calendarConfig.startWeekday - 1) % weekLength) + 1 : 1;
    return ((dayCount - 1 + (startWeekday - 1)) % weekLength + weekLength) % weekLength;
}

/**
 * Given a real-world anchor date and the dayCount it corresponds to, compute
 * the startWeekday value that makes the anchored-week formula agree with the
 * true Gregorian weekday. Used when a Gregorian Starting Date is confirmed.
 * @param {{year:number, month:number, day:number}} anchorDate
 * @param {number} anchorDayCount
 * @param {number} weekLength - Normally 7
 * @returns {number} 1-based startWeekday
 */
export function startWeekdayForAnchor(anchorDate, anchorDayCount, weekLength = 7) {
    const trueIdx = gregorianWeekdayIndex(anchorDate.year, anchorDate.month, anchorDate.day); // 0=Mon
    // Solve ((anchorDayCount - 1 + startWeekday - 1) mod L) = trueIdx
    const sw = ((trueIdx - (anchorDayCount - 1)) % weekLength + weekLength) % weekLength + 1;
    return sw;
}

/** Ordinal suffix: 1→st, 2→nd, 3→rd, 11-13→th, etc. */
export function ordinalSuffix(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return 'th';
    switch (n % 10) {
        case 1: return 'st';
        case 2: return 'nd';
        case 3: return 'rd';
        default: return 'th';
    }
}

/**
 * Century label for a signed year: 2024 → "21st Century", -44 → "1st Century BC".
 * @param {number} year
 * @returns {string}
 */
export function centuryLabel(year) {
    if (!Number.isInteger(year) || year === 0) return '';
    const abs = Math.abs(year);
    const cent = Math.floor((abs - 1) / 100) + 1;
    return `${cent}${ordinalSuffix(cent)} Century${year < 0 ? ' BC' : ''}`;
}

/** Render a signed year for display: 2024 → "2024", -44 → "44 BC". */
export function formatYear(year) {
    if (!Number.isInteger(year)) return '';
    return year < 0 ? `${Math.abs(year)} BC` : String(year);
}

/**
 * Compute the complete deterministic date display for a story day.
 * @param {{year:number, month:number, day:number}} startDate - The anchor
 * @param {number} anchorDayCount - dayCount the anchor corresponds to
 * @param {number} dayCount - Current story day counter
 * @param {object} calendarConfig - From getCalendarConfig()
 * @returns {{date:{year:number,month:number,day:number}, dateDisplay:string,
 *            weekdayName:string, monthName:string, dayOfYear:number,
 *            centuryLabel:string, eraSub:string}}
 */
export function computeDeterministicDate(startDate, anchorDayCount, dayCount, calendarConfig) {
    const elapsed = (dayCount || 0) - (anchorDayCount || 0);
    const date = addDaysToDate(startDate, elapsed, calendarConfig);
    const monthNames = monthNamesFor(calendarConfig);
    const monthName = monthNames[Math.min(date.month - 1, monthNames.length - 1)] || `Month ${date.month}`;
    const weekDays = (Array.isArray(calendarConfig?.weekDays) && calendarConfig.weekDays.length > 0)
        ? calendarConfig.weekDays
        : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const weekdayName = weekDays[weekdayIndexForDayCount(dayCount, calendarConfig)] || weekDays[0];

    const dateDisplay = `${weekdayName}, ${monthName} ${date.day}${ordinalSuffix(date.day)}, ${formatYear(date.year)}`;

    // Code-computed era sub-line:
    // - Custom calendar: the config's eraName field, with {year} substitution.
    // - Gregorian: century label (the LLM may override with a historical era
    //   like "Meiji 12" during day advancement — cultural labels are its job).
    let eraSub = '';
    if (calendarConfig?.enabled) {
        const eraName = typeof calendarConfig.eraName === 'string' ? calendarConfig.eraName.trim() : '';
        if (eraName) eraSub = eraName.replace(/\{year\}/gi, formatYear(date.year));
    } else {
        eraSub = centuryLabel(date.year);
    }

    return {
        date,
        dateDisplay,
        weekdayName,
        monthName,
        dayOfYear: dayOfYearFor(date, calendarConfig),
        centuryLabel: centuryLabel(date.year),
        eraSub
    };
}

/**
 * Parse a displayed date line ("Wednesday, April 20th, 2024" or
 * "Firesday, Emberfall 3rd, 312" or "March 15th, 44 BC") back into
 * components under the active calendar. Used by the adopt-computed-dates
 * action to pair the engine with whatever date the chat currently shows.
 * @param {string} display
 * @param {object} calendarConfig
 * @returns {{year:number, month:number, day:number}|null}
 */
export function parseDisplayDate(display, calendarConfig) {
    if (!display || typeof display !== 'string') return null;
    let s = display.trim().replace(/\s+/g, ' ');

    if (!calendarConfig?.enabled) {
        // Gregorian display lines may begin with a weekday followed by a comma.
        const lead = s.match(/^[^\d,]+,\s*/);
        if (lead) s = s.slice(lead[0].length).trim();
        return parseUserDate(s, false);
    }

    // For custom calendars, strip ONLY a configured weekday prefix. A generic
    // "text before first comma" rule would corrupt legitimate configured month
    // names such as "Shimotsuki, the Eleventh Month".
    const weekDays = Array.isArray(calendarConfig.weekDays) ? calendarConfig.weekDays : [];
    for (const weekday of weekDays) {
        const name = String(weekday || '').trim();
        if (!name) continue;
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = s.match(new RegExp('^' + esc + '\\s*,\\s*', 'i'));
        if (match) {
            s = s.slice(match[0].length).trim();
            break;
        }
    }

    // Custom calendar: match configured month names (longest first, so
    // "Duskmonth Deep" wins over "Duskmonth")
    let bc = false;
    const bcMatch = s.match(/\s+(BC|BCE)\.?$/i);
    if (bcMatch) { bc = true; s = s.slice(0, bcMatch.index).trim(); }
    const names = (Array.isArray(calendarConfig.monthNames) ? calendarConfig.monthNames : [])
        .map((n, i) => ({ n: String(n || ''), i }))
        .filter(x => x.n)
        .sort((a, b) => b.n.length - a.n.length);
    for (const { n, i } of names) {
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = s.match(new RegExp('^' + esc + '\\s+(\\d{1,3})(?:st|nd|rd|th)?,?\\s+(\\d{1,6})$', 'i'));
        if (m) {
            const day = parseInt(m[1], 10);
            const year = parseInt(m[2], 10);
            const lengths = Array.isArray(calendarConfig.monthDays) ? calendarConfig.monthDays : [];
            if (year === 0 || day < 1) return null;
            if (lengths[i] && day > lengths[i]) return null;
            return { year: bc ? -year : year, month: i + 1, day };
        }
    }
    return null;
}

/**
 * Extract a plausible in-story YEAR from freeform text like "Reiwa 6 · 2024",
 * "Imperial Era · 1125 CE", "44 BC", or "Third Age · Year 12". Explicit
 * era markers and an explicit Year/yr keyword may use short years; bare numbers
 * remain limited to 3-6 digits so era-relative values such as the "6" in
 * "Reiwa 6" are not mistaken for the absolute year.
 * @param {string} text
 * @returns {number|null} Signed year (negative = BC) or null
 */
export function extractYearFromText(text) {
    if (!text || typeof text !== 'string') return null;

    // Explicit era markers are unambiguous even for short years: "44 BC",
    // "12 CE". Prefer these before looking at bare numbers.
    const marked = [...text.matchAll(/(\d{1,6})\s*(BCE|BC|CE|AD)\b/gi)];
    if (marked.length > 0) {
        const m = marked[marked.length - 1];
        const year = parseInt(m[1], 10);
        if (!Number.isInteger(year) || year === 0) return null;
        return /^BCE?$/i.test(m[2]) ? -year : year;
    }

    // Custom/fantasy calendars often write short absolute years explicitly as
    // "Year 12". The keyword makes this safe to distinguish from era-relative
    // labels such as "Reiwa 6".
    const explicitYear = text.match(/\b(?:year|yr\.?)\s*(-?\d{1,6})\b/i);
    if (explicitYear) {
        const year = parseInt(explicitYear[1], 10);
        if (Number.isInteger(year) && year !== 0) return year;
    }

    // Bare numbers remain conservative: only 3-6 digits count as an absolute
    // year so the "6" in "Reiwa 6 • 2024" is never mistaken for year 6.
    const bare = [...text.matchAll(/\b(\d{3,6})\b/g)];
    if (bare.length === 0) return null;
    const year = parseInt(bare[bare.length - 1][1], 10);
    return Number.isInteger(year) && year !== 0 ? year : null;
}

/**
 * Convert a story day counter into a calendar date for a known year, using
 * the active calendar's month lengths. The day counter is seeded at warmup
 * as day-of-year, so `dayCount` maps back to a month/day by walking the
 * configured months (modulo the year length for long-running chats).
 * @param {number} dayCount
 * @param {number} year - Signed year the story is currently in
 * @param {object} calendarConfig
 * @returns {{year:number, month:number, day:number}}
 */
export function dateFromDayCount(dayCount, year, calendarConfig) {
    const lengths = monthLengthsFor(calendarConfig, year);
    const yearLen = lengths.reduce((a, b) => a + b, 0) || 365;
    let doy = ((Math.max(1, Math.trunc(dayCount) || 1) - 1) % yearLen) + 1;
    let month = 1;
    for (const len of lengths) {
        if (doy <= len) break;
        doy -= len;
        month += 1;
    }
    return { year, month, day: doy };
}

/**
 * Overwrite forecast day labels with code-computed weekday names. Entry 0 is
 * always 'Today'; entries 1..n get the weekday of todayDayCount + i via the
 * same anchored-week formula as everything else. Used wherever the
 * deterministic engine is active so forecast labels can never show stale
 * real-world weekday names in a custom-calendar world (or wrong weekdays in
 * a real one).
 * @param {Array} forecast - Parsed forecast entries (label/icon/temps/…)
 * @param {number} todayDayCount - dayCount of the forecast's first entry
 * @param {object} calendarConfig
 * @returns {Array} New array with corrected labels
 */
export function applyDeterministicForecastLabels(forecast, todayDayCount, calendarConfig) {
    if (!Array.isArray(forecast)) return forecast;
    const weekDays = (Array.isArray(calendarConfig?.weekDays) && calendarConfig.weekDays.length > 0)
        ? calendarConfig.weekDays
        : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return forecast.map((day, i) => ({
        ...day,
        label: i === 0 ? 'Today' : (weekDays[weekdayIndexForDayCount((todayDayCount || 0) + i, calendarConfig)] || day.label)
    }));
}

/**
 * Parse a user-entered Starting Date string.
 *
 * Accepted formats:
 *   1/1/26          01/01/2026        01/01/26
 *   January 1, 2026     January 1st, 2026     January 1st 2026
 *   1 January 2026      1st January 2026      (day-first written form)
 *   Optional trailing "BC" / "BCE" on the written forms → negative year.
 *
 * @param {string} text
 * @param {boolean} dmy - International toggle: read 10/4/26 as April 10th
 * @returns {{year:number, month:number, day:number}|null} month 1-based, or null if unparseable
 */
export function parseUserDate(text, dmy = false, calendarConfig = null) {
    if (!text || typeof text !== 'string') return null;
    let s = text.trim().replace(/\s+/g, ' ');
    if (!s) return null;

    // BC/BCE suffix (written forms)
    let bc = false;
    const bcMatch = s.match(/\s+(BC|BCE)\.?$/i);
    if (bcMatch) {
        bc = true;
        s = s.slice(0, bcMatch.index).trim();
    }

    const custom = calendarConfig?.enabled && Array.isArray(calendarConfig.monthDays) && calendarConfig.monthDays.length > 0;
    const finish = (year, month, day) => {
        if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
        if (year === 0) return null; // no year zero
        const maxMonth = custom ? calendarConfig.monthDays.length : 12;
        if (month < 1 || month > maxMonth) return null;
        let lengths;
        if (custom) {
            lengths = [...calendarConfig.monthDays];
            if (lengths.length === 12 && lengths[1] === 28) lengths[1] = 29; // accept leap-day entry
        } else {
            lengths = [...GREGORIAN_MONTH_DAYS];
            lengths[1] = 29; // accept Feb 29 at parse time; leap validity is display-side
        }
        if (day < 1 || day > lengths[month - 1]) return null;
        return { year: bc ? -Math.abs(year) : year, month, day };
    };

    // Two-digit years mean the 2000s: "26" → 2026. BC years are literal —
    // "44 BC" is year 44, never 2044.
    const expandYear = (y) => (!bc && y < 100 ? 2000 + y : y);

    // ── Slash / dash numeric form: 1/1/26, 01-01-2026 ──
    const numMatch = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
    if (numMatch) {
        const a = parseInt(numMatch[1], 10);
        const b = parseInt(numMatch[2], 10);
        const y = expandYear(parseInt(numMatch[3], 10));
        return dmy ? finish(y, b, a) : finish(y, a, b);
    }

    // ── ISO form: 2026-01-01 ──
    const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
        return finish(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10), parseInt(isoMatch[3], 10));
    }

    // Strip ordinal suffixes for the written forms: "1st" → "1"
    const cleaned = s.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');

    // ── Written form, month-first: "January 1, 2026" / "January 1 2026" ──
    const mFirst = cleaned.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{1,4})$/);
    if (mFirst) {
        const month = MONTH_NAME_LOOKUP[mFirst[1].toLowerCase()];
        if (month) return finish(expandYear(parseInt(mFirst[3], 10)), month, parseInt(mFirst[2], 10));
    }

    // ── Written form, day-first: "1 January 2026" ──
    const dFirst = cleaned.match(/^(\d{1,2})\s+(?:of\s+)?([A-Za-z]+)\.?,?\s+(\d{1,4})$/);
    if (dFirst) {
        const month = MONTH_NAME_LOOKUP[dFirst[2].toLowerCase()];
        if (month) return finish(expandYear(parseInt(dFirst[3], 10)), month, parseInt(dFirst[1], 10));
    }

    return null;
}

// ── Current-date parsing and cyclical calendar helpers ────────────────────

const ORDINAL_WORD_VALUES = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
    eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty-first': 21, 'twenty-second': 22, 'twenty-third': 23,
    'twenty-fourth': 24, 'twenty-fifth': 25, 'twenty-sixth': 26, 'twenty-seventh': 27, 'twenty-eighth': 28,
    'twenty-ninth': 29, thirtieth: 30, 'thirty-first': 31
};

function extractDayValue(text) {
    const numeric = String(text || '').match(/\b(\d{1,3})(?:st|nd|rd|th)?\b/i);
    if (numeric) return parseInt(numeric[1], 10);
    const lower = String(text || '').toLowerCase();
    for (const [word, value] of Object.entries(ORDINAL_WORD_VALUES)) {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('(?:^|[^\\p{L}])' + escaped + '(?=[^\\p{L}]|$)', 'iu').test(lower)) return value;
    }
    return null;
}

/** Return the configured year length for a specific year. */
export function yearLengthFor(calendarConfig, year = 1) {
    return monthLengthsFor(calendarConfig, year).reduce((sum, days) => sum + (Number(days) || 0), 0) || 365;
}

/** Wrap an arbitrary counter into the configured calendar year's 1-based range. */
export function wrapDayCount(dayCount, calendarConfig, year = 1) {
    const len = yearLengthFor(calendarConfig, year);
    const n = Number.isFinite(Number(dayCount)) ? Math.trunc(Number(dayCount)) : 1;
    return ((Math.max(1, n) - 1) % len + len) % len + 1;
}

/**
 * Parse the chat's currently displayed LLM-written date using its own calendar
 * config. The year may live in dateSub while month/day live in dateDisplay.
 * Custom month names are matched longest-first, including names containing
 * commas (e.g. "Shimotsuki, the Eleventh Month").
 */
export function parseCurrentCalendarDate(dateDisplay, dateSub, calendarConfig, dmy = false) {
    const display = String(dateDisplay || '').trim();
    const sub = String(dateSub || '').trim();
    if (!display) return null;

    const inline = parseDisplayDate(display, calendarConfig);
    if (inline) return inline;

    const year = extractYearFromText(sub) ?? extractYearFromText(display);
    if (!Number.isInteger(year) || year === 0) return null;

    const names = monthNamesFor(calendarConfig)
        .map((name, index) => ({ name: String(name || ''), index }))
        .filter(x => x.name)
        .sort((a, b) => b.name.length - a.name.length);

    for (const { name, index } of names) {
        const pos = display.toLocaleLowerCase().indexOf(name.toLocaleLowerCase());
        if (pos === -1) continue;
        const remainder = (display.slice(0, pos) + ' ' + display.slice(pos + name.length)).trim();
        const day = extractDayValue(remainder);
        if (!Number.isInteger(day)) continue;
        const lengths = monthLengthsFor(calendarConfig, year);
        if (index >= lengths.length || day < 1 || day > lengths[index]) continue;
        return { year, month: index + 1, day };
    }

    // Numeric month/day display with the year stored separately.
    const numeric = display.match(/\b(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\b/);
    if (numeric) {
        const a = parseInt(numeric[1], 10);
        const b = parseInt(numeric[2], 10);
        const month = dmy ? b : a;
        const day = dmy ? a : b;
        const lengths = monthLengthsFor(calendarConfig, year);
        if (month >= 1 && month <= lengths.length && day >= 1 && day <= lengths[month - 1]) {
            return { year, month, day };
        }
    }

    return null;
}

/** Find the configured weekday currently written in dateDisplay. */
export function weekdayIndexFromDisplay(dateDisplay, calendarConfig) {
    const display = String(dateDisplay || '').toLocaleLowerCase();
    const days = Array.isArray(calendarConfig?.weekDays) && calendarConfig.weekDays.length
        ? calendarConfig.weekDays : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    for (let i = 0; i < days.length; i++) {
        const name = String(days[i] || '').trim().toLocaleLowerCase();
        if (name && display.includes(name)) return i;
    }
    return null;
}

/** Render a deterministic date using a caller-supplied weekday index. */
export function formatCalendarDate(date, weekdayIndex, calendarConfig) {
    const monthNames = monthNamesFor(calendarConfig);
    const weekDays = Array.isArray(calendarConfig?.weekDays) && calendarConfig.weekDays.length
        ? calendarConfig.weekDays : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const monthName = monthNames[Math.max(0, Math.min(date.month - 1, monthNames.length - 1))] || `Month ${date.month}`;
    const wi = Number.isInteger(weekdayIndex) ? ((weekdayIndex % weekDays.length) + weekDays.length) % weekDays.length : 0;
    return `${weekDays[wi]}, ${monthName} ${date.day}${ordinalSuffix(date.day)}, ${formatYear(date.year)}`;
}

/** Advance the currently displayed calendar date without using elapsedStoryDays. */
export function advanceCurrentCalendarDate(currentDay, days, calendarConfig, dmy = false) {
    const currentDate = parseCurrentCalendarDate(currentDay?.dateDisplay, currentDay?.dateSub, calendarConfig, dmy);
    if (!currentDate) return null;
    const amount = Math.trunc(days) || 0;
    const date = addDaysToDate(currentDate, amount, calendarConfig);
    const weekDays = Array.isArray(calendarConfig?.weekDays) && calendarConfig.weekDays.length
        ? calendarConfig.weekDays : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    let weekdayIndex = weekdayIndexFromDisplay(currentDay?.dateDisplay, calendarConfig);
    if (Number.isInteger(weekdayIndex)) {
        weekdayIndex = ((weekdayIndex + amount) % weekDays.length + weekDays.length) % weekDays.length;
    } else if (!calendarConfig?.enabled && weekDays.length === 7) {
        weekdayIndex = gregorianWeekdayIndex(date.year, date.month, date.day);
    } else {
        weekdayIndex = weekdayIndexForDayCount(dayOfYearFor(date, calendarConfig), calendarConfig);
    }
    return {
        date,
        weekdayIndex,
        weekdayName: weekDays[weekdayIndex] || weekDays[0],
        dateDisplay: formatCalendarDate(date, weekdayIndex, calendarConfig),
        dayOfYear: dayOfYearFor(date, calendarConfig)
    };
}

/** Apply forecast labels from a known current weekday instead of dayCount. */
export function applyForecastLabelsFromWeekday(forecast, currentWeekdayIndex, calendarConfig) {
    if (!Array.isArray(forecast)) return forecast;
    const weekDays = Array.isArray(calendarConfig?.weekDays) && calendarConfig.weekDays.length
        ? calendarConfig.weekDays : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const base = Number.isInteger(currentWeekdayIndex) ? currentWeekdayIndex : 0;
    return forecast.map((entry, i) => ({
        ...entry,
        label: i === 0 ? 'Today' : (weekDays[(base + i) % weekDays.length] || entry.label)
    }));
}

function compareCalendarDates(a, b) {
    if (a.year !== b.year) return a.year < b.year ? -1 : 1;
    if (a.month !== b.month) return a.month < b.month ? -1 : 1;
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return 0;
}

/** Whole calendar days from start to end under the configured calendar. */
export function daysBetweenCalendarDates(start, end, calendarConfig) {
    if (!start || !end || start.year === 0 || end.year === 0) return null;
    const cmp = compareCalendarDates(start, end);
    if (cmp === 0) return 0;
    if (cmp > 0) {
        const reverse = daysBetweenCalendarDates(end, start, calendarConfig);
        return Number.isInteger(reverse) ? -reverse : null;
    }

    if (start.year === end.year) {
        return dayOfYearFor(end, calendarConfig) - dayOfYearFor(start, calendarConfig);
    }

    let total = yearLengthFor(calendarConfig, start.year) - dayOfYearFor(start, calendarConfig);
    let year = nextYear(start.year);
    let guard = 0;
    while (year !== end.year && guard++ < 100000) {
        total += yearLengthFor(calendarConfig, year);
        year = nextYear(year);
    }
    if (year !== end.year) return null;
    total += dayOfYearFor(end, calendarConfig);
    return total;
}

/**
 * Resolve a one-time event schedule against the current calendar date and
 * return its elapsed-story-day occurrence window. Calendar position remains
 * cyclical; elapsedStoryDays is used only to remember which annual occurrence
 * this one-time event belongs to after year rollover.
 *
 * Named month/day schedules are reparsed in the target year so leap-year
 * differences are honored. "Day N" schedules remain a cyclical day-of-year
 * position in whatever configured year contains the next occurrence.
 */
export function resolveScheduledElapsedWindow(scheduledDate, currentDate, currentDayCount, currentElapsed, calendarConfig) {
    if (!scheduledDate) return null;

    const elapsed = Number.isInteger(currentElapsed) && currentElapsed >= 0 ? currentElapsed : 0;
    const baseYear = currentDate?.year ?? 1;
    const baseDOY = currentDate
        ? dayOfYearFor(currentDate, calendarConfig)
        : wrapDayCount(currentDayCount || 1, calendarConfig, baseYear);
    const baseDate = currentDate || dateFromDayCount(baseDOY, baseYear, calendarConfig);

    const scheduleText = String(scheduledDate);
    const explicitYear = /\bDay\s*\d/i.test(scheduleText) ? null : extractYearFromText(scheduleText);
    let occurrenceYear = explicitYear ?? baseYear;
    let range = parseScheduledDayRange(scheduledDate, calendarConfig, occurrenceYear);
    if (!range) return null;

    let startDate = dateFromDayCount(range.startDay, occurrenceYear, calendarConfig);
    if (explicitYear == null && compareCalendarDates(startDate, baseDate) < 0) {
        occurrenceYear = nextYear(occurrenceYear);
        range = parseScheduledDayRange(scheduledDate, calendarConfig, occurrenceYear);
        if (!range) return null;
        startDate = dateFromDayCount(range.startDay, occurrenceYear, calendarConfig);
    }

    let endYear = occurrenceYear;
    if (range.endDay < range.startDay) endYear = nextYear(endYear);
    let endDate = dateFromDayCount(range.endDay, endYear, calendarConfig);

    const deltaStart = daysBetweenCalendarDates(baseDate, startDate, calendarConfig);
    const span = daysBetweenCalendarDates(startDate, endDate, calendarConfig);
    if (!Number.isInteger(deltaStart) || !Number.isInteger(span) || span < 0) return null;

    return {
        start: elapsed + deltaStart,
        end: elapsed + deltaStart + span,
        startDay: range.startDay,
        endDay: range.endDay,
        occurrenceYear
    };
}

/**
 * Parse an event scheduledDate into cyclical day-of-year bounds using the
 * active calendar. Supports "Day 12", "Day 10-14", configured month names,
 * numeric or ordinal days, and same-month numeric ranges.
 */
export function parseScheduledDayRange(scheduledDate, calendarConfig, year = 1) {
    const text = String(scheduledDate || '').trim();
    if (!text) return null;
    const yearLen = yearLengthFor(calendarConfig, year);

    const dayRange = text.match(/\bDay\s*(\d+)\s*[-–]\s*(\d+)\b/i);
    if (dayRange) {
        const startDay = parseInt(dayRange[1], 10);
        const endDay = parseInt(dayRange[2], 10);
        if (startDay >= 1 && startDay <= yearLen && endDay >= 1 && endDay <= yearLen) return { startDay, endDay };
        return null;
    }
    const daySingle = text.match(/\bDay\s*(\d+)\b/i);
    if (daySingle) {
        const d = parseInt(daySingle[1], 10);
        return d >= 1 && d <= yearLen ? { startDay: d, endDay: d } : null;
    }

    const names = monthNamesFor(calendarConfig)
        .map((name, index) => ({ name: String(name || ''), index }))
        .filter(x => x.name)
        .sort((a, b) => b.name.length - a.name.length);
    const lower = text.toLocaleLowerCase();
    for (const { name, index } of names) {
        const pos = lower.indexOf(name.toLocaleLowerCase());
        if (pos === -1) continue;
        const remainder = (text.slice(0, pos) + ' ' + text.slice(pos + name.length)).trim();
        const range = remainder.match(/\b(\d{1,3})(?:st|nd|rd|th)?\s*[-–]\s*(\d{1,3})(?:st|nd|rd|th)?\b/i);
        const start = range ? parseInt(range[1], 10) : extractDayValue(remainder);
        const end = range ? parseInt(range[2], 10) : start;
        const lengths = monthLengthsFor(calendarConfig, year);
        if (!Number.isInteger(start) || !Number.isInteger(end) || index >= lengths.length) continue;
        if (start < 1 || start > lengths[index] || end < 1 || end > lengths[index]) continue;
        let prefix = 0;
        for (let i = 0; i < index; i++) prefix += lengths[i];
        return { startDay: prefix + start, endDay: prefix + end };
    }
    return null;
}
