'use strict';

const PROD_COPY_URL = process.env.LIST_PAGINATION_PRODCOPY_URL || '';
if (PROD_COPY_URL) process.env.DATABASE_URL = PROD_COPY_URL;

jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn() }));

const db = require('../backend/src/db/connection');
const leadsService = require('../backend/src/services/leadsService');
const jobsService = require('../backend/src/services/jobsService');
const tasksQueries = require('../backend/src/db/tasksQueries');
const contactsService = require('../backend/src/services/contactsService');
const paymentsService = require('../backend/src/services/zenbookerPaymentsSyncService');

jest.setTimeout(300000);

const originalQuery = db.query;
let activeCapture = null;

function isExplainable(sql) {
    return typeof sql === 'string' && /^\s*(SELECT|WITH)\b/i.test(sql);
}

function planRoot(result) {
    const value = result.rows[0]?.['QUERY PLAN'];
    if (!Array.isArray(value) || !value[0]) throw new Error('EXPLAIN did not return FORMAT JSON');
    return value[0];
}

db.query = async (sql, params) => {
    if (activeCapture && isExplainable(sql)) {
        const plans = [];
        for (let run = 0; run < 3; run++) {
            const explained = await originalQuery(
                `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) ${sql}`,
                params,
            );
            plans.push(planRoot(explained));
        }
        activeCapture.statements.push({ sql, plans });
    }
    return originalQuery(sql, params);
};

function walkPlan(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const child of node.Plans || []) walkPlan(child, visit);
}

function warmPlans(statement) {
    return statement.plans.slice(1);
}

