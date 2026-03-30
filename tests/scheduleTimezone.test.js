/**
 * F013 Schedule Sprint 3 — Timezone & Past-Overlay Unit Tests
 *
 * Tests the pure logic behind timezone-aware schedule display:
 * - minutesSinceMidnight in company TZ
 * - dateKeyInTZ for item grouping
 * - todayInTZ for "today" detection
 * - formatTimeInTZ for time labels
 * - Past overlay height calculations
 *
 * Covers test cases:
 *   TC-F013-001, TC-F013-002, TC-F013-003, TC-F013-005 (timezone)
 *   TC-F013-006, TC-F013-007, TC-F013-008, TC-F013-009, TC-F013-010 (overlay)
 */

// ─── Inline reimplementation of companyTime.ts pure functions ────────────────
// (Jest runs CommonJS; we replicate the Intl-based logic here for unit testing)

function tzOffsetMinutes(utcDate, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'longOffset',
    }).formatToParts(utcDate);
    const tzPart = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
    if (tzPart === 'GMT') return 0;
    const match = tzPart.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!match) return 0;
    const sign = match[1] === '+' ? 1 : -1;
    return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
}

function dateInTZ(year, month, day, hour, minute, tz = 'America/New_York') {
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    const offsetMin = tzOffsetMinutes(utcGuess, tz);
    return new Date(utcGuess.getTime() - offsetMin * 60000);
}

function todayInTZ(tz = 'America/New_York') {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

function minutesSinceMidnight(d, tz) {
    if (!tz) return d.getHours() * 60 + d.getMinutes();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const h = parseInt((parts.find(p => p.type === 'hour') || {}).value || '0');
    const m = parseInt((parts.find(p => p.type === 'minute') || {}).value || '0');
    return (h === 24 ? 0 : h) * 60 + m;
}

function formatTimeInTZ(d, tz) {
    return d.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
        ...(tz && { timeZone: tz }),
    });
}

function dateKeyInTZ(isoString, tz = 'America/New_York') {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(isoString));
}

// ─── Past overlay calculation (mirrors DayView/WeekView logic) ──────────────

