'use strict';

/**
 * AR-PROVIDER-SCOPE-001 — real PostgreSQL proof for the canonical Pulse AR
 * aggregate. The fixture uses task-only timelines so row surfacing, pin source,
 * plaque payload, task count, and has-open-task input all depend on the filtered
 * open_tasks lateral rather than an unrelated call/SMS/email/unread signal.
 */

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const tasksQueries = require('../backend/src/db/tasksQueries');

jest.setTimeout(30000);

const RUN_ID = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const PROVIDER = randomUUID();
const OTHER_A = randomUUID();
const OTHER_B = randomUUID();

const fixtures = {};
let client;
let setupError = null;
const pooledQuery = db.query;

function ids(rows) {
    return rows.map(row => String(row.id)).sort();
}

async function insertUser(id, companyId, label) {
    await db.query(
        `INSERT INTO crm_users (id, keycloak_sub, email, full_name, company_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, `arps-${RUN_ID}-${label}`, `${label}-${RUN_ID}@example.test`, label, companyId]
    );
}

async function insertContact(companyId, phone, label) {
    const { rows } = await db.query(
        `INSERT INTO contacts (company_id, phone_e164, full_name)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [companyId, phone, label]
    );
    return rows[0].id;
}

async function insertTimeline(companyId, contactId, label) {
    const { rows } = await db.query(
        `INSERT INTO timelines
            (company_id, contact_id, display_name, is_action_required, has_unread)
         VALUES ($1, $2, $3, false, false)
         RETURNING id`,
        [companyId, contactId, label]
    );
    return rows[0].id;
}

async function insertTask(companyId, timelineId, title, ownerId, authorId) {
    const { rows } = await db.query(
        `INSERT INTO tasks
            (company_id, thread_id, title, status, owner_user_id, author_user_id, created_by)
         VALUES ($1, $2, $3, 'open', $4, $5, 'user')
         RETURNING id`,
        [companyId, timelineId, title, ownerId, authorId]
    );
    return rows[0].id;
}

async function pulsePage(companyId, taskContentScope) {
    return timelinesQueries.getUnifiedTimelinePage({
        companyId,
        limit: 50,
        offset: 0,
        providerScope: { assignedOnly: false, userId: null },
        taskContentScope,
    });
}

beforeAll(async () => {
    try {
        client = await db.pool.connect();
        await client.query('BEGIN');
        // Migration 139 removed this v1 index. Keep the fixture runnable against
        // a stale developer schema; transaction rollback restores it afterward.
        await client.query('DROP INDEX IF EXISTS uq_tasks_one_open_per_thread');
        db.query = (text, params) => client.query(text, params);

        await db.query(
            `INSERT INTO companies (id, name, slug)
             VALUES ($1, $2, $3), ($4, $5, $6)`,
            [
                COMPANY_A, 'AR Provider Scope A', `arps-a-${RUN_ID}`,
                COMPANY_B, 'AR Provider Scope B', `arps-b-${RUN_ID}`,
            ]
        );
        await insertUser(PROVIDER, COMPANY_A, 'Provider');
        await insertUser(OTHER_A, COMPANY_A, 'Other A');
        await insertUser(OTHER_B, COMPANY_B, 'Other B');

        const sharedPhone = `+1508${String(Date.now()).slice(-7)}`;
        const mixedContact = await insertContact(COMPANY_A, sharedPhone, 'Mixed ownership');
        const otherContact = await insertContact(COMPANY_A, '+16175550199', 'Other only');
        const foreignContact = await insertContact(COMPANY_B, sharedPhone, 'Foreign same phone');
        fixtures.mixedTimeline = await insertTimeline(COMPANY_A, mixedContact, 'Mixed ownership');
        fixtures.otherTimeline = await insertTimeline(COMPANY_A, otherContact, 'Other only');
        fixtures.foreignTimeline = await insertTimeline(COMPANY_B, foreignContact, 'Foreign same phone');

        fixtures.assigned = await insertTask(
            COMPANY_A, fixtures.mixedTimeline, 'Assigned to provider', PROVIDER, OTHER_A
        );
        fixtures.authored = await insertTask(
            COMPANY_A, fixtures.mixedTimeline, 'Authored by provider', OTHER_A, PROVIDER
        );
        fixtures.hiddenMixed = await insertTask(
            COMPANY_A, fixtures.mixedTimeline, 'Teammate mixed task', OTHER_A, OTHER_A
        );
        fixtures.hiddenOnly = await insertTask(
            COMPANY_A, fixtures.otherTimeline, 'Teammate-only task', OTHER_A, OTHER_A
        );
        // Legacy coupling from the old Pulse task route must not resurrect this
        // hidden task as a taskless-manual AR plaque for the provider.
        await db.query(
            `UPDATE timelines SET
                is_action_required = true,
                action_required_reason = 'manual',
                action_required_set_at = now()
             WHERE company_id = $1 AND id = $2`,
            [COMPANY_A, fixtures.otherTimeline]
        );
        fixtures.foreign = await insertTask(
            COMPANY_B, fixtures.foreignTimeline, 'Foreign same-phone task', OTHER_B, OTHER_B
        );
    } catch (error) {
        setupError = error;
    }
});

