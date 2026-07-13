'use strict';

/**
 * TELEPHONY-WIZARD-UX-001 T2 — Twilio Port-In routes and service.
 * Twilio SDK/upload/auth collaborators are fully mocked; PostgreSQL runs in an
 * isolated schema using the production migration so tenant and race guarantees
 * exercise real constraints and queries.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ORIGINAL_ENV = {
    DATABASE_URL: process.env.DATABASE_URL,
    PGOPTIONS: process.env.PGOPTIONS,
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
};

process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.KEYCLOAK_REALM_URL = 'http://localhost:8080/realms/crm-prod';
process.env.TWILIO_ACCOUNT_SID = 'AC11111111111111111111111111111111';
process.env.TWILIO_AUTH_TOKEN = 'master-auth-token';

const mockPortabilityFetch = jest.fn();
const mockPortingCreate = jest.fn();
const mockPortingFetch = jest.fn();
const mockPortingRemove = jest.fn();
const mockPortingPortabilities = jest.fn(() => ({ fetch: mockPortabilityFetch }));
const mockPortingPortIns = jest.fn(() => ({
    fetch: mockPortingFetch,
    remove: mockPortingRemove,
}));
mockPortingPortIns.create = mockPortingCreate;

const mockMasterClient = {
    numbers: {
        v1: {
            portingPortabilities: mockPortingPortabilities,
            portingPortIns: mockPortingPortIns,
        },
    },
};

jest.mock('node-fetch', () => jest.fn());
jest.mock('../backend/src/services/twilioClient', () => ({
    getTwilioClient: jest.fn(() => mockMasterClient),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/userService', () => ({
    findOrCreateUser: jest.fn(),
}));
jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(() => ({
        scope: 'tenant', company: null, membership: null, permissions: [],
    })),
    resolveAuthzContext: jest.fn(),
}));
jest.mock('jwks-rsa', () => jest.fn().mockReturnValue({ getSigningKey: jest.fn() }));

const express = require('express');
const request = require('supertest');
const uploadFetch = require('node-fetch');

const BASE_PATH = '/api/telephony/port-in';
const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const SCHEMA = `wiz_port_in_${process.pid}_${Date.now()}`.toLowerCase();
const MIGRATION_PATH = path.join(__dirname, '../backend/db/migrations/169_port_in_requests.sql');
const ROLLBACK_PATH = path.join(__dirname, '../backend/db/migrations/rollback_169_port_in_requests.sql');

let adminPool;
let schemaClient;
let db;
let portInService;
let telephonyTenantService;
let router;
let authenticate;
let requireCompanyAccess;
let requirePermission;
let dbReady = false;
let setupError = null;
const companyIds = [];

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

async function createTestSchema() {
    schemaClient = await adminPool.connect();
    await schemaClient.query(`CREATE SCHEMA ${SCHEMA}`);
    await schemaClient.query(`SET search_path TO ${SCHEMA}`);
    await schemaClient.query(`
        CREATE TABLE companies (
            id UUID PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            timezone TEXT NOT NULL DEFAULT 'America/New_York'
        );
        CREATE TABLE crm_users (
            id UUID PRIMARY KEY,
            company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
            email TEXT
        );
        CREATE TABLE company_telephony (
            company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
            provider TEXT NOT NULL DEFAULT 'twilio',
            twilio_subaccount_sid TEXT,
            status TEXT NOT NULL DEFAULT 'connected',
            connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            suspended_at TIMESTAMPTZ
        );
    `);
    await schemaClient.query(fs.readFileSync(MIGRATION_PATH, 'utf8'));
    await schemaClient.query(
        `INSERT INTO companies (id, name) VALUES ($1, 'Default Company')`,
        [DEFAULT_COMPANY_ID]
    );
}

async function seedCompany({ connected = true } = {}) {
    const companyId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    companyIds.push(companyId);
    await db.query(
        `INSERT INTO companies (id, name, timezone)
         VALUES ($1, $2, 'America/New_York')`,
        [companyId, `Port Test ${companyId.slice(0, 8)}`]
    );
    await db.query(
        `INSERT INTO crm_users (id, company_id, email)
         VALUES ($1, $2, 'admin@example.com')`,
        [actorId, companyId]
    );
    if (connected) {
        await db.query(
            `INSERT INTO company_telephony (company_id, twilio_subaccount_sid, status)
             VALUES ($1, $2, 'connected')`,
            [companyId, `AC${companyId.replace(/-/g, '').slice(0, 32)}`]
        );
    }
    return { companyId, actorId };
}

function appWith({ companyId, actorId, permissions = ['tenant.telephony.manage'], poisonedCompanyId } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            sub: 'kc-user',
            email: 'admin@example.com',
            crmUser: { id: actorId || crypto.randomUUID() },
        };
        req.authz = {
            scope: 'tenant',
            platform_role: 'none',
            company: companyId ? {
                id: companyId,
                name: 'Scoped Company',
                status: 'active',
                timezone: 'America/New_York',
            } : null,
            membership: companyId ? { role_key: 'tenant_admin' } : null,
            permissions,
        };
        req.companyId = poisonedCompanyId;
        next();
    });
    app.use(
        BASE_PATH,
        requirePermission('tenant.telephony.manage'),
        requireCompanyAccess,
        router
    );
    return app;
}

function realAuthApp() {
    const app = express();
    app.use(express.json());
    app.use(
        BASE_PATH,
        authenticate,
        requirePermission('tenant.telephony.manage'),
        requireCompanyAccess,
        router
    );
    return app;
}

function futureDate(days = 10) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function validFields(overrides = {}) {
    return {
        phone_number: '+16175550123',
        customer_name: 'Acme Repair LLC',
        customer_type: 'Business',
        account_number: 'ACC-123',
        pin: '4321',
        account_telephone_number: '+16175550999',
        authorized_representative: 'Ada Lovelace',
        authorized_representative_email: 'ada@example.com',
        address_street: '1 Main St',
        address_street2: 'Suite 2',
        address_city: 'Boston',
        address_state: 'MA',
        address_zip: '02108',
        address_country: 'USA',
        target_port_in_date: futureDate(),
        ...overrides,
    };
}

function createRequest(app, fields = validFields(), file = {
    buffer: Buffer.from('%PDF-1.7 utility bill'),
    filename: 'utility-bill.pdf',
    contentType: 'application/pdf',
}) {
    let req = request(app).post(BASE_PATH);
    for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) req = req.field(key, value);
    }
    if (file) req = req.attach('utility_bill', file.buffer, file);
    return req;
}

async function seedPortIn(companyId, overrides = {}) {
    const row = {
        id: crypto.randomUUID(),
        phone_number: `+1617${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`,
        status: 'pending',
        twilio_port_in_sid: null,
        twilio_status: 'In progress',
        customer_name: 'Existing Customer',
        ...overrides,
    };
    await db.query(
        `INSERT INTO port_in_requests
            (id, company_id, phone_number, status, twilio_port_in_sid,
             twilio_status, losing_carrier_info, signature_request_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
            row.id,
            companyId,
            row.phone_number,
            row.status,
            row.twilio_port_in_sid,
            row.twilio_status,
            JSON.stringify({ customerName: row.customer_name }),
            row.signature_request_url || null,
        ]
    );
    return row;
}

beforeAll(async () => {
    try {
        adminPool = new Pool({
            connectionString: ORIGINAL_ENV.DATABASE_URL || 'postgresql://localhost/twilio_calls',
            max: 1,
        });
        await createTestSchema();
        process.env.PGOPTIONS = `-c search_path=${SCHEMA}`;

        db = require('../backend/src/db/connection');
        portInService = require('../backend/src/services/portInService');
        telephonyTenantService = require('../backend/src/services/telephonyTenantService');
        router = require('../backend/src/routes/telephonyPortIn');
        ({ authenticate, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth'));
        ({ requirePermission } = require('../backend/src/middleware/authorization'));
        dbReady = true;
    } catch (err) {
        setupError = err;
        console.warn('\n[telephonyPortIn] SKIPPED-NEEDS-DB —', err.message, '\n');
    }
});

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockPortabilityFetch.mockResolvedValue({
        portable: true,
        numberType: 'LOCAL',
        notPortableReason: null,
        pinAndAccountNumberRequired: false,
    });
    uploadFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ sid: 'RD111', mime_type: 'application/pdf' }),
    });
    mockPortingCreate.mockResolvedValue({
        portInRequestSid: 'KW111',
        portInRequestStatus: 'In progress',
        signatureRequestUrl: 'https://twilio.example/loa/KW111',
    });
    mockPortingFetch.mockResolvedValue({
        portInRequestStatus: 'In progress',
        signatureRequestUrl: 'https://twilio.example/loa/KW111',
    });
    mockPortingRemove.mockResolvedValue(true);
    if (telephonyTenantService) {
        jest.spyOn(telephonyTenantService, 'connectTelephony');
    }
});

afterEach(async () => {
    if (!dbReady || !companyIds.length) return;
    const ids = companyIds.splice(0);
    await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [ids]);
});

afterAll(async () => {
    if (db?.pool) {
        try { await db.pool.end(); } catch (_) { /* ignore */ }
    }
    if (schemaClient) {
        try { await schemaClient.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch (_) { /* ignore */ }
        schemaClient.release();
    }
    if (adminPool) {
        try { await adminPool.end(); } catch (_) { /* ignore */ }
    }
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) restoreEnv(name, value);
});

