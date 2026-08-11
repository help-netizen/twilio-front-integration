'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const googleAdsQueries = require('../backend/src/db/googleAdsQueries');
const connectionService = require('../backend/src/services/googleAdsConnectionService');
const syncService = require('../backend/src/services/googleAdsSyncService');
const lsaAttribution = require('../backend/src/services/googleLsaAttributionService');

jest.setTimeout(120000);

const GOOGLE_ADS_MIGRATION = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/214_google_ads_connector.sql'),
    'utf8'
);
const LSA_MIGRATION = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/251_google_lsa_attribution.sql'),
    'utf8'
);
const CONTACT_PHONE_MIGRATION = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/242_contact_identity_foundation.sql'),
    'utf8'
);
const LSA_ROLLBACK = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/rollback_251_google_lsa_attribution.sql'),
    'utf8'
);
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const CUSTOMER_ID = '1234567890';
const NOW = new Date('2026-08-11T16:00:00.000Z');
const TAG = `lsa-${Date.now()}-${process.pid}`;

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
    test('GOOGLE-LSA DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`Google LSA DB tests are pending: ${DATABASE.reason}`);
    });
}

function accountAdapter() {
    return {
        fetchAccountMetadata: jest.fn().mockResolvedValue({
            currency_code: 'USD',
            account_timezone: 'America/New_York',
        }),
    };
}

function providerLead(externalLeadId, overrides = {}) {
    return {
        external_account_id: CUSTOMER_ID,
        external_lead_id: externalLeadId,
        resource_name: `customers/${CUSTOMER_ID}/localServicesLeads/${externalLeadId}`,
        lead_type: 'PHONE_CALL',
        phone_e164: '+16175550101',
        normalized_phone: '6175550101',
        provider_created_at: new Date('2026-08-10T14:00:00.000Z'),
        provider_creation_date_time: '2026-08-10 10:00:00.000000',
        lead_charged: true,
        lead_status: 'ACTIVE',
        ...overrides,
    };
}

async function connect(companyId) {
    await connectionService.connectCompany({
        companyId,
        customerId: CUSTOMER_ID,
        refreshToken: `refresh-${companyId}`,
        actorId: null,
    }, { adapter: accountAdapter() });
    const { rows } = await db.query(
        `UPDATE google_ads_connections
         SET synced_through_date = '2026-08-10',
             last_sync_status = 'pending'
         WHERE company_id = $1
         RETURNING *`,
        [companyId]
    );
    return rows[0];
}

async function claim(companyId, connectionId) {
    const lease = new Date(NOW.getTime() + syncService.LEASE_MS);
    const connection = await googleAdsQueries.claimConnection(
        companyId,
        connectionId,
        NOW,
        lease
    );
    expect(connection).toBeTruthy();
    return lease;
}

async function insertLsa(companyId, connectionId, externalLeadId, overrides = {}) {
    const row = providerLead(externalLeadId, overrides);
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
            lead_charged,
            lead_status
         )
         VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9::TIMESTAMPTZ, $10, $11, $12
         )
         RETURNING *`,
        [
            companyId,
            connectionId,
            CUSTOMER_ID,
            row.external_lead_id,
            row.resource_name,
            row.lead_type,
            row.phone_e164,
            row.normalized_phone,
            row.provider_created_at,
            row.provider_creation_date_time,
            row.lead_charged,
            row.lead_status,
        ]
    );
    return rows[0];
}

async function insertContact(companyId, phone) {
    const { rows } = await db.query(
        `INSERT INTO contacts (company_id, full_name, phone_e164)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [companyId, `${TAG} Contact`, phone]
    );
    const contactId = rows[0].id;
    await db.query(
        `INSERT INTO contact_phones (
            company_id,
            contact_id,
            phone_e164,
            normalized_phone,
            is_primary
         )
         VALUES ($1, $2, $3, $4, true)`,
        [companyId, contactId, phone, phone.replace(/[^0-9]/g, '').slice(-10)]
    );
    return contactId;
}

