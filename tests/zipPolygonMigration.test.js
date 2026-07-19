const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');

describe('migration 186 ZIP polygon place-ID cache', () => {
    const forward = fs.readFileSync(
        path.join(MIGRATIONS, '186_zip_polygon_place_ids.sql'),
        'utf8'
    );
    const rollback = fs.readFileSync(
        path.join(MIGRATIONS, 'rollback_186_zip_polygon_place_ids.sql'),
        'utf8'
    );

    it('is additive, replay-safe, and reversible on the public ZIP cache only', () => {
        expect(forward).toMatch(/ALTER TABLE zip_geocache/);
        expect(forward).toMatch(/ADD COLUMN IF NOT EXISTS google_place_id TEXT/);
        expect(forward).toMatch(/ADD COLUMN IF NOT EXISTS place_id_resolved_at TIMESTAMPTZ/);
        expect(forward).not.toMatch(/service_territories|company_id/i);
        expect(rollback).toMatch(/DROP COLUMN IF EXISTS place_id_resolved_at/);
        expect(rollback).toMatch(/DROP COLUMN IF EXISTS google_place_id/);
    });
});
