const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
};
const mockLogJobActivity = jest.fn();
const mockLogLeadContactActivity = jest.fn();
const mockRequireActiveTechnician = jest.fn();
const mockCanonicalizeAssignments = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
    pool: {
        connect: jest.fn(),
    },
}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: jest.fn() }));
jest.mock('../backend/src/services/jobActivityService', () => ({
    logJobActivity: (...args) => mockLogJobActivity(...args),
}));
jest.mock('../backend/src/services/leadContactActivityService', () => ({
    logLeadContactActivity: (...args) => mockLogLeadContactActivity(...args),
    systemActor: (label = 'Automation', source = 'crm') => ({
        id: null, type: 'system', label, source,
    }),
}));
jest.mock('../backend/src/services/technicianRosterService', () => ({
    requireActive: (...args) => mockRequireActiveTechnician(...args),
    canonicalizeAssignments: (...args) => mockCanonicalizeAssignments(...args),
}));

const db = require('../backend/src/db/connection');
const leadsService = require('../backend/src/services/leadsService');

function makeLeadRow(overrides = {}) {
    return {
        id: 42,
        uuid: 'ABC123',
        serial_id: 1001,
        company_id: 'company-1',
        status: 'Submitted',
        sub_status: null,
        lead_lost: false,
        converted_to_job: false,
        zenbooker_job_id: null,
        contact_id: 123,
        first_name: 'Ada',
        last_name: 'Lovelace',
        company: null,
        phone: '+16175550000',
        email: 'ada@example.com',
        address: '1 Main St',
        unit: null,
        city: 'Boston',
        state: 'MA',
        postal_code: '02110',
        country: 'US',
        job_type: 'Repair',
        job_source: 'Phone',
        lead_notes: 'Fix appliance',
        comments: null,
        metadata: {},
        tags: null,
        structured_notes: [],
        lead_date_time: null,
        lead_end_date_time: null,
        created_at: new Date('2026-06-01T12:00:00Z'),
        payment_due_date: null,
        latitude: null,
        longitude: null,
        ...overrides,
    };
}

let currentLeadRow;

function mockLeadLookup(leadRow = makeLeadRow()) {
    currentLeadRow = leadRow;
    db.query.mockImplementation((sql) => {
        if (String(sql).includes('SELECT * FROM leads')) {
            return Promise.resolve({ rows: [leadRow] });
        }
        return Promise.resolve({ rows: [] });
    });
}

function mockClaimExistingJob(existingJob) {
    mockClient.query.mockImplementation(async (sql) => {
        const text = String(sql);
        if (/SELECT \*\s+FROM leads[\s\S]+FOR UPDATE/i.test(text)) return { rows: [currentLeadRow] };
        if (/SELECT id, contact_id, zenbooker_job_id, job_seq, public_code\s+FROM jobs/i.test(text)) return { rows: [existingJob] };
        if (/SELECT id\s+FROM jobs/i.test(text)) return { rows: [{ id: existingJob.id }] };
        if (/UPDATE leads/i.test(text)) {
            return { rows: [{ id: currentLeadRow.id, uuid: currentLeadRow.uuid, status: 'Converted', converted_to_job: true }] };
        }
        return { rows: [], rowCount: 0 };
    });
}

function mockClaimNewJob(jobId = 1131, jobSeq = 171, publicCode = 'aB3xZ') {
    mockClient.query.mockImplementation(async (sql) => {
        const text = String(sql);
        if (/SELECT \*\s+FROM leads[\s\S]+FOR UPDATE/i.test(text)) return { rows: [currentLeadRow] };
        if (/SELECT id, contact_id, zenbooker_job_id, job_seq, public_code\s+FROM jobs/i.test(text)) return { rows: [] };
        if (/INSERT INTO jobs/i.test(text)) {
            return { rows: [{ id: jobId, job_seq: jobSeq, public_code: publicCode }] };
        }
        if (/SELECT id\s+FROM jobs/i.test(text)) return { rows: [{ id: jobId }] };
        if (/UPDATE leads/i.test(text)) {
            return { rows: [{ id: currentLeadRow.id, uuid: currentLeadRow.uuid, status: 'Converted', converted_to_job: true }] };
        }
        return { rows: [], rowCount: 0 };
    });
}

