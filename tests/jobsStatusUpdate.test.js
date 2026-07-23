/**
 * Regression guard: jobsService.updateBlancStatus
 *
 * Prod bug (after the cancel-reason change): the UPDATE reused $1 both as
 * `blanc_status = $1` (varchar) AND `CASE WHEN $1 = 'Canceled'` (text), so
 * Postgres failed with "inconsistent types deduced for parameter $1" on EVERY
 * status change. The canceled flag must be its own param, never a reuse of $1.
 *
 * (The real type error only surfaces against Postgres; this locks the query
 * shape so the reuse can't come back.)
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/fsmService', () => ({
    resolveTransition: jest.fn(async () => ({ valid: true })),
}));

const db = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');

const COMPANY = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
    // Default: every query returns a minimal job row so getJobById resolves.
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [{ id: 5, blanc_status: 'Submitted', company_id: COMPANY }] });
});

function updateCall() {
    return db.query.mock.calls.find(
        c => /UPDATE jobs/.test(String(c[0])) && /blanc_status/.test(String(c[0])),
    );
}

describe('updateBlancStatus query shape', () => {
    it('never reuses $1 in a typed comparison (the prod bug)', async () => {
        await jobsService.updateBlancStatus(5, 'Canceled', COMPANY);
        const call = updateCall();
        expect(call).toBeTruthy();
        // The exact pattern that made Postgres deduce two types for $1.
        expect(String(call[0])).not.toMatch(/\$1\s*=\s*'Canceled'/);
    });

    it('binds the canceled flag as its own boolean param', async () => {
        await jobsService.updateBlancStatus(5, 'Canceled', COMPANY);
        expect(updateCall()[1]).toEqual(['Canceled', true, 5, COMPANY]);
        expect(String(updateCall()[0])).toContain('AND company_id = $4');
    });

    it('passes canceled=false for a non-cancel transition', async () => {
        await jobsService.updateBlancStatus(5, 'Job is Done', COMPANY);
        expect(updateCall()[1]).toEqual(['Job is Done', false, 5, COMPANY]);
    });
});
