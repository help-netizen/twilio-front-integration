'use strict';

const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/213_google_ads_connector.sql'),
    'utf8'
);
const rollback = fs.readFileSync(
    path.join(
        __dirname,
        '../backend/db/migrations/rollback_213_google_ads_connector.sql'
    ),
    'utf8'
);

describe('Google Ads migration 213 contract', () => {
    test('connection and performance identities are tenant-inclusive', () => {
        expect(migration).toContain('CREATE TABLE IF NOT EXISTS google_ads_connections');
        expect(migration).toContain('company_id              UUID NOT NULL UNIQUE');
        expect(migration).toContain('UNIQUE (company_id, id)');
        expect(migration).toContain(
            'FOREIGN KEY (company_id, channel_id)'
        );
        expect(migration).toContain(
            `UNIQUE (
            company_id,
            provider_key,
            external_account_id,
            external_campaign_id,
            performance_date
        )`
        );
        expect(migration).toContain(
            'ON google_ads_connections(status, last_sync_status, last_synced_at)'
        );
        expect(migration).toContain(
            'ON lead_source_performance_daily(company_id, performance_date, channel_id)'
        );
    });

    test('marketplace app is derived and carries the complete assistant block', () => {
        expect(migration).toContain("'google-ads'");
        expect(migration).toContain('"derived_connection": true');
        expect(migration).toContain("'none'");
        for (const key of [
            'what_it_does',
            'prerequisites',
            'setup_steps',
            'outcome',
            'recommend_when',
            'gotchas',
        ]) {
            expect(migration).toContain(`"${key}"`);
        }
        expect(migration).toContain('ON CONFLICT (app_key) DO UPDATE');
    });

    test('migration does not blanket-seed google_ads channels for companies', () => {
        expect(migration).not.toMatch(/INSERT\s+INTO\s+lead_source_channels/i);
        expect(migration).toContain(
            'googleAdsConnectionService creates it only when a company'
        );
    });

    test('rollback removes connector facts before runtime-created channels', () => {
        expect(rollback.indexOf('DROP TABLE IF EXISTS lead_source_performance_daily'))
            .toBeLessThan(rollback.indexOf('DROP TABLE IF EXISTS google_ads_connections'));
        expect(rollback.indexOf('DROP TABLE IF EXISTS google_ads_connections'))
            .toBeLessThan(rollback.indexOf('DELETE FROM lead_source_channels'));
    });
});
