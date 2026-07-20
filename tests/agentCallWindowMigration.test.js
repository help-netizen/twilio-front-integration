'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('AGENT-CALL-WINDOW-001 durable migration controls', () => {
    test('migration 189 keeps short weekdays, deletes only full names, and constrains future writes', () => {
        const sql = read('backend/db/migrations/189_agent_call_windows.sql');
        const rollback = read('backend/db/migrations/rollback_189_agent_call_windows.sql');

        expect(sql).toContain("WHERE day_of_week IN (\n    'Monday'");
        expect(sql).toContain("CHECK (day_of_week IN ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'))");
        const deleteBlock = sql.slice(
            sql.indexOf('DELETE FROM user_group_hours'),
            sql.indexOf('ALTER TABLE user_group_hours', sql.indexOf('DELETE FROM user_group_hours'))
        );
        expect(deleteBlock).not.toContain("'Mon'");
        expect(sql).toContain('calling_window_work_days');
        expect(sql).toContain('calling_window_mode = NULL');
        expect(rollback).toContain('DROP CONSTRAINT IF EXISTS chk_user_group_hours_canonical_weekday');
    });

    test('parts caller seed has both description layers and is replayed after the lead caller seed', () => {
        const seed = read('backend/db/migrations/190_seed_outbound_parts_caller_marketplace_app.sql');
        const boot = read('backend/src/db/marketplaceQueries.js');

        expect(seed).toContain("'outbound-parts-caller'");
        expect(seed).toContain("'ai'");
        expect(seed).toContain('short_description');
        expect(seed).toContain('long_description');
        for (const field of [
            'what_it_does', 'prerequisites', 'setup_steps', 'outcome', 'recommend_when', 'gotchas',
        ]) expect(seed).toContain(`"${field}"`);
        expect(seed).toContain('"setup_path": "/settings/integrations/outbound-parts-caller"');
        expect(boot.indexOf("176_seed_outbound_lead_caller_marketplace_app.sql"))
            .toBeLessThan(boot.indexOf("190_seed_outbound_parts_caller_marketplace_app.sql"));
    });
});
