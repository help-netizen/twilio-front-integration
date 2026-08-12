'use strict';

const { randomUUID } = require('crypto');
const suffix = randomUUID();
const schema = `provider_mirror_${suffix.replaceAll('-', '')}`;
const previousPgOptions = process.env.PGOPTIONS;
process.env.PGOPTIONS = [previousPgOptions, `-c search_path=${schema},public`]
    .filter(Boolean)
    .join(' ');
const db = require('../backend/src/db/connection');
const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const leadsService = require('../backend/src/services/leadsService');
const directoryService = require('../backend/src/services/technicianDirectoryService');
const eventBus = require('../backend/src/services/eventBus');

jest.setTimeout(60000);

const companyA = randomUUID();
const companyB = randomUUID();
const userA = randomUUID();
const lateUserA = randomUUID();
const identityUserA = randomUUID();
const userB = randomUUID();
const conversionTechA = randomUUID();
const lateLinkTechA = randomUUID();
const identityTechA = randomUUID();
const technicianB = randomUUID();
const lateExternalId = `late-external-${suffix}`;
let foreignJobId;
let unrelatedStaleJobId;
let eventEmitSpy;

async function insertUser(userId, companyId, label) {
    await db.query(
        `INSERT INTO crm_users
            (id, keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, $4, 'company_member', 'active', $5,
                 'none', 'active', 'user')`,
        [userId, `mirror-${label}-${suffix}`, `mirror-${label}-${suffix}@test.invalid`, label, companyId]
    );
    await db.query(
        `INSERT INTO company_memberships
            (user_id, company_id, role, role_key, status)
         VALUES ($1, $2, 'company_member', 'provider', 'active')`,
        [userId, companyId]
    );
}

async function foreignSnapshot() {
    const { rows } = await db.query(
        `SELECT to_jsonb(j) AS value
         FROM jobs j
         WHERE j.id = $1 AND j.company_id = $2`,
        [foreignJobId, companyB]
    );
    return rows[0].value;
}

async function expectForeignUnchanged(before) {
    await expect(foreignSnapshot()).resolves.toEqual(before);
}

async function unrelatedStaleSnapshot() {
    const { rows } = await db.query(
        `SELECT to_jsonb(j) AS value
         FROM jobs j
         WHERE j.id = $1 AND j.company_id = $2`,
        [unrelatedStaleJobId, companyA]
    );
    return rows[0].value;
}

