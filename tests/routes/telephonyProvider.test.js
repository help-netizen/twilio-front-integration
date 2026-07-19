const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const { requirePermission } = require('../../backend/src/middleware/authorization');
const telephonyProviderRouter = require('../../backend/src/routes/telephonyProvider');

function makeApp(companyId = 'company-1') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        req.authz = { permissions: ['tenant.telephony.manage'] };
        next();
    });
    app.use('/api/telephony/provider', telephonyProviderRouter);
    return app;
}

// App where the caller has an authenticated company context and a selectable
// effective-permission set. The REAL route middleware reads `permissions`.
function makeAppWithPermissions(permissions, companyId = 'company-1') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        req.authz = { permissions };
        next();
    });
    app.use('/api/telephony/provider', telephonyProviderRouter);
    return app;
}

describe('F017 telephony provider status', () => {
    const oldEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...oldEnv };
        process.env.TWILIO_ACCOUNT_SID = 'AC1234567890abcdef';
        process.env.TWILIO_AUTH_TOKEN = 'secret-token';
        mockQuery.mockResolvedValue({ rows: [{ count: 9 }] });
    });

    afterAll(() => {
        process.env = oldEnv;
    });

    test('returns provider metadata from env and tenant-scoped local inventory count', async () => {
        const res = await request(makeApp('company-1'))
            .get('/api/telephony/provider');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(expect.objectContaining({
            name: 'Twilio',
            status: 'connected',
            account_sid: 'AC************cdef',
            numbers_count: 9,
            inventory_source: 'phone_number_settings',
            error_log: [],
        }));
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('FROM phone_number_settings'),
            ['company-1']
        );
    });

    test('does not report connected when Twilio credentials are missing', async () => {
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;

        const res = await request(makeApp())
            .get('/api/telephony/provider');

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('error');
        expect(res.body.data.account_sid).toBeNull();
        expect(res.body.data.error_log).toContain('Twilio credentials are not configured');
    });
});

describe('TELEPHONY-AUTONOMOUS-MODE-001 autonomous-mode API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('provider can read the flag with phone_calls.use and no manage permission', async () => {
        mockQuery.mockResolvedValue({ rows: [{ autonomous_mode: true }] });

        const res = await request(makeAppWithPermissions(['phone_calls.use']))
            .get('/api/telephony/provider/autonomous-mode');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { autonomous_mode: true } });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('SELECT autonomous_mode FROM company_telephony WHERE company_id = $1'),
            ['company-1']
        );
    });

    test('effective-permission deny blocks GET without phone_calls.use', async () => {
        const res = await request(makeAppWithPermissions(['pulse.view']))
            .get('/api/telephony/provider/autonomous-mode');

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockQuery).not.toHaveBeenCalledWith(
            expect.stringContaining('SELECT autonomous_mode'),
            expect.anything()
        );
    });

    test('GET COALESCEs a missing company_telephony row to false', async () => {
        mockQuery.mockResolvedValue({ rows: [] }); // company never connected a subaccount

        const res = await request(makeAppWithPermissions(['phone_calls.use']))
            .get('/api/telephony/provider/autonomous-mode');

        expect(res.status).toBe(200);
        expect(res.body.data.autonomous_mode).toBe(false);
    });

    // ── PATCH is gated by tenant.telephony.manage ──
    test('PATCH is rejected (403) without tenant.telephony.manage', async () => {
        mockQuery.mockResolvedValue({ rows: [] }); // audit_log insert on denial

        const res = await request(makeAppWithPermissions(['tenant.company.manage']))
            .patch('/api/telephony/provider/autonomous-mode')
            .send({ autonomous_mode: true });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        // Gate blocks BEFORE any UPSERT touches company_telephony.
        expect(mockQuery).not.toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO company_telephony'),
            expect.anything()
        );
    });

    test('PATCH upserts and returns the saved flag with tenant.telephony.manage', async () => {
        mockQuery.mockImplementation((sql) => {
            if (sql.includes('INSERT INTO company_telephony')) {
                return { rows: [{ autonomous_mode: true }] };
            }
            return { rows: [] }; // audit_log insert
        });

        const res = await request(makeAppWithPermissions(['tenant.telephony.manage']))
            .patch('/api/telephony/provider/autonomous-mode')
            .send({ autonomous_mode: true });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { autonomous_mode: true } });
        // Upsert is company-scoped and works even with no pre-existing row.
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('ON CONFLICT (company_id) DO UPDATE SET'),
            ['company-1', true]
        );
    });

    test('PATCH rejects a non-boolean body (422) without touching the DB', async () => {
        const res = await request(makeAppWithPermissions(['tenant.telephony.manage']))
            .patch('/api/telephony/provider/autonomous-mode')
            .send({ autonomous_mode: 'yes' });

        expect(res.status).toBe(422);
        expect(mockQuery).not.toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO company_telephony'),
            expect.anything()
        );
    });

    test('company scoping: the flag is read/written only for the caller company', async () => {
        mockQuery.mockResolvedValue({ rows: [{ autonomous_mode: false }] });

        await request(makeAppWithPermissions(['phone_calls.use'], 'company-XYZ'))
            .get('/api/telephony/provider/autonomous-mode');

        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('WHERE company_id = $1'),
            ['company-XYZ'],
        );
    });
});
