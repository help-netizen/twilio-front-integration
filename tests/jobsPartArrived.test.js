/**
 * OUTBOUND-PARTS-CALL-001 — jobsService "Part arrived" + createTask passthrough (unit, mocked).
 *
 * Binding: Docs/test-cases/OUTBOUND-PARTS-CALL-001.md U03 (+ S1/S13 unit slices)
 * (spec §B.1/§B.2/§B.3 · arch §1). Covers:
 *   - tasksQueries.createTask additive kind+actions passthrough (legacy byte-identical).
 *   - updateBlancStatus: Waiting for parts → Part arrived valid; Part arrived → {Rescheduled,
 *     Canceled, Follow Up with Client} valid; an invalid target rejected.
 *   - S13 fail-safe: onPartArrived throws/rejects during the hook → the status transition
 *     STILL commits (the UPDATE ran, the function does not throw).
 *
 * db + fsmService + partsCallService mocked; no real HTTP/DB.
 */

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

// fsmService.resolveTransition — drive the fallback (hardcoded ALLOWED_TRANSITIONS)
// path so the transition validation under test is jobsService's own map.
const mockResolveTransition = jest.fn();
jest.mock('../backend/src/services/fsmService', () => ({
    resolveTransition: (...a) => mockResolveTransition(...a),
}));

// The fire-and-forget hooks lazy-require partsCallService — mock it so we can
// inject a throw/reject (S13 / TC-CC-07) and assert dispatch without the real
// lifecycle. cancelScheduledRobotCalls = CANCEL-001 CC-02 leave-hook target.
const mockOnPartArrived = jest.fn();
const mockCancelScheduledRobotCalls = jest.fn();
jest.mock('../backend/src/services/partsCallService', () => ({
    onPartArrived: (...a) => mockOnPartArrived(...a),
    cancelScheduledRobotCalls: (...a) => mockCancelScheduledRobotCalls(...a),
}));

const jobsService = require('../backend/src/services/jobsService');
const tasksQueries = require('../backend/src/db/tasksQueries');

const COMPANY = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockResolveTransition.mockReset();
    mockOnPartArrived.mockReset();
    mockOnPartArrived.mockResolvedValue(null);
    mockCancelScheduledRobotCalls.mockReset();
    mockCancelScheduledRobotCalls.mockResolvedValue({ canceled: 0, marker: false });
    // Default: fallback path so jobsService's hardcoded ALLOWED_TRANSITIONS validates.
    mockResolveTransition.mockResolvedValue({ fallback: true });
});

// Wire getJobById (first query) → a job in `fromStatus`, then the UPDATE.
function seedJob({ fromStatus, zenbookerJobId = null }) {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql) => {
        const s = String(sql);
        if (/UPDATE jobs/i.test(s)) return { rows: [] };
        // getJobById SELECT (and any other read) → the job row.
        return {
            rows: [{
                id: 50, company_id: COMPANY, blanc_status: fromStatus,
                zenbooker_job_id: zenbookerJobId, zb_canceled: false,
                customer_name: 'Jane',
            }],
        };
    });
}

function updateJobsCall() {
    return mockQuery.mock.calls.find(c => /UPDATE jobs/i.test(String(c[0])) && /blanc_status/.test(String(c[0])));
}

// ── U03 — createTask additive kind+actions passthrough ────────────────────────
describe('createTask additive passthrough (U03)', () => {
    test('kind + actions present → INSERT includes both columns (actions ::jsonb)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10 }] }); // INSERT RETURNING id
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 10, kind: 'part_arrived_call' }] }); // getTaskById

        await tasksQueries.createTask(COMPANY, {
            parentType: 'job', parentId: 50,
            description: 'Part arrived — schedule completion visit for Jane',
            kind: 'part_arrived_call',
            actions: [{ type: 'robot_call' }, { type: 'manual_call' }],
        });

        const [sql, vals] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO tasks/i);
        expect(sql).toMatch(/kind/);
        expect(sql).toMatch(/actions/);
        expect(sql).toMatch(/::jsonb/);
        // actions is JSON-serialized.
        expect(vals).toContain('part_arrived_call');
        expect(vals).toContain(JSON.stringify([{ type: 'robot_call' }, { type: 'manual_call' }]));
    });

    test('legacy caller (no kind/actions) → INSERT byte-identical to today (no new cols)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 11 }] });
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 11 }] });

        await tasksQueries.createTask(COMPANY, {
            parentType: 'job', parentId: 5,
            description: 'Call client',
            owner_user_id: 'u1', author_user_id: 'u1',
        });

        const [sql] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO tasks/i);
        // No kind / actions columns for a legacy caller.
        expect(sql).not.toMatch(/\bkind\b/);
        expect(sql).not.toMatch(/\bactions\b/);
        expect(sql).not.toMatch(/::jsonb/);
    });
});