function needDb() {
    if (dbReady) return true;
    console.warn('SKIPPED-NEEDS-DB:', setupError?.message || 'database unavailable');
    return false;
}

describe('migration 169', () => {
    test('applies and rolls back cleanly in a scratch schema', async () => {
        if (!needDb()) return;
        const scratch = `${SCHEMA}_rollback`;
        try {
            await schemaClient.query(`CREATE SCHEMA ${scratch}`);
            await schemaClient.query(`SET search_path TO ${scratch}`);
            await schemaClient.query(`
                CREATE TABLE companies (id UUID PRIMARY KEY);
                CREATE TABLE crm_users (id UUID PRIMARY KEY);
            `);
            await schemaClient.query(fs.readFileSync(MIGRATION_PATH, 'utf8'));
            await schemaClient.query(fs.readFileSync(ROLLBACK_PATH, 'utf8'));
            const result = await schemaClient.query("SELECT to_regclass('port_in_requests') AS table_name");
            expect(result.rows[0].table_name).toBeNull();
        } finally {
            await schemaClient.query(`SET search_path TO ${SCHEMA}`);
            await schemaClient.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
        }
    });
});

describe('port-in authentication and tenant isolation', () => {
    test('TC-WIZ-010: every endpoint rejects a missing token with 401', async () => {
        if (!needDb()) return;
        const id = crypto.randomUUID();
        const calls = [
            request(realAuthApp()).get(BASE_PATH),
            request(realAuthApp()).post(`${BASE_PATH}/check`).send({ phone_number: '+16175550123' }),
            createRequest(realAuthApp()),
            request(realAuthApp()).get(`${BASE_PATH}/${id}`),
            request(realAuthApp()).delete(`${BASE_PATH}/${id}`),
        ];
        for (const call of calls) {
            const res = await call;
            expect(res.status).toBe(401);
            expect(res.body.code).toBe('AUTH_REQUIRED');
        }
    });

    test('TC-WIZ-011: every endpoint requires tenant.telephony.manage', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        const app = appWith({ companyId, actorId, permissions: [] });
        const id = crypto.randomUUID();
        const calls = [
            request(app).get(BASE_PATH),
            request(app).post(`${BASE_PATH}/check`).send({ phone_number: '+16175550123' }),
            createRequest(app),
            request(app).get(`${BASE_PATH}/${id}`),
            request(app).delete(`${BASE_PATH}/${id}`),
        ];
        for (const call of calls) {
            const res = await call;
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('ACCESS_DENIED');
        }
        expect(mockPortabilityFetch).not.toHaveBeenCalled();
    });

    test('TC-WIZ-012: list/get/delete cannot cross company boundaries', async () => {
        if (!needDb()) return;
        const companyA = await seedCompany();
        const companyB = await seedCompany();
        const foreign = await seedPortIn(companyB.companyId, {
            phone_number: '+16175550155',
            twilio_port_in_sid: 'KWforeign',
        });
        const app = appWith({
            companyId: companyA.companyId,
            actorId: companyA.actorId,
            poisonedCompanyId: companyB.companyId,
        });

        const list = await request(app).get(`${BASE_PATH}?company_id=${companyB.companyId}`);
        const get = await request(app).get(`${BASE_PATH}/${foreign.id}`);
        const del = await request(app).delete(`${BASE_PATH}/${foreign.id}`);

        expect(list.status).toBe(200);
        expect(list.body.requests).toEqual([]);
        expect(get.status).toBe(404);
        expect(del.status).toBe(404);
        expect(mockPortingFetch).not.toHaveBeenCalled();
        expect(mockPortingRemove).not.toHaveBeenCalled();
    });
});

