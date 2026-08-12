'use strict';

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const userService = require('../backend/src/services/userService');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const TECHNICIAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
    jest.clearAllMocks();
    db.query
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'user-1', technician_id: TECHNICIAN }] });
});

it('projects technicians.id rather than a Zenbooker external identity', async () => {
    await expect(userService.listUsers(COMPANY)).resolves.toMatchObject({
        users: [{ technician_id: TECHNICIAN }],
        total: 1,
    });

    const projectionSql = db.query.mock.calls[1][0];
    expect(projectionSql).toContain('(SELECT t.id::text');
    expect(projectionSql).not.toContain('technician_external_identities');
    expect(db.query.mock.calls[1][1][0]).toBe(COMPANY);
});
