'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const {
    parseArgs,
    collectDropped,
    collectExpected,
} = require('../backend/src/cli/verifyMigrationsApplied');

/**
 * The check exists because `schema_migrations` cannot answer "is it applied?" in
 * this project — it is legacy, stops at 18, and 083+ are re-runnable and
 * untracked. Asking the schema what it actually contains is the only truth, and
 * the parser below is what turns a migration file into that question.
 */
describe('verify migrations by their objects', () => {
    it('collects tables, columns and indexes a migration creates', () => {
        const files = [{
            migration: '261',
            source: `
                CREATE TABLE IF NOT EXISTS email_events (id BIGSERIAL PRIMARY KEY);
                ALTER TABLE email_messages
                  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
                CREATE INDEX IF NOT EXISTS idx_email_messages_occurred_at ON email_messages (occurred_at);
                CREATE UNIQUE INDEX uq_email_events_key ON email_events (id);
            `,
        }];
        const expected = collectExpected(files, new Set());
        expect(expected).toEqual([
            { migration: '261', kind: 'table', name: 'email_events' },
            { migration: '261', kind: 'column', name: 'email_messages.occurred_at' },
            // An index carries what it indexes, so a run can tell "the migration
            // never happened" apart from "the column it indexed was dropped".
            { migration: '261', kind: 'index', name: 'idx_email_messages_occurred_at', on: { table: 'email_messages', column: 'occurred_at' } },
            { migration: '261', kind: 'index', name: 'uq_email_events_key', on: { table: 'email_events', column: 'id' } },
        ]);
    });

    it('does not call an object missing when a later migration drops it', () => {
        // Six indexes from mig241 are absent in production and SHOULD be: mig257
        // removes them. Counting those as failures would cry wolf on every run
        // and teach everyone to ignore the check.
        const sources = [
            'CREATE UNIQUE INDEX uq_technician_profiles_native ON technician_profiles (company_id, tech_id);',
            'DROP INDEX IF EXISTS uq_technician_profiles_native;',
        ];
        const dropped = collectDropped(sources);
        expect(dropped.has('uq_technician_profiles_native')).toBe(true);

        const expected = collectExpected(
            [{ migration: '241', source: sources[0] }],
            dropped
        );
        expect(expected).toEqual([]);
    });

    it('remembers which column an index lives on', () => {
        // uq_provider_bridge_per_company is absent in production because
        // ZB-DECOUPLE dropped the column it indexed. Without this, the check
        // reports a phantom missing migration every single run.
        const files = [{
            migration: '100',
            source: `CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_bridge_per_company
                     ON company_user_profiles (zenbooker_team_member_id)
                     WHERE zenbooker_team_member_id IS NOT NULL;`,
        }];
        expect(collectExpected(files, new Set())[0].on).toEqual({
            table: 'company_user_profiles',
            column: 'zenbooker_team_member_id',
        });
    });

    it('catches a dropped column too, not just tables and indexes', () => {
        const dropped = collectDropped(['ALTER TABLE user_profiles DROP COLUMN IF EXISTS call_masking_enabled;']);
        expect(dropped.has('call_masking_enabled')).toBe(true);
    });

    it('never reports the same object twice', () => {
        // Re-runnable migrations re-declare the same index; one object, one check.
        const files = [
            { migration: '100', source: 'CREATE INDEX IF NOT EXISTS idx_x ON t (a);' },
            { migration: '140', source: 'CREATE INDEX IF NOT EXISTS idx_x ON t (a);' },
        ];
        expect(collectExpected(files, new Set())).toHaveLength(1);
    });

    it('can be scoped to recent migrations and rejects junk flags', () => {
        expect(parseArgs(['--from=200']).from).toBe(200);
        expect(parseArgs([]).from).toBe(0);
        expect(() => parseArgs(['--all'])).toThrow(/Unknown argument/);
    });
});
