// ─── Company Timezone Utilities ──────────────────────────────────────────────
// All scheduling dates must be created in the company's timezone, not the
// browser's local timezone.  These helpers convert "wall-clock" date/time
// components in a named IANA timezone to proper UTC Date objects.

import { serverDate } from './serverClock';

const DEFAULT_TZ = 'America/New_York';

/**
 * Build a UTC `Date` that represents the given wall-clock time in `tz`.
 *
 * Example:
 *   dateInTZ(2026, 3, 29, 9, 0, 'America/New_York')
 *   → Date whose .toISOString() === "2026-03-29T13:00:00.000Z" (EDT = UTC-4)
 */
export function dateInTZ(
    year: number,
    month: number,       // 1-based (January = 1)
    day: number,
    hour: number,
    minute: number,
    tz: string = DEFAULT_TZ,
): Date {
    // 1. Create a UTC date with the nominal values
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

    // 2. Determine the UTC offset of `tz` at that instant
    const offsetMin = tzOffsetMinutes(utcGuess, tz);

    // 3. Shift so the wall-clock reading in `tz` equals the requested time
    return new Date(utcGuess.getTime() - offsetMin * 60_000);
}

/**
 * Today's date string ("YYYY-MM-DD") in the company timezone.
 */
export function todayInTZ(tz: string = DEFAULT_TZ): string {
    // en-CA locale formats as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(serverDate());
}

/**
 * Tomorrow's date components [year, month (1-based), day] in the company tz.
 */
export function tomorrowInTZ(tz: string = DEFAULT_TZ): [number, number, number] {
    const todayStr = todayInTZ(tz);
    const [y, m, d] = todayStr.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1)); // UTC, day overflow is fine
    return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
}

/**
 * Build a UTC Date for "tomorrow at HH:MM" in the company timezone.
 */
export function tomorrowAtInTZ(hour: number, minute: number, tz: string = DEFAULT_TZ): Date {
    const [y, m, d] = tomorrowInTZ(tz);
    return dateInTZ(y, m, d, hour, minute, tz);
}

/**
 * Minutes elapsed since midnight for `date` in the given timezone.
 * If tz is omitted, uses browser local time.
 */
export function minutesSinceMidnight(d: Date, tz?: string): number {
    if (!tz) return d.getHours() * 60 + d.getMinutes();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    // Intl hour12:false may return 24 for midnight
    return (h === 24 ? 0 : h) * 60 + m;
}

/**
 * Format a Date as a short time string ("9:00 AM") in the given timezone.
 */
export function formatTimeInTZ(d: Date, tz?: string): string {
    return d.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
        ...(tz && { timeZone: tz }),
    });
}

/**
 * Format a Date as full date + time string ("Mar 30, 2026 1:00 PM") in the given timezone.
 */
export function formatDateTimeInTZ(d: Date, tz?: string): string {
    return d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        ...(tz && { timeZone: tz }),
    });
}

/**
 * Get the date string "YYYY-MM-DD" for a UTC ISO date in the given timezone.
 * Useful for grouping items by day in company TZ.
 */
export function dateKeyInTZ(isoString: string, tz: string = DEFAULT_TZ): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(isoString));
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Return the UTC offset (in minutes, positive = east of UTC) for `tz` at the
 * given UTC instant.  Uses Intl.DateTimeFormat's `longOffset` output which
 * looks like "GMT-04:00" or "GMT+05:30".
 */
function tzOffsetMinutes(utcDate: Date, tz: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'longOffset',
    }).formatToParts(utcDate);

    const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || '';
    // "GMT" means UTC+0
    if (tzPart === 'GMT') return 0;
    const match = tzPart.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!match) return 0; // fallback — treat as UTC
    const sign = match[1] === '+' ? 1 : -1;
    return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
}
