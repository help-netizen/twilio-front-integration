/**
 * PRICEBOOK-002 — QUERY-layer transaction tests for
 * estimateItemPresetsQueries.bulkSaveItems.
 *
 * The db connection is mocked so getClient() yields a fake client
 * ({ query, release }). All SQL (BEGIN/COMMIT/ROLLBACK + insert/update/archive)
 * flows through fakeClient.query — the internal helpers call
 * client.query.bind(client) — so we drive behaviour by routing on the SQL text.
 * Tests assert BEGIN/COMMIT/ROLLBACK + release() bookkeeping, counts, the tagged
 * preset_not_found throw, and the exact fields handed to the UPDATE.
 */

const fakeClient = { query: jest.fn(), release: jest.fn() };

jest.mock('../backend/src/db/connection', () => ({
    getClient: jest.fn(),
    query: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/estimateItemPresetsQueries');

// Classify a SQL string so a test can decide what rows to return.
function kindOf(sql) {
    const s = String(sql).trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return s;
    if (s.startsWith('INSERT INTO estimate_item_presets')) return 'INSERT';
    // The archive UPDATE is the one gated on archived_at IS NULL.
    if (s.startsWith('UPDATE estimate_item_presets') && s.includes('archived_at = NOW()')) return 'ARCHIVE';
    if (s.startsWith('UPDATE estimate_item_presets')) return 'UPDATE';
    return 'OTHER';
}

beforeEach(() => {
    fakeClient.query.mockReset();
    fakeClient.release.mockReset();
    db.getClient.mockReset().mockResolvedValue(fakeClient);
});

describe('queries.bulkSaveItems (transaction layer)', () => {
    test('TC-PB2-006: update resolving null → ROLLBACK, release, no COMMIT, rejects preset_not_found', async () => {
        // INSERT succeeds; the UPDATE returns no rows (id vanished) → helper → null.
        fakeClient.query.mockImplementation(async (sql) => {
            switch (kindOf(sql)) {
                case 'INSERT': return { rows: [{ id: 101 }] };
                case 'UPDATE': return { rows: [] }; // update → null
                default: return { rows: [] };
            }
        });

        await expect(queries.bulkSaveItems('co1', {
            creates: [{ clientKey: 'k1', name: 'New' }],
            updates: [{ id: 42, name: 'Gone' }],
            deletes: [],
        }, { actorId: 'u1' })).rejects.toMatchObject({ code: 'preset_not_found', itemId: 42 });

        const kinds = fakeClient.query.mock.calls.map(c => kindOf(c[0]));
        expect(kinds).toContain('BEGIN');
        expect(kinds).toContain('ROLLBACK');
        expect(kinds).not.toContain('COMMIT');
        expect(fakeClient.release).toHaveBeenCalledTimes(1);
        // The INSERT ran inside the aborted tx (never committed → rolled back).
        expect(kinds).toContain('INSERT');
    });

    test('TC-PB2-007: already-archived delete (archive → null) not counted, COMMIT, no throw', async () => {
        let archiveCall = 0;
        fakeClient.query.mockImplementation(async (sql) => {
            if (kindOf(sql) === 'ARCHIVE') {
                archiveCall += 1;
                // First delete (55) already archived → no row; second (56) → row.
                return { rows: archiveCall === 1 ? [] : [{ id: 56 }] };
            }
            return { rows: [] };
        });

        const out = await queries.bulkSaveItems('co1', {
            creates: [],
            updates: [],
            deletes: [55, 56],
        }, { actorId: 'u1' });

        expect(archiveCall).toBe(2);
        expect(out.counts.deleted).toBe(1);
        const kinds = fakeClient.query.mock.calls.map(c => kindOf(c[0]));
        expect(kinds).toContain('BEGIN');
        expect(kinds).toContain('COMMIT');
        expect(kinds).not.toContain('ROLLBACK');
        expect(fakeClient.release).toHaveBeenCalledTimes(1);
    });

    test('TC-PB2-008: UPDATE SQL carries only editable columns (no default_quantity/usage_count/last_used_at/created_by)', async () => {
        let updateSql = null;
        let updateParams = null;
        fakeClient.query.mockImplementation(async (sql, params) => {
            if (kindOf(sql) === 'UPDATE') {
                updateSql = String(sql);
                updateParams = params;
                return { rows: [{ id: 42 }] };
            }
            return { rows: [] };
        });

        // The SERVICE hands the query layer a normalized update: id + whitelisted
        // editable columns only. The query layer splits id off and forwards the rest
        // to updatePresetScoped, which builds SET clauses from the editable set.
        await queries.bulkSaveItems('co1', {
            updates: [{
                id: 42,
                name: 'Part',
                description: 'desc',
                code: '2010',
                unit: 'ea',
                default_unit_price: 140,
                default_taxable: true,
                category_id: 7,
            }],
        }, { actorId: 'u1' });

        expect(updateSql).toBeTruthy();
        // Editable columns are present in the SET clause.
        for (const col of ['name', 'description', 'code', 'unit', 'default_unit_price', 'default_taxable', 'category_id']) {
            expect(updateSql).toMatch(new RegExp(`${col}\\s*=`));
        }
        // Server-managed columns must NOT appear in the SET clause.
        expect(updateSql).not.toMatch(/default_quantity\s*=/);
        expect(updateSql).not.toMatch(/usage_count\s*=/);
        expect(updateSql).not.toMatch(/last_used_at\s*=/);
        expect(updateSql).not.toMatch(/created_by\s*=/);
        // id is the WHERE bind, not a SET value.
        expect(updateParams).toContain(42);
    });
});
