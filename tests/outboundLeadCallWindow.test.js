/**
 * OUTBOUND-LEAD-CALL-001 (OLC-T3) — TC-OLC-003..010: pure helpers.
 * normalizeDialablePhone matrix, work-window boundaries, nextWindowStart,
 * clamp identity, ladder arithmetic (+clamp), DST, sanitization+termination,
 * and the sabotage detector (assertClamped can go red).
 *
 * All instants are constructed as UTC ISO strings for America/New_York
 * fixtures — EDT (UTC-4) in July, EST (UTC-5) in January — so the suite is
 * process-TZ independent (run under TZ=UTC and TZ=America/Los_Angeles alike).
 */

const svc = require('../backend/src/services/outboundLeadCallService');

const NY = {
    timezone: 'America/New_York',
    work_start_time: '08:00',
    work_end_time: '18:00',
    work_days: [1, 2, 3, 4, 5],
};

// Invariant checker (TC-OLC-010): result must be INSIDE the work window.
function assertClamped(result, ds) {
    if (!svc.isWithinWorkWindow(result, ds)) {
        throw new Error(`not clamped: ${result.toISOString()}`);
    }
}

describe('TC-OLC-003: normalizeDialablePhone matrix', () => {
    it.each([
        ['6175551234', '+16175551234'],
        ['16175551234', '+16175551234'],
        ['+1 (617) 555-1234', '+16175551234'],
        ['+447911123456', '+447911123456'],
        ['+123456789', null],       // + but only 9 digits
        ['5551234', null],          // 7 digits
        ['26175551234', null],      // 11 digits not starting 1, no +
        ['garbage', null],
        ['', null],
        [null, null],
    ])('normalizeDialablePhone(%j) → %j', (input, expected) => {
        expect(svc.normalizeDialablePhone(input)).toBe(expected);
    });
});

describe('TC-OLC-004: isWithinWorkWindow day/week boundaries', () => {
    // Wed 2026-07-15 (EDT = UTC-4). Local HH:MM → UTC HH+4.
    it.each([
        ['Wed 12:00 local', '2026-07-15T16:00:00Z', true],
        ['Wed 07:59 local', '2026-07-15T11:59:00Z', false],
        ['Wed 08:00 local exactly', '2026-07-15T12:00:00Z', true],
        ['Wed 17:59 local', '2026-07-15T21:59:00Z', true],
        ['Wed 18:00 local exactly (dial must START before end)', '2026-07-15T22:00:00Z', false],
        ['Sat 12:00 local', '2026-07-18T16:00:00Z', false],
    ])('%s → %s', (_label, iso, expected) => {
        expect(svc.isWithinWorkWindow(new Date(iso), NY)).toBe(expected);
    });
});

describe('TC-OLC-005: nextWindowStart', () => {
    it('(a) weekday before hours → SAME-DAY 08:00 local', () => {
        const from = new Date('2026-07-15T10:12:00Z'); // Wed 06:12 EDT
        expect(svc.nextWindowStart(from, NY).toISOString()).toBe('2026-07-15T12:00:00.000Z');
    });

    it('(b) weekday after hours → next-day 08:00', () => {
        const from = new Date('2026-07-15T23:30:00Z'); // Wed 19:30 EDT
        expect(svc.nextWindowStart(from, NY).toISOString()).toBe('2026-07-16T12:00:00.000Z');
    });

    it('(c) SC-03: Sat 22:40 with Mon-Sat work_days → MONDAY 08:00 (Sun skipped)', () => {
        const ds = { ...NY, work_days: [1, 2, 3, 4, 5, 6] };
        const from = new Date('2026-07-19T02:40:00Z'); // Sat 2026-07-18 22:40 EDT
        expect(svc.nextWindowStart(from, ds).toISOString()).toBe('2026-07-20T12:00:00.000Z'); // Mon
    });

    it('(d) from INSIDE the window → NEXT window start strictly after (tomorrow), not today\'s past one', () => {
        const from = new Date('2026-07-15T16:00:00Z'); // Wed 12:00 EDT
        expect(svc.nextWindowStart(from, NY).toISOString()).toBe('2026-07-16T12:00:00.000Z');
    });

    it('(e) Friday 18:00 exactly, Mon-Fri → Monday 08:00', () => {
        const from = new Date('2026-07-17T22:00:00Z'); // Fri 18:00 EDT
        expect(svc.nextWindowStart(from, NY).toISOString()).toBe('2026-07-20T12:00:00.000Z');
    });
});

describe('TC-OLC-006: clampIntoWorkWindow identity inside the window', () => {
    it('inside → the SAME instant back', () => {
        const inside = new Date('2026-07-15T16:00:00Z');
        expect(svc.clampIntoWorkWindow(inside, NY)).toBe(inside);
    });

    it('outside → exactly nextWindowStart', () => {
        const outside = new Date('2026-07-15T23:30:00Z');
        expect(svc.clampIntoWorkWindow(outside, NY).toISOString())
            .toBe(svc.nextWindowStart(outside, NY).toISOString());
    });
});

