/**
 * partsCallService.test.js — OUTBOUND-PARTS-CALL-001, TC-OPC-U01/U02/U04/U05/U06/U07.
 *
 * Unit (mocked db + deps): pins the auto-task idempotence guard (`onPartArrived`)
 * and the pre-compute/enqueue decision tree of `startRobotCall` (spec §B.3 / §C.1,
 * S1 / S2 / S6 / S14). NO real DB, NO real slot engine, NO dial.
 *
 * A mocked jest here proves only the DISPATCH / branch taken (which SQL string,
 * whether createTask / an INSERT / placeCall ran) — never that a row actually
 * moved or a partial-unique index blocked a second row (that is the integration
 * section's job, per the house lesson).
 */

'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

jest.mock('../backend/src/db/tasksQueries', () => ({
    createTask: jest.fn(async () => ({ id: 70, kind: 'part_arrived_call' })),
    getTaskById: jest.fn(async () => ({ id: 70, status: 'open' })),
}));
// BTN-06: onPartArrived best-effort thread-links the job task to the customer's
// Pulse timeline via timelinesQueries.findOrCreateTimelineByContact. Mock the seam
// so the link/skip/non-fatal branches are asserted without the real timeline DB.
jest.mock('../backend/src/db/timelinesQueries', () => ({
    findOrCreateTimelineByContact: jest.fn(),
}));
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
    // CANCEL-001 (CC-01): the cancel core writes ONE FR-3 job note per cancel.
    addNote: jest.fn(async () => ({ notes: [] })),
}));
// CANCEL-001 (CC-01): cancelScheduledRobotCalls logs an `outbound_call_canceled`
// domain event per affected job — mock the seam (its real impl hits db.query).
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(),
}));
// OUTBOUND-CALL-CANCEL-001: customer-contact behavior moved to the neutral core.
// This suite retains the parts status-leave core and compatibility wrapper only.
jest.mock('../backend/src/services/outboundCallCancellationService', () => ({
    PARTS_VISIT_TASK_KIND: 'part_arrived_call',
    PARTS_VISIT_DEFAULT_ACTIONS: [
        { type: 'robot_call', label: '🤖 Let the robot call' },
        { type: 'manual_call', label: "📞 I'll call myself" },
    ],
    cancelForCompletedCustomerCall: jest.fn(async () => ({ canceled: 0, marker: false })),
}));
// recommendSlots.run is mocked (no engine); formatSlotLabel is the REAL pure helper
// so buildRobotCallSlot builds the same label the voice surface offers (SLOTPICK-001).
jest.mock('../backend/src/services/agentSkills/skills/recommendSlots', () => {
    const actual = jest.requireActual('../backend/src/services/agentSkills/skills/recommendSlots');
    return { run: jest.fn(), formatSlotLabel: actual.formatSlotLabel };
});
jest.mock('../backend/src/services/outboundCallSettingsService', () => ({
    resolve: jest.fn(async () => ({ enabled: true, max_attempts: 3 })),
}));
jest.mock('../backend/src/services/agentCallWindowService', () => ({
    AGENT_KEYS: { PARTS: 'outbound-parts-caller', LEADS: 'outbound-lead-caller' },
    nextAllowedAt: jest.fn(async (_companyId, _agentKey, now) => now),
}));
// SLOTPICK-001: buildRobotCallSlot derives company-local date/time via resolveTimezone.
jest.mock('../backend/src/services/slotEngineService', () => ({
    resolveTimezone: jest.fn(async () => 'America/New_York'),
}));

const tasksQueries = require('../backend/src/db/tasksQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const dbConn = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');
const eventService = require('../backend/src/services/eventService');
const outboundCallCancellationService = require('../backend/src/services/outboundCallCancellationService');
const recommendSlots = require('../backend/src/services/agentSkills/skills/recommendSlots');
const settings = require('../backend/src/services/outboundCallSettingsService');
const agentCallWindowService = require('../backend/src/services/agentCallWindowService');
const slotEngineService = require('../backend/src/services/slotEngineService');
const partsCallService = require('../backend/src/services/partsCallService');

const CO = '00000000-0000-0000-0000-000000000001';
const OTHER_CO = 'c0000000-0000-4000-8000-0000000000f1';

const TOP_SLOT = { key: 'k1', date: '2026-07-10', start: '10:00', end: '12:00', label: 'Tue 10-12' };
const DIALABLE_JOB = {
    id: 50,
    contact_id: 501,
    blanc_status: 'Part arrived',
    zb_canceled: false,
    customer_phone: '+16175551212',
    address: '1 Main St',
    lat: 42.1,
    lng: -71.1,
};

// TECHSLOT-001: startRobotCall enriches EVERY enqueued slot_json with the tech
// constraint + the job's coords ({…, techId, lat, lng}) at the INSERT point.
// DIALABLE_JOB has no assigned_techs (→ []) so techId defaults to null here.
const enriched = (slot, over = {}) => ({ ...slot, techId: null, lat: 42.1, lng: -71.1, ...over });

beforeEach(() => {
    jest.clearAllMocks();
    settings.resolve.mockResolvedValue({ enabled: true, max_attempts: 3 });
    agentCallWindowService.nextAllowedAt.mockImplementation(async (_companyId, _agentKey, now) => now);
});

// ---------------------------------------------------------------------------
// TC-OPC-U01 / U02: onPartArrived — SELECT-guard app-upsert
// ---------------------------------------------------------------------------

describe('TC-OPC-U01: onPartArrived — no open task → createTask once with kind+actions', () => {
    test('SELECT finds 0 rows → exactly one createTask with correct kind/actions/title', async () => {
        // 1) dedup SELECT → 0 rows; 2) job customer_name lookup.
        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ customer_name: 'Jane' }] });

        await partsCallService.onPartArrived(50, CO);

        expect(tasksQueries.createTask).toHaveBeenCalledTimes(1);
        const [companyArg, payload] = tasksQueries.createTask.mock.calls[0];
        expect(companyArg).toBe(CO);
        expect(payload).toMatchObject({
            parentType: 'job',
            parentId: 50,
            kind: 'part_arrived_call',
            description: 'Part arrived — schedule completion visit for Jane',
        });
        expect(payload.actions).toEqual([
            { type: 'robot_call', label: '🤖 Let the robot call' },
            { type: 'manual_call', label: "📞 I'll call myself" },
        ]);
        // dedup SELECT is scoped to company + job + kind + status='open'
        const guardSql = mockQuery.mock.calls[0][0];
        expect(guardSql).toMatch(/kind = \$3 AND status = 'open'/i);
        expect(mockQuery.mock.calls[0][1]).toEqual([CO, 50, 'part_arrived_call']);
    });
});

