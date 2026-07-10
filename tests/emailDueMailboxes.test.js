'use strict';

/**
 * GMAIL-PUSH-FIX-001 — FIX#2 due-matrix (TC-GPF-001).
 *
 * Unit-tests the PURE predicate `emailQueries.isMailboxDue(row, {intervalMinutes, now})`
 * — the row-level mirror of the `listDueMailboxes` SQL WHERE clause — at a FROZEN
 * `now`, so the due/not-due truth table is genuinely runnable jest (no live Postgres;
 * the SQL boolean logic is exercised separately by the live-pg case TC-GPF-003).
 *
 * The predicate is three clauses:
 *   • cadence  — due iff never finished OR finished > `intervalMinutes` ago
 *   • overlap  — blocked ONLY while genuinely in-flight = started with NO newer finish
 *                (finished IS NULL or finished < started) AND started < 10min ago
 *   • the 10-min escape releases a crashed/hung sync so a mailbox never freezes.
 *
 * `isMailboxDue` is pure (no db), but requiring emailQueries pulls in ./connection;
 * mock the pool so no real Postgres pool is created.
 *
 * Run:
 *   node node_modules/jest/bin/jest.js tests/emailDueMailboxes.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const { isMailboxDue } = require('../backend/src/db/emailQueries');

// Frozen clock — every row's timestamps are relative to this instant.
const NOW = new Date('2026-07-10T12:00:00Z');
const ago = (min) => new Date(NOW.getTime() - min * 60000);

// interval = 5 min (the production default; runSchedulerTick passes floor(SYNC_MS/60000)).
const due = (row) => isMailboxDue(row, { intervalMinutes: 5, now: NOW });

describe('isMailboxDue — due-matrix at a frozen now (TC-GPF-001, interval=5m)', () => {
    it('never-synced (started null, finished null) → DUE', () => {
        expect(due({ last_sync_started_at: null, last_sync_finished_at: null })).toBe(true);
    });

    it('idle-elapsed (finished 8m ago, started 8m ago) → DUE', () => {
        // finished 8m ago > 5m interval → cadence due; finished ≥ started → not in-flight.
        expect(due({ last_sync_started_at: ago(8), last_sync_finished_at: ago(8) })).toBe(true);
    });

    it('idle-fresh (finished 3m ago) → NOT DUE', () => {
        // finished only 3m ago < 5m interval → cadence blocks (regardless of overlap).
        expect(due({ last_sync_started_at: ago(4), last_sync_finished_at: ago(3) })).toBe(false);
    });

    it('in-flight recent (started 1m ago, finished null) → NOT DUE', () => {
        // started, no finish yet, < 10m → genuinely in-flight → overlap blocks.
        expect(due({ last_sync_started_at: ago(1), last_sync_finished_at: null })).toBe(false);
    });

    it('in-flight with stale prior finish (finished < started, both recent) → NOT DUE', () => {
        // finished(30m ago) < started(1m ago) → no NEWER finish → still in-flight → block.
        // (A naive `finished IS NULL` in-flight test would WRONGLY mark this due.)
        expect(due({ last_sync_started_at: ago(1), last_sync_finished_at: ago(30) })).toBe(false);
    });

    it('stuck (started 20m ago, no newer finish) → DUE (10-min escape)', () => {
        // finished(40m) < started(20m) → in-flight, BUT started > 10m ago → escape hatch releases it.
        expect(due({ last_sync_started_at: ago(20), last_sync_finished_at: ago(40) })).toBe(true);
    });

    it('crashed-first-run (started 15m ago, finished null) → DUE (10-min escape)', () => {
        // never finished, but started > 10m ago → escape hatch (a crashed initial sync can't freeze the box).
        expect(due({ last_sync_started_at: ago(15), last_sync_finished_at: null })).toBe(true);
    });

    // ── LOAD-BEARING NEGATIVE CONTROL — this is the case the fix exists for ──────────
    // The OLD guard blocked ANY mailbox whose last_sync_started_at was within 10 min,
    // which wrongly froze a HEALTHY idle mailbox that had legitimately finished a sync
    // > 1 interval ago (started 8m, finished 7m). The finish-vs-start compare fixes it.
    // The sabotage step (b) re-introduces that old guard and this case goes RED.
    it('idle-fresh-start (finished 7m ago > interval, started 8m ago) → DUE', () => {
        expect(due({ last_sync_started_at: ago(8), last_sync_finished_at: ago(7) })).toBe(true);
    });
});
