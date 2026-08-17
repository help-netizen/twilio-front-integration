'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/chatgptMcpQueries');

const COMPANY = '00000000-0000-0000-0000-0000000000a1';

beforeEach(() => jest.clearAllMocks());

test('getContactHistory projects native and legacy Job identifiers', async () => {
    db.query
        .mockResolvedValueOnce({ rows: [{ id: 21, company_id: COMPANY }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
            rows: [{
                id: 71,
                job_number: null,
                job_seq: 171,
                public_code: 'aB3xZ',
            }],
        })
        .mockResolvedValueOnce({ rows: [] });

    const result = await queries.getContactHistory(COMPANY, 21, 50);

    expect(result.jobs).toEqual([expect.objectContaining({
        id: 71,
        job_number: null,
        job_seq: 171,
        public_code: 'aB3xZ',
    })]);
    const jobsCall = db.query.mock.calls.find(([sql]) => /FROM jobs j/.test(sql));
    expect(jobsCall[0]).toContain('j.job_number, j.job_seq, j.public_code');
    expect(jobsCall[0]).toContain('j.company_id = $1');
    expect(jobsCall[1]).toEqual([COMPANY, 21, 50]);
});
