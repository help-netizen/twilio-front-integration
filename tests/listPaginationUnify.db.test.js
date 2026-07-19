'use strict';

const { randomUUID } = require('node:crypto');

const TEST_DB_URL = process.env.LIST_PAGINATION_TEST_DB_URL || '';
if (TEST_DB_URL) process.env.DATABASE_URL = TEST_DB_URL;

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

jest.setTimeout(120000);

const TAG = `lpu-${Date.now()}-${process.pid}`;
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const SECRET_KEY = `lpu_secret_${Date.now()}_${process.pid}`;
const SECRET_VALUE = `${TAG}-tenant-secret`;

const fixture = {
    contactsA: [],
    leadsA: [],
    jobsA: [],
    tasksA: [],
    paymentsA: [],
    contactParent: null,
    secretJobA: null,
    secretJobB: null,
};

if (!TEST_DB_URL) {
    console.warn('LIST-PAGINATION-UNIFY-001 real-DB gate SKIPPED-NEEDS-LIST_PAGINATION_TEST_DB_URL');
}

async function idsFromInsert(sql, params) {
    const result = await db.query(sql, params);
    return result.rows.map(row => String(row.id));
}

async function seedFixtures() {
    await db.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
            COMPANY_A, `${TAG} Company A`, `${TAG}-a`,
            COMPANY_B, `${TAG} Company B`, `${TAG}-b`,
        ],
    );
    await db.query(
        `INSERT INTO crm_users (id, keycloak_sub, email, full_name, company_id)
         VALUES ($1, $2, $3, 'LPU User A', $4),
                ($5, $6, $7, 'LPU User B', $8)`,
        [
            USER_A, `${TAG}-user-a`, `${TAG}-a@example.com`, COMPANY_A,
            USER_B, `${TAG}-user-b`, `${TAG}-b@example.com`, COMPANY_B,
        ],
    );

    fixture.contactsA = await idsFromInsert(
        `INSERT INTO contacts (company_id, full_name, phone_e164, email)
         SELECT $1, $2 || '-contact-' || g, '+1555' || LPAD(g::text, 7, '0'),
                $2 || '-contact-' || g || '@example.com'
         FROM generate_series(1, 101) AS g
         RETURNING id::text AS id`,
        [COMPANY_A, TAG],
    );
    fixture.contactParent = fixture.contactsA[0];
    await db.query(
        `INSERT INTO contacts (company_id, full_name, phone_e164, email)
         VALUES ($1, $2, '+19990000001', $3)`,
        [COMPANY_B, `${TAG}-foreign-contact`, `${TAG}-foreign-contact@example.com`],
    );

    fixture.leadsA = await idsFromInsert(
        `INSERT INTO leads (
            company_id, uuid, status, first_name, last_name, phone, email,
            job_type, job_source, metadata, created_at
         )
         SELECT $1,
                'LPU' || LPAD(g::text, 9, '0'),
                'Submitted',
                $2 || '-lead',
                g::text,
                '+1666' || LPAD(g::text, 7, '0'),
                $2 || '-lead-' || g || '@example.com',
                'Repair',
                'Website',
                '{}'::jsonb,
                TIMESTAMPTZ '2026-01-01 00:00:00+00' + g * interval '1 second'
         FROM generate_series(1, 201) AS g
         RETURNING id::text AS id`,
        [COMPANY_A, TAG],
    );
    await db.query(
        `INSERT INTO leads (company_id, uuid, status, first_name, metadata, created_at)
         VALUES ($1, $2, 'Submitted', $3, '{}'::jsonb, '2098-01-01T00:00:00Z')`,
        [COMPANY_B, `B${String(Date.now()).slice(-9)}`, `${TAG}-foreign-lead`],
    );

    const jobsResult = await db.query(
        `INSERT INTO jobs (
            company_id, blanc_status, job_number, service_name, customer_name,
            start_date, assigned_techs, assigned_provider_user_ids, metadata
         )
         SELECT $1,
                'Submitted',
                $2 || '-job-' || g,
                'Repair',
                $2 || '-customer-' || g,
                TIMESTAMPTZ '2026-02-01 00:00:00+00' + g * interval '1 second',
                jsonb_build_array(jsonb_build_object('id', $3::text, 'name', 'Alex')),
                to_jsonb(ARRAY[$3::text]),
                CASE WHEN g = 1 THEN jsonb_build_object($4::text, $5::text) ELSE '{}'::jsonb END
         FROM generate_series(1, 101) AS g
         RETURNING id::text AS id, metadata`,
        [COMPANY_A, TAG, USER_A, SECRET_KEY, SECRET_VALUE],
    );
    fixture.jobsA = jobsResult.rows.map(row => String(row.id));
    fixture.secretJobA = String(jobsResult.rows.find(row => row.metadata?.[SECRET_KEY] === SECRET_VALUE).id);
    const foreignJob = await db.query(
        `INSERT INTO jobs (
            company_id, blanc_status, job_number, service_name, customer_name,
            start_date, assigned_techs, assigned_provider_user_ids, metadata
         ) VALUES (
            $1, 'Submitted', $2, 'Repair', $3, '2098-02-01T00:00:00Z',
            jsonb_build_array(jsonb_build_object('id', $4::text, 'name', 'Foreign')),
            to_jsonb(ARRAY[$4::text]), jsonb_build_object($5::text, $6::text)
         ) RETURNING id::text AS id`,
        [COMPANY_B, `${TAG}-foreign-job`, `${TAG}-foreign-customer`, USER_B, SECRET_KEY, SECRET_VALUE],
    );
    fixture.secretJobB = String(foreignJob.rows[0].id);
    await db.query(
        `INSERT INTO lead_custom_fields (
            company_id, display_name, api_name, field_type, is_system, is_searchable
         ) VALUES ($1, 'Foreign Secret', $2, 'text', false, true)`,
        [COMPANY_B, SECRET_KEY],
    );

    fixture.tasksA = await idsFromInsert(
        `INSERT INTO tasks (
            company_id, contact_id, title, description, status, due_at,
            owner_user_id, author_user_id, created_by, created_at
         )
         SELECT $1,
                $2::bigint,
                $3 || '-task-' || g,
                $3 || '-task-' || g,
                'open',
                TIMESTAMPTZ '2026-03-01 00:00:00+00' + g * interval '1 second',
                $4,
                $4,
                'user',
                TIMESTAMPTZ '2026-02-01 00:00:00+00' + g * interval '1 second'
         FROM generate_series(1, 101) AS g
         RETURNING id::text AS id`,
        [COMPANY_A, fixture.contactParent, TAG, USER_A],
    );
    const foreignContact = await db.query(
        `SELECT id FROM contacts WHERE company_id = $1 ORDER BY id LIMIT 1`,
        [COMPANY_B],
    );
    await db.query(
        `INSERT INTO tasks (
            company_id, contact_id, title, status, due_at, owner_user_id, created_by
         ) VALUES ($1, $2, $3, 'open', '2001-01-01T00:00:00Z', $4, 'user')`,
        [COMPANY_B, foreignContact.rows[0].id, `${TAG}-foreign-task`, USER_B],
    );

    fixture.paymentsA = await idsFromInsert(
        `INSERT INTO zb_payments (
            company_id, transaction_id, job_number, client,
            payment_methods, display_payment_method, amount_paid, payment_date,
            tech, invoice_amount_due, invoice_paid_in_full, check_deposited
         )
         SELECT $1,
                $2 || '-txn-' || g,
                $2 || '-job-' || g,
                $2 || '-client-' || g,
                CASE WHEN g % 2 = 0 THEN 'check' ELSE 'card' END,
                CASE WHEN g % 2 = 0 THEN 'check' ELSE 'card' END,
                g::numeric,
                TIMESTAMPTZ '2026-04-01 12:00:00+00' + g * interval '1 second',
                CASE WHEN g % 2 = 0 THEN 'Alex, Sam' ELSE 'Sam' END,
                (102 - g)::numeric,
                g % 2 = 0,
                false
         FROM generate_series(1, 101) AS g
         RETURNING id::text AS id`,
        [COMPANY_A, TAG],
    );
    await db.query(
        `INSERT INTO zb_payments (
            company_id, transaction_id, amount_paid, payment_date, tech
         ) VALUES ($1, $2, 9999, '2098-04-01T00:00:00Z', 'Foreign')`,
        [COMPANY_B, `${TAG}-foreign-payment`],
    );
}