// ── FSM transitions via hardcoded ALLOWED_TRANSITIONS fallback ────────────────
describe('Part arrived transitions (spec §B.1)', () => {
    test('Waiting for parts → Part arrived is valid (UPDATE runs)', async () => {
        seedJob({ fromStatus: 'Waiting for parts' });
        const out = await jobsService.updateBlancStatus(50, 'Part arrived', COMPANY);
        expect(updateJobsCall()).toBeTruthy();
        expect(out.blanc_status).toBe('Part arrived');
        expect(out._prev_status).toBe('Waiting for parts');
    });

    test.each(['Rescheduled', 'Canceled', 'Follow Up with Client'])(
        'Part arrived → %s is valid',
        async (target) => {
            seedJob({ fromStatus: 'Part arrived' });
            const out = await jobsService.updateBlancStatus(50, target, COMPANY);
            expect(updateJobsCall()).toBeTruthy();
            expect(out.blanc_status).toBe(target);
        }
    );

    test('Part arrived → Completed (not in the allow-list) is rejected', async () => {
        seedJob({ fromStatus: 'Part arrived' });
        await expect(jobsService.updateBlancStatus(50, 'Completed', COMPANY))
            .rejects.toThrow(/not allowed|Invalid/i);
        // No UPDATE ran on a rejected transition.
        expect(updateJobsCall()).toBeUndefined();
    });
});

// ── S13 — fail-safe hook: onPartArrived throws → transition STILL commits ──────
describe('fail-safe hook (S13)', () => {
    test('onPartArrived rejects → updateBlancStatus still resolves with Part arrived (UPDATE committed)', async () => {
        seedJob({ fromStatus: 'Waiting for parts' });
        mockOnPartArrived.mockRejectedValueOnce(new Error('createTask boom'));

        // Must NOT throw despite the hook rejection.
        const out = await jobsService.updateBlancStatus(50, 'Part arrived', COMPANY);

        expect(out.blanc_status).toBe('Part arrived');
        // The status UPDATE committed regardless of the thrown hook.
        expect(updateJobsCall()).toBeTruthy();
        // The hook WAS invoked (fire-and-forget) with (jobId, companyId).
        expect(mockOnPartArrived).toHaveBeenCalledWith(50, COMPANY);
        // Let the rejected .catch settle so no unhandled-rejection warning leaks.
        await new Promise((r) => setImmediate(r));
    });

    test('onPartArrived throws synchronously → transition still commits, no throw', async () => {
        seedJob({ fromStatus: 'Waiting for parts' });
        mockOnPartArrived.mockImplementationOnce(() => { throw new Error('sync boom'); });

        const out = await jobsService.updateBlancStatus(50, 'Part arrived', COMPANY);
        expect(out.blanc_status).toBe('Part arrived');
        expect(updateJobsCall()).toBeTruthy();
    });

    test('hook only fires on ENTRY to Part arrived (re-entry from Part arrived → no hook)', async () => {
        seedJob({ fromStatus: 'Part arrived' });
        await jobsService.updateBlancStatus(50, 'Rescheduled', COMPANY);
        expect(mockOnPartArrived).not.toHaveBeenCalled();
    });
});

// ── OUTBOUND-PARTS-CALL-CANCEL-001 (CC-02) — leave-hooks ──────────────────────
// TC-CC-07/08/09: every writer that can exit 'Part arrived' fires the cancel
// exactly once with ({jobId}, companyId, {kind:'status_change', newStatus});
// non-Part-arrived pre-states never fire; hook failure never fails the write.

