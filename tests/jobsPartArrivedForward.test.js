/**
 * JOB-FSM-PART-ARRIVED-FORWARD-001 — "Part arrived" must be a NON-BLOCKING status.
 *
 * Regression: migration 156 seeded Part_arrived with only Rescheduled / Follow Up /
 * Canceled, so a technician on a job in "Part arrived" had no FORWARD path (On the way /
 * Visit completed) — the job was trapped. This guards the STATIC fallback
 * (ALLOWED_TRANSITIONS in jobsService.js), used for tenants with no published FSM graph.
 * The per-company published graph is patched by migration 160 (verified against the DB).
 *
 * fsmService.resolveTransition is mocked to return { fallback: true } so updateBlancStatus
 * exercises the hardcoded ALLOWED_TRANSITIONS branch specifically.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/fsmService', () => ({
    // Force the hardcoded-fallback path (no published graph for this tenant).
    resolveTransition: jest.fn(async () => ({ valid: null, fallback: true })),
}));

const db = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');

const COMPANY = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
    db.query.mockReset();
    // getJobById (first query) returns a job already in "Part arrived".
    db.query.mockResolvedValue({ rows: [{ id: 7, blanc_status: 'Part arrived', company_id: COMPANY }] });
});

function updateCall() {
    return db.query.mock.calls.find(
        c => /UPDATE jobs/.test(String(c[0])) && /blanc_status/.test(String(c[0])),
    );
}

describe('Part arrived is non-blocking (static ALLOWED_TRANSITIONS fallback)', () => {
    // The forward/back transitions the fix adds — each must now be permitted.
    it.each([
        'On the way',
        'Visit completed',
        'Waiting for parts',
        'Submitted',
        // the three that already worked pre-fix stay allowed
        'Rescheduled',
        'Follow Up with Client',
    ])('allows Part arrived → %s (reaches the UPDATE)', async (target) => {
        await expect(jobsService.updateBlancStatus(7, target, COMPANY)).resolves.toBeDefined();
        expect(updateCall()).toBeTruthy();
        expect(updateCall()[1][0]).toBe(target);
    });

    it('still REJECTS a non-modeled jump (Part arrived → Job is Done) — the map is a guard, not wide-open', async () => {
        await expect(jobsService.updateBlancStatus(7, 'Job is Done', COMPANY))
            .rejects.toThrow(/not allowed/);
        expect(updateCall()).toBeFalsy(); // never reached the UPDATE
    });

    it('still REJECTS an invalid status', async () => {
        await expect(jobsService.updateBlancStatus(7, 'Bogus Status', COMPANY))
            .rejects.toThrow(/Invalid blanc_status|not allowed/);
    });
});
