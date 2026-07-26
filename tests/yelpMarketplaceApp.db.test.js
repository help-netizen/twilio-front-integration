'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const FORWARD = fs.readFileSync(
    path.join(MIGRATIONS, '203_seed_yelp_leads_marketplace_app.sql'),
    'utf8'
);
const ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_203_seed_yelp_leads_marketplace_app.sql'),
    'utf8'
);
const MARKETPLACE_QUERIES_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'src', 'db', 'marketplaceQueries.js'),
    'utf8'
);

jest.setTimeout(30000);

let client;

beforeAll(async () => {
    client = await db.pool.connect();
});

afterAll(async () => {
    if (client) client.release();
    await db.pool.end();
});

describe('YELP-LEADS-001 marketplace migration 203 · real PostgreSQL', () => {
    it('is registered in the boot replay after the base Marketplace seed', () => {
        const base = MARKETPLACE_QUERIES_SOURCE.indexOf(
            "readMigration('083_create_marketplace_apps.sql')"
        );
        const yelp = MARKETPLACE_QUERIES_SOURCE.indexOf(
            "readMigration('203_seed_yelp_leads_marketplace_app.sql')"
        );

        expect(base).toBeGreaterThanOrEqual(0);
        expect(yelp).toBeGreaterThan(base);
    });

    it('applies idempotently with exact catalog/assistant fields and creates no installation', async () => {
        await client.query('BEGIN');
        try {
            await client.query(ROLLBACK);
            await client.query(FORWARD);
            const first = await client.query(
                `SELECT *
                 FROM marketplace_apps
                 WHERE app_key = 'yelp-leads'`
            );
            expect(first.rows).toHaveLength(1);
            const row = first.rows[0];
            expect(row).toMatchObject({
                app_key: 'yelp-leads',
                name: 'Yelp Leads',
                provider_name: 'Albusto',
                category: 'lead_generation',
                app_type: 'internal',
                logo_url: null,
                requested_scopes: ['leads:create'],
                provisioning_mode: 'manual',
                status: 'published',
            });
            expect(row.metadata.access_summary).toEqual(['Create leads']);
            expect(Object.keys(row.metadata.assistant).sort()).toEqual([
                'gotchas',
                'outcome',
                'prerequisites',
                'recommend_when',
                'setup_steps',
                'what_it_does',
            ]);

            const appId = row.id;
            await client.query(FORWARD);
            await client.query(FORWARD);

            const after = await client.query(
                `SELECT id, COUNT(*) OVER ()::int AS count
                 FROM marketplace_apps
                 WHERE app_key = 'yelp-leads'`
            );
            expect(after.rows).toEqual([{ id: appId, count: 1 }]);
            const installations = await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM marketplace_installations
                 WHERE app_id = $1`,
                [appId]
            );
            expect(installations.rows[0].count).toBe(0);

            await client.query(ROLLBACK);
            await client.query(ROLLBACK);
            expect((await client.query(
                "SELECT id FROM marketplace_apps WHERE app_key = 'yelp-leads'"
            )).rows).toHaveLength(0);
        } finally {
            await client.query('ROLLBACK');
        }
    });
});
