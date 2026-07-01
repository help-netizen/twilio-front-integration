/**
 * PRICEBOOK-002 — estimateItemPresetsService.bulkSaveItems unit tests.
 * The DB layer (queries + priceBookQueries.getCategory) is mocked; tests exercise
 * the service's normalize → validate → transact → re-read pipeline.
 */

jest.mock('../backend/src/db/estimateItemPresetsQueries', () => ({
    bulkSaveItems: jest.fn(),
    listForManage: jest.fn(),
    findActiveIdsScoped: jest.fn(),
}));
jest.mock('../backend/src/db/priceBookQueries', () => ({
    getCategory: jest.fn(),
}));

const queries = require('../backend/src/db/estimateItemPresetsQueries');
const pbQueries = require('../backend/src/db/priceBookQueries');
const svc = require('../backend/src/services/estimateItemPresetsService');

beforeEach(() => {
    queries.bulkSaveItems.mockReset();
    queries.listForManage.mockReset();
    queries.findActiveIdsScoped.mockReset();
    pbQueries.getCategory.mockReset();
    // Default happy-path stubs.
    queries.bulkSaveItems.mockResolvedValue({ createdMap: [], counts: { created: 0, updated: 0, deleted: 0 } });
    queries.listForManage.mockResolvedValue([]);
    // By default, every update id pre-check resolves as active (echo the ids back).
    queries.findActiveIdsScoped.mockImplementation(async (_companyId, ids) => (ids || []).map(Number));
    pbQueries.getCategory.mockResolvedValue({ id: 7, name: 'Cat' });
});