describe('portability check', () => {
    test('POST /check lazily connects and returns Twilio portability fields', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        mockPortabilityFetch.mockResolvedValueOnce({
            portable: false,
            numberType: 'MOBILE',
            notPortableReason: 'Manual porting is required',
            pinAndAccountNumberRequired: true,
        });

        const res = await request(appWith({ companyId, actorId }))
            .post(`${BASE_PATH}/check`)
            .send({ phone_number: '+16175550123' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            portable: false,
            number_type: 'MOBILE',
            reason: 'Manual porting is required',
        });
        expect(telephonyTenantService.connectTelephony).toHaveBeenCalledWith(companyId, {
            actorId,
            companyName: 'Scoped Company',
        });
    });

    test('POST /check maps Twilio errors to 502 PORTABILITY_CHECK_FAILED', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        mockPortabilityFetch.mockRejectedValueOnce(new Error('Twilio unavailable'));

        const res = await request(appWith({ companyId, actorId }))
            .post(`${BASE_PATH}/check`)
            .send({ phone_number: '+16175550123' });

        expect(res.status).toBe(502);
        expect(res.body.code).toBe('PORTABILITY_CHECK_FAILED');
    });
});

describe('port-in create flow', () => {
    test('TC-WIZ-014: DB-first happy path uploads the bill and sends the exact SDK model', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        const fields = validFields();
        mockPortingCreate.mockImplementationOnce(async () => {
            const local = await db.query(
                `SELECT status, twilio_port_in_sid, documents
                 FROM port_in_requests
                 WHERE company_id = $1 AND phone_number = $2`,
                [companyId, fields.phone_number]
            );
            expect(local.rows[0]).toMatchObject({
                status: 'submitted',
                twilio_port_in_sid: null,
                documents: ['RD111'],
            });
            return {
                portInRequestSid: 'KW111',
                portInRequestStatus: 'In progress',
                signatureRequestUrl: 'https://twilio.example/loa/KW111',
            };
        });

        const res = await createRequest(appWith({ companyId, actorId }), fields);

        expect(res.status).toBe(201);
        expect(res.body.request).toMatchObject({
            phone_number: fields.phone_number,
            customer_name: fields.customer_name,
            status: 'pending',
            twilio_status: 'In progress',
            signature_request_url: 'https://twilio.example/loa/KW111',
        });
        expect(res.body.request).not.toHaveProperty('losing_carrier_info');
        expect(res.body.request).not.toHaveProperty('documents');
        expect(res.body.request).not.toHaveProperty('pin');
        expect(telephonyTenantService.connectTelephony).toHaveBeenCalledWith(companyId, {
            actorId,
            companyName: 'Scoped Company',
        });

        const targetSid = `AC${companyId.replace(/-/g, '').slice(0, 32)}`;
        expect(mockPortingPortabilities).toHaveBeenCalledWith(fields.phone_number);
        expect(mockPortabilityFetch).toHaveBeenCalledWith({ targetAccountSid: targetSid });
        expect(mockPortingCreate).toHaveBeenCalledWith({
            numbersV1PortingPortInCreate: {
                accountSid: targetSid,
                documents: ['RD111'],
                phoneNumbers: [{ phoneNumber: fields.phone_number, pin: fields.pin }],
                losingCarrierInformation: {
                    customerName: fields.customer_name,
                    customerType: fields.customer_type,
                    accountNumber: fields.account_number,
                    accountTelephoneNumber: fields.account_telephone_number,
                    authorizedRepresentative: fields.authorized_representative,
                    authorizedRepresentativeEmail: fields.authorized_representative_email,
                    address: {
                        street: fields.address_street,
                        street2: fields.address_street2,
                        city: fields.address_city,
                        state: fields.address_state,
                        zip: fields.address_zip,
                        country: fields.address_country,
                    },
                },
                targetPortInDate: fields.target_port_in_date,
            },
        });

        const [uploadUrl, uploadOptions] = uploadFetch.mock.calls[0];
        const multipart = uploadOptions.body.toString('utf8');
        expect(uploadUrl).toBe('https://numbers-upload.twilio.com/v1/Documents');
        expect(uploadOptions.headers.Authorization).toBe(
            `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`
        );
        expect(multipart).toContain('name="document_type"\r\n\r\nutility_bill');
        expect(multipart).toContain('name="friendly_name"\r\n\r\nutility-bill.pdf');
        expect(multipart).toContain('name="File"; filename="utility-bill.pdf"');

        const stored = await db.query(
            `SELECT company_id, phone_number, status, twilio_port_in_sid,
                    losing_carrier_info, documents, account_number, pin,
                    account_telephone_number, created_by
             FROM port_in_requests
             WHERE company_id = $1 AND phone_number = $2`,
            [companyId, fields.phone_number]
        );
        expect(stored.rows[0]).toMatchObject({
            company_id: companyId,
            phone_number: fields.phone_number,
            status: 'pending',
            twilio_port_in_sid: 'KW111',
            documents: ['RD111'],
            account_number: fields.account_number,
            pin: fields.pin,
            account_telephone_number: fields.account_telephone_number,
            created_by: actorId,
        });
        expect(stored.rows[0].losing_carrier_info).toMatchObject({
            customerName: fields.customer_name,
            accountNumber: fields.account_number,
            accountTelephoneNumber: fields.account_telephone_number,
        });
    });

    test('TC-WIZ-015: a nonportable number returns 422 without a local request or upload', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        mockPortabilityFetch.mockResolvedValueOnce({
            portable: false,
            numberType: 'LOCAL',
            notPortableReason: 'Number is not active',
        });

        const res = await createRequest(appWith({ companyId, actorId }));

        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ ok: false, code: 'NOT_PORTABLE' });
        expect(res.body.error).toContain('Number is not active');
        expect(uploadFetch).not.toHaveBeenCalled();
        expect(mockPortingCreate).not.toHaveBeenCalled();
        const rows = await db.query('SELECT * FROM port_in_requests WHERE company_id = $1', [companyId]);
        expect(rows.rows).toEqual([]);
    });

    test('TC-WIZ-016: a target date under seven company-local days fails before connect/Twilio', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        const res = await createRequest(
            appWith({ companyId, actorId }),
            validFields({ target_port_in_date: futureDate(3) })
        );

        expect(res.status).toBe(422);
        expect(res.body.code).toBe('TARGET_DATE_TOO_SOON');
        expect(telephonyTenantService.connectTelephony).not.toHaveBeenCalled();
        expect(mockPortabilityFetch).not.toHaveBeenCalled();
    });

    test('TC-WIZ-017: invalid E.164, missing bill, and invalid MIME are 422 validation errors', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        const app = appWith({ companyId, actorId });

        const badNumber = await createRequest(app, validFields({ phone_number: '617555' }));
        const missingFile = await createRequest(app, validFields(), null);
        const badMime = await createRequest(app, validFields(), {
            buffer: Buffer.from('plain text'),
            filename: 'bill.txt',
            contentType: 'text/plain',
        });

        for (const res of [badNumber, missingFile, badMime]) {
            expect(res.status).toBe(422);
            expect(res.body.code).toBe('VALIDATION');
        }
        expect(mockPortabilityFetch).not.toHaveBeenCalled();
        expect(uploadFetch).not.toHaveBeenCalled();
    });

    test('TC-WIZ-018: active duplicate is 409 while a canceled request releases the guard', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        const existing = await seedPortIn(companyId, {
            phone_number: '+16175550123',
            status: 'pending',
        });
        const app = appWith({ companyId, actorId });

        const duplicate = await createRequest(app);
        expect(duplicate.status).toBe(409);
        expect(duplicate.body.code).toBe('PORT_ALREADY_REQUESTED');
        expect(uploadFetch).not.toHaveBeenCalled();
        expect(mockPortingCreate).not.toHaveBeenCalled();

        await db.query(
            `UPDATE port_in_requests SET status = 'canceled' WHERE id = $1 AND company_id = $2`,
            [existing.id, companyId]
        );
        const retry = await createRequest(app);
        expect(retry.status).toBe(201);
    });

    test('the partial unique index stops concurrent create calls before a second upload/create', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        const input = validFields();
        const file = {
            buffer: Buffer.from('%PDF concurrency'),
            originalname: 'bill.pdf',
            mimetype: 'application/pdf',
        };
        let releaseCreate;
        let announceCreate;
        const createStarted = new Promise(resolve => { announceCreate = resolve; });
        mockPortingCreate.mockImplementationOnce(() => {
            announceCreate();
            return new Promise(resolve => {
                releaseCreate = () => resolve({
                    portInRequestSid: 'KWconcurrent',
                    portInRequestStatus: 'In progress',
                });
            });
        });

        const first = portInService.createPortIn(companyId, input, file, { actorId });
        await createStarted;
        await expect(portInService.createPortIn(companyId, input, file, { actorId }))
            .rejects.toMatchObject({ code: 'PORT_ALREADY_REQUESTED', httpStatus: 409 });
        releaseCreate();
        await expect(first).resolves.toMatchObject({ status: 'pending' });
        expect(uploadFetch).toHaveBeenCalledTimes(1);
        expect(mockPortingCreate).toHaveBeenCalledTimes(1);
    });

    test('TC-WIZ-021: feature-gated create persists action_required and returns 502', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        mockPortingCreate.mockRejectedValueOnce({
            status: 403,
            code: 20403,
            message: 'Account lacks permission to access the API',
        });

        const res = await createRequest(appWith({ companyId, actorId }));

        expect(res.status).toBe(502);
        expect(res.body.code).toBe('PORTING_UNAVAILABLE');
        const stored = await db.query(
            `SELECT status, twilio_port_in_sid, twilio_status, documents
             FROM port_in_requests
             WHERE company_id = $1 AND phone_number = '+16175550123'`,
            [companyId]
        );
        expect(stored.rows[0]).toEqual({
            status: 'action_required',
            twilio_port_in_sid: null,
            twilio_status: 'PORTING_UNAVAILABLE',
            documents: ['RD111'],
        });
    });

    test('document upload failure marks the DB-first row failed and skips create', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        uploadFetch.mockResolvedValueOnce({ ok: false });

        const res = await createRequest(appWith({ companyId, actorId }));

        expect(res.status).toBe(502);
        expect(res.body.code).toBe('DOCUMENT_UPLOAD_FAILED');
        expect(mockPortingCreate).not.toHaveBeenCalled();
        const stored = await db.query(
            `SELECT status, twilio_status FROM port_in_requests
             WHERE company_id = $1 AND phone_number = '+16175550123'`,
            [companyId]
        );
        expect(stored.rows[0]).toEqual({
            status: 'failed',
            twilio_status: 'document_upload_failed',
        });
    });

    test('generic Twilio create failure marks failed and releases the active-number guard', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        const app = appWith({ companyId, actorId });
        mockPortingCreate.mockRejectedValueOnce({ status: 500, code: 20500, message: 'Twilio error' });

        const failed = await createRequest(app);
        expect(failed.status).toBe(502);
        expect(failed.body.code).toBe('PORT_IN_CREATE_FAILED');
        const stored = await db.query(
            `SELECT status, twilio_status FROM port_in_requests
             WHERE company_id = $1 AND phone_number = '+16175550123'`,
            [companyId]
        );
        expect(stored.rows[0]).toEqual({ status: 'failed', twilio_status: 'create_failed' });

        const retry = await createRequest(app);
        expect(retry.status).toBe(201);
    });
});

