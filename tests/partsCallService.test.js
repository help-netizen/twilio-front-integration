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
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
}));
jest.mock('../backend/src/services/agentSkills/skills/recommendSlots', () => ({
    run: jest.fn(),
}));
jest.mock('../backend/src/services/outboundCallSettingsService', () => ({
    resolve: jest.fn(async () => ({ enabled: true, max_attempts: 3 })),
}));

const tasksQueries = require('../backend/src/db/tasksQueries');
const jobsService = require('../backend/src/services/jobsService');
const recommendSlots = require('../backend/src/services/agentSkills/skills/recommendSlots');
const settings = require('../backend/src/services/outboundCallSettingsService');
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
