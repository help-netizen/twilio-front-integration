/**
 * OUTBOUND-LEAD-CALL-001 (OLC-T4) — TC-OLC-020..030, 032, 033.
 * Claim-time processing (processLeadAttempt), ladder (scheduleLeadRetryOr-
 * Exhaust), dispatcher tasks (createLeadCallTask), worker scenario dispatch,
 * and ★TC-OLC-029: the PARTS-REGRESSION sabotage gate over a mixed batch with
 * the golden placeCall fixture.
 *
 * Golden provenance: processAttempt (the parts path) is BYTE-UNTOUCHED by this
 * feature (git diff shows only the tick dispatch branch + one export). The
 * fixture tests/fixtures/parts-placecall-golden.json is captured from exactly
 * that unchanged path (WRITE_PARTS_GOLDEN=1 once, then frozen); every later
 * run deep-equals against the frozen file.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
    addNote: jest.fn(async () => ({})),
    getJobBalanceDue: jest.fn(),
}));
jest.mock('../backend/src/services/outboundCallService', () => ({
    placeCall: jest.fn(),
}));
jest.mock('../backend/src/services/outboundCallSettingsService', () => ({
    resolve: jest.fn(),
}));
jest.mock('../backend/src/services/groupRouting', () => ({
    isBusinessHours: jest.fn(),
}));
jest.mock('../backend/src/services/vapiCallTimelineService', () => ({
    recordPlacement: jest.fn(),
}));
jest.mock('../backend/src/services/partsCallService', () => ({
    isChainCanceled: jest.fn(),
    markRobotCallCanceled: jest.fn(),
}));
jest.mock('../backend/src/services/marketplaceService', () => ({
    isAppConnected: jest.fn(),
}));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(),
}));
jest.mock('../backend/src/services/agentSkills/skills/recommendSlots', () => ({
    run: jest.fn(),
}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(),
}));
jest.mock('../backend/src/services/companyProfileService', () => ({
    getProfile: jest.fn(),
}));
jest.mock('../backend/src/db/timelinesQueries', () => ({
    findOrCreateTimeline: jest.fn(),
    createTask: jest.fn(),
}));

const jobsService = require('../backend/src/services/jobsService');
const outboundCallService = require('../backend/src/services/outboundCallService');
const partsSettings = require('../backend/src/services/outboundCallSettingsService');
const groupRouting = require('../backend/src/services/groupRouting');
const vapiCallTimeline = require('../backend/src/services/vapiCallTimelineService');
const partsCallService = require('../backend/src/services/partsCallService');
const marketplaceService = require('../backend/src/services/marketplaceService');
const scheduleService = require('../backend/src/services/scheduleService');
const recommendSlots = require('../backend/src/services/agentSkills/skills/recommendSlots');
const eventService = require('../backend/src/services/eventService');
const companyProfileService = require('../backend/src/services/companyProfileService');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const leadsService = require('../backend/src/services/leadsService');
const leadSettings = require('../backend/src/services/outboundLeadCallSettingsService');
const worker = require('../backend/src/services/outboundCallWorker');
const svc = require('../backend/src/services/outboundLeadCallService');

const CO = '00000000-0000-0000-0000-000000000001';
const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'parts-placecall-golden.json');

const NY_DS = {
    timezone: 'America/New_York',
    work_start_time: '08:00',
    work_end_time: '18:00',
    work_days: [1, 2, 3, 4, 5],
};

const TOP_SLOT = {
    key: 'slot-1', label: 'Tue, Jul 21, 9–11am',
    date: '2026-07-21', start: '09:00', end: '11:00', techId: 't1',
};

function mkLeadAttempt(over = {}) {
    return {
        id: 700,
        company_id: CO,
        job_id: null,
        task_id: null,
        contact_id: 501,
        phone: '+16175551234',
        attempt_no: 1,
        status: 'dialing',
        scenario: 'lead_call',
        lead_uuid: 'LD-1',
        slot_json: null,
        ...over,
    };
}

function mkPartsAttempt(over = {}) {
    return {
        id: 900,
        company_id: CO,
        job_id: 50,
        task_id: 70,
        contact_id: 501,
        phone: '+16175551212',
        attempt_no: 1,
        status: 'dialing',
        scenario: 'parts_visit',
        lead_uuid: null,
        slot_json: { date: '2026-07-10', start: '10:00', end: '12:00', label: 'Tue 10-12', key: 'p-slot' },
        ...over,
    };
}

const LEAD = {
    UUID: 'LD-1',
    ClientId: '4242',
    FirstName: 'Alfreda',
    LastName: 'Smith',
    Phone: '+16175551234',
    JobSource: 'Pro Referral',
    Status: 'Submitted',
    LeadDateTime: null,
    ContactId: 501,
    PostalCode: '02467',
    Latitude: '42.31',
    Longitude: '-71.16',
    Address: '101 Asheville Rd',
    City: 'Chestnut Hill',
    State: 'MA',
    Description: 'Dishwasher leaks from the door',
    Comments: null,
};

const DIALABLE_JOB = {
    id: 50, blanc_status: 'Part arrived', zb_canceled: false,
    customer_name: 'Jane', customer_phone: '+16175551212',
};

let getLeadByUUIDSpy;
let leadResolveSpy;
let isSourceEnabledReal;

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Lead-side defaults
    getLeadByUUIDSpy = jest.spyOn(leadsService, 'getLeadByUUID').mockResolvedValue({ ...LEAD });
    leadResolveSpy = jest.spyOn(leadSettings, 'resolve').mockResolvedValue({
        enabled_sources: ['ProReferral'], max_attempts: 3, backoff_schedule: ['immediate', '+30m', '+2h'],
    });
    isSourceEnabledReal = leadSettings.isSourceEnabled;
    marketplaceService.isAppConnected.mockResolvedValue(true);
    scheduleService.getDispatchSettings.mockResolvedValue({ ...NY_DS });
    recommendSlots.run.mockResolvedValue({ available: true, fallback: false, slots: [{ ...TOP_SLOT }] });
    companyProfileService.getProfile.mockResolvedValue({ name: 'ABC Homes' });
    outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_lead_1' });
    vapiCallTimeline.recordPlacement.mockResolvedValue(undefined);
    timelinesQueries.findOrCreateTimeline.mockResolvedValue({ id: 321 });
    timelinesQueries.createTask.mockResolvedValue({ id: 555 });

    // Parts-side defaults (for tick mixed-batch tests)
    jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB });
    jobsService.getJobBalanceDue.mockResolvedValue({ balanceDue: null, total: null, amountPaid: null });
    partsSettings.resolve.mockResolvedValue({
        max_attempts: 3, backoff_schedule: ['immediate', '+2h', 'next_business_morning'],
        next_morning_hour: 9, enabled: true,
    });
    groupRouting.isBusinessHours.mockResolvedValue(true);
    partsCallService.isChainCanceled.mockResolvedValue(false);
    partsCallService.markRobotCallCanceled.mockResolvedValue(undefined);

    // Freeze "inside window": Wednesday 2026-07-15 12:00 EDT.
    jest.useFakeTimers({ now: new Date('2026-07-15T16:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });

    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.OUTBOUND_CALL_IGNORE_BUSINESS_HOURS;
});

const updates = (re) => mockQuery.mock.calls.filter(([sql]) => re.test(sql));
const terminateCalls = () => updates(/SET status = \$2, reason = \$3/);
const ladderInserts = () => updates(/INSERT INTO outbound_call_attempts/);

describe('TC-OLC-020: goal-achieved skip at claim', () => {
    it.each([
        ['hold set', { LeadDateTime: '2026-07-16T14:00:00Z' }, 'goal_achieved:hold_set'],
        ['Lost', { Status: 'Lost' }, 'goal_achieved:closed_lost'],
        ['CONVERTED', { Status: 'CONVERTED' }, 'goal_achieved:closed_converted'],
    ])('%s → canceled with exact reason, no dial, no slots, no task', async (_l, patch, reason) => {
        getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, ...patch });
        await svc.processLeadAttempt(mkLeadAttempt());
        const t = terminateCalls();
        expect(t).toHaveLength(1);
        expect(t[0][1]).toEqual([700, 'canceled', reason]);
        expect(outboundCallService.placeCall).not.toHaveBeenCalled();
        expect(recommendSlots.run).not.toHaveBeenCalled();
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
    });

    it('lead vanished (LEAD_NOT_FOUND) → canceled/lead_not_found', async () => {
        const err = new Error('nope'); err.code = 'LEAD_NOT_FOUND';
        getLeadByUUIDSpy.mockRejectedValue(err);
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(terminateCalls()[0][1]).toEqual([700, 'canceled', 'lead_not_found']);
    });

    it('D3 negative: live-human context (fresh notes) does NOT stop processing — no takeover guard', async () => {
        getLeadByUUIDSpy.mockResolvedValue({
            ...LEAD,
            Comments: 'dispatcher note: just spoke with the customer!',
        });
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(recommendSlots.run).toHaveBeenCalledTimes(1); // proceeded to slots
        expect(outboundCallService.placeCall).toHaveBeenCalledTimes(1); // and dialed
    });
});

describe('TC-OLC-021: FR-15 re-check at claim', () => {
    it('(a) disconnected → canceled/app_disconnected, nothing else', async () => {
        marketplaceService.isAppConnected.mockResolvedValue(false);
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(terminateCalls()[0][1]).toEqual([700, 'canceled', 'app_disconnected']);
        expect(outboundCallService.placeCall).not.toHaveBeenCalled();
        expect(ladderInserts()).toHaveLength(0);
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
    });

    it('(b) source disabled → canceled/source_disabled', async () => {
        leadResolveSpy.mockResolvedValue({ enabled_sources: ['Google'], max_attempts: 3, backoff_schedule: [] });
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(terminateCalls()[0][1]).toEqual([700, 'canceled', 'source_disabled']);
    });

    it('order: goal-check BEFORE eligibility — hold + disconnected → goal reason', async () => {
        getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, LeadDateTime: '2026-07-16T14:00:00Z' });
        marketplaceService.isAppConnected.mockResolvedValue(false);
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(terminateCalls()[0][1][2]).toBe('goal_achieved:hold_set');
    });
});

describe('TC-OLC-022: business-window carry at claim', () => {
    it('outside hours → pending carry to nextWindowStart; no dial, no slots', async () => {
        jest.setSystemTime(new Date('2026-07-15T23:30:00Z')); // Wed 19:30 EDT
        await svc.processLeadAttempt(mkLeadAttempt());
        const carry = updates(/SET status = 'pending', scheduled_at = \$2/);
        expect(carry).toHaveLength(1);
        expect(carry[0][1][0]).toBe(700);
        expect(carry[0][1][1].toISOString()).toBe('2026-07-16T12:00:00.000Z'); // Thu 08:00 EDT
        expect(outboundCallService.placeCall).not.toHaveBeenCalled();
        expect(recommendSlots.run).not.toHaveBeenCalled();
        expect(groupRouting.isBusinessHours).not.toHaveBeenCalled(); // D2: dispatch settings, not groupRouting
    });

    it('OUTBOUND_CALL_IGNORE_BUSINESS_HOURS=yes → dials immediately even off-hours', async () => {
        process.env.OUTBOUND_CALL_IGNORE_BUSINESS_HOURS = 'yes';
        jest.setSystemTime(new Date('2026-07-15T23:30:00Z'));
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(outboundCallService.placeCall).toHaveBeenCalledTimes(1);
    });
});

describe('TC-OLC-023: slot pre-compute failures feed the ladder', () => {
    it.each([
        ['engine fallback', { available: false, slots: [], fallback: true }],
        ['available but empty', { available: true, fallback: false, slots: [] }],
    ])('(%s) → no dial; ladder called once with no_slots', async (_l, recs) => {
        recommendSlots.run.mockResolvedValue(recs);
        const spy = jest.spyOn(svc, 'scheduleLeadRetryOrExhaust');
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(outboundCallService.placeCall).not.toHaveBeenCalled();
        // ladder ran: terminal mark with klass 'failed' reason no_slots
        const t = terminateCalls();
        expect(t.some(([, params]) => params[1] === 'failed' && params[2] === 'no_slots')).toBe(true);
        spy.mockRestore();
    });

    it('run throws → same ladder path', async () => {
        recommendSlots.run.mockRejectedValue(new Error('engine down'));
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(outboundCallService.placeCall).not.toHaveBeenCalled();
        expect(terminateCalls().some(([, p]) => p[2] === 'no_slots')).toBe(true);
    });

    it('location trio: zip-only / lone-coordinate dropped / address composed / nothing', async () => {
        // zip only
        getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, Latitude: null, Longitude: null, Address: null });
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(recommendSlots.run.mock.calls[0][2]).toEqual({ zip: '02467', address: undefined });

        // lone latitude → both-or-nothing
        jest.clearAllMocks();
        mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
        recommendSlots.run.mockResolvedValue({ available: true, fallback: false, slots: [{ ...TOP_SLOT }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'v' });
        marketplaceService.isAppConnected.mockResolvedValue(true);
        scheduleService.getDispatchSettings.mockResolvedValue({ ...NY_DS });
        companyProfileService.getProfile.mockResolvedValue({ name: 'ABC Homes' });
        getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, Longitude: null, PostalCode: null, Address: null });
        await svc.processLeadAttempt(mkLeadAttempt());
        const input = recommendSlots.run.mock.calls[0][2];
        expect(input).not.toHaveProperty('lat');
        expect(input).not.toHaveProperty('lng');
        expect(input.zip).toBeUndefined();

        // address composed
        jest.clearAllMocks();
        mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
        recommendSlots.run.mockResolvedValue({ available: true, fallback: false, slots: [{ ...TOP_SLOT }] });
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'v' });
        marketplaceService.isAppConnected.mockResolvedValue(true);
        scheduleService.getDispatchSettings.mockResolvedValue({ ...NY_DS });
        companyProfileService.getProfile.mockResolvedValue({ name: 'ABC Homes' });
        getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, Latitude: null, Longitude: null, PostalCode: null });
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(recommendSlots.run.mock.calls[0][2].address).toBe('101 Asheville Rd, Chestnut Hill, MA');
    });
});

describe('TC-OLC-024: happy dial — placeCall contract snapshot', () => {
    it('full-context lead → exact placeCall argument (greeting owned by the dedicated assistant, NO firstMessage override)', async () => {
        const longDesc = 'x'.repeat(400);
        getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, Description: longDesc });
        await svc.processLeadAttempt(mkLeadAttempt());

        expect(outboundCallService.placeCall).toHaveBeenCalledTimes(1);
        const arg = outboundCallService.placeCall.mock.calls[0][0];
        expect(arg).toEqual({
            companyId: CO,
            scenario: 'lead_call',
            leadUuid: 'LD-1',
            contactId: 501,
            customerName: 'Alfreda Smith',
            customerNumber: '+16175551234',
            slot: { ...TOP_SLOT, lat: 42.31, lng: -71.16 },
            zip: '02467',
            problemDescription: 'x'.repeat(300),
            source: 'Pro Referral',
        });
        // The lead greeting/brand name lives on the dedicated VAPI assistant, not
        // in a per-call override built from the (legal) company profile name.
        expect(arg).not.toHaveProperty('firstMessage');
        expect(arg.problemDescription).toHaveLength(300);

        // ok:true → correlation stamp + slot audit + Pulse mirror
        const stamp = updates(/SET vapi_call_id = \$2, slot_json = \$3/);
        expect(stamp).toHaveLength(1);
        expect(stamp[0][1]).toEqual([700, 'vapi_lead_1', JSON.stringify(TOP_SLOT)]);
        expect(vapiCallTimeline.recordPlacement).toHaveBeenCalledWith(expect.objectContaining({
            vapiCallId: 'vapi_lead_1',
            dialedNumber: '+16175551234',
        }));
    });

    it('company profile is NOT read for the greeting anymore (dedicated assistant owns it)', async () => {
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(companyProfileService.getProfile).not.toHaveBeenCalled();
        expect(outboundCallService.placeCall.mock.calls[0][0]).not.toHaveProperty('firstMessage');
    });

    it('no name → "there"; source passed through for prompt context', async () => {
        getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, JobSource: 'Pro Referral', FirstName: null, LastName: null });
        leadResolveSpy.mockResolvedValue({ enabled_sources: ['Pro Referral'], max_attempts: 3, backoff_schedule: [] });
        await svc.processLeadAttempt(mkLeadAttempt());
        const arg = outboundCallService.placeCall.mock.calls[0][0];
        expect(arg.customerName).toBe('there');
        expect(arg.source).toBe('Pro Referral');
    });

    it('recordPlacement throw does NOT reclassify the attempt (stays dialing)', async () => {
        vapiCallTimeline.recordPlacement.mockRejectedValue(new Error('timeline down'));
        await svc.processLeadAttempt(mkLeadAttempt());
        // no terminate/ladder writes beyond the correlation stamp
        expect(terminateCalls()).toHaveLength(0);
        expect(ladderInserts()).toHaveLength(0);
        expect(updates(/SET vapi_call_id/)).toHaveLength(1);
    });
});

describe('TC-OLC-025: placement failure → ladder', () => {
    it.each([
        ['vapi_config_missing'], ['vapi_http_500'], ['missing_customer_number'],
    ])('error %s feeds the ladder with that reason', async (error) => {
        outboundCallService.placeCall.mockResolvedValue({ ok: false, error });
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(terminateCalls().some(([, p]) => p[1] === 'failed' && p[2] === error)).toBe(true);
        expect(updates(/SET vapi_call_id/)).toHaveLength(0);
        expect(vapiCallTimeline.recordPlacement).not.toHaveBeenCalled();
    });

    it('ok:false without error → place_call_failed', async () => {
        outboundCallService.placeCall.mockResolvedValue({ ok: false });
        await svc.processLeadAttempt(mkLeadAttempt());
        expect(terminateCalls().some(([, p]) => p[2] === 'place_call_failed')).toBe(true);
    });
});

describe('TC-OLC-026: ladder rungs', () => {
    it('attempt 1 no_answer → +30m rung; identity copied; slot_json NOT copied', async () => {
        await svc.scheduleLeadRetryOrExhaust(mkLeadAttempt({ attempt_no: 1 }), 'no_answer', 'no_answer');
        const t = terminateCalls();
        expect(t[0][1]).toEqual([700, 'no_answer', 'no_answer']);
        const ins = ladderInserts();
        expect(ins).toHaveLength(1);
        const [sql, params] = ins[0];
        expect(sql).not.toMatch(/slot_json/);
        expect(params[0]).toBe(CO);
        expect(params[1]).toBe('LD-1');
        expect(params[2]).toBe(501);
        expect(params[3]).toBe('+16175551234');
        expect(params[4]).toBe(2); // attempt_no + 1
        expect(params[5].toISOString()).toBe('2026-07-15T16:30:00.000Z'); // +30m inside window
        expect(eventService.logEvent).toHaveBeenCalledWith(
            CO, 'lead', 'LD-1', 'outbound_lead_call_retry',
            expect.objectContaining({ attemptNo: 1, outcome: 'no_answer' }), 'system');
    });

    it('attempt 2 → +2h rung', async () => {
        await svc.scheduleLeadRetryOrExhaust(mkLeadAttempt({ attempt_no: 2, id: 701 }), 'no_answer', 'no_answer');
        const ins = ladderInserts();
        expect(ins[0][1][4]).toBe(3);
        expect(ins[0][1][5].toISOString()).toBe('2026-07-15T18:00:00.000Z'); // +2h
    });
});

describe('TC-OLC-027: exhaustion after max attempts', () => {
    it('(a) no_answer exhaustion → marker row + "couldn\'t reach" task + event', async () => {
        // per-attempt lines query returns two terminal rows
        mockQuery.mockImplementation(async (sql) => {
            if (/SELECT attempt_no, status, reason, updated_at/.test(sql)) {
                return { rows: [
                    { attempt_no: 1, status: 'no_answer', reason: 'customer-did-not-answer', updated_at: '2026-07-15T14:05:00Z' },
                    { attempt_no: 2, status: 'no_answer', reason: null, updated_at: '2026-07-15T14:40:00Z' },
                ] };
            }
            if (/SELECT 1 FROM tasks/.test(sql)) return { rows: [] };
            return { rows: [], rowCount: 1 };
        });
        await svc.scheduleLeadRetryOrExhaust(mkLeadAttempt({ attempt_no: 3 }), 'no_answer', 'no_answer');

        const marker = ladderInserts().find(([sql]) => /'exhausted'/.test(sql));
        expect(marker).toBeTruthy();
        expect(marker[0]).toMatch(/'max_attempts_reached'/);
        expect(marker[1][4]).toBe(3);

        expect(timelinesQueries.createTask).toHaveBeenCalledTimes(1);
        const task = timelinesQueries.createTask.mock.calls[0][0];
        expect(task.title).toBe("Couldn't reach Alfreda Smith — 3 automated call attempts");
        expect(task.description).toContain('Attempt 1: no_answer (customer-did-not-answer)');
        expect(task.description).toContain('Please follow up and book the appointment.');
        expect(task).toMatchObject({
            companyId: CO, threadId: 321, subjectType: 'lead', subjectId: '4242',
            priority: 'p1', createdBy: 'agent', agentType: 'outbound_lead_call',
        });
        expect(task.agentStatus).toBeUndefined();
        expect(eventService.logEvent).toHaveBeenCalledWith(
            CO, 'lead', 'LD-1', 'outbound_lead_call_exhausted', { attempts: 3 }, 'system');
    });

    it('(b) no_slots exhaustion → slots-unavailable copy', async () => {
        mockQuery.mockImplementation(async (sql) => {
            if (/SELECT 1 FROM tasks/.test(sql)) return { rows: [] };
            return { rows: [], rowCount: 1 };
        });
        await svc.scheduleLeadRetryOrExhaust(mkLeadAttempt({ attempt_no: 3 }), 'no_slots', 'failed');
        const task = timelinesQueries.createTask.mock.calls[0][0];
        expect(task.title).toBe("Couldn't offer Alfreda Smith a time — appointment slots unavailable (3 attempts)");
        expect(task.description).toContain('slot engine unavailable or no windows');
        expect(task.description).toContain('Please schedule manually.');
    });
});

describe('TC-OLC-028: no-resurrection re-check blocks the next rung', () => {
    it.each([
        ['hold landed', () => getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, LeadDateTime: '2026-07-15T20:00:00Z' }), 'goal_achieved'],
        ['lead closed', () => getLeadByUUIDSpy.mockResolvedValue({ ...LEAD, Status: 'Lost' }), 'goal_achieved'],
        ['app disconnected', () => marketplaceService.isAppConnected.mockResolvedValue(false), 'app_disconnected'],
        ['source disabled', () => leadResolveSpy.mockResolvedValue({ enabled_sources: [], max_attempts: 3, backoff_schedule: [] }), 'source_disabled'],
        ['lead gone', () => { const e = new Error('x'); e.code = 'LEAD_NOT_FOUND'; getLeadByUUIDSpy.mockRejectedValue(e); }, 'lead_not_found'],
    ])('%s → no INSERT, no task, retry_skipped event', async (_l, prep, blockedBy) => {
        prep();
        await svc.scheduleLeadRetryOrExhaust(mkLeadAttempt({ attempt_no: 1 }), 'no_answer', 'no_answer');
        expect(ladderInserts()).toHaveLength(0);
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
        expect(eventService.logEvent).toHaveBeenCalledWith(
            CO, 'lead', 'LD-1', 'outbound_lead_call_retry_skipped',
            expect.objectContaining({ blockedBy }), 'system');
    });

    it('fail-open: re-check infra throw still schedules the next rung', async () => {
        getLeadByUUIDSpy.mockRejectedValue(new Error('db hiccup'));
        await svc.scheduleLeadRetryOrExhaust(mkLeadAttempt({ attempt_no: 1 }), 'no_answer', 'no_answer');
        expect(ladderInserts()).toHaveLength(1);
    });
});

describe('★ TC-OLC-029: PARTS-REGRESSION sabotage gate (mixed batch, golden fixture)', () => {
    function armClaim(rows) {
        mockQuery.mockImplementation(async (sql) => {
            if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows };
            if (/FROM companies c/.test(sql)) return { rows: [{ group_id: 'g1', timezone: 'America/New_York' }] };
            if (/SELECT 1 FROM tasks/.test(sql)) return { rows: [] };
            return { rows: [], rowCount: 1 };
        });
    }

    it('claim SQL is scenario-agnostic and both rows enter one tick; parts == golden; lead → processLeadAttempt', async () => {
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_mixed' });
        const leadSpy = jest.spyOn(svc, 'processLeadAttempt').mockResolvedValue(undefined);
        armClaim([mkPartsAttempt(), mkLeadAttempt()]);

        const n = await worker.tick();
        expect(n).toBe(2);

        // Claim SQL never filters by scenario
        const claimSql = mockQuery.mock.calls.find(([sql]) => /FOR UPDATE SKIP LOCKED/.test(sql))[0];
        expect(claimSql).not.toMatch(/scenario/);

        // Lead row → exactly one processLeadAttempt, and the parts path did NOT get it
        expect(leadSpy).toHaveBeenCalledTimes(1);
        expect(leadSpy.mock.calls[0][0].lead_uuid).toBe('LD-1');

        // Parts row went through the REAL processAttempt → placeCall body vs golden
        expect(outboundCallService.placeCall).toHaveBeenCalledTimes(1);
        const partsArg = outboundCallService.placeCall.mock.calls[0][0];
        for (const k of ['scenario', 'leadUuid', 'zip', 'problemDescription', 'source', 'firstMessage']) {
            expect(partsArg).not.toHaveProperty(k);
        }
        if (process.env.WRITE_PARTS_GOLDEN) {
            fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
            fs.writeFileSync(GOLDEN_PATH, JSON.stringify(partsArg, null, 2));
        }
        const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
        expect(partsArg).toEqual(golden);
        leadSpy.mockRestore();
    });

    it('sabotaged lead branch (throw) → parts outcome STILL equals golden; tick survives', async () => {
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'vapi_mixed' });
        const leadSpy = jest.spyOn(svc, 'processLeadAttempt').mockRejectedValue(new Error('SABOTAGE'));
        armClaim([mkPartsAttempt(), mkLeadAttempt()]);

        const n = await worker.tick();
        expect(n).toBe(2);
        const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
        expect(outboundCallService.placeCall.mock.calls[0][0]).toEqual(golden);
        // the sabotage landed in the worker catch → terminate failed worker_error
        expect(terminateCalls().some(([, p]) => p[1] === 'failed' && /worker_error:SABOTAGE/.test(p[2]))).toBe(true);
        leadSpy.mockRestore();
    });

    it('discrimination control: with routing inverted, BOTH step-2 asserts go red', async () => {
        // Simulate an inverted dispatch by feeding a batch where the labels are
        // swapped: prove the assertions FAIL against swapped routing (i.e. they
        // discriminate), by checking what WOULD happen: parts row processed by
        // the lead branch produces a placeCall arg with lead keys (≠ golden),
        // and processLeadAttempt would receive the PARTS row.
        const leadSpy = jest.spyOn(svc, 'processLeadAttempt').mockResolvedValue(undefined);
        // Swap scenarios on the same two rows → the router sends parts-shaped
        // row into the lead branch and vice versa.
        armClaim([
            mkPartsAttempt({ scenario: 'lead_call', lead_uuid: 'LD-X' }), // parts-shaped but routed to lead
            mkLeadAttempt({ scenario: 'parts_visit', job_id: 50, lead_uuid: null }), // lead-shaped but routed to parts
        ]);
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'v' });

        await worker.tick();
        // The "golden" comparison would now see the parts flow driven by the
        // lead-shaped row → different body; and processLeadAttempt got the
        // parts-shaped row. Both directions detected:
        expect(leadSpy.mock.calls[0][0].id).toBe(900); // parts row landed in the lead branch
        const arg = outboundCallService.placeCall.mock.calls[0] && outboundCallService.placeCall.mock.calls[0][0];
        const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
        expect(arg).not.toEqual(golden); // parts golden mismatch under swapped routing
        leadSpy.mockRestore();
    });

    it('Touch-2: getTimezoneOffsetMs exported; export surface otherwise unchanged', () => {
        expect(typeof worker.getTimezoneOffsetMs).toBe('function');
        expect(Object.keys(worker).sort()).toEqual([
            'computeNextScheduledAt', 'getTimezoneOffsetMs', 'nextBusinessMorning',
            'processAttempt', 'resolveBusinessHoursGroup', 'retryBlockReason',
            'start', 'stop', 'tick',
        ]);
    });
});

describe('TC-OLC-030: worker throw-isolation across a mixed batch', () => {
    it('an unexpected lead throw mid-batch never aborts siblings', async () => {
        const rows = [
            mkLeadAttempt({ id: 701, lead_uuid: 'LD-A' }),
            mkPartsAttempt({ id: 902 }),
            mkLeadAttempt({ id: 703, lead_uuid: 'LD-B' }),
        ];
        mockQuery.mockImplementation(async (sql) => {
            if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows };
            if (/FROM companies c/.test(sql)) return { rows: [{ group_id: 'g1', timezone: 'America/New_York' }] };
            return { rows: [], rowCount: 1 };
        });
        outboundCallService.placeCall.mockResolvedValue({ ok: true, vapiCallId: 'v' });
        const leadSpy = jest.spyOn(svc, 'processLeadAttempt')
            .mockImplementationOnce(async () => { throw new Error('unexpected'); })
            .mockImplementationOnce(async () => undefined);

        const n = await worker.tick();
        expect(n).toBe(3);
        expect(leadSpy).toHaveBeenCalledTimes(2); // both lead rows dispatched
        expect(outboundCallService.placeCall).toHaveBeenCalledTimes(1); // parts sibling processed
        expect(terminateCalls().some(([, p]) => p[0] === 701 && /worker_error:unexpected/.test(p[2]))).toBe(true);
        leadSpy.mockRestore();
    });
});

describe('TC-OLC-032: createLeadCallTask belt + copy', () => {
    it('(b) open task exists → skip, no createTask', async () => {
        mockQuery.mockImplementation(async (sql) => {
            if (/SELECT 1 FROM tasks/.test(sql)) return { rows: [{ '?': 1 }] };
            return { rows: [], rowCount: 1 };
        });
        await svc.createLeadCallTask(CO, { ...LEAD }, mkLeadAttempt({ attempt_no: 3 }), 'exhausted', {});
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('task_exists'));
    });

    it('(c) declined with summary → follow-up copy', async () => {
        mockQuery.mockImplementation(async (sql) => {
            if (/SELECT 1 FROM tasks/.test(sql)) return { rows: [] };
            return { rows: [], rowCount: 1 };
        });
        await svc.createLeadCallTask(CO, { ...LEAD }, mkLeadAttempt({ attempt_no: 1 }), 'declined', { summary: 'Asked to be called next week.' });
        const task = timelinesQueries.createTask.mock.calls[0][0];
        expect(task.title).toBe("Alfreda Smith answered but didn't book — follow up");
        expect(task.description).toContain('Call summary: Asked to be called next week.');
        expect(task.description).toContain('Please follow up personally.');
    });

    it('(e) createTask throws → non-fatal warn', async () => {
        mockQuery.mockImplementation(async (sql) => (/SELECT 1 FROM tasks/.test(sql) ? { rows: [] } : { rows: [], rowCount: 1 }));
        timelinesQueries.createTask.mockRejectedValue(new Error('tasks down'));
        await expect(svc.createLeadCallTask(CO, { ...LEAD }, mkLeadAttempt(), 'exhausted', {}))
            .resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining('createLeadCallTask failed'), 'tasks down');
    });
});

describe('TC-OLC-033 (E-6): two different leads, same phone — chains keyed by lead_uuid', () => {
    it('second lead\'s rung INSERT carries ITS lead_uuid; both timelines resolve by the shared phone', async () => {
        await svc.scheduleLeadRetryOrExhaust(mkLeadAttempt({ id: 801, lead_uuid: 'LD-A' }), 'no_answer', 'no_answer');
        await svc.scheduleLeadRetryOrExhaust(mkLeadAttempt({ id: 802, lead_uuid: 'LD-B' }), 'no_answer', 'no_answer');
        const ins = ladderInserts();
        expect(ins).toHaveLength(2);
        expect(ins[0][1][1]).toBe('LD-A');
        expect(ins[1][1][1]).toBe('LD-B');
    });
});
