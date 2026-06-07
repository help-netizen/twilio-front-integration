const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
};

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    pool: {
        connect: jest.fn(),
    },
}));
jest.mock('../backend/src/services/zenbookerClient', () => ({
    createJob: jest.fn(),
    createJobFromLead: jest.fn(),
    getJob: jest.fn(),
}));
jest.mock('../backend/src/services/fsmService', () => ({}));

const db = require('../backend/src/db/connection');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
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

function mockLeadLookup(leadRow = makeLeadRow()) {
    db.query.mockImplementation((sql) => {
        if (String(sql).includes('SELECT * FROM leads')) {
            return Promise.resolve({ rows: [leadRow] });
        }
        return Promise.resolve({ rows: [] });
    });
}

function mockClaimExistingJob(existingJob) {
    mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [existingJob] }) // existing local job lookup
        .mockResolvedValueOnce({ rows: [] }) // early lead converted update
        .mockResolvedValueOnce({ rows: [] }); // COMMIT
}

describe('leadsService.convertLead idempotency', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockClient.query.mockReset();
        mockClient.release.mockReset();
        db.pool.connect.mockResolvedValue(mockClient);
        mockLeadLookup();
    });

    it('reuses an existing local job when retrying a conversion after Zenbooker failed', async () => {
        mockClaimExistingJob({ id: 1131, contact_id: 123, zenbooker_job_id: null });
        zenbookerClient.createJob.mockResolvedValue({ job_id: 'zb-1131' });
        zenbookerClient.getJob.mockResolvedValue({
            job_number: '971346',
            start_date: '2026-06-08T13:00:00Z',
            end_date: '2026-06-08T15:00:00Z',
            time_slot: { arrival_window_minutes: 120 },
            territory: { name: 'Boston' },
            assigned_providers: [],
            notes: [],
            invoice: {},
            status: 'scheduled',
            canceled: false,
            rescheduled: false,
            customer: { id: 'cust-1' },
        });

        const result = await leadsService.convertLead('ABC123', {
            zb_job_payload: {
                territory_id: 'territory-1',
                timeslot: { start: '2026-06-08T13:00:00Z', end: '2026-06-08T15:00:00Z' },
            },
        }, 'company-1');

        expect(result).toMatchObject({
            job_id: 1131,
            zenbooker_job_id: 'zb-1131',
            link: '/jobs/1131',
        });
        expect(zenbookerClient.createJob).toHaveBeenCalledTimes(1);
        expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO jobs'))).toBe(false);
        expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_xact_lock'))).toBe(true);
    });

    it('returns an already linked local job without creating another Zenbooker job', async () => {
        mockClaimExistingJob({ id: 1131, contact_id: 123, zenbooker_job_id: 'zb-existing' });

        const result = await leadsService.convertLead('ABC123', {
            zb_job_payload: {
                territory_id: 'territory-1',
                timeslot: { start: '2026-06-08T13:00:00Z', end: '2026-06-08T15:00:00Z' },
            },
        }, 'company-1');

        expect(result).toMatchObject({
            job_id: 1131,
            zenbooker_job_id: 'zb-existing',
            link: '/jobs/1131',
        });
        expect(zenbookerClient.createJob).not.toHaveBeenCalled();
        expect(zenbookerClient.getJob).not.toHaveBeenCalled();
        expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO jobs'))).toBe(false);
    });
});
