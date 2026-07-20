'use strict';

const fs = require('fs');
const path = require('path');
const { createInspectorScheduler } = require('../backend/src/services/inspectorScheduler');
const {
    isAtOrAfterLocalTime,
    localDateInTZ,
    startOfLocalDay,
} = require('../backend/src/utils/companyTime');

const COMPANY = '11111111-1111-1111-1111-111111111111';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

describe('Inspector scheduler and company-local time', () => {
    test('SAB-INSP-TZ-NOON + SAB-INSP-DST: noon/local date/day boundary use company timezone', () => {
        expect(isAtOrAfterLocalTime(new Date('2026-07-20T15:59:59.000Z'), 12, 0, 'America/New_York')).toBe(false);
        expect(isAtOrAfterLocalTime(new Date('2026-07-20T16:00:00.000Z'), 12, 0, 'America/New_York')).toBe(true);
        expect(localDateInTZ(new Date('2026-07-20T03:30:00.000Z'), 'America/New_York')).toBe('2026-07-19');
        expect(startOfLocalDay(new Date('2026-03-08T17:00:00.000Z'), 'America/New_York').toISOString())
            .toBe('2026-03-08T05:00:00.000Z');
        expect(startOfLocalDay(new Date('2026-11-01T17:00:00.000Z'), 'America/New_York').toISOString())
            .toBe('2026-11-01T04:00:00.000Z');
    });

    test('SAB-INSP-LOCAL-DAY: eligibility boundary is midnight in the company timezone', () => {
        expect(startOfLocalDay(new Date('2026-07-20T20:00:00.000Z'), 'America/New_York').toISOString())
            .toBe('2026-07-20T04:00:00.000Z');
        expect(startOfLocalDay(new Date('2026-07-20T20:00:00.000Z'), 'America/Los_Angeles').toISOString())
            .toBe('2026-07-20T07:00:00.000Z');
    });

    test('SAB-INSP-INSTALL-GATE: due aggregate requires published app, connected install, enabled setting, active company', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../backend/src/db/inspectorQueries.js'),
            'utf8'
        );
        const start = source.indexOf('async function listDueCompanies');
        const end = source.indexOf('async function claimDailyRun');
        const sql = source.slice(start, end);
        expect(sql).toContain("app.app_key = $3");
        expect(sql).toContain("app.status = 'published'");
        expect(sql).toContain("c.status = 'active'");
        expect(sql).toContain("mi.status = 'connected'");
        expect(sql).toContain('COALESCE(settings.enabled, true) = true');
        expect(sql).toContain('settings.company_id = mi.company_id');

        const runtimeStart = source.indexOf('async function getRuntimeConfiguration');
        const runtimeEnd = source.indexOf('async function saveSettings');
        const runtimeSql = source.slice(runtimeStart, runtimeEnd);
        expect(runtimeSql).toContain("installation.status = 'connected'");
        expect(runtimeSql).toContain("company.status = 'active'");
        expect(runtimeSql).toContain('COALESCE(settings.enabled, true) = true');
        expect(runtimeSql).toContain('installation.company_id = $1');
        expect(runtimeSql).toContain('settings.company_id = $1');
    });

    test('SAB-INSP-ONCE-PER-DAY: active claim suppresses another tick and runner is detached', async () => {
        const run = deferred();
        const queries = {
            listDueCompanies: jest.fn()
                .mockResolvedValueOnce([{ company_id: COMPANY, company_local_date: '2026-07-20', timezone: 'America/New_York' }])
                .mockResolvedValue([]),
            claimDailyRun: jest.fn().mockResolvedValue({
                id: 7, company_id: COMPANY, company_local_date: '2026-07-20',
                timezone: 'America/New_York', started_at: '2026-07-20T16:00:00.000Z',
            }),
            finishRun: jest.fn(),
        };
        const runner = { runCompany: jest.fn().mockReturnValue(run.promise) };
        const scheduler = createInspectorScheduler({
            queries, runner, now: () => new Date('2026-07-20T16:00:00.000Z'),
        });
        await expect(scheduler.tick(new Date('2026-07-20T16:00:00.000Z')))
            .resolves.toMatchObject({ claimed: 1, active: 1 });
        await expect(scheduler.tick(new Date('2026-07-20T16:01:00.000Z')))
            .resolves.toMatchObject({ claimed: 0, active: 1 });
        expect(queries.listDueCompanies).toHaveBeenCalledTimes(1);
        run.resolve({ spend_cap: false });
        await scheduler.waitForIdle();
        expect(runner.runCompany).toHaveBeenCalledWith(expect.objectContaining({
            companyId: COMPANY, runId: 7, companyLocalDate: '2026-07-20',
        }));
    });

    test('REGRESSION 22007: a node-pg Date company_local_date reaches the runner as YYYY-MM-DD, not Date.toString()', async () => {
        // node-pg parses a PG `date` column into a JS Date at local midnight; the
        // prod scheduler did String(dateObject) → "Mon Jul 20 2026 …" which Postgres
        // rejected as ::DATE (SQLSTATE 22007) and failed every run. The claim now
        // must hand the runner a canonical calendar-day string.
        const run = deferred();
        const queries = {
            listDueCompanies: jest.fn()
                .mockResolvedValueOnce([{ company_id: COMPANY, company_local_date: new Date(2026, 6, 20), timezone: 'America/New_York' }])
                .mockResolvedValue([]),
            claimDailyRun: jest.fn().mockResolvedValue({
                id: 9, company_id: COMPANY,
                company_local_date: new Date(2026, 6, 20), // ← a Date, exactly as node-pg returns it
                timezone: 'America/New_York', started_at: '2026-07-20T16:00:00.000Z',
            }),
            finishRun: jest.fn(),
        };
        const runner = { runCompany: jest.fn().mockReturnValue(run.promise) };
        const scheduler = createInspectorScheduler({
            queries, runner, now: () => new Date('2026-07-20T16:00:00.000Z'),
        });
        await scheduler.tick(new Date('2026-07-20T16:00:00.000Z'));
        run.resolve({ spend_cap: false });
        await scheduler.waitForIdle();
        const passed = runner.runCompany.mock.calls[0][0].companyLocalDate;
        expect(typeof passed).toBe('string');
        expect(passed).toBe('2026-07-20');
        expect(passed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('atomic claim loser starts no company run', async () => {
        const queries = {
            listDueCompanies: jest.fn().mockResolvedValue([
                { company_id: COMPANY, company_local_date: '2026-07-20', timezone: 'America/New_York' },
            ]),
            claimDailyRun: jest.fn().mockResolvedValue(null),
            finishRun: jest.fn(),
        };
        const runner = { runCompany: jest.fn() };
        const scheduler = createInspectorScheduler({ queries, runner });
        await expect(scheduler.tick(new Date('2026-07-20T16:00:00.000Z')))
            .resolves.toMatchObject({ claimed: 0 });
        expect(runner.runCompany).not.toHaveBeenCalled();
    });

    test('spend-cap result opens a cooldown and prevents untouched company claims', async () => {
        const tickNow = new Date('2026-07-20T16:00:00.000Z');
        const queries = {
            listDueCompanies: jest.fn().mockResolvedValue([
                { company_id: COMPANY, company_local_date: '2026-07-20', timezone: 'America/New_York' },
            ]),
            claimDailyRun: jest.fn().mockResolvedValue({
                id: 7, company_id: COMPANY, company_local_date: '2026-07-20', timezone: 'America/New_York',
            }),
            finishRun: jest.fn(),
        };
        const runner = { runCompany: jest.fn().mockResolvedValue({ spend_cap: true, retry_after_ms: 60000 }) };
        const scheduler = createInspectorScheduler({ queries, runner, now: () => tickNow });
        await scheduler.tick(tickNow);
        await scheduler.waitForIdle();
        queries.listDueCompanies.mockClear();
        await expect(scheduler.tick(new Date('2026-07-20T16:00:30.000Z')))
            .resolves.toMatchObject({ claimed: 0, circuit_open: true });
        expect(queries.listDueCompanies).not.toHaveBeenCalled();
    });
});
