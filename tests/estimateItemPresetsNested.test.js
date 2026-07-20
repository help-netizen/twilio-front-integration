'use strict';

jest.mock('../backend/src/db/estimateItemPresetsQueries', () => ({
    findByNameScoped: jest.fn(), insertPreset: jest.fn(), getByIdScoped: jest.fn(), updatePresetScoped: jest.fn(),
}));
jest.mock('../backend/src/db/priceBookQueries', () => ({ getCategory: jest.fn() }));

const queries = require('../backend/src/db/estimateItemPresetsQueries');
const priceBookQueries = require('../backend/src/db/priceBookQueries');
const service = require('../backend/src/services/estimateItemPresetsService');

beforeEach(() => {
    Object.values(queries).forEach(mock => mock.mockReset());
    priceBookQueries.getCategory.mockReset();
});

describe('nested Price Book category assignment on item mutations', () => {
    test('T-foreign create rejects a foreign category before item lookup/write', async () => {
        priceBookQueries.getCategory.mockResolvedValue(null);
        await expect(service.create('company-a', { name: 'Labor', category_id: 99 }))
            .rejects.toMatchObject({ code: 'category_not_found', httpStatus: 404 });
        expect(priceBookQueries.getCategory).toHaveBeenCalledWith('company-a', 99);
        expect(queries.findByNameScoped).not.toHaveBeenCalled();
        expect(queries.insertPreset).not.toHaveBeenCalled();
    });

    test('T-own create accepts an active owned category and preserves crm_users actor', async () => {
        priceBookQueries.getCategory.mockResolvedValue({ id: 7, company_id: 'company-a', archived_at: null });
        queries.findByNameScoped.mockResolvedValue(null);
        queries.insertPreset.mockResolvedValue({ id: 1, name: 'Labor', category_id: 7, default_quantity: 1, default_unit_price: 0 });
        await service.create('company-a', { name: 'Labor', category_id: '7' }, { createdBy: 'crm-user-a' });
        expect(queries.insertPreset).toHaveBeenCalledWith('company-a', expect.objectContaining({ category_id: 7, createdBy: 'crm-user-a' }));
    });

    test('T-foreign update leaves the owned item unchanged when new category is foreign', async () => {
        queries.getByIdScoped.mockResolvedValue({ id: 4, company_id: 'company-a', name: 'Labor' });
        priceBookQueries.getCategory.mockResolvedValue(null);
        await expect(service.update('company-a', 4, { category_id: 99 }))
            .rejects.toMatchObject({ code: 'category_not_found', httpStatus: 404 });
        expect(queries.updatePresetScoped).not.toHaveBeenCalled();
    });
});
