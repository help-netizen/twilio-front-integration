/**
 * OUTBOUND-LEAD-CALL-001 (OLC-T1) — TC-OLC-055/056: psql-less shape assertions
 * for migration 173 (dialer extension + settings) and 174 (marketplace seed)
 * + rollback order + boot-registration. Pure fs + regex over the SQL files
 * (precedent: tests/timeOffMigration.test.js). Live-PG constraint behavior is
 * TC-OLC-057 (manual stand). Spec drafted these as 172/173; renumbered 173/174
 * (172 taken by feedback_submissions) — the global ≥100 uniqueness tripwire in
 * tests/timeOffMigration.test.js guards collisions; no maximality assert here.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const DDL_FILE = '173_outbound_lead_call.sql';
const DDL_ROLLBACK = 'rollback_173_outbound_lead_call.sql';
const SEED_FILE = '174_seed_outbound_lead_caller_marketplace_app.sql';
const SEED_ROLLBACK = 'rollback_174_seed_outbound_lead_caller_marketplace_app.sql';

const ddl = fs.readFileSync(path.join(MIGRATIONS_DIR, DDL_FILE), 'utf8');
const ddlRollback = fs.readFileSync(path.join(MIGRATIONS_DIR, DDL_ROLLBACK), 'utf8');
const seed = fs.readFileSync(path.join(MIGRATIONS_DIR, SEED_FILE), 'utf8');
const seedRollback = fs.readFileSync(path.join(MIGRATIONS_DIR, SEED_ROLLBACK), 'utf8');
const files = fs.readdirSync(MIGRATIONS_DIR);
const bootRegistry = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'src', 'db', 'marketplaceQueries.js'), 'utf8');

describe('TC-OLC-055: migration 173 dialer-extension shape', () => {
    it('relaxes job_id and adds the scenario discriminator with parts default', () => {
        expect(ddl).toMatch(/ALTER TABLE outbound_call_attempts ALTER COLUMN job_id DROP NOT NULL/);
        expect(ddl).toMatch(/ADD COLUMN IF NOT EXISTS scenario\s+TEXT NOT NULL DEFAULT 'parts_visit'/);
    });

    it('adds lead_uuid VARCHAR(20) FK to leads(uuid) ON DELETE CASCADE', () => {
        expect(ddl).toMatch(/ADD COLUMN IF NOT EXISTS lead_uuid VARCHAR\(20\) REFERENCES leads\(uuid\) ON DELETE CASCADE/);
    });

    it('scope CHECK has BOTH arms (lead needs lead, everything else needs job)', () => {
        expect(ddl).toMatch(/chk_outbound_call_attempts_scope/);
        expect(ddl).toMatch(/scenario = 'lead_call' AND lead_uuid IS NOT NULL/);
        expect(ddl).toMatch(/scenario <> 'lead_call' AND job_id IS NOT NULL/);
    });

    it('one-active-chain-per-lead partial unique + lead lookup index', () => {
        expect(ddl).toMatch(
            /CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_call_attempts_active_lead\s+ON outbound_call_attempts \(lead_uuid\)\s+WHERE status IN \('pending', 'dialing'\) AND lead_uuid IS NOT NULL/
        );
        expect(ddl).toMatch(/CREATE INDEX IF NOT EXISTS idx_outbound_call_attempts_lead/);
    });

    it('outbound_lead_call_settings table with FR-2/FR-5 defaults + updated_at trigger', () => {
        expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS outbound_lead_call_settings/);
        expect(ddl).toMatch(/enabled_sources\s+JSONB\s+NOT NULL DEFAULT '\["ProReferral"\]'::jsonb/);
        expect(ddl).toMatch(/max_attempts\s+INTEGER\s+NOT NULL DEFAULT 3/);
        expect(ddl).toMatch(/backoff_schedule JSONB\s+NOT NULL DEFAULT '\["immediate","\+30m","\+2h"\]'::jsonb/);
        expect(ddl).toMatch(/CREATE TRIGGER trg_outbound_lead_call_settings_updated_at/);
    });

    it('does not touch the parts guard or the parts settings table', () => {
        // The parts objects may appear in -- comments and COMMENT ON strings
        // (documentation) — strip both before the negative greps.
        const sqlOnly = ddl.split('\n')
            .filter(l => !l.trim().startsWith('--') && !l.trim().startsWith('COMMENT ON'))
            .join('\n');
        expect(sqlOnly).not.toMatch(/uq_outbound_call_attempts_active_job/);
        expect(sqlOnly).not.toMatch(/\boutbound_call_settings\b/);
    });

    it('rollback deletes lead rows BEFORE re-tightening job_id, drops only feature objects', () => {
        const deleteIdx = ddlRollback.indexOf("DELETE FROM outbound_call_attempts WHERE scenario = 'lead_call'");
        const setNotNullIdx = ddlRollback.indexOf('ALTER COLUMN job_id SET NOT NULL');
        expect(deleteIdx).toBeGreaterThanOrEqual(0);
        expect(setNotNullIdx).toBeGreaterThan(deleteIdx);
        expect(ddlRollback).toMatch(/DROP TABLE IF EXISTS outbound_lead_call_settings/);
        const drops = ddlRollback.match(/DROP\s+TABLE[^;]*;/gi) || [];
        for (const stmt of drops) expect(stmt).toMatch(/outbound_lead_call_settings/);
    });

    it('numbering: exactly one 173_ forward migration — ours; rollback exists; 172 exists (no gap)', () => {
        expect(files.filter(f => /^173_/.test(f))).toEqual([DDL_FILE]);
        expect(files).toContain(DDL_ROLLBACK);
        expect(files.some(f => /^172_/.test(f))).toBe(true);
    });
});

describe('TC-OLC-056: migration 174 marketplace seed', () => {
    it('seeds the outbound-lead-caller tile with the gate-only shape', () => {
        expect(seed).toMatch(/'outbound-lead-caller'/);
        expect(seed).toMatch(/'Albusto'/);
        expect(seed).toMatch(/'lead_generation'/);
        expect(seed).toMatch(/'internal'/);
        expect(seed).toMatch(/'none'/);
        expect(seed).toMatch(/'published'/);
        expect(seed).toMatch(/"setup_path": "\/settings\/integrations\/outbound-lead-caller"/);
        expect(seed).toMatch(/"requires_credential_input": false/);
    });

    it('ON CONFLICT DO UPDATE covers every seeded column + updated_at (boot-reseed idempotent)', () => {
        for (const col of ['name', 'provider_name', 'category', 'app_type', 'short_description',
            'long_description', 'requested_scopes', 'provisioning_mode', 'status',
            'support_email', 'metadata']) {
            expect(seed).toMatch(new RegExp(`${col} = EXCLUDED\\.${col}`));
        }
        expect(seed).toMatch(/updated_at = NOW\(\)/);
    });

    it('does NOT auto-install (no marketplace_installations INSERT — connect is an owner action)', () => {
        expect(seed).not.toMatch(/marketplace_installations/i);
    });

    it('copy never says "Blanc" (N-7 product-name rule)', () => {
        expect(seed).not.toMatch(/Blanc/);
    });

    it('boot-registered in ensureMarketplaceSchema AFTER the 170 line; the DDL 173 is NOT boot-replayed', () => {
        const line170 = bootRegistry.indexOf("readMigration('170_split_lead_generator_marketplace_apps.sql')");
        const line174 = bootRegistry.indexOf("readMigration('174_seed_outbound_lead_caller_marketplace_app.sql')");
        expect(line170).toBeGreaterThanOrEqual(0);
        expect(line174).toBeGreaterThan(line170);
        expect(bootRegistry).not.toMatch(/readMigration\('173_outbound_lead_call\.sql'\)/);
    });

    it('seed rollback deletes only the tile', () => {
        expect(seedRollback).toMatch(/DELETE FROM marketplace_apps WHERE app_key = 'outbound-lead-caller'/);
        expect(seedRollback).not.toMatch(/DROP TABLE/i);
    });

    it('numbering: exactly one 174_ forward migration — ours; rollback exists', () => {
        expect(files.filter(f => /^174_/.test(f))).toEqual([SEED_FILE]);
        expect(files).toContain(SEED_ROLLBACK);
    });
});