describe('port-in status refresh and cancellation', () => {
    test('TC-WIZ-019: detail fetch normalizes and persists a live Twilio status', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        const existing = await seedPortIn(companyId, {
            phone_number: '+16175550177',
            twilio_port_in_sid: 'KWrefresh',
        });
        mockPortingFetch.mockResolvedValueOnce({
            portInRequestStatus: 'in review',
            signatureRequestUrl: 'https://twilio.example/loa/refreshed',
        });

        const res = await request(appWith({ companyId, actorId })).get(`${BASE_PATH}/${existing.id}`);

        expect(res.status).toBe(200);
        expect(res.body.request).toMatchObject({
            status: 'in_review',
            twilio_status: 'in review',
            signature_request_url: 'https://twilio.example/loa/refreshed',
        });
        expect(mockPortingPortIns).toHaveBeenCalledWith('KWrefresh');
        expect(mockPortingFetch).toHaveBeenCalledTimes(1);
        const stored = await db.query(
            `SELECT status, twilio_status FROM port_in_requests
             WHERE id = $1 AND company_id = $2`,
            [existing.id, companyId]
        );
        expect(stored.rows[0]).toEqual({ status: 'in_review', twilio_status: 'in review' });
    });

    test.each([
        ['In progress', 'pending'],
        ['In review', 'in_review'],
        ['Waiting for Signature', 'action_required'],
        ['Action-Required', 'action_required'],
        ['Completed', 'completed'],
        ['Canceled', 'canceled'],
        ['Expired', 'failed'],
        ['future provider state', 'pending'],
    ])('normalizes Twilio status %s to %s', (remote, local) => {
        if (!needDb()) return;
        expect(portInService.normalizeStatus(remote)).toBe(local);
    });

    test('list refresh is best-effort and returns the last DB state on Twilio failure', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        await seedPortIn(companyId, {
            phone_number: '+16175550188',
            twilio_port_in_sid: 'KWdown',
        });
        mockPortingFetch.mockRejectedValueOnce(new Error('Twilio unavailable'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await request(appWith({ companyId, actorId })).get(BASE_PATH);

        expect(res.status).toBe(200);
        expect(res.body.requests).toHaveLength(1);
        expect(res.body.requests[0]).toMatchObject({ status: 'pending', twilio_status: 'In progress' });
        expect(warn).toHaveBeenCalled();
    });

    test('TC-WIZ-020: pending cancels remotely, terminal rejects, and Twilio 404 is success', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        const pending = await seedPortIn(companyId, {
            phone_number: '+16175550201',
            twilio_port_in_sid: 'KWcancel',
        });
        const completed = await seedPortIn(companyId, {
            phone_number: '+16175550202',
            status: 'completed',
            twilio_port_in_sid: 'KWcomplete',
        });
        const alreadyGone = await seedPortIn(companyId, {
            phone_number: '+16175550203',
            twilio_port_in_sid: 'KWgone',
        });
        const app = appWith({ companyId, actorId });

        const canceled = await request(app).delete(`${BASE_PATH}/${pending.id}`);
        expect(canceled.status).toBe(200);
        expect(canceled.body.request.status).toBe('canceled');
        expect(mockPortingPortIns).toHaveBeenCalledWith('KWcancel');

        const terminal = await request(app).delete(`${BASE_PATH}/${completed.id}`);
        expect(terminal.status).toBe(409);
        expect(terminal.body.code).toBe('NOT_CANCELABLE');

        mockPortingRemove.mockRejectedValueOnce({ status: 404 });
        const gone = await request(app).delete(`${BASE_PATH}/${alreadyGone.id}`);
        expect(gone.status).toBe(200);
        expect(gone.body.request.status).toBe('canceled');
    });

    test('an action_required request without a Twilio SID cancels locally', async () => {
        if (!needDb()) return;
        const { companyId, actorId } = await seedCompany();
        const fallback = await seedPortIn(companyId, {
            phone_number: '+16175550204',
            status: 'action_required',
            twilio_port_in_sid: null,
            twilio_status: 'PORTING_UNAVAILABLE',
        });

        const res = await request(appWith({ companyId, actorId }))
            .delete(`${BASE_PATH}/${fallback.id}`);

        expect(res.status).toBe(200);
        expect(res.body.request.status).toBe('canceled');
        expect(mockPortingRemove).not.toHaveBeenCalled();
    });

    test('default company portability uses the master SID as target', async () => {
        if (!needDb()) return;
        await portInService.checkPortability(DEFAULT_COMPANY_ID, '+16175550300');
        expect(mockPortabilityFetch).toHaveBeenCalledWith({
            targetAccountSid: process.env.TWILIO_ACCOUNT_SID,
        });
    });
});