async function insertCall(companyId, phone, startedAt, contactId = null) {
    const { rows } = await db.query(
        `INSERT INTO calls (
            call_sid,
            company_id,
            contact_id,
            direction,
            from_number,
            to_number,
            status,
            is_final,
            started_at
         )
         VALUES ($1, $2, $3, 'inbound', $4, '+16175550000', 'completed', true,
                 $5::TIMESTAMPTZ)
         RETURNING id`,
        [`CA${randomUUID().replace(/-/g, '')}`, companyId, contactId, phone, startedAt]
    );
    return rows[0].id;
}

async function insertCrmLead(companyId, phone, createdAt, contactId) {
    const { rows } = await db.query(
        `INSERT INTO leads (
            uuid,
            company_id,
            contact_id,
            phone,
            status,
            converted_to_job,
            created_at,
            updated_at
         )
         VALUES ($1, $2, $3, $4, 'Submitted', false,
                 $5::TIMESTAMPTZ, $5::TIMESTAMPTZ)
         RETURNING id`,
        [randomUUID().replace(/-/g, '').slice(0, 20), companyId, contactId, phone, createdAt]
    );
    return rows[0].id;
}

async function insertJob(companyId, contactId, createdAt, leadId = null) {
    const { rows } = await db.query(
        `INSERT INTO jobs (
            company_id,
            contact_id,
            lead_id,
            blanc_status,
            created_at,
            updated_at
         )
         VALUES ($1, $2, $3, 'Submitted', $4::TIMESTAMPTZ, $4::TIMESTAMPTZ)
         RETURNING id`,
        [companyId, contactId, leadId, createdAt]
    );
    return rows[0].id;
}

async function lsaSnapshot(companyId) {
    const { rows } = await db.query(
        `SELECT jsonb_build_object(
             'leads', COALESCE((
                 SELECT jsonb_agg(to_jsonb(lead) ORDER BY lead.id)
                 FROM google_lsa_leads lead
                 WHERE lead.company_id = $1
             ), '[]'::JSONB),
             'attributions', COALESCE((
                 SELECT jsonb_agg(to_jsonb(attribution) ORDER BY attribution.matched_job_id)
                 FROM google_lsa_job_attributions attribution
                 WHERE attribution.company_id = $1
             ), '[]'::JSONB)
         ) AS snapshot`,
        [companyId]
    );
    return JSON.stringify(rows[0].snapshot);
}