describe('TC-OLC-007: computeLeadNextDueAt ladder arithmetic + clamp', () => {
    const settings = { backoff_schedule: ['immediate', '+30m', '+2h'], max_attempts: 3 };
    const now = new Date('2026-07-15T14:00:00Z'); // Wed 10:00 EDT

    it('(a) justFailedNo=1 → now+30m (0-based NEXT-attempt token, parts convention)', () => {
        expect(svc.computeLeadNextDueAt(1, settings, NY, now).toISOString()).toBe('2026-07-15T14:30:00.000Z');
    });

    it('(b) justFailedNo=2 → now+2h', () => {
        expect(svc.computeLeadNextDueAt(2, settings, NY, now).toISOString()).toBe('2026-07-15T16:00:00.000Z');
    });

    it('(c) immediate → now', () => {
        expect(svc.computeLeadNextDueAt(0, settings, NY, now).toISOString()).toBe(now.toISOString());
    });

    it('(d) generic +45m token', () => {
        expect(svc.computeLeadNextDueAt(0, { backoff_schedule: ['+45m'] }, NY, now).toISOString())
            .toBe('2026-07-15T14:45:00.000Z');
    });

    it('(e)/(f) unknown token and missing index → now (conservative)', () => {
        expect(svc.computeLeadNextDueAt(0, { backoff_schedule: ['tomorrow'] }, NY, now).toISOString())
            .toBe(now.toISOString());
        expect(svc.computeLeadNextDueAt(7, settings, NY, now).toISOString()).toBe(now.toISOString());
    });

    it('(g) clamp: fail 17:45 local, +30m → 18:15 outside → next business day 08:00', () => {
        const at = new Date('2026-07-15T21:45:00Z'); // Wed 17:45 EDT
        const out = svc.computeLeadNextDueAt(1, settings, NY, at);
        expect(out.toISOString()).toBe('2026-07-16T12:00:00.000Z');
        assertClamped(out, NY);
    });

    it('(h) clamp: Friday 17:00 +2h → 19:00 → Monday 08:00', () => {
        const at = new Date('2026-07-17T21:00:00Z'); // Fri 17:00 EDT
        const out = svc.computeLeadNextDueAt(2, settings, NY, at);
        expect(out.toISOString()).toBe('2026-07-20T12:00:00.000Z');
        assertClamped(out, NY);
    });
});

describe('TC-OLC-008: DST boundaries (America/New_York)', () => {
    it('(a) spring-forward night: +2h across the gap is a valid forward instant; window opens 08:00 EDT', () => {
        // 2026-03-08 01:30 EST (UTC-5) = 06:30Z; 02:00→03:00 local gap.
        const at = new Date('2026-03-08T06:30:00Z'); // Sunday — outside work days anyway
        const out = svc.computeLeadNextDueAt(2, { backoff_schedule: ['immediate', '+30m', '+2h'] }, NY, at);
        // +2h = 08:30Z (= 04:30 EDT after the jump), Sunday → clamp to Monday 08:00 EDT (UTC-4).
        expect(out.toISOString()).toBe('2026-03-09T12:00:00.000Z');
        expect(out.getTime()).toBeGreaterThan(at.getTime());
    });

    it('(a2) nextWindowStart lands at 08:00 wall-clock EDT (UTC-4), not EST math', () => {
        const from = new Date('2026-03-08T06:30:00Z');
        expect(svc.nextWindowStart(from, NY).toISOString()).toBe('2026-03-09T12:00:00.000Z');
    });

    it('(b) fall-back: window start is 08:00 EST (UTC-5) with no hour drift; +2h stays monotonic', () => {
        // 2026-11-01 fall-back (Sunday). From Sat 2026-10-31 20:00 EDT = 2026-11-01T00:00Z.
        const from = new Date('2026-11-01T00:00:00Z');
        // Next workday = Monday 2026-11-02, 08:00 EST = 13:00Z.
        expect(svc.nextWindowStart(from, NY).toISOString()).toBe('2026-11-02T13:00:00.000Z');
        const plus2h = svc.computeLeadNextDueAt(2, { backoff_schedule: ['immediate', '+30m', '+2h'] }, NY, from);
        expect(plus2h.getTime()).toBeGreaterThan(from.getTime());
    });
});