describe('TC-OPC-U02: onPartArrived — open task exists → no-op (SELECT-guard is the upsert)', () => {
    test('SELECT finds 1 row → createTask NOT called, returns the existing task', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 70 }] });

        const out = await partsCallService.onPartArrived(50, CO);

        expect(tasksQueries.createTask).not.toHaveBeenCalled();
        expect(tasksQueries.getTaskById).toHaveBeenCalledWith(CO, 70, null);
        expect(out).toMatchObject({ id: 70 });
    });
});

// ---------------------------------------------------------------------------
// TC-OPC-U04: startRobotCall — slots present → enqueue ONE pending attempt
// ---------------------------------------------------------------------------

describe('TC-OPC-U04: startRobotCall — slots present → store top-1 slot + insert ONE pending attempt', () => {
    test('recommendSlots ok → INSERT pending attempt (immediate), no synchronous dial', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        recommendSlots.run.mockResolvedValue({ available: true, slots: [TOP_SLOT] });
        // The INSERT returns the new attempt id.
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 900 }] });

        const out = await partsCallService.startRobotCall(50, CO, 70);

        // TECHSLOT-001: the top-1 slot is enriched with techId(+null)/job coords.
        expect(out).toEqual({ ok: true, attemptId: 900, slot: enriched(TOP_SLOT) });

        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeTruthy();
        expect(insertCall[0]).toMatch(/'pending'/i);
        expect(insertCall[0]).toMatch(/\$6/);
        // slot_json carries the serialized top-1 slot; params carry company/job/task/phone.
        const params = insertCall[1];
        expect(params[0]).toBe(CO);
        expect(params[1]).toBe(50);
        expect(params[2]).toBe(70);
        expect(params[4]).toBe('+16175551212');
        expect(params[5]).toBeInstanceOf(Date);
        expect(JSON.parse(params[6])).toEqual(enriched(TOP_SLOT));
    });

    test('SAB-CW-PARTS-INIT: first attempt uses a future guard result without consuming an attempt', async () => {
        const deferredUntil = new Date('2026-07-20T13:00:00.000Z');
        agentCallWindowService.nextAllowedAt.mockResolvedValue(deferredUntil);
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        recommendSlots.run.mockResolvedValue({ available: true, slots: [TOP_SLOT] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 903 }] });

        await partsCallService.startRobotCall(50, CO, 70);

        const insertCall = mockQuery.mock.calls.find((call) => /INSERT INTO outbound_call_attempts/i.test(call[0]));
        expect(agentCallWindowService.nextAllowedAt).toHaveBeenCalledWith(
            CO,
            'outbound-parts-caller',
            expect.any(Date)
        );
        expect(insertCall[0]).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, 1, 'pending', \$6, \$7::jsonb\)/);
        expect(insertCall[1][5]).toBe(deferredUntil);
    });
});

describe('TC-OPC-U04b: startRobotCall — partial-unique (23505) on INSERT → return in-flight existing', () => {
    test('INSERT rejects 23505 → SELECT existing active row → { ok:true, already:true }', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        recommendSlots.run.mockResolvedValue({ available: true, slots: [TOP_SLOT] });
        const dup = new Error('duplicate key value violates unique constraint');
        dup.code = '23505';
        mockQuery
            .mockRejectedValueOnce(dup) // the INSERT
            .mockResolvedValueOnce({ rows: [{ id: 800 }] }); // the "existing active" SELECT

        const out = await partsCallService.startRobotCall(50, CO, 70);
        expect(out).toEqual({ ok: true, already: true, attemptId: 800 });
    });
});

// ---------------------------------------------------------------------------
// TC-OPC-U05: v1 company gate
// ---------------------------------------------------------------------------

describe('TC-OPC-U05: startRobotCall — v1 company gate short-circuits a non-default company', () => {
    test('non-default company → { ok:false, disabled }, NO recommendSlots, NO attempt', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB });

        const out = await partsCallService.startRobotCall(50, OTHER_CO, 70);

        expect(out).toEqual({ ok: false, reason: 'disabled' });
        expect(recommendSlots.run).not.toHaveBeenCalled();
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeFalsy();
    });

    test('default company but settings.enabled=false → disabled, no attempt', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB });
        settings.resolve.mockResolvedValue({ enabled: false });

        const out = await partsCallService.startRobotCall(50, CO, 70);
        expect(out).toEqual({ ok: false, reason: 'disabled' });
        expect(recommendSlots.run).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// TC-OPC-U06: no slots / engine error → NO call, task reason, no attempt row
// ---------------------------------------------------------------------------

describe('TC-OPC-U06: startRobotCall — no slots / engine fault → NO call, NO attempt, task reason failed', () => {
    test('recommendSlots available:false/fallback:true → no INSERT, robot_call marked failed', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        recommendSlots.run.mockResolvedValue({ available: false, slots: [], fallback: true });
        // markRobotCallFailed: SELECT actions then UPDATE actions.
        mockQuery
            .mockResolvedValueOnce({ rows: [{ actions: [{ type: 'robot_call' }, { type: 'manual_call' }] }] })
            .mockResolvedValueOnce({ rows: [] });

        const out = await partsCallService.startRobotCall(50, CO, 70);

        expect(out).toEqual({ ok: false, reason: 'no_slots' });
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeFalsy();
        // robot_call action stamped state:'failed' with a reason.
        const updateCall = mockQuery.mock.calls.find((c) => /UPDATE tasks SET actions/i.test(c[0]));
        expect(updateCall).toBeTruthy();
        const written = JSON.parse(updateCall[1][2]);
        const robot = written.find((a) => a.type === 'robot_call');
        expect(robot.state).toBe('failed');
        expect(typeof robot.reason).toBe('string');
    });

    test('recommendSlots THROWS → same no-call branch, reason engine_error, no INSERT', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        recommendSlots.run.mockRejectedValue(new Error('engine boom'));
        mockQuery
            .mockResolvedValueOnce({ rows: [{ actions: [{ type: 'robot_call' }] }] })
            .mockResolvedValueOnce({ rows: [] });

        const out = await partsCallService.startRobotCall(50, CO, 70);
        expect(out).toEqual({ ok: false, reason: 'engine_error' });
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeFalsy();
    });
});