// Seed for syncFromZenbooker: getJobByZbId SELECT → the existing row; UPDATE → ok.
function seedZbSync(existingRow) {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql) => {
        const s = String(sql);
        if (/UPDATE jobs/i.test(s)) return { rows: [], rowCount: 1 };
        if (/FROM jobs WHERE zenbooker_job_id/i.test(s)) return { rows: existingRow ? [existingRow] : [] };
        return { rows: [] };
    });
}

function zbSyncUpdateCall() {
    return mockQuery.mock.calls.find(c => /UPDATE jobs/i.test(String(c[0])) && /zb_status = \$1/.test(String(c[0])));
}

describe('CANCEL-001 leave-hooks (TC-CC-07 updateBlancStatus)', () => {
    test('Part arrived → Rescheduled fires cancel ONCE with ({jobId}, companyId, status_change cause)', async () => {
        seedJob({ fromStatus: 'Part arrived' });
        await jobsService.updateBlancStatus(50, 'Rescheduled', COMPANY);
        expect(mockCancelScheduledRobotCalls).toHaveBeenCalledTimes(1);
        expect(mockCancelScheduledRobotCalls).toHaveBeenCalledWith(
            { jobId: 50 }, COMPANY, { kind: 'status_change', newStatus: 'Rescheduled' }
        );
        // Leave, not enter: the enter-hook must NOT fire on an exit transition.
        expect(mockOnPartArrived).not.toHaveBeenCalled();
    });

    test('no-company legacy path → companyId falls back to the job row tenant', async () => {
        seedJob({ fromStatus: 'Part arrived' });
        await jobsService.updateBlancStatus(50, 'Rescheduled'); // no companyId arg
        expect(mockCancelScheduledRobotCalls).toHaveBeenCalledWith(
            { jobId: 50 }, COMPANY, { kind: 'status_change', newStatus: 'Rescheduled' }
        );
    });

    test('ENTER transition (Waiting for parts → Part arrived) → cancel NOT called, enter-hook fires (regression)', async () => {
        seedJob({ fromStatus: 'Waiting for parts' });
        await jobsService.updateBlancStatus(50, 'Part arrived', COMPANY);
        expect(mockCancelScheduledRobotCalls).not.toHaveBeenCalled();
        expect(mockOnPartArrived).toHaveBeenCalledWith(50, COMPANY);
    });

    test('never-was-Part-arrived (Submitted → Canceled) → cancel NOT called', async () => {
        seedJob({ fromStatus: 'Submitted' });
        await jobsService.updateBlancStatus(50, 'Canceled', COMPANY);
        expect(mockCancelScheduledRobotCalls).not.toHaveBeenCalled();
    });

    test('rejecting cancel does NOT reject updateBlancStatus (fire-and-forget)', async () => {
        seedJob({ fromStatus: 'Part arrived' });
        mockCancelScheduledRobotCalls.mockRejectedValueOnce(new Error('cancel boom'));
        const out = await jobsService.updateBlancStatus(50, 'Rescheduled', COMPANY);
        expect(out.blanc_status).toBe('Rescheduled');
        expect(updateJobsCall()).toBeTruthy(); // the status UPDATE committed
        await new Promise((r) => setImmediate(r)); // settle the .catch
    });

    test('synchronously-throwing cancel does NOT break the transition', async () => {
        seedJob({ fromStatus: 'Part arrived' });
        mockCancelScheduledRobotCalls.mockImplementationOnce(() => { throw new Error('sync boom'); });
        const out = await jobsService.updateBlancStatus(50, 'Canceled', COMPANY);
        expect(out.blanc_status).toBe('Canceled');
        expect(updateJobsCall()).toBeTruthy();
    });
});

