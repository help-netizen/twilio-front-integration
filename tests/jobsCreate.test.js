/**
 * Tests for local-only direct Job creation after Zenbooker job traffic was
 * decommissioned.
 */

'use strict';

const express = require('express');
const http = require('http');

function request(app, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: server.address().port,
                path,
                method: method.toUpperCase(),
                headers: { 'Content-Type': 'application/json' },
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    server.close();
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(data) });
                    } catch {
                        resolve({ status: res.statusCode, body: data });
                    }
                });
            });
            req.on('error', err => { server.close(); reject(err); });
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

const mockCreateDirectJob = jest.fn();
const mockLogJobActivity = jest.fn();
const mockEventEmit = jest.fn(async () => {});

jest.mock('../backend/src/services/jobsService', () => ({
    createDirectJob: (...args) => mockCreateDirectJob(...args),
}));
jest.mock('../backend/src/services/jobActivityService', () => ({
    userActor: id => ({ id, type: 'user', label: null, source: 'crm' }),
    logJobActivity: (...args) => mockLogJobActivity(...args),
}));
jest.mock('../backend/src/services/eventBus', () => ({ emit: (...args) => mockEventEmit(...args) }));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1,
    MAX_FILES_PER_NOTE: 1,
}));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/services/stripePaymentsService', () => ({
    StripePaymentsError: class extends Error {},
}));

const jobsRouter = require('../backend/src/routes/jobs');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const VALID_BODY = {
    contact: { name: 'Jane Doe', phone: '+16175551234' },
    address: { line1: '6 Cirrus Drive', city: 'Ashland', postal_code: '01721' },
    slot: { start: '2026-07-01T14:00:00Z', end: '2026-07-01T16:00:00Z' },
    job_type: 'Refrigerator repair',
};

function routeApp({ permissions = [], companyFilter = { company_id: COMPANY }, noTenant = false } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'u-1' } };
        req.authz = { scope: 'tenant', permissions, scopes: {} };
        req.companyFilter = noTenant ? undefined : companyFilter;
        req.companyId = 'LEGACY-DO-NOT-USE';
        next();
    });
    app.use('/', jobsRouter);
    return app;
}

describe('POST /api/jobs — local route contract', () => {
    beforeEach(() => mockCreateDirectJob.mockReset());

    test('denies without jobs.create permission', async () => {
        const res = await request(routeApp({ permissions: [] }), 'POST', '/', VALID_BODY);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockCreateDirectJob).not.toHaveBeenCalled();
    });

    test('uses req.companyFilter and returns the local-only result', async () => {
        mockCreateDirectJob.mockResolvedValue({
            job_id: 7,
            zenbooker_job_id: null,
            zb_warning: null,
        });
        const res = await request(routeApp({ permissions: ['jobs.create'] }), 'POST', '/', VALID_BODY);

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ job_id: 7, zenbooker_job_id: null, zb_warning: null });
        expect(mockCreateDirectJob).toHaveBeenCalledWith(
            COMPANY,
            VALID_BODY,
            { id: 'u-1', type: 'user', label: null, source: 'crm' }
        );
    });

    test('returns 403 when companyFilter is absent', async () => {
        const res = await request(
            routeApp({ permissions: ['jobs.create'], noTenant: true }),
            'POST',
            '/',
            VALID_BODY
        );
        expect(res.status).toBe(403);
        expect(mockCreateDirectJob).not.toHaveBeenCalled();
    });

    test('the removed bulk-import endpoint is not routable', async () => {
        const res = await request(routeApp({ permissions: ['jobs.edit'] }), 'POST', '/sync');
        expect(res.status).toBe(404);
    });
});