// ---------------------------------------------------------------------------
// TC-OPC-U07: no phone / not-dialable job
// ---------------------------------------------------------------------------

describe('TC-OPC-U07: startRobotCall — not-dialable / no phone → NO call, NO attempt', () => {
    test('job not Part arrived → { ok:false, not_dialable }, no recommendSlots', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB, blanc_status: 'Waiting for parts' });
        const out = await partsCallService.startRobotCall(50, CO, 70);
        expect(out).toEqual({ ok: false, reason: 'not_dialable' });
        expect(recommendSlots.run).not.toHaveBeenCalled();
    });

    test('job has no phone → { ok:false, no_phone }, robot_call marked failed, no recommendSlots', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB, customer_phone: null });
        mockQuery
            .mockResolvedValueOnce({ rows: [{ actions: [{ type: 'robot_call' }] }] })
            .mockResolvedValueOnce({ rows: [] });

        const out = await partsCallService.startRobotCall(50, CO, 70);
        expect(out).toEqual({ ok: false, reason: 'no_phone' });
        expect(recommendSlots.run).not.toHaveBeenCalled();
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeFalsy();
    });

    test('PHONE-FALLBACK-001: job.customer_phone null but contact has phone_e164 → falls back to the contact phone + enqueues', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB, customer_phone: null }); // contact_id 501
        recommendSlots.run.mockResolvedValue({ available: true, slots: [TOP_SLOT] });
        mockQuery
            .mockResolvedValueOnce({ rows: [{ phone_e164: '+15085140320' }] }) // contact fallback lookup
            .mockResolvedValueOnce({ rows: [{ id: 951 }] }); // the enqueue INSERT
        const out = await partsCallService.startRobotCall(50, CO, 70);
        expect(out).toEqual({ ok: true, attemptId: 951, slot: enriched(TOP_SLOT) });
        // fallback lookup is company-scoped by contact_id
        const lookup = mockQuery.mock.calls.find((c) => /FROM contacts WHERE id = \$1 AND company_id = \$2/i.test(c[0]));
        expect(lookup && lookup[1]).toEqual([501, CO]);
        // the enqueued attempt dials the contact's phone
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall[1]).toContain('+15085140320');
    });
});

// ---------------------------------------------------------------------------
// SLOTPICK-001 — buildRobotCallSlot: ISO → canonical slot_json + validation
// (TC-SP-01…06). Company-local derivation is pinned via a mocked resolveTimezone
// + a frozen clock so the horizon window is deterministic. EDT = UTC−4 for the
// July/Sep 2026 dates used here (US DST is in effect through Nov 1 2026).
// ---------------------------------------------------------------------------

describe('SLOTPICK-001: buildRobotCallSlot — ISO→slot_json conversion + validation', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-08T12:00:00Z')); // company-local today = 2026-07-08 (EDT)
        slotEngineService.resolveTimezone.mockResolvedValue('America/New_York');
    });
    afterEach(() => jest.useRealTimers());

    test('TC-SP-01: valid UTC window → canonical slot in company tz (EDT = UTC−4)', async () => {
        const out = await partsCallService.buildRobotCallSlot(
            { startIso: '2026-07-09T13:00:00Z', endIso: '2026-07-09T15:00:00Z' },
            CO,
        );
        expect(slotEngineService.resolveTimezone).toHaveBeenCalledWith(CO);
        expect(out.ok).toBe(true);
        expect(out.slot).toEqual({
            key: '2026-07-09|09:00|11:00',
            date: '2026-07-09',
            start: '09:00',
            end: '11:00',
            label: recommendSlots.formatSlotLabel('2026-07-09', '09:00', '11:00'),
            techName: null,
            confidence: null,
            techId: null, // TECHSLOT-001: carried when picked; null otherwise
        });
    });

    test('TC-SP-01b: techName passthrough → carried onto the slot (else null)', async () => {
        const out = await partsCallService.buildRobotCallSlot(
            { startIso: '2026-07-09T13:00:00Z', endIso: '2026-07-09T15:00:00Z', techName: 'Alex' },
            CO,
        );
        expect(out.ok).toBe(true);
        expect(out.slot.techName).toBe('Alex');
    });

    test('TC-SP-02: bad / empty / missing ISO → invalid_slot (no throw)', async () => {
        await expect(partsCallService.buildRobotCallSlot({ startIso: 'not-a-date', endIso: '2026-07-09T15:00:00Z' }, CO))
            .resolves.toEqual({ ok: false, error: 'invalid_slot' });
        await expect(partsCallService.buildRobotCallSlot({ startIso: '', endIso: '2026-07-09T15:00:00Z' }, CO))
            .resolves.toEqual({ ok: false, error: 'invalid_slot' });
        await expect(partsCallService.buildRobotCallSlot({ startIso: '2026-07-09T13:00:00Z' }, CO))
            .resolves.toEqual({ ok: false, error: 'invalid_slot' }); // endIso missing
    });

    test('TC-SP-03: start ≥ end instant (equal + reversed) → invalid_slot', async () => {
        await expect(partsCallService.buildRobotCallSlot({ startIso: '2026-07-09T13:00:00Z', endIso: '2026-07-09T13:00:00Z' }, CO))
            .resolves.toEqual({ ok: false, error: 'invalid_slot' });
        await expect(partsCallService.buildRobotCallSlot({ startIso: '2026-07-09T15:00:00Z', endIso: '2026-07-09T13:00:00Z' }, CO))
            .resolves.toEqual({ ok: false, error: 'invalid_slot' });
    });

    test('TC-SP-04: window crossing company-local midnight → invalid_slot', async () => {
        // 2026-07-09 23:00 EDT (→03:00Z next day) … 2026-07-10 01:00 EDT (→05:00Z):
        // instants ordered, but local date(start)=07-09 ≠ date(end)=07-10.
        const out = await partsCallService.buildRobotCallSlot(
            { startIso: '2026-07-10T03:00:00Z', endIso: '2026-07-10T05:00:00Z' },
            CO,
        );
        expect(out).toEqual({ ok: false, error: 'invalid_slot' });
    });

    test('TC-SP-05: past company-local day rejected; same-day allowed (grace)', async () => {
        await expect(partsCallService.buildRobotCallSlot({ startIso: '2026-07-07T16:00:00Z', endIso: '2026-07-07T18:00:00Z' }, CO))
            .resolves.toEqual({ ok: false, error: 'invalid_slot' }); // 2026-07-07 < today
        const same = await partsCallService.buildRobotCallSlot({ startIso: '2026-07-08T20:00:00Z', endIso: '2026-07-08T22:00:00Z' }, CO);
        expect(same.ok).toBe(true);
        expect(same.slot.date).toBe('2026-07-08'); // == today → allowed
    });

    test('TC-SP-06: horizon — today+60d allowed, today+61d rejected', async () => {
        const at60 = await partsCallService.buildRobotCallSlot({ startIso: '2026-09-06T16:00:00Z', endIso: '2026-09-06T18:00:00Z' }, CO);
        expect(at60.ok).toBe(true);
        expect(at60.slot.date).toBe('2026-09-06'); // 2026-07-08 + 60d
        await expect(partsCallService.buildRobotCallSlot({ startIso: '2026-09-07T16:00:00Z', endIso: '2026-09-07T18:00:00Z' }, CO))
            .resolves.toEqual({ ok: false, error: 'invalid_slot' }); // +61d
    });
});