afterAll(async () => {
    if (client) {
        try {
            await client.query('ROLLBACK');
        } finally {
            db.query = pooledQuery;
            client.release();
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

function requireDatabase() {
    if (setupError) throw new Error(`AR-PROVIDER-SCOPE-001 database setup failed: ${setupError.message}`);
}

describe('AR-PROVIDER-SCOPE-001 — Pulse task content scope (real PostgreSQL)', () => {
    test('provider sees assigned/authored plaque tasks only; teammate-only thread is not AR-pinned', async () => {
        requireDatabase();
        const page = await pulsePage(COMPANY_A, { canViewAll: false, userId: PROVIDER });
        const mixed = page.find(row => String(row.tl_id) === String(fixtures.mixedTimeline));

        expect(mixed).toBeTruthy();
        expect(ids(mixed.open_tasks)).toEqual(ids([
            { id: fixtures.assigned },
            { id: fixtures.authored },
        ]));
        expect(Number(mixed.open_task_count)).toBe(2);
        expect(page.find(row => String(row.tl_id) === String(fixtures.otherTimeline))).toBeUndefined();
        expect(ids(mixed.open_tasks)).not.toContain(String(fixtures.hiddenMixed));
    });

    test('admin/manager/dispatcher effective scope sees every company task unchanged', async () => {
        requireDatabase();
        const page = await pulsePage(COMPANY_A, { canViewAll: true, userId: null });
        const mixed = page.find(row => String(row.tl_id) === String(fixtures.mixedTimeline));
        const other = page.find(row => String(row.tl_id) === String(fixtures.otherTimeline));

        expect(ids(mixed.open_tasks)).toEqual(ids([
            { id: fixtures.assigned },
            { id: fixtures.authored },
            { id: fixtures.hiddenMixed },
        ]));
        expect(ids(other.open_tasks)).toEqual([String(fixtures.hiddenOnly)]);
    });

    test('AR counter uses the same assigned-or-authored predicate', async () => {
        requireDatabase();
        await expect(tasksQueries.countTasks(COMPANY_A, {
            status: 'open',
            parent_type: 'timeline',
            scopeOwnerId: PROVIDER,
        })).resolves.toBe(2);
        await expect(tasksQueries.countTasks(COMPANY_A, {
            status: 'open',
            parent_type: 'timeline',
        })).resolves.toBe(4);
    });

    test('missing restricted actor fails closed: task-only timelines disappear', async () => {
        requireDatabase();
        await expect(pulsePage(COMPANY_A, { canViewAll: false, userId: null }))
            .resolves.toEqual([]);
        await expect(pulsePage(COMPANY_A, null)).resolves.toEqual([]);
    });

    test('T-foreign/T-blast: same-phone foreign task is neither exposed nor changed', async () => {
        requireDatabase();
        const before = await db.query(
            `SELECT id, company_id, thread_id, title, status, owner_user_id, author_user_id
             FROM tasks WHERE company_id = $1 AND id = $2`,
            [COMPANY_B, fixtures.foreign]
        );

        const pageA = await pulsePage(COMPANY_A, { canViewAll: true, userId: null });
        expect(pageA.find(row => String(row.tl_id) === String(fixtures.foreignTimeline))).toBeUndefined();
        expect(pageA.flatMap(row => ids(row.open_tasks))).not.toContain(String(fixtures.foreign));

        const after = await db.query(
            `SELECT id, company_id, thread_id, title, status, owner_user_id, author_user_id
             FROM tasks WHERE company_id = $1 AND id = $2`,
            [COMPANY_B, fixtures.foreign]
        );
        expect(after.rows).toStrictEqual(before.rows);
    });
});