describe('CANCEL-001 leave-hooks (TC-CC-08 cancelJob + markComplete direct writers)', () => {
    test('cancelJob on a Part-arrived job → cancel with newStatus Canceled', async () => {
        seedJob({ fromStatus: 'Part arrived' }); // zenbooker_job_id null → no ZB client call
        const out = await jobsService.cancelJob(50);
        expect(out.blanc_status).toBe('Canceled');
        expect(mockCancelScheduledRobotCalls).toHaveBeenCalledTimes(1);
        expect(mockCancelScheduledRobotCalls).toHaveBeenCalledWith(
            { jobId: 50 }, COMPANY, { kind: 'status_change', newStatus: 'Canceled' }
        );
    });

    test('markComplete on a Part-arrived job → cancel with newStatus Visit completed', async () => {
        seedJob({ fromStatus: 'Part arrived' });
        const out = await jobsService.markComplete(50);
        expect(out.blanc_status).toBe('Visit completed');
        expect(mockCancelScheduledRobotCalls).toHaveBeenCalledTimes(1);
        expect(mockCancelScheduledRobotCalls).toHaveBeenCalledWith(
            { jobId: 50 }, COMPANY, { kind: 'status_change', newStatus: 'Visit completed' }
        );
    });

    test('job in Submitted → neither direct writer fires the hook', async () => {
        seedJob({ fromStatus: 'Submitted' });
        await jobsService.cancelJob(50);
        seedJob({ fromStatus: 'Submitted' });
        await jobsService.markComplete(50);
        expect(mockCancelScheduledRobotCalls).not.toHaveBeenCalled();
    });

    test('rejecting cancel does NOT reject cancelJob (non-fatal)', async () => {
        seedJob({ fromStatus: 'Part arrived' });
        mockCancelScheduledRobotCalls.mockRejectedValueOnce(new Error('boom'));
        const out = await jobsService.cancelJob(50);
        expect(out.blanc_status).toBe('Canceled');
        await new Promise((r) => setImmediate(r));
    });
});

describe('CANCEL-001 leave-hooks (TC-CC-09 syncFromZenbooker zb_canceled flip)', () => {
    const existingPartArrived = {
        id: 50, company_id: COMPANY, blanc_status: 'Part arrived',
        zenbooker_job_id: 'zb-1', zb_canceled: false, zb_status: 'scheduled',
        assigned_techs: [], notes: [],
    };

    test('zb_canceled false→true flip → cancel with Canceled (Zenbooker); blanc_status PRESERVED in the UPDATE', async () => {
        seedZbSync(existingPartArrived);
        const res = await jobsService.syncFromZenbooker('zb-1', { status: 'scheduled', canceled: true }, COMPANY);

        expect(mockCancelScheduledRobotCalls).toHaveBeenCalledTimes(1);
        expect(mockCancelScheduledRobotCalls).toHaveBeenCalledWith(
            { jobId: 50 }, COMPANY, { kind: 'status_change', newStatus: 'Canceled (Zenbooker)' }
        );

        // Regression pin (preserve path :1105-1120): the sync UPDATE keeps
        // blanc_status = 'Part arrived' ($4) even though ZB says Canceled.
        const upd = zbSyncUpdateCall();
        expect(upd).toBeTruthy();
        expect(upd[1][3]).toBe('Part arrived');
        expect(upd[1][1]).toBe(true); // zb_canceled ($2) written true
        expect(res.blanc_status).toBe('Part arrived');
    });

    test('incoming zb_canceled=false → no flip, no cancel', async () => {
        seedZbSync(existingPartArrived);
        await jobsService.syncFromZenbooker('zb-1', { status: 'scheduled', canceled: false }, COMPANY);
        expect(mockCancelScheduledRobotCalls).not.toHaveBeenCalled();
        expect(zbSyncUpdateCall()).toBeTruthy(); // sync itself still ran
    });

    test('existing zb_canceled already true → no flip, no cancel (idempotent re-sync)', async () => {
        seedZbSync({ ...existingPartArrived, zb_canceled: true });
        await jobsService.syncFromZenbooker('zb-1', { status: 'scheduled', canceled: true }, COMPANY);
        expect(mockCancelScheduledRobotCalls).not.toHaveBeenCalled();
    });

    test('existing job NOT Part arrived → flip does not fire the hook', async () => {
        seedZbSync({ ...existingPartArrived, blanc_status: 'Submitted' });
        await jobsService.syncFromZenbooker('zb-1', { status: 'scheduled', canceled: true }, COMPANY);
        expect(mockCancelScheduledRobotCalls).not.toHaveBeenCalled();
    });
});
