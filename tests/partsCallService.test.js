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
// SLOTPICK-001: buildRobotCallSlot derives company-local date/time via resolveTimezone.
jest.mock('../backend/src/services/slotEngineService', () => ({
    resolveTimezone: jest.fn(async () => 'America/New_York'),
}));

const tasksQueries = require('../backend/src/db/tasksQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const dbConn = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');
const recommendSlots = require('../backend/src/services/agentSkills/skills/recommendSlots');
const settings = require('../backend/src/services/outboundCallSettingsService');
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

beforeEach(() => {
    jest.clearAllMocks();
    settings.resolve.mockResolvedValue({ enabled: true, max_attempts: 3 });
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

        expect(out).toEqual({ ok: true, attemptId: 900, slot: TOP_SLOT });

        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeTruthy();
        expect(insertCall[0]).toMatch(/'pending'/i);
        expect(insertCall[0]).toMatch(/now\(\)/i);
        // slot_json carries the serialized top-1 slot; params carry company/job/task/phone.
        const params = insertCall[1];
        expect(params[0]).toBe(CO);
        expect(params[1]).toBe(50);
        expect(params[2]).toBe(70);
        expect(params[4]).toBe('+16175551212');
        expect(JSON.parse(params[5])).toEqual(TOP_SLOT);
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
    });

    test('TC-SP-07: valid dispatcher slot → SKIP recommendSlots, enqueue the built slot_json', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 901 }] }); // the INSERT
        const dispatcherSlot = { startIso: '2026-07-09T13:00:00Z', endIso: '2026-07-09T15:00:00Z' };

        const out = await partsCallService.startRobotCall(50, CO, 70, null, dispatcherSlot);

        // Engine precompute is SKIPPED entirely.
        expect(recommendSlots.run).not.toHaveBeenCalled();
        expect(out).toEqual({ ok: true, attemptId: 901, slot: EXPECTED_SLOT() });

        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(insertCall).toBeTruthy();
        const params = insertCall[1];
        expect(params[0]).toBe(CO); // company_id scoped
        expect(params[1]).toBe(50);
        expect(params[2]).toBe(70);
        expect(JSON.parse(params[5])).toEqual(EXPECTED_SLOT()); // the built canonical slot, not the raw ISO
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
        expect(out).toEqual({ ok: true, attemptId: 902, slot: TOP_SLOT });
        const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO outbound_call_attempts/i.test(c[0]));
        expect(JSON.parse(insertCall[1][5])).toEqual(TOP_SLOT);
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