async function cleanupFixtures() {
    const companyIds = [COMPANY_A, COMPANY_B];
    await db.query('DELETE FROM tasks WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query('DELETE FROM lead_custom_fields WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query('DELETE FROM zb_payments WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query('DELETE FROM jobs WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query('DELETE FROM leads WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query('DELETE FROM contacts WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query('DELETE FROM crm_users WHERE id = ANY($1::uuid[])', [[USER_A, USER_B]]);
    await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
}

async function concurrentInsert(sql, params) {
    const client = await db.pool.connect();
    let began = false;
    try {
        await client.query('BEGIN');
        began = true;
        const result = await client.query(sql, params);
        await client.query('COMMIT');
        began = false;
        return String(result.rows[0].id);
    } finally {
        if (began) await client.query('ROLLBACK');
        client.release();
    }
}

async function assertInsertStableWalk({ baselineIds, fetchPage, getRows, insertAhead }) {
    const expected = baselineIds.map(String).sort();
    const first = await fetchPage(null);
    expect(first.pagination.total).toBe(expected.length);
    expect(first.pagination.has_more).toBe(true);
    expect(first.pagination.next_cursor).toEqual(expect.any(String));

    const seen = getRows(first).map(String);
    const insertedId = await insertAhead();
    let cursor = first.pagination.next_cursor;
    let pages = 1;
    const usedCursors = new Set();
    while (cursor) {
        expect(usedCursors.has(cursor)).toBe(false);
        usedCursors.add(cursor);
        const page = await fetchPage(cursor);
        pages++;
        expect(page.pagination.total).toBeNull();
        seen.push(...getRows(page).map(String));
        if (page.pagination.has_more) {
            expect(page.pagination.next_cursor).toEqual(expect.any(String));
        } else {
            expect(page.pagination.next_cursor).toBeNull();
        }
        cursor = page.pagination.next_cursor;
    }

    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen).toHaveLength(expected.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(expected);
    expect(seen).not.toContain(insertedId);
}

const describeDb = TEST_DB_URL ? describe : describe.skip;

describeDb('LIST-PAGINATION-UNIFY-001 real PostgreSQL gate', () => {
    beforeAll(async () => {
        await db.query('SELECT 1 FROM companies LIMIT 1');
        await seedFixtures();
    });

    afterAll(async () => {
        try {
            await cleanupFixtures();
        } finally {
            await db.pool.end();
        }
    });

    test('SAB-JOBS-CUSTOM-FIELD-TENANT: searchable field definitions and rows remain tenant-isolated', async () => {
        const beforeOwnership = await jobsService.listJobs({
            companyId: COMPANY_A,
            search: SECRET_VALUE,
            limit: 50,
        });
        expect(beforeOwnership.total).toBe(0);
        expect(beforeOwnership.results).toEqual([]);

        await db.query(
            'DELETE FROM lead_custom_fields WHERE company_id = $1 AND api_name = $2',
            [COMPANY_B, SECRET_KEY],
        );
        await db.query(
            `INSERT INTO lead_custom_fields (
                company_id, display_name, api_name, field_type, is_system, is_searchable
             ) VALUES ($1, 'Owned Secret', $2, 'text', false, true)`,
            [COMPANY_A, SECRET_KEY],
        );

        const afterOwnership = await jobsService.listJobs({
            companyId: COMPANY_A,
            search: SECRET_VALUE,
            limit: 50,
        });
        expect(afterOwnership.total).toBe(1);
        expect(afterOwnership.results.map(job => String(job.id))).toEqual([fixture.secretJobA]);
        expect(afterOwnership.results.map(job => String(job.id))).not.toContain(fixture.secretJobB);
    });

    test('SAB-PAYMENTS-PAGED-AGGREGATE: page-one count and sum include all 101 matches', async () => {
        const page = await paymentsService.listPayments(COMPANY_A, {
            dateFrom: '2026-04-01',
            dateTo: '2026-04-02',
            limit: 50,
        });

        expect(page.rows).toHaveLength(50);
        expect(page.pagination).toMatchObject({ total: 101, returned: 50, has_more: true });
        expect(page.aggregates).toEqual({ transaction_count: 101, total_amount: '5151.00' });
        expect(page.facets).toEqual({
            payment_methods: ['card', 'check'],
            providers: ['Alex', 'Sam'],
            undeposited_check_count: 50,
        });
    });

    test('SAB-CURSOR-OFFSET-INSERT fixed Leads: ahead insert cannot duplicate or skip baseline rows', async () => {
        await assertInsertStableWalk({
            baselineIds: fixture.leadsA,
            fetchPage: cursor => leadsService.listLeads({
                companyId: COMPANY_A,
                only_open: true,
                limit: 100,
                cursor: cursor || undefined,
            }),
            getRows: page => page.results.map(lead => lead.ClientId),
            insertAhead: () => concurrentInsert(
                `INSERT INTO leads (
                    company_id, uuid, status, first_name, metadata, created_at
                 ) VALUES ($1, $2, 'Submitted', $3, '{}'::jsonb, '2099-01-01T00:00:00Z')
                 RETURNING id::text AS id`,
                [COMPANY_A, `I${String(Date.now()).slice(-9)}`, `${TAG}-inserted-lead`],
            ),
        });
    });

    test('SAB-CURSOR-OFFSET-INSERT dynamic Jobs: ahead insert cannot duplicate or skip baseline rows', async () => {
        await assertInsertStableWalk({
            baselineIds: fixture.jobsA,
            fetchPage: cursor => jobsService.listJobs({
                companyId: COMPANY_A,
                providerScope: { assignedOnly: true, userId: USER_A },
                sortBy: 'start_date',
                sortOrder: 'desc',
                limit: 50,
                cursor: cursor || undefined,
            }),
            getRows: page => page.results.map(job => job.id),
            insertAhead: () => concurrentInsert(
                `INSERT INTO jobs (
                    company_id, blanc_status, job_number, service_name, start_date,
                    assigned_techs, assigned_provider_user_ids, metadata
                 ) VALUES (
                    $1, 'Submitted', $2, 'Repair', '2099-02-01T00:00:00Z',
                    jsonb_build_array(jsonb_build_object('id', $3::text, 'name', 'Alex')),
                    to_jsonb(ARRAY[$3::text]), '{}'::jsonb
                 ) RETURNING id::text AS id`,
                [COMPANY_A, `${TAG}-inserted-job`, USER_A],
            ),
        });
    });

    test('SAB-CURSOR-OFFSET-INSERT fixed Tasks: ahead insert cannot duplicate or skip baseline rows', async () => {
        await assertInsertStableWalk({
            baselineIds: fixture.tasksA,
            fetchPage: cursor => tasksQueries.listTasksPage(COMPANY_A, {
                status: 'open',
                scopeOwnerId: USER_A,
                sort_by: 'due_at',
                sort_order: 'asc',
                limit: 50,
                cursor: cursor || undefined,
            }),
            getRows: page => page.tasks.map(task => task.id),
            insertAhead: () => concurrentInsert(
                `INSERT INTO tasks (
                    company_id, contact_id, title, description, status, due_at,
                    owner_user_id, author_user_id, created_by
                 ) VALUES (
                    $1, $2::bigint, $3, $3, 'open', '2000-01-01T00:00:00Z', $4, $4, 'user'
                 ) RETURNING id::text AS id`,
                [COMPANY_A, fixture.contactParent, `${TAG}-inserted-task`, USER_A],
            ),
        });
    });

    test('SAB-CURSOR-OFFSET-INSERT fixed Contacts: ahead insert cannot duplicate or skip baseline rows', async () => {
        await assertInsertStableWalk({
            baselineIds: fixture.contactsA,
            fetchPage: cursor => contactsService.listContacts({
                companyId: COMPANY_A,
                limit: 50,
                cursor: cursor || undefined,
            }),
            getRows: page => page.results.map(contact => contact.id),
            insertAhead: () => concurrentInsert(
                `INSERT INTO contacts (company_id, full_name, phone_e164, email)
                 VALUES ($1, $2, '+18880000001', $3)
                 RETURNING id::text AS id`,
                [COMPANY_A, `${TAG}-inserted-contact`, `${TAG}-inserted-contact@example.com`],
            ),
        });
    });

    test('SAB-CURSOR-OFFSET-INSERT dynamic Payments: ahead insert cannot duplicate or skip baseline rows', async () => {
        await assertInsertStableWalk({
            baselineIds: fixture.paymentsA,
            fetchPage: cursor => paymentsService.listPayments(COMPANY_A, {
                dateFrom: '2026-04-01',
                dateTo: '2099-12-31',
                sortField: 'amount_paid',
                sortDir: 'desc',
                limit: 50,
                cursor: cursor || undefined,
            }),
            getRows: page => page.rows.map(payment => payment.id),
            insertAhead: () => concurrentInsert(
                `INSERT INTO zb_payments (
                    company_id, transaction_id, amount_paid, payment_date, tech
                 ) VALUES ($1, $2, 999999, '2099-04-01T00:00:00Z', 'Alex')
                 RETURNING id::text AS id`,
                [COMPANY_A, `${TAG}-inserted-payment`],
            ),
        });
    });
});

afterAll(async () => {
    if (!TEST_DB_URL) await db.pool.end();
});
