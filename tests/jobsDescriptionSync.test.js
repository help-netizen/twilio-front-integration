jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/db/membershipQueries', () => ({
    resolveProviderUserIds: jest.fn().mockResolvedValue([]),
}));

const db = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const ZB_JOB_ID = 'zb-job-1';
const NO_EXISTING_ROW = Symbol('no-existing-row');

function zbJob(overrides = {}) {
    return {
        job_number: '832568',
        status: 'scheduled',
        services: [],
        ...overrides,
    };
}

function mockDescriptionUpsert(existingDescription = NO_EXISTING_ROW) {
    let storedDescription = existingDescription;

    db.query.mockImplementation(async (sql, params) => {
        const incomingDescription = params[9];
        const protectsExisting = sql.includes(
            "description = COALESCE(NULLIF(jobs.description, ''), EXCLUDED.description)"
        );

        // Match the PostgreSQL COALESCE(NULLIF(...)) conflict behavior.
        if (storedDescription === NO_EXISTING_ROW || !protectsExisting ||
            storedDescription === null || storedDescription === '') {
            storedDescription = incomingDescription;
        }

        return {
            rows: [{
                id: 1442,
                zenbooker_job_id: ZB_JOB_ID,
                blanc_status: 'Submitted',
                description: storedDescription,
                company_id: COMPANY,
            }],
        };
    });

    return () => storedDescription;
}

describe('jobsService.zbJobToColumns description mapping', () => {
    it('maps a single service description and keeps job_notes mapped to notes', () => {
        const jobNotes = [{ id: 'note-1', text: 'Separate job note' }];
        const columns = jobsService.zbJobToColumns(zbJob({
            services: [{ description: 'Ge oven. Double. F20. Jb850st1ss' }],
            job_notes: jobNotes,
        }));

        expect(columns.description).toBe('Ge oven. Double. F20. Jb850st1ss');
        expect(columns.notes).toBe(JSON.stringify(jobNotes));
    });

    it('newline-joins trimmed descriptions from multiple services', () => {
        const columns = jobsService.zbJobToColumns(zbJob({
            services: [
                { service_name: 'First service', description: ' First intake text ' },
                { service_name: 'Second service', description: 'Second intake text' },
            ],
        }));

        expect(columns.description).toBe('First intake text\nSecond intake text');
        expect(columns.description).not.toContain('First service');
        expect(columns.description).not.toContain('Second service');
    });

    it.each([
        undefined,
        [],
        [{ description: '' }],
        [{ description: '   ' }],
        [{}, { description: null }],
    ])('returns null when services contain no non-empty descriptions (%p)', services => {
        expect(jobsService.zbJobToColumns(zbJob({ services })).description).toBeNull();
    });
});

describe('jobsService.createJob description upsert', () => {
    beforeEach(() => {
        db.query.mockReset();
    });

    it('persists the Zenbooker description on insert', async () => {
        const getStoredDescription = mockDescriptionUpsert();

        const job = await jobsService.createJob({
            zenbookerJobId: ZB_JOB_ID,
            zbData: zbJob({ services: [{ description: 'Fresh intake text' }] }),
            companyId: COMPANY,
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/job_number, service_name, description, start_date/);
        expect(params[9]).toBe('Fresh intake text');
        expect(job.description).toBe('Fresh intake text');
        expect(getStoredDescription()).toBe('Fresh intake text');
    });

    it('does not overwrite an existing non-empty description on conflict', async () => {
        const getStoredDescription = mockDescriptionUpsert('Manual Albusto edit');

        const job = await jobsService.createJob({
            zenbookerJobId: ZB_JOB_ID,
            zbData: zbJob({ services: [{ description: 'New Zenbooker intake text' }] }),
            companyId: COMPANY,
        });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain(
            "description = COALESCE(NULLIF(jobs.description, ''), EXCLUDED.description)"
        );
        expect(job.description).toBe('Manual Albusto edit');
        expect(getStoredDescription()).toBe('Manual Albusto edit');
    });

    it.each([null, ''])('fills an existing %p description on conflict', async existingDescription => {
        const getStoredDescription = mockDescriptionUpsert(existingDescription);

        const job = await jobsService.createJob({
            zenbookerJobId: ZB_JOB_ID,
            zbData: zbJob({ services: [{ description: 'Zenbooker intake text' }] }),
            companyId: COMPANY,
        });

        expect(job.description).toBe('Zenbooker intake text');
        expect(getStoredDescription()).toBe('Zenbooker intake text');
    });
});
