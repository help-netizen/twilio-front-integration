// ─── Company Timezone Utilities ──────────────────────────────────────────────
// Backend equivalent of frontend/src/utils/companyTime.ts
// Creates UTC dates for wall-clock times in a named IANA timezone.

const DEFAULT_TZ = 'America/New_York';

/**
 * Build a UTC Date that represents the given wall-clock time in `tz`.
 *
 * @param {number} year
 * @param {number} month  1-based (January = 1)
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {string} [tz]   IANA timezone name
 * @returns {Date}
 */
function dateInTZ(year, month, day, hour, minute, tz = DEFAULT_TZ) {
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    const offsetMin = tzOffsetMinutes(utcGuess, tz);
    return new Date(utcGuess.getTime() - offsetMin * 60_000);
}

/**
 * Today's date string ("YYYY-MM-DD") in the given timezone.
 */
function todayInTZ(tz = DEFAULT_TZ) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/**
 * Tomorrow's date components [year, month (1-based), day] in the given tz.
 */
function tomorrowInTZ(tz = DEFAULT_TZ) {
    const todayStr = todayInTZ(tz);
    const [y, m, d] = todayStr.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
}

/**
 * Build a UTC Date for "tomorrow at HH:MM" in the given timezone.
 */
function tomorrowAtInTZ(hour, minute, tz = DEFAULT_TZ) {
    const [y, m, d] = tomorrowInTZ(tz);
    return dateInTZ(y, m, d, hour, minute, tz);
}

// ─── Internal ────────────────────────────────────────────────────────────────

function tzOffsetMinutes(utcDate, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'longOffset',
    }).formatToParts(utcDate);

    const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || '';
    if (tzPart === 'GMT') return 0;
    const match = tzPart.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!match) return 0;
    const sign = match[1] === '+' ? 1 : -1;
    return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
}

module.exports = { dateInTZ, todayInTZ, tomorrowInTZ, tomorrowAtInTZ };
