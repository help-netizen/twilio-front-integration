'use strict';

const COMPANY = '00000000-0000-0000-0000-00000000b101';
const PROVIDER_USER = '00000000-0000-0000-0000-00000000b102';
const CURSOR_TS = '2026-07-18T15:00:00.654321Z';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(),
    actorName: () => 'Jobs Tester',
    getEntityHistory: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1024,
    MAX_FILES_PER_NOTE: 5,
    getAttachmentsForEntity: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/conversationsService', () => ({}));
jest.mock('../backend/src/services/routeDistanceService', () => ({}));
jest.mock('../backend/src/services/googlePlacesService', () => ({}));
jest.mock('../backend/src/services/emailService', () => ({}));
jest.mock('../backend/src/services/rateMeService', () => ({}));
jest.mock('../backend/src/db/companyQueries', () => ({}));
jest.mock('../backend/src/db/rateMeQueries', () => ({}));
jest.mock('../backend/src/services/messagingHelper', () => ({ resolveCompanyProxyE164: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const express = require('express');
const request = require('supertest');
const db = require('../backend/src/db/connection');
const jobsService = require('../backend/src/services/jobsService');
const jobsRouter = require('../backend/src/routes/jobs');

function jobRow(id, overrides = {}) {
    return {
        id,
        company_id: COMPANY,
        blanc_status: 'Submitted',
        zb_status: 'scheduled',
        zb_rescheduled: false,
        zb_canceled: false,
        assigned_techs: [],
        assigned_provider_user_ids: [],
        notes: [],
        metadata: {},
        start_date: new Date('2026-07-18T15:00:00.654Z'),
        end_date: null,
        created_at: new Date('2026-07-18T12:00:00.000Z'),
        updated_at: new Date('2026-07-18T12:00:00.000Z'),
        __cursor_null: false,
        __cursor_value: CURSOR_TS,
        __cursor_id: String(id),
        ...overrides,
    };
}

function useListDispatch({
    total = 0,
    providers = [],
    rows = [],
    tags = [],
    payments = [],
    metaFieldExists = true,
} = {}) {
    db.query.mockImplementation(async (sql) => {
        if (/SELECT 1\s+FROM lead_custom_fields\s+WHERE company_id = \$1/i.test(sql)) {
            return { rows: metaFieldExists ? [{ '?column?': 1 }] : [] };
        }
        if (/\(SELECT COUNT\(\*\)::int FROM jobs j/i.test(sql)) {
            return { rows: [{ total, providers }] };
        }
        if (/SELECT j\.\*,[\s\S]*FROM jobs j/i.test(sql)) return { rows };
        if (/FROM job_tag_assignments jta[\s\S]*scoped_job/i.test(sql)) return { rows: tags };
        if (/WITH\s+(?:invoice_rollup|original_payments)\s+AS/i.test(sql)) return { rows: payments };
        throw new Error(`Unexpected Jobs list SQL: ${sql}`);
    });
}

function appFor(companyId = COMPANY) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'user-1', crmUser: { id: PROVIDER_USER } };
        req.authz = {
            scope: 'tenant',
            permissions: ['jobs.view'],
            scopes: { job_visibility: 'all' },
            membership: { role_key: 'tenant_admin' },
        };
        if (companyId) req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', jobsRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    useListDispatch();
});

describe('Jobs fail-closed tenant and route contract', () => {
    test('route requires company context before invoking listJobs or SQL', async () => {
        const listSpy = jest.spyOn(jobsService, 'listJobs');

        const response = await request(appFor(null)).get('/');

        expect(response.status).toBe(403);
        expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(listSpy).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
        listSpy.mockRestore();
    });

    test('picker route also requires company context before service or SQL', async () => {
        const pickerSpy = jest.spyOn(jobsService, 'searchJobsForPicker');

        const response = await request(appFor(null)).get('/picker?search=repair');

        expect(response.status).toBe(403);
        expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(pickerSpy).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
        pickerSpy.mockRestore();
    });

    test.each([
        ['/:id', '/123', 'getJobById'],
        ['/by-code/:code', '/by-code/aB3xZ', 'getJobByCode'],
    ])('%s requires company context before resolving a job', async (_label, path, resolverName) => {
        const resolver = jest.spyOn(jobsService, resolverName);

        const response = await request(appFor(null)).get(path);

        expect(response.status).toBe(403);
        expect(response.body.code).toBe('TENANT_CONTEXT_REQUIRED');
        expect(resolver).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
        resolver.mockRestore();
    });

    test('service requires company context before SQL', async () => {
        await expect(jobsService.listJobs()).rejects.toMatchObject({
            code: 'TENANT_CONTEXT_REQUIRED',
            statusCode: 403,
        });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('route uses the one start_date default and forwards job_source into cursor mode', async () => {
        const response = await request(appFor()).get('/').query({
            job_source: 'Rely,Website',
            limit: '50',
        });

        expect(response.status).toBe(200);
        expect(response.body.data.pagination).toMatchObject({
            mode: 'cursor',
            limit: 50,
            returned: 0,
            total: 0,
        });
        const dataSql = db.query.mock.calls[1][0];
        expect(dataSql).toMatch(/j\.job_source = ANY\(\$2::text\[\]\)/);
        expect(dataSql).toMatch(/ORDER BY \(j\.start_date IS NULL\) ASC, j\.start_date DESC, j\.id DESC/);
    });

    test('invalid sort and cursor-plus-offset are typed 400s with zero SQL', async () => {
        const badSort = await request(appFor()).get('/').query({ sort_by: 'drop;table' });
        expect(badSort.status).toBe(400);
        expect(badSort.body.code).toBe('INVALID_QUERY');
        expect(db.query).not.toHaveBeenCalled();

        const mixed = await request(appFor()).get('/').query({ cursor: 'opaque', offset: '0' });
        expect(mixed.status).toBe(400);
        expect(mixed.body.code).toBe('INVALID_CURSOR_REQUEST');
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('Job picker projection', () => {
    test('service requires company context and rejects unbounded input before SQL', async () => {
        await expect(jobsService.searchJobsForPicker({ search: 'repair' }))
            .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED', statusCode: 403 });
        await expect(jobsService.searchJobsForPicker({
            companyId: COMPANY,
            search: 'x'.repeat(201),
        })).rejects.toMatchObject({ code: 'INVALID_QUERY', statusCode: 400 });
        await expect(jobsService.searchJobsForPicker({
            companyId: COMPANY,
            limit: 51,
        })).rejects.toMatchObject({ code: 'INVALID_QUERY', statusCode: 400 });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('one company-scoped query searches identifiers, customer, address, and service with a narrow shape', async () => {
        db.query.mockResolvedValueOnce({ rows: [{
            id: 71,
            job_number: 'J-71',
            job_seq: 171,
            customer_name: 'Jane Customer',
            address: '71 Main St',
            service_name: 'Repair',
            start_date: new Date('2026-07-18T15:00:00.000Z'),
            blanc_status: 'Submitted',
            company_id: 'must-not-leak',
            metadata: { must_not: 'leak' },
        }] });

        const result = await jobsService.searchJobsForPicker({
            companyId: COMPANY,
            search: 'Jane',
            limit: 12,
            providerScope: { assignedOnly: true, userId: PROVIDER_USER },
        });

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('j.company_id = $1');
        expect(sql).toContain('j.assigned_provider_user_ids @> $2::jsonb');
        expect(sql).toContain('j.job_number ILIKE $3');
        expect(sql).toContain('j.public_code ILIKE $3');
        expect(sql).toContain('j.job_seq');
        expect(sql).toContain("COALESCE(NULLIF(c.full_name, ''), NULLIF(j.customer_name, '')) ILIKE $3");
        expect(sql).toContain("COALESCE(j.address, '') ILIKE $3");
        expect(sql).toContain("COALESCE(j.service_name, '') ILIKE $3");
        expect(sql).toContain('c.company_id = j.company_id');
        expect(sql).not.toContain('SELECT j.*');
        expect(sql).not.toMatch(/COUNT\(|job_tag_assignments|invoice_rollup/);
        expect(params).toEqual([
            COMPANY,
            JSON.stringify([PROVIDER_USER]),
            '%Jane%',
            'Jane',
            12,
        ]);
        expect(result).toEqual({ results: [{
            id: 71,
            job_number: 'J-71',
            job_seq: 171,
            customer_name: 'Jane Customer',
            address: '71 Main St',
            service_name: 'Repair',
            start_date: '2026-07-18T15:00:00.000Z',
            status: 'Submitted',
        }] });
    });

    test('numeric picker search matches job_seq exactly while public codes stay fuzzy-searchable', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await jobsService.searchJobsForPicker({
            companyId: COMPANY,
            search: '171',
            limit: 12,
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('j.job_number ILIKE $2');
        expect(sql).toContain('j.public_code ILIKE $2');
        expect(sql).toContain('j.job_seq::text = $3');
        expect(params).toEqual([COMPANY, '%171%', '171', '171', 12]);
    });

    test('assigned-only without a resolved crm user fails closed to zero rows', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await jobsService.searchJobsForPicker({
            companyId: COMPANY,
            providerScope: { assignedOnly: true, userId: null },
        });

        expect(db.query.mock.calls[0][0]).toContain('WHERE j.company_id = $1 AND FALSE');
        expect(db.query.mock.calls[0][1]).toEqual([COMPANY, 20]);
    });
});

describe('Jobs complete predicates, security, and facets', () => {
    test.each([
        ['customer_email', "LOWER(COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, ''), ''))"],
        ['customer_phone', "LOWER(COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, ''), ''))"],
    ])('list projection and %s sort use the live contact with the job snapshot fallback', async (sortBy, sortExpression) => {
        await jobsService.listJobs({ companyId: COMPANY, sortBy });

        const dataSql = db.query.mock.calls[1][0];
        expect(dataSql).toContain("COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS customer_phone");
        expect(dataSql).toContain("COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS customer_email");
        expect(dataSql).toContain(sortExpression);
        expect(dataSql).toContain('LEFT JOIN contacts c ON c.id = j.contact_id AND c.company_id = j.company_id');
    });

    test('SAB-JOBS-CUSTOM-FIELD-TENANT: search uses one correlated, company-scoped custom-field predicate', async () => {
        await jobsService.listJobs({ companyId: COMPANY, search: 'secret-value' });

        expect(db.query).toHaveBeenCalledTimes(2);
        for (const [sql, params] of db.query.mock.calls) {
            expect(sql).toMatch(/j\.company_id = \$1/);
            expect(sql).toMatch(/lcf\.company_id = j\.company_id/);
            expect(sql).toMatch(/lcf\.is_searchable = true/);
            expect(sql).toMatch(/lcf\.is_system = false/);
            expect(sql).toMatch(/COALESCE\(j\.metadata ->> lcf\.api_name, ''\) ILIKE \$2/);
            expect(params.slice(0, 2)).toEqual([COMPANY, '%secret-value%']);
        }
        expect(db.query.mock.calls.some(([sql]) => /SELECT api_name FROM lead_custom_fields/i.test(sql))).toBe(false);
    });

    test('numeric list search matches job_seq exactly and public_code fuzzily', async () => {
        await jobsService.listJobs({ companyId: COMPANY, search: '171' });

        expect(db.query).toHaveBeenCalledTimes(2);
        for (const [sql, params] of db.query.mock.calls) {
            expect(sql).toContain('j.job_number ILIKE $2');
            expect(sql).toContain('j.public_code ILIKE $2');
            expect(sql).toContain('j.job_seq::text = $3');
            expect(params.slice(0, 3)).toEqual([COMPANY, '%171%', '171']);
        }
    });

    test('row total and provider facet share all predicates except the exact selected provider', async () => {
        useListDispatch({ total: 4, providers: ['Alex', 'Alexandra', 'Sam'] });

        const result = await jobsService.listJobs({
            companyId: COMPANY,
            providerScope: { assignedOnly: true, userId: PROVIDER_USER },
            blancStatus: 'Submitted,Rescheduled',
            zbCanceled: 'false',
            search: 'repair',
            onlyOpen: true,
            startDate: '2026-07-01',
            endDate: '2026-07-18',
            serviceName: 'Install,Repair',
            jobSource: 'Rely,Website',
            provider: 'Alex',
            tagIds: '7,8',
            tagMatch: 'all',
        });

        const [metadataSql, metadataParams] = db.query.mock.calls[0];
        expect(metadataSql).toMatch(/j\.assigned_provider_user_ids @> \$2::jsonb/);
        expect(metadataSql.match(/j\.assigned_provider_user_ids @>/g)).toHaveLength(2);
        expect(metadataSql).toMatch(/j\.job_source = ANY\(\$9::text\[\]\)/);
        expect(metadataSql).toMatch(/jta3\.tag_id = ANY\(\$10::int\[\]\)/);
        expect(metadataSql).toMatch(/BTRIM\(tech\.value ->> 'name'\) = ANY\(\$12::text\[\]\)/);
        expect(metadataSql.match(/= ANY\(\$12::text\[\]\)/g)).toHaveLength(1);
        expect(metadataSql).not.toMatch(/assigned_techs::text ILIKE/);
        expect(metadataParams[0]).toBe(COMPANY);
        expect(metadataParams[1]).toBe(JSON.stringify([PROVIDER_USER]));
        expect(metadataParams.at(-1)).toEqual(['Alex']);
        expect(result.total).toBe(4);
        expect(result.facets).toEqual({ providers: ['Alex', 'Alexandra', 'Sam'] });
    });

    test('page tag hydration joins back to company-scoped Jobs and only sees returned IDs', async () => {
        const rows = Array.from({ length: 3 }, (_unused, index) => jobRow(10 - index));
        useListDispatch({ total: 3, rows });

        await jobsService.listJobs({ companyId: COMPANY, limit: 2 });

        const [tagSql, tagParams] = db.query.mock.calls[2];
        expect(tagSql).toMatch(/JOIN jobs scoped_job ON scoped_job\.id = jta\.job_id AND scoped_job\.company_id = \$2/);
        expect(tagParams).toEqual([[10, 9], COMPANY]);
        expect(db.query.mock.calls[3][1]).toEqual([COMPANY, [10, 9]]);
    });
});

describe('Jobs sort and cursor contract', () => {
    test.each([
        'job_number', 'customer_name', 'customer_phone', 'customer_email', 'service_name',
        'start_date', 'end_date', 'blanc_status', 'zb_status', 'address', 'territory',
        'invoice_total', 'invoice_status', 'job_type', 'job_source', 'description',
        'created_at', 'updated_at',
    ])('%s is closed and always ties by ID', async (sortBy) => {
        await jobsService.listJobs({ companyId: COMPANY, sortBy, sortOrder: 'asc' });

        const dataSql = db.query.mock.calls[1][0];
        expect(dataSql).toMatch(/ORDER BY[\s\S]*j\.id ASC/);
        expect(dataSql).not.toContain(sortBy === 'invoice_total' ? '__never__' : `meta:${sortBy}`);
    });

    test('metadata sorts require a current-company catalog row and bind the JSON key', async () => {
        await jobsService.listJobs({
            companyId: COMPANY,
            sortBy: 'meta:equipment_model',
            sortOrder: 'asc',
        });

        expect(db.query.mock.calls[0]).toEqual([
            expect.stringMatching(/WHERE company_id = \$1 AND api_name = \$2 AND is_system = false/),
            [COMPANY, 'equipment_model'],
        ]);
        const [dataSql, dataParams] = db.query.mock.calls[2];
        expect(dataSql).toMatch(/j\.metadata ->> \$2/);
        expect(dataSql).not.toContain("metadata ->> 'equipment_model'");
        expect(dataParams).toEqual([COMPANY, 'equipment_model', 51]);

        jest.clearAllMocks();
        useListDispatch({ metaFieldExists: false });
        await expect(jobsService.listJobs({
            companyId: COMPANY,
            sortBy: 'meta:foreign_field',
        })).rejects.toMatchObject({ code: 'INVALID_QUERY', statusCode: 400 });
        expect(db.query).toHaveBeenCalledTimes(1);
        expect(db.query.mock.calls[0][1]).toEqual([COMPANY, 'foreign_field']);
    });

    test('default nullable timestamp cursor returns 50 then one without count/facet on continuation', async () => {
        const probeRows = Array.from({ length: 51 }, (_unused, index) => jobRow(100 - index));
        useListDispatch({ total: 51, providers: ['Alex'], rows: probeRows });

        const first = await jobsService.listJobs({ companyId: COMPANY, limit: 50 });

        expect(first.results).toHaveLength(50);
        expect(first.pagination).toMatchObject({ total: 51, has_more: true });
        expect(first.pagination.next_cursor).toEqual(expect.any(String));

        jest.clearAllMocks();
        useListDispatch({ rows: [jobRow(50)] });
        const second = await jobsService.listJobs({
            companyId: COMPANY,
            limit: 50,
            cursor: first.pagination.next_cursor,
        });

        expect(second.results.map(job => job.id)).toEqual([50]);
        expect(second.facets).toBeNull();
        expect(second.pagination).toMatchObject({ total: null, has_more: false, next_cursor: null });
        expect(db.query.mock.calls.some(([sql]) => /COUNT\(\*\)/.test(sql))).toBe(false);
        const [pageSql, pageParams] = db.query.mock.calls[0];
        expect(pageSql).toMatch(/\(j\.start_date IS NULL\) > \$2::boolean/);
        expect(pageSql).toMatch(/j\.start_date IS NOT DISTINCT FROM \$3::timestamptz AND j\.id < \$4::bigint/);
        expect(pageParams.slice(0, 4)).toEqual([COMPANY, false, CURSOR_TS, '51']);
    });

    test('filter or visibility changes reject a saved cursor before SQL', async () => {
        useListDispatch({ total: 51, rows: Array.from({ length: 51 }, (_unused, index) => jobRow(100 - index)) });
        const first = await jobsService.listJobs({ companyId: COMPANY, limit: 50, search: 'repair' });

        jest.clearAllMocks();
        await expect(jobsService.listJobs({
            companyId: COMPANY,
            limit: 50,
            search: 'install',
            cursor: first.pagination.next_cursor,
        })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
        expect(db.query).not.toHaveBeenCalled();
    });
});
