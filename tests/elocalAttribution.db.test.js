'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const elocalQueries = require('../backend/src/db/elocalQueries');
const { configureCompany } = require(
    '../backend/src/services/elocalConnectionService'
);
const { matchCompany } = require(
    '../backend/src/services/elocalAttributionService'
);

jest.setTimeout(90000);

function migration(name) {
    return fs.readFileSync(path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        name
    ), 'utf8');
}

const MIGRATIONS = [
    migration('213_lead_channel_analytics_foundation.sql'),
    migration('214_google_ads_connector.sql'),
    migration('251_google_lsa_attribution.sql'),
    migration('252_elocal_attribution.sql'),
];
const ELOCAL_MIGRATION = MIGRATIONS.at(-1);
const ELOCAL_ROLLBACK = migration('rollback_252_elocal_attribution.sql');
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const TAG = `elocal-db-${Date.now()}-${process.pid}`;
const PHONE_SHARED = `+1617${String(Date.now()).slice(-7)}`;
const PHONE_GUARD = `+1781${String(Date.now() + 1).slice(-7)}`;
const NOW = new Date('2026-08-14T16:00:00.000Z');
const LEASE = new Date('2026-08-14T16:10:00.000Z');

let connectionA;
let connectionB;
let contactA1;
let contactA2;
let contactGuard;
let contactB;
let jobA1;
let jobA2;
let dbReady = false;

function probeDatabase() {
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_USE_SYSTEM_CA;
    const pgModule = require.resolve('pg');
    const script = `
        const { Client } = require(${JSON.stringify(pgModule)});
        const client = new Client({
            connectionString: process.env.DATABASE_URL
                || 'postgresql://localhost/twilio_calls',
            connectionTimeoutMillis: 2000,
        });
        (async () => {
            try {
                await client.connect();
                await client.query('SELECT 1');
                await client.end();
                process.exit(0);
            } catch (error) {
                process.stderr.write(String(error.message || error));
                try { await client.end(); } catch {}
                process.exit(2);
            }
        })();`;
    const result = spawnSync(process.execPath, ['--use-bundled-ca', '-e', script], {
        env: probeEnv,
        encoding: 'utf8',
        timeout: 6000,
    });
    return {
        ready: result.status === 0,
        reason: String(
            result.stderr || result.error?.message || `probe exit ${result.status}`
        ).trim(),
    };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    test('ELOCAL DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`ELOCAL DB tests are pending: ${DATABASE.reason}`);
    });
}

async function insertCompany(companyId, suffix) {
    await db.query(
        `INSERT INTO companies (id, name, slug, timezone)
         VALUES ($1, $2, $3, 'America/New_York')`,
        [companyId, `${TAG} ${suffix}`, `${TAG}-${suffix}`]
    );
}