async function cleanupFixtures() {
    await db.query(
        `DELETE FROM google_lsa_job_attributions
         WHERE company_id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
    await db.query(
        `DELETE FROM google_lsa_leads
         WHERE company_id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
    await db.query(
        `DELETE FROM calls
         WHERE company_id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
    await db.query(
        `DELETE FROM jobs
         WHERE company_id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
    await db.query(
        `DELETE FROM leads
         WHERE company_id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
    await db.query(
        `DELETE FROM contact_phones
         WHERE company_id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
    await db.query(
        `DELETE FROM contacts
         WHERE company_id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
    await db.query(
        `DELETE FROM companies
         WHERE id IN ($1, $2)`,
        [COMPANY_A, COMPANY_B]
    );
}

let savedEnv;

beforeAll(async () => {
    if (!DATABASE.ready) return;
    savedEnv = {
        GOOGLE_ADS_CLIENT_ID: process.env.GOOGLE_ADS_CLIENT_ID,
        GOOGLE_ADS_CLIENT_SECRET: process.env.GOOGLE_ADS_CLIENT_SECRET,
        GOOGLE_ADS_DEVELOPER_TOKEN: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        GOOGLE_ADS_TOKEN_ENCRYPTION_KEY: process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY,
    };
    process.env.GOOGLE_ADS_CLIENT_ID = 'oauth-client';
    process.env.GOOGLE_ADS_CLIENT_SECRET = 'oauth-secret';
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'developer-secret';
    process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY = 'e'.repeat(64);

    await db.query(GOOGLE_ADS_MIGRATION);
    await db.query(CONTACT_PHONE_MIGRATION);
    await db.query(LSA_MIGRATION);
});

beforeEach(async () => {
    if (!DATABASE.ready) return;
    await cleanupFixtures();
    await db.query(
        `INSERT INTO companies (id, name, slug, timezone)
         VALUES
            ($1, $2, $3, 'America/New_York'),
            ($4, $5, $6, 'America/New_York')`,
        [
            COMPANY_A,
            `${TAG} Company A`,
            `${TAG}-a`,
            COMPANY_B,
            `${TAG} Company B`,
            `${TAG}-b`,
        ]
    );
});

afterAll(async () => {
    if (!DATABASE.ready) return;
    await cleanupFixtures();
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe('GOOGLE-LSA-ATTRIBUTION-001 migration and sync', () => {
    databaseTest('migration rehomes only the deterministic duplicate channel and is idempotent', async () => {
        const connection = await connect(COMPANY_A);
        const { rows: duplicateRows } = await db.query(
            `INSERT INTO lead_source_channels (
                company_id,
                channel_key,
                display_name,
                description,
                metadata
             )
             VALUES (
                $1,
                'source_89e8a431de55c3822053e36c5eb21d06',
                'Google Ads',
                'Historical source',
                '{"seeded_from_raw_source":true}'::JSONB
             )
             RETURNING id`,
            [COMPANY_A]
        );
        await db.query(
            `INSERT INTO lead_source_aliases (
                company_id,
                channel_id,
                raw_source,
                normalized_source
             )
             VALUES ($1, $2, 'Google Ads', 'google ads')`,
            [COMPANY_A, duplicateRows[0].id]
        );

        await db.query(LSA_MIGRATION);
        await db.query(LSA_MIGRATION);

        const { rows } = await db.query(
            `SELECT
                 alias.channel_id,
                 canonical.id AS canonical_id,
                 duplicate.is_active AS duplicate_active,
                 duplicate.metadata->>'google_lsa_attribution_001_merged' AS merged
             FROM lead_source_aliases alias
             JOIN lead_source_channels canonical
               ON canonical.company_id = $1
              AND canonical.channel_key = 'google_ads'
             JOIN lead_source_channels duplicate
               ON duplicate.company_id = $1
              AND duplicate.channel_key = 'source_89e8a431de55c3822053e36c5eb21d06'
             WHERE alias.company_id = $1
               AND alias.normalized_source = 'google ads'`,
            [COMPANY_A]
        );
        expect(rows[0]).toEqual({
            channel_id: connection.channel_id,
            canonical_id: connection.channel_id,
            duplicate_active: false,
            merged: 'true',
        });
        const app = await db.query(
            `SELECT metadata->'assistant' AS assistant
             FROM marketplace_apps
             WHERE app_key = 'google-ads'`
        );
        expect(app.rows[0].assistant).toMatchObject({
            what_it_does: expect.stringContaining('Local Services Ads'),
            prerequisites: expect.any(Array),
            setup_steps: expect.any(Array),
            outcome: expect.any(String),
            recommend_when: expect.any(Array),
            gotchas: expect.any(Array),
        });
        expect(LSA_ROLLBACK).toContain('DROP TABLE IF EXISTS google_lsa_job_attributions');
        expect(LSA_ROLLBACK).toContain('DROP TABLE IF EXISTS google_lsa_leads');

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(LSA_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT
                     TO_REGCLASS('google_lsa_leads') AS leads_table,
                     TO_REGCLASS('google_lsa_job_attributions') AS jobs_table`
            );
            expect(rolledBack.rows[0]).toEqual({
                leads_table: null,
                jobs_table: null,
            });
            await client.query('ROLLBACK');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    });

    databaseTest('T-own/T-foreign/T-blast: leased sync upserts tenant-local LSA rows idempotently', async () => {
        const connectionA = await connect(COMPANY_A);
        const connectionB = await connect(COMPANY_B);
        await insertLsa(COMPANY_B, connectionB.id, 'shared-lead', {
            lead_status: 'FOREIGN_SENTINEL',
        });
        const beforeB = await lsaSnapshot(COMPANY_B);
        const adapter = {
            refreshAccessToken: jest.fn().mockResolvedValue('access-private'),
            fetchLocalServicesLeads: jest.fn().mockResolvedValue([
                providerLead('shared-lead'),
            ]),
            fetchCampaignPerformance: jest.fn().mockResolvedValue([]),
        };

        await expect(syncService.syncCompany(
            COMPANY_A,
            connectionB.id,
            { adapter, now: () => NOW }
        )).resolves.toEqual({ status: 'skipped' });
        expect(adapter.refreshAccessToken).not.toHaveBeenCalled();

        await expect(syncService.syncCompany(
            COMPANY_A,
            connectionA.id,
            { adapter, now: () => NOW }
        )).resolves.toMatchObject({ status: 'ok', ranges: 1 });
        adapter.fetchLocalServicesLeads.mockResolvedValue([
            providerLead('shared-lead', { lead_status: 'UPDATED' }),
        ]);
        await syncService.syncCompany(
            COMPANY_A,
            connectionA.id,
            { adapter, now: () => NOW }
        );

        const own = await db.query(
            `SELECT COUNT(*)::INT AS count, MAX(lead_status) AS lead_status
             FROM google_lsa_leads
             WHERE company_id = $1
               AND resource_name = $2`,
            [
                COMPANY_A,
                'customers/1234567890/localServicesLeads/shared-lead',
            ]
        );
        expect(own.rows[0]).toEqual({ count: 1, lead_status: 'UPDATED' });
        expect(await lsaSnapshot(COMPANY_B)).toBe(beforeB);
        expect(adapter.fetchLocalServicesLeads).toHaveBeenCalledTimes(2);
    });
});

