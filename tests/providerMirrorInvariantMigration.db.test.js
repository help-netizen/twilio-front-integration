'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');

jest.setTimeout(60000);

const migration = fs.readFileSync(path.join(
    __dirname,
    '..',
    'backend',
    'db',
    'migrations',
    '258_provider_mirror_invariant.sql'
), 'utf8');
const rollback = fs.readFileSync(path.join(
    __dirname,
    '..',
    'backend',
    'db',
    'migrations',
    'rollback_258_provider_mirror_invariant.sql'
), 'utf8');

const schema = `provider_mirror_invariant_${randomUUID().replaceAll('-', '')}`;
let client;
let initialJobId;
let initialUserId;
let foreignCompanyId;
let foreignUserId;
let foreignJobId;

async function createFixtureTables(runner) {
    await runner.query(`
        CREATE TABLE company_memberships (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL,
            company_id UUID NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, company_id)
        );
        CREATE TABLE technicians (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            company_id UUID NOT NULL,
            display_name TEXT NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            crm_user_id UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (company_id, id),
            FOREIGN KEY (crm_user_id, company_id)
                REFERENCES company_memberships(user_id, company_id)
                ON DELETE SET NULL (crm_user_id)
        );
        CREATE UNIQUE INDEX uq_test_technicians_company_crm_user
            ON technicians (company_id, crm_user_id)
            WHERE crm_user_id IS NOT NULL;
        CREATE TABLE technician_external_identities (
            company_id UUID NOT NULL,
            source TEXT NOT NULL,
            external_id TEXT NOT NULL,
            technician_id UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (company_id, source, external_id),
            FOREIGN KEY (company_id, technician_id)
                REFERENCES technicians(company_id, id)
                ON DELETE CASCADE
        );
        CREATE INDEX idx_test_external_identity_technician
            ON technician_external_identities (company_id, technician_id, source);
        CREATE TABLE jobs (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            assigned_techs JSONB NOT NULL DEFAULT '[]'::jsonb,
            assigned_provider_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX idx_test_jobs_company ON jobs (company_id);
    `);
}

async function seedMembership(companyId, userId = randomUUID(), status = 'active') {
    await client.query(
        `INSERT INTO company_memberships (user_id, company_id, status)
         VALUES ($1, $2, $3)`,
        [userId, companyId, status]
    );
    return userId;
}

