'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const analytics = require('../backend/src/services/leadChannelAnalyticsService');
const analyticsRouter = require('../backend/src/routes/leadChannelAnalytics');
const { requirePermission } = require('../backend/src/middleware/authorization');

jest.setTimeout(90000);

const MIGRATION = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        '213_lead_channel_analytics_foundation.sql'
    ),
    'utf8'
);
const CONNECTOR_MIGRATION = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        '214_google_ads_connector.sql'
    ),
    'utf8'
);
const LSA_MIGRATION = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        '251_google_lsa_attribution.sql'
    ),
    'utf8'
);
const ELOCAL_MIGRATION = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        '252_elocal_attribution.sql'
    ),
    'utf8'
);

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const TECH_A_1 = randomUUID();
const TECH_A_2 = randomUUID();
const TECH_B = randomUUID();
const TAG = `lca-${Date.now()}-${process.pid}`;
const SHARED_PHONE = `+1555${String(Date.now()).slice(-7)}`;
const FROM = '2026-07-01';
const TO = '2026-07-31';
const SEEDED_GOOGLE_ADS_KEY = `source_${
    createHash('md5').update('google ads').digest('hex')
}`;

let contactA;
let contactB;
let leadA;
let leadB;
let jobA;
let jobB;
let dbReady = false;

