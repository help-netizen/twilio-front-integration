'use strict';

// Regression for the timezone bind-count bug: getScheduleItems pushed the timezone
// parameter whenever a timezone was supplied, but only referenced it ($tzIdx) under
// a startDate/endDate boundary. An unbounded call WITH a timezone therefore bound one
// more parameter than the SQL text used, which Postgres rejects at execute time
// ("bind message supplies N parameters, but requires M"). We assert that every $N in
// the emitted SQL is covered by the params array — for both bounded and unbounded
// calls — by capturing what the module passes to db.query.

const captured = [];
jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(async (sql, params) => {
        // Snapshot params: the module reuses one array and pushes limit/offset AFTER
        // the count query runs, so a live reference would misread the count binding.
        captured.push({ sql, params: [...params] });
        // Count-query returns a total; data-query returns rows. Both are read here.
        return { rows: [{ total: '0' }] };
    }),
}));

const scheduleQueries = require('../backend/src/db/scheduleQueries');

/** Highest $N referenced in the SQL text. */
function maxPlaceholder(sql) {
    const nums = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
    return nums.length ? Math.max(...nums) : 0;
}

function assertBindConsistent(entry) {
    // Every placeholder must have a value; no value may be left unreferenced.
    expect(maxPlaceholder(entry.sql)).toBe(entry.params.length);
}

/** The unified count/data queries share the built `params`; other reads (provider
 *  roster etc.) have their own params and are out of scope for this check. */
function unifiedEntries() {
    return captured.filter(e => /entity_type/.test(e.sql));
}

describe('getScheduleItems parameter binding', () => {
    beforeEach(() => { captured.length = 0; });

    test('unbounded call WITH a timezone does not bind an unreferenced parameter', async () => {
        await scheduleQueries.getScheduleItems({
            companyId: 'company-1',
            timezone: 'America/New_York',
            // no startDate / endDate — the bug case
        });
        expect(unifiedEntries().length).toBeGreaterThan(0);
        unifiedEntries().forEach(assertBindConsistent);
    });

    test('date-bounded call WITH a timezone still binds every placeholder', async () => {
        await scheduleQueries.getScheduleItems({
            companyId: 'company-1',
            timezone: 'America/New_York',
            startDate: '2026-07-20',
            endDate: '2026-07-21',
        });
        unifiedEntries().forEach(assertBindConsistent);
        // and the timezone must actually be referenced when dates are present
        expect(unifiedEntries().some(e => /AT TIME ZONE \$\d+/.test(e.sql))).toBe(true);
    });

    test('date-bounded call WITHOUT a timezone binds every placeholder', async () => {
        await scheduleQueries.getScheduleItems({
            companyId: 'company-1',
            startDate: '2026-07-20',
            endDate: '2026-07-21',
        });
        unifiedEntries().forEach(assertBindConsistent);
    });
});
