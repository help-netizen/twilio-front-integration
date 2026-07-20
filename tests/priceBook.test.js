/**
 * PRICEBOOK-001 — priceBookService unit tests (queries mocked).
 * Covers validation, company-scoping pass-through, and group expansion shape.
 */

jest.mock('../backend/src/db/priceBookQueries', () => ({
    listCategories: jest.fn(), getCategory: jest.fn(), insertCategory: jest.fn(), updateCategory: jest.fn(), archiveCategory: jest.fn(),
    listGroups: jest.fn(), getGroup: jest.fn(), getGroupItems: jest.fn(), insertGroup: jest.fn(), updateGroup: jest.fn(), archiveGroup: jest.fn(),
    setGroupItems: jest.fn(), getGroupExpansion: jest.fn(),
    findCategoryByName: jest.fn(), findGroupByName: jest.fn(), upsertGroupItem: jest.fn(), exportRows: jest.fn(),
}));
jest.mock('../backend/src/db/estimateItemPresetsQueries', () => ({
    findByNameScoped: jest.fn(), findByCodeScoped: jest.fn(), updatePresetScoped: jest.fn(), insertPreset: jest.fn(),
}));

const q = require('../backend/src/db/priceBookQueries');
const presetQ = require('../backend/src/db/estimateItemPresetsQueries');
const svc = require('../backend/src/services/priceBookService');

beforeEach(() => { Object.values(q).forEach(fn => fn.mockReset()); Object.values(presetQ).forEach(fn => fn.mockReset()); });

describe('categories', () => {
    test('createCategory requires a name', async () => {
        await expect(svc.createCategory('co1', {})).rejects.toMatchObject({ httpStatus: 422 });
        expect(q.insertCategory).not.toHaveBeenCalled();
    });
    test('createCategory passes companyId + createdBy through', async () => {
        q.insertCategory.mockResolvedValue({ id: 5, name: 'X' });
        await svc.createCategory('co1', { name: ' X ' }, { createdBy: 'u1' });
        expect(q.insertCategory).toHaveBeenCalledWith('co1', expect.objectContaining({ name: ' X ', createdBy: 'u1' }));
    });
    test('archiveCategory 404s when nothing archived', async () => {
        q.archiveCategory.mockResolvedValue(null);
        await expect(svc.archiveCategory('co1', 9)).rejects.toMatchObject({ httpStatus: 404 });
    });
});

describe('groups', () => {
    test('createGroup validates name, then replaces membership when items[] given', async () => {
        q.insertGroup.mockResolvedValue({ id: 3, name: 'G' });
        q.setGroupItems.mockResolvedValue([]);
        q.getGroup.mockResolvedValue({ id: 3, name: 'G' });
        q.getGroupItems.mockResolvedValue([]);
        await svc.createGroup('co1', { name: 'G', items: [{ item_id: 10, quantity: 2 }, { item_id: 'x' }] });
        // Only valid items (numeric item_id) are forwarded; qty>0 normalized.
        expect(q.setGroupItems).toHaveBeenCalledWith('co1', 3, [{ item_id: 10, quantity: 2 }]);
    });
    test('updateGroup with absent items[] does NOT touch membership', async () => {
        q.getGroup.mockResolvedValue({ id: 3, name: 'G' });
        q.getGroupItems.mockResolvedValue([]);
        await svc.updateGroup('co1', 3, { name: 'G2' });
        expect(q.setGroupItems).not.toHaveBeenCalled();
    });
});

describe('group expansion (add-to-document shape)', () => {
    test('maps qty/price/taxable to line-item strings (server already skips archived items)', async () => {
        q.getGroup.mockResolvedValue({ id: 3 });
        q.getGroupExpansion.mockResolvedValue([
            { name: 'Labor', description: null, quantity: 2, unit: 'hr', unit_price: 95, taxable: false },
            { name: 'Part', description: 'x', quantity: 1, unit: null, unit_price: 140, taxable: true },
        ]);
        const out = await svc.getGroupExpansion('co1', 3);
        expect(out).toEqual([
            { name: 'Labor', description: '', quantity: '2', unit: 'hr', unit_price: '95', taxable: false },
            { name: 'Part', description: 'x', quantity: '1', unit: null, unit_price: '140', taxable: true },
        ]);
    });
    test('expansion 404s for a missing group', async () => {
        q.getGroup.mockResolvedValue(null);
        await expect(svc.getGroupExpansion('co1', 99)).rejects.toMatchObject({ httpStatus: 404 });
    });
});

describe('CSV import', () => {
    test('creates categories/groups once (cached), adds items with memberships, upserts existing items', async () => {
        // Category/group don't exist yet → created; item1 new, item2 already exists → updated.
        q.findCategoryByName.mockResolvedValue(null);
        q.insertCategory.mockResolvedValue({ id: 7 });
        q.findGroupByName.mockResolvedValue(null);
        q.insertGroup.mockResolvedValue({ id: 9 });
        q.upsertGroupItem.mockResolvedValue(undefined);
        presetQ.findByCodeScoped
            .mockResolvedValueOnce(null)                 // "Labor" → new
            .mockResolvedValueOnce({ id: 42 });          // "Part" → existing
        presetQ.insertPreset.mockResolvedValue({ id: 41 });
        presetQ.updatePresetScoped.mockResolvedValue({ id: 42 });

        const csv = [
            'Name,Description,Code,Unit,Unit Price,Taxable,Category,Group,Group Quantity',
            'Labor,,1010,hr,95,No,Dishwasher,Drain motor,2',
            'Part,,2010,ea,140,Yes,Dishwasher,Drain motor,1',
        ].join('\n');

        const s = await svc.importCsv('co1', csv, { createdBy: 'u1' });

        expect(s).toMatchObject({ rows: 2, items_created: 1, items_updated: 1, categories_created: 1, groups_created: 1, memberships: 2 });
        expect(s.errors).toEqual([]);
        // Category + group created exactly once despite appearing on both rows (caching).
        expect(q.insertCategory).toHaveBeenCalledTimes(1);
        expect(q.insertGroup).toHaveBeenCalledTimes(1);
        expect(q.upsertGroupItem).toHaveBeenCalledTimes(2);
        // Taxable parsed: Part row taxable=true.
        expect(presetQ.updatePresetScoped).toHaveBeenCalledWith('co1', 42, expect.objectContaining({ default_taxable: true, category_id: 7 }));
    });

    test('parses quoted fields with embedded commas + reports a missing-name row error, keeps going', async () => {
        q.findCategoryByName.mockResolvedValue({ id: 1 });
        presetQ.findByNameScoped.mockResolvedValue(null);
        presetQ.insertPreset.mockResolvedValue({ id: 5 });

        const csv = [
            'Name,Description,Category',
            '"Motor, 1/2 HP","Quoted, with comma",Parts',
            ',orphan row,Parts',
        ].join('\n');

        const s = await svc.importCsv('co1', csv, {});
        expect(s.items_created).toBe(1);
        expect(s.errors).toEqual([{ row: 3, error: 'Name is empty' }]);
        expect(presetQ.insertPreset).toHaveBeenCalledWith('co1', expect.objectContaining({ name: 'Motor, 1/2 HP', description: 'Quoted, with comma' }));
    });

    test('empty file → 422', async () => {
        await expect(svc.importCsv('co1', '', {})).rejects.toMatchObject({ httpStatus: 422 });
    });
});