async function insertContact(companyId, name, phone) {
    const { rows } = await db.query(
        `INSERT INTO contacts (company_id, full_name, phone_e164)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [companyId, name, phone]
    );
    return rows[0].id;
}

async function insertJob(companyId, contactId, suffix, createdAt) {
    const { rows } = await db.query(
        `INSERT INTO jobs (
             company_id,
             contact_id,
             job_number,
             blanc_status,
             created_at,
             updated_at
         )
         VALUES ($1, $2, $3, 'Submitted', $4, $4)
         RETURNING id`,
        [companyId, contactId, `${TAG}-${suffix}`, createdAt]
    );
    return rows[0].id;
}

async function insertCall({ companyId, contactId, phone, suffix, startedAt }) {
    const { rows } = await db.query(
        `INSERT INTO calls (
             call_sid,
             company_id,
             contact_id,
             from_number,
             direction,
             status,
             is_final,
             started_at
         )
         VALUES ($1, $2, $3, $4, 'inbound', 'completed', true, $5)
         RETURNING id`,
        [`CA${TAG}${suffix}`, companyId, contactId, phone, startedAt]
    );
    return rows[0].id;
}

async function insertProviderLead({
    companyId = COMPANY_A,
    connectionId = connectionA.id,
    suffix,
    phone,
    callAt,
}) {
    const { rows } = await db.query(
        `INSERT INTO elocal_leads (
             company_id,
             connection_id,
             campaign_id,
             external_call_id,
             caller_phone_e164,
             normalized_phone,
             cost_cents,
             supply_event_status,
             billable,
             call_at
         )
         VALUES (
             $1, $2, $3, $4, $5, RIGHT($5, 10), 1000,
             'BILLABLE', true, $6
         )
         RETURNING id`,
        [
            companyId,
            connectionId,
            `${TAG}-campaign`,
            `${TAG}-${suffix}`,
            phone,
            callAt,
        ]
    );
    return rows[0].id;
}

async function setupFixtures() {
    for (const sql of MIGRATIONS) {
        await db.query(sql);
        await db.query(sql);
    }
    await insertCompany(COMPANY_A, 'a');
    await insertCompany(COMPANY_B, 'b');

    connectionA = await configureCompany({
        companyId: COMPANY_A,
        campaignIds: ['campaign-a', 'campaign-b', 'campaign-a'],
    });
    connectionB = await configureCompany({
        companyId: COMPANY_B,
        campaignIds: ['campaign-b'],
    });
    const replayed = await configureCompany({
        companyId: COMPANY_A,
        campaignIds: ['campaign-a', 'campaign-b', 'campaign-a'],
    });
    expect(replayed.id).toBe(connectionA.id);
    expect(replayed.campaign_ids).toEqual(['campaign-a', 'campaign-b']);

    const claimedA = await elocalQueries.claimConnection(
        COMPANY_A,
        connectionA.id,
        NOW,
        LEASE
    );
    expect(claimedA.id).toBe(connectionA.id);

    contactA1 = await insertContact(COMPANY_A, 'Own one', PHONE_SHARED);
    contactA2 = await insertContact(COMPANY_A, 'Own duplicate', PHONE_SHARED);
    contactGuard = await insertContact(COMPANY_A, 'Guard contact', PHONE_GUARD);
    contactB = await insertContact(COMPANY_B, 'Foreign', PHONE_SHARED);
    jobA1 = await insertJob(
        COMPANY_A,
        contactA1,
        'job-a1',
        '2026-08-10T16:00:00Z'
    );
    jobA2 = await insertJob(
        COMPANY_A,
        contactA2,
        'job-a2',
        '2026-08-10T16:05:00Z'
    );
    await insertJob(COMPANY_B, contactB, 'job-b', '2026-08-10T16:00:00Z');
}

async function cleanupFixtures() {
    const companyIds = [COMPANY_A, COMPANY_B];
    await db.query(
        'DELETE FROM elocal_connections WHERE company_id = ANY($1::UUID[])',
        [companyIds]
    );
    await db.query(
        'DELETE FROM calls WHERE company_id = ANY($1::UUID[])',
        [companyIds]
    );
    await db.query(
        'DELETE FROM jobs WHERE company_id = ANY($1::UUID[])',
        [companyIds]
    );
    await db.query(
        'DELETE FROM contacts WHERE company_id = ANY($1::UUID[])',
        [companyIds]
    );
    await db.query(
        'DELETE FROM lead_source_aliases WHERE company_id = ANY($1::UUID[])',
        [companyIds]
    );
    await db.query(
        'DELETE FROM lead_source_channels WHERE company_id = ANY($1::UUID[])',
        [companyIds]
    );
    await db.query(
        'DELETE FROM companies WHERE id = ANY($1::UUID[])',
        [companyIds]
    );
}

beforeAll(async () => {
    if (!DATABASE.ready) return;
    await setupFixtures();
    dbReady = true;
});

afterAll(async () => {
    if (dbReady) {
        try {
            await cleanupFixtures();
        } catch (error) {
            console.warn('[elocalAttribution.db] cleanup failed:', error.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* already closed */ }
});

describe('ELOCAL-ATTRIBUTION-001 real PostgreSQL mechanism and matcher', () => {
    databaseTest('merges the exact duplicate channels and rollback restores them', async () => {
        const duplicates = await db.query(
            `INSERT INTO lead_source_channels (
                 company_id,
                 channel_key,
                 display_name,
                 is_active
             )
             VALUES
                ($1, 'source_04a1ea464d394d519efd30a5988341f8',
                 'Elocal', true),
                ($1, 'source_88cdf671ddacd95240fc98b1eef48ec2',
                 'eLocals', true)
             RETURNING id, channel_key`,
            [COMPANY_B]
        );
        const duplicateByKey = new Map(
            duplicates.rows.map(row => [row.channel_key, row.id])
        );
        await db.query(
            `INSERT INTO lead_source_aliases (
                 company_id,
                 channel_id,
                 normalized_source,
                 raw_source
             )
             VALUES
                ($1, $2, 'elocal', 'Elocal'),
                ($1, $3, 'elocals', 'eLocals')`,
            [
                COMPANY_B,
                duplicateByKey.get('source_04a1ea464d394d519efd30a5988341f8'),
                duplicateByKey.get('source_88cdf671ddacd95240fc98b1eef48ec2'),
            ]
        );
        await db.query(ELOCAL_MIGRATION);

        const merged = await db.query(
            `SELECT
                 channel.channel_key,
                 channel.is_active,
                 alias.channel_id,
                 canonical.id AS canonical_id
             FROM lead_source_channels channel
             JOIN lead_source_aliases alias
               ON alias.company_id = channel.company_id
              AND alias.channel_id <> channel.id
              AND alias.normalized_source = CASE
                    WHEN channel.channel_key =
                        'source_04a1ea464d394d519efd30a5988341f8'
                        THEN 'elocal'
                    ELSE 'elocals'
                  END
             JOIN lead_source_channels canonical
               ON canonical.company_id = channel.company_id
              AND canonical.channel_key = 'elocal'
             WHERE channel.company_id = $1
               AND channel.channel_key IN (
                    'source_04a1ea464d394d519efd30a5988341f8',
                    'source_88cdf671ddacd95240fc98b1eef48ec2'
               )
             ORDER BY channel.channel_key`,
            [COMPANY_B]
        );
        expect(merged.rows).toHaveLength(2);
        expect(merged.rows.every(row => row.is_active === false)).toBe(true);
        expect(merged.rows.every(
            row => row.channel_id === row.canonical_id
        )).toBe(true);

        const baseEntityDependencies = await db.query(
            `SELECT
                 constraint_row.conname,
                 dependency.refobjid::REGCLASS::TEXT AS dependency
             FROM pg_constraint constraint_row
             JOIN pg_depend dependency
               ON dependency.classid = 'pg_constraint'::REGCLASS
              AND dependency.objid = constraint_row.oid
             WHERE constraint_row.conname IN (
                    'elocal_leads_company_contact_fk',
                    'elocal_leads_company_lead_fk',
                    'elocal_leads_company_call_fk',
                    'elocal_job_attributions_job_fk',
                    'elocal_job_attributions_contact_fk',
                    'elocal_job_attributions_call_fk',
                    'elocal_job_attributions_crm_lead_fk'
               )
               AND dependency.refobjid IN (
                    SELECT indexrelid
                    FROM pg_index
                    WHERE indrelid IN (
                        'calls'::REGCLASS,
                        'contacts'::REGCLASS,
                        'leads'::REGCLASS,
                        'jobs'::REGCLASS
                    )
               )
             ORDER BY constraint_row.conname`,
        );
        expect(baseEntityDependencies.rows).toEqual([
            {
                conname: 'elocal_job_attributions_call_fk',
                dependency: 'calls_pkey',
            },
            {
                conname: 'elocal_job_attributions_contact_fk',
                dependency: 'contacts_pkey',
            },
            {
                conname: 'elocal_job_attributions_crm_lead_fk',
                dependency: 'leads_pkey',
            },
            {
                conname: 'elocal_job_attributions_job_fk',
                dependency: 'jobs_pkey',
            },
            {
                conname: 'elocal_leads_company_call_fk',
                dependency: 'calls_pkey',
            },
            {
                conname: 'elocal_leads_company_contact_fk',
                dependency: 'contacts_pkey',
            },
            {
                conname: 'elocal_leads_company_lead_fk',
                dependency: 'leads_pkey',
            },
        ]);

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(ELOCAL_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT is_active
                 FROM lead_source_channels
                 WHERE company_id = $1
                   AND channel_key IN (
                        'source_04a1ea464d394d519efd30a5988341f8',
                        'source_88cdf671ddacd95240fc98b1eef48ec2'
                   )`,
                [COMPANY_B]
            );
            expect(rolledBack.rows).toHaveLength(2);
            expect(rolledBack.rows.every(row => row.is_active === true)).toBe(true);
            const tables = await client.query(
                `SELECT
                    TO_REGCLASS('public.elocal_connections') AS connections,
                    TO_REGCLASS('public.elocal_leads') AS leads,
                    TO_REGCLASS('public.elocal_job_attributions') AS attributions`
            );
            expect(tables.rows[0]).toEqual({
                connections: null,
                leads: null,
                attributions: null,
            });
            await client.query('ROLLBACK');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    });

    databaseTest('dedupes external call id during leased upsert', async () => {
        const row = {
            campaign_id: 'campaign-a',
            external_call_id: `${TAG}-deduped-call`,
            caller_phone_e164: PHONE_GUARD,
            normalized_phone: PHONE_GUARD.slice(-10),
            cost_cents: 2500,
            supply_event_status: 'BILLABLE',
            supply_event_status_reason: 'qualified',
            billable: true,
            call_at: '2026-08-01T14:00:00Z',
            service_zip_code: '02108',
            service_city: 'Boston',
            service_state_abbr: 'MA',
            campaign_name: 'Boston - CALL',
            category_name: 'Plumbing',
            call_duration_seconds: 60,
            call_quality_tags: [],
            forwarding_number: null,
            external_campaign_id: 'external',
            lead_source_id: 'source',
        };
        await elocalQueries.commitCallsChunk({
            companyId: COMPANY_A,
            connectionId: connectionA.id,
            rows: [row, { ...row, campaign_id: 'campaign-b' }],
            chunkStart: '2026-08-01',
            chunkEnd: '2026-08-01',
            now: NOW,
            expectedLeaseExpiresAt: LEASE,
        });

        const { rows } = await db.query(
            `SELECT COUNT(*)::INTEGER AS count, MAX(campaign_id) AS campaign_id
             FROM elocal_leads
             WHERE company_id = $1
               AND external_call_id = $2`,
            [COMPANY_A, row.external_call_id]
        );
        expect(rows[0]).toEqual({ count: 1, campaign_id: 'campaign-b' });
    });

    databaseTest('matches nearby evidence, expands duplicate contacts, guards time, and fails ambiguity closed', async () => {
        const directLead = await insertProviderLead({
            suffix: 'direct',
            phone: PHONE_SHARED,
            callAt: '2026-08-10T14:00:00Z',
        });
        const guardLead = await insertProviderLead({
            suffix: 'guard',
            phone: PHONE_GUARD,
            callAt: '2026-08-12T14:00:00Z',
        });
        const ambiguousLead = await insertProviderLead({
            suffix: 'ambiguous',
            phone: PHONE_SHARED,
            callAt: '2026-08-11T14:00:00Z',
        });
        await insertCall({
            companyId: COMPANY_A,
            contactId: contactA1,
            phone: PHONE_SHARED,
            suffix: 'direct',
            startedAt: '2026-08-10T14:01:00Z',
        });
        await insertCall({
            companyId: COMPANY_A,
            contactId: contactGuard,
            phone: PHONE_GUARD,
            suffix: 'guard',
            startedAt: '2026-08-12T14:16:00Z',
        });
        await Promise.all([
            insertCall({
                companyId: COMPANY_A,
                contactId: contactA1,
                phone: PHONE_SHARED,
                suffix: 'ambiguous-1',
                startedAt: '2026-08-11T14:00:00Z',
            }),
            insertCall({
                companyId: COMPANY_A,
                contactId: contactA2,
                phone: PHONE_SHARED,
                suffix: 'ambiguous-2',
                startedAt: '2026-08-11T14:00:00Z',
            }),
            insertCall({
                companyId: COMPANY_B,
                contactId: contactB,
                phone: PHONE_SHARED,
                suffix: 'foreign',
                startedAt: '2026-08-10T14:00:00Z',
            }),
        ]);

        const result = await matchCompany({
            companyId: COMPANY_A,
            connectionId: connectionA.id,
            expectedLeaseExpiresAt: LEASE,
            now: NOW,
        });
        expect(result).toEqual({ matchedLeads: 1, attributedJobs: 2 });

        const matches = await db.query(
            `SELECT id, match_status, match_method, matched_contact_id
             FROM elocal_leads
             WHERE company_id = $1
               AND id = ANY($2::UUID[])`,
            [COMPANY_A, [directLead, guardLead, ambiguousLead]]
        );
        const byId = new Map(matches.rows.map(row => [row.id, row]));
        expect(byId.get(directLead)).toMatchObject({
            match_status: 'matched',
            match_method: 'nearby_call_contact',
            matched_contact_id: contactA1,
        });
        expect(byId.get(guardLead)).toMatchObject({
            match_status: 'diagnostic',
            match_method: 'phone_only',
            matched_contact_id: null,
        });
        expect(byId.get(ambiguousLead)).toMatchObject({
            match_status: 'ambiguous',
            match_method: null,
            matched_contact_id: null,
        });

        const attributions = await db.query(
            `SELECT elocal_lead_id, matched_job_id, matched_contact_id
             FROM elocal_job_attributions
             WHERE company_id = $1
             ORDER BY matched_job_id`,
            [COMPANY_A]
        );
        expect(attributions.rows).toEqual([
            {
                elocal_lead_id: directLead,
                matched_job_id: jobA1,
                matched_contact_id: contactA1,
            },
            {
                elocal_lead_id: directLead,
                matched_job_id: jobA2,
                matched_contact_id: contactA2,
            },
        ]);
        expect(new Set(attributions.rows.map(row => row.matched_job_id)).size)
            .toBe(attributions.rows.length);
    });

    databaseTest('T-own/T-foreign/T-blast keep same-phone provider state tenant-scoped', async () => {
        const foreignLead = await insertProviderLead({
            companyId: COMPANY_B,
            connectionId: connectionB.id,
            suffix: 'foreign-provider',
            phone: PHONE_SHARED,
            callAt: '2026-08-10T14:00:00Z',
        });
        await expect(matchCompany({
            companyId: COMPANY_A,
            connectionId: connectionB.id,
            expectedLeaseExpiresAt: LEASE,
            now: NOW,
        })).rejects.toMatchObject({ code: 'SYNC_CLAIM_LOST' });

        const foreign = await db.query(
            `SELECT match_status
             FROM elocal_leads
             WHERE company_id = $1
               AND id = $2`,
            [COMPANY_B, foreignLead]
        );
        expect(foreign.rows[0].match_status).toBe('pending');

        const blast = await db.query(
            `SELECT COUNT(*)::INTEGER AS count
             FROM elocal_job_attributions attribution
             JOIN jobs job
               ON job.company_id = attribution.company_id
              AND job.id = attribution.matched_job_id
             WHERE attribution.company_id = $1
               AND job.company_id = $1`,
            [COMPANY_A]
        );
        expect(blast.rows[0].count).toBe(2);
    });
});