describe('TC-OLC-009: dispatch-settings sanitization + termination guarantee', () => {
    it.each([
        [{ work_days: [] }],
        [{ work_days: null }],
        [{ work_days: ['mon'] }],
        [{ work_days: [9] }],
    ])('bad work_days %j → weekdays fallback', (patch) => {
        const s = svc.sanitizeDispatchSettings({ ...NY, ...patch });
        expect(s.work_days).toEqual([1, 2, 3, 4, 5]);
    });

    it('bad/reversed hours → 08:00/18:00; falsy tz → America/New_York', () => {
        expect(svc.sanitizeDispatchSettings({ work_start_time: '25:99', work_end_time: 'x' }).work_start_time).toBe('08:00');
        const rev = svc.sanitizeDispatchSettings({ work_start_time: '18:00', work_end_time: '08:00' });
        expect(rev.work_start_time).toBe('08:00');
        expect(rev.work_end_time).toBe('18:00');
        expect(svc.sanitizeDispatchSettings({ timezone: '' }).timezone).toBe('America/New_York');
        // '8:30' is valid per the 1-2 digit hour regex
        expect(svc.sanitizeDispatchSettings({ work_start_time: '8:30', work_end_time: '17:00' }).work_start_time).toBe('8:30');
    });

    it('termination invariant: ANY config → strictly-after result within from+14d (or the +24h fallback)', () => {
        const from = new Date('2026-07-15T16:00:00Z');
        const fuzz = [
            {}, null, { work_days: [0] }, { work_days: [6] },
            { work_start_time: '00:00', work_end_time: '00:01' },
            { timezone: 'Pacific/Kiritimati' }, { timezone: 'Etc/GMT+12' },
            { work_days: [3], work_start_time: '23:00', work_end_time: '23:59' },
        ];
        for (const cfg of fuzz) {
            const out = svc.nextWindowStart(from, cfg);
            expect(out.getTime()).toBeGreaterThan(from.getTime());
            expect(out.getTime()).toBeLessThanOrEqual(from.getTime() + 15 * 24 * 3600 * 1000);
        }
    });
});

describe('TC-OLC-010: sabotage — the clamp detector can go red', () => {
    it('(a) honest ladder results pass assertClamped', () => {
        const at = new Date('2026-07-15T21:45:00Z');
        const out = svc.computeLeadNextDueAt(1, { backoff_schedule: ['immediate', '+30m', '+2h'] }, NY, at);
        expect(() => assertClamped(out, NY)).not.toThrow();
    });

    it('(b) a deliberately UNCLAMPED value (17:45+30m=18:15) trips the detector', () => {
        const unclamped = new Date('2026-07-15T22:15:00Z'); // Wed 18:15 EDT
        expect(() => assertClamped(unclamped, NY)).toThrow(/not clamped/);
    });
});

describe('TC-OLC-011: parseLeadContext (appliance context the agent confirms)', () => {
    it('(a) structured pipe-delimited comments → Unit/Brand/Problem', () => {
        const out = svc.parseLeadContext({
            Comments: 'Unit: Refrigerator | Brand: Samsung | Age: 5 years | Problem: not cooling | Fee agreed: Yes',
        });
        expect(out).toEqual({ applianceType: 'Refrigerator', applianceBrand: 'Samsung', applianceProblem: 'not cooling' });
    });

    it('(b) job_type gives the unit when comments have none; the trailing verb is stripped', () => {
        expect(svc.parseLeadContext({ JobType: 'Dryer Repair' }).applianceType).toBe('Dryer');
        expect(svc.parseLeadContext({ JobType: 'Washer Installation' }).applianceType).toBe('Washer');
        // Comments Unit wins over job_type.
        expect(svc.parseLeadContext({ JobType: 'Dryer Repair', Comments: 'Unit: Oven' }).applianceType).toBe('Oven');
    });

    it('(c) synonyms — Make/Manufacturer→brand, Issue/Symptom→problem, Appliance/Type→unit', () => {
        expect(svc.parseLeadContext({ Comments: 'Make: LG | Issue: won\'t drain' }))
            .toEqual({ applianceType: null, applianceBrand: 'LG', applianceProblem: "won't drain" });
        expect(svc.parseLeadContext({ Comments: 'Appliance: Microwave | Symptom: sparks' }))
            .toEqual({ applianceType: 'Microwave', applianceBrand: null, applianceProblem: 'sparks' });
    });

    it('(d) no structured problem → free-text Description is the reported issue', () => {
        expect(svc.parseLeadContext({ Description: 'Dishwasher leaks from the door' }).applianceProblem)
            .toBe('Dishwasher leaks from the door');
        // A structured Problem beats the Description fallback.
        expect(svc.parseLeadContext({ Comments: 'Problem: no heat', Description: 'ignore me' }).applianceProblem)
            .toBe('no heat');
    });

    it('(e) placeholder junk (unknown / n/a / - / ?) is dropped, not spoken', () => {
        expect(svc.parseLeadContext({ Comments: 'Unit: unknown | Brand: N/A | Problem: -' }))
            .toEqual({ applianceType: null, applianceBrand: null, applianceProblem: null });
        expect(svc.parseLeadContext({ JobType: 'Repair' }).applianceType).toBeNull(); // verb-only → empty → null
    });

    it('(f) empty / garbage lead → all-null, never throws', () => {
        expect(svc.parseLeadContext({})).toEqual({ applianceType: null, applianceBrand: null, applianceProblem: null });
        expect(() => svc.parseLeadContext({ Comments: null, Description: null, JobType: null })).not.toThrow();
    });
});