describe('bulkSaveItems', () => {
    test('partitions creates/updates/deletes, returns summary + createdMap + items snapshot', async () => {
        queries.bulkSaveItems.mockResolvedValue({
            createdMap: [{ clientKey: 'tmp-1', id: 128 }],
            counts: { created: 1, updated: 1, deleted: 2 },
        });
        queries.listForManage.mockResolvedValue([
            { id: 128, name: 'Labor', default_unit_price: 95, default_taxable: false },
        ]);

        const out = await svc.bulkSaveItems('co1', {
            creates: [{ clientKey: 'tmp-1', name: 'Labor', description: 'On-site', code: '1010', unit: 'hr', default_unit_price: 95, default_taxable: false, category_id: 7 }],
            updates: [{ id: 42, name: 'Part', description: null, code: '2010', unit: 'ea', default_unit_price: 140, default_taxable: true, category_id: 7 }],
            deletes: [55, 56],
        }, { actorId: 'u1' });

        expect(queries.bulkSaveItems).toHaveBeenCalledTimes(1);
        const [companyIdArg, batchArg, optsArg] = queries.bulkSaveItems.mock.calls[0];
        expect(companyIdArg).toBe('co1');
        expect(batchArg.creates).toHaveLength(1);
        expect(batchArg.updates).toHaveLength(1);
        expect(batchArg.deletes).toEqual([55, 56]);
        expect(optsArg).toEqual({ actorId: 'u1' });

        expect(out.summary).toEqual({ created: 1, updated: 1, deleted: 2 });
        expect(out.createdMap).toEqual([{ clientKey: 'tmp-1', id: 128 }]);
        expect(out.items).toEqual([expect.objectContaining({ id: 128, name: 'Labor' })]);
        // listForManage re-read with limit 1000, active only.
        expect(queries.listForManage).toHaveBeenCalledWith('co1', { limit: 1000, offset: 0, includeArchived: false });
    });

    test('discards a fully-empty new row (no name/code/desc/unit/price/category)', async () => {
        await svc.bulkSaveItems('co1', {
            creates: [
                { clientKey: 'blank', name: '', description: '', code: '', unit: '', default_unit_price: 0 },
                { clientKey: 'real', name: 'Real', default_unit_price: 10 },
            ],
        }, {});
        const batch = queries.bulkSaveItems.mock.calls[0][1];
        expect(batch.creates).toHaveLength(1);
        expect(batch.creates[0].name).toBe('Real');
    });

    test('empty-name surviving create → 422 with details, no DB write', async () => {
        await expect(svc.bulkSaveItems('co1', {
            // Has a code so it survives the empty-row filter, but name is blank.
            creates: [{ name: '  ', code: '999', default_unit_price: 5 }],
        }, {})).rejects.toMatchObject({
            httpStatus: 422,
            code: 'validation_failed',
            details: [expect.objectContaining({ scope: 'creates', index: 0, field: 'name' })],
        });
        expect(queries.bulkSaveItems).not.toHaveBeenCalled();
    });

    test('non-numeric price → 422', async () => {
        await expect(svc.bulkSaveItems('co1', {
            creates: [{ name: 'X', default_unit_price: 'abc' }],
        }, {})).rejects.toMatchObject({
            httpStatus: 422,
            details: [expect.objectContaining({ field: 'default_unit_price' })],
        });
        expect(queries.bulkSaveItems).not.toHaveBeenCalled();
    });

    test('negative price → 422', async () => {
        await expect(svc.bulkSaveItems('co1', {
            updates: [{ id: 5, name: 'X', default_unit_price: -1 }],
        }, {})).rejects.toMatchObject({
            httpStatus: 422,
            details: [expect.objectContaining({ scope: 'updates', field: 'default_unit_price' })],
        });
        expect(queries.bulkSaveItems).not.toHaveBeenCalled();
    });

    test('foreign category_id (getCategory → null) → 422, no DB write', async () => {
        pbQueries.getCategory.mockResolvedValue(null);
        await expect(svc.bulkSaveItems('co1', {
            creates: [{ name: 'X', default_unit_price: 1, category_id: 99 }],
        }, {})).rejects.toMatchObject({
            httpStatus: 422,
            details: [expect.objectContaining({ scope: 'creates', index: 0, field: 'category_id' })],
        });
        expect(queries.bulkSaveItems).not.toHaveBeenCalled();
    });

    test('distinct category_ids checked once each (dedup)', async () => {
        await svc.bulkSaveItems('co1', {
            creates: [{ name: 'A', default_unit_price: 1, category_id: 7 }, { name: 'B', default_unit_price: 1, category_id: 7 }],
            updates: [{ id: 3, name: 'C', default_unit_price: 1, category_id: 8 }],
        }, {});
        expect(pbQueries.getCategory).toHaveBeenCalledTimes(2);
    });

    test('empty payload → summary {0,0,0} and current items, still hits bulkSaveItems', async () => {
        queries.listForManage.mockResolvedValue([{ id: 1, name: 'Existing', default_unit_price: 3 }]);
        const out = await svc.bulkSaveItems('co1', {}, {});
        expect(out.summary).toEqual({ created: 0, updated: 0, deleted: 0 });
        expect(out.items).toEqual([expect.objectContaining({ id: 1, name: 'Existing' })]);
        expect(queries.bulkSaveItems).toHaveBeenCalledWith('co1', { creates: [], updates: [], deletes: [] }, { actorId: null });
    });

    test('duplicate names are allowed (no dedupe error)', async () => {
        await svc.bulkSaveItems('co1', {
            creates: [{ name: 'Same', default_unit_price: 1 }, { name: 'Same', default_unit_price: 2 }],
        }, {});
        const batch = queries.bulkSaveItems.mock.calls[0][1];
        expect(batch.creates).toHaveLength(2);
    });

    test('collects ALL errors across the batch into details[]', async () => {
        await expect(svc.bulkSaveItems('co1', {
            creates: [{ code: 'a', name: '', default_unit_price: 1 }],
            updates: [{ id: 9, name: 'ok', default_unit_price: -5 }],
        }, {})).rejects.toMatchObject({
            httpStatus: 422,
            details: expect.arrayContaining([
                expect.objectContaining({ scope: 'creates', field: 'name' }),
                expect.objectContaining({ scope: 'updates', field: 'default_unit_price' }),
            ]),
        });
    });

    // FIX 1(a): pre-validate update ids in the SERVICE before the transaction.
    test('foreign/archived update id (findActiveIdsScoped missing it) → 422 details{scope:updates,field:id}, no DB write', async () => {
        // id 42 is valid/active, id 77 is not returned → not found or archived.
        queries.findActiveIdsScoped.mockResolvedValue([42]);
        await expect(svc.bulkSaveItems('co1', {
            updates: [
                { id: 42, name: 'Ok', default_unit_price: 10 },
                { id: 77, name: 'Gone', default_unit_price: 20 },
            ],
        }, {})).rejects.toMatchObject({
            httpStatus: 422,
            code: 'validation_failed',
            details: expect.arrayContaining([
                expect.objectContaining({ scope: 'updates', index: 1, field: 'id' }),
            ]),
        });
        expect(queries.findActiveIdsScoped).toHaveBeenCalledWith('co1', [42, 77]);
        expect(queries.bulkSaveItems).not.toHaveBeenCalled();
    });

    // FIX 1(b): safety net — TOCTOU tagged error from the query layer → clean 409.
    test('query-layer preset_not_found (TOCTOU) → EstimateItemPresetError 409', async () => {
        queries.bulkSaveItems.mockRejectedValue(
            Object.assign(new Error('preset_not_found'), { code: 'preset_not_found', itemId: 42 }),
        );
        await expect(svc.bulkSaveItems('co1', {
            updates: [{ id: 42, name: 'Ok', default_unit_price: 10 }],
        }, {})).rejects.toMatchObject({
            httpStatus: 409,
            code: 'preset_not_found',
        });
    });

    test('unrelated query-layer error is re-thrown unchanged (not masked as 409)', async () => {
        const boom = new Error('db exploded');
        queries.bulkSaveItems.mockRejectedValue(boom);
        await expect(svc.bulkSaveItems('co1', {
            updates: [{ id: 42, name: 'Ok', default_unit_price: 10 }],
        }, {})).rejects.toBe(boom);
    });
});
