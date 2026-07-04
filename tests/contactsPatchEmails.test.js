/**
 * CONTACT-EMAIL-MERGE-001 — T2 unit suite (jest, route, db mocked).
 *
 * Pins the CONTRACT of `PATCH /api/contacts/:id` `emails[]` + the single tx:
 *   • TC-CEM-U10 — emails[] handled OUTSIDE the scalar allowedFields loop; each
 *     address upserts via enrichEmail(lower(trim)); scalar contacts.email synced
 *     to the primary; exactly one primary; body WITHOUT emails leaves the email
 *     path untouched (back-compat).
 *   • TC-CEM-U11 — resolveAddedEmail called ONCE per NEWLY-added address only
 *     (never for an address already in the current set).
 *   • TC-CEM-U12 — ONE transaction: a thrown merge → ROLLBACK issued, COMMIT
 *     NEVER issued, 500 without a leaked stack (email add rolled back with merge).
 *   • TC-CEM-U13 — removal → DELETE contact_emails for the dropped row, with NO
 *     UPDATE clearing email_messages.{contact_id,timeline_id,on_timeline} and no
 *     merge/un-merge path.
 *   • TC-R-6 — middleware/tenancy: 403 without contacts.edit, 404 foreign id.
 *
 * House style (cf. tests/routes/phoneNumbers.test.js): mock db/connection with a
 * pool.connect returning a CAPTURING tx client, mock the merge + dedupe services,
 * drive the real router via supertest with an injected auth middleware. Mocked db
 * proves the SQL string / call ordering / which branch fired — real row movement
 * is the T4 verify-script's job.
 *
 * Worktree run: jest --testPathIgnorePatterns "/node_modules/".
 */

const express = require('express');
const request = require('supertest');

// ─── A capturing pooled tx client ─────────────────────────────────────────────
// query() records every (sql, params) so tests can assert on ordering and shape.
// A per-test `router` supplies rows for the few SELECTs the handler makes.
let clientRouter = null;
const mockClient = {
    calls: [],
    query: jest.fn((sql, params) => {
        mockClient.calls.push({ sql: String(sql), params });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
        const routed = clientRouter ? clientRouter(String(sql), params) : undefined;
        return Promise.resolve(routed || { rows: [], rowCount: 0 });
    }),
    release: jest.fn(),
};
const mockPoolQuery = jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 }));

jest.mock('../backend/src/db/connection', () => ({
    pool: { connect: jest.fn(() => Promise.resolve(mockClient)) },
    query: (...args) => mockPoolQuery(...args),
}));

