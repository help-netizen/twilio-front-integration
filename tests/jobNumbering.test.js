'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/services/technicianRosterService', () => ({
    canonicalizeAssignments: jest.fn(async (_companyId, assignments) => (
        Array.isArray(assignments) ? assignments : []
    )),
}));

const db = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';

function jobRow(overrides = {}) {
    return {
        id: 700,
        lead_id: null,
        contact_id: null,
        company_id: COMPANY_A,
        job_seq: 31,
        public_code: 'aB3xZ',
        blanc_status: 'Submitted',
        zb_status: 'scheduled',
        zb_rescheduled: false,
        zb_canceled: false,
        assigned_techs: [],
        assigned_provider_user_ids: [],
        notes: [],
        created_at: new Date('2026-08-16T12:00:00.000Z'),
        updated_at: new Date('2026-08-16T12:00:00.000Z'),
        ...overrides,
    };
}

describe('JOB-NUMBERING-001 service resolvers', () => {
    beforeEach(() => {
        db.query.mockReset();
    });

    test('getJobBySeq resolves only the requested company and returns both identifiers', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [jobRow()] })
            .mockResolvedValueOnce({ rows: [] });

        const job = await jobsService.getJobBySeq(COMPANY_A, 31);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('WHERE j.company_id = $1 AND j.job_seq = $2');
        expect(params).toEqual([COMPANY_A, 31]);
        expect(job).toMatchObject({
            id: 700,
            company_id: COMPANY_A,
            job_seq: 31,
            public_code: 'aB3xZ',
        });
    });

    test('getJobBySeq cannot return another company row for the same probe', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(jobsService.getJobBySeq(COMPANY_B, 31)).resolves.toBeNull();

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('j.company_id = $1');
        expect(sql).toContain('j.job_seq = $2');
        expect(params).toEqual([COMPANY_B, 31]);
    });

    test('getJobBySeq fails closed without company context', async () => {
        await expect(jobsService.getJobBySeq(null, 31)).rejects.toMatchObject({
            code: 'TENANT_CONTEXT_REQUIRED',
            statusCode: 403,
        });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('getJobByCode is the deliberate global lookup and returns redirect context', async () => {
        db.query.mockResolvedValueOnce({ rows: [jobRow()] });

        const job = await jobsService.getJobByCode('aB3xZ');

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('WHERE j.public_code = $1');
        expect(sql).not.toMatch(/WHERE[^;]*company_id/);
        expect(params).toEqual(['aB3xZ']);
        expect(job).toMatchObject({
            company_id: COMPANY_A,
            job_seq: 31,
            public_code: 'aB3xZ',
        });
    });

    test('createJob returns trigger-populated identifiers through its DTO', async () => {
        db.query.mockResolvedValueOnce({ rows: [jobRow({
            id: 701,
            job_seq: 32,
            public_code: 'Z9q2M',
            zenbooker_job_id: 'zb-701',
        })] });

        const job = await jobsService.createJob({
            contactId: 17,
            zenbookerJobId: 'zb-701',
            companyId: COMPANY_A,
        });

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO jobs');
        expect(sql).toContain('RETURNING *');
        expect(job).toMatchObject({
            id: 701,
            job_seq: 32,
            public_code: 'Z9q2M',
        });
    });
});