// ---------------------------------------------------------------------------
// SLOTPICK-001 — startRobotCall dispatcher-slot passthrough (TC-SP-07…09).
// A dispatcher-picked window is built+validated server-side and SKIPS the engine;
// no window → the pre-existing auto-compute path runs unchanged (backward-compat).
// ---------------------------------------------------------------------------

describe('SLOTPICK-001: startRobotCall — dispatcher slot passthrough vs auto-compute', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-08T12:00:00Z'));
        slotEngineService.resolveTimezone.mockResolvedValue('America/New_York');
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        settings.resolve.mockResolvedValue({ enabled: true, max_attempts: 3 });
    });
    afterEach(() => jest.useRealTimers());

    const EXPECTED_SLOT = () => ({
        key: '2026-07-09|09:00|11:00',
        date: '2026-07-09',
        start: '09:00',
        end: '11:00',
        label: recommendSlots.formatSlotLabel('2026-07-09', '09:00', '11:00'),
        techName: null,
        confidence: null,
        techId: null, // TECHSLOT-001: no lane pick + no assigned tech → null
    });

    test('TC-SP-07: valid dispatcher slot → SKIP recommendSlots, enqueue the built slot_json', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 901 }] }); // the INSERT
        const dispatcherSlot = { startIso: '2026-07-09T13:00:00Z', endIso: '2026-07-09T15:00:00Z' };

        const out = await partsCallService.startRobotCall(50, CO, 70, null, dispatcherSlot);

        // Engine precompute is SKIPPED entirely.
        expect(recommendSlots.run).not.toHaveBeenCalled();
        expect(out).toEqual({ ok: true, attemptId: 901, slot: enriched(EXPECTED_SLOT()) });

        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeTruthy();
        const params = insertCall[1];
        expect(params[0]).toBe(CO); // company_id scoped
        expect(params[1]).toBe(50);
        expect(params[2]).toBe(70);
        expect(JSON.parse(params[6])).toEqual(enriched(EXPECTED_SLOT())); // the built canonical slot, not the raw ISO
    });

    test('TC-SP-08: invalid dispatcher slot → reason:invalid_slot; NO recommendSlots, NO INSERT, task NOT stamped', async () => {
        const out = await partsCallService.startRobotCall(50, CO, 70, null, { startIso: 'bad', endIso: 'worse' });

        expect(out).toEqual({ ok: false, reason: 'invalid_slot' });
        expect(recommendSlots.run).not.toHaveBeenCalled();
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeFalsy();
        // markRobotCallFailed (SELECT actions → UPDATE tasks SET actions) must NOT run.
        const stampCall = mockQuery.mock.calls.find((c) => /UPDATE tasks SET actions/i.test(c[0]));
        expect(stampCall).toBeFalsy();
    });

    test('TC-SP-09: NO dispatcher slot → auto-compute path unchanged (recommendSlots top-1)', async () => {
        recommendSlots.run.mockResolvedValue({ available: true, slots: [TOP_SLOT] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 902 }] });

        const out = await partsCallService.startRobotCall(50, CO, 70); // 3-arg / no slot

        expect(recommendSlots.run).toHaveBeenCalledTimes(1);
        expect(out).toEqual({ ok: true, attemptId: 902, slot: enriched(TOP_SLOT) });
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(JSON.parse(insertCall[1][6])).toEqual(enriched(TOP_SLOT));
    });
});

// ---------------------------------------------------------------------------
// OUTBOUND-PARTS-CALL-TECHSLOT-001 — multi_tech server gate (TC-TS-14…16) +
// techId/coords into slot_json (TC-TS-17). The gate fires right after the job
// load + dialable guard — BEFORE the v1 settings gate, the phone resolution and
// ANY slot work — and NEVER stamps the task (mirrors not_dialable, arch §7/§10.4).
// techId rides buildRobotCallSlot; both slot paths converge on an enrich that
// adds { techId, lat, lng } to the enqueued slot_json (arch §2/§5).
// ---------------------------------------------------------------------------

describe('TECHSLOT-001: startRobotCall — multi_tech gate (TC-TS-14/15/16)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-08T12:00:00Z'));
        slotEngineService.resolveTimezone.mockResolvedValue('America/New_York');
    });
    afterEach(() => jest.useRealTimers());

    const DISPATCHER_SLOT = { startIso: '2026-07-09T13:00:00Z', endIso: '2026-07-09T15:00:00Z', techId: 'A' };

    test('TC-TS-14: 2 assigned techs → { ok:false, reason:multi_tech }; NO INSERT, NO task stamp, before v1/phone/slot', async () => {
        jobsService.getJobById.mockResolvedValue({
            ...DIALABLE_JOB,
            assigned_techs: [{ id: 'A' }, { id: 'B' }],
        });

        const out = await partsCallService.startRobotCall(50, CO, 70, null, DISPATCHER_SLOT);

        expect(out).toEqual({ ok: false, reason: 'multi_tech' });
        // No attempt INSERT and no markRobotCallFailed stamp — in fact NO query at
        // all runs after the (mocked) job load: the gate short-circuits first.
        expect(mockQuery).not.toHaveBeenCalled();
        // Fires BEFORE the v1 gate / phone / slot steps: settings, the engine and
        // even the tz resolution (buildRobotCallSlot's first dependency) untouched.
        expect(settings.resolve).not.toHaveBeenCalled();
        expect(recommendSlots.run).not.toHaveBeenCalled();
        expect(slotEngineService.resolveTimezone).not.toHaveBeenCalled();
    });

    test('TC-TS-14b: 3 techs + NO dispatcher slot (auto-compute path) → same multi_tech refusal', async () => {
        jobsService.getJobById.mockResolvedValue({
            ...DIALABLE_JOB,
            assigned_techs: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
        });

        const out = await partsCallService.startRobotCall(50, CO, 70);

        expect(out).toEqual({ ok: false, reason: 'multi_tech' });
        expect(recommendSlots.run).not.toHaveBeenCalled();
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('TC-TS-15: exactly 1 assigned tech → NOT blocked; proceeds to the INSERT', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB, assigned_techs: [{ id: 'A' }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 910 }] }); // the INSERT

        const out = await partsCallService.startRobotCall(50, CO, 70, null, DISPATCHER_SLOT);

        expect(out.ok).toBe(true);
        expect(out.attemptId).toBe(910);
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeTruthy();
    });

    test('TC-TS-16: 0 assigned techs → NOT blocked (length not ≥2); proceeds', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB, assigned_techs: [] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 911 }] });

        const out = await partsCallService.startRobotCall(50, CO, 70, null, DISPATCHER_SLOT);

        expect(out.ok).toBe(true);
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeTruthy();
    });
});

