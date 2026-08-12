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

    test('legacy providerUserIds cannot override the inline OB-58 mirror derivation', async () => {
        await scheduleQueries.reassignJob('co-1', 42, [{ id: 'a', name: 'A' }], JSON.stringify(['user-1']));
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/assigned_provider_user_ids\s*=\s*COALESCE/);
        expect(sql).toMatch(/FROM jsonb_array_elements\(\$3::jsonb\)/);
        expect(sql).toMatch(/e\.company_id\s*=\s*j\.company_id/);
        expect(sql).toMatch(/t\.company_id\s*=\s*j\.company_id/);
        expect(sql).toMatch(/t\.active\s*=\s*TRUE/);
        expect(sql).toMatch(/m\.company_id\s*=\s*j\.company_id/);
        expect(params).toHaveLength(3);
    });

    test('omitted providerUserIds still refreshes the visibility mirror atomically', async () => {
        await scheduleQueries.reassignJob('co-1', 42, [{ id: 'a', name: 'A' }]);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/assigned_provider_user_ids\s*=\s*COALESCE/);
        expect(sql).toMatch(/WHERE j\.id = \$1 AND j\.company_id = \$2/);
        expect(params).toHaveLength(3);
    });
});