beforeAll(async () => {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`
        CREATE TABLE ${schema}.companies (
            id UUID PRIMARY KEY,
            name TEXT,
            slug TEXT,
            status TEXT,
            timezone TEXT
        );
        CREATE TABLE ${schema}.crm_users (
            id UUID PRIMARY KEY,
            keycloak_sub TEXT,
            email TEXT,
            full_name TEXT,
            role TEXT,
            status TEXT,
            company_id UUID,
            platform_role TEXT,
            onboarding_status TEXT,
            kind TEXT
        );
        CREATE TABLE ${schema}.company_memberships (
            id BIGSERIAL PRIMARY KEY,
            user_id UUID NOT NULL,
            company_id UUID NOT NULL,
            role TEXT,
            role_key TEXT,
            status TEXT,
            UNIQUE (user_id, company_id)
        );
        CREATE TABLE ${schema}.company_user_profiles (
            membership_id BIGINT PRIMARY KEY,
            is_provider BOOLEAN NOT NULL DEFAULT FALSE
        );
        CREATE TABLE ${schema}.technicians (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            company_id UUID NOT NULL,
            display_name TEXT NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            crm_user_id UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            merged_into UUID
        );
        CREATE TABLE ${schema}.technician_external_identities (
            company_id UUID NOT NULL,
            source TEXT NOT NULL,
            external_id TEXT NOT NULL,
            technician_id UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (company_id, source, external_id)
        );
        CREATE TABLE ${schema}.leads (
            id BIGSERIAL PRIMARY KEY,
            serial_id BIGINT,
            uuid TEXT NOT NULL,
            company_id UUID NOT NULL,
            status TEXT NOT NULL,
            sub_status TEXT,
            lead_lost BOOLEAN NOT NULL DEFAULT FALSE,
            converted_to_job BOOLEAN NOT NULL DEFAULT FALSE,
            zenbooker_job_id TEXT,
            contact_id BIGINT,
            first_name TEXT,
            last_name TEXT,
            company TEXT,
            phone TEXT,
            email TEXT,
            address TEXT,
            unit TEXT,
            city TEXT,
            state TEXT,
            postal_code TEXT,
            country TEXT,
            job_type TEXT,
            job_source TEXT,
            referral_company TEXT,
            timezone TEXT,
            lead_notes TEXT,
            comments TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            tags JSONB,
            structured_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
            lead_date_time TIMESTAMPTZ,
            lead_end_date_time TIMESTAMPTZ,
            payment_due_date TIMESTAMPTZ,
            latitude DOUBLE PRECISION,
            longitude DOUBLE PRECISION,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE ${schema}.jobs (
            id BIGSERIAL PRIMARY KEY,
            lead_id BIGINT,
            contact_id BIGINT,
            zenbooker_job_id TEXT,
            blanc_status TEXT,
            service_name TEXT,
            address TEXT,
            customer_name TEXT,
            customer_phone TEXT,
            customer_email TEXT,
            company_id UUID NOT NULL,
            job_type TEXT,
            job_source TEXT,
            description TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            comments TEXT,
            start_date TIMESTAMPTZ,
            end_date TIMESTAMPTZ,
            assigned_techs JSONB NOT NULL DEFAULT '[]'::jsonb,
            assigned_provider_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE ${schema}.audit_log (
            id BIGSERIAL PRIMARY KEY,
            actor_id UUID,
            actor_email TEXT,
            actor_ip INET,
            action TEXT NOT NULL,
            target_type TEXT,
            target_id TEXT,
            company_id UUID,
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            trace_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    eventEmitSpy = jest.spyOn(eventBus, 'emit').mockResolvedValue({ id: null });

    await db.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, 'Mirror lifecycle A', $3, 'active', 'America/New_York'),
                ($2, 'Mirror lifecycle B', $4, 'active', 'America/New_York')`,
        [companyA, companyB, `mirror-lifecycle-a-${suffix}`, `mirror-lifecycle-b-${suffix}`]
    );
    await insertUser(userA, companyA, 'conversion-a');
    await insertUser(lateUserA, companyA, 'late-link-a');
    await insertUser(identityUserA, companyA, 'identity-a');
    await insertUser(userB, companyB, 'foreign-b');

    await db.query(
        `INSERT INTO technicians (id, company_id, display_name, active, crm_user_id)
         VALUES ($1, $5, 'Conversion Tech A', TRUE, $6),
                ($2, $5, 'Late Link Tech A', TRUE, NULL),
                ($3, $5, 'Identity Tech A', TRUE, $7),
                ($4, $8, 'Foreign Tech B', TRUE, $9)`,
        [
            conversionTechA,
            lateLinkTechA,
            identityTechA,
            technicianB,
            companyA,
            userA,
            identityUserA,
            companyB,
            userB,
        ]
    );
    const foreignJob = await db.query(
        `INSERT INTO jobs
            (company_id, blanc_status, assigned_techs, assigned_provider_user_ids)
         VALUES ($1, 'Submitted', $2::jsonb, $3::jsonb)
         RETURNING id`,
        [
            companyB,
            JSON.stringify([{ id: technicianB, name: 'Foreign Tech B' }]),
            JSON.stringify([userB]),
        ]
    );
    foreignJobId = foreignJob.rows[0].id;
    const unrelatedStaleJob = await db.query(
        `INSERT INTO jobs
            (company_id, blanc_status, assigned_techs, assigned_provider_user_ids)
         VALUES ($1, 'Submitted', $2::jsonb, '[]'::jsonb)
         RETURNING id`,
        [companyA, JSON.stringify([{ id: conversionTechA, name: 'Conversion Tech A' }])]
    );
    unrelatedStaleJobId = unrelatedStaleJob.rows[0].id;
});

