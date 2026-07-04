/**
 * EMAIL-LEAD-ORIGIN-001 — lead-by-contact lookup + phone-optional POST /api/leads.
 *
 * DB, realtimeService, and the router's service deps are mocked (jest mocks the
 * DB — the real phoneless-insert / by-contact / EXPLAIN(idx_leads_contact_id)
 * paths are covered by the real-DB-copy verify plan in the spec, NOT here).
 *
 * Real-DB-copy verification (documented, run against a prod copy — see spec
 * "Verify plan"):
 *   1. EXPLAIN getLeadByContact → uses idx_leads_contact_id (no seq-scan).
 *   2. POST /api/leads with Email + name + selected_contact_id, NO phone →
 *      stored row has phone NULL, email set, contact_id set.
 *   3. getLeadByContact returns the open lead / null when the contact has a job /
 *      null when the only lead is Lost or Converted.
 *   4. Foreign-company contactId → null.
 *   5. A phone create + GET /by-phone stay byte-identical to today.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: jest.fn() }));

// Router deps (so backend/src/routes/leads.js mounts cleanly in the route tests).
jest.mock('../backend/src/services/noteAttachmentsService', () => ({ MAX_FILE_SIZE: 10 * 1024 * 1024 }));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/contactDedupeService', () => ({
    resolveContact: jest.fn(),
    createNewContactPublic: jest.fn(),
}));
jest.mock('../backend/src/services/contactAddressService', () => ({ resolveAddress: jest.fn() }));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn(), actorName: () => 'Tester' }));
jest.mock('../backend/src/services/pushService', () => ({ sendPushToCompany: jest.fn(() => Promise.resolve()) }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(() => Promise.resolve()) }));

const express = require('express');
const request = require('supertest');
const db = require('../backend/src/db/connection');
const leadsService = require('../backend/src/services/leadsService');
const contactDedupeService = require('../backend/src/services/contactDedupeService');
const leadsRouter = require('../backend/src/routes/leads');

function makeLeadRow(overrides = {}) {
    return {
        id: 77,
        uuid: 'ABCXYZ',
        serial_id: 5005,
        company_id: 'company-1',
        status: 'Submitted',
        contact_id: 900,
        first_name: 'Jane',
        last_name: 'Doe',
        phone: null,
        email: 'jane@example.com',
        team: [],
        ...overrides,
    };
}

// Mount the real router behind a middleware that injects the authz/company
// context the way requireCompanyAccess would, so requirePermission gates run.
function appAs(perms, companyId = 'company-1') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'u1', email: 't@t.com', name: 'Tester', crmUser: { id: 1 } };
        req.authz = { scope: 'tenant', permissions: perms, company: { id: companyId } };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', leadsRouter);
    return app;
}

beforeEach(() => {
    db.query.mockReset();
    contactDedupeService.resolveContact.mockReset();
    contactDedupeService.createNewContactPublic.mockReset();
});

// =============================================================================
// leadsService.getLeadByContact — SQL shape mirrors getLeadByPhone
// =============================================================================
describe('leadsService.getLeadByContact', () => {
    test('is exported', () => {
        expect(typeof leadsService.getLeadByContact).toBe('function');
    });

    test('keys on contact_id=$1 + open-status filter + company_id=$2, team agg, ORDER BY id DESC LIMIT 1', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeLeadRow()] }) // main lookup
            .mockResolvedValueOnce({ rows: [] });             // job-exists post-filter (no job)

        const lead = await leadsService.getLeadByContact(900, 'company-1');

        expect(lead).toBeTruthy();
        expect(lead.ClientId ?? lead.id ?? lead.SerialId).toBeDefined();

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/l\.contact_id\s*=\s*\$1/);
        expect(sql).toMatch(/l\.status\s+NOT\s+IN\s*\(\s*'Lost'\s*,\s*'Converted'\s*\)/);
        expect(sql).toMatch(/l\.company_id\s*=\s*\$2/);
        expect(sql).toMatch(/LEFT\s+JOIN\s+lead_team_assignments\s+lta\s+ON\s+lta\.lead_id\s*=\s*l\.id/);
        expect(sql).toMatch(/json_agg/);
        expect(sql).toMatch(/GROUP\s+BY\s+l\.id/);
        expect(sql).toMatch(/ORDER\s+BY\s+l\.id\s+DESC/);
        expect(sql).toMatch(/LIMIT\s+1/);
        expect(params).toEqual([900, 'company-1']);
    });

    test('omits the company predicate (and $2) when companyId is not passed', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeLeadRow()] })
            .mockResolvedValueOnce({ rows: [] });

        await leadsService.getLeadByContact(900);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).not.toMatch(/company_id/);
        expect(params).toEqual([900]);
    });

    test('runs the "contact has a job → null" post-filter and returns null when a job exists', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [makeLeadRow({ contact_id: 900 })] })
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // job exists

        const lead = await leadsService.getLeadByContact(900, 'company-1');

        expect(lead).toBeNull();
        expect(db.query).toHaveBeenCalledTimes(2);
        const [jobSql, jobParams] = db.query.mock.calls[1];
        expect(jobSql).toMatch(/FROM\s+jobs\s+WHERE\s+contact_id\s*=\s*\$1\s+LIMIT\s+1/);
        expect(jobParams).toEqual([900]);
    });

    test('returns null when no lead row matches (status filter excludes Lost/Converted at the DB)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const lead = await leadsService.getLeadByContact(900, 'company-1');
        expect(lead).toBeNull();
        expect(db.query).toHaveBeenCalledTimes(1); // no job post-filter when no row
    });

    test('returns null without querying when contactId is falsy', async () => {
        expect(await leadsService.getLeadByContact(undefined, 'company-1')).toBeNull();
        expect(await leadsService.getLeadByContact(0, 'company-1')).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });
});

// =============================================================================
// GET /api/leads/by-contact/:contactId
// =============================================================================
describe('GET /api/leads/by-contact/:contactId', () => {
    test('returns { lead } for a valid contactId, company-scoped', async () => {
        const spy = jest.spyOn(leadsService, 'getLeadByContact').mockResolvedValueOnce(makeLeadRow());
        const res = await request(appAs(['leads.view'])).get('/by-contact/900');

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toHaveProperty('lead');
        expect(res.body.data.lead).toBeTruthy();
        expect(spy).toHaveBeenCalledWith(900, 'company-1');
        spy.mockRestore();
    });

    test('returns { lead: null } when no lead is linked', async () => {
        const spy = jest.spyOn(leadsService, 'getLeadByContact').mockResolvedValueOnce(null);
        const res = await request(appAs(['pulse.view'])).get('/by-contact/900');

        expect(res.status).toBe(200);
        expect(res.body.data.lead).toBeNull();
        spy.mockRestore();
    });

    test('accepts pulse.view as well as leads.view (mirrors by-phone gate)', async () => {
        const spy = jest.spyOn(leadsService, 'getLeadByContact').mockResolvedValue(null);
        expect((await request(appAs(['leads.view'])).get('/by-contact/900')).status).toBe(200);
        expect((await request(appAs(['pulse.view'])).get('/by-contact/900')).status).toBe(200);
        spy.mockRestore();
    });

    test('403 without leads.view / pulse.view', async () => {
        const spy = jest.spyOn(leadsService, 'getLeadByContact');
        const res = await request(appAs(['jobs.view'])).get('/by-contact/900');
        expect(res.status).toBe(403);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('400 INVALID_ID on a non-numeric id', async () => {
        const spy = jest.spyOn(leadsService, 'getLeadByContact');
        const res = await request(appAs(['leads.view'])).get('/by-contact/abc');
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_ID');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('400 INVALID_ID on a non-positive id', async () => {
        const spy = jest.spyOn(leadsService, 'getLeadByContact');
        const res = await request(appAs(['leads.view'])).get('/by-contact/0');
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_ID');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('threads the caller company_id into getLeadByContact (tenant isolation)', async () => {
        const spy = jest.spyOn(leadsService, 'getLeadByContact').mockResolvedValueOnce(null);
        await request(appAs(['leads.view'], 'company-XYZ')).get('/by-contact/900');
        expect(spy).toHaveBeenCalledWith(900, 'company-XYZ');
        spy.mockRestore();
    });

    test('is matched as a static segment, NOT as /:uuid', async () => {
        const byContact = jest.spyOn(leadsService, 'getLeadByContact').mockResolvedValueOnce(null);
        const byUuid = jest.spyOn(leadsService, 'getLeadByUUID').mockResolvedValue(makeLeadRow());
        await request(appAs(['leads.view'])).get('/by-contact/900');
        expect(byContact).toHaveBeenCalledTimes(1);
        expect(byUuid).not.toHaveBeenCalled();
        byContact.mockRestore();
        byUuid.mockRestore();
    });
});

// =============================================================================
// POST /api/leads — relaxed validation (phone OR email OR selected_contact_id)
// =============================================================================
describe('POST /api/leads validation (EMAIL-LEAD-ORIGIN-001)', () => {
    test('rejects 400 VALIDATION_ERROR when phone, email AND contact are all absent', async () => {
        const createSpy = jest.spyOn(leadsService, 'createLead');
        const res = await request(appAs(['leads.create']))
            .post('/')
            .send({ FirstName: 'Jane', LastName: 'Doe' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toMatch(/Phone, Email, or a selected contact is required/);
        expect(createSpy).not.toHaveBeenCalled();
        createSpy.mockRestore();
    });

    test('accepts an email-only lead (no phone, no contact) → 201', async () => {
        contactDedupeService.resolveContact.mockResolvedValueOnce({ contact_id: 555, status: 'created', matched_by: 'email', email_enriched: false, warnings: [] });
        const createSpy = jest.spyOn(leadsService, 'createLead').mockResolvedValueOnce({ UUID: 'U1', SerialId: 1, ClientId: '77', link: null });
        db.query.mockResolvedValue({ rows: [] }); // link-lead-to-contact UPDATE + any address noop

        const res = await request(appAs(['leads.create']))
            .post('/')
            .send({ FirstName: 'Jane', LastName: 'Doe', Email: 'jane@example.com' });

        expect(res.status).toBe(201);
        expect(createSpy).toHaveBeenCalledTimes(1);
        createSpy.mockRestore();
    });

    test('accepts a selected_contact_id-only lead (no phone, no email) via the attach branch → 201', async () => {
        const createSpy = jest.spyOn(leadsService, 'createLead').mockResolvedValueOnce({ UUID: 'U2', SerialId: 2, ClientId: '78', link: null });
        db.query.mockResolvedValue({ rows: [] });

        const res = await request(appAs(['leads.create']))
            .post('/')
            .send({ FirstName: 'Jane', LastName: 'Doe', selected_contact_id: 900, contact_update_mode: 'attach' });

        expect(res.status).toBe(201);
        // attach branch links directly — no resolveContact, no fabricated phone.
        expect(contactDedupeService.resolveContact).not.toHaveBeenCalled();
        const [leadBody] = createSpy.mock.calls[0];
        expect(leadBody.contact_id).toBe(900);
        expect(leadBody.Phone).toBeUndefined();
        createSpy.mockRestore();
    });

    test('still accepts a phone-only lead (phone-origin path unchanged) → 201', async () => {
        contactDedupeService.resolveContact.mockResolvedValueOnce({ contact_id: 601, status: 'created', matched_by: 'phone', email_enriched: false, warnings: [] });
        const createSpy = jest.spyOn(leadsService, 'createLead').mockResolvedValueOnce({ UUID: 'U3', SerialId: 3, ClientId: '79', link: null });
        db.query.mockResolvedValue({ rows: [] });

        const res = await request(appAs(['leads.create']))
            .post('/')
            .send({ FirstName: 'Jane', LastName: 'Doe', Phone: '+16175551212' });

        expect(res.status).toBe(201);
        expect(createSpy).toHaveBeenCalledTimes(1);
        createSpy.mockRestore();
    });

    test('rejects a too-short phone with no email/contact (min-5 rule preserved)', async () => {
        const createSpy = jest.spyOn(leadsService, 'createLead');
        const res = await request(appAs(['leads.create']))
            .post('/')
            .send({ FirstName: 'Jane', LastName: 'Doe', Phone: '12' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(createSpy).not.toHaveBeenCalled();
        createSpy.mockRestore();
    });
});

// =============================================================================
// POST /api/leads — update_contact phone guard (blank Phone must not null it)
// =============================================================================
describe('POST /api/leads update_contact phone guard', () => {
    function contactUpdateSql() {
        // The contact UPDATE is the first db.query in the update_contact branch.
        const call = db.query.mock.calls.find(([sql]) => /UPDATE\s+contacts\s+SET/i.test(sql));
        return call || [null, null];
    }

    test('a BLANK Phone in update_contact mode does NOT write phone_e164', async () => {
        const createSpy = jest.spyOn(leadsService, 'createLead').mockResolvedValueOnce({ UUID: 'U4', SerialId: 4, ClientId: '80', link: null });
        db.query.mockResolvedValue({ rows: [] });

        const res = await request(appAs(['leads.create']))
            .post('/')
            .send({ FirstName: 'Jane', LastName: 'Doe', Email: 'jane@example.com', selected_contact_id: 900, contact_update_mode: 'update_contact' });

        expect(res.status).toBe(201);
        const [sql, params] = contactUpdateSql();
        expect(sql).toBeTruthy();
        expect(sql).not.toMatch(/phone_e164/);
        // no phone value should have been pushed
        expect(params).not.toContain('+1');
        createSpy.mockRestore();
    });

    test('a present Phone in update_contact mode DOES write phone_e164', async () => {
        const createSpy = jest.spyOn(leadsService, 'createLead').mockResolvedValueOnce({ UUID: 'U5', SerialId: 5, ClientId: '81', link: null });
        db.query.mockResolvedValue({ rows: [] });

        const res = await request(appAs(['leads.create']))
            .post('/')
            .send({ FirstName: 'Jane', LastName: 'Doe', Phone: '+16175551212', selected_contact_id: 900, contact_update_mode: 'update_contact' });

        expect(res.status).toBe(201);
        const [sql] = contactUpdateSql();
        expect(sql).toMatch(/phone_e164/);
        createSpy.mockRestore();
    });
});
