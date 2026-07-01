// JOB-TECH-ASSIGN-001 + JOB-PROVIDER-MULTI-001 — reassignJob REPLACES assigned_techs
// (never appends) with the given provider array; [] unassigns. Supports one OR many.
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
const db = require('../backend/src/db/connection');
const scheduleQueries = require('../backend/src/db/scheduleQueries');

describe('reassignJob — replace with a provider array', () => {
    beforeEach(() => {
        db.query.mockReset();
        db.query.mockResolvedValue({ rows: [{ id: 42, assigned_techs: [] }] });
    });

    test('REPLACES assigned_techs (no append) and stores id + name', async () => {
        await scheduleQueries.reassignJob('co-1', 42, [{ id: 'tech-9', name: 'Alex Kim' }]);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/assigned_techs\s*=\s*\$3::jsonb/); // SET, not concat
        expect(sql).not.toMatch(/\|\|/);                        // never append
        expect(params[0]).toBe(42);
        expect(params[1]).toBe('co-1');
        expect(JSON.parse(params[2])).toEqual([{ id: 'tech-9', name: 'Alex Kim' }]);
    });

    test('empty array UNASSIGNS (stores [])', async () => {
        await scheduleQueries.reassignJob('co-1', 42, []);
        const [, params] = db.query.mock.calls[0];
        expect(JSON.parse(params[2])).toEqual([]);
    });

    test('missing name → empty string, id coerced to string', async () => {
        await scheduleQueries.reassignJob('co-1', 42, [{ id: 'tech-9' }]);
        const [, params] = db.query.mock.calls[0];
        expect(JSON.parse(params[2])).toEqual([{ id: 'tech-9', name: '' }]);
    });

    test('MULTIPLE providers are all stored (JOB-PROVIDER-MULTI-001)', async () => {
        await scheduleQueries.reassignJob('co-1', 42, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
        const [, params] = db.query.mock.calls[0];
        expect(JSON.parse(params[2])).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
    });

    test('null / empty ids are filtered out', async () => {
        await scheduleQueries.reassignJob('co-1', 42, [{ id: 'a', name: 'A' }, { id: null }, { id: '' }, null]);
        const [, params] = db.query.mock.calls[0];
        expect(JSON.parse(params[2])).toEqual([{ id: 'a', name: 'A' }]);
    });

    test('duplicate provider ids are deduped (first wins)', async () => {
        await scheduleQueries.reassignJob('co-1', 42, [{ id: 'a', name: 'A' }, { id: 'a', name: 'A dup' }]);
        const [, params] = db.query.mock.calls[0];
        expect(JSON.parse(params[2])).toEqual([{ id: 'a', name: 'A' }]);
    });

    test('providerUserIds → also refreshes assigned_provider_user_ids in the SAME update', async () => {
        await scheduleQueries.reassignJob('co-1', 42, [{ id: 'a', name: 'A' }], JSON.stringify(['user-1']));
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/assigned_provider_user_ids\s*=\s*\$4::jsonb/);
        expect(params[3]).toBe(JSON.stringify(['user-1']));
    });

    test('no providerUserIds → the visibility mirror column is left untouched', async () => {
        await scheduleQueries.reassignJob('co-1', 42, [{ id: 'a', name: 'A' }]);
        const [sql] = db.query.mock.calls[0];
        expect(sql).not.toMatch(/assigned_provider_user_ids/);
    });
});
