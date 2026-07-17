jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));

const db = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');

describe('jobsService.getJobById', () => {
    beforeEach(() => {
        db.query.mockReset();
    });

    it('qualifies job id and company id when joining leads for lead serial id', async () => {
        db.query
            .mockResolvedValueOnce({
                rows: [{
                    id: 705,
                    lead_id: 389,
                    lead_serial_id: 53,
                    contact_id: 3346,
                    zenbooker_job_id: 'zb-job',
                    blanc_status: 'Submitted',
                    zb_status: 'scheduled',
                    zb_rescheduled: false,
                    zb_canceled: false,
                    job_number: '971346',
                    service_name: 'COD Service',
                    start_date: new Date('2026-04-21T17:00:00Z'),
                    end_date: new Date('2026-04-21T19:00:00Z'),
                    assigned_techs: [],
                    notes: [],
                    company_id: 'company-uuid-001',
                    created_at: new Date('2026-04-21T00:00:00Z'),
                    updated_at: new Date('2026-04-21T00:00:00Z'),
                }],
            })
            .mockResolvedValueOnce({ rows: [] });

        const job = await jobsService.getJobById(705, 'company-uuid-001');

        expect(db.query.mock.calls[0][0]).toContain('WHERE j.id = $1 AND j.company_id = $2');
        expect(job).toMatchObject({ id: 705, lead_serial_id: 53, job_number: '971346' });
    });
});
