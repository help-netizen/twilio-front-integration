'use strict';

/**
 * ZB-DECOUPLE-001 Phase A / T1 — unit coverage for the native technician
 * directory query layer with a MOCKED pool (runs without a database). It proves
 * the security invariant that matters most here: every function is company-scoped
 * and never lets one tenant's ZB external id resolve to another tenant's
 * technician. The DB round-trip against migration 240 runs at deploy against the
 * fully-migrated schema (the local dev DB is not fully migrated).
 */
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const q = require('../backend/src/db/technicianDirectoryQueries');

const CO_A = '00000000-0000-0000-0000-00000000000a';
const CO_B = '00000000-0000-0000-0000-00000000000b';
const ZB_ID = '1777258620147x394270109685733300';
const TECH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TECH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => jest.clearAllMocks());

// The tenant fence: every query the layer issues binds company_id as its FIRST
// parameter — true for INSERT (VALUES $1) and for SELECT/UPDATE (WHERE company_id=$1)
// alike. A function that forgot to scope would bind something else first.
function assertCompanyScoped(companyId) {
    expect(db.query.mock.calls.length).toBeGreaterThan(0);
    for (const [, params] of db.query.mock.calls) {
        expect(params[0]).toBe(companyId);
    }
}

test('createTechnician inserts scoped to the company and returns the row', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: TECH_A, company_id: CO_A }] });
    const row = await q.createTechnician({ companyId: CO_A, displayName: 'Ali' });
    expect(row).toEqual({ id: TECH_A, company_id: CO_A });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO technicians/);
    expect(params).toEqual([CO_A, 'Ali', true, null]);
});

test('upsertExternalIdentity is idempotent and never repoints a taken triple', async () => {
    // First insert wins.
    db.query.mockResolvedValueOnce({ rows: [{ company_id: CO_A, source: 'zenbooker', external_id: ZB_ID, technician_id: TECH_A }] });
    const first = await q.upsertExternalIdentity({ companyId: CO_A, source: 'zenbooker', externalId: ZB_ID, technicianId: TECH_A });
    expect(first.technician_id).toBe(TECH_A);
    expect(db.query.mock.calls[0][0]).toMatch(/ON CONFLICT \(company_id, source, external_id\) DO NOTHING/);

    jest.clearAllMocks();
    // Re-run proposing a DIFFERENT technician: DO NOTHING returns [], then the
    // stored row is read back — it must still be TECH_A, not the caller's TECH_B.
    db.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ company_id: CO_A, source: 'zenbooker', external_id: ZB_ID, technician_id: TECH_A }] });
    const again = await q.upsertExternalIdentity({ companyId: CO_A, source: 'zenbooker', externalId: ZB_ID, technicianId: TECH_B });
    expect(again.technician_id).toBe(TECH_A);
    assertCompanyScoped(CO_A);
});

test('resolveExternalToUuid is company-scoped — same ZB id in company B never returns company A', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ technician_id: TECH_B }] });
    const uuid = await q.resolveExternalToUuid(CO_B, 'zenbooker', ZB_ID);
    expect(uuid).toBe(TECH_B);
    const [sql, params] = db.query.mock.calls[0];
    expect(params).toEqual([CO_B, 'zenbooker', ZB_ID]);
    expect(sql).toMatch(/company_id\s*=\s*\$1/);
});

test('resolveExternalToUuid returns null when the company has no such mapping', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await q.resolveExternalToUuid(CO_A, 'zenbooker', 'unknown')).toBeNull();
});

test('resolveUuidToExternal is company-scoped and returns the external id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ external_id: ZB_ID }] });
    expect(await q.resolveUuidToExternal(CO_A, 'zenbooker', TECH_A)).toBe(ZB_ID);
    expect(db.query.mock.calls[0][1]).toEqual([CO_A, 'zenbooker', TECH_A]);
});

test('listActiveTechnicians filters active and scopes to the company', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: TECH_A, display_name: 'Ali', active: true, crm_user_id: null }] });
    const rows = await q.listActiveTechnicians(CO_A);
    expect(rows).toHaveLength(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/active\s*=\s*TRUE/);
    expect(params).toEqual([CO_A]);
    assertCompanyScoped(CO_A);
});

test('findActiveTechnicianByCrmUserId is active-only and company-scoped', async () => {
    db.query.mockResolvedValueOnce({
        rows: [{ id: TECH_A, display_name: 'Ali', active: true, crm_user_id: 'crm-user' }],
    });
    const row = await q.findActiveTechnicianByCrmUserId(CO_A, 'crm-user');
    expect(row.id).toBe(TECH_A);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/company_id\s*=\s*\$1/);
    expect(sql).toMatch(/crm_user_id\s*=\s*\$2/);
    expect(sql).toMatch(/active\s*=\s*TRUE/);
    expect(params).toEqual([CO_A, 'crm-user']);
});

test('linkCrmUser updates within the tenant only and can unlink with null', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: TECH_A, crm_user_id: null }] });
    await q.linkCrmUser({ companyId: CO_A, technicianId: TECH_A, crmUserId: null });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE technicians/);
    expect(sql).toMatch(/company_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/);
    expect(params).toEqual([CO_A, TECH_A, null]);
});
