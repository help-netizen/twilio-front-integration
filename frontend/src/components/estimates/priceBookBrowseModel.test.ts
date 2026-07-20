import { describe, expect, it } from 'vitest';
import type { PriceBookCategoryNode } from '../../services/priceBookApi';
import { categoryOptions, categoryPathLabel, descendantIds, flattenCategoryTree } from './priceBookBrowseModel';

const node = (id: number, name: string, parent_id: number | null, depth: number, children: PriceBookCategoryNode[] = []): PriceBookCategoryNode => ({
    id, name, parent_id, depth, children, description: null, sort_order: 0, archived_at: null,
});

const tree = [
    node(1, '8 Education', null, 1, [
        node(2, 'Dishwasher', 1, 2, [node(3, 'Standard', 2, 3)]),
        node(4, 'Refrigerator', 1, 2, [node(5, 'Standard', 4, 3)]),
    ]),
];

describe('priceBookBrowseModel', () => {
    it('SAB-PB-PICKER-PATH: gives repeated leaf names distinct full-path labels', () => {
        expect(categoryPathLabel(tree, 3)).toBe('8 Education › Dishwasher › Standard');
        expect(categoryPathLabel(tree, 5)).toBe('8 Education › Refrigerator › Standard');
        expect(categoryPathLabel(tree, null)).toBe('Uncategorized');
    });

    it('flattens in drill-down order and excludes a moved node plus its descendants', () => {
        expect(flattenCategoryTree(tree).map(category => category.id)).toEqual([1, 2, 3, 4, 5]);
        const excluded = descendantIds(tree, 2);
        expect([...excluded]).toEqual([2, 3]);
        expect(categoryOptions(tree, excluded).map(option => option.id)).toEqual([1, 4, 5]);
    });
});