function probeDatabase() {
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_USE_SYSTEM_CA;
    const pgModule = require.resolve('pg');
    const script = `
        const { Client } = require(${JSON.stringify(pgModule)});
        const client = new Client({
            connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls',
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
    test('LEAD-CHANNEL-ANALYTICS DB release blocker: PostgreSQL must be available', () => {
        throw new Error(
            `LEAD-CHANNEL-ANALYTICS DB tests are pending: ${DATABASE.reason}`
        );
    });
}

function responseDouble() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function routeHandler(pathname) {
    const layer = analyticsRouter.stack.find(
        item => item.route?.path === pathname
    );
    if (!layer) throw new Error(`Missing route handler for ${pathname}`);
    return layer.route.stack[0].handle;
}

async function invokeEndpoint(companyId, pathname, query) {
    const req = {
        method: 'GET',
        originalUrl: `/api/lead-channel-analytics${pathname}`,
        query,
        user: { crmUser: { id: TECH_A_1 } },
        authz: {
            scope: 'tenant',
            permissions: ['reports.financial.view', 'lead_source.view'],
        },
        companyFilter: { company_id: companyId },
        companyId: COMPANY_B,
    };
    const res = responseDouble();
    const gates = [
        requirePermission('reports.financial.view'),
        requirePermission('lead_source.view'),
    ];
    for (const gate of gates) {
        let allowed = false;
        gate(req, res, () => { allowed = true; });
        if (!allowed) return res;
    }
    await routeHandler(pathname)(req, res);
    return res;
}

async function insertFixtures() {
    await db.query(
        `INSERT INTO companies (id, name, slug, timezone)
         VALUES
            ($1, $2, $3, 'America/New_York'),
            ($4, $5, $6, 'America/New_York')`,
        [
            COMPANY_A,
            `${TAG} Company A`,
            `${TAG}-company-a`,
            COMPANY_B,
            `${TAG} Company B`,
            `${TAG}-company-b`,
        ]
    );

    const contacts = await db.query(
        `INSERT INTO contacts (company_id, full_name, phone_e164)
         VALUES
            ($1, 'Analytics Customer A', $3),
            ($2, 'Analytics Customer B', $3)
         RETURNING id, company_id`,
        [COMPANY_A, COMPANY_B, SHARED_PHONE]
    );
    contactA = contacts.rows.find(row => row.company_id === COMPANY_A).id;
    contactB = contacts.rows.find(row => row.company_id === COMPANY_B).id;

    await db.query(
        `INSERT INTO crm_users
            (id, keycloak_sub, email, full_name, role, company_id)
         VALUES
            ($1, $2, 'ada@example.test', 'Ada Technician', 'company_member', $3),
            ($4, $5, 'grace@example.test', 'Grace Technician', 'company_member', $3),
            ($6, $7, 'foreign@example.test', 'Foreign Technician', 'company_member', $8)`,
        [
            TECH_A_1,
            `${TAG}-tech-a-1`,
            COMPANY_A,
            TECH_A_2,
            `${TAG}-tech-a-2`,
            TECH_B,
            `${TAG}-tech-b`,
            COMPANY_B,
        ]
    );

    const leads = await db.query(
        `INSERT INTO leads
            (uuid, company_id, contact_id, first_name, phone, postal_code,
             job_source, status, converted_to_job, created_at, updated_at)
         VALUES
            ($1, $2, $3, 'Customer A', $4, '02108', 'Google Ads',
             'Converted', true, '2026-07-10T14:00:00Z', '2026-07-10T15:00:00Z'),
            ($5, $6, $7, 'Customer B', $4, '02108', 'Google Ads',
             'Converted', true, '2026-07-10T14:00:00Z', '2026-07-10T15:00:00Z')
         RETURNING id, company_id`,
        [
            `${TAG.slice(-12)}a`,
            COMPANY_A,
            contactA,
            SHARED_PHONE,
            `${TAG.slice(-12)}b`,
            COMPANY_B,
            contactB,
        ]
    );
    leadA = leads.rows.find(row => row.company_id === COMPANY_A).id;
    leadB = leads.rows.find(row => row.company_id === COMPANY_B).id;

    const jobs = await db.query(
        `INSERT INTO jobs
            (lead_id, contact_id, company_id, zenbooker_job_id, blanc_status,
             assigned_provider_user_ids, created_at, updated_at)
         VALUES
            ($1, $2, $3, $4, 'Job is Done', $5::jsonb,
             '2026-07-11T14:00:00Z', '2026-07-12T14:00:00Z'),
            ($6, $7, $8, $9, 'Job is Done', $10::jsonb,
             '2026-07-11T14:00:00Z', '2026-07-12T14:00:00Z')
         RETURNING id, company_id`,
        [
            leadA,
            contactA,
            COMPANY_A,
            `${TAG}-zb-job-a`,
            JSON.stringify([TECH_A_1, TECH_A_2, TECH_A_1]),
            leadB,
            contactB,
            COMPANY_B,
            `${TAG}-zb-job-b`,
            JSON.stringify([TECH_B]),
        ]
    );
    jobA = jobs.rows.find(row => row.company_id === COMPANY_A).id;
    jobB = jobs.rows.find(row => row.company_id === COMPANY_B).id;

    await db.query(
        `INSERT INTO service_territories (company_id, zip, area, city, state)
         VALUES
            ($1, '02108', 'Downtown', 'Boston', 'MA'),
            ($2, '02108', 'Foreign Area', 'Boston', 'MA')`,
        [COMPANY_A, COMPANY_B]
    );

    const invoices = await db.query(
        `INSERT INTO invoices
            (company_id, invoice_number, status, contact_id, job_id,
             subtotal, total, amount_paid, balance_due)
         VALUES
            ($1, $2, 'paid', $3, $4, 100.00, 100.00, 100.00, 0),
            ($5, $6, 'paid', $7, $8, 999.99, 999.99, 999.99, 0)
         RETURNING id, company_id`,
        [
            COMPANY_A,
            `${TAG}-INV-A`,
            contactA,
            jobA,
            COMPANY_B,
            `${TAG}-INV-B`,
            contactB,
            jobB,
        ]
    );
    const invoiceA = invoices.rows.find(row => row.company_id === COMPANY_A).id;
    const invoiceB = invoices.rows.find(row => row.company_id === COMPANY_B).id;

    await db.query(
        `INSERT INTO payment_transactions
            (company_id, contact_id, invoice_id, job_id, transaction_type,
             payment_method, status, amount, processed_at, external_source)
         VALUES
            ($1, $2, $3, $4, 'payment', 'cash', 'completed', 100.00,
             '2026-07-15T14:00:00Z', 'analytics-test'),
            ($1, $2, NULL, $4, 'payment', 'cash', 'completed', 12.34,
             '2026-07-16T14:00:00Z', 'analytics-test-standalone'),
            ($5, $6, $7, $8, 'payment', 'cash', 'completed', 999.99,
             '2026-07-15T14:00:00Z', 'analytics-test'),
            ($5, $6, NULL, $8, 'payment', 'cash', 'completed', 88.88,
             '2026-07-16T14:00:00Z', 'analytics-test-standalone')`,
        [
            COMPANY_A,
            contactA,
            invoiceA,
            jobA,
            COMPANY_B,
            contactB,
            invoiceB,
            jobB,
        ]
    );

    await db.query(
        `INSERT INTO calls
            (call_sid, contact_id, direction, status, is_final, started_at,
             price, price_unit, company_id)
         VALUES
            ($1, $2, 'inbound', 'completed', true,
             '2026-07-09T14:00:00Z', -1.24, 'USD', $3),
            ($4, $5, 'inbound', 'completed', true,
             '2026-07-09T14:00:00Z', -9.99, 'USD', $6)`,
        [
            `CA${TAG}A`,
            contactA,
            COMPANY_A,
            `CA${TAG}B`,
            contactB,
            COMPANY_B,
        ]
    );

    // Replay after the leads exist so deterministic historical aliases are
    // seeded. Double application is an explicit migration contract.
    await db.query(MIGRATION);
    await db.query(MIGRATION);
}

async function cleanupFixtures() {
    const companyIds = [COMPANY_A, COMPANY_B];
    await db.query('DELETE FROM calls WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query(
        'DELETE FROM payment_transactions WHERE company_id = ANY($1::uuid[])',
        [companyIds]
    );
    await db.query('DELETE FROM invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query('DELETE FROM jobs WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query('DELETE FROM leads WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query(
        'DELETE FROM service_territories WHERE company_id = ANY($1::uuid[])',
        [companyIds]
    );
    await db.query('DELETE FROM crm_users WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query('DELETE FROM contacts WHERE company_id = ANY($1::uuid[])', [companyIds]);
    await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
}

async function resetSpendFixtures() {
    const companyIds = [COMPANY_A, COMPANY_B];
    await db.query(
        `DELETE FROM elocal_connections
         WHERE company_id = ANY($1::uuid[])`,
        [companyIds]
    );
    await db.query(
        `DELETE FROM lead_source_performance_daily
         WHERE company_id = ANY($1::uuid[])`,
        [companyIds]
    );
    await db.query(
        `DELETE FROM google_ads_connections
         WHERE company_id = ANY($1::uuid[])`,
        [companyIds]
    );
    await db.query(
        `DELETE FROM payment_transactions
         WHERE company_id = ANY($1::uuid[])
           AND external_source LIKE $2`,
        [companyIds, `${TAG}-phase3%`]
    );
    await db.query(
        `DELETE FROM jobs
         WHERE company_id = ANY($1::uuid[])
           AND job_number LIKE $2`,
        [companyIds, `${TAG}-phase3%`]
    );
    await db.query(
        `DELETE FROM leads
         WHERE company_id = ANY($1::uuid[])
           AND first_name = 'Phase 3 Analytics'`,
        [companyIds]
    );
    await db.query(
        `DELETE FROM leads
         WHERE company_id = $1
           AND first_name = 'Phase B Allocation'`,
        [COMPANY_A]
    );
    await db.query(
        `UPDATE leads
         SET gclid = NULL
         WHERE company_id = ANY($1::uuid[])`,
        [companyIds]
    );
    await db.query(
        `DELETE FROM lead_source_channels
         WHERE company_id = ANY($1::uuid[])
           AND channel_key IN ('google_ads', 'elocal', 'phase_b_zero_lead')`,
        [companyIds]
    );
}

async function ensureChannel(
    companyId,
    channelKey = 'google_ads',
    displayName = 'Google Ads',
    isActive = true
) {
    const { rows } = await db.query(
        `INSERT INTO lead_source_channels (
             company_id,
             channel_key,
             display_name,
             is_active
         )
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, channel_key) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             is_active = EXCLUDED.is_active,
             updated_at = NOW()
         RETURNING id`,
        [companyId, channelKey, displayName, isActive]
    );
    return rows[0].id;
}

async function seedSpend(
    companyId,
    channelId,
    costMicros,
    campaignId = 'shared-campaign',
    campaignName = 'Shared campaign label'
) {
    await db.query(
        `INSERT INTO lead_source_performance_daily (
             company_id,
             provider_key,
             external_account_id,
             external_campaign_id,
             external_campaign_name,
             channel_id,
             performance_date,
             cost_micros
         )
         VALUES (
             $1,
             'google_ads',
             'shared-account',
             $2,
             $5,
             $3,
             '2026-07-10',
             $4
         )`,
        [companyId, campaignId, channelId, costMicros, campaignName]
    );
}

async function markLeadAsGoogleClick(leadId, companyId) {
    await db.query(
        `UPDATE leads
         SET gclid = $1
         WHERE id = $2
           AND company_id = $3`,
        [`${TAG}-gclid`, leadId, companyId]
    );
}

async function seedLsaConnection(companyId, channelId, customerId) {
    const { rows } = await db.query(
        `INSERT INTO google_ads_connections (
             company_id,
             channel_id,
             customer_id,
             status,
             last_sync_status,
             account_timezone
         )
         VALUES ($1, $2, $3, 'connected', 'ok', 'America/New_York')
         RETURNING id`,
        [companyId, channelId, customerId]
    );
    return rows[0].id;
}

async function seedMatchedLsaLead({
    companyId,
    connectionId,
    contactId,
    leadId,
    externalId,
    providerCreatedAt = '2026-07-10T14:00:00Z',
}) {
    const { rows } = await db.query(
        `INSERT INTO google_lsa_leads (
             company_id,
             connection_id,
             external_account_id,
             external_lead_id,
             resource_name,
             lead_type,
             phone_e164,
             normalized_phone,
             provider_created_at,
             provider_creation_date_time,
             match_status,
             matched_contact_id,
             matched_lead_id,
             match_method,
             match_confidence,
             matched_at
         )
         VALUES (
             $1,
             $2,
             $3,
             $4,
             $5,
             'PHONE_CALL',
             $6,
             RIGHT($6, 10),
             $7,
             '2026-07-10 10:00:00.000000',
             'matched',
             $8,
             $9,
             'nearby_call_contact',
             100,
             $7
         )
         RETURNING id`,
        [
            companyId,
            connectionId,
            `account-${externalId}`,
            externalId,
            `customers/analytics/localServicesLeads/${externalId}`,
            SHARED_PHONE,
            providerCreatedAt,
            contactId,
            leadId,
        ]
    );
    return rows[0].id;
}

async function attributeLsaJob({ companyId, lsaLeadId, jobId, contactId, leadId }) {
    await db.query(
        `INSERT INTO google_lsa_job_attributions (
             company_id,
             lsa_lead_id,
             matched_job_id,
             matched_contact_id,
             evidence_lead_id,
             match_method,
             match_confidence
         )
         VALUES ($1, $2, $3, $4, $5, 'nearby_call_contact', 100)`,
        [companyId, lsaLeadId, jobId, contactId, leadId]
    );
}

async function seedElocalConnection(companyId, channelId, suffix) {
    const { rows } = await db.query(
        `INSERT INTO elocal_connections (
             company_id,
             channel_id,
             campaign_ids,
             api_key_reference,
             status,
             last_sync_status
         )
         VALUES ($1, $2, $3::TEXT[], 'ELOCAL_API_KEY', 'connected', 'ok')
         RETURNING id`,
        [companyId, channelId, [`${TAG}-campaign-${suffix}`]]
    );
    return rows[0].id;
}

async function seedElocalLead({
    companyId,
    connectionId,
    contactId,
    leadId,
    suffix,
    billable,
    costCents,
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
             call_at,
             match_status,
             matched_contact_id,
             matched_lead_id,
             match_method,
             match_confidence,
             matched_at
         )
         VALUES (
             $1,
             $2,
             $3,
             $4,
             $5,
             RIGHT($5, 10),
             $6,
             $7,
             $8,
             '2026-07-10T14:00:00Z',
             'matched',
             $9,
             $10,
             'nearby_call_contact',
             100,
             '2026-07-10T14:00:00Z'
         )
         RETURNING id`,
        [
            companyId,
            connectionId,
            `${TAG}-campaign-${suffix}`,
            `${TAG}-call-${suffix}`,
            SHARED_PHONE,
            costCents,
            billable ? 'BILLABLE' : 'UNBILLABLE',
            billable,
            contactId,
            leadId,
        ]
    );
    return rows[0].id;
}

