'use strict';

/**
 * MARKETPLACE-LEADGEN-SPLIT-001 T1 — real-PostgreSQL migration coverage.
 *
 * SELF-SKIPS when a current database is unavailable. Every case uses a
 * dedicated client and rolls its fixture back, including the rollback tests.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const marketplaceQueries = require('../backend/src/db/marketplaceQueries');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const SOURCE_CREDENTIAL_ID = 424242;
const DECOY_CREDENTIAL_ID = 424243;
const COMPANY_B_CREDENTIAL_ID = 424244;
const TAG = `MLS-${Date.now()}-${process.pid}`;
const FOUR_APP_KEYS = ['pro-referral-leads', 'rely-leads', 'nsa-leads', 'lhg-leads'];
const ALL_LEAD_APP_KEYS = ['lead-generator', ...FOUR_APP_KEYS];
const MIGRATIONS_DIR = path.join(__dirname, '..', 'backend', 'db', 'migrations');

const EXPECTED_NEW_APPS = {
    'pro-referral-leads': {
        name: 'Pro Referral Leads',
        short_description: 'Creates inbound leads from Pro Referral.',
        long_description: 'Posts Pro Referral leads into Albusto with source attribution.',
    },
    'rely-leads': {
        name: 'Rely Leads',
        short_description: 'Creates inbound leads from Rely.',
        long_description: 'Posts Rely leads into Albusto with source attribution.',
    },
    'nsa-leads': {
        name: 'NSA Leads',
        short_description: 'Creates inbound leads from NSA.',
        long_description: 'Posts NSA leads into Albusto with source attribution.',
    },
    'lhg-leads': {
        name: 'LHG Leads',
        short_description: 'Creates inbound leads from LHG.',
        long_description: 'Posts LHG leads into Albusto with source attribution.',
    },
};

let dbReady = false;

function readMigration(filename) {
    return fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

function omit(row, keys) {
    return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

async function count(client, sql, params = []) {
    const { rows } = await client.query(sql, params);
    return Number(rows[0].n);
}

async function snapshotApiIntegrations(client) {
    const { rows } = await client.query('SELECT * FROM api_integrations ORDER BY id');
    return rows;
}

async function withTxn(fn) {
    const client = await db.pool.connect();
    let began = false;
    try {
        await client.query('BEGIN');
        began = true;
        return await fn(client);
    } finally {
        try {
            if (began) await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
}

async function apply169(client) {
    await client.query(readMigration('170_split_lead_generator_marketplace_apps.sql'));
}

async function applyRollback169(client) {
    await client.query(readMigration('rollback_170_split_lead_generator_marketplace_apps.sql'));
}

async function resetToPre169(client) {
    await client.query(`
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ language 'plpgsql';
    `);
    await client.query(readMigration('083_create_marketplace_apps.sql'));
    await client.query(
        `DELETE FROM marketplace_installations
         WHERE app_id IN (
             SELECT id FROM marketplace_apps WHERE app_key = ANY($1::text[])
         )`,
        [FOUR_APP_KEYS]
    );
    await client.query(
        'DELETE FROM marketplace_apps WHERE app_key = ANY($1::text[])',
        [FOUR_APP_KEYS]
    );
    await client.query(
        `DELETE FROM marketplace_installations
         WHERE company_id = $1
           AND app_id = (SELECT id FROM marketplace_apps WHERE app_key = 'lead-generator')`,
        [DEFAULT_COMPANY_ID]
    );
    await client.query(
        'DELETE FROM api_integrations WHERE id = ANY($1::bigint[])',
        [[SOURCE_CREDENTIAL_ID, DECOY_CREDENTIAL_ID, COMPANY_B_CREDENTIAL_ID]]
    );
    await client.query(
        `INSERT INTO api_integrations
            (id, client_name, key_id, secret_hash, scopes, company_id)
         VALUES
            ($1, 'MLS-fixture', $2, 'x', '["leads:create"]'::jsonb, $4),
            ($3, 'MLS-decoy', $5, 'x', '["leads:create"]'::jsonb, $4)`,
        [
            SOURCE_CREDENTIAL_ID,
            `ak_mls_${TAG}`,
            DECOY_CREDENTIAL_ID,
            DEFAULT_COMPANY_ID,
            `ak_mls_decoy_${TAG}`,
        ]
    );

    const appResult = await client.query(
        "SELECT id FROM marketplace_apps WHERE app_key = 'lead-generator'"
    );
    const leadGeneratorAppId = appResult.rows[0].id;
    const decoyResult = await client.query(
        `INSERT INTO marketplace_installations
            (company_id, app_id, api_integration_id, status, installed_at, created_at)
         VALUES ($1, $2, $3, 'disconnected', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')
         RETURNING id`,
        [DEFAULT_COMPANY_ID, leadGeneratorAppId, DECOY_CREDENTIAL_ID]
    );
    const sourceResult = await client.query(
        `INSERT INTO marketplace_installations
            (company_id, app_id, api_integration_id, status, installed_at, created_at)
         VALUES ($1, $2, $3, 'connected', NOW(), NOW())
         RETURNING id`,
        [DEFAULT_COMPANY_ID, leadGeneratorAppId, SOURCE_CREDENTIAL_ID]
    );

    return {
        leadGeneratorAppId,
        sourceInstallationId: sourceResult.rows[0].id,
        decoyInstallationId: decoyResult.rows[0].id,
    };
}

async function createCompanyB(client, suffix) {
    const companyId = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, 'Marketplace Lead Split Company B', $2)`,
        [companyId, `mls-company-b-${suffix}-${TAG}`.toLowerCase()]
    );
    return companyId;
}

async function assertNoNewInstallations(client) {
    expect(await count(
        client,
        `SELECT COUNT(*) AS n
         FROM marketplace_installations mi
         JOIN marketplace_apps a ON a.id = mi.app_id
         WHERE a.app_key = ANY($1::text[])`,
        [FOUR_APP_KEYS]
    )).toBe(0);
    expect(await count(
        client,
        `SELECT COUNT(*) AS n
         FROM marketplace_installations mi
         JOIN marketplace_apps a ON a.id = mi.app_id
         WHERE a.app_key = ANY($1::text[])
           AND mi.status = 'connected'
           AND mi.api_integration_id IS NULL`,
        [FOUR_APP_KEYS]
    )).toBe(0);
    expect(await count(
        client,
        'SELECT COUNT(*) AS n FROM marketplace_apps WHERE app_key = ANY($1::text[])',
        [FOUR_APP_KEYS]
    )).toBe(4);
    const { rows } = await client.query(
        "SELECT name FROM marketplace_apps WHERE app_key = 'lead-generator'"
    );
    expect(rows[0].name).toBe('Website Leads');
}

beforeAll(async () => {
    try {
        await db.query('SELECT 1 FROM companies LIMIT 1');
        await db.query('SELECT 1 FROM api_integrations LIMIT 1');
        dbReady = true;
    } catch (error) {
        console.warn('\n[marketplaceLeadgenSplit.db] SKIPPED-NEEDS-DB —', error.message, '\n');
        dbReady = false;
    }
});

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

describe('MARKETPLACE-LEADGEN-SPLIT-001 migration 169 · real PostgreSQL', () => {
    it('TC-M1-01 · fresh apply seeds the exact catalog on the resolved shared credential', async () => {
        if (!dbReady) return console.warn('TC-M1-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            const fixture = await resetToPre169(client);
            const leadBefore = (await client.query(
                "SELECT * FROM marketplace_apps WHERE app_key = 'lead-generator'"
            )).rows[0];
            const sourceBefore = (await client.query(
                'SELECT * FROM marketplace_installations WHERE id = $1',
                [fixture.sourceInstallationId]
            )).rows[0];
            const eventsBefore = await count(
                client,
                'SELECT COUNT(*) AS n FROM marketplace_installation_events'
            );
            const apiBefore = await snapshotApiIntegrations(client);

            await apply169(client);

            const catalog = (await client.query(
                `SELECT app_key
                 FROM marketplace_apps
                 WHERE category = 'lead_generation'
                 ORDER BY app_key`
            )).rows.map(row => row.app_key);
            expect(catalog).toEqual([...ALL_LEAD_APP_KEYS].sort());

            const leadAfter = (await client.query(
                "SELECT * FROM marketplace_apps WHERE app_key = 'lead-generator'"
            )).rows[0];
            expect(leadAfter).toMatchObject({
                name: 'Website Leads',
                short_description: 'Creates inbound leads from your company website.',
                long_description: 'Posts orders and form submissions from your company website into Albusto as leads with source attribution.',
            });
            expect(omit(leadAfter, ['name', 'short_description', 'long_description', 'updated_at']))
                .toEqual(omit(leadBefore, ['name', 'short_description', 'long_description', 'updated_at']));

            const seeded = (await client.query(
                `SELECT mi.*, a.app_key
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE a.app_key = ANY($1::text[])
                 ORDER BY a.app_key`,
                [FOUR_APP_KEYS]
            )).rows;
            expect(seeded).toHaveLength(4);
            for (const row of seeded) {
                expect(row.company_id).toBe(DEFAULT_COMPANY_ID);
                expect(Number(row.api_integration_id)).toBe(SOURCE_CREDENTIAL_ID);
                expect(row.status).toBe('connected');
                expect(row.installed_at).not.toBeNull();
                expect(row.installed_by).toBeNull();
                expect(row.metadata).toEqual({
                    seeded_by: 'MARKETPLACE-LEADGEN-SPLIT-001',
                    shared_credential: true,
                });
            }
            expect(await count(
                client,
                `SELECT COUNT(*) AS n
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE a.app_key = ANY($1::text[])
                   AND mi.company_id <> $2`,
                [FOUR_APP_KEYS, DEFAULT_COMPANY_ID]
            )).toBe(0);
            expect(await count(
                client,
                'SELECT COUNT(*) AS n FROM marketplace_installation_events'
            )).toBe(eventsBefore);
            expect(await snapshotApiIntegrations(client)).toEqual(apiBefore);
            await expect(client.query(
                'SELECT * FROM marketplace_installations WHERE id = $1',
                [fixture.sourceInstallationId]
            )).resolves.toMatchObject({ rows: [sourceBefore] });
        });
    });

    it('TC-M2-01 · repeated apply preserves app ids, installations, events, and credentials', async () => {
        if (!dbReady) return console.warn('TC-M2-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            await resetToPre169(client);
            await apply169(client);
            const appsBefore = (await client.query(
                `SELECT to_jsonb(a) - 'updated_at' AS snapshot
                 FROM marketplace_apps a
                 WHERE category = 'lead_generation'
                 ORDER BY app_key`
            )).rows;
            const installationsBefore = (await client.query(
                `SELECT * FROM marketplace_installations
                 WHERE company_id = $1
                 ORDER BY id`,
                [DEFAULT_COMPANY_ID]
            )).rows;
            const eventsBefore = await count(
                client,
                'SELECT COUNT(*) AS n FROM marketplace_installation_events'
            );
            const apiBefore = await snapshotApiIntegrations(client);

            await apply169(client);
            await apply169(client);

            const appsAfter = (await client.query(
                `SELECT to_jsonb(a) - 'updated_at' AS snapshot
                 FROM marketplace_apps a
                 WHERE category = 'lead_generation'
                 ORDER BY app_key`
            )).rows;
            const installationsAfter = (await client.query(
                `SELECT * FROM marketplace_installations
                 WHERE company_id = $1
                 ORDER BY id`,
                [DEFAULT_COMPANY_ID]
            )).rows;
            expect(appsAfter).toEqual(appsBefore);
            expect(installationsAfter).toEqual(installationsBefore);
            expect(await count(
                client,
                'SELECT COUNT(*) AS n FROM marketplace_installation_events'
            )).toBe(eventsBefore);
            expect(await snapshotApiIntegrations(client)).toEqual(apiBefore);
        });
    });

    it('TC-M3-01 · the real boot list re-applies 169 after 083 and self-heals the catalog', async () => {
        if (!dbReady) return console.warn('TC-M3-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            await resetToPre169(client);
            await marketplaceQueries.ensureMarketplaceSchema(client);

            const lead = await client.query(
                "SELECT name FROM marketplace_apps WHERE app_key = 'lead-generator'"
            );
            expect(lead.rows[0].name).toBe('Website Leads');
            expect(await count(
                client,
                `SELECT COUNT(*) AS n FROM marketplace_apps
                 WHERE app_key = ANY($1::text[]) AND status = 'published'`,
                [FOUR_APP_KEYS]
            )).toBe(4);
            const firstSeed = (await client.query(
                `SELECT mi.id, mi.api_integration_id
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1 AND a.app_key = ANY($2::text[])
                 ORDER BY mi.id`,
                [DEFAULT_COMPANY_ID, FOUR_APP_KEYS]
            )).rows;
            expect(firstSeed).toHaveLength(4);
            expect(firstSeed.every(row => Number(row.api_integration_id) === SOURCE_CREDENTIAL_ID)).toBe(true);

            await marketplaceQueries.ensureMarketplaceSchema(client);

            const secondSeed = (await client.query(
                `SELECT mi.id, mi.api_integration_id
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1 AND a.app_key = ANY($2::text[])
                 ORDER BY mi.id`,
                [DEFAULT_COMPANY_ID, FOUR_APP_KEYS]
            )).rows;
            expect(secondSeed).toEqual(firstSeed);
            const leadAfterReplay = await client.query(
                "SELECT name FROM marketplace_apps WHERE app_key = 'lead-generator'"
            );
            expect(leadAfterReplay.rows[0].name).toBe('Website Leads');
        });
    });

    it('TC-M4-01 · ineligible source variants seed nothing and later eligible state self-heals', async () => {
        if (!dbReady) return console.warn('TC-M4-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            const fixture = await resetToPre169(client);
            await client.query(
                `DELETE FROM marketplace_installations
                 WHERE company_id = $1 AND app_id = $2`,
                [DEFAULT_COMPANY_ID, fixture.leadGeneratorAppId]
            );
            await apply169(client);
            await assertNoNewInstallations(client);

            await client.query(
                `INSERT INTO marketplace_installations
                    (company_id, app_id, api_integration_id, status, installed_at)
                 VALUES ($1, $2, $3, 'connected', NOW())`,
                [DEFAULT_COMPANY_ID, fixture.leadGeneratorAppId, SOURCE_CREDENTIAL_ID]
            );
            await apply169(client);
            expect(await count(
                client,
                `SELECT COUNT(*) AS n
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1 AND a.app_key = ANY($2::text[])`,
                [DEFAULT_COMPANY_ID, FOUR_APP_KEYS]
            )).toBe(4);
        });

        await withTxn(async client => {
            const fixture = await resetToPre169(client);
            await client.query(
                'DELETE FROM marketplace_installations WHERE id = $1',
                [fixture.sourceInstallationId]
            );
            await apply169(client);
            await assertNoNewInstallations(client);
        });

        await withTxn(async client => {
            const fixture = await resetToPre169(client);
            await client.query(
                'UPDATE marketplace_installations SET api_integration_id = NULL WHERE id = $1',
                [fixture.sourceInstallationId]
            );
            await apply169(client);
            await assertNoNewInstallations(client);
        });
    });

    it('TC-M5-01 · disconnected and revoked rows are never resurrected by replay', async () => {
        if (!dbReady) return console.warn('TC-M5-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            await resetToPre169(client);
            await apply169(client);
            const disconnected = (await client.query(
                `UPDATE marketplace_installations mi
                 SET status = 'disconnected'
                 FROM marketplace_apps a
                 WHERE mi.app_id = a.id
                   AND mi.company_id = $1
                   AND a.app_key = 'nsa-leads'
                 RETURNING mi.*`,
                [DEFAULT_COMPANY_ID]
            )).rows[0];
            const otherRows = (await client.query(
                `SELECT mi.*
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1
                   AND a.app_key = ANY($2::text[])
                   AND a.app_key <> 'nsa-leads'
                 ORDER BY mi.id`,
                [DEFAULT_COMPANY_ID, ALL_LEAD_APP_KEYS]
            )).rows;

            await apply169(client);
            await apply169(client);

            const afterDisconnected = (await client.query(
                `SELECT mi.*
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1 AND a.app_key = 'nsa-leads'`,
                [DEFAULT_COMPANY_ID]
            )).rows;
            expect(afterDisconnected).toEqual([disconnected]);
            const otherRowsAfter = (await client.query(
                `SELECT mi.*
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1
                   AND a.app_key = ANY($2::text[])
                   AND a.app_key <> 'nsa-leads'
                 ORDER BY mi.id`,
                [DEFAULT_COMPANY_ID, ALL_LEAD_APP_KEYS]
            )).rows;
            expect(otherRowsAfter).toEqual(otherRows);

            const revoked = (await client.query(
                `UPDATE marketplace_installations
                 SET status = 'revoked'
                 WHERE id = $1
                 RETURNING *`,
                [disconnected.id]
            )).rows[0];
            await apply169(client);
            const afterRevoked = (await client.query(
                `SELECT mi.*
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1 AND a.app_key = 'nsa-leads'`,
                [DEFAULT_COMPANY_ID]
            )).rows;
            expect(afterRevoked).toEqual([revoked]);
        });
    });

    it('TC-M6-01 · rollback restores 083 copy and leaves the live installation and credential intact', async () => {
        if (!dbReady) return console.warn('TC-M6-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            const fixture = await resetToPre169(client);
            await apply169(client);
            const newAppIds = (await client.query(
                'SELECT id FROM marketplace_apps WHERE app_key = ANY($1::text[]) ORDER BY id',
                [FOUR_APP_KEYS]
            )).rows.map(row => row.id);
            const sourceBefore = (await client.query(
                'SELECT * FROM marketplace_installations WHERE id = $1',
                [fixture.sourceInstallationId]
            )).rows[0];
            const apiBefore = await snapshotApiIntegrations(client);
            const callQaBefore = (await client.query(
                "SELECT * FROM marketplace_apps WHERE app_key = 'call-qa-agent'"
            )).rows[0];
            const eventsBefore = await count(
                client,
                'SELECT COUNT(*) AS n FROM marketplace_installation_events'
            );

            const readRollbackState = async () => ({
                lead: (await client.query(
                    "SELECT * FROM marketplace_apps WHERE app_key = 'lead-generator'"
                )).rows[0],
                source: (await client.query(
                    'SELECT * FROM marketplace_installations WHERE id = $1',
                    [fixture.sourceInstallationId]
                )).rows[0],
                api: await snapshotApiIntegrations(client),
                callQa: (await client.query(
                    "SELECT * FROM marketplace_apps WHERE app_key = 'call-qa-agent'"
                )).rows[0],
                appCount: await count(
                    client,
                    'SELECT COUNT(*) AS n FROM marketplace_apps WHERE app_key = ANY($1::text[])',
                    [FOUR_APP_KEYS]
                ),
                installationCount: await count(
                    client,
                    'SELECT COUNT(*) AS n FROM marketplace_installations WHERE app_id = ANY($1::bigint[])',
                    [newAppIds]
                ),
                eventCount: await count(
                    client,
                    'SELECT COUNT(*) AS n FROM marketplace_installation_events'
                ),
            });

            await applyRollback169(client);
            const firstRollback = await readRollbackState();
            expect(firstRollback.lead).toMatchObject({
                name: 'Lead Generator',
                short_description: 'Creates inbound leads from external campaigns.',
                long_description: 'Posts validated campaign leads into Blanc with source attribution.',
            });
            expect(firstRollback.appCount).toBe(0);
            expect(firstRollback.installationCount).toBe(0);
            expect(firstRollback.source).toEqual(sourceBefore);
            expect(firstRollback.api).toEqual(apiBefore);
            expect(firstRollback.callQa).toEqual(callQaBefore);
            expect(firstRollback.eventCount).toBe(eventsBefore);

            await applyRollback169(client);
            expect(await readRollbackState()).toEqual(firstRollback);
        });
    });

    it('TC-M7-01 · rollback orphans another company credential without revoking or deleting it', async () => {
        if (!dbReady) return console.warn('TC-M7-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            const fixture = await resetToPre169(client);
            await apply169(client);
            const companyB = await createCompanyB(client, 'm7');
            const relyAppId = (await client.query(
                "SELECT id FROM marketplace_apps WHERE app_key = 'rely-leads'"
            )).rows[0].id;
            await client.query(
                `INSERT INTO api_integrations
                    (id, client_name, key_id, secret_hash, scopes, company_id, marketplace_app_id)
                 VALUES ($1, 'MLS-company-b', $2, 'x', '["leads:create"]'::jsonb, $3, $4)`,
                [COMPANY_B_CREDENTIAL_ID, `ak_mls_company_b_${TAG}`, companyB, relyAppId]
            );
            const installationId = (await client.query(
                `INSERT INTO marketplace_installations
                    (company_id, app_id, api_integration_id, status, installed_at)
                 VALUES ($1, $2, $3, 'connected', NOW())
                 RETURNING id`,
                [companyB, relyAppId, COMPANY_B_CREDENTIAL_ID]
            )).rows[0].id;
            await client.query(
                `UPDATE api_integrations
                 SET marketplace_installation_id = $1
                 WHERE id = $2`,
                [installationId, COMPANY_B_CREDENTIAL_ID]
            );
            const eventId = (await client.query(
                `INSERT INTO marketplace_installation_events
                    (company_id, installation_id, app_id, api_integration_id, event_type)
                 VALUES ($1, $2, $3, $4, 'connect_requested')
                 RETURNING id`,
                [companyB, installationId, relyAppId, COMPANY_B_CREDENTIAL_ID]
            )).rows[0].id;
            const sourceBefore = (await client.query(
                'SELECT * FROM marketplace_installations WHERE id = $1',
                [fixture.sourceInstallationId]
            )).rows[0];
            const liveCredentialBefore = (await client.query(
                'SELECT * FROM api_integrations WHERE id = $1',
                [SOURCE_CREDENTIAL_ID]
            )).rows[0];

            await applyRollback169(client);

            expect(await count(
                client,
                'SELECT COUNT(*) AS n FROM marketplace_installations WHERE id = $1',
                [installationId]
            )).toBe(0);
            const companyBCredential = (await client.query(
                'SELECT * FROM api_integrations WHERE id = $1',
                [COMPANY_B_CREDENTIAL_ID]
            )).rows[0];
            expect(companyBCredential).toMatchObject({
                revoked_at: null,
                marketplace_app_id: null,
                marketplace_installation_id: null,
            });
            const event = (await client.query(
                'SELECT * FROM marketplace_installation_events WHERE id = $1',
                [eventId]
            )).rows[0];
            expect(event).toMatchObject({
                installation_id: null,
                app_id: null,
            });
            expect(Number(event.api_integration_id)).toBe(COMPANY_B_CREDENTIAL_ID);
            await expect(client.query(
                'SELECT * FROM marketplace_installations WHERE id = $1',
                [fixture.sourceInstallationId]
            )).resolves.toMatchObject({ rows: [sourceBefore] });
            await expect(client.query(
                'SELECT * FROM api_integrations WHERE id = $1',
                [SOURCE_CREDENTIAL_ID]
            )).resolves.toMatchObject({ rows: [liveCredentialBefore] });
        });
    });

    it('TC-M8-01 · api_integrations is byte-identical across apply, replay, boot, and rollback', async () => {
        if (!dbReady) return console.warn('TC-M8-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            await resetToPre169(client);
            const snapshots = [await snapshotApiIntegrations(client)];
            await apply169(client);
            snapshots.push(await snapshotApiIntegrations(client));
            await apply169(client);
            snapshots.push(await snapshotApiIntegrations(client));
            await marketplaceQueries.ensureMarketplaceSchema(client);
            snapshots.push(await snapshotApiIntegrations(client));
            await applyRollback169(client);
            snapshots.push(await snapshotApiIntegrations(client));

            for (const snapshot of snapshots.slice(1)) {
                expect(snapshot).toEqual(snapshots[0]);
            }
            for (const snapshot of snapshots) {
                expect(snapshot.find(row => Number(row.id) === SOURCE_CREDENTIAL_ID).revoked_at).toBeNull();
            }
        });
    });

    it('TC-G3-01 · an unrevoked shared credential prevents reconciler cascade', async () => {
        if (!dbReady) return console.warn('TC-G3-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            await resetToPre169(client);
            await apply169(client);
            await client.query(
                `UPDATE marketplace_installations mi
                 SET status = 'disconnected'
                 FROM marketplace_apps a
                 WHERE mi.app_id = a.id
                   AND mi.company_id = $1
                   AND a.app_key = 'nsa-leads'`,
                [DEFAULT_COMPANY_ID]
            );

            await marketplaceQueries.reconcileRevokedInstallations(DEFAULT_COMPANY_ID, client);
            const firstStatuses = (await client.query(
                `SELECT a.app_key, mi.status
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1
                   AND a.app_key = ANY($2::text[])
                   AND (a.app_key <> 'lead-generator' OR mi.status = 'connected')
                 ORDER BY a.app_key`,
                [DEFAULT_COMPANY_ID, ALL_LEAD_APP_KEYS]
            )).rows;
            expect(firstStatuses).toHaveLength(5);
            expect(firstStatuses.find(row => row.app_key === 'nsa-leads').status).toBe('disconnected');
            expect(firstStatuses.filter(row => row.app_key !== 'nsa-leads').every(row => row.status === 'connected')).toBe(true);

            await client.query(
                'UPDATE api_integrations SET revoked_at = NOW() WHERE id = $1',
                [SOURCE_CREDENTIAL_ID]
            );
            await marketplaceQueries.reconcileRevokedInstallations(DEFAULT_COMPANY_ID, client);
            const controlStatuses = (await client.query(
                `SELECT a.app_key, mi.status
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1
                   AND a.app_key = ANY($2::text[])
                   AND (a.app_key <> 'lead-generator' OR mi.api_integration_id = $3)
                 ORDER BY a.app_key`,
                [DEFAULT_COMPANY_ID, ALL_LEAD_APP_KEYS, SOURCE_CREDENTIAL_ID]
            )).rows;
            expect(controlStatuses.find(row => row.app_key === 'nsa-leads').status).toBe('disconnected');
            expect(controlStatuses.filter(row => row.app_key !== 'nsa-leads').every(row => row.status === 'revoked')).toBe(true);
        });
    });

    it('TC-C1-01 · any company lists exactly five published lead-generation apps', async () => {
        if (!dbReady) return console.warn('TC-C1-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            await resetToPre169(client);
            await apply169(client);
            const companyB = await createCompanyB(client, 'c1');
            const listed = await marketplaceQueries.listPublishedAppsWithInstallation(companyB, client);
            const leadApps = listed
                .filter(row => row.category === 'lead_generation')
                .map(row => ({ app_key: row.app_key, name: row.name, status: row.status }))
                .sort((a, b) => a.app_key.localeCompare(b.app_key));
            expect(leadApps).toEqual([
                { app_key: 'lead-generator', name: 'Website Leads', status: 'published' },
                ...FOUR_APP_KEYS.map(appKey => ({
                    app_key: appKey,
                    name: EXPECTED_NEW_APPS[appKey].name,
                    status: 'published',
                })),
            ].sort((a, b) => a.app_key.localeCompare(b.app_key)));
        });
    });

    it('TC-C2-01 · new app columns and copy are exact while legacy branding stays unchanged', async () => {
        if (!dbReady) return console.warn('TC-C2-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            await resetToPre169(client);
            await apply169(client);
            const rows = (await client.query(
                'SELECT * FROM marketplace_apps WHERE app_key = ANY($1::text[]) ORDER BY app_key',
                [FOUR_APP_KEYS]
            )).rows;
            expect(rows).toHaveLength(4);
            for (const row of rows) {
                expect(row).toMatchObject({
                    ...EXPECTED_NEW_APPS[row.app_key],
                    provider_name: 'Albusto',
                    category: 'lead_generation',
                    app_type: 'internal',
                    requested_scopes: ['leads:create'],
                    provisioning_mode: 'manual',
                    status: 'published',
                    support_email: 'support@albusto.com',
                    docs_url: '/settings/api-docs',
                    metadata: { access_summary: ['Create leads'] },
                    privacy_url: null,
                    logo_url: null,
                });
            }
            const userVisibleStrings = rows.flatMap(row => [
                row.name,
                row.short_description,
                row.long_description,
            ]);
            expect(userVisibleStrings.some(value => /Blanc/.test(value))).toBe(false);
            expect(userVisibleStrings.some(value => /enforc|блок/i.test(value))).toBe(false);

            const leadGenerator = (await client.query(
                "SELECT * FROM marketplace_apps WHERE app_key = 'lead-generator'"
            )).rows[0];
            expect(leadGenerator).toMatchObject({
                provider_name: 'Blanc Labs',
                support_email: 'support@blanc.local',
                privacy_url: 'https://blanc.local/privacy',
            });
        });
    });

    it('TC-C3-01 · default company has five distinct connected rows on one credential', async () => {
        if (!dbReady) return console.warn('TC-C3-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            const fixture = await resetToPre169(client);
            await apply169(client);
            const listed = await marketplaceQueries.listPublishedAppsWithInstallation(
                DEFAULT_COMPANY_ID,
                client
            );
            const listedLeadApps = listed.filter(row => row.category === 'lead_generation');
            expect(listedLeadApps).toHaveLength(5);
            expect(listedLeadApps.every(row => row.installation_status === 'connected')).toBe(true);
            expect(listedLeadApps.every(row => row.installation_id !== null)).toBe(true);

            const connected = (await client.query(
                `SELECT mi.id, mi.api_integration_id, a.app_key
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1
                   AND mi.status = 'connected'
                   AND a.app_key = ANY($2::text[])
                 ORDER BY a.app_key`,
                [DEFAULT_COMPANY_ID, ALL_LEAD_APP_KEYS]
            )).rows;
            expect(connected).toHaveLength(5);
            expect(new Set(connected.map(row => String(row.id))).size).toBe(5);
            expect(connected.map(row => String(row.id))).toContain(String(fixture.sourceInstallationId));
            expect(connected.every(row => Number(row.api_integration_id) === SOURCE_CREDENTIAL_ID)).toBe(true);
        });
    });

    it('TC-C4-01 · a non-default company sees five available apps and no seeded installation', async () => {
        if (!dbReady) return console.warn('TC-C4-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            await resetToPre169(client);
            await apply169(client);
            const companyB = await createCompanyB(client, 'c4');
            const listed = await marketplaceQueries.listPublishedAppsWithInstallation(companyB, client);
            const leadApps = listed.filter(row => row.category === 'lead_generation');
            expect(leadApps).toHaveLength(5);
            expect(leadApps.every(row => row.installation_id === null)).toBe(true);
            expect(leadApps.every(row => row.installation_status === null)).toBe(true);
            expect(await count(
                client,
                'SELECT COUNT(*) AS n FROM marketplace_installations WHERE company_id = $1',
                [companyB]
            )).toBe(0);
        });
    });
});

describe('MARKETPLACE-LEADGEN-SPLIT-001 credential-sharing helper · real PostgreSQL', () => {
    it('TC-G5-01 · count is company-scoped, active-only, self-excluding, and falsy-safe', async () => {
        if (!dbReady) return console.warn('TC-G5-01 SKIPPED-NEEDS-DB');

        await withTxn(async client => {
            await resetToPre169(client);
            await apply169(client);

            const installations = (await client.query(
                `SELECT mi.id, a.app_key
                 FROM marketplace_installations mi
                 JOIN marketplace_apps a ON a.id = mi.app_id
                 WHERE mi.company_id = $1
                   AND a.app_key = ANY($2::text[])`,
                [DEFAULT_COMPANY_ID, ALL_LEAD_APP_KEYS]
            )).rows;
            const idByKey = Object.fromEntries(
                installations.map(row => [row.app_key, row.id])
            );
            const companyB = await createCompanyB(client, 'g5');
            await client.query(
                `INSERT INTO marketplace_installations
                    (company_id, app_id, api_integration_id, status, installed_at)
                 VALUES (
                    $1,
                    (SELECT id FROM marketplace_apps WHERE app_key = 'nsa-leads'),
                    $2,
                    'connected',
                    NOW()
                 )`,
                [companyB, SOURCE_CREDENTIAL_ID]
            );
            await client.query(
                `UPDATE marketplace_installations mi
                 SET status = CASE a.app_key
                     WHEN 'rely-leads' THEN 'provisioning_failed'
                     WHEN 'lhg-leads' THEN 'disconnected'
                     ELSE mi.status
                 END
                 FROM marketplace_apps a
                 WHERE mi.app_id = a.id
                   AND mi.company_id = $1
                   AND a.app_key IN ('rely-leads', 'lhg-leads')`,
                [DEFAULT_COMPANY_ID]
            );

            const nsaCount = await marketplaceQueries.countOtherActiveInstallationsOnCredential(
                DEFAULT_COMPANY_ID,
                SOURCE_CREDENTIAL_ID,
                idByKey['nsa-leads'],
                client
            );
            expect(nsaCount).toBe(3);
            expect(typeof nsaCount).toBe('number');
            await expect(marketplaceQueries.countOtherActiveInstallationsOnCredential(
                DEFAULT_COMPANY_ID,
                SOURCE_CREDENTIAL_ID,
                idByKey['lead-generator'],
                client
            )).resolves.toBe(3);

            await client.query(
                `UPDATE marketplace_installations mi
                 SET status = CASE
                     WHEN a.app_key = 'rely-leads' THEN 'revoked'
                     ELSE 'disconnected'
                 END
                 FROM marketplace_apps a
                 WHERE mi.app_id = a.id
                   AND mi.company_id = $1
                   AND a.app_key = ANY($2::text[])`,
                [DEFAULT_COMPANY_ID, FOUR_APP_KEYS]
            );
            await expect(marketplaceQueries.countOtherActiveInstallationsOnCredential(
                DEFAULT_COMPANY_ID,
                SOURCE_CREDENTIAL_ID,
                idByKey['lead-generator'],
                client
            )).resolves.toBe(0);

            const spyClient = { query: jest.fn((...args) => client.query(...args)) };
            await expect(marketplaceQueries.countOtherActiveInstallationsOnCredential(
                DEFAULT_COMPANY_ID,
                null,
                idByKey['nsa-leads'],
                spyClient
            )).resolves.toBe(0);
            await expect(marketplaceQueries.countOtherActiveInstallationsOnCredential(
                DEFAULT_COMPANY_ID,
                undefined,
                idByKey['nsa-leads'],
                spyClient
            )).resolves.toBe(0);
            await expect(marketplaceQueries.countOtherActiveInstallationsOnCredential(
                DEFAULT_COMPANY_ID,
                0,
                idByKey['nsa-leads'],
                spyClient
            )).resolves.toBe(0);
            expect(spyClient.query).not.toHaveBeenCalled();
        });
    });
});
