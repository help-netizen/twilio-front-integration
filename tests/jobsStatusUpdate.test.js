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
jest.mock('../backend/src/services/zenbookerClient', () => ({
    markJobComplete: jest.fn(),
    cancelJob: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
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

    it('projects old/new status and job number into the domain event payload', async () => {
        db.query.mockResolvedValue({
            rows: [{
                id: 5,
                blanc_status: 'Submitted',
                job_number: 'J-5',
                company_id: COMPANY,
            }],
        });
        await jobsService.updateBlancStatus(5, 'Canceled', COMPANY);
        const eventCall = db.query.mock.calls.find(([sql]) => /INSERT INTO domain_events/.test(sql));
        expect(eventCall).toBeTruthy();
        expect(JSON.parse(eventCall[1][4])).toMatchObject({
            job_id: 5,
            job_number: 'J-5',
            old_status: 'Submitted',
            new_status: 'Canceled',
            from: 'Submitted',
            to: 'Canceled',
        });
    });

    it('does not call Zenbooker from the blanc_status change path', async () => {
        db.query.mockResolvedValue({
            rows: [{
                id: 5,
                blanc_status: 'Submitted',
                zenbooker_job_id: 'zb-job-5',
                zb_status: 'scheduled',
                company_id: COMPANY,
            }],
        });

        await jobsService.updateBlancStatus(5, 'Job is Done', COMPANY);

        expect(zenbookerClient.markJobComplete).not.toHaveBeenCalled();
        expect(zenbookerClient.cancelJob).not.toHaveBeenCalled();
    });

    it('uses a supplied transaction client for the status write and domain event', async () => {
        const job = {
            id: 5,
            blanc_status: 'Submitted',
            job_number: 'J-5',
            company_id: COMPANY,
        };
        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rowCount: 1, rows: [] })
                .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'event-1' }] }),
        };

        await jobsService.updateBlancStatus(5, 'On the way', COMPANY, null, {
            client,
            job,
            resolvedTransition: { valid: true, targetState: 'On the way', event: 'TO_ON_THE_WAY' },
        });

        expect(client.query).toHaveBeenCalledTimes(2);
        expect(client.query.mock.calls[0][0]).toContain('UPDATE jobs');
        expect(client.query.mock.calls[0][1]).toEqual(['On the way', false, 5, COMPANY]);
        expect(client.query.mock.calls[1][0]).toContain('INSERT INTO domain_events');
        expect(db.query).not.toHaveBeenCalled();
    });
});
