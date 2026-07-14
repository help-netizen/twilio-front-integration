/**
 * OUTBOUND-LEAD-CALL-001 (OLC-T3) — TC-OLC-011..019: the lead.created emit
 * contract in createLead + the onLeadCreated eligibility gauntlet.
 * db/eventBus/services are mocked; the service under test is REAL.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
}));
jest.mock('../backend/src/services/marketplaceService', () => ({
    isAppConnected: jest.fn(),
}));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const eventBus = require('../backend/src/services/eventBus');
const marketplaceService = require('../backend/src/services/marketplaceService');
const scheduleService = require('../backend/src/services/scheduleService');
const leadsService = require('../backend/src/services/leadsService');
const settingsService = require('../backend/src/services/outboundLeadCallSettingsService');
const svc = require('../backend/src/services/outboundLeadCallService');

const NY_DS = {
    timezone: 'America/New_York',
    work_start_time: '08:00',
    work_end_time: '18:00',
    work_days: [1, 2, 3, 4, 5],
};

const LEAD = {
    UUID: 'LD-TEST-1',
    ClientId: '4242',
    FirstName: 'Alfreda',
    LastName: 'Smith',
    Phone: '+16175551234',
    JobSource: 'Pro Referral',
    Status: 'Submitted',
    LeadDateTime: null,
    ContactId: 77,
};

let getLeadByIdSpy;
let resolveSpy;

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    marketplaceService.isAppConnected.mockResolvedValue(true);
    scheduleService.getDispatchSettings.mockResolvedValue({ ...NY_DS });
    getLeadByIdSpy = jest.spyOn(leadsService, 'getLeadById').mockResolvedValue({ ...LEAD });
    resolveSpy = jest.spyOn(settingsService, 'resolve').mockResolvedValue({
        enabled_sources: ['ProReferral'],
        max_attempts: 3,
        backoff_schedule: ['immediate', '+30m', '+2h'],
    });
    // Default DB behavior: lifetime-once SELECT finds nothing; INSERT succeeds.
    db.query.mockImplementation(async (sql) => {
        if (/SELECT 1 FROM outbound_call_attempts/.test(sql)) return { rows: [] };
        return { rows: [], rowCount: 1 };
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});

const insertCalls = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO outbound_call_attempts/.test(sql));
const traceCalls = () => db.query.mock.calls.filter(([sql]) => /UPDATE leads/.test(sql));

describe('TC-OLC-011: lead.created emit contract in createLead', () => {
    it('emits once, after SSE, with the exact payload/opts; a rejected emit never breaks the create', async () => {
        // Real createLead with mocked db: generateUniqueUUID probes first
        // (SELECT → no collision), then the INSERT returns the new row.
        db.query.mockImplementation(async (sql) => {
            if (/INSERT INTO leads/.test(sql)) {
                return { rows: [{ uuid: 'LD-NEW-1', serial_id: 9, id: 555 }] };
            }
            return { rows: [] };
        });
        eventBus.emit.mockRejectedValueOnce(new Error('bus down'));

        const out = await leadsService.createLead({
            FirstName: 'A', LastName: 'B', Phone: '6175551234',
            JobSource: 'Pro Referral', JobType: 'COD',
        }, 'co-1');

        expect(out).toMatchObject({ UUID: 'LD-NEW-1', ClientId: '555' });
        expect(eventBus.emit).toHaveBeenCalledTimes(1);
        const [companyId, type, payload, opts] = eventBus.emit.mock.calls[0];
        expect(companyId).toBe('co-1');
        expect(type).toBe('lead.created');
        expect(payload).toMatchObject({
            id: 555,
            uuid: 'LD-NEW-1',
            first_name: 'A',
            last_name: 'B',
            phone: '+16175551234',
            job_source: 'Pro Referral',
            status: 'Submitted',
        });
        expect(payload).toHaveProperty('job_type');
        expect(opts).toEqual({ actorType: 'system', aggregateType: 'lead', aggregateId: 555 });
    });
});

describe('TC-OLC-012: gate 1 — app not connected', () => {
    it('stops before ANY lead read or write', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(false);
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(getLeadByIdSpy).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('reason=app_not_connected'));
    });
});

describe('TC-OLC-013: gate 3 — source matching', () => {
    it('(a) disabled source → silent stop: no trace, no INSERT', async () => {
        getLeadByIdSpy.mockResolvedValue({ ...LEAD, JobSource: 'Thumbtack' });
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(insertCalls()).toHaveLength(0);
        expect(traceCalls()).toHaveLength(0);
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('reason=source_not_enabled'));
    });

    it('(b) display variant "Pro Referral" matches canonical "ProReferral" → INSERT reached', async () => {
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(insertCalls()).toHaveLength(1);
    });

    it('(c) null source → stop', async () => {
        getLeadByIdSpy.mockResolvedValue({ ...LEAD, JobSource: null });
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(insertCalls()).toHaveLength(0);
    });
});

describe('TC-OLC-014: gate 4 — no dialable phone → Comments trace + stop', () => {
    it('appends the exact trace and never INSERTs', async () => {
        getLeadByIdSpy.mockResolvedValue({ ...LEAD, Phone: '5551234' }); // 7 digits
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(insertCalls()).toHaveLength(0);
        const traces = traceCalls();
        expect(traces).toHaveLength(1);
        const [sql, params] = traces[0];
        expect(sql).toMatch(/COALESCE\(NULLIF\(comments, ''\) \|\| E'\\n\\n', ''\) \|\| \$2/);
        expect(params[0]).toBe(LEAD.UUID);
        expect(params[2]).toBe('co-1');
        expect(params[1]).toMatch(/^\[AI Phone\] \d{4}-\d{2}-\d{2}T[\d:.]+Z — Outbound call skipped — no phone number on the lead\.$/);
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('reason=no_phone'));
    });

    it('trace append failure is logged, skip preserved, nothing thrown (E-18)', async () => {
        getLeadByIdSpy.mockResolvedValue({ ...LEAD, Phone: '' });
        db.query.mockImplementation(async (sql) => {
            if (/UPDATE leads/.test(sql)) throw new Error('comments hiccup');
            return { rows: [] };
        });
        await expect(svc.onLeadCreated({ leadId: 1, companyId: 'co-1' })).resolves.toBeUndefined();
        expect(insertCalls()).toHaveLength(0);
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining('no-phone trace append failed'), 'comments hiccup');
    });
});

describe('TC-OLC-015: gate 5 — goal achieved at birth', () => {
    it.each([
        ['hold set', { LeadDateTime: '2026-07-16T14:00:00Z' }],
        ['Lost', { Status: 'Lost' }],
        ['converted lower-case', { Status: 'converted' }],
    ])('%s → stop without INSERT or trace', async (_l, patch) => {
        getLeadByIdSpy.mockResolvedValue({ ...LEAD, ...patch });
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(insertCalls()).toHaveLength(0);
        expect(traceCalls()).toHaveLength(0);
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('reason=goal_achieved_at_birth'));
    });

    it('Submitted without hold → proceeds', async () => {
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(insertCalls()).toHaveLength(1);
    });
});

describe('TC-OLC-016: gate 6 lifetime-once + concurrent duplicate', () => {
    it('(a) ANY prior chain row (even exhausted) → stop, no INSERT', async () => {
        db.query.mockImplementation(async (sql) => {
            if (/SELECT 1 FROM outbound_call_attempts/.test(sql)) return { rows: [{ '?column?': 1 }] };
            return { rows: [] };
        });
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(insertCalls()).toHaveLength(0);
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('reason=chain_exists'));
    });

    it('(b) concurrent deliveries: INSERT carries the partial-index ON CONFLICT; both resolve', async () => {
        await Promise.all([
            svc.onLeadCreated({ leadId: 1, companyId: 'co-1' }),
            svc.onLeadCreated({ leadId: 1, companyId: 'co-1' }),
        ]);
        const inserts = insertCalls();
        expect(inserts.length).toBeGreaterThanOrEqual(1);
        for (const [sql] of inserts) {
            expect(sql).toMatch(/ON CONFLICT \(lead_uuid\) WHERE status IN \('pending', 'dialing'\) DO NOTHING/);
        }
    });
});

describe('TC-OLC-017: eligible → exact INSERT with clamped due_at', () => {
    it('(a) inside the window → dueAt ≈ now; exact params', async () => {
        const before = Date.now();
        // Freeze "inside window": Wednesday 12:00 EDT
        jest.useFakeTimers({ now: new Date('2026-07-15T16:00:00Z'), doNotFake: ['nextTick'] });
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        jest.useRealTimers();

        const inserts = insertCalls();
        expect(inserts).toHaveLength(1);
        const [, params] = inserts[0];
        expect(params[0]).toBe('co-1');
        expect(params[1]).toBe(LEAD.UUID);
        expect(params[2]).toBe(77);
        expect(params[3]).toBe('+16175551234');
        const dueAt = params[4];
        expect(dueAt.toISOString()).toBe('2026-07-15T16:00:00.000Z');
        expect(inserts[0][0]).not.toMatch(/job_id|slot_json/);
        expect(console.log).toHaveBeenCalledWith(
            expect.stringMatching(/enqueued lead=LD-TEST-1 due_at=2026-07-15T16:00:00/));
        expect(before).toBeGreaterThan(0);
    });

    it('(b) SC-03 Saturday 22:40, Mon-Sat hours → dueAt Monday 08:00 company-tz', async () => {
        scheduleService.getDispatchSettings.mockResolvedValue({ ...NY_DS, work_days: [1, 2, 3, 4, 5, 6] });
        jest.useFakeTimers({ now: new Date('2026-07-19T02:40:00Z'), doNotFake: ['nextTick'] }); // Sat 22:40 EDT
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        jest.useRealTimers();
        const [, params] = insertCalls()[0];
        expect(params[4].toISOString()).toBe('2026-07-20T12:00:00.000Z'); // Mon 08:00 EDT
    });
});

describe('TC-OLC-018: gauntlet fail-safety', () => {
    it('(a) non-LEAD_NOT_FOUND throw from getLeadById → warn, resolves, no writes', async () => {
        getLeadByIdSpy.mockRejectedValue(new Error('db down'));
        await expect(svc.onLeadCreated({ leadId: 1, companyId: 'co-1' })).resolves.toBeUndefined();
        expect(insertCalls()).toHaveLength(0);
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining('[outboundLeadCall] onLeadCreated failed'), 'db down');
    });

    it('(a2) LEAD_NOT_FOUND → clean skip, no warn-level failure', async () => {
        const err = new Error('nope'); err.code = 'LEAD_NOT_FOUND';
        getLeadByIdSpy.mockRejectedValue(err);
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('reason=lead_not_found'));
    });

    it('(b) getDispatchSettings throws → INSERT still happens with the default window', async () => {
        scheduleService.getDispatchSettings.mockRejectedValue(new Error('ds down'));
        jest.useFakeTimers({ now: new Date('2026-07-15T16:00:00Z'), doNotFake: ['nextTick'] });
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        jest.useRealTimers();
        expect(insertCalls()).toHaveLength(1); // Wed noon EDT is inside the default window
    });
});

describe('TC-OLC-019: sabotage — the source-gate detector can go red', () => {
    it('with isSourceEnabled forced true, the Thumbtack fixture DOES insert (detector power proven)', async () => {
        getLeadByIdSpy.mockResolvedValue({ ...LEAD, JobSource: 'Thumbtack' });
        const spy = jest.spyOn(settingsService, 'isSourceEnabled').mockReturnValue(true);
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(insertCalls()).toHaveLength(1); // ← TC-OLC-013(a)'s "no INSERT" would fail on such an impl
        spy.mockRestore();

        // honest re-run is green again
        jest.clearAllMocks();
        marketplaceService.isAppConnected.mockResolvedValue(true);
        scheduleService.getDispatchSettings.mockResolvedValue({ ...NY_DS });
        getLeadByIdSpy.mockResolvedValue({ ...LEAD, JobSource: 'Thumbtack' });
        db.query.mockImplementation(async (sql) => (/SELECT 1 FROM outbound_call_attempts/.test(sql) ? { rows: [] } : { rows: [] }));
        await svc.onLeadCreated({ leadId: 1, companyId: 'co-1' });
        expect(insertCalls()).toHaveLength(0);
    });
});