async function attributeElocalJob({
    companyId,
    elocalLeadId,
    jobId,
    contactId,
    leadId,
}) {
    await db.query(
        `INSERT INTO elocal_job_attributions (
             company_id,
             elocal_lead_id,
             matched_job_id,
             matched_contact_id,
             evidence_lead_id,
             match_method,
             match_confidence
         )
         VALUES ($1, $2, $3, $4, $5, 'nearby_call_contact', 100)`,
        [companyId, elocalLeadId, jobId, contactId, leadId]
    );
}

async function seedPhase3Job({
    companyId,
    contactId,
    leadId = null,
    suffix,
    zbStatus = 'scheduled',
    amount = null,
}) {
    const { rows } = await db.query(
        `INSERT INTO jobs (
             company_id,
             contact_id,
             lead_id,
             job_number,
             blanc_status,
             zb_status,
             created_at,
             updated_at
         )
         VALUES (
             $1,
             $2,
             $3,
             $4,
             'Submitted',
             $5,
             '2026-08-05T14:00:00Z',
             '2026-08-05T14:00:00Z'
         )
         RETURNING id`,
        [companyId, contactId, leadId, `${TAG}-phase3-${suffix}`, zbStatus]
    );
    const jobId = rows[0].id;
    if (amount !== null) {
        await db.query(
            `INSERT INTO payment_transactions (
                 company_id,
                 contact_id,
                 job_id,
                 transaction_type,
                 payment_method,
                 status,
                 amount,
                 processed_at,
                 external_source
             )
             VALUES (
                 $1,
                 $2,
                 $3,
                 'payment',
                 'cash',
                 'completed',
                 $4,
                 '2026-08-06T14:00:00Z',
                 $5
             )`,
            [companyId, contactId, jobId, amount, `${TAG}-phase3-${suffix}`]
        );
    }
    return jobId;
}

beforeAll(async () => {
    if (!DATABASE.ready) return;
    await db.query(MIGRATION);
    await db.query(MIGRATION);
    await db.query(CONNECTOR_MIGRATION);
    await db.query(CONNECTOR_MIGRATION);
    await db.query(LSA_MIGRATION);
    await db.query(LSA_MIGRATION);
    await db.query(ELOCAL_MIGRATION);
    await db.query(ELOCAL_MIGRATION);
    await insertFixtures();
    dbReady = true;
});

beforeEach(async () => {
    if (dbReady) await resetSpendFixtures();
});

afterEach(async () => {
    if (dbReady) await resetSpendFixtures();
});