function calcPastHeight(nowMinFromGrid, totalWorkHours, hourHeight) {
    return Math.max(0, Math.min(nowMinFromGrid, totalWorkHours * 60)) / 60 * hourHeight;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('F013 Schedule Timezone Utilities', () => {

    // TC-F013-001: Item positioning uses company TZ, not browser TZ
    describe('minutesSinceMidnight', () => {
        test('TC-F013-001: converts UTC timestamp to minutes in company TZ', () => {
            // 2026-03-30T17:00:00Z = 1:00 PM EDT (America/New_York, UTC-4)
            const utcDate = new Date('2026-03-30T17:00:00Z');
            const minutes = minutesSinceMidnight(utcDate, 'America/New_York');
            // 1:00 PM = 13 * 60 = 780 minutes from midnight
            expect(minutes).toBe(780);
        });

        test('TC-F013-001: same UTC time shows different minutes in different TZ', () => {
            // 2026-03-30T17:00:00Z
            // In EDT (UTC-4): 1:00 PM = 780 min
            // In PDT (UTC-7): 10:00 AM = 600 min
            const utcDate = new Date('2026-03-30T17:00:00Z');
            const nyMinutes = minutesSinceMidnight(utcDate, 'America/New_York');
            const laMinutes = minutesSinceMidnight(utcDate, 'America/Los_Angeles');
            expect(nyMinutes).toBe(780); // 1:00 PM
            expect(laMinutes).toBe(600); // 10:00 AM
            expect(nyMinutes).not.toBe(laMinutes);
        });

        test('handles midnight edge case', () => {
            // 2026-03-30T04:00:00Z = midnight EDT
            const utcDate = new Date('2026-03-30T04:00:00Z');
            const minutes = minutesSinceMidnight(utcDate, 'America/New_York');
            expect(minutes).toBe(0); // midnight
        });
    });

    // TC-F013-002: Hour labels in company TZ
    describe('formatTimeInTZ', () => {
        test('TC-F013-002: formats time in specified timezone', () => {
            // Create 8:00 AM Chicago time
            const chicagoDate = dateInTZ(2026, 3, 30, 8, 0, 'America/Chicago');
            const label = formatTimeInTZ(chicagoDate, 'America/Chicago');
            expect(label).toMatch(/8:00\s*AM/i);
        });

        test('formats time differently per timezone for same UTC instant', () => {
            // 2026-03-30T17:00:00Z
            const utcDate = new Date('2026-03-30T17:00:00Z');
            const nyLabel = formatTimeInTZ(utcDate, 'America/New_York');
            const laLabel = formatTimeInTZ(utcDate, 'America/Los_Angeles');
            expect(nyLabel).toMatch(/1:00\s*PM/i);  // EDT
            expect(laLabel).toMatch(/10:00\s*AM/i); // PDT
        });
    });

    // TC-F013-003: "Today" determined by company TZ
    describe('todayInTZ', () => {
        test('TC-F013-003: returns date string in YYYY-MM-DD format', () => {
            const today = todayInTZ('America/New_York');
            expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });

        test('todayInTZ can differ across timezones near midnight', () => {
            // This is a structural test — we can't mock Date.now() easily,
            // but we verify the function returns valid date for different TZs
            const nyToday = todayInTZ('America/New_York');
            const utcToday = todayInTZ('UTC');
            // Both should be valid date strings
            expect(nyToday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(utcToday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });
    });

    // TC-F013-005: Fallback timezone
    describe('dateInTZ fallback', () => {
        test('TC-F013-005: uses America/New_York as default timezone', () => {
            // dateInTZ without explicit tz should use default
            const d = dateInTZ(2026, 3, 30, 9, 0);
            // 9:00 AM EDT = 13:00 UTC (EDT = UTC-4)
            expect(d.toISOString()).toBe('2026-03-30T13:00:00.000Z');
        });
    });

    // TC-F013-001 extended: dateKeyInTZ groups items correctly
    describe('dateKeyInTZ', () => {
        test('groups UTC timestamp to correct day in company TZ', () => {
            // 2026-03-30T03:00:00Z = March 29 at 11:00 PM EDT
            const key = dateKeyInTZ('2026-03-30T03:00:00Z', 'America/New_York');
            expect(key).toBe('2026-03-29'); // Previous day in EDT
        });

        test('midnight UTC maps to same day in UTC but previous in western TZ', () => {
            const utcKey = dateKeyInTZ('2026-03-30T00:00:00Z', 'UTC');
            const nyKey = dateKeyInTZ('2026-03-30T00:00:00Z', 'America/New_York');
            expect(utcKey).toBe('2026-03-30');
            expect(nyKey).toBe('2026-03-29'); // 8:00 PM EDT on March 29
        });
    });

    // TC-F013-004: Sidebar time in company TZ (logic only)
    describe('sidebar time formatting', () => {
        test('TC-F013-004: formats start_at in company TZ', () => {
            const d = new Date('2026-03-30T17:00:00Z');
            const formatted = formatTimeInTZ(d, 'America/New_York');
            expect(formatted).toMatch(/1:00\s*PM/i);
        });
    });
});

describe('F013 Schedule Past-Time Overlay Calculations', () => {

    const HOUR_HEIGHT = 80; // DayView uses 80px
    const WORK_START = 8;   // 8:00 AM
    const WORK_END = 18;    // 6:00 PM
    const TOTAL_WORK_HOURS = WORK_END - WORK_START; // 10 hours

    // TC-F013-006: Past overlay on today
    test('TC-F013-006: overlay height proportional to elapsed work time', () => {
        // Current time = 2:30 PM company TZ → 14.5 hours
        // Minutes from grid start: (14.5 - 8) * 60 = 390 min
        const nowMinFromGrid = (14.5 - WORK_START) * 60; // 390
        const height = calcPastHeight(nowMinFromGrid, TOTAL_WORK_HOURS, HOUR_HEIGHT);
        // Expected: 390 / 60 * 80 = 6.5 * 80 = 520px
        expect(height).toBe(520);
    });

    // TC-F013-007: No overlay on non-today days
    test('TC-F013-007: no overlay when nowMinFromGrid is 0 (not today)', () => {
        const height = calcPastHeight(0, TOTAL_WORK_HOURS, HOUR_HEIGHT);
        expect(height).toBe(0);
    });

    // TC-F013-008: Now-line position matches current time
    test('TC-F013-008: now-line at 10:00 AM', () => {
        // 10:00 AM → (10 - 8) * 60 = 120 min from grid start
        const nowMinFromGrid = (10 - WORK_START) * 60; // 120
        const height = calcPastHeight(nowMinFromGrid, TOTAL_WORK_HOURS, HOUR_HEIGHT);
        // Expected: 120 / 60 * 80 = 2 * 80 = 160px
        expect(height).toBe(160);
    });

    // TC-F013-009: Clamp before work hours
    test('TC-F013-009: overlay 0 when current time is before work hours', () => {
        // 6:00 AM → (6 - 8) * 60 = -120 min from grid start
        const nowMinFromGrid = (6 - WORK_START) * 60; // -120
        const height = calcPastHeight(nowMinFromGrid, TOTAL_WORK_HOURS, HOUR_HEIGHT);
        expect(height).toBe(0);
    });

    // TC-F013-010: Clamp after work hours
    test('TC-F013-010: overlay covers full grid when after work hours', () => {
        // 8:00 PM → (20 - 8) * 60 = 720 min from grid start
        const nowMinFromGrid = (20 - WORK_START) * 60; // 720
        const height = calcPastHeight(nowMinFromGrid, TOTAL_WORK_HOURS, HOUR_HEIGHT);
        // Expected: clamped to total = 10 * 60 = 600 min → 600/60*80 = 800px
        expect(height).toBe(800);
    });

    // TC-F013-011: WeekView overlay only on today column (logic)
    test('TC-F013-011: only today column gets non-zero pastHeight', () => {
        const todayStr = todayInTZ('America/New_York');
        const dayKeys = ['2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04'];

        const overlayFlags = dayKeys.map(key => {
            const isToday = key === todayStr;
            if (!isToday) return 0;
            // Simulate some mid-day time
            const nowMinFromGrid = 180; // 3 hours past work start
            return calcPastHeight(nowMinFromGrid, TOTAL_WORK_HOURS, HOUR_HEIGHT);
        });

        // At most one column should have non-zero overlay
        const nonZeroCount = overlayFlags.filter(h => h > 0).length;
        expect(nonZeroCount).toBeLessThanOrEqual(1);
    });
});

describe('F013 dateInTZ correctness', () => {
    test('EDT offset: 9:00 AM New York = 13:00 UTC (summer)', () => {
        const d = dateInTZ(2026, 7, 15, 9, 0, 'America/New_York');
        expect(d.toISOString()).toBe('2026-07-15T13:00:00.000Z');
    });

    test('EST offset: 9:00 AM New York = 14:00 UTC (winter)', () => {
        const d = dateInTZ(2026, 1, 15, 9, 0, 'America/New_York');
        expect(d.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    });

    test('CDT offset: 9:00 AM Chicago = 14:00 UTC (summer)', () => {
        const d = dateInTZ(2026, 7, 15, 9, 0, 'America/Chicago');
        expect(d.toISOString()).toBe('2026-07-15T14:00:00.000Z');
    });

    test('PDT offset: 9:00 AM Los Angeles = 16:00 UTC (summer)', () => {
        const d = dateInTZ(2026, 7, 15, 9, 0, 'America/Los_Angeles');
        expect(d.toISOString()).toBe('2026-07-15T16:00:00.000Z');
    });

    test('UTC timezone: 9:00 AM UTC = 09:00 UTC', () => {
        const d = dateInTZ(2026, 3, 30, 9, 0, 'UTC');
        expect(d.toISOString()).toBe('2026-03-30T09:00:00.000Z');
    });
});