// ─── Service mocks ────────────────────────────────────────────────────────────
jest.mock('../backend/src/services/contactsService', () => ({
    getById: jest.fn(),
    getContactById: jest.fn(),
    getContactLeads: jest.fn(async () => []),
    getContactEmails: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/contactDedupeService', () => ({
    enrichEmail: jest.fn(async () => true),
    getAdditionalEmails: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/contactEmailMergeService', () => ({
    resolveAddedEmail: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/timelineMergeService', () => ({
    mergeOrphanTimelines: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/zenbookerSyncService', () => ({
    FEATURE_ENABLED: false,
    syncContactToZenbooker: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
// Unused-by-PATCH collaborators the router requires at module load.
jest.mock('../backend/src/services/noteAttachmentsService', () => ({ MAX_FILE_SIZE: 1, MAX_FILES_PER_NOTE: 1 }));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));

const contactsService = require('../backend/src/services/contactsService');
const dedupe = require('../backend/src/services/contactDedupeService');
const mergeSvc = require('../backend/src/services/contactEmailMergeService');
const contactsRouter = require('../backend/src/routes/contacts');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';

function makeApp({ permissions = ['contacts.edit'], companyId = COMPANY_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', email: 'u@x.com', crmUser: { id: 'crm-1' } };
        req.authz = { permissions, scopes: {} };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/contacts', contactsRouter);
    return app;
}

// SQL helpers over the captured tx-client calls.
const clientSql = () => mockClient.calls.map(c => c.sql);
const findCall = (re) => mockClient.calls.find(c => re.test(c.sql));
const orderOf = (re) => mockClient.calls.findIndex(c => re.test(c.sql));

beforeEach(() => {
    jest.clearAllMocks();
    mockClient.calls = [];
    // Default tx-client routing: the in-tx full_name recalc probe finds the
    // contact (so a name edit does not 404). Individual tests may override.
    clientRouter = (sql) => {
        if (/SELECT first_name, last_name FROM contacts/i.test(sql)) {
            return { rows: [{ first_name: 'Jane', last_name: 'Doe' }] };
        }
        return { rows: [], rowCount: 0 };
    };
    // Re-establish default IMPLEMENTATIONS every test. jest.clearAllMocks() wipes
    // call history but NOT implementations set via mockResolvedValue/mockRejectedValue,
    // so an earlier test's mockRejectedValue would otherwise bleed forward.
    dedupe.enrichEmail.mockResolvedValue(true);
    dedupe.getAdditionalEmails.mockResolvedValue([]);
    mergeSvc.resolveAddedEmail.mockResolvedValue(undefined);
    // Default: the pre-tx existence guard + the post-commit reload both succeed.
    contactsService.getById.mockResolvedValue({ id: 5, company_id: COMPANY_A, email: null });
    contactsService.getContactById.mockResolvedValue({
        id: 5, first_name: 'Jane', last_name: 'Doe', email: 'work@acme.com',
        phone_e164: null, secondary_phone: null, secondary_phone_name: null,
        company_name: null, zenbooker_customer_id: null,
    });
});

// ─── TC-CEM-U10 — emails[] upserted via enrichEmail, scalar synced to primary ──
describe('TC-CEM-U10: emails[] persisted via enrichEmail, scalar = primary, one primary', () => {
    it('upserts each normalized address, sets scalar contacts.email = primary, out of the scalar loop', async () => {
        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ emails: [{ email: 'Work@Acme.com', is_primary: true }, { email: 'p2@acme.com' }] });

        expect(res.status).toBe(200);

        // enrichEmail called once per address with lower(trim)'d value + the tx client.
        expect(dedupe.enrichEmail).toHaveBeenCalledTimes(2);
        expect(dedupe.enrichEmail).toHaveBeenNthCalledWith(1, 5, 'work@acme.com', mockClient);
        expect(dedupe.enrichEmail).toHaveBeenNthCalledWith(2, 5, 'p2@acme.com', mockClient);

        // The scalar contacts.email UPDATE carries the primary (work@acme.com).
        const contactUpdate = findCall(/UPDATE contacts SET/i);
        expect(contactUpdate).toBeTruthy();
        expect(contactUpdate.sql).toMatch(/email = \$/);
        expect(contactUpdate.params).toContain('work@acme.com');

        // Exactly one primary reconciled to the primary address.
        const primaryReconcile = findCall(/UPDATE contact_emails SET is_primary = \(email_normalized = \$2\)/i);
        expect(primaryReconcile).toBeTruthy();
        expect(primaryReconcile.params).toEqual([5, 'work@acme.com']);

        // Committed, not rolled back.
        expect(clientSql()).toContain('COMMIT');
        expect(clientSql()).not.toContain('ROLLBACK');
    });

    it('when NO entry is flagged primary, the first surviving address becomes primary', async () => {
        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ emails: [{ email: 'a@acme.com' }, { email: 'b@acme.com' }] });

        expect(res.status).toBe(200);
        const primaryReconcile = findCall(/UPDATE contact_emails SET is_primary/i);
        expect(primaryReconcile.params).toEqual([5, 'a@acme.com']); // first entry
        const contactUpdate = findCall(/UPDATE contacts SET/i);
        expect(contactUpdate.params).toContain('a@acme.com');
    });

    it('a body WITHOUT emails leaves the email path completely untouched (back-compat)', async () => {
        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ first_name: 'Renamed' });

        expect(res.status).toBe(200);
        expect(dedupe.enrichEmail).not.toHaveBeenCalled();
        expect(dedupe.getAdditionalEmails).not.toHaveBeenCalled();
        expect(mergeSvc.resolveAddedEmail).not.toHaveBeenCalled();
        expect(findCall(/UPDATE contact_emails/i)).toBeUndefined();
        // The scalar contact update still ran (first_name), committed.
        expect(findCall(/UPDATE contacts SET/i)).toBeTruthy();
        expect(clientSql()).toContain('COMMIT');
    });

    it('drops blank / non-email-shaped entries before upsert', async () => {
        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ emails: [{ email: '  ' }, { email: 'not-an-email' }, { email: 'ok@acme.com', is_primary: true }] });

        expect(res.status).toBe(200);
        expect(dedupe.enrichEmail).toHaveBeenCalledTimes(1);
        expect(dedupe.enrichEmail).toHaveBeenCalledWith(5, 'ok@acme.com', mockClient);
    });
});

