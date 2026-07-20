'use strict';

/**
 * AGENT-CALL-WINDOW-001 — real-PostgreSQL cleanup proof. The transaction is
 * rolled back, including all schema changes and fixture rows.
 */
const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');
const { isBusinessHoursForRows } = require('../backend/src/services/groupRouting');

jest.setTimeout(30000);

const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '189_agent_call_windows.sql'),
    'utf8'
);
const LEAD_WINDOW_PREREQUISITE = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '178_outbound_lead_call_window.sql'),
    'utf8'
);
const ROLLBACK = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_189_agent_call_windows.sql'),
    'utf8'
);
const GROUP_ID = `cw-${Date.now()}-${process.pid}`;

describe('migration 189 — canonical short weekdays', () => {
    test('SAB-CW-MIGRATION-NO-FLIP: short rows win before, survive unchanged, full rows are removed', async () => {
        let available = true;
        try {
            await db.query('SELECT 1 FROM user_group_hours LIMIT 1');
            await db.query('SELECT 1 FROM outbound_lead_call_settings LIMIT 1');
            await db.query('SELECT 1 FROM outbound_call_settings LIMIT 1');
        } catch (error) {
            available = false;
            console.warn(`SAB-CW-MIGRATION-NO-FLIP SKIPPED-NEEDS-DB — ${error.message}`);
        }
        if (!available) return;

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`ALTER TABLE user_group_hours DROP CONSTRAINT IF EXISTS chk_user_group_hours_canonical_weekday`);
            await client.query(
                `INSERT INTO user_groups (id, company_id, name) VALUES ($1, $2, 'Call-window migration fixture')`,
                [GROUP_ID, '00000000-0000-0000-0000-000000000001']
            );
            await client.query(
                `INSERT INTO user_group_hours
                    (group_id, day_of_week, is_open, open_time, close_time)
                 VALUES
                    ($1, 'Sat', true, '07:00', '17:00'),
                    ($1, 'Saturday', false, NULL, NULL),
                    ($1, 'Thu', true, '07:00', '21:00'),
                    ($1, 'Thursday', true, '09:00', '17:00')`,
                [GROUP_ID]
            );

            const before = await client.query(
                `SELECT day_of_week, is_open, open_time, close_time
                 FROM user_group_hours
                 WHERE group_id = $1
                 ORDER BY CASE WHEN day_of_week = ANY($2::text[]) THEN 0 ELSE 1 END, id`,
                [GROUP_ID, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']]
            );
            expect(isBusinessHoursForRows(
                before.rows,
                { timezone: 'America/New_York' },
                new Date('2026-07-18T14:00:00.000Z')
            )).toBe(true);

            // Some developer databases intentionally lag non-boot DDL. Migration
            // 189 follows 178 in production; apply that prerequisite inside this
            // rollback-only transaction when exercising the real SQL.
            await client.query(LEAD_WINDOW_PREREQUISITE);
            await client.query(MIGRATION);
            await client.query(MIGRATION);

            const after = await client.query(
                `SELECT day_of_week, is_open, open_time, close_time
                 FROM user_group_hours WHERE group_id = $1 ORDER BY day_of_week`,
                [GROUP_ID]
            );
            expect(after.rows).toEqual([
                { day_of_week: 'Sat', is_open: true, open_time: '07:00', close_time: '17:00' },
                { day_of_week: 'Thu', is_open: true, open_time: '07:00', close_time: '21:00' },
            ]);
            expect(isBusinessHoursForRows(
                after.rows,
                { timezone: 'America/New_York' },
                new Date('2026-07-18T14:00:00.000Z')
            )).toBe(true);

            await client.query('SAVEPOINT reject_full_weekday');
            await expect(client.query(
                `INSERT INTO user_group_hours
                    (group_id, day_of_week, is_open, open_time, close_time)
                 VALUES ($1, 'Monday', true, '09:00', '17:00')`,
                [GROUP_ID]
            )).rejects.toMatchObject({ code: '23514' });
            await client.query('ROLLBACK TO SAVEPOINT reject_full_weekday');

            await client.query(ROLLBACK);
            await client.query(ROLLBACK);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});
