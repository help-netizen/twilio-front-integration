'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const q = require('../backend/src/db/contactIdentityQueries');

const CO_A = '00000000-0000-0000-0000-00000000000a';
const CONTACT_A = '101';
const CONTACT_B = '202';
const EXTERNAL_ID = 'zb-contact-123';

beforeEach(() => jest.clearAllMocks());

function assertCompanyScoped(companyId) {
    expect(db.query.mock.calls.length).toBeGreaterThan(0);
    for (const [, params] of db.query.mock.calls) {
        expect(params[0]).toBe(companyId);
    }
}

test('normalizePhone returns the last ten digits and rejects short values', () => {
    expect(q.normalizePhone('+1 (617) 555-0101')).toBe('6175550101');
    expect(q.normalizePhone('001-1-617-555-0101')).toBe('6175550101');
    expect(q.normalizePhone('555-0101')).toBeNull();
    expect(q.normalizePhone(null)).toBeNull();
});

test('upsertExternalIdentity inserts company first and returns the inserted map', async () => {
    const stored = {
        company_id: CO_A,
        source: 'zenbooker',
        external_id: EXTERNAL_ID,
        contact_id: CONTACT_A,
    };
    db.query.mockResolvedValueOnce({ rows: [stored] });

    await expect(q.upsertExternalIdentity({
        companyId: CO_A,
        source: 'zenbooker',
        externalId: EXTERNAL_ID,
        contactId: CONTACT_A,
    })).resolves.toEqual(stored);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/c\.company_id\s*=\s*\$1\s+AND\s+c\.id\s*=\s*\$4/);
    expect(sql).toMatch(/ON CONFLICT \(company_id, source, external_id\) DO NOTHING/);
    expect(params).toEqual([CO_A, 'zenbooker', EXTERNAL_ID, CONTACT_A]);
    assertCompanyScoped(CO_A);
});

test('upsertExternalIdentity reads back the winner without repointing it', async () => {
    db.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ contact_id: CONTACT_A }] });

    await expect(q.upsertExternalIdentity({
        companyId: CO_A,
        source: 'zenbooker',
        externalId: EXTERNAL_ID,
        contactId: CONTACT_B,
    })).resolves.toEqual({ contact_id: CONTACT_A });
    expect(db.query.mock.calls[1][0]).toMatch(/company_id\s*=\s*\$1/);
    assertCompanyScoped(CO_A);
});

test('resolveExternalToContact is company-scoped', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ contact_id: CONTACT_A }] });
    await expect(q.resolveExternalToContact(CO_A, 'zenbooker', EXTERNAL_ID))
        .resolves.toBe(CONTACT_A);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/company_id\s*=\s*\$1/);
    expect(params).toEqual([CO_A, 'zenbooker', EXTERNAL_ID]);
    assertCompanyScoped(CO_A);
});

test('resolveContactToExternal is company-scoped and deterministic', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ external_id: EXTERNAL_ID }] });
    await expect(q.resolveContactToExternal(CO_A, 'zenbooker', CONTACT_A))
        .resolves.toBe(EXTERNAL_ID);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/company_id\s*=\s*\$1/);
    expect(sql).toMatch(/ORDER BY identity\.created_at ASC, identity\.external_id ASC/);
    expect(params).toEqual([CO_A, 'zenbooker', CONTACT_A]);
    assertCompanyScoped(CO_A);
});

test('findContactIdsByNormalizedPhone excludes shared rows by default', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ contact_id: CONTACT_A }, { contact_id: CONTACT_B }] });
    await expect(q.findContactIdsByNormalizedPhone(CO_A, '+1 617-555-0101'))
        .resolves.toEqual([CONTACT_A, CONTACT_B]);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/company_id\s*=\s*\$1/);
    expect(sql).toMatch(/is_shared\s*=\s*FALSE/);
    expect(params).toEqual([CO_A, '6175550101']);
    assertCompanyScoped(CO_A);
});

test('findContactIdsByNormalizedPhone can include shared rows without losing scope', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ contact_id: CONTACT_A }] });
    await q.findContactIdsByNormalizedPhone(CO_A, '6175550101', { includeShared: true });
    const [sql] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/is_shared\s*=\s*FALSE/);
    assertCompanyScoped(CO_A);
});

test('listPhonesForContact scopes the contact read by company first', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ contact_id: CONTACT_A }] });
    await expect(q.listPhonesForContact(CO_A, CONTACT_A))
        .resolves.toEqual([{ contact_id: CONTACT_A }]);
    expect(db.query.mock.calls[0][1]).toEqual([CO_A, CONTACT_A]);
    expect(db.query.mock.calls[0][0]).toMatch(/company_id\s*=\s*\$1\s+AND\s+contact_id\s*=\s*\$2/);
    assertCompanyScoped(CO_A);
});

test('upsertContactPhone normalizes and inserts only for a contact owned by the company', async () => {
    db.query.mockResolvedValueOnce({
        rows: [{ contact_id: CONTACT_A, normalized_phone: '6175550101' }],
    });
    await expect(q.upsertContactPhone({
        companyId: CO_A,
        contactId: CONTACT_A,
        phoneE164: '+1 (617) 555-0101',
        label: 'Mobile',
        isPrimary: true,
    })).resolves.toEqual({ contact_id: CONTACT_A, normalized_phone: '6175550101' });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE company_id\s*=\s*\$1\s+AND id\s*=\s*\$2/);
    expect(sql).toMatch(/existing\.company_id\s*=\s*\$1/);
    expect(params).toEqual([
        CO_A, CONTACT_A, '+1 (617) 555-0101', '6175550101', 'Mobile', true, false,
    ]);
    assertCompanyScoped(CO_A);
});

test('markPhoneShared updates only the company-scoped normalized number', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ contact_id: CONTACT_A, is_shared: true }] });
    await expect(q.markPhoneShared(CO_A, '+1 617 555 0101', true))
        .resolves.toEqual([{ contact_id: CONTACT_A, is_shared: true }]);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/phone\.company_id\s*=\s*\$1\s+AND\s+phone\.normalized_phone\s*=\s*\$2/);
    expect(params).toEqual([CO_A, '6175550101', true]);
    assertCompanyScoped(CO_A);
});