function isMetadataSql(sql) {
    return /COUNT\(\*\)|json_agg\(|WITH\s+base_rows\s+AS|\baggregate\s+AS/i.test(sql);
}

function assertHealthyCapture(capture) {
    expect(capture.statements.length).toBeGreaterThan(0);
    const summaries = [];

    for (const statement of capture.statements) {
        const thresholdMs = isMetadataSql(statement.sql) ? 250 : 100;
        for (const plan of warmPlans(statement)) {
            expect(Number(plan['Execution Time'])).toBeLessThanOrEqual(thresholdMs);
            walkPlan(plan.Plan, node => {
                expect(Number(node['Temp Read Blocks'] || 0)).toBe(0);
                expect(Number(node['Temp Written Blocks'] || 0)).toBe(0);
                expect(node['Sort Space Type']).not.toBe('Disk');

                if (node['Node Type'] === 'Seq Scan') {
                    const returned = Number(node['Actual Rows'] || 0) * Number(node['Actual Loops'] || 1);
                    const removed = Number(node['Rows Removed by Filter'] || 0) * Number(node['Actual Loops'] || 1);
                    expect(removed).not.toBeGreaterThan(Math.max(returned * 10, 1000));
                }
            });
        }

        const warmTimes = warmPlans(statement).map(plan => Number(plan['Execution Time']));
        const serialized = JSON.stringify(warmPlans(statement));
        const indexes = [...serialized.matchAll(/"Index Name":"([^"]+)"/g)].map(match => match[1]);
        summaries.push({
            kind: isMetadataSql(statement.sql) ? 'metadata' : 'row',
            warm_ms: warmTimes,
            indexes: [...new Set(indexes)],
        });
    }

    console.info(`[LIST-PAGINATION-PLANS] ${capture.label}`, summaries);
}

async function capture(label, operation) {
    const record = { label, statements: [] };
    activeCapture = record;
    try {
        const value = await operation();
        assertHealthyCapture(record);
        return { value, record };
    } finally {
        activeCapture = null;
    }
}

function expectIndex(record, indexName) {
    const serialized = JSON.stringify(record.statements.flatMap(statement => warmPlans(statement)));
    expect(serialized).toContain(`"Index Name":"${indexName}"`);
}

function expectNoMetadata(record, pattern) {
    expect(record.statements.some(statement => pattern.test(statement.sql))).toBe(false);
}

function requireCursor(page, label) {
    if (!page.pagination?.next_cursor) {
        throw new Error(`${label} needs a representative tenant with more than one real page`);
    }
    return page.pagination.next_cursor;
}

async function representativeCompany(table, where = 'TRUE') {
    const allowed = new Set(['leads', 'jobs', 'tasks', 'contacts', 'zb_payments']);
    if (!allowed.has(table)) throw new Error(`Unsupported discovery table: ${table}`);
    const result = await originalQuery(
        `SELECT company_id, COUNT(*)::int AS count
         FROM ${table}
         WHERE company_id IS NOT NULL AND ${where}
         GROUP BY company_id
         ORDER BY count DESC
         LIMIT 1`,
    );
    if (!result.rows[0]?.company_id) throw new Error(`No representative company for ${table}`);
    return result.rows[0].company_id;
}

function dateOnly(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid representative date: ${value}`);
    return date.toISOString().slice(0, 10);
}

function daysBefore(value, days) {
    const date = value instanceof Date ? new Date(value) : new Date(value);
    date.setUTCDate(date.getUTCDate() - days);
    return dateOnly(date);
}

async function dateBounds(table, column, companyId) {
    const allowed = {
        leads: 'created_at',
        jobs: 'start_date',
        zb_payments: 'payment_date',
    };
    if (allowed[table] !== column) throw new Error('Unsupported date-bound discovery');
    const result = await originalQuery(
        `SELECT MIN(${column}) AS min_value, MAX(${column}) AS max_value
         FROM ${table}
         WHERE company_id = $1 AND ${column} IS NOT NULL`,
        [companyId],
    );
    if (!result.rows[0]?.max_value) throw new Error(`No representative dates for ${table}`);
    return result.rows[0];
}

if (!PROD_COPY_URL) {
    console.warn('LIST-PAGINATION-UNIFY-001 plan gate SKIPPED-NEEDS-LIST_PAGINATION_PRODCOPY_URL');
}

const describeDb = PROD_COPY_URL ? describe : describe.skip;

describeDb('LIST-PAGINATION-UNIFY-001 production-copy EXPLAIN gate', () => {
    beforeAll(async () => {
        const settings = await originalQuery(
            `SELECT current_setting('default_transaction_read_only') AS read_only,
                    current_setting('statement_timeout') AS statement_timeout`,
        );
        expect(settings.rows[0]?.read_only).toBe('on');
        expect(settings.rows[0]?.statement_timeout).toMatch(/^(5000ms|5s)$/);
    });

    afterAll(async () => {
        db.query = originalQuery;
        await db.pool.end();
    });

    test('Leads: default pages, metadata, full predicates/search, and alternate sorts', async () => {
        const companyId = await representativeCompany('leads');
        const bounds = await dateBounds('leads', 'created_at', companyId);
        const endDate = dateOnly(bounds.max_value);
        const startDate = daysBefore(bounds.max_value, 29);
        const common = await originalQuery(
            `SELECT status, job_source, job_type, first_name
             FROM leads
             WHERE company_id = $1 AND created_at >= $2::date
             ORDER BY created_at DESC LIMIT 1`,
            [companyId, startDate],
        );
        const values = common.rows[0] || {};

        const first = await capture('leads/default-page-1', () => leadsService.listLeads({
            companyId,
            start_date: startDate,
            end_date: endDate,
            only_open: true,
            limit: 100,
        }));
        expectIndex(first.record, 'idx_lpu_leads_company_created_id');
        const cursor = requireCursor(first.value, 'Leads default');
        const second = await capture('leads/default-page-2', () => leadsService.listLeads({
            companyId,
            start_date: startDate,
            end_date: endDate,
            only_open: true,
            limit: 100,
            cursor,
        }));
        expectNoMetadata(second.record, /SELECT COUNT\(\*\)::int AS total FROM leads/i);

        await capture('leads/status-source-job-type-rejected', () => leadsService.listLeads({
            companyId,
            only_open: false,
            status: values.status ? [values.status] : [],
            source: values.job_source ? [values.job_source] : [],
            job_type: values.job_type ? [values.job_type] : [],
            rejected_only: true,
            limit: 100,
        }));

        const metadataSearch = await originalQuery(
            `SELECT l.metadata ->> lcf.api_name AS value
             FROM leads l
             JOIN lead_custom_fields lcf
               ON lcf.company_id = l.company_id
              AND lcf.is_searchable = true
              AND lcf.is_system = false
             WHERE l.company_id = $1
               AND NULLIF(l.metadata ->> lcf.api_name, '') IS NOT NULL
             LIMIT 1`,
            [companyId],
        );
        const searchValue = metadataSearch.rows[0]?.value;
        if (!searchValue) throw new Error('Leads search gate needs representative searchable custom metadata');
        await capture('leads/search', () => leadsService.listLeads({
            companyId,
            only_open: false,
            search: String(searchValue).slice(0, 80),
            limit: 100,
        }));
        await capture('leads/alternate-name-sort', () => leadsService.listLeads({
            companyId, only_open: false, sort_by: 'FirstName', sort_order: 'asc', limit: 100,
        }));
        await capture('leads/serial-id-sort', () => leadsService.listLeads({
            companyId, only_open: false, sort_by: 'SerialId', sort_order: 'desc', limit: 100,
        }));
    });

    test('Jobs: default/alternate pages, facets, scoped filters, searches, and metadata sort', async () => {
        const companyId = await representativeCompany('jobs');
        const representative = await originalQuery(
            `SELECT j.id, j.job_source, j.service_name, j.blanc_status, j.job_number,
                    NULLIF(BTRIM(tech.value ->> 'name'), '') AS provider,
                    NULLIF(user_id.value, '') AS provider_user_id,
                    tag_rows.tag_id
             FROM jobs j
             LEFT JOIN LATERAL jsonb_array_elements(COALESCE(j.assigned_techs, '[]'::jsonb)) tech(value) ON true
             LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(j.assigned_provider_user_ids, '[]'::jsonb)) user_id(value) ON true
             LEFT JOIN LATERAL (
                 SELECT jta.tag_id FROM job_tag_assignments jta WHERE jta.job_id = j.id LIMIT 1
             ) tag_rows ON true
             WHERE j.company_id = $1
             ORDER BY j.start_date DESC NULLS LAST
             LIMIT 1`,
            [companyId],
        );
        const values = representative.rows[0] || {};

        const first = await capture('jobs/default-page-1-and-facet', () => jobsService.listJobs({
            companyId, sortBy: 'start_date', sortOrder: 'desc', limit: 50,
        }));
        expectIndex(first.record, 'idx_lpu_jobs_company_start_id');
        const cursor = requireCursor(first.value, 'Jobs default');
        const second = await capture('jobs/default-page-2', () => jobsService.listJobs({
            companyId, sortBy: 'start_date', sortOrder: 'desc', limit: 50, cursor,
        }));
        expectNoMetadata(second.record, /AS total,\s*[\s\S]*AS providers/i);

        await capture('jobs/created-at-sort', () => jobsService.listJobs({
            companyId, sortBy: 'created_at', sortOrder: 'desc', limit: 50,
        }));
        await capture('jobs/source-provider-tag-full-scope', () => jobsService.listJobs({
            companyId,
            jobSource: values.job_source || undefined,
            provider: values.provider || undefined,
            tagIds: values.tag_id ? String(values.tag_id) : undefined,
            limit: 50,
        }));
        if (values.provider_user_id) {
            await capture('jobs/assigned-only-scope', () => jobsService.listJobs({
                companyId,
                providerScope: { assignedOnly: true, userId: values.provider_user_id },
                limit: 50,
            }));
        }
        if (values.job_number) {
            await capture('jobs/normal-search', () => jobsService.listJobs({
                companyId, search: String(values.job_number).slice(0, 80), limit: 50,
            }));
        }

        const custom = await originalQuery(
            `SELECT lcf.api_name, j.metadata ->> lcf.api_name AS value
             FROM jobs j
             JOIN lead_custom_fields lcf
               ON lcf.company_id = j.company_id
              AND lcf.is_system = false
              AND lcf.is_searchable = true
             WHERE j.company_id = $1
               AND NULLIF(j.metadata ->> lcf.api_name, '') IS NOT NULL
             LIMIT 1`,
            [companyId],
        );
        if (!custom.rows[0]?.api_name || !custom.rows[0]?.value) {
            throw new Error('Jobs plan gate needs representative searchable custom metadata');
        }
        await capture('jobs/custom-metadata-search', () => jobsService.listJobs({
            companyId, search: String(custom.rows[0].value).slice(0, 80), limit: 50,
        }));
        await capture('jobs/unindexed-text-sort', () => jobsService.listJobs({
            companyId, sortBy: 'customer_name', sortOrder: 'asc', limit: 50,
        }));
        await capture('jobs/metadata-sort', () => jobsService.listJobs({
            companyId, sortBy: `meta:${custom.rows[0].api_name}`, sortOrder: 'asc', limit: 50,
        }));
    });

    test('Tasks: manager/owner pages, count, parent/search predicates, and alternate sort', async () => {
        const companyId = await representativeCompany(
            'tasks',
            `(job_id IS NOT NULL OR lead_id IS NOT NULL OR estimate_id IS NOT NULL
              OR invoice_id IS NOT NULL OR contact_id IS NOT NULL OR thread_id IS NOT NULL)`,
        );
        const representative = await originalQuery(
            `SELECT t.owner_user_id, t.title, ow.full_name
             FROM tasks t
             LEFT JOIN crm_users ow ON ow.id = t.owner_user_id AND ow.company_id = t.company_id
             WHERE t.company_id = $1
               AND (t.job_id IS NOT NULL OR t.lead_id IS NOT NULL OR t.estimate_id IS NOT NULL
                    OR t.invoice_id IS NOT NULL OR t.contact_id IS NOT NULL OR t.thread_id IS NOT NULL)
             ORDER BY t.due_at ASC NULLS LAST
             LIMIT 1`,
            [companyId],
        );
        const values = representative.rows[0] || {};
        const ownerScope = await originalQuery(
            `SELECT owner_user_id, COUNT(*)::int AS count
             FROM tasks
             WHERE company_id = $1 AND status = 'open' AND owner_user_id IS NOT NULL
             GROUP BY owner_user_id
             ORDER BY count DESC
             LIMIT 1`,
            [companyId],
        );
        const ownerUserId = ownerScope.rows[0]?.owner_user_id;
        if (!ownerUserId) throw new Error('Tasks plan gate needs a representative owner scope');

        const first = await capture('tasks/manager-default-page-1', () => tasksQueries.listTasksPage(companyId, {
            status: 'open', sort_by: 'due_at', sort_order: 'asc', limit: 50,
        }));
        expectIndex(first.record, 'idx_lpu_tasks_company_status_due_created_id');
        const cursor = requireCursor(first.value, 'Tasks manager default');
        const second = await capture('tasks/manager-default-page-2', () => tasksQueries.listTasksPage(companyId, {
            status: 'open', sort_by: 'due_at', sort_order: 'asc', limit: 50, cursor,
        }));
        expectNoMetadata(second.record, /SELECT COUNT\(\*\)::int AS total/i);

        const ownerFirst = await capture('tasks/non-manager-owner-page-1', () => tasksQueries.listTasksPage(companyId, {
            status: 'open', scopeOwnerId: ownerUserId, limit: 50,
        }));
        const ownerCursor = requireCursor(ownerFirst.value, 'Tasks non-manager owner scope');
        const ownerSecond = await capture('tasks/non-manager-owner-page-2', () => tasksQueries.listTasksPage(companyId, {
            status: 'open', scopeOwnerId: ownerUserId, limit: 50, cursor: ownerCursor,
        }));
        expectNoMetadata(ownerSecond.record, /SELECT COUNT\(\*\)::int AS total/i);
        await capture('tasks/parent-type-filter', () => tasksQueries.listTasksPage(companyId, {
            status: 'open', parent_type: 'contact', limit: 50,
        }));
        const searchValue = values.full_name || values.title;
        if (searchValue) {
            await capture('tasks/parent-assignee-search', () => tasksQueries.listTasksPage(companyId, {
                status: 'open', search: String(searchValue).slice(0, 80), limit: 50,
            }));
        }
        await capture('tasks/parent-label-sort', () => tasksQueries.listTasksPage(companyId, {
            status: 'open', sort_by: 'parent_label', sort_order: 'asc', limit: 50,
        }));
    });

    test('Contacts: full/assigned default pages, count, common and rare search', async () => {
        const companyId = await representativeCompany('contacts');
        const representative = await originalQuery(
            `SELECT c.full_name
             FROM contacts c
             WHERE c.company_id = $1
             ORDER BY c.id DESC
             LIMIT 1`,
            [companyId],
        );
        const values = representative.rows[0] || {};
        const providerScope = await originalQuery(
            `SELECT provider_user.value AS provider_user_id, COUNT(DISTINCT j.contact_id)::int AS count
             FROM jobs j
             CROSS JOIN LATERAL jsonb_array_elements_text(
                 COALESCE(j.assigned_provider_user_ids, '[]'::jsonb)
             ) provider_user(value)
             WHERE j.company_id = $1 AND j.contact_id IS NOT NULL
             GROUP BY provider_user.value
             ORDER BY count DESC
             LIMIT 1`,
            [companyId],
        );
        const providerUserId = providerScope.rows[0]?.provider_user_id;
        if (!providerUserId) throw new Error('Contacts plan gate needs a representative assigned-only scope');

        const first = await capture('contacts/full-scope-page-1', () => contactsService.listContacts({
            companyId, limit: 50,
        }));
        expectIndex(first.record, 'idx_lpu_contacts_company_id');
        const cursor = requireCursor(first.value, 'Contacts default');
        const second = await capture('contacts/full-scope-page-2', () => contactsService.listContacts({
            companyId, limit: 50, cursor,
        }));
        expectNoMetadata(second.record, /SELECT COUNT\(\*\)::int AS total FROM contacts/i);

        const assignedFirst = await capture('contacts/assigned-only-page-1', () => contactsService.listContacts({
            companyId,
            providerScope: { assignedOnly: true, userId: providerUserId },
            limit: 50,
        }));
        const assignedCursor = requireCursor(assignedFirst.value, 'Contacts assigned-only scope');
        const assignedSecond = await capture('contacts/assigned-only-page-2', () => contactsService.listContacts({
            companyId,
            providerScope: { assignedOnly: true, userId: providerUserId },
            limit: 50,
            cursor: assignedCursor,
        }));
        expectNoMetadata(assignedSecond.record, /SELECT COUNT\(\*\)::int AS total FROM contacts/i);
        if (values.full_name) {
            await capture('contacts/common-search', () => contactsService.listContacts({
                companyId, search: String(values.full_name).slice(0, 50), limit: 50,
            }));
        }
        await capture('contacts/rare-search', () => contactsService.listContacts({
            companyId, search: '__lpu_intentionally_absent_search__', limit: 50,
        }));
    });

    test('Payments: default pages, all-match aggregate/facets, filters, and alternate sorts', async () => {
        const companyId = await representativeCompany('zb_payments');
        const bounds = await dateBounds('zb_payments', 'payment_date', companyId);
        const dateFrom = dateOnly(bounds.min_value);
        const dateTo = dateOnly(bounds.max_value);
        const representative = await originalQuery(
            `SELECT p.payment_methods, p.display_payment_method, p.client,
                    p.invoice_paid_in_full,
                    NULLIF(BTRIM(split_part(COALESCE(p.tech, ''), ',', 1)), '') AS provider
             FROM zb_payments p
             WHERE p.company_id = $1
             ORDER BY p.payment_date DESC NULLS LAST
             LIMIT 1`,
            [companyId],
        );
        const values = representative.rows[0] || {};

        const first = await capture('payments/default-page-1-aggregate-facets', () => paymentsService.listPayments(companyId, {
            dateFrom, dateTo, sortField: 'payment_date', sortDir: 'desc', limit: 50,
        }));
        expectIndex(first.record, 'idx_lpu_zb_payments_company_date_id');
        const cursor = requireCursor(first.value, 'Payments default');
        const second = await capture('payments/default-page-2', () => paymentsService.listPayments(companyId, {
            dateFrom, dateTo, sortField: 'payment_date', sortDir: 'desc', limit: 50, cursor,
        }));
        expectNoMetadata(second.record, /WITH\s+base_rows\s+AS/i);

        await capture('payments/full-filter-metadata', () => paymentsService.listPayments(companyId, {
            dateFrom,
            dateTo,
            paymentMethod: values.display_payment_method || values.payment_methods || undefined,
            quickFilter: 'new_checks',
            search: values.client || undefined,
            provider: values.provider || undefined,
            paidStatus: values.invoice_paid_in_full === true ? 'paid' : 'due',
            limit: 50,
        }));
        if (values.client) {
            await capture('payments/search', () => paymentsService.listPayments(companyId, {
                dateFrom, dateTo, search: String(values.client).slice(0, 80), limit: 50,
            }));
        }
        await capture('payments/amount-sort', () => paymentsService.listPayments(companyId, {
            dateFrom, dateTo, sortField: 'amount_paid', sortDir: 'desc', limit: 50,
        }));
        await capture('payments/tech-sort', () => paymentsService.listPayments(companyId, {
            dateFrom, dateTo, sortField: 'tech', sortDir: 'asc', limit: 50,
        }));
    });
});

afterAll(async () => {
    if (!PROD_COPY_URL) {
        db.query = originalQuery;
        await db.pool.end();
    }
});
