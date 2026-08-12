'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const mirrorQueries = require('../backend/src/db/jobProviderMirrorQueries');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const TECHNICIAN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rowCount: 2 });
});

test('targeted refresh recomputes complete mirrors for only the tenant technician jobs', async () => {
    await expect(mirrorQueries.refreshProviderMirror(COMPANY_A, {
        technicianIds: [TECHNICIAN_A],
    })).resolves.toEqual({ updated: 2 });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('WHERE j2.company_id = $1');
    expect(sql).toContain('WHERE j.company_id = $1');
    expect(sql).toContain("target_identity.source = 'zenbooker'");
    expect(sql).toContain('target_identity.technician_id = ANY($2::uuid[])');
    expect(sql).toContain('native_m.user_id = t.crm_user_id');
    expect(sql).toContain('t.active = TRUE');
    expect(params).toEqual([COMPANY_A, [TECHNICIAN_A]]);
});

test('empty target set is a no-op instead of widening into a company refresh', async () => {
    await expect(mirrorQueries.refreshProviderMirror(COMPANY_A, {
        technicianIds: [],
    })).resolves.toEqual({ updated: 0 });
    expect(db.query).not.toHaveBeenCalled();
});
