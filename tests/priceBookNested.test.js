'use strict';

jest.mock('../backend/src/db/priceBookQueries', () => ({
    listCategories: jest.fn(), getCategory: jest.fn(), insertCategory: jest.fn(), updateCategory: jest.fn(), archiveCategory: jest.fn(),
    listGroups: jest.fn(), getGroup: jest.fn(), getGroupItems: jest.fn(), insertGroup: jest.fn(), updateGroup: jest.fn(), archiveGroup: jest.fn(),
    setGroupItems: jest.fn(), getGroupExpansion: jest.fn(), findCategoryByName: jest.fn(), findGroupByName: jest.fn(), upsertGroupItem: jest.fn(), exportRows: jest.fn(),
}));
jest.mock('../backend/src/db/estimateItemPresetsQueries', () => ({}));

const q = require('../backend/src/db/priceBookQueries');
const service = require('../backend/src/services/priceBookService');

beforeEach(() => Object.values(q).forEach(mock => mock.mockReset()));

describe('PRICEBOOK-NESTED-001 category service', () => {
    test('T-own / SAB-PB-SIBLING-REPEAT: tree nests three levels and permits repeated leaf names under different parents', async () => {
        q.listCategories.mockResolvedValue([
            { id: 5, parent_id: 3, name: 'Standard', sort_order: 0 },
            { id: 1, parent_id: null, name: '8 Education', sort_order: 8 },
            { id: 3, parent_id: 1, name: 'Dishwasher', sort_order: 1 },
            { id: 2, parent_id: 1, name: 'Refrigerator', sort_order: 0 },
            { id: 4, parent_id: 2, name: 'Standard', sort_order: 0 },
        ]);

        const tree = await service.listCategoryTree('company-a');

        expect(q.listCategories).toHaveBeenCalledWith('company-a', { includeArchived: false });
        expect(tree).toHaveLength(1);
        expect(tree[0]).toMatchObject({ id: 1, depth: 1 });
        expect(tree[0].children.map(child => child.name)).toEqual(['Refrigerator', 'Dishwasher']);
        expect(tree[0].children[0].children[0]).toMatchObject({ name: 'Standard', depth: 3, children: [] });
        expect(tree[0].children[1].children[0]).toMatchObject({ name: 'Standard', depth: 3, children: [] });
    });

    test('T-foreign parent returns 404 and performs no category insert', async () => {
        q.getCategory.mockResolvedValue(null);
        await expect(service.createCategory('company-a', { name: 'Child', parent_id: 99 }))
            .rejects.toMatchObject({ code: 'category_not_found', httpStatus: 404 });
        expect(q.getCategory).toHaveBeenCalledWith('company-a', 99);
        expect(q.insertCategory).not.toHaveBeenCalled();
    });

    test('database root/sibling conflict maps to stable 409', async () => {
        q.insertCategory.mockRejectedValue(Object.assign(new Error('unique'), { code: '23505' }));
        await expect(service.createCategory('company-a', { name: 'Duplicate' }))
            .rejects.toMatchObject({ code: 'category_name_conflict', httpStatus: 409 });
    });

    test('database cycle/depth guard maps to stable 422', async () => {
        q.getCategory.mockResolvedValue({ id: 7, company_id: 'company-a', archived_at: null });
        q.updateCategory.mockRejectedValue(Object.assign(new Error('four levels'), { code: '23514' }));
        await expect(service.updateCategory('company-a', 7, { parent_id: 8 }))
            .rejects.toMatchObject({ code: 'category_tree_invalid', httpStatus: 422 });
    });

    test('D3: archive with active dependencies returns 409 category_not_empty and counts', async () => {
        q.archiveCategory.mockResolvedValue({ category: { id: 7 }, dependencies: { children: 1, items: 2, groups: 3 } });
        await expect(service.archiveCategory('company-a', 7)).rejects.toMatchObject({
            code: 'category_not_empty', httpStatus: 409, details: { children: 1, items: 2, groups: 3 },
        });
    });

    test('T-foreign group category returns 404 before group insert', async () => {
        q.getCategory.mockResolvedValue(null);
        await expect(service.createGroup('company-a', { name: 'Group', category_id: 99 }))
            .rejects.toMatchObject({ code: 'category_not_found', httpStatus: 404 });
        expect(q.getCategory).toHaveBeenCalledWith('company-a', 99);
        expect(q.insertGroup).not.toHaveBeenCalled();
    });
});
