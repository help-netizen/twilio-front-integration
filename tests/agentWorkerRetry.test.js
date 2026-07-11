'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-002 — shared agentWorker retry state machine (mocked).
 * Target: agentWorker.processBatch. The retry is ADDITIVE + OPT-IN: default
 * max_attempts=1 stays terminal-on-first-failure (byte-for-byte), only max_attempts>1
 * re-queues with backoff. Covers A-01, A-02b, A-03, A-04, A-05 + the terminal
 * boundary table (the opt-in equivalence line that protects geocode/route/zb/mcp_tool).
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/agentWorkerRetry.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockQuery = jest.fn();
const mockRun = jest.fn();
const mockEmit = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../backend/src/services/agentHandlers', () => ({ run: mockRun }));
jest.mock('../backend/src/services/eventBus', () => ({ emit: mockEmit }));

const agentWorker = require('../backend/src/services/agentWorker');
const { taskRow } = require('./yelpFixtures');

// The claim is `UPDATE tasks SET agent_status='running' …`; every follow-up write is
// classified by its SQL. primeClaim returns `claimedRows` for the claim, empty else.
function primeClaim(claimedRows) {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql) =>
        /update tasks set agent_status\s*=\s*'running'/i.test(sql)
            ? { rows: claimedRows }
            : { rows: [] }
    );
}

// The per-task write that FOLLOWS the claim (succeeded / queued / failed), never the claim.
function followUpWrites() {
    return mockQuery.mock.calls.filter(([sql]) =>
        /update tasks/i.test(sql) && !/agent_status\s*=\s*'running'/i.test(sql)
    );
}

const emittedTypes = () => mockEmit.mock.calls.map((c) => c[1]);

beforeEach(() => {
    jest.clearAllMocks();
});

// ── A-01 · WORKER-default-terminal-once (P0, req #1) ──────────────────────────
describe('A-01 · WORKER-default-terminal-once (SAB-WORKER-REQUEUE-DEFAULT)', () => {
    it('default max_attempts=1 that throws → TERMINAL on attempt 1, single failed emit, not re-queued', async () => {
        primeClaim([taskRow({ id: 1, agent_type: 'job_geocode', attempt_count: 0, max_attempts: 1 })]);
        mockRun.mockRejectedValue(new Error('boom'));

        await agentWorker.processBatch();

        const writes = followUpWrites();
        // (1) exactly one follow-up write, sets agent_status='failed' (not 'queued')
        expect(writes).toHaveLength(1);
        const [sql, params] = writes[0];
        expect(sql).toMatch(/agent_status\s*=\s*'failed'/i);
        expect(sql).not.toMatch(/agent_status\s*=\s*'queued'/i);
        // (2) next_attempt_at stays NULL — no interval math, no future Date param
        expect(sql).toMatch(/next_attempt_at\s*=\s*null/i);
        expect(sql).not.toMatch(/make_interval/i);
        expect(params.some((p) => p instanceof Date)).toBe(false);
        // (3) status NOT flipped to done
        expect(sql).not.toMatch(/status\s*=\s*'done'/i);
        // (4) emit exactly once, agent_task.failed, never succeeded
        expect(mockEmit).toHaveBeenCalledTimes(1);
        expect(mockEmit.mock.calls[0][1]).toBe('agent_task.failed');
        expect(emittedTypes()).not.toContain('agent_task.succeeded');
        // (5) not re-queued — only the one claim + one terminal write on `tasks`
        const runningClaims = mockQuery.mock.calls.filter(([s]) => /agent_status\s*=\s*'running'/i.test(s));
        expect(runningClaims).toHaveLength(1);
    });
});

// ── A-02b · RETRY branch arithmetic (P0, req #2) ──────────────────────────────
describe('A-02b · RETRY state machine max_attempts=3 (SAB-RETRY-EMIT-EACH-ATTEMPT)', () => {
    it('claimed attempt_count 0→requeue, 1→requeue, 2→terminal; agent_task.failed exactly once total', async () => {
        mockRun.mockRejectedValue(new Error('smtp 503'));
        const results = [];
        for (const ac of [0, 1, 2]) {
            mockEmit.mockClear();
            primeClaim([taskRow({ id: 1, agent_type: 'yelp_lead', attempt_count: ac, max_attempts: 3 })]);
            await agentWorker.processBatch();
            results.push({ ac, writes: followUpWrites(), emits: emittedTypes() });
        }

        // attempt_count 0 and 1 → re-queue: queued, future next_attempt_at, NO emit
        for (const r of results.slice(0, 2)) {
            expect(r.writes).toHaveLength(1);
            const [sql, params] = r.writes[0];
            expect(sql).toMatch(/agent_status\s*=\s*'queued'/i);
            expect(sql).toMatch(/next_attempt_at\s*=\s*now\(\)\s*\+\s*make_interval/i);
            expect(params[2]).toBe(r.ac + 1);          // attempt_count = claimed+1
            expect(typeof params[3]).toBe('number');   // backoff seconds
            expect(params[3]).toBeGreaterThan(0);
            expect(r.emits).not.toContain('agent_task.failed');
            expect(r.emits).not.toContain('agent_task.succeeded');
        }
        // attempt_count 2 → terminal: failed, next_attempt_at NULL, ONE failed emit
        const term = results[2];
        expect(term.writes).toHaveLength(1);
        const [tsql, tparams] = term.writes[0];
        expect(tsql).toMatch(/agent_status\s*=\s*'failed'/i);
        expect(tsql).toMatch(/next_attempt_at\s*=\s*null/i);
        expect(tparams[2]).toBe(3);
        expect(term.emits).toEqual(['agent_task.failed']);
    });
});