describe('jobsService.createDirectJob local persistence', () => {
    function loadService({ dbQuery, resolveContact, resolveProviderUserIds }) {
        let service;
        jest.isolateModules(() => {
            jest.doMock('../backend/src/db/connection', () => ({
                query: dbQuery,
                getClient: jest.fn(),
                pool: { connect: jest.fn() },
            }));
            jest.doMock('../backend/src/services/contactDedupeService', () => ({
                resolveContact: resolveContact || jest.fn(),
            }));
            jest.doMock('../backend/src/db/membershipQueries', () => ({
                resolveProviderUserIds: resolveProviderUserIds || jest.fn(async () => []),
            }));
            jest.doMock('../backend/src/services/fsmService', () => ({}));
            jest.doMock('../backend/src/services/eventService', () => ({}));
            jest.doMock('../backend/src/services/contactPropagationService', () => ({
                propagateContactDetails: jest.fn(async () => {}),
            }));
            jest.doMock('../backend/src/services/routeSegmentService', () => ({
                recalcForJob: jest.fn(async () => {}),
                enqueueGeocode: jest.fn(async () => {}),
            }));
            service = jest.requireActual('../backend/src/services/jobsService');
        });
        return service;
    }

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('../backend/src/db/connection');
    });

    test('rejects an existing contact from another company before any insert', async () => {
        const dbQuery = jest.fn().mockResolvedValue({ rows: [] });
        const service = loadService({ dbQuery });

        await expect(service.createDirectJob(COMPANY, {
            contact: { contact_id: 999 },
            slot: { start: '2026-07-01T14:00:00Z', end: '2026-07-01T16:00:00Z' },
        })).rejects.toMatchObject({ message: 'Contact not found', httpStatus: 404 });

        expect(dbQuery).toHaveBeenCalledWith(
            'SELECT id FROM contacts WHERE id = $1 AND company_id = $2',
            [999, COMPANY]
        );
        expect(dbQuery.mock.calls.some(([sql]) => /INSERT INTO jobs/.test(sql))).toBe(false);
    });

    test('creates the job locally with description, assignment, and provider mirror', async () => {
        const dbQuery = jest.fn(async sql => {
            if (/INSERT INTO jobs/.test(sql)) {
                return {
                    rows: [{
                        id: 42,
                        company_id: COMPANY,
                        contact_id: 5,
                        blanc_status: 'Submitted',
                        service_name: 'Refrigerator repair',
                        description: 'door seal',
                        address: '6 Cirrus Drive, Ashland, 01721',
                        assigned_techs: [{ id: 'tech-7' }],
                        assigned_provider_user_ids: ['user-7'],
                        notes: [],
                    }],
                };
            }
            return { rows: [] };
        });
        const resolveContact = jest.fn().mockResolvedValue({ contact_id: 5, status: 'created' });
        const resolveProviderUserIds = jest.fn().mockResolvedValue(['user-7']);
        const service = loadService({ dbQuery, resolveContact, resolveProviderUserIds });

        const result = await service.createDirectJob(COMPANY, {
            contact: { name: 'Jane Doe', phone: '+16175551234' },
            address: { line1: '6 Cirrus Drive', city: 'Ashland', postal_code: '01721' },
            slot: {
                start: '2026-07-01T14:00:00Z',
                end: '2026-07-01T16:00:00Z',
                tech_id: 'tech-7',
            },
            job_type: 'Refrigerator repair',
            description: 'door seal',
        });

        expect(result).toEqual({ job_id: 42, zenbooker_job_id: null, zb_warning: null });
        expect(resolveProviderUserIds).toHaveBeenCalledWith(COMPANY, ['tech-7']);
        const [insertSql, insertParams] = dbQuery.mock.calls.find(([sql]) => /INSERT INTO jobs/.test(sql));
        expect(insertSql).toContain('description');
        expect(insertSql).toContain('assigned_provider_user_ids');
        expect(insertParams).toContain('door seal');
        expect(insertParams).toContain(JSON.stringify([{ id: 'tech-7' }]));
        expect(insertParams).toContain(JSON.stringify(['user-7']));
    });
});