afterAll(async () => {
    if (dbReady) {
        try {
            await cleanupFixtures();
        } catch (error) {
            console.warn('[leadChannelAnalytics.db] cleanup failed:', error.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* already closed */ }
});

describe('LEAD-CHANNEL-ANALYTICS-001 migration and durable milestones', () => {
    databaseTest('tables are tenant-keyed, aliases preserve raw lead source, and replay is idempotent', async () => {
        const constraints = await db.query(
            `SELECT pc.conname, pg_get_constraintdef(pc.oid) AS definition
             FROM pg_constraint pc
             JOIN pg_class rel
               ON rel.oid = pc.conrelid
             JOIN pg_namespace ns
               ON ns.oid = rel.relnamespace
             WHERE ns.nspname = 'public'
               AND pc.conname = ANY($1::text[])`,
            [[
                'lead_source_channels_company_key_unique',
                'lead_source_aliases_company_source_unique',
                'lead_source_aliases_company_channel_fk',
            ]]
        );
        expect(constraints.rows.map(row => row.conname).sort()).toEqual([
            'lead_source_aliases_company_channel_fk',
            'lead_source_aliases_company_source_unique',
            'lead_source_channels_company_key_unique',
        ]);
        expect(
            constraints.rows.find(
                row => row.conname === 'lead_source_channels_company_key_unique'
            ).definition
        ).toContain('company_id, channel_key');
        expect(
            constraints.rows.find(
                row => row.conname === 'lead_source_aliases_company_source_unique'
            ).definition
        ).toContain('company_id, normalized_source');

        const sources = await db.query(
            `SELECT l.company_id, l.job_source, lsa.normalized_source, ch.display_name
             FROM leads l
             JOIN lead_source_aliases lsa
               ON lsa.company_id = l.company_id
              AND lsa.normalized_source = LOWER(BTRIM(l.job_source))
             JOIN lead_source_channels ch
               ON ch.company_id = l.company_id
              AND ch.id = lsa.channel_id
             WHERE l.company_id = ANY($1::uuid[])
             ORDER BY l.company_id`,
            [[COMPANY_A, COMPANY_B]]
        );
        expect(sources.rows).toHaveLength(2);
        expect(sources.rows.every(row => row.job_source === 'Google Ads')).toBe(true);
        expect(sources.rows.every(row => row.normalized_source === 'google ads')).toBe(true);
        expect(new Set(sources.rows.map(row => row.company_id))).toEqual(
            new Set([COMPANY_A, COMPANY_B])
        );
    });

    databaseTest('FSM-derived timestamps survive a later status change', async () => {
        const before = await db.query(
            `SELECT converted_at
             FROM leads
             WHERE id = $1 AND company_id = $2`,
            [leadA, COMPANY_A]
        );
        const jobBefore = await db.query(
            `SELECT visit_completed_at, repair_done_at
             FROM jobs
             WHERE id = $1 AND company_id = $2`,
            [jobA, COMPANY_A]
        );
        expect(before.rows[0].converted_at).not.toBeNull();
        expect(jobBefore.rows[0].visit_completed_at).not.toBeNull();
        expect(jobBefore.rows[0].repair_done_at).not.toBeNull();

        await db.query(
            `UPDATE jobs
             SET blanc_status = 'Submitted', updated_at = NOW()
             WHERE id = $1 AND company_id = $2`,
            [jobA, COMPANY_A]
        );
        const jobAfter = await db.query(
            `SELECT visit_completed_at, repair_done_at
             FROM jobs
             WHERE id = $1 AND company_id = $2`,
            [jobA, COMPANY_A]
        );
        expect(jobAfter.rows[0]).toEqual(jobBefore.rows[0]);
    });
});

describe('LEAD-CHANNEL-ANALYTICS-001 real aggregate and endpoint tenancy', () => {
    databaseTest('no connector or spend preserves existing keys and adds LSA lenses', async () => {
        const [summary, channel, quality] = await Promise.all([
            invokeEndpoint(COMPANY_A, '/summary', { from: FROM, to: TO }),
            invokeEndpoint(COMPANY_A, '/breakdown', {
                dimension: 'channel',
                from: FROM,
                to: TO,
            }),
            invokeEndpoint(COMPANY_A, '/data-quality', { from: FROM, to: TO }),
        ]);

        expect(JSON.stringify(summary.body)).toBe(JSON.stringify({
            kpis: {
                leads: 1,
                converted: 1,
                visit_completed: 1,
                jobs_done: 1,
                revenue_net_cents: 11234,
                call_cost_cents: 124,
                ad_spend_cents: 0,
                roas: null,
                marketing_contribution_cents: 11110,
                google_lsa_ad_spend_cents: 0,
                google_other_ad_spend_cents: 0,
                google_lsa_windowed_revenue_cents: 0,
                google_lsa_ltv_cents: 0,
                google_lsa_roas: null,
                google_lsa_ltv_roas: null,
                elocal_call_count: 0,
                elocal_billable_call_count: 0,
                elocal_unbillable_call_count: 0,
                elocal_matched_call_count: 0,
                elocal_billable_ad_spend_cents: 0,
                elocal_booked_conversions: 0,
                elocal_completed_conversions: 0,
                elocal_windowed_revenue_cents: 0,
                elocal_cpa_booked_cents: null,
                elocal_cpa_completed_cents: null,
                elocal_roas: null,
            },
            funnel: [
                { stage: 'leads', count: 1, conv_pct: 100 },
                { stage: 'converted', count: 1, conv_pct: 100 },
                { stage: 'visit_completed', count: 1, conv_pct: 100 },
                { stage: 'job_is_done', count: 1, conv_pct: 100 },
            ],
            period: {
                from: FROM,
                to: TO,
                timezone: 'America/New_York',
            },
        }));
        expect(JSON.stringify(channel.body)).toBe(JSON.stringify({
            dimension: 'channel',
            rows: [{
                key: SEEDED_GOOGLE_ADS_KEY,
                label: 'Google Ads',
                leads: 1,
                converted: 1,
                visit_completed: 1,
                jobs_done: 1,
                revenue_net_cents: 11234,
                ad_spend_cents: null,
                roas: null,
                marketing_contribution_cents: 11110,
                google_lsa_ad_spend_cents: 0,
                google_other_ad_spend_cents: 0,
                google_lsa_windowed_revenue_cents: 0,
                google_lsa_ltv_cents: 0,
                google_lsa_roas: null,
                google_lsa_ltv_roas: null,
                elocal_call_count: 0,
                elocal_billable_call_count: 0,
                elocal_unbillable_call_count: 0,
                elocal_matched_call_count: 0,
                elocal_billable_ad_spend_cents: 0,
                elocal_booked_conversions: 0,
                elocal_completed_conversions: 0,
                elocal_windowed_revenue_cents: 0,
                elocal_cpa_booked_cents: null,
                elocal_cpa_completed_cents: null,
                elocal_roas: null,
                funnel_counts: {
                    leads: 1,
                    converted: 1,
                    visit_completed: 1,
                    jobs_done: 1,
                },
            }],
            totals: {
                leads: 1,
                jobs_done: 1,
                revenue_net_cents: 11234,
                ad_spend_cents: 0,
                roas: null,
                marketing_contribution_cents: 11110,
                google_lsa_ad_spend_cents: 0,
                google_other_ad_spend_cents: 0,
                google_lsa_windowed_revenue_cents: 0,
                google_lsa_ltv_cents: 0,
                google_lsa_roas: null,
                google_lsa_ltv_roas: null,
                elocal_call_count: 0,
                elocal_billable_call_count: 0,
                elocal_unbillable_call_count: 0,
                elocal_matched_call_count: 0,
                elocal_billable_ad_spend_cents: 0,
                elocal_booked_conversions: 0,
                elocal_completed_conversions: 0,
                elocal_windowed_revenue_cents: 0,
                elocal_cpa_booked_cents: null,
                elocal_cpa_completed_cents: null,
                elocal_roas: null,
                funnel_counts: {
                    leads: 1,
                    converted: 1,
                    visit_completed: 1,
                    jobs_done: 1,
                },
            },
        }));
        expect(JSON.stringify(quality.body)).toBe(JSON.stringify({
            attribution_coverage_pct: 100,
            unallocated_spend_cents: 0,
            tax_basis_unknown_cents: 0,
            connected_sources: [],
        }));
    });

    databaseTest('a ZB job invoice-null payment uses job-keyed net revenue', async () => {
        const response = await invokeEndpoint(COMPANY_A, '/summary', {
            from: FROM,
            to: TO,
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({
            kpis: {
                leads: 1,
                converted: 1,
                visit_completed: 1,
                jobs_done: 1,
                revenue_net_cents: 11234,
                call_cost_cents: 124,
                ad_spend_cents: 0,
                roas: null,
                marketing_contribution_cents: 11110,
                google_lsa_ad_spend_cents: 0,
                google_other_ad_spend_cents: 0,
                google_lsa_windowed_revenue_cents: 0,
                google_lsa_ltv_cents: 0,
                google_lsa_roas: null,
                google_lsa_ltv_roas: null,
                elocal_call_count: 0,
                elocal_billable_call_count: 0,
                elocal_unbillable_call_count: 0,
                elocal_matched_call_count: 0,
                elocal_billable_ad_spend_cents: 0,
                elocal_booked_conversions: 0,
                elocal_completed_conversions: 0,
                elocal_windowed_revenue_cents: 0,
                elocal_cpa_booked_cents: null,
                elocal_cpa_completed_cents: null,
                elocal_roas: null,
            },
            funnel: [
                { stage: 'leads', count: 1, conv_pct: 100 },
                { stage: 'converted', count: 1, conv_pct: 100 },
                { stage: 'visit_completed', count: 1, conv_pct: 100 },
                { stage: 'job_is_done', count: 1, conv_pct: 100 },
            ],
            period: {
                from: FROM,
                to: TO,
                timezone: 'America/New_York',
            },
        });

        await db.query(
            `INSERT INTO payment_transactions (
                 company_id,
                 contact_id,
                 job_id,
                 transaction_type,
                 payment_method,
                 status,
                 amount,
                 processed_at,
                 external_source,
                 voided_at
             )
             VALUES
                ($1, $2, $3, 'refund', 'cash', 'completed', 2.00,
                 '2026-07-17T14:00:00Z', $4, NULL),
                ($1, $2, $3, 'payment', 'cash', 'completed', 99.00,
                 '2026-07-17T14:00:00Z', $5, '2026-07-18T14:00:00Z')`,
            [
                COMPANY_A,
                contactA,
                jobA,
                `${TAG}-phase3-refund`,
                `${TAG}-phase3-voided`,
            ]
        );
        const net = await analytics.getSummary(COMPANY_A, {
            from: FROM,
            to: TO,
        });
        expect(net.kpis.revenue_net_cents).toBe(11034);
    });

    databaseTest('multi-tech equal split reconciles every metric to company totals', async () => {
        const response = await invokeEndpoint(COMPANY_A, '/breakdown', {
            dimension: 'technician',
            from: FROM,
            to: TO,
        });

        expect(response.statusCode).toBe(200);
        expect(response.body.dimension).toBe('technician');
        expect(response.body.rows).toHaveLength(2);
        expect(response.body.rows.map(row => row.leads)).toEqual([0.5, 0.5]);
        expect(response.body.rows.map(row => row.jobs_done)).toEqual([0.5, 0.5]);
        expect(response.body.rows.map(row => row.revenue_net_cents)).toEqual([5617, 5617]);
        expect(response.body.rows.map(
            row => row.marketing_contribution_cents
        )).toEqual([5555, 5555]);

        const sum = key => response.body.rows.reduce(
            (total, row) => total + row[key],
            0
        );
        expect(sum('leads')).toBe(response.body.totals.leads);
        expect(sum('jobs_done')).toBe(response.body.totals.jobs_done);
        expect(sum('revenue_net_cents')).toBe(
            response.body.totals.revenue_net_cents
        );
        expect(sum('marketing_contribution_cents')).toBe(
            response.body.totals.marketing_contribution_cents
        );
        expect(new Set(response.body.rows.map(row => row.key))).toEqual(
            new Set([TECH_A_1, TECH_A_2])
        );
    });

    databaseTest('only payments without a job remain unknown tax basis', async () => {
        const quality = await invokeEndpoint(COMPANY_A, '/data-quality', {
            from: FROM,
            to: TO,
        });
        const summary = await analytics.getSummary(COMPANY_A, {
            from: FROM,
            to: TO,
        });

        expect(quality.statusCode).toBe(200);
        expect(quality.body).toEqual({
            attribution_coverage_pct: 100,
            unallocated_spend_cents: 0,
            tax_basis_unknown_cents: 0,
            connected_sources: [],
        });
        expect(summary.kpis.revenue_net_cents).toBe(11234);
        expect(summary.kpis.marketing_contribution_cents).toBe(11110);
    });

    databaseTest('LSA precedence owns each job once and exposes windowed, LTV, and spend lenses', async () => {
        const googleChannel = await ensureChannel(COMPANY_A);
        const connectionId = await seedLsaConnection(
            COMPANY_A,
            googleChannel,
            '1111111111'
        );
        const lsaLeadId = await seedMatchedLsaLead({
            companyId: COMPANY_A,
            connectionId,
            contactId: contactA,
            leadId: leadA,
            externalId: `${TAG}-phase3-a`,
        });
        const leadlessWindowedJob = await seedPhase3Job({
            companyId: COMPANY_A,
            contactId: contactA,
            suffix: 'windowed',
            amount: 25,
        });
        await seedPhase3Job({
            companyId: COMPANY_A,
            contactId: contactA,
            suffix: 'lifetime',
            amount: 50,
        });
        await markLeadAsGoogleClick(leadA, COMPANY_A);
        await attributeLsaJob({
            companyId: COMPANY_A,
            lsaLeadId,
            jobId: jobA,
            contactId: contactA,
            leadId: leadA,
        });
        await attributeLsaJob({
            companyId: COMPANY_A,
            lsaLeadId,
            jobId: leadlessWindowedJob,
            contactId: contactA,
            leadId: null,
        });
        await seedSpend(
            COMPANY_A,
            googleChannel,
            9000000,
            'lsa-campaign',
            'Boston LocalServices Calls'
        );
        await seedSpend(
            COMPANY_A,
            googleChannel,
            6000000,
            'search-campaign',
            'Boston Search Calls'
        );

        const [summary, breakdown] = await Promise.all([
            analytics.getSummary(COMPANY_A, { from: FROM, to: TO }),
            analytics.getBreakdown(COMPANY_A, {
                dimension: 'channel',
                from: FROM,
                to: TO,
            }),
        ]);

        expect(summary.kpis).toMatchObject({
            leads: 1,
            revenue_net_cents: 13734,
            ad_spend_cents: 1500,
            google_lsa_ad_spend_cents: 900,
            google_other_ad_spend_cents: 600,
            google_lsa_windowed_revenue_cents: 13734,
            google_lsa_ltv_cents: 18734,
            google_lsa_roas: 13734 / 900,
            google_lsa_ltv_roas: 18734 / 900,
        });
        expect(summary.kpis.google_lsa_ltv_cents).toBeGreaterThan(
            summary.kpis.google_lsa_windowed_revenue_cents
        );

        const google = breakdown.rows.find(row => row.key === 'google_ads');
        expect(google).toMatchObject({
            leads: 1,
            revenue_net_cents: 13734,
            google_lsa_ad_spend_cents: 900,
            google_other_ad_spend_cents: 600,
            google_lsa_windowed_revenue_cents: 13734,
            google_lsa_ltv_cents: 18734,
            google_lsa_roas: 13734 / 900,
            google_lsa_ltv_roas: 18734 / 900,
        });
        expect(breakdown.totals.revenue_net_cents).toBe(13734);
    });

    databaseTest('eLocal exposes BILLABLE spend, both CPA lenses, and job-keyed windowed revenue', async () => {
        const [elocalChannelA, elocalChannelB] = await Promise.all([
            ensureChannel(COMPANY_A, 'elocal', 'eLocal'),
            ensureChannel(COMPANY_B, 'elocal', 'eLocal'),
        ]);
        const [connectionA, connectionB] = await Promise.all([
            seedElocalConnection(COMPANY_A, elocalChannelA, 'a'),
            seedElocalConnection(COMPANY_B, elocalChannelB, 'b'),
        ]);
        const [billableLead, unbillableLead, foreignLead] = await Promise.all([
            seedElocalLead({
                companyId: COMPANY_A,
                connectionId: connectionA,
                contactId: contactA,
                leadId: leadA,
                suffix: 'billable',
                billable: true,
                costCents: 10000,
            }),
            seedElocalLead({
                companyId: COMPANY_A,
                connectionId: connectionA,
                contactId: contactA,
                leadId: leadA,
                suffix: 'unbillable',
                billable: false,
                costCents: 9000,
            }),
            seedElocalLead({
                companyId: COMPANY_B,
                connectionId: connectionB,
                contactId: contactB,
                leadId: leadB,
                suffix: 'foreign',
                billable: true,
                costCents: 999900,
            }),
        ]);
        await db.query(
            `UPDATE jobs
             SET zb_status = 'complete'
             WHERE company_id = $1
               AND id = $2`,
            [COMPANY_A, jobA]
        );
        await Promise.all([
            attributeElocalJob({
                companyId: COMPANY_A,
                elocalLeadId: billableLead,
                jobId: jobA,
                contactId: contactA,
                leadId: leadA,
            }),
            attributeElocalJob({
                companyId: COMPANY_B,
                elocalLeadId: foreignLead,
                jobId: jobB,
                contactId: contactB,
                leadId: leadB,
            }),
        ]);
        const sameContactUnattributedJob = await seedPhase3Job({
            companyId: COMPANY_A,
            contactId: contactA,
            suffix: 'elocal-unowned',
            amount: 50,
        });

        const [summary, breakdown, quality] = await Promise.all([
            analytics.getSummary(COMPANY_A, { from: FROM, to: TO }),
            analytics.getBreakdown(COMPANY_A, {
                dimension: 'channel',
                from: FROM,
                to: TO,
            }),
            analytics.getDataQuality(COMPANY_A, { from: FROM, to: TO }),
        ]);

        expect(summary.kpis).toMatchObject({
            leads: 1,
            revenue_net_cents: 11234,
            ad_spend_cents: 10000,
            elocal_call_count: 2,
            elocal_billable_call_count: 1,
            elocal_unbillable_call_count: 1,
            elocal_matched_call_count: 2,
            elocal_billable_ad_spend_cents: 10000,
            elocal_booked_conversions: 1,
            elocal_completed_conversions: 1,
            elocal_windowed_revenue_cents: 11234,
            elocal_cpa_booked_cents: 10000,
            elocal_cpa_completed_cents: 10000,
            elocal_roas: 11234 / 10000,
        });
        expect(summary.kpis.elocal_windowed_revenue_cents).not.toBe(16234);

        const elocal = breakdown.rows.find(row => row.key === 'elocal');
        expect(elocal).toMatchObject({
            leads: 1,
            revenue_net_cents: 11234,
            ad_spend_cents: 10000,
            elocal_billable_ad_spend_cents: 10000,
            elocal_booked_conversions: 1,
            elocal_completed_conversions: 1,
            elocal_windowed_revenue_cents: 11234,
            elocal_cpa_booked_cents: 10000,
            elocal_cpa_completed_cents: 10000,
            elocal_roas: 11234 / 10000,
        });
        expect(breakdown.totals.revenue_net_cents).toBe(11234);
        expect(quality.connected_sources).toEqual([{
            key: 'elocal',
            label: 'eLocal',
            status: 'connected',
            last_synced_at: null,
            synced_from_date: null,
            synced_through_date: null,
        }]);
        expect(JSON.stringify(quality.connected_sources)).not.toContain('campaign');
        expect(JSON.stringify(quality.connected_sources)).not.toContain('API_KEY');

        const persisted = await db.query(
            `SELECT id
             FROM jobs
             WHERE company_id = $1
               AND id = $2`,
            [COMPANY_A, sameContactUnattributedJob]
        );
        expect(persisted.rows).toHaveLength(1);
        expect(unbillableLead).toBeTruthy();
    });

    databaseTest("zb_status='complete' counts the job as visit-completed and done", async () => {
        const { rows } = await db.query(
            `INSERT INTO leads (
                 uuid,
                 company_id,
                 contact_id,
                 first_name,
                 phone,
                 postal_code,
                 job_source,
                 status,
                 converted_to_job,
                 created_at,
                 updated_at
             )
             VALUES (
                 $1,
                 $2,
                 $3,
                 'Phase 3 Analytics',
                 $4,
                 '02108',
                 'Google Ads',
                 'New',
                 false,
                 '2026-07-20T14:00:00Z',
                 '2026-07-20T14:00:00Z'
             )
             RETURNING id`,
            [`${TAG.slice(-10)}z`, COMPANY_A, contactA, SHARED_PHONE]
        );
        await seedPhase3Job({
            companyId: COMPANY_A,
            contactId: contactA,
            leadId: rows[0].id,
            suffix: 'zb-complete',
            zbStatus: 'complete',
        });

        const summary = await analytics.getSummary(COMPANY_A, {
            from: FROM,
            to: TO,
        });

        expect(summary.kpis).toMatchObject({
            leads: 2,
            converted: 2,
            visit_completed: 2,
            jobs_done: 2,
            revenue_net_cents: 11234,
        });
    });

    databaseTest('T-foreign/T-blast: foreign LSA ownership and LTV never enter company A', async () => {
        const foreignGoogleChannel = await ensureChannel(COMPANY_B);
        const foreignConnectionId = await seedLsaConnection(
            COMPANY_B,
            foreignGoogleChannel,
            '2222222222'
        );
        const foreignLsaLeadId = await seedMatchedLsaLead({
            companyId: COMPANY_B,
            connectionId: foreignConnectionId,
            contactId: contactB,
            leadId: leadB,
            externalId: `${TAG}-phase3-b`,
        });
        await attributeLsaJob({
            companyId: COMPANY_B,
            lsaLeadId: foreignLsaLeadId,
            jobId: jobB,
            contactId: contactB,
            leadId: leadB,
        });

        const summary = await analytics.getSummary(COMPANY_A, {
            from: FROM,
            to: TO,
        });

        expect(summary.kpis).toMatchObject({
            leads: 1,
            revenue_net_cents: 11234,
            google_lsa_windowed_revenue_cents: 0,
            google_lsa_ltv_cents: 0,
        });
    });

    databaseTest('T-blast: same-source/phone company B never appears in any endpoint', async () => {
        const responses = await Promise.all([
            invokeEndpoint(COMPANY_A, '/summary', { from: FROM, to: TO }),
            invokeEndpoint(COMPANY_A, '/breakdown', {
                dimension: 'channel',
                from: FROM,
                to: TO,
            }),
            invokeEndpoint(COMPANY_A, '/breakdown', {
                dimension: 'area',
                from: FROM,
                to: TO,
            }),
            invokeEndpoint(COMPANY_A, '/breakdown', {
                dimension: 'technician',
                from: FROM,
                to: TO,
            }),
            invokeEndpoint(COMPANY_A, '/data-quality', { from: FROM, to: TO }),
        ]);

        expect(responses.every(response => response.statusCode === 200)).toBe(true);
        const payload = JSON.stringify(responses.map(response => response.body));
        expect(payload).not.toContain('99999');
        expect(payload).not.toContain('8888');
        expect(payload).not.toContain('Foreign Area');
        expect(payload).not.toContain('Foreign Technician');
        expect(payload).not.toContain(TECH_B);

        const channel = responses[1].body;
        expect(channel.totals.revenue_net_cents).toBe(11234);
        expect(channel.totals.leads).toBe(1);
        const area = responses[2].body;
        expect(area.rows).toHaveLength(1);
        expect(area.rows[0].label).toBe('Downtown');
        expect(responses[4].body.tax_basis_unknown_cents).toBe(0);
    });

    databaseTest('SAB-LCA-COST-COMPANY: summary spend scan cannot cross tenant boundaries', async () => {
        const [channelA, channelB] = await Promise.all([
            ensureChannel(COMPANY_A),
            ensureChannel(COMPANY_B),
        ]);
        await Promise.all([
            markLeadAsGoogleClick(leadA, COMPANY_A),
            seedSpend(COMPANY_A, channelA, 25000000),
            seedSpend(COMPANY_B, channelB, 99990000),
        ]);

        const response = await invokeEndpoint(COMPANY_A, '/summary', {
            from: FROM,
            to: TO,
        });

        expect(response.statusCode).toBe(200);
        expect(response.body.kpis).toMatchObject({
            revenue_net_cents: 11234,
            call_cost_cents: 124,
            ad_spend_cents: 2500,
            roas: 11234 / 2500,
            marketing_contribution_cents: 8610,
        });
    });

    databaseTest('channel spend includes zero-lead synthetic rows and surfaces unallocated spend', async () => {
        const googleAdsChannel = await ensureChannel(COMPANY_A);
        const zeroLeadChannel = await ensureChannel(
            COMPANY_A,
            'phase_b_zero_lead',
            'Zero-lead paid channel'
        );
        await markLeadAsGoogleClick(leadA, COMPANY_A);
        await seedSpend(COMPANY_A, googleAdsChannel, 25000000, 'google-campaign');
        await seedSpend(COMPANY_A, zeroLeadChannel, 10000000, 'zero-lead-campaign');

        const [breakdown, quality] = await Promise.all([
            invokeEndpoint(COMPANY_A, '/breakdown', {
                dimension: 'channel',
                from: FROM,
                to: TO,
            }),
            invokeEndpoint(COMPANY_A, '/data-quality', { from: FROM, to: TO }),
        ]);

        const googleAds = breakdown.body.rows.find(row => row.key === 'google_ads');
        const zeroLead = breakdown.body.rows.find(
            row => row.key === 'phase_b_zero_lead'
        );
        expect(googleAds).toMatchObject({
            leads: 1,
            revenue_net_cents: 11234,
            ad_spend_cents: 2500,
            roas: 11234 / 2500,
            marketing_contribution_cents: 8610,
        });
        expect(zeroLead).toEqual({
            key: 'phase_b_zero_lead',
            label: 'Zero-lead paid channel',
            leads: 0,
            converted: 0,
            visit_completed: 0,
            jobs_done: 0,
            revenue_net_cents: 0,
            ad_spend_cents: 1000,
            roas: null,
            marketing_contribution_cents: -1000,
            google_lsa_ad_spend_cents: 0,
            google_other_ad_spend_cents: 0,
            google_lsa_windowed_revenue_cents: 0,
            google_lsa_ltv_cents: 0,
            google_lsa_roas: null,
            google_lsa_ltv_roas: null,
            elocal_call_count: 0,
            elocal_billable_call_count: 0,
            elocal_unbillable_call_count: 0,
            elocal_matched_call_count: 0,
            elocal_billable_ad_spend_cents: 0,
            elocal_booked_conversions: 0,
            elocal_completed_conversions: 0,
            elocal_windowed_revenue_cents: 0,
            elocal_cpa_booked_cents: null,
            elocal_cpa_completed_cents: null,
            elocal_roas: null,
            funnel_counts: {
                leads: 0,
                converted: 0,
                visit_completed: 0,
                jobs_done: 0,
            },
        });
        expect(breakdown.body.totals).toMatchObject({
            ad_spend_cents: 3500,
            marketing_contribution_cents: 7610,
        });
        expect(breakdown.body.totals.roas).toBeCloseTo(11234 / 3500);
        expect(
            breakdown.body.rows.reduce(
                (total, row) => total + row.ad_spend_cents,
                0
            )
        ).toBe(3500);
        expect(quality.body.unallocated_spend_cents).toBe(1000);
    });

    databaseTest('modeled per-lead area and technician spend allocation reconciles exactly', async () => {
        const googleAdsChannel = await ensureChannel(COMPANY_A);
        await markLeadAsGoogleClick(leadA, COMPANY_A);
        await db.query(
            `INSERT INTO leads (
                 uuid,
                 company_id,
                 contact_id,
                 first_name,
                 phone,
                 postal_code,
                 gclid,
                 status,
                 converted_to_job,
                 created_at,
                 updated_at
             )
             VALUES (
                 $1,
                 $2,
                 $3,
                 'Phase B Allocation',
                 $4,
                 '99999',
                 $5,
                 'New',
                 false,
                 '2026-07-20T14:00:00Z',
                 '2026-07-20T14:00:00Z'
             )`,
            [
                `${TAG.slice(-11)}p`,
                COMPANY_A,
                contactA,
                SHARED_PHONE,
                `${TAG}-allocation-gclid`,
            ]
        );
        await seedSpend(COMPANY_A, googleAdsChannel, 10010000);

        const [area, technician, quality] = await Promise.all([
            invokeEndpoint(COMPANY_A, '/breakdown', {
                dimension: 'area',
                from: FROM,
                to: TO,
            }),
            invokeEndpoint(COMPANY_A, '/breakdown', {
                dimension: 'technician',
                from: FROM,
                to: TO,
            }),
            invokeEndpoint(COMPANY_A, '/data-quality', { from: FROM, to: TO }),
        ]);

        for (const breakdown of [area.body, technician.body]) {
            expect(breakdown.totals.ad_spend_cents).toBe(1001);
            expect(breakdown.totals.marketing_contribution_cents).toBe(10109);
            expect(
                breakdown.rows.reduce(
                    (total, row) => total + row.ad_spend_cents,
                    0
                )
            ).toBe(1001);
            expect(
                breakdown.rows.reduce(
                    (total, row) => total + row.marketing_contribution_cents,
                    0
                )
            ).toBe(10109);
        }

        expect(area.body.rows.map(row => row.ad_spend_cents).sort()).toEqual([
            500,
            501,
        ]);
        const downtown = area.body.rows.find(row => row.label === 'Downtown');
        const outside = area.body.rows.find(
            row => row.label === 'Outside configured areas'
        );
        expect(downtown.marketing_contribution_cents).toBe(
            11234 - 124 - downtown.ad_spend_cents
        );
        expect(outside.marketing_contribution_cents).toBe(
            -outside.ad_spend_cents
        );

        const unassigned = technician.body.rows.find(
            row => row.key === 'unassigned'
        );
        const assigned = technician.body.rows.filter(
            row => row.key !== 'unassigned'
        );
        expect(assigned).toHaveLength(2);
        expect(
            assigned.reduce((total, row) => total + row.ad_spend_cents, 0)
            + unassigned.ad_spend_cents
        ).toBe(1001);
        for (const row of assigned) {
            expect(row.marketing_contribution_cents).toBe(
                row.revenue_net_cents - 62 - row.ad_spend_cents
            );
        }
        expect(unassigned.marketing_contribution_cents).toBe(
            -unassigned.ad_spend_cents
        );
        expect(quality.body.unallocated_spend_cents).toBe(0);
    });

    databaseTest('connected source status is useful and excludes credentials and customer identity', async () => {
        const channelId = await ensureChannel(COMPANY_A);
        await db.query(
            `INSERT INTO google_ads_connections (
                 company_id,
                 channel_id,
                 customer_id,
                 refresh_token_encrypted,
                 status,
                 last_sync_status,
                 last_synced_at,
                 synced_from_date,
                 synced_through_date
             )
             VALUES (
                 $1,
                 $2,
                 '1234567890',
                 'v1:secret-iv:secret-tag:secret-ciphertext',
                 'connected',
                 'success',
                 '2026-07-27T12:30:00Z',
                 '2026-07-01',
                 '2026-07-26'
             )`,
            [COMPANY_A, channelId]
        );

        const quality = await invokeEndpoint(COMPANY_A, '/data-quality', {
            from: FROM,
            to: TO,
        });
        expect(quality.body.connected_sources).toEqual([{
            key: 'google_ads',
            label: 'Google Ads',
            status: 'connected',
            last_synced_at: '2026-07-27T12:30:00.000Z',
            synced_from_date: '2026-07-01',
            synced_through_date: '2026-07-26',
        }]);
        const payload = JSON.stringify(quality.body.connected_sources);
        expect(payload).not.toContain('customer');
        expect(payload).not.toContain('1234567890');
        expect(payload).not.toContain('token');
        expect(payload).not.toContain('ciphertext');
    });

    databaseTest('gclid takes precedence over an existing source alias when google_ads is active', async () => {
        await ensureChannel(COMPANY_A);
        await markLeadAsGoogleClick(leadA, COMPANY_A);

        const breakdown = await invokeEndpoint(COMPANY_A, '/breakdown', {
            dimension: 'channel',
            from: FROM,
            to: TO,
        });

        expect(breakdown.statusCode).toBe(200);
        expect(breakdown.body.rows).toHaveLength(1);
        expect(breakdown.body.rows[0]).toMatchObject({
            key: 'google_ads',
            label: 'Google Ads',
            leads: 1,
            revenue_net_cents: 11234,
            ad_spend_cents: null,
        });
        expect(breakdown.body.rows[0].key).not.toBe(SEEDED_GOOGLE_ADS_KEY);
    });
});
