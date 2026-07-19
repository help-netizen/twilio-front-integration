'use strict';

/**
 * DISPATCH-SETTINGS-NULL-FIX — regression for the Schedule ⚙️ Dispatch Settings
 * save crash:
 *   null value in column "buffer_minutes" of relation "dispatch_settings"
 *   violates not-null constraint
 *
 * Root cause: upsertDispatchSettings' UPDATE branch COALESCEs every field (a
 * partial payload is legal by design), but the INSERT branch passed raw NULLs —
 * and an EXPLICIT NULL bypasses a column DEFAULT. Any company saving the panel
 * for the FIRST time (no dispatch_settings row yet — code-level defaults served
 * until then) with a partial payload hit the NOT NULL constraint.
 *
 * Fix under test: the INSERT branch mirrors the schema defaults via COALESCE.
 *
 * Structural control always runs; the PostgreSQL leg self-skips when the local
 * test database is unavailable and cleans up every row it created.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const scheduleQueries = require('../backend/src/db/scheduleQueries');

jest.setTimeout(30000);

const QUERIES_FILE = path.join(__dirname, '..', 'backend', 'src', 'db', 'scheduleQueries.js');
const TAG = `DISP-${Date.now()}-${process.pid}`;

describe('dispatch_settings upsert — INSERT branch must mirror schema defaults', () => {
    test('structural: INSERT VALUES coalesce buffer_minutes/slot_duration/work fields', () => {
        const src = fs.readFileSync(QUERIES_FILE, 'utf8');
        const insertBlock = src.slice(
            src.indexOf('INSERT INTO dispatch_settings'),
            src.indexOf('ON CONFLICT (company_id)')
        );
        // The regression: raw "$7," (buffer_minutes) in VALUES. Every nullable
        // parameter must be defaulted inside VALUES, not passed through bare.
        expect(insertBlock).toContain("COALESCE($7, 0)");
        expect(insertBlock).toContain("COALESCE($6, 60)");
        expect(insertBlock).toContain("COALESCE($2, 'America/New_York')");
        expect(insertBlock).toContain("COALESCE($5, '{1,2,3,4,5}'::smallint[])");
        expect(insertBlock).not.toMatch(/VALUES[^)]*\$7\s*,/);
    });

    describe('postgres leg', () => {
        let available = false;
        const companyId = randomUUID();

        beforeAll(async () => {
            try {
                await db.query('SELECT 1');
                available = true;
                await db.query(
                    `INSERT INTO companies (id, name, slug) VALUES ($1, $2, $3)`,
                    [companyId, `Dispatch ${TAG}`, `dispatch-${TAG.toLowerCase()}`]
                );
            } catch {
                available = false;
            }
        });

        afterAll(async () => {
            if (!available) return;
            try {
                await db.query(`DELETE FROM dispatch_settings WHERE company_id = $1`, [companyId]);
                await db.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
            } finally {
                await db.pool?.end?.();
            }
        });

        test('first-save partial payload (hours only) creates the row with defaults', async () => {
            if (!available) return console.warn('[dispatchSettingsUpsert] PG unavailable — skipped');

            // Exactly what the Dispatch Settings panel sends: hours + days, nothing else.
            const row = await scheduleQueries.upsertDispatchSettings(companyId, {
                work_start_time: '09:00',
                work_end_time: '17:00',
                work_days: [1, 2, 3, 4, 5, 6],
            });

            expect(row).toBeTruthy();
            expect(row.buffer_minutes).toBe(0);            // was the NOT NULL crash
            expect(row.slot_duration).toBe(60);
            expect(row.timezone).toBe('America/New_York');
            expect(String(row.work_start_time)).toMatch(/^09:00/);
            expect(String(row.work_end_time)).toMatch(/^17:00/);
            expect(row.work_days).toEqual([1, 2, 3, 4, 5, 6]);
        });

        test('second save (UPDATE branch) still merges partial payloads', async () => {
            if (!available) return console.warn('[dispatchSettingsUpsert] PG unavailable — skipped');

            const row = await scheduleQueries.upsertDispatchSettings(companyId, {
                buffer_minutes: 15,
            });
            expect(row.buffer_minutes).toBe(15);
            // Hours from the first save survive an unrelated partial update.
            expect(String(row.work_start_time)).toMatch(/^09:00/);
            expect(row.work_days).toEqual([1, 2, 3, 4, 5, 6]);
        });
    });
});
