'use strict';

/**
 * RELY-LEADS-SETTINGS-001 T2 — real-PostgreSQL JSONB settings merge coverage.
 *
 * SELF-SKIPS when no database with migration 169 is reachable. The fixture is
 * tagged, transaction-rolled-back, and covered by an afterAll cleanup fallback.
 */

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const marketplaceQueries = require('../backend/src/db/marketplaceQueries');

const TAG = `RLS-${Date.now()}-${process.pid}`;
const COMPANY_ID = randomUUID();

let dbReady = false;
let appId = null;

beforeAll(async () => {
    try {
        await marketplaceQueries.ensureMarketplaceSchema();
        const app = await db.query(
            `SELECT id
             FROM marketplace_apps
             WHERE app_key = 'rely-leads'
               AND status = 'published'
             LIMIT 1`
        );
        if (!app.rows[0]) throw new Error('migration 169 rely-leads app is unavailable');
        appId = app.rows[0].id;
        dbReady = true;
    } catch (error) {
        console.warn('\n[relyLeadsSettings.db] SKIPPED-NEEDS-DB —', error.message, '\n');
        dbReady = false;
    }
});

afterAll(async () => {
    if (dbReady) {
        try {
            await db.query(
                `DELETE FROM companies
                 WHERE id = $1
                   AND slug = $2`,
                [COMPANY_ID, `rely-settings-${TAG}`.toLowerCase()]
            );
        } catch (error) {
            console.warn('[relyLeadsSettings.db] cleanup failed:', error.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

describe('RELY-LEADS-SETTINGS-001 settings merge · real PostgreSQL', () => {
    test('TC-S3-DB-01 · top-level merge preserves metadata, replaces settings, and handles NULL', async () => {
        if (!dbReady) return console.warn('TC-S3-DB-01 SKIPPED-NEEDS-DB');

        const client = await db.pool.connect();
        let began = false;
        try {
            await client.query('BEGIN');
            began = true;
            await client.query(
                `INSERT INTO companies (id, name, slug)
                 VALUES ($1, $2, $3)`,
                [COMPANY_ID, `Rely Settings ${TAG}`, `rely-settings-${TAG}`.toLowerCase()]
            );
            const inserted = await client.query(
                `INSERT INTO marketplace_installations
                    (company_id, app_id, status, installed_at, metadata, updated_at)
                 VALUES ($1, $2, 'connected', NOW(), $3::jsonb, '2020-01-01T00:00:00.000Z')
                 RETURNING id, updated_at`,
                [
                    COMPANY_ID,
                    appId,
                    JSON.stringify({
                        seeded_by: 'MARKETPLACE-LEADGEN-SPLIT-001',
                        shared_credential: true,
                        fixture_tag: TAG,
                    }),
                ]
            );
            const installationId = inserted.rows[0].id;

            const firstSettings = {
                zone: { mode: 'custom', custom_zips: ['02301'] },
                unit_types: ['Dishwasher'],
                brands: [],
                updated_at: '2026-07-13T00:00:00.000Z',
                updated_by: null,
            };
            const first = await marketplaceQueries.setInstallationSettings(
                COMPANY_ID,
                installationId,
                firstSettings,
                client
            );
            expect(first.metadata).toEqual({
                seeded_by: 'MARKETPLACE-LEADGEN-SPLIT-001',
                shared_credential: true,
                fixture_tag: TAG,
                settings: firstSettings,
            });
            expect(new Date(first.updated_at).getTime())
                .toBeGreaterThan(new Date('2020-01-01T00:00:00.000Z').getTime());

            const replacementSettings = {
                zone: { mode: 'company', custom_zips: [] },
                unit_types: [],
                brands: ['GE'],
                updated_at: '2026-07-13T01:00:00.000Z',
                updated_by: null,
            };
            const replacement = await marketplaceQueries.setInstallationSettings(
                COMPANY_ID,
                installationId,
                replacementSettings,
                client
            );
            expect(replacement.metadata).toEqual({
                seeded_by: 'MARKETPLACE-LEADGEN-SPLIT-001',
                shared_credential: true,
                fixture_tag: TAG,
                settings: replacementSettings,
            });
            expect(JSON.stringify(replacement.metadata)).not.toContain('Dishwasher');

            await client.query(
                'ALTER TABLE marketplace_installations ALTER COLUMN metadata DROP NOT NULL'
            );
            await client.query(
                `UPDATE marketplace_installations
                 SET metadata = NULL
                 WHERE company_id = $1
                   AND id = $2`,
                [COMPANY_ID, installationId]
            );
            const nullLegSettings = {
                zone: { mode: 'custom', custom_zips: [] },
                unit_types: [],
                brands: [],
                updated_at: '2026-07-13T02:00:00.000Z',
                updated_by: null,
            };
            const nullLeg = await marketplaceQueries.setInstallationSettings(
                COMPANY_ID,
                installationId,
                nullLegSettings,
                client
            );
            expect(nullLeg.metadata).toEqual({ settings: nullLegSettings });
        } finally {
            try {
                if (began) await client.query('ROLLBACK');
            } finally {
                client.release();
            }
        }
    });
});

describe('RELY-LEADS-SETTINGS-001 rejected-lead badge · real PostgreSQL', () => {
    test('TC-R4-DB-01 · rejected marker is excluded while NULL and rejected:false are counted', async () => {
        if (!dbReady) return console.warn('TC-R4-DB-01 SKIPPED-NEEDS-DB');

        const leadsService = require('../backend/src/services/leadsService');
        const suffix = TAG.replace(/[^A-Za-z0-9]/g, '').slice(-12);
        const leadUuids = [`R4A${suffix}`, `R4B${suffix}`, `R4C${suffix}`];
        const marker = {
            rely_filter: {
                rejected: true,
                reason: 'out_of_area',
                evaluated_at: '2026-07-13T00:00:00.000Z',
                zip: '02888',
                unit: null,
                brand: null,
            },
        };

        try {
            await db.query(
                `INSERT INTO companies (id, name, slug)
                 VALUES ($1, $2, $3)`,
                [COMPANY_ID, `Rely Settings ${TAG}`, `rely-settings-${TAG}`.toLowerCase()]
            );
            await db.query(
                `INSERT INTO leads (uuid, company_id, status, lead_lost, comments, metadata)
                 VALUES
                    ($1, $4, 'Submitted', false, $5, '{}'::jsonb),
                    ($2, $4, 'Submitted', false, $5, $6::jsonb),
                    ($3, $4, 'Submitted', false, $5, NULL)`,
                [leadUuids[0], leadUuids[1], leadUuids[2], COMPANY_ID, TAG, JSON.stringify(marker)]
            );

            expect(await leadsService.countNewLeads(COMPANY_ID)).toBe(2);

            await db.query(
                `UPDATE leads
                 SET metadata = $3::jsonb
                 WHERE company_id = $1
                   AND uuid = $2`,
                [COMPANY_ID, leadUuids[0], JSON.stringify({ rely_filter: { rejected: false } })]
            );
            expect(await leadsService.countNewLeads(COMPANY_ID)).toBe(2);
        } finally {
            await db.query(
                `DELETE FROM leads
                 WHERE company_id = $1
                   AND comments = $2`,
                [COMPANY_ID, TAG]
            );
            await db.query(
                `DELETE FROM companies
                 WHERE id = $1
                   AND slug = $2`,
                [COMPANY_ID, `rely-settings-${TAG}`.toLowerCase()]
            );
        }
    });
});