// ─── TC-CEM-U11 — resolveAddedEmail only for NEWLY-added addresses ─────────────
describe('TC-CEM-U11: resolveAddedEmail per newly-added address only', () => {
    it('calls resolveAddedEmail once for the new address, not for a pre-existing one', async () => {
        // a@acme.com already recorded; b@acme.com is new.
        dedupe.getAdditionalEmails.mockResolvedValue(['a@acme.com']);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ emails: [{ email: 'a@acme.com', is_primary: true }, { email: 'b@acme.com' }] });

        expect(res.status).toBe(200);
        expect(mergeSvc.resolveAddedEmail).toHaveBeenCalledTimes(1);
        expect(mergeSvc.resolveAddedEmail).toHaveBeenCalledWith(5, 'b@acme.com', COMPANY_A, mockClient);
    });

    it('an address already held as the scalar primary is NOT treated as newly-added', async () => {
        contactsService.getById.mockResolvedValue({ id: 5, company_id: COMPANY_A, email: 'p@acme.com' });
        dedupe.getAdditionalEmails.mockResolvedValue([]);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ emails: [{ email: 'p@acme.com', is_primary: true }] });

        expect(res.status).toBe(200);
        expect(mergeSvc.resolveAddedEmail).not.toHaveBeenCalled();
    });
});

// ─── TC-CEM-U12 — ONE transaction, thrown merge → ROLLBACK, never COMMIT ───────
describe('TC-CEM-U12: a thrown merge rolls the whole PATCH back', () => {
    it('issues ROLLBACK (never COMMIT) and returns 500 without leaking a stack', async () => {
        dedupe.getAdditionalEmails.mockResolvedValue([]);
        mergeSvc.resolveAddedEmail.mockRejectedValue(new Error('boom in merge leg'));

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ emails: [{ email: 'x@acme.com', is_primary: true }] });

        expect(res.status).toBe(500);
        // The email upsert DID run (before the throw)…
        expect(dedupe.enrichEmail).toHaveBeenCalledWith(5, 'x@acme.com', mockClient);
        // …but the tx was rolled back, not committed.
        expect(clientSql()).toContain('ROLLBACK');
        expect(clientSql()).not.toContain('COMMIT');
        expect(mockClient.release).toHaveBeenCalled();
        // Generic error body — no stack / internal message leaked.
        expect(res.body).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
        expect(JSON.stringify(res.body)).not.toMatch(/boom in merge leg/);
    });
});

// ─── TC-CEM-U13 — removal is non-destructive (row deleted, history untouched) ──
describe('TC-CEM-U13: removal drops the contact_emails row without un-linking history', () => {
    it('DELETEs the dropped address and never clears email_messages linkage', async () => {
        // Current set: primary p@acme.com + extra old@acme.com. PATCH drops old@.
        contactsService.getById.mockResolvedValue({ id: 5, company_id: COMPANY_A, email: 'p@acme.com' });
        dedupe.getAdditionalEmails.mockResolvedValue(['p@acme.com', 'old@acme.com']);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ emails: [{ email: 'p@acme.com', is_primary: true }] });

        expect(res.status).toBe(200);

        const del = findCall(/DELETE FROM contact_emails/i);
        expect(del).toBeTruthy();
        expect(del.params).toEqual([5, 'old@acme.com']);
        // The kept primary is NOT deleted.
        expect(mockClient.calls.filter(c => /DELETE FROM contact_emails/i.test(c.sql)).length).toBe(1);

        // NO update that clears message linkage for the removed address, no merge.
        expect(findCall(/UPDATE email_messages/i)).toBeUndefined();
        expect(mergeSvc.resolveAddedEmail).not.toHaveBeenCalled(); // p@ is pre-existing
        expect(clientSql()).toContain('COMMIT');
    });
});