// ── A-03 · CLAIM-respects-backoff: SQL shape (P0, req #3) ──────────────────────
describe('A-03 · CLAIM-respects-backoff (SAB-CLAIM-IGNORE-BACKOFF)', () => {
    it('claim SQL carries the next_attempt_at predicate AND preserves the pre-existing guards', async () => {
        mockQuery.mockReset();
        mockQuery.mockResolvedValue({ rows: [] }); // empty batch

        await agentWorker.processBatch();

        const [claimSql] = mockQuery.mock.calls[0];
        expect(claimSql).toMatch(/agent_status\s*=\s*'queued'/i);
        expect(claimSql).toMatch(/next_attempt_at\s+is\s+null\s+or\s+next_attempt_at\s*<=\s*now\(\)/i);
        expect(claimSql).toMatch(/for update skip locked/i);
        expect(claimSql).toMatch(/company_id is not null/i);
    });
});

// ── A-04 · success path unchanged (P1) ────────────────────────────────────────
describe('A-04 · success path unchanged', () => {
    it('yelp_lead handler resolves → succeeded/done/completed_at + emit succeeded once, no retry fields', async () => {
        primeClaim([taskRow({ id: 1, agent_type: 'yelp_lead', max_attempts: 3, attempt_count: 0 })]);
        mockRun.mockResolvedValue({ greeted: true, lead_id: 55 });

        await agentWorker.processBatch();

        const writes = followUpWrites();
        expect(writes).toHaveLength(1);
        const [sql] = writes[0];
        expect(sql).toMatch(/agent_status\s*=\s*'succeeded'/i);
        expect(sql).toMatch(/status\s*=\s*'done'/i);
        expect(sql).toMatch(/completed_at\s*=\s*now\(\)/i);
        expect(sql).not.toMatch(/next_attempt_at/i);
        expect(mockEmit).toHaveBeenCalledTimes(1);
        expect(mockEmit.mock.calls[0][1]).toBe('agent_task.succeeded');
        expect(emittedTypes()).not.toContain('agent_task.failed');
    });
});

// ── A-05 · tenant isolation (P2) ──────────────────────────────────────────────
describe('A-05 · tenant isolation', () => {
    it('claim keeps company_id IS NOT NULL; each emit is scoped to its own task.company_id', async () => {
        const A = '00000000-0000-0000-0000-00000000000a';
        const B = '00000000-0000-0000-0000-00000000000b';
        primeClaim([
            taskRow({ id: 1, company_id: A, agent_type: 'noop' }),
            taskRow({ id: 2, company_id: B, agent_type: 'noop' }),
        ]);
        mockRun.mockResolvedValue({ ok: true });

        await agentWorker.processBatch();

        const [claimSql] = mockQuery.mock.calls[0];
        expect(claimSql).toMatch(/company_id is not null/i);
        // emit(companyId, type, payload, {aggregateId}) — company A's task never emits under B.
        const callFor1 = mockEmit.mock.calls.find((c) => c[3] && c[3].aggregateId === 1);
        const callFor2 = mockEmit.mock.calls.find((c) => c[3] && c[3].aggregateId === 2);
        expect(callFor1[0]).toBe(A);
        expect(callFor2[0]).toBe(B);
    });
});

// ── terminal boundary table — the whole regression story (req #6, gap #2) ─────
describe('terminal boundary: terminal ⇔ attempt_count+1 >= max_attempts', () => {
    const cases = [
        { max: 1, ac: 0, terminal: true },
        { max: 2, ac: 0, terminal: false },
        { max: 2, ac: 1, terminal: true },
        { max: 3, ac: 0, terminal: false },
        { max: 3, ac: 1, terminal: false },
        { max: 3, ac: 2, terminal: true },
    ];
    it.each(cases)('max_attempts=$max, claimed attempt_count=$ac → terminal=$terminal', async ({ max, ac, terminal }) => {
        primeClaim([taskRow({ id: 1, agent_type: 'yelp_lead', attempt_count: ac, max_attempts: max })]);
        mockRun.mockRejectedValue(new Error('x'));

        await agentWorker.processBatch();

        const [sql] = followUpWrites()[0];
        if (terminal) {
            expect(sql).toMatch(/agent_status\s*=\s*'failed'/i);
            expect(emittedTypes()).toContain('agent_task.failed');
        } else {
            expect(sql).toMatch(/agent_status\s*=\s*'queued'/i);
            expect(emittedTypes()).not.toContain('agent_task.failed');
            expect(emittedTypes()).not.toContain('agent_task.succeeded');
        }
    });
});