describe('TECHSLOT-001: techId + job coords into slot_json (TC-TS-17)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-08T12:00:00Z'));
        slotEngineService.resolveTimezone.mockResolvedValue('America/New_York');
    });
    afterEach(() => jest.useRealTimers());

    const ISO_WINDOW = { startIso: '2026-07-09T13:00:00Z', endIso: '2026-07-09T15:00:00Z' };

    test('buildRobotCallSlot carries techId onto the built slot (else null)', async () => {
        const withTech = await partsCallService.buildRobotCallSlot({ ...ISO_WINDOW, techId: 'B' }, CO);
        expect(withTech.ok).toBe(true);
        expect(withTech.slot).toEqual({
            key: '2026-07-09|09:00|11:00',
            date: '2026-07-09',
            start: '09:00',
            end: '11:00',
            label: recommendSlots.formatSlotLabel('2026-07-09', '09:00', '11:00'),
            techName: null,
            confidence: null,
            techId: 'B',
        });

        const without = await partsCallService.buildRobotCallSlot({ ...ISO_WINDOW }, CO);
        expect(without.ok).toBe(true);
        expect(without.slot.techId).toBeNull();
    });

    test('TC-TS-17: dispatcher slot with techId → inserted slot_json = canonical keys + techId + job lat/lng', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB, assigned_techs: [{ id: 'A' }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 920 }] });

        const out = await partsCallService.startRobotCall(50, CO, 70, null, { ...ISO_WINDOW, techId: 'B' });

        expect(out.ok).toBe(true);
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(JSON.parse(insertCall[1][6])).toEqual({
            key: '2026-07-09|09:00|11:00',
            date: '2026-07-09',
            start: '09:00',
            end: '11:00',
            label: recommendSlots.formatSlotLabel('2026-07-09', '09:00', '11:00'),
            techName: null,
            confidence: null,
            techId: 'B', // the dispatcher's lane pick WINS over the single assigned tech
            lat: 42.1,
            lng: -71.1,
        });
    });

    test('TC-TS-17b: invalid ISO still → invalid_slot even when techId present (SLOTPICK regression)', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB, assigned_techs: [{ id: 'A' }] });

        const out = await partsCallService.startRobotCall(50, CO, 70, null, { startIso: 'bad', endIso: 'worse', techId: 'B' });

        expect(out).toEqual({ ok: false, reason: 'invalid_slot' });
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeFalsy();
    });

    test('single-tech default: dispatcher slot WITHOUT techId → defaults to the sole assigned tech (spec edge 1)', async () => {
        jobsService.getJobById.mockResolvedValue({ ...DIALABLE_JOB, assigned_techs: [{ id: 'A' }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 921 }] });

        const out = await partsCallService.startRobotCall(50, CO, 70, null, { ...ISO_WINDOW });

        expect(out.ok).toBe(true);
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(JSON.parse(insertCall[1][6])).toMatchObject({ techId: 'A', lat: 42.1, lng: -71.1 });
    });

    test('auto-compute path enriched too: sole-tech default + coords; missing job coords → null (non-fatal)', async () => {
        jobsService.getJobById.mockResolvedValue({
            ...DIALABLE_JOB,
            assigned_techs: [{ id: 'A' }],
            lat: null,
            lng: null,
        });
        recommendSlots.run.mockResolvedValue({ available: true, slots: [TOP_SLOT] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 922 }] });

        const out = await partsCallService.startRobotCall(50, CO, 70);

        expect(out.ok).toBe(true);
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(JSON.parse(insertCall[1][6])).toEqual({ ...TOP_SLOT, techId: 'A', lat: null, lng: null });
    });
});

// ---------------------------------------------------------------------------
// BTN-06 (OUTBOUND-PARTS-CALL-BTN-001): onPartArrived also thread-links the new
// job task to the customer's Pulse timeline so it surfaces as Action Required —
// best-effort, non-fatal, guarded (no contact / a link failure → job-only task,
// creation never fails). All three branches asserted with the db + timeline seams
// mocked (no real timeline row is touched).
// ---------------------------------------------------------------------------

