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

// The fire-and-forget hook lazy-requires partsCallService — mock it so we can
// inject a throw/reject (S13) and assert dispatch without the real lifecycle.
const mockOnPartArrived = jest.fn();
jest.mock('../backend/src/services/partsCallService', () => ({
    onPartArrived: (...a) => mockOnPartArrived(...a),
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
