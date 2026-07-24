'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/contactDedupeService', () => ({}));
jest.mock('../backend/src/services/zenbookerSyncService', () => ({}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({ MAX_FILE_SIZE: 1024 }));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const express = require('express');
const request = require('supertest');
const db = require('../backend/src/db/connection');
const contactsRouter = require('../backend/src/routes/contacts');

const COMPANY = '00000000-0000-0000-0000-00000000c101';
const PROVIDER = '00000000-0000-0000-0000-00000000c102';

function appFor({ permissions = [], scopes = { job_visibility: 'assigned_only' } } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'provider-sub', crmUser: { id: PROVIDER } };
        req.authz = {
            scope: 'tenant',
            permissions,
            scopes,
            company: { id: COMPANY },
            membership: { role_key: 'provider' },
        };
        req.companyFilter = { company_id: COMPANY };
        next();
    });
    app.use('/', contactsRouter);
    return app;
}

function useContactRows(rows) {
    db.query.mockImplementation(async (sql) => {
        if (/SELECT COUNT\(\*\)::int AS total FROM contacts c/i.test(sql)) {
            return { rows: [{ total: rows.length }] };
        }
        if (/SELECT c\.\*/i.test(sql)) return { rows };
        throw new Error(`Unexpected Contacts SQL: ${sql}`);
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    useContactRows([{
        id: 42,
        company_id: COMPANY,
        full_name: 'Ada Assigned',
        phone_e164: '+16175550142',
        secondary_phone: '+16175550942',
        email: 'ada@example.test',
        notes: 'must not leak',
        zenbooker_data: {},
        __cursor_id: '42',
    }]);
});

describe('provider assigned-contact search route-local gate', () => {
    test('T-own: provider.enabled + assigned_only returns the compact projection only', async () => {
        const response = await request(appFor({ permissions: ['provider.enabled'] }))
            .get('/')
            .query({ search: 'Ada', limit: 20 });

        expect(response.status).toBe(200);
        expect(response.body.data.results).toEqual([{
            id: 42,
            name: 'Ada Assigned',
            phone: '+16175550142',
            email: 'ada@example.test',
        }]);
        expect(Object.keys(response.body.data.results[0]).sort())
            .toEqual(['email', 'id', 'name', 'phone']);
        for (const [sql, params] of db.query.mock.calls) {
            expect(sql).toContain('c.company_id = $1');
            expect(sql).toContain('pj.company_id = c.company_id');
            expect(sql).toContain('pj.assigned_provider_user_ids @> $2::jsonb');
            expect(params.slice(0, 3)).toEqual([
                COMPANY,
                JSON.stringify([PROVIDER]),
                '%Ada%',
            ]);
        }
    });

    test.each([
        ['no permission', [], { job_visibility: 'assigned_only' }, 'Ada'],
        ['provider permission but company-wide scope', ['provider.enabled'], { job_visibility: 'all' }, 'Ada'],
        ['provider permission but no search', ['provider.enabled'], { job_visibility: 'assigned_only' }, undefined],
    ])('R-matrix deny: %s', async (_label, permissions, scopes, search) => {
        const req = request(appFor({ permissions, scopes })).get('/');
        if (search !== undefined) req.query({ search });
        const response = await req;

        expect(response.status).toBe(403);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('contacts.view retains the full office list contract', async () => {
        const response = await request(appFor({
            permissions: ['contacts.view'],
            scopes: { job_visibility: 'all' },
        })).get('/');

        expect(response.status).toBe(200);
        expect(response.body.data.results[0]).toEqual(expect.objectContaining({
            id: 42,
            full_name: 'Ada Assigned',
            phone_e164: '+16175550142',
            company_id: COMPANY,
            notes: 'must not leak',
        }));
    });
});