test('lead conversion stores the resolved provider mirror immediately and cannot blast another tenant', async () => {
    const before = await foreignSnapshot();
    const unrelatedBefore = await unrelatedStaleSnapshot();
    const leadUuid = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
    await db.query(
        `INSERT INTO leads
            (uuid, company_id, status, converted_to_job, first_name, last_name,
             job_type, job_source)
         VALUES ($1, $2, 'Submitted', FALSE, 'Yelp', 'Customer',
                 'Appliance repair', 'Yelp')`,
        [leadUuid, companyA]
    );

    const converted = await leadsService.convertLead(leadUuid, {
        schedule: {
            start_at: '2036-04-01T13:00:00.000Z',
            end_at: '2036-04-01T15:00:00.000Z',
            technician_ids: [conversionTechA],
        },
    }, companyA);

    const { rows } = await db.query(
        `SELECT assigned_techs, assigned_provider_user_ids
         FROM jobs
         WHERE id = $1 AND company_id = $2`,
        [converted.job_id, companyA]
    );
    expect(rows[0].assigned_techs).toEqual([{
        id: conversionTechA,
        name: 'Conversion Tech A',
    }]);
    expect(rows[0].assigned_provider_user_ids).toEqual([userA]);
    await expectForeignUnchanged(before);
    await expect(unrelatedStaleSnapshot()).resolves.toEqual(unrelatedBefore);
});

test('late CRM link and unlink reconcile existing jobs without manual intervention or tenant blast', async () => {
    const before = await foreignSnapshot();
    const unrelatedBefore = await unrelatedStaleSnapshot();
    const { rows: jobs } = await db.query(
        `INSERT INTO jobs
            (company_id, blanc_status, assigned_techs, assigned_provider_user_ids)
         VALUES ($1, 'Submitted', $2::jsonb, '[]'::jsonb)
         RETURNING id`,
        [companyA, JSON.stringify([{ id: lateLinkTechA, name: 'Late Link Tech A' }])]
    );

    await directoryQueries.linkCrmUser({
        companyId: companyA,
        technicianId: lateLinkTechA,
        crmUserId: lateUserA,
    });
    await expect(db.query(
        `SELECT assigned_provider_user_ids FROM jobs
         WHERE id = $1 AND company_id = $2`,
        [jobs[0].id, companyA]
    )).resolves.toMatchObject({ rows: [{ assigned_provider_user_ids: [lateUserA] }] });

    await directoryQueries.unlinkCrmUser({ companyId: companyA, crmUserId: lateUserA });
    await expect(db.query(
        `SELECT assigned_provider_user_ids FROM jobs
         WHERE id = $1 AND company_id = $2`,
        [jobs[0].id, companyA]
    )).resolves.toMatchObject({ rows: [{ assigned_provider_user_ids: [] }] });
    await expectForeignUnchanged(before);
    await expect(unrelatedStaleSnapshot()).resolves.toEqual(unrelatedBefore);
});

test('late external identity and membership projection both reconcile their assignment chain tenant-locally', async () => {
    const before = await foreignSnapshot();
    const unrelatedBefore = await unrelatedStaleSnapshot();
    const { rows: jobs } = await db.query(
        `INSERT INTO jobs
            (company_id, blanc_status, assigned_techs, assigned_provider_user_ids)
         VALUES ($1, 'Submitted', $2::jsonb, '[]'::jsonb)
         RETURNING id`,
        [companyA, JSON.stringify([{ id: lateExternalId, name: 'Historical Identity Tech A' }])]
    );

    await directoryQueries.upsertExternalIdentity({
        companyId: companyA,
        source: 'zenbooker',
        externalId: lateExternalId,
        technicianId: identityTechA,
    });
    await expect(db.query(
        `SELECT assigned_provider_user_ids FROM jobs
         WHERE id = $1 AND company_id = $2`,
        [jobs[0].id, companyA]
    )).resolves.toMatchObject({ rows: [{ assigned_provider_user_ids: [identityUserA] }] });
    await expect(unrelatedStaleSnapshot()).resolves.toEqual(unrelatedBefore);

    await db.query(
        `UPDATE company_memberships
         SET status = 'inactive'
         WHERE company_id = $1 AND user_id = $2`,
        [companyA, identityUserA]
    );
    await directoryService.projectFromMemberships(companyA);
    await expect(db.query(
        `SELECT assigned_provider_user_ids FROM jobs
         WHERE id = $1 AND company_id = $2`,
        [jobs[0].id, companyA]
    )).resolves.toMatchObject({ rows: [{ assigned_provider_user_ids: [] }] });
    await expectForeignUnchanged(before);
});

afterAll(async () => {
    try {
        await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    } finally {
        eventEmitSpy?.mockRestore();
        if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
        else process.env.PGOPTIONS = previousPgOptions;
        try { require('../backend/src/services/realtimeService').stopKeepAlive(); } catch (_) { /* ignore */ }
        try { await db.pool.end(); } catch (_) { /* already closed */ }
    }
});
