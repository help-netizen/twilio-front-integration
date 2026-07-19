'use strict';

const COMPANY = '00000000-0000-0000-0000-00000000a101';

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    pool: { connect: jest.fn() },
}));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: jest.fn() }));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({ MAX_FILE_SIZE: 10 * 1024 * 1024 }));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/contactDedupeService', () => ({
    resolveContact: jest.fn(),
    createNewContactPublic: jest.fn(),
}));
jest.mock('../backend/src/services/contactAddressService', () => ({ resolveAddress: jest.fn() }));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(),
    actorName: () => 'List Tester',
}));
jest.mock('../backend/src/services/pushService', () => ({ sendPushToCompany: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(() => Promise.resolve()) }));

const express = require('express');
const request = require('supertest');
const db = require('../backend/src/db/connection');
const leadsService = require('../backend/src/services/leadsService');
const leadsRouter = require('../backend/src/routes/leads');

const CURSOR_TS = '2026-07-18T12:00:00.123456Z';

function leadRow(id, overrides = {}) {
    return {
        id,
        uuid: `L${String(id).padStart(5, '0')}`,
        serial_id: id,
        company_id: COMPANY,
        status: 'Submitted',
        created_at: new Date('2026-07-18T12:00:00.123Z'),
        metadata: {},
        __cursor_value: CURSOR_TS,
        __cursor_id: String(id),
        ...overrides,
    };
}

function useListDispatch({ total = 0, rows = [], teams = [] } = {}) {
    db.query.mockImplementation(async (sql) => {
        if (/SELECT COUNT\(\*\)::int AS total FROM leads l/i.test(sql)) {
            return { rows: [{ total }] };
        }
        if (/FROM lead_team_assignments lta/i.test(sql)) return { rows: teams };
        if (/FROM leads l/i.test(sql)) return { rows };
        throw new Error(`Unexpected Lead list SQL: ${sql}`);
    });
}

function appFor(companyId = COMPANY) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'user-1', crmUser: { id: 'crm-1' } };
        req.authz = {
            scope: 'tenant',
            permissions: ['leads.view'],
            company: { id: companyId || COMPANY, status: 'active' },
        };
        if (companyId) req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', leadsRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    useListDispatch();
});