describe('BTN-06: onPartArrived — best-effort Pulse thread-link (AR-TASK-UNIFY)', () => {
    let errSpy;
    beforeEach(() => {
        // The non-fatal branch logs via console.error — silence it for a clean run.
        errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => errSpy.mockRestore());

    test('job HAS contact_id → thread-links task to the customer timeline (thread_id=999, company-scoped, IS NULL guard)', async () => {
        // 1) dedup SELECT → none; 2) job lookup returns customer_name + contact_id;
        // 3) the thread-link UPDATE → 1 row affected.
        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ customer_name: 'Jane', contact_id: 501 }] })
            .mockResolvedValueOnce({ rowCount: 1 });
        tasksQueries.createTask.mockResolvedValueOnce({ id: 70, kind: 'part_arrived_call' });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValueOnce({ id: 999 });
        tasksQueries.getTaskById.mockResolvedValueOnce({ id: 70, thread_id: 999, actions: [{ type: 'robot_call' }] });

        const out = await partsCallService.onPartArrived(50, CO);

        // Timeline resolved for the job's contact, company-scoped, on the shared conn.
        expect(timelinesQueries.findOrCreateTimelineByContact).toHaveBeenCalledWith(501, CO, dbConn);
        // The thread-link UPDATE ran: thread_id=$3=999, contact_id=$4=501, company $1,
        // guarded by `thread_id IS NULL` (idempotent — won't relink an already-linked task).
        const linkCall = mockQuery.mock.calls.find(
            (c) => /UPDATE tasks/i.test(String(c[0])) && /thread_id/.test(String(c[0]))
        );
        expect(linkCall).toBeTruthy();
        expect(linkCall[0]).toMatch(/thread_id = \$3/);
        expect(linkCall[0]).toMatch(/company_id = \$1/);
        expect(linkCall[0]).toMatch(/thread_id IS NULL/);
        expect(linkCall[1]).toEqual([CO, 70, 999, 501]);
        // Returns the re-hydrated (now timeline-linked) task.
        expect(tasksQueries.getTaskById).toHaveBeenCalledWith(CO, 70, null);
        expect(out).toMatchObject({ id: 70, thread_id: 999 });
    });

    test('job has NO contact_id → no link attempted, task returned job-only, no throw', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ customer_name: 'Jane', contact_id: null }] });
        tasksQueries.createTask.mockResolvedValueOnce({ id: 71, kind: 'part_arrived_call' });

        const out = await partsCallService.onPartArrived(50, CO);

        // The `contactId != null` guard short-circuits — no timeline resolution at all.
        expect(timelinesQueries.findOrCreateTimelineByContact).not.toHaveBeenCalled();
        const linkCall = mockQuery.mock.calls.find((c) => /UPDATE tasks/i.test(String(c[0])));
        expect(linkCall).toBeFalsy();
        // The job-only created task is returned as-is (no re-hydration).
        expect(out).toEqual({ id: 71, kind: 'part_arrived_call' });
        expect(tasksQueries.getTaskById).not.toHaveBeenCalled();
    });

    test('findOrCreateTimelineByContact THROWS → still resolves with the created task (error swallowed, creation NOT rolled back)', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ customer_name: 'Jane', contact_id: 501 }] });
        tasksQueries.createTask.mockResolvedValueOnce({ id: 72, kind: 'part_arrived_call' });
        timelinesQueries.findOrCreateTimelineByContact.mockRejectedValueOnce(new Error('timeline boom'));

        // MUST NOT throw despite the link seam rejecting.
        const out = await partsCallService.onPartArrived(50, CO);

        // Task creation happened and was NOT rolled back by the failed link.
        expect(tasksQueries.createTask).toHaveBeenCalledTimes(1);
        // The thread-link UPDATE never ran (resolution threw before it).
        const linkCall = mockQuery.mock.calls.find((c) => /UPDATE tasks/i.test(String(c[0])));
        expect(linkCall).toBeFalsy();
        // Resolves with the job-only created task (the error is swallowed / logged).
        expect(out).toEqual({ id: 72, kind: 'part_arrived_call' });
    });
});

// ---------------------------------------------------------------------------
// OUTBOUND-PARTS-CALL-CANCEL-001 (CC-01) — the cancel core (TC-CC-01…05), the
// retry-chain guard `isChainCanceled`, the generalized robot_call stamps and the
// startRobotCall queued re-stamp (TC-CC-17). All SQL company-scoped; never throws.
// ---------------------------------------------------------------------------

