import { describe, expect, it } from 'vitest';
import source from './ItemPresetSearchCombobox.tsx?raw';

describe('nested Price Book picker contract', () => {
    it('keeps sequential drill-down, breadcrumb, and legacy Uncategorized access in the existing picker', () => {
        expect(source).toContain('listCategoryTree()');
        expect(source).toContain('Category breadcrumb');
        expect(source).toContain('Uncategorized');
        expect(source).toContain('uncategorized: true');
        expect(source).toContain("event.key === 'Backspace'");
        expect(source).toContain('browseCategory(currentCategory.parent_id)');
    });

    it('keeps global search/create/groups and disambiguates search results with SKU plus full path', () => {
        expect(source).toContain('searchEstimateItemPresets(trimmed, 50)');
        expect(source).toContain('onCreateNew(trimmed)');
        expect(source).toContain('listGroups({');
        expect(source).toContain('preset.code');
        expect(source).toContain('categoryPathLabel(tree, preset.category_id)');
    });
});