describe('Leads tenant and request contract', () => {
    test('route fails closed without company context before invoking the service or SQL', async () => {
        const listSpy = jest.spyOn(leadsService, 'listLeads');

        const response = await request(appFor(null)).get('/');

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(listSpy).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
        listSpy.mockRestore();
    });

    test('service fails closed without company context before SQL', async () => {
        await expect(leadsService.listLeads()).rejects.toMatchObject({
            code: 'TENANT_CONTEXT_REQUIRED',
            httpStatus: 403,
        });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('route forwards complete server controls and returns the additive cursor envelope', async () => {
        const response = await request(appFor()).get('/')
            .query({
                search: 'boiler',
                source: ['Rely', 'Website'],
                job_type: ['Repair', 'Install'],
                rejected_only: 'true',
                status: ['Review', 'Submitted'],
                sort_by: 'JobSource',
                sort_order: 'asc',
                limit: '50',
            });

        expect(response.status).toBe(200);
        expect(response.body.data.pagination).toEqual({
            mode: 'cursor',
            offset: 0,
            records: 50,
            limit: 50,
            returned: 0,
            has_more: false,
            next_cursor: null,
            total: 0,
        });
        expect(response.body.data.filters).toMatchObject({
            search: 'boiler',
            source: ['Rely', 'Website'],
            job_type: ['Repair', 'Install'],
            rejected_only: true,
            sort_by: 'JobSource',
            sort_order: 'asc',
        });
    });

    test('invalid sort and cursor-plus-offset requests are 400 with zero SQL', async () => {
        const invalidSort = await request(appFor()).get('/').query({ sort_by: 'DROP TABLE leads' });
        expect(invalidSort.status).toBe(400);
        expect(invalidSort.body.error.code).toBe('INVALID_QUERY');
        expect(db.query).not.toHaveBeenCalled();

        const mixed = await request(appFor()).get('/').query({ cursor: 'opaque', offset: '0' });
        expect(mixed.status).toBe(400);
        expect(mixed.body.error.code).toBe('INVALID_CURSOR_REQUEST');
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('Leads complete predicates, ordering, and totals', () => {
    test('all existing controls constrain both count and rows, including company-scoped custom search', async () => {
        await leadsService.listLeads({
            companyId: COMPANY,
            start_date: '2026-07-01',
            end_date: '2026-07-18',
            only_open: true,
            status: ['Submitted', 'Review'],
            search: 'Boiler',
            source: ['Website', 'Rely'],
            job_type: ['Repair', 'Install'],
            rejected_only: true,
            sort_by: 'CreatedDate',
            sort_order: 'desc',
            limit: 100,
        });

        const [countSql, countParams] = db.query.mock.calls[0];
        const [pageSql, pageParams] = db.query.mock.calls[1];
        for (const sql of [countSql, pageSql]) {
            expect(sql).toMatch(/l\.company_id = \$1/);
            expect(sql).toMatch(/l\.status NOT IN \('Lost', 'Converted'\)/);
            expect(sql).toMatch(/l\.created_at >= \$2::date/);
            expect(sql).toMatch(/l\.created_at < \(\$3::date \+ interval '1 day'\)/);
            expect(sql).toMatch(/l\.status = ANY\(\$4::text\[\]\)/);
            expect(sql).toMatch(/lcf\.company_id = l\.company_id/);
            expect(sql).toMatch(/lcf\.is_searchable = true/);
            expect(sql).toMatch(/lcf\.is_system = false/);
            expect(sql).toMatch(/l\.job_source = ANY\(\$6::text\[\]\)/);
            expect(sql).toMatch(/l\.job_type = ANY\(\$7::text\[\]\)/);
            expect(sql).toContain(`l.metadata @> '{"rely_filter":{"rejected":true}}'::jsonb`);
        }
        expect(countParams).toEqual([
            COMPANY,
            '2026-07-01',
            '2026-07-18',
            ['Review', 'Submitted'],
            '%Boiler%',
            ['Rely', 'Website'],
            ['Install', 'Repair'],
        ]);
        expect(pageParams.slice(0, -1)).toEqual(countParams);
        expect(pageParams.at(-1)).toBe(101);
    });

    test.each([
        ['Status', /LOWER\(COALESCE\(l\.status, ''\)\) COLLATE "C" ASC, l\.id ASC/],
        ['FirstName', /LOWER\(COALESCE\(l\.first_name, ''\)\) COLLATE "C" ASC, l\.id ASC/],
        ['Phone', /LOWER\(COALESCE\(l\.phone, ''\)\) COLLATE "C" ASC, l\.id ASC/],
        ['Email', /LOWER\(COALESCE\(l\.email, ''\)\) COLLATE "C" ASC, l\.id ASC/],
        ['City', /LOWER\(COALESCE\(l\.city, ''\)\) COLLATE "C" ASC, l\.id ASC/],
        ['JobType', /LOWER\(COALESCE\(l\.job_type, ''\)\) COLLATE "C" ASC, l\.id ASC/],
        ['JobSource', /LOWER\(COALESCE\(l\.job_source, ''\)\) COLLATE "C" ASC, l\.id ASC/],
        ['CreatedDate', /l\.created_at ASC, l\.id ASC/],
        ['SerialId', /l\.serial_id ASC, l\.id ASC/],
    ])('%s uses a closed server expression and ID tiebreaker', async (sortBy, orderPattern) => {
        await leadsService.listLeads({
            companyId: COMPANY,
            sort_by: sortBy,
            sort_order: 'asc',
        });

        const [pageSql] = db.query.mock.calls[1];
        expect(pageSql).toMatch(orderPattern);
    });

    test('Lead-team hydration is page-limited and independently company-scoped', async () => {
        useListDispatch({
            total: 1,
            rows: [leadRow(12)],
            teams: [{ lead_id: '12', team: [{ id: 4, name: 'A Tech' }] }],
        });

        const result = await leadsService.listLeads({ companyId: COMPANY });

        expect(result.results[0].Team).toEqual([{ id: 4, name: 'A Tech' }]);
        const [teamSql, teamParams] = db.query.mock.calls[2];
        expect(teamSql).toMatch(/lta\.company_id = \$1/);
        expect(teamSql).toMatch(/lta\.lead_id = ANY\(\$2::bigint\[\]\)/);
        expect(teamParams).toEqual([COMPANY, ['12']]);
    });
});

describe('Leads cursor boundaries', () => {
    test('SAB-LEADS-EXACT-BOUNDARY: exactly 100 matches end without a false has_more or cursor', async () => {
        const rows = Array.from({ length: 100 }, (_unused, index) => leadRow(100 - index));
        useListDispatch({ total: 100, rows });

        const page = await leadsService.listLeads({ companyId: COMPANY, limit: 100 });

        expect(page.results).toHaveLength(100);
        expect(page.pagination).toMatchObject({
            total: 100,
            returned: 100,
            has_more: false,
            next_cursor: null,
        });
        expect(db.query.mock.calls[1][1].at(-1)).toBe(101);
    });

    test('101 equal timestamps return 100 then one, tie by ID, and suppress continuation count', async () => {
        const probe = Array.from({ length: 101 }, (_unused, index) => leadRow(200 - index));
        useListDispatch({ total: 101, rows: probe });

        const first = await leadsService.listLeads({ companyId: COMPANY, limit: 100 });

        expect(first.results.map(lead => lead.ClientId)).toEqual(
            Array.from({ length: 100 }, (_unused, index) => 200 - index),
        );
        expect(first.pagination).toMatchObject({ total: 101, has_more: true });
        expect(first.pagination.next_cursor).toEqual(expect.any(String));

        jest.clearAllMocks();
        useListDispatch({ rows: [leadRow(100)] });
        const second = await leadsService.listLeads({
            companyId: COMPANY,
            limit: 100,
            cursor: first.pagination.next_cursor,
        });

        expect(second.results.map(lead => lead.ClientId)).toEqual([100]);
        expect(second.pagination).toMatchObject({ total: null, has_more: false, next_cursor: null });
        expect(db.query.mock.calls.some(([sql]) => /COUNT\(\*\)/i.test(sql))).toBe(false);
        const [pageSql, pageParams] = db.query.mock.calls[0];
        expect(pageSql).toMatch(/l\.created_at < \$2::timestamptz/);
        expect(pageSql).toMatch(/l\.created_at IS NOT DISTINCT FROM \$2::timestamptz AND l\.id < \$3::bigint/);
        expect(pageParams.slice(0, 3)).toEqual([COMPANY, CURSOR_TS, '101']);
    });

    test('cursor fingerprints reject filter or tenant reuse before SQL', async () => {
        useListDispatch({ total: 101, rows: Array.from({ length: 101 }, (_unused, index) => leadRow(200 - index)) });
        const first = await leadsService.listLeads({ companyId: COMPANY, limit: 100, search: 'boiler' });

        jest.clearAllMocks();
        await expect(leadsService.listLeads({
            companyId: COMPANY,
            limit: 100,
            search: 'furnace',
            cursor: first.pagination.next_cursor,
        })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('legacy offset mode remains additive and also uses a limit+1 probe', async () => {
        useListDispatch({ total: 101, rows: [leadRow(10), leadRow(9), leadRow(8)] });

        const page = await leadsService.listLeads({
            companyId: COMPANY,
            records: 2,
            offset: 4,
        });

        expect(page.results).toHaveLength(2);
        expect(page.pagination).toMatchObject({
            mode: 'offset',
            offset: 4,
            records: 2,
            has_more: true,
            next_cursor: null,
            total: 101,
        });
        const pageParams = db.query.mock.calls[1][1];
        expect(pageParams.slice(-2)).toEqual([3, 4]);
    });
});