function insertedJobDescription() {
    const insertCall = mockClient.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO jobs'));
    return insertCall?.[1]?.[11];
}

describe('leadsService.convertLead idempotency', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockClient.query.mockReset();
        mockClient.release.mockReset();
        db.pool.connect.mockResolvedValue(mockClient);
        db.getClient.mockResolvedValue(mockClient);
        mockLeadLookup();
        mockLogJobActivity.mockResolvedValue({ ok: true, id: 1 });
        mockLogLeadContactActivity.mockResolvedValue({ ok: true, id: 2 });
        mockRequireActiveTechnician.mockResolvedValue({
            id: '77777777-7777-4777-8777-777777777777',
            name: 'Russell',
        });
        mockCanonicalizeAssignments.mockImplementation(async (_companyId, assignments) => assignments);
    });

    it('uses the custom Zenbooker service description for the local job', async () => {
        mockLeadLookup(makeLeadRow({ lead_notes: null }));
        mockClaimNewJob();

        await leadsService.convertLead('ABC123', {
            zb_job_payload: {
                services: [{ custom_service: { description: 'Ge oven. Double. F20. Jb850st1ss' } }],
            },
            service: { name: 'X' },
        }, 'company-1');

        expect(insertedJobDescription()).toBe('Ge oven. Double. F20. Jb850st1ss');
    });

    it('prefers the service override description over the Zenbooker payload', async () => {
        mockLeadLookup(makeLeadRow({ lead_notes: null }));
        mockClaimNewJob();

        await leadsService.convertLead('ABC123', {
            zb_job_payload: {
                services: [{ custom_service: { description: 'Zenbooker description' } }],
            },
            service: { name: 'X', description: '  Service override description  ' },
        }, 'company-1');

        expect(insertedJobDescription()).toBe('Service override description');
    });

    it('falls back to lead notes when no override description is present', async () => {
        mockLeadLookup(makeLeadRow({ lead_notes: 'Fix appliance from lead notes' }));
        mockClaimNewJob();

        await leadsService.convertLead('ABC123', {
            service: { name: 'X' },
        }, 'company-1');

        expect(insertedJobDescription()).toBe('Fix appliance from lead notes');
    });

    it('inserts a null description when no description source is present', async () => {
        mockLeadLookup(makeLeadRow({ lead_notes: null, comments: null }));
        mockClaimNewJob();

        await leadsService.convertLead('ABC123', {
            service: { name: 'X' },
        }, 'company-1');

        expect(insertedJobDescription()).toBeNull();
    });

    it('logs a newly created Job with the threaded CRM actor in the claim transaction', async () => {
        mockClaimNewJob();
        const actor = {
            id: '10000000-0000-4000-8000-000000000001',
            type: 'user',
            label: null,
            source: 'crm',
        };

        await leadsService.convertLead(
            'ABC123',
            { service: { name: 'Repair' } },
            'company-1',
            actor
        );

        expect(mockLogJobActivity).toHaveBeenCalledWith({
            companyId: 'company-1',
            action: 'job.created',
            jobId: 1131,
            actor,
            summary: { status: 'Submitted' },
        }, { client: mockClient });
        expect(mockLogLeadContactActivity).toHaveBeenCalledWith({
            companyId: 'company-1',
            entityType: 'lead',
            action: 'lead.converted',
            entityId: 42,
            actor,
            summary: { job_id: 1131, status: 'Converted', previous_status: 'Submitted' },
        }, { client: mockClient });
        expect(mockLogLeadContactActivity).toHaveBeenCalledWith({
            companyId: 'company-1',
            entityType: 'lead',
            action: 'lead.status_changed',
            entityId: 42,
            actor,
            summary: { job_id: 1131, status: 'Converted', previous_status: 'Submitted' },
        }, { client: mockClient });
    });

    it('reuses an existing local job when retrying a conversion', async () => {
        mockClaimExistingJob({
            id: 1131,
            contact_id: 123,
            zenbooker_job_id: null,
            job_seq: 171,
            public_code: 'aB3xZ',
        });

        const result = await leadsService.convertLead('ABC123', {
            zb_job_payload: {
                territory_id: 'territory-1',
                timeslot: { start: '2026-06-08T13:00:00Z', end: '2026-06-08T15:00:00Z' },
            },
        }, 'company-1');

        expect(result).toMatchObject({
            job_id: 1131,
            job_seq: 171,
            public_code: 'aB3xZ',
            zenbooker_job_id: null,
            link: '/jobs/by-id/1131',
        });
        expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO jobs'))).toBe(false);
        expect(mockClient.query.mock.calls.some(([sql]) => /FROM leads[\s\S]+FOR UPDATE/.test(String(sql)))).toBe(true);
        expect(mockLogJobActivity).not.toHaveBeenCalled();
    });

    it('returns an already linked local job with its historical provenance', async () => {
        mockClaimExistingJob({
            id: 1131,
            contact_id: 123,
            zenbooker_job_id: 'zb-existing',
            job_seq: 171,
            public_code: 'aB3xZ',
        });

        const result = await leadsService.convertLead('ABC123', {
            zb_job_payload: {
                territory_id: 'territory-1',
                timeslot: { start: '2026-06-08T13:00:00Z', end: '2026-06-08T15:00:00Z' },
            },
        }, 'company-1');

        expect(result).toMatchObject({
            job_id: 1131,
            job_seq: 171,
            public_code: 'aB3xZ',
            zenbooker_job_id: 'zb-existing',
            link: '/jobs/by-id/1131',
        });
        expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO jobs'))).toBe(false);
    });

    it('persists caller-supplied zenbooker_job_id provenance without an API lookup', async () => {
        mockClaimNewJob();

        await leadsService.convertLead('ABC123', {
            zenbooker_job_id: 'zb-provenance-1',
        }, 'company-1');

        const insert = mockClient.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO jobs'));
        expect(insert[1][2]).toBe('zb-provenance-1');
    });

    it('resolves and inserts the provider mirror with a scheduled lead conversion', async () => {
        const crmUserId = '11111111-1111-4111-8111-111111111111';
        const leadRow = makeLeadRow();
        currentLeadRow = leadRow;
        db.query.mockImplementation(async sql => {
            const text = String(sql);
            if (text.includes('SELECT * FROM leads')) return { rows: [leadRow] };
            if (text.includes('SELECT DISTINCT m.user_id')) {
                return { rows: [{ user_id: crmUserId }] };
            }
            return { rows: [] };
        });
        mockClaimNewJob();

        await leadsService.convertLead('ABC123', {
            schedule: {
                start_at: '2026-06-08T13:00:00Z',
                end_at: '2026-06-08T15:00:00Z',
                technician_ids: ['legacy-russell'],
            },
        }, 'company-1');

        const [insertSql, insertParams] = mockClient.query.mock.calls.find(
            ([sql]) => String(sql).includes('INSERT INTO jobs')
        );
        expect(insertSql).toContain('assigned_provider_user_ids');
        expect(insertParams[16]).toBe(JSON.stringify([{
            id: '77777777-7777-4777-8777-777777777777',
            name: 'Russell',
        }]));
        expect(insertParams[17]).toBe(JSON.stringify([crmUserId]));
        expect(db.query.mock.calls.find(([sql]) => String(sql).includes('SELECT DISTINCT m.user_id'))?.[1])
            .toEqual(['company-1', ['77777777-7777-4777-8777-777777777777']]);
    });
});
