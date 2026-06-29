// JOB-TECH-ASSIGN-001 — reassignJob must REPLACE the assignee (not append) and
// accept null to unassign. The append bug (|| $3) accumulated stale techs and
// stored nameless chips; only surfaced once an already-assigned job was reassigned.
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
const db = require('../backend/src/db/connection');
const scheduleQueries = require('../backend/src/db/scheduleQueries');

describe('reassignJob — single-assignee replace', () => {
    beforeEach(() => {
        db.query.mockReset();
        db.query.mockResolvedValue({ rows: [{ id: 42, assigned_techs: [] }] });
    });

    test('REPLACES assigned_techs (no append) and stores id + name', async () => {
        await scheduleQueries.reassignJob('co-1', 42, 'tech-9', 'Alex Kim');
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/assigned_techs\s*=\s*\$3::jsonb/); // SET, not concat
        expect(sql).not.toMatch(/\|\|/);                        // never append
        expect(params[0]).toBe(42);
        expect(params[1]).toBe('co-1');
        expect(JSON.parse(params[2])).toEqual([{ id: 'tech-9', name: 'Alex Kim' }]);
    });

    test('null assignee UNASSIGNS (stores [])', async () => {
        await scheduleQueries.reassignJob('co-1', 42, null);
        const [, params] = db.query.mock.calls[0];
        expect(JSON.parse(params[2])).toEqual([]);
    });

    test('missing name → empty string, still exactly one entry', async () => {
        await scheduleQueries.reassignJob('co-1', 42, 'tech-9');
        const [, params] = db.query.mock.calls[0];
        expect(JSON.parse(params[2])).toEqual([{ id: 'tech-9', name: '' }]);
    });
});
