/**
 * TECH-DAYOFF-001 (DO-06, section C) — TC-DO-29: psql-less shape assertions for
 * migration 167 (technician_time_off) + its rollback + number-167 uniqueness.
 * Pure fs + regex over the SQL files; no database required. The live CHECK
 * enforcement is covered at the API level by TC-DO-06 (timeOffRoutes.test.js).
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const UP_FILE = '167_technician_time_off.sql';
const ROLLBACK_FILE = 'rollback_167_technician_time_off.sql';

const up = fs.readFileSync(path.join(MIGRATIONS_DIR, UP_FILE), 'utf8');
const rollback = fs.readFileSync(path.join(MIGRATIONS_DIR, ROLLBACK_FILE), 'utf8');
const files = fs.readdirSync(MIGRATIONS_DIR);

describe('TC-DO-29: migration 167 up shape', () => {
    it('creates the table idempotently (IF NOT EXISTS)', () => {
        expect(up).toMatch(/CREATE TABLE IF NOT EXISTS technician_time_off/);
    });

    it('company_id: UUID NOT NULL, FK to companies with ON DELETE CASCADE', () => {
        expect(up).toMatch(/company_id\s+UUID NOT NULL REFERENCES companies\(id\) ON DELETE CASCADE/);
    });

    it('technician identity: TEXT NOT NULL ZB id (INV-7) + technician_name TEXT snapshot', () => {
        expect(up).toMatch(/technician_id\s+TEXT NOT NULL/);
        expect(up).toMatch(/technician_name\s+TEXT/);
    });

    it('period columns: TIMESTAMPTZ NOT NULL with CHECK (ends_at > starts_at)', () => {
        expect(up).toMatch(/starts_at\s+TIMESTAMPTZ NOT NULL/);
        expect(up).toMatch(/ends_at\s+TIMESTAMPTZ NOT NULL CHECK \(ends_at > starts_at\)/);
    });

    it("source default 'individual' with CHECK IN ('individual','company'); batch_id UUID; created_by FK to crm_users", () => {
        expect(up).toMatch(/source\s+TEXT NOT NULL DEFAULT 'individual' CHECK \(source IN \('individual','company'\)\)/);
        expect(up).toMatch(/batch_id\s+UUID/);
        expect(up).toMatch(/created_by\s+UUID REFERENCES crm_users\(id\)/);
    });

    it('lookup index: idempotent, on (company_id, technician_id, starts_at)', () => {
        expect(up).toMatch(
            /CREATE INDEX IF NOT EXISTS idx_tech_time_off_lookup\s+ON technician_time_off \(company_id, technician_id, starts_at\)/
        );
    });
});

describe('TC-DO-29: rollback 167 shape', () => {
    it('drops the day-off table idempotently', () => {
        expect(rollback).toMatch(/DROP TABLE IF EXISTS technician_time_off/);
    });

    it('drops NOTHING but technician_time_off (no foreign-table DROPs)', () => {
        const drops = rollback.match(/DROP\s+TABLE[^;]*;/gi) || [];
        expect(drops.length).toBeGreaterThan(0);
        for (const stmt of drops) {
            expect(stmt).toMatch(/technician_time_off/);
        }
        // No other destructive statements against foreign objects.
        const otherDrops = (rollback.match(/DROP\s+(?!TABLE)[A-Z]+/gi) || []);
        expect(otherDrops).toEqual([]);
    });
});

describe('TC-DO-29: number 167 is free and maximal (worktree-drift RECHECK, precedent 161)', () => {
    it('exactly one 167_ forward migration — ours', () => {
        expect(files.filter(f => /^167_/.test(f))).toEqual([UP_FILE]);
    });

    it('rollback file exists alongside the forward migration', () => {
        expect(files).toContain(ROLLBACK_FILE);
    });

    it('the previous migration 166 exists (no numbering gap)', () => {
        expect(files.some(f => /^166_/.test(f))).toBe(true);
    });

    it('168 is the maximal migration number on disk (167 dayoff + 168 SERVICE-TERR-002)', () => {
        const numbers = files
            .map(f => (f.match(/^(\d+)_/) || [])[1])
            .filter(Boolean)
            .map(Number);
        expect(Math.max(...numbers)).toBe(168);
    });
});