describe('CANCEL-001: cancelScheduledRobotCalls — cancel core (TC-CC-01…05)', () => {
    const PENDING_ROW = {
        id: 10, job_id: 5, task_id: 7, contact_id: 501,
        phone: '+16175550100', attempt_no: 1, status: 'pending', slot_json: null,
    };
    const DIALING_ROW = {
        id: 11, job_id: 5, task_id: 7, contact_id: 501,
        phone: '+16175550100', attempt_no: 2, status: 'dialing', slot_json: null,
    };
    const ACTIONS_ROW = {
        rows: [{
            actions: [
                { type: 'robot_call', label: '🤖 Let the robot call' },
                { type: 'manual_call', label: "📞 I'll call myself" },
            ],
        }],
    };

    test('TC-CC-01: pending flip + ONE FR-3 note + task stamp + event (status_change); NO marker', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [PENDING_ROW] })             // active SELECT
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 10 }] }) // flip UPDATE (re-checks pending)
            .mockResolvedValueOnce(ACTIONS_ROW)                         // stamp SELECT actions
            .mockResolvedValueOnce({ rows: [] });                       // stamp UPDATE

        const out = await partsCallService.cancelScheduledRobotCalls(
            { jobId: 5 }, CO, { kind: 'status_change', newStatus: 'Rescheduled' },
        );

        expect(out).toEqual({ canceled: 1, marker: false });

        // Active SELECT is company+job scoped to the ACTIVE statuses only.
        const [selSql, selParams] = mockQuery.mock.calls[0];
        expect(selSql).toMatch(/company_id = \$1 AND job_id = \$2/);
        expect(selSql).toMatch(/scenario = 'parts_visit'/);
        expect(selSql).toMatch(/status IN \('pending','dialing'\)/);
        expect(selParams).toEqual([CO, 5]);

        // The flip targets the pending row by id, re-checks status='pending',
        // stamps the machine reason, and is company-scoped.
        const flip = mockQuery.mock.calls.find((c) => /UPDATE outbound_call_attempts/i.test(c[0]));
        expect(flip).toBeTruthy();
        expect(flip[0]).toMatch(/SET status = 'canceled'/);
        expect(flip[0]).toMatch(/AND status = 'pending'/);
        expect(flip[0]).toMatch(/company_id = \$1/);
        expect(flip[1]).toEqual([CO, 10, 'status_change:Rescheduled']);

        // Exactly ONE FR-3 note through the REAL addNote signature.
        expect(jobsService.addNote).toHaveBeenCalledTimes(1);
        expect(jobsService.addNote).toHaveBeenCalledWith(
            5,
            "AI: robot call canceled — job left 'Part arrived' (status changed to 'Rescheduled').",
            [], 'AI Phone', 'AI Phone',
        );

        // Task 7's robot_call action → {state:'canceled', reason}; other actions verbatim.
        const stampUpd = mockQuery.mock.calls.find((c) => /UPDATE tasks SET actions/i.test(c[0]));
        expect(stampUpd).toBeTruthy();
        expect(stampUpd[1][0]).toBe(CO);
        expect(stampUpd[1][1]).toBe(7);
        const written = JSON.parse(stampUpd[1][2]);
        expect(written.find((a) => a.type === 'robot_call')).toEqual({
            type: 'robot_call',
            label: '🤖 Let the robot call',
            state: 'canceled',
            reason: "Canceled — job status changed to 'Rescheduled'.",
        });
        expect(written.find((a) => a.type === 'manual_call')).toEqual({
            type: 'manual_call', label: "📞 I'll call myself",
        });

        // A pending flip needs NO mid-flight marker.
        const marker = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(marker).toBeFalsy();

        // Domain event logged for the job, company-scoped.
        expect(eventService.logEvent).toHaveBeenCalledTimes(1);
        expect(eventService.logEvent).toHaveBeenCalledWith(
            CO, 'job', 5, 'outbound_call_canceled',
            expect.objectContaining({ canceled: 1, marker: false, kind: 'status_change', newStatus: 'Rescheduled' }),
            'system',
        );
    });

    test('TC-CC-02: no active rows → silent no-op {canceled:0}; twice → still zero side effects', async () => {
        mockQuery.mockResolvedValue({ rows: [] }); // active SELECT (both calls)

        const cause = { kind: 'status_change', newStatus: 'Rescheduled' };
        const first = await partsCallService.cancelScheduledRobotCalls({ jobId: 5 }, CO, cause);
        const second = await partsCallService.cancelScheduledRobotCalls({ jobId: 5 }, CO, cause);

        expect(first).toEqual({ canceled: 0, marker: false });
        expect(second).toEqual({ canceled: 0, marker: false });
        // ZERO notes, ZERO stamps, ZERO writes of any kind — only the two SELECTs.
        expect(jobsService.addNote).not.toHaveBeenCalled();
        expect(eventService.logEvent).not.toHaveBeenCalled();
        const writes = mockQuery.mock.calls.filter((c) => /UPDATE|INSERT/i.test(c[0]));
        expect(writes).toHaveLength(0);
        expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('TC-CC-03: dialing-only → NO UPDATE of the in-flight row; canceled MARKER inserted (exhausted column set) + suffix note + stamp', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [DIALING_ROW] }) // active SELECT
            .mockResolvedValueOnce({ rows: [{ id: 12 }] })  // marker INSERT
            .mockResolvedValueOnce(ACTIONS_ROW)             // stamp SELECT actions
            .mockResolvedValueOnce({ rows: [] });           // stamp UPDATE

        const out = await partsCallService.cancelScheduledRobotCalls(
            { jobId: 5 }, CO,
            { kind: 'status_change', newStatus: 'Rescheduled' },
        );

        expect(out).toEqual({ canceled: 0, marker: true });

        // The dialing row is NEVER touched (owner default: no mid-call kill).
        const attemptUpdate = mockQuery.mock.calls.find((c) => /UPDATE outbound_call_attempts/i.test(c[0]));
        expect(attemptUpdate).toBeFalsy();

        // ONE marker INSERT mirroring the exhausted-marker column set
        // (company/job/task/contact/phone/attempt_no + slot_json + reason).
        const marker = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(marker).toBeTruthy();
        expect(marker[0]).toMatch(/'canceled'/);
        expect(marker[0]).toMatch(/company_id, job_id, task_id, contact_id, phone, attempt_no, status, scheduled_at, slot_json, reason/);
        expect(marker[1]).toEqual([CO, 5, 7, 501, '+16175550100', 2, null, 'status_change:Rescheduled']);

        // The FR-3 status-leave note carries the mid-flight suffix.
        expect(jobsService.addNote).toHaveBeenCalledTimes(1);
        expect(jobsService.addNote.mock.calls[0][1]).toBe(
            "AI: robot call canceled — job left 'Part arrived' (status changed to 'Rescheduled')."
            + ' A call already in progress will not be retried.',
        );

        // Task stamped canceled with the short status-leave reason.
        const stampUpd = mockQuery.mock.calls.find((c) => /UPDATE tasks SET actions/i.test(c[0]));
        const robot = JSON.parse(stampUpd[1][2]).find((a) => a.type === 'robot_call');
        expect(robot.state).toBe('canceled');
        expect(robot.reason).toBe("Canceled — job status changed to 'Rescheduled'.");
    });

    test('TC-CC-04: non-job scope is owned by the shared customer-contact core → no query here', async () => {
        const out = await partsCallService.cancelScheduledRobotCalls(
            { phone: '+16175550100' }, CO,
            { kind: 'status_change', newStatus: 'Rescheduled' },
        );
        expect(out).toEqual({ canceled: 0, marker: false });
        expect(mockQuery).not.toHaveBeenCalled();
        expect(jobsService.addNote).not.toHaveBeenCalled();
    });

    test('TC-CC-05: db.query rejects → resolves {canceled:0} (never throws), console.warn', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockQuery.mockRejectedValueOnce(new Error('db down'));

        await expect(partsCallService.cancelScheduledRobotCalls(
            { jobId: 5 }, CO, { kind: 'status_change', newStatus: 'Rescheduled' },
        )).resolves.toMatchObject({ canceled: 0 });

        expect(warn).toHaveBeenCalled();
        expect(jobsService.addNote).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    test('note failure is guarded: addNote rejects → still resolves {canceled:1} and the stamp still runs', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        jobsService.addNote.mockRejectedValueOnce(new Error('note boom'));
        mockQuery
            .mockResolvedValueOnce({ rows: [PENDING_ROW] })             // active SELECT
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 10 }] }) // flip UPDATE
            .mockResolvedValueOnce(ACTIONS_ROW)                         // stamp SELECT
            .mockResolvedValueOnce({ rows: [] });                       // stamp UPDATE

        const out = await partsCallService.cancelScheduledRobotCalls(
            { jobId: 5 }, CO, { kind: 'status_change', newStatus: 'Canceled' },
        );

        expect(out).toEqual({ canceled: 1, marker: false });
        const stampUpd = mockQuery.mock.calls.find((c) => /UPDATE tasks SET actions/i.test(c[0]));
        expect(stampUpd).toBeTruthy(); // note fault did NOT abort the stamp
        warn.mockRestore();
    });
});

