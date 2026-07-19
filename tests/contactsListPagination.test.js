'use strict';

const COMPANY = '00000000-0000-0000-0000-00000000d101';
const PROVIDER_USER = '00000000-0000-0000-0000-00000000d102';

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
const contactsService = require('../backend/src/services/contactsService');
const contactsRouter = require('../backend/src/routes/contacts');

function contactRow(id, overrides = {}) {
    return {
        id,
        company_id: COMPANY,
        full_name: `Contact ${id}`,
        phone_e164: `+1555000${String(id).padStart(4, '0')}`,
        email: `contact${id}@example.com`,
        zenbooker_data: {},
        __cursor_id: String(id),
        ...overrides,
    };
}

function useListDispatch({ total = 0, rows = [] } = {}) {
    db.query.mockImplementation(async (sql) => {
        if (/SELECT COUNT\(\*\)::int AS total FROM contacts c/i.test(sql)) {
            return { rows: [{ total }] };
        }
        if (/SELECT c\.\*/i.test(sql)) return { rows };
        throw new Error(`Unexpected Contacts list SQL: ${sql}`);
    });
}

function appFor(companyId = COMPANY) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'user-1', crmUser: { id: PROVIDER_USER } };
        req.authz = {
            scope: 'tenant',
            permissions: ['contacts.view'],
            scopes: { job_visibility: 'all' },
            membership: { role_key: 'tenant_admin' },
        };
        if (companyId) req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', contactsRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    useListDispatch();
});

describe('Contacts route and predicate contract', () => {
    test('missing company remains a typed 403 with zero SQL', async () => {
        const response = await request(appFor(null)).get('/');
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(db.query).not.toHaveBeenCalled();
    });

    test('company/provider/search predicates are byte-identical in total and rows', async () => {
        await contactsService.listContacts({
            companyId: COMPANY,
            providerScope: { assignedOnly: true, userId: PROVIDER_USER },
            search: 'Ada',
            limit: 50,
        });

        expect(db.query).toHaveBeenCalledTimes(2);
        for (const [sql, params] of db.query.mock.calls) {
            expect(sql).toMatch(/c\.company_id = \$1/);
            expect(sql).toMatch(/pj\.company_id = c\.company_id/);
            expect(sql).toMatch(/pj\.assigned_provider_user_ids @> \$2::jsonb/);
            expect(sql).toMatch(/c\.full_name ILIKE \$3/);
            expect(sql).toMatch(/c\.phone_e164 ILIKE \$3/);
            expect(sql).toMatch(/c\.secondary_phone ILIKE \$3/);
            expect(sql).toMatch(/c\.email ILIKE \$3/);
            expect(params.slice(0, 3)).toEqual([
                COMPANY,
                JSON.stringify([PROVIDER_USER]),
                '%Ada%',
            ]);
        }
    });

    test('route returns typed 400s for invalid input before SQL', async () => {
        const badOffset = await request(appFor()).get('/').query({ offset: '-1' });
        expect(badOffset.status).toBe(400);
        expect(badOffset.body.error.code).toBe('INVALID_QUERY');
        expect(db.query).not.toHaveBeenCalled();

        const mixed = await request(appFor()).get('/').query({ cursor: 'opaque', offset: '0' });
        expect(mixed.status).toBe(400);
        expect(mixed.body.error.code).toBe('INVALID_CURSOR_REQUEST');
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('Contacts ID cursor boundaries', () => {
    test('exactly 50 matching contacts end without false has_more', async () => {
        useListDispatch({
            total: 50,
            rows: Array.from({ length: 50 }, (_unused, index) => contactRow(50 - index)),
        });

        const page = await contactsService.listContacts({ companyId: COMPANY, limit: 50 });

        expect(page.results).toHaveLength(50);
        expect(page.pagination).toMatchObject({
            mode: 'cursor',
            total: 50,
            returned: 50,
            has_more: false,
            next_cursor: null,
        });
        expect(db.query.mock.calls[1][1].at(-1)).toBe(51);
    });

    test('51 contacts return 50 then one, using id keyset and no continuation count', async () => {
        useListDispatch({
            total: 51,
            rows: Array.from({ length: 51 }, (_unused, index) => contactRow(100 - index)),
        });
        const first = await contactsService.listContacts({ companyId: COMPANY, limit: 50 });

        expect(first.pagination).toMatchObject({ total: 51, has_more: true });
        expect(first.pagination.next_cursor).toEqual(expect.any(String));

        jest.clearAllMocks();
        useListDispatch({ rows: [contactRow(50)] });
        const second = await contactsService.listContacts({
            companyId: COMPANY,
            limit: 50,
            cursor: first.pagination.next_cursor,
        });

        expect(second.results.map(contact => contact.id)).toEqual([50]);
        expect(second.pagination).toMatchObject({ total: null, has_more: false, next_cursor: null });
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/c\.id < \$2::bigint/);
        expect(params.slice(0, 2)).toEqual([COMPANY, '51']);
    });

    test('tenant, provider scope, search, or page-size changes reject cursor reuse before SQL', async () => {
        useListDispatch({
            total: 51,
            rows: Array.from({ length: 51 }, (_unused, index) => contactRow(100 - index)),
        });
        const first = await contactsService.listContacts({
            companyId: COMPANY,
            providerScope: { assignedOnly: true, userId: PROVIDER_USER },
            search: 'Ada',
            limit: 50,
        });

        jest.clearAllMocks();
        await expect(contactsService.listContacts({
            companyId: COMPANY,
            providerScope: { assignedOnly: true, userId: PROVIDER_USER },
            search: 'Grace',
            limit: 50,
            cursor: first.pagination.next_cursor,
        })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('softphone-style limit=3,offset=0 remains compatible and uses the extra-row probe', async () => {
        useListDispatch({
            total: 4,
            rows: [contactRow(4), contactRow(3), contactRow(2), contactRow(1)],
        });
        const page = await contactsService.listContacts({
            companyId: COMPANY,
            search: 'contact',
            limit: 3,
            offset: 0,
        });

        expect(page.results).toHaveLength(3);
        expect(page.pagination).toMatchObject({
            mode: 'offset',
            offset: 0,
            limit: 3,
            total: 4,
            has_more: true,
            next_cursor: null,
        });
        expect(db.query.mock.calls[1][1].slice(-2)).toEqual([4, 0]);
    });
});