describe('GOOGLE-LSA-ATTRIBUTION-001 real matcher', () => {
    databaseTest('T-own/T-foreign/T-blast: tiers, time guard, duplicate expansion, ambiguity, and MESSAGE exclusion', async () => {
        const connectionA = await connect(COMPANY_A);
        const connectionB = await connect(COMPANY_B);

        const phoneDirect = '+16175550101';
        const directContact = await insertContact(COMPANY_A, phoneDirect);
        const duplicateContact = await insertContact(COMPANY_A, phoneDirect);
        await insertCall(
            COMPANY_A,
            phoneDirect,
            '2026-08-10T14:05:00.000Z',
            directContact
        );
        const directLsa = await insertLsa(
            COMPANY_A,
            connectionA.id,
            'direct',
            { phone_e164: phoneDirect, normalized_phone: '6175550101' }
        );
        const repeatLsa = await insertLsa(
            COMPANY_A,
            connectionA.id,
            'repeat',
            {
                phone_e164: phoneDirect,
                normalized_phone: '6175550101',
                provider_created_at: new Date('2026-08-12T14:00:00.000Z'),
                provider_creation_date_time: '2026-08-12 10:00:00.000000',
            }
        );
        await insertCall(
            COMPANY_A,
            phoneDirect,
            '2026-08-12T14:02:00.000Z',
            directContact
        );
        const directJob = await insertJob(
            COMPANY_A,
            directContact,
            '2026-08-10T15:00:00.000Z'
        );
        const duplicateJob = await insertJob(
            COMPANY_A,
            duplicateContact,
            '2026-08-11T10:00:00.000Z'
        );
        const repeatJob = await insertJob(
            COMPANY_A,
            duplicateContact,
            '2026-08-12T13:00:00.000Z'
        );

        const phoneCallOnly = '+16175550202';
        const callOnlyContact = await insertContact(COMPANY_A, phoneCallOnly);
        await insertCall(COMPANY_A, phoneCallOnly, '2026-08-10T15:05:00.000Z');
        const callOnlyLsa = await insertLsa(
            COMPANY_A,
            connectionA.id,
            'call-phone',
            {
                phone_e164: phoneCallOnly,
                normalized_phone: '6175550202',
                provider_created_at: new Date('2026-08-10T15:00:00.000Z'),
                provider_creation_date_time: '2026-08-10 11:00:00.000000',
            }
        );
        const callOnlyJob = await insertJob(
            COMPANY_A,
            callOnlyContact,
            '2026-08-10T16:00:00.000Z'
        );

        const phoneCrmLead = '+16175550303';
        const crmContact = await insertContact(COMPANY_A, phoneCrmLead);
        const crmLsa = await insertLsa(
            COMPANY_A,
            connectionA.id,
            'crm-lead',
            {
                phone_e164: phoneCrmLead,
                normalized_phone: '6175550303',
                provider_created_at: new Date('2026-08-10T16:00:00.000Z'),
                provider_creation_date_time: '2026-08-10 12:00:00.000000',
            }
        );
        const crmLeadId = await insertCrmLead(
            COMPANY_A,
            phoneCrmLead,
            '2026-08-10T17:00:00.000Z',
            crmContact
        );
        const crmJob = await insertJob(
            COMPANY_A,
            crmContact,
            '2026-08-10T17:00:00.000Z',
            crmLeadId
        );

        const phoneDiagnostic = '+16175550404';
        const diagnosticContact = await insertContact(COMPANY_A, phoneDiagnostic);
        const diagnosticLsa = await insertLsa(
            COMPANY_A,
            connectionA.id,
            'diagnostic',
            {
                phone_e164: phoneDiagnostic,
                normalized_phone: '6175550404',
                provider_created_at: new Date('2026-08-10T17:00:00.000Z'),
                provider_creation_date_time: '2026-08-10 13:00:00.000000',
            }
        );
        await insertJob(
            COMPANY_A,
            diagnosticContact,
            '2026-08-10T18:00:00.000Z'
        );

        const phoneOutsideGuard = '+16175550505';
        const outsideContact = await insertContact(COMPANY_A, phoneOutsideGuard);
        const outsideLsa = await insertLsa(
            COMPANY_A,
            connectionA.id,
            'outside-guard',
            {
                phone_e164: phoneOutsideGuard,
                normalized_phone: '6175550505',
                provider_created_at: new Date('2026-08-10T18:00:00.000Z'),
                provider_creation_date_time: '2026-08-10 14:00:00.000000',
            }
        );
        await insertCall(
            COMPANY_A,
            phoneOutsideGuard,
            '2026-08-10T18:16:00.000Z',
            outsideContact
        );
        await insertJob(
            COMPANY_A,
            outsideContact,
            '2026-08-10T19:00:00.000Z'
        );

        const phoneAmbiguous = '+16175550606';
        const ambiguousContactA = await insertContact(COMPANY_A, phoneAmbiguous);
        const ambiguousContactB = await insertContact(COMPANY_A, phoneAmbiguous);
        const ambiguousLsa = await insertLsa(
            COMPANY_A,
            connectionA.id,
            'ambiguous',
            {
                phone_e164: phoneAmbiguous,
                normalized_phone: '6175550606',
                provider_created_at: new Date('2026-08-10T19:00:00.000Z'),
                provider_creation_date_time: '2026-08-10 15:00:00.000000',
            }
        );
        await insertCall(
            COMPANY_A,
            phoneAmbiguous,
            '2026-08-10T19:05:00.000Z',
            ambiguousContactA
        );
        await insertCall(
            COMPANY_A,
            phoneAmbiguous,
            '2026-08-10T19:05:00.000Z',
            ambiguousContactB
        );

        const phoneMessage = '+16175550707';
        const messageContact = await insertContact(COMPANY_A, phoneMessage);
        const messageLsa = await insertLsa(
            COMPANY_A,
            connectionA.id,
            'message',
            {
                lead_type: 'MESSAGE',
                phone_e164: phoneMessage,
                normalized_phone: '6175550707',
                provider_created_at: new Date('2026-08-10T20:00:00.000Z'),
                provider_creation_date_time: '2026-08-10 16:00:00.000000',
            }
        );
        await insertCall(
            COMPANY_A,
            phoneMessage,
            '2026-08-10T20:01:00.000Z',
            messageContact
        );

        const foreignContact = await insertContact(COMPANY_B, phoneDirect);
        await insertCall(
            COMPANY_B,
            phoneDirect,
            '2026-08-10T14:01:00.000Z',
            foreignContact
        );
        await insertLsa(COMPANY_B, connectionB.id, 'direct', {
            phone_e164: phoneDirect,
            normalized_phone: '6175550101',
        });
        await insertJob(
            COMPANY_B,
            foreignContact,
            '2026-08-10T15:00:00.000Z'
        );
        // Historical scalar contact FKs permit this anomalous cross-tenant pair.
        // The matcher must still reject it through jobs.company_id.
        const crossTenantJob = await insertJob(
            COMPANY_B,
            directContact,
            '2026-08-10T15:30:00.000Z'
        );

        const leaseB = await claim(COMPANY_B, connectionB.id);
        await lsaAttribution.matchCompany({
            companyId: COMPANY_B,
            connectionId: connectionB.id,
            expectedLeaseExpiresAt: leaseB,
            now: NOW,
        });
        const beforeB = await lsaSnapshot(COMPANY_B);

        const leaseA = await claim(COMPANY_A, connectionA.id);
        await expect(lsaAttribution.matchCompany({
            companyId: COMPANY_A,
            connectionId: connectionA.id,
            expectedLeaseExpiresAt: leaseA,
            now: NOW,
        })).resolves.toEqual({ matchedLeads: 4, attributedJobs: 5 });

        const matches = await db.query(
            `SELECT external_lead_id, match_status, match_method,
                    match_confidence, matched_contact_id, matched_lead_id
             FROM google_lsa_leads
             WHERE company_id = $1
             ORDER BY external_lead_id`,
            [COMPANY_A]
        );
        const byExternalId = new Map(
            matches.rows.map(row => [row.external_lead_id, row])
        );
        expect(byExternalId.get(directLsa.external_lead_id)).toMatchObject({
            match_status: 'matched',
            match_method: 'nearby_call_contact',
            match_confidence: 100,
            matched_contact_id: directContact,
        });
        expect(byExternalId.get(repeatLsa.external_lead_id)).toMatchObject({
            match_status: 'matched',
            match_method: 'nearby_call_contact',
            match_confidence: 100,
        });
        expect(byExternalId.get(callOnlyLsa.external_lead_id)).toMatchObject({
            match_status: 'matched',
            match_method: 'nearby_call_phone',
            match_confidence: 95,
        });
        expect(byExternalId.get(crmLsa.external_lead_id)).toMatchObject({
            match_status: 'matched',
            match_method: 'nearby_crm_lead_contact',
            match_confidence: 90,
            matched_lead_id: crmLeadId,
        });
        expect(byExternalId.get(diagnosticLsa.external_lead_id)).toMatchObject({
            match_status: 'diagnostic',
            match_method: 'phone_only',
            match_confidence: 60,
            matched_contact_id: null,
        });
        expect(byExternalId.get(outsideLsa.external_lead_id)).toMatchObject({
            match_status: 'diagnostic',
            match_method: 'phone_only',
            match_confidence: 60,
        });
        expect(byExternalId.get(ambiguousLsa.external_lead_id)).toMatchObject({
            match_status: 'ambiguous',
            match_method: null,
            match_confidence: null,
        });
        expect(byExternalId.get(messageLsa.external_lead_id)).toMatchObject({
            match_status: 'ineligible',
            match_method: null,
        });

        const attributionRows = await db.query(
            `SELECT lsa.external_lead_id, attribution.matched_job_id
             FROM google_lsa_job_attributions attribution
             JOIN google_lsa_leads lsa
               ON lsa.company_id = $1
              AND lsa.id = attribution.lsa_lead_id
             WHERE attribution.company_id = $1
             ORDER BY attribution.matched_job_id`,
            [COMPANY_A]
        );
        expect(attributionRows.rows).toEqual(expect.arrayContaining([
            { external_lead_id: 'direct', matched_job_id: directJob },
            { external_lead_id: 'direct', matched_job_id: duplicateJob },
            { external_lead_id: 'repeat', matched_job_id: repeatJob },
            { external_lead_id: 'call-phone', matched_job_id: callOnlyJob },
            { external_lead_id: 'crm-lead', matched_job_id: crmJob },
        ]));
        expect(new Set(attributionRows.rows.map(row => row.matched_job_id)).size)
            .toBe(attributionRows.rows.length);
        expect(attributionRows.rows.map(row => row.matched_job_id))
            .not.toContain(crossTenantJob);
        expect(await lsaSnapshot(COMPANY_B)).toBe(beforeB);

        await expect(lsaAttribution.matchCompany({
            companyId: COMPANY_A,
            connectionId: connectionB.id,
            expectedLeaseExpiresAt: leaseB,
            now: NOW,
        })).rejects.toMatchObject({ code: 'SYNC_CLAIM_LOST' });
        expect(await lsaSnapshot(COMPANY_B)).toBe(beforeB);
    });
});