describe('CANCEL-001: isChainCanceled — newer-canceled-row guard read', () => {
    test('EXISTS is scoped company+job and counts ONLY rows with id > sinceAttemptId', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ canceled: true }] });

        await expect(partsCallService.isChainCanceled(CO, 5, 42)).resolves.toBe(true);

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/SELECT EXISTS/i);
        expect(sql).toMatch(/company_id = \$1 AND job_id = \$2/);
        expect(sql).toMatch(/status = 'canceled' AND id > \$3/);
        expect(params).toEqual([CO, 5, 42]);
    });

    test('no newer canceled row → false; read fault → false (fail-open, no throw)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ canceled: false }] });
        await expect(partsCallService.isChainCanceled(CO, 5, 42)).resolves.toBe(false);

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockQuery.mockRejectedValueOnce(new Error('read boom'));
        await expect(partsCallService.isChainCanceled(CO, 5, 42)).resolves.toBe(false);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('CANCEL-001: robot_call action stamps (wrapper regression + generalization)', () => {
    const STAMP_ACTIONS = {
        rows: [{
            actions: [
                { type: 'robot_call', label: '🤖 Let the robot call' },
                { type: 'manual_call', label: "📞 I'll call myself" },
            ],
        }],
    };

    test('markRobotCallFailed still stamps {state:failed, reason} (pre-existing behavior kept)', async () => {
        mockQuery.mockResolvedValueOnce(STAMP_ACTIONS).mockResolvedValueOnce({ rows: [] });

        await partsCallService.markRobotCallFailed(CO, 7, 'boom');

        const upd = mockQuery.mock.calls.find((c) => /UPDATE tasks SET actions/i.test(c[0]));
        expect(upd[1][0]).toBe(CO);
        expect(upd[1][1]).toBe(7);
        const written = JSON.parse(upd[1][2]);
        expect(written.find((a) => a.type === 'robot_call')).toEqual({
            type: 'robot_call', label: '🤖 Let the robot call', state: 'failed', reason: 'boom',
        });
        expect(written.find((a) => a.type === 'manual_call')).toEqual({
            type: 'manual_call', label: "📞 I'll call myself",
        });
    });

    test('markRobotCallCanceled stamps {state:canceled, reason} through the same jsonb map', async () => {
        mockQuery.mockResolvedValueOnce(STAMP_ACTIONS).mockResolvedValueOnce({ rows: [] });

        await partsCallService.markRobotCallCanceled(CO, 7, 'Canceled — customer was already reached by phone.');

        const upd = mockQuery.mock.calls.find((c) => /UPDATE tasks SET actions/i.test(c[0]));
        const robot = JSON.parse(upd[1][2]).find((a) => a.type === 'robot_call');
        expect(robot).toEqual({
            type: 'robot_call', label: '🤖 Let the robot call',
            state: 'canceled', reason: 'Canceled — customer was already reached by phone.',
        });
    });
});

describe('CANCEL-001 (TC-CC-17): startRobotCall re-queue resets the stamp to queued', () => {
    const STALE_CANCELED_ACTIONS = {
        rows: [{
            actions: [
                { type: 'robot_call', label: '🤖 Let the robot call', state: 'canceled', reason: "Canceled — job status changed to 'Rescheduled'." },
                { type: 'manual_call', label: "📞 I'll call myself" },
            ],
        }],
    };

    test('fresh INSERT success → robot_call → {state:queued}, stale canceled reason CLEARED', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        recommendSlots.run.mockResolvedValue({ available: true, slots: [TOP_SLOT] });
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 930 }] })   // enqueue INSERT
            .mockResolvedValueOnce(STALE_CANCELED_ACTIONS)    // stamp SELECT actions
            .mockResolvedValueOnce({ rows: [] });             // stamp UPDATE

        const out = await partsCallService.startRobotCall(50, CO, 70);

        expect(out).toEqual({ ok: true, attemptId: 930, slot: enriched(TOP_SLOT) });
        const upd = mockQuery.mock.calls.find((c) => /UPDATE tasks SET actions/i.test(c[0]));
        expect(upd).toBeTruthy();
        expect(upd[1][0]).toBe(CO);
        expect(upd[1][1]).toBe(70);
        const written = JSON.parse(upd[1][2]);
        const robot = written.find((a) => a.type === 'robot_call');
        expect(robot).toEqual({ type: 'robot_call', label: '🤖 Let the robot call', state: 'queued' });
        expect(robot).not.toHaveProperty('reason'); // stale reason cleared
        expect(written.find((a) => a.type === 'manual_call')).toEqual({
            type: 'manual_call', label: "📞 I'll call myself",
        });
    });

    test('already:true (23505) path is ALSO a successful enqueue → stamps queued too', async () => {
        jobsService.getJobById.mockResolvedValue(DIALABLE_JOB);
        recommendSlots.run.mockResolvedValue({ available: true, slots: [TOP_SLOT] });
        const dup = new Error('duplicate key value violates unique constraint');
        dup.code = '23505';
        mockQuery
            .mockRejectedValueOnce(dup)                       // the INSERT
            .mockResolvedValueOnce({ rows: [{ id: 800 }] })   // existing-active SELECT
            .mockResolvedValueOnce(STALE_CANCELED_ACTIONS)    // stamp SELECT actions
            .mockResolvedValueOnce({ rows: [] });             // stamp UPDATE

        const out = await partsCallService.startRobotCall(50, CO, 70);

        expect(out).toEqual({ ok: true, already: true, attemptId: 800 });
        const upd = mockQuery.mock.calls.find((c) => /UPDATE tasks SET actions/i.test(c[0]));
        expect(upd).toBeTruthy();
        const robot = JSON.parse(upd[1][2]).find((a) => a.type === 'robot_call');
        expect(robot).toEqual({ type: 'robot_call', label: '🤖 Let the robot call', state: 'queued' });
    });
});

// The AI/Sara detector and cross-scenario matrix now live with the neutral core.
// Keep this compatibility export pinned so older callers cannot fork behavior.
describe('OUTBOUND-CALL-CANCEL-001: onHumanContact compatibility wrapper', () => {
    test('delegates the stored call row and optional client to the shared detector', async () => {
        const call = { call_sid: 'CA1', company_id: CO };
        const client = { query: jest.fn() };
        outboundCallCancellationService.cancelForCompletedCustomerCall
            .mockResolvedValueOnce({ canceled: 2, marker: true });

        await expect(partsCallService.onHumanContact(call, client))
            .resolves.toEqual({ canceled: 2, marker: true });
        expect(outboundCallCancellationService.cancelForCompletedCustomerCall)
            .toHaveBeenCalledWith(call, client);
    });
});