// ─── Single-transaction structural guarantees ─────────────────────────────────
describe('single-transaction boundary', () => {
    it('wraps contact UPDATE + emails + merge between exactly one BEGIN and one COMMIT on the pooled client', async () => {
        dedupe.getAdditionalEmails.mockResolvedValue([]);

        await request(makeApp())
            .patch('/api/contacts/5')
            .send({ first_name: 'Jane', emails: [{ email: 'new@acme.com', is_primary: true }] });

        const sqls = clientSql();
        expect(sqls.filter(s => s === 'BEGIN').length).toBe(1);
        expect(sqls.filter(s => s === 'COMMIT').length).toBe(1);

        // Ordering: BEGIN → contact UPDATE → enrichEmail (upsert) → resolveAddedEmail → COMMIT.
        const oBegin = sqls.indexOf('BEGIN');
        const oUpdate = orderOf(/UPDATE contacts SET/i);
        const oCommit = sqls.indexOf('COMMIT');
        expect(oBegin).toBeLessThan(oUpdate);
        expect(oUpdate).toBeLessThan(oCommit);

        // enrichEmail + resolveAddedEmail both ran on the SAME tx client, before COMMIT.
        expect(dedupe.enrichEmail).toHaveBeenCalledWith(5, 'new@acme.com', mockClient);
        expect(mergeSvc.resolveAddedEmail).toHaveBeenCalledWith(5, 'new@acme.com', COMPANY_A, mockClient);
    });

    it('emails:[] with a removal is a VALID update (not 400 NO_FIELDS)', async () => {
        contactsService.getById.mockResolvedValue({ id: 5, company_id: COMPANY_A, email: null });
        dedupe.getAdditionalEmails.mockResolvedValue(['gone@acme.com']);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ emails: [] });

        expect(res.status).toBe(200);
        expect(findCall(/DELETE FROM contact_emails/i).params).toEqual([5, 'gone@acme.com']);
        expect(clientSql()).toContain('COMMIT');
    });

    it('no valid fields AND no emails → 400 NO_FIELDS, tx never opened', async () => {
        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ unknown_field: 'x' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('NO_FIELDS');
        expect(mockClient.query).not.toHaveBeenCalled(); // never BEGIN
    });
});

// ─── TC-R-6 — middleware / tenancy ────────────────────────────────────────────
describe('TC-R-6: permission + tenancy', () => {
    it('403 without contacts.edit', async () => {
        const res = await request(makeApp({ permissions: [] }))
            .patch('/api/contacts/5')
            .send({ first_name: 'X' });
        expect(res.status).toBe(403);
        expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('404 for a foreign / absent contact (company-scoped getById → null)', async () => {
        contactsService.getById.mockResolvedValue(null);
        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ first_name: 'X', emails: [{ email: 'a@acme.com', is_primary: true }] });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
        // Guard fires before the tx opens; no merge attempted.
        expect(mockClient.query).not.toHaveBeenCalled();
        expect(mergeSvc.resolveAddedEmail).not.toHaveBeenCalled();
    });

    it('every merge call carries req.companyFilter.company_id (data isolation)', async () => {
        dedupe.getAdditionalEmails.mockResolvedValue([]);
        await request(makeApp({ companyId: COMPANY_A }))
            .patch('/api/contacts/5')
            .send({ emails: [{ email: 'iso@acme.com', is_primary: true }] });

        expect(mergeSvc.resolveAddedEmail).toHaveBeenCalledWith(5, 'iso@acme.com', COMPANY_A, mockClient);
    });
});