async function seedTechnician(companyId, {
    userId = null,
    active = true,
    technicianId = randomUUID(),
    name = 'Invariant technician',
} = {}) {
    await client.query(
        `INSERT INTO technicians
            (id, company_id, display_name, active, crm_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [technicianId, companyId, name, active, userId]
    );
    return technicianId;
}

async function insertJob(companyId, assignedTechs, { includeMirror = false, mirror = [] } = {}) {
    const sql = includeMirror
        ? `INSERT INTO jobs
              (company_id, assigned_techs, assigned_provider_user_ids)
           VALUES ($1, $2::jsonb, $3::jsonb)
           RETURNING id, assigned_provider_user_ids`
        : `INSERT INTO jobs (company_id, assigned_techs)
           VALUES ($1, $2::jsonb)
           RETURNING id, assigned_provider_user_ids`;
    const params = includeMirror
        ? [companyId, JSON.stringify(assignedTechs), JSON.stringify(mirror)]
        : [companyId, JSON.stringify(assignedTechs)];
    const { rows } = await client.query(sql, params);
    return rows[0];
}

async function mirrorFor(jobId, companyId) {
    const { rows } = await client.query(
        `SELECT assigned_provider_user_ids
         FROM jobs
         WHERE id = $1 AND company_id = $2`,
        [jobId, companyId]
    );
    return rows[0].assigned_provider_user_ids;
}

async function foreignSnapshot() {
    const { rows } = await client.query(
        `SELECT to_jsonb(job)::text AS bytes
         FROM jobs job
         WHERE id = $1 AND company_id = $2`,
        [foreignJobId, foreignCompanyId]
    );
    return rows[0].bytes;
}

beforeAll(async () => {
    client = await db.getClient();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await createFixtureTables(client);

    const initialCompanyId = randomUUID();
    initialUserId = await seedMembership(initialCompanyId);
    const initialTechId = await seedTechnician(initialCompanyId, { userId: initialUserId });
    const initialJob = await insertJob(
        initialCompanyId,
        [{ id: initialTechId, name: 'Pre-migration technician' }],
        { includeMirror: true, mirror: [] }
    );
    initialJobId = initialJob.id;

    await client.query(migration);

    foreignCompanyId = randomUUID();
    foreignUserId = await seedMembership(foreignCompanyId);
    const foreignTechId = await seedTechnician(foreignCompanyId, {
        userId: foreignUserId,
        name: 'Foreign technician',
    });
    const foreignJob = await insertJob(foreignCompanyId, [{
        id: foreignTechId,
        name: 'Foreign technician',
    }]);
    foreignJobId = foreignJob.id;
});

test('migration full-recompute repairs pre-existing drift immediately', async () => {
    const { rows } = await client.query(
        `SELECT assigned_provider_user_ids
         FROM jobs
         WHERE id = $1`,
        [initialJobId]
    );
    expect(rows[0].assigned_provider_user_ids).toEqual([initialUserId]);
});

test('raw SQL UPDATE assigned_techs derives the mirror and leaves the neighbour byte-identical', async () => {
    const before = await foreignSnapshot();
    const companyId = randomUUID();
    const userId = await seedMembership(companyId);
    const technicianId = await seedTechnician(companyId, { userId });
    const job = await insertJob(companyId, []);

    const { rows } = await client.query(
        `UPDATE jobs
         SET assigned_techs = $3::jsonb
         WHERE id = $1 AND company_id = $2
         RETURNING assigned_provider_user_ids`,
        [job.id, companyId, JSON.stringify([{ id: technicianId, name: 'Raw SQL' }])]
    );

    expect(rows[0].assigned_provider_user_ids).toEqual([userId]);
    expect(await foreignSnapshot()).toBe(before);
});

test('INSERT jobs without the mirror column closes the exact 1682 writer gap', async () => {
    const before = await foreignSnapshot();
    const companyId = randomUUID();
    const userId = await seedMembership(companyId);
    const technicianId = await seedTechnician(companyId, { userId });

    const job = await insertJob(companyId, [{ id: technicianId, name: '1682 guard' }]);

    expect(job.assigned_provider_user_ids).toEqual([userId]);
    expect(await foreignSnapshot()).toBe(before);
});

test('linking crm_user_id after assignment makes every affected job visible', async () => {
    const before = await foreignSnapshot();
    const companyId = randomUUID();
    const userId = await seedMembership(companyId);
    const technicianId = await seedTechnician(companyId);
    const first = await insertJob(companyId, [{ id: technicianId, name: 'Late link' }]);
    const second = await insertJob(companyId, [{ id: technicianId, name: 'Late link' }]);
    expect(first.assigned_provider_user_ids).toEqual([]);

    await client.query(
        `UPDATE technicians
         SET crm_user_id = $3
         WHERE company_id = $1 AND id = $2`,
        [companyId, technicianId, userId]
    );

    await expect(mirrorFor(first.id, companyId)).resolves.toEqual([userId]);
    await expect(mirrorFor(second.id, companyId)).resolves.toEqual([userId]);
    expect(await foreignSnapshot()).toBe(before);
});

test('deactivating membership removes visibility without application reconciliation', async () => {
    const before = await foreignSnapshot();
    const companyId = randomUUID();
    const userId = await seedMembership(companyId);
    const technicianId = await seedTechnician(companyId, { userId });
    const job = await insertJob(companyId, [{ id: technicianId, name: 'Membership status' }]);

    await client.query(
        `UPDATE company_memberships
         SET status = 'inactive'
         WHERE company_id = $1 AND user_id = $2`,
        [companyId, userId]
    );

    await expect(mirrorFor(job.id, companyId)).resolves.toEqual([]);
    expect(await foreignSnapshot()).toBe(before);
});

test('a forged foreign user id written directly to the mirror does not survive', async () => {
    const before = await foreignSnapshot();
    const companyId = randomUUID();
    const userId = await seedMembership(companyId);
    const technicianId = await seedTechnician(companyId, { userId });
    const job = await insertJob(companyId, [{ id: technicianId, name: 'Forgery guard' }]);

    const { rows } = await client.query(
        `UPDATE jobs
         SET assigned_provider_user_ids = $3::jsonb
         WHERE id = $1 AND company_id = $2
         RETURNING assigned_provider_user_ids`,
        [job.id, companyId, JSON.stringify([foreignUserId])]
    );

    expect(rows[0].assigned_provider_user_ids).toEqual([userId]);
    expect(rows[0].assigned_provider_user_ids).not.toContain(foreignUserId);
    expect(await foreignSnapshot()).toBe(before);
});

test('external identity INSERT/UPDATE/DELETE refresh only jobs using old or new refs', async () => {
    const before = await foreignSnapshot();
    const companyId = randomUUID();
    const userId = await seedMembership(companyId);
    const technicianId = await seedTechnician(companyId, { userId });
    const oldExternalId = `old-${randomUUID()}`;
    const newExternalId = `new-${randomUUID()}`;
    const oldJob = await insertJob(companyId, [{ id: oldExternalId, name: 'Legacy old' }]);
    const newJob = await insertJob(companyId, [{ id: newExternalId, name: 'Legacy new' }]);

    await client.query(
        `INSERT INTO technician_external_identities
            (company_id, source, external_id, technician_id)
         VALUES ($1, 'zenbooker', $2, $3)`,
        [companyId, oldExternalId, technicianId]
    );
    await expect(mirrorFor(oldJob.id, companyId)).resolves.toEqual([userId]);

    await client.query(
        `UPDATE technician_external_identities
         SET external_id = $3
         WHERE company_id = $1 AND source = 'zenbooker' AND external_id = $2`,
        [companyId, oldExternalId, newExternalId]
    );
    await expect(mirrorFor(oldJob.id, companyId)).resolves.toEqual([]);
    await expect(mirrorFor(newJob.id, companyId)).resolves.toEqual([userId]);

    await client.query(
        `DELETE FROM technician_external_identities
         WHERE company_id = $1 AND source = 'zenbooker' AND external_id = $2`,
        [companyId, newExternalId]
    );
    await expect(mirrorFor(newJob.id, companyId)).resolves.toEqual([]);
    expect(await foreignSnapshot()).toBe(before);
});

test('technician active changes and membership DELETE revoke visibility', async () => {
    const before = await foreignSnapshot();
    const companyId = randomUUID();
    const userId = await seedMembership(companyId);
    const technicianId = await seedTechnician(companyId, { userId });
    const externalId = `lifecycle-${randomUUID()}`;
    await client.query(
        `INSERT INTO technician_external_identities
            (company_id, source, external_id, technician_id)
         VALUES ($1, 'zenbooker', $2, $3)`,
        [companyId, externalId, technicianId]
    );
    const job = await insertJob(companyId, [{ id: externalId, name: 'Lifecycle' }]);

    await client.query(
        `UPDATE technicians SET active = FALSE
         WHERE company_id = $1 AND id = $2`,
        [companyId, technicianId]
    );
    await expect(mirrorFor(job.id, companyId)).resolves.toEqual([]);

    await client.query(
        `UPDATE technicians SET active = TRUE
         WHERE company_id = $1 AND id = $2`,
        [companyId, technicianId]
    );
    await expect(mirrorFor(job.id, companyId)).resolves.toEqual([userId]);

    await client.query(
        `DELETE FROM company_memberships
         WHERE company_id = $1 AND user_id = $2`,
        [companyId, userId]
    );
    await expect(mirrorFor(job.id, companyId)).resolves.toEqual([]);
    expect(await foreignSnapshot()).toBe(before);
});

test('ALWAYS triggers survive session_replication_role=replica', async () => {
    const companyId = randomUUID();
    const userId = await seedMembership(companyId);
    const technicianId = await seedTechnician(companyId, { userId });
    const job = await insertJob(companyId, [{ id: technicianId, name: 'Replica role' }]);

    try {
        await client.query(`SET session_replication_role = 'replica'`);
        const { rows } = await client.query(
            `UPDATE jobs
             SET assigned_provider_user_ids = $3::jsonb
             WHERE id = $1 AND company_id = $2
             RETURNING assigned_provider_user_ids`,
            [job.id, companyId, JSON.stringify([foreignUserId])]
        );
        expect(rows[0].assigned_provider_user_ids).toEqual([userId]);
    } finally {
        await client.query(`SET session_replication_role = 'origin'`);
    }
});

test('DISABLE TRIGGER can bypass the invariant, and explicit full-recompute repairs it', async () => {
    const companyId = randomUUID();
    const userId = await seedMembership(companyId);
    const technicianId = await seedTechnician(companyId, { userId });
    const job = await insertJob(companyId, [{ id: technicianId, name: 'Importer bypass' }]);

    await client.query(`ALTER TABLE jobs DISABLE TRIGGER trg_jobs_provider_mirror_update`);
    try {
        await client.query(
            `UPDATE jobs
             SET assigned_provider_user_ids = $3::jsonb
             WHERE id = $1 AND company_id = $2`,
            [job.id, companyId, JSON.stringify([foreignUserId])]
        );
        await expect(mirrorFor(job.id, companyId)).resolves.toEqual([foreignUserId]);
    } finally {
        await client.query(
            `ALTER TABLE jobs ENABLE ALWAYS TRIGGER trg_jobs_provider_mirror_update`
        );
    }

    const { rows } = await client.query(
        `SELECT refresh_job_provider_mirrors(ARRAY[$1]::uuid[], NULL, NULL, TRUE) AS updated`,
        [companyId]
    );
    expect(Number(rows[0].updated)).toBe(1);
    await expect(mirrorFor(job.id, companyId)).resolves.toEqual([userId]);
});

test('all invariant triggers are replica-safe ALWAYS triggers', async () => {
    const { rows } = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM pg_trigger
         WHERE tgrelid IN (
             'jobs'::regclass,
             'technicians'::regclass,
             'technician_external_identities'::regclass,
             'company_memberships'::regclass
         )
           AND tgname LIKE '%provider_mirror%'
           AND tgenabled = 'A'`
    );
    expect(rows[0].count).toBe(11);
});

test('rollback removes enforcement functions/triggers without destroying mirror data', async () => {
    const rollbackClient = await db.getClient();
    const rollbackSchema = `provider_mirror_rollback_${randomUUID().replaceAll('-', '')}`;
    try {
        await rollbackClient.query(`CREATE SCHEMA ${rollbackSchema}`);
        await rollbackClient.query(`SET search_path TO ${rollbackSchema}, public`);
        await createFixtureTables(rollbackClient);
        await rollbackClient.query(migration);

        const companyId = randomUUID();
        const userId = randomUUID();
        const technicianId = randomUUID();
        await rollbackClient.query(
            `INSERT INTO company_memberships (user_id, company_id, status)
             VALUES ($1, $2, 'active')`,
            [userId, companyId]
        );
        await rollbackClient.query(
            `INSERT INTO technicians
                (id, company_id, display_name, active, crm_user_id)
             VALUES ($1, $2, 'Rollback technician', TRUE, $3)`,
            [technicianId, companyId, userId]
        );
        const { rows: protectedJobs } = await rollbackClient.query(
            `INSERT INTO jobs (company_id, assigned_techs)
             VALUES ($1, $2::jsonb)
             RETURNING id, assigned_provider_user_ids`,
            [companyId, JSON.stringify([{ id: technicianId, name: 'Rollback technician' }])]
        );
        expect(protectedJobs[0].assigned_provider_user_ids).toEqual([userId]);

        await rollbackClient.query(rollback);

        const { rows: triggers } = await rollbackClient.query(
            `SELECT tgname
             FROM pg_trigger
             WHERE tgrelid IN (
                 'jobs'::regclass,
                 'technicians'::regclass,
                 'technician_external_identities'::regclass,
                 'company_memberships'::regclass
             )
               AND tgname LIKE '%provider_mirror%'`
        );
        expect(triggers).toEqual([]);
        const { rows: functions } = await rollbackClient.query(
            `SELECT proname
             FROM pg_proc
             WHERE pronamespace = $1::regnamespace
               AND proname LIKE '%provider_mirror%'`,
            [rollbackSchema]
        );
        expect(functions).toEqual([]);
        const { rows: preservedJobs } = await rollbackClient.query(
            `SELECT assigned_provider_user_ids
             FROM jobs
             WHERE id = $1`,
            [protectedJobs[0].id]
        );
        expect(preservedJobs[0].assigned_provider_user_ids).toEqual([userId]);
    } finally {
        await rollbackClient.query(`DROP SCHEMA IF EXISTS ${rollbackSchema} CASCADE`).catch(() => {});
        rollbackClient.release();
    }
});

afterAll(async () => {
    if (client) {
        await client.query(`SET session_replication_role = 'origin'`).catch(() => {});
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        client.release();
    }
    await db.pool.end().catch(() => {});
});
