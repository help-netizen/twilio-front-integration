import type { PriceBookCategoryNode } from '../../services/priceBookApi';

export function flattenCategoryTree(tree: PriceBookCategoryNode[]): PriceBookCategoryNode[] {
    const result: PriceBookCategoryNode[] = [];
    const visit = (nodes: PriceBookCategoryNode[]) => {
        for (const node of nodes) {
            result.push(node);
            visit(node.children);
        }
    };
    visit(tree);
    return result;
}

export function categoryPath(tree: PriceBookCategoryNode[], categoryId: number | null): PriceBookCategoryNode[] {
    if (categoryId == null) return [];
    const flat = flattenCategoryTree(tree);
    const byId = new Map(flat.map(node => [node.id, node]));
    const result: PriceBookCategoryNode[] = [];
    const seen = new Set<number>();
    let current = byId.get(categoryId);
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        result.unshift(current);
        current = current.parent_id == null ? undefined : byId.get(current.parent_id);
    }
    return result;
}

export function categoryPathLabel(tree: PriceBookCategoryNode[], categoryId: number | null): string {
    if (categoryId == null) return 'Uncategorized';
    return categoryPath(tree, categoryId).map(node => node.name).join(' › ');
}

export function categoryOptions(tree: PriceBookCategoryNode[], excludedIds: Set<number> = new Set()): Array<PriceBookCategoryNode & { label: string }> {
    return flattenCategoryTree(tree)
        .filter(node => !excludedIds.has(node.id))
        .map(node => ({ ...node, label: categoryPathLabel(tree, node.id) }));
}

export function descendantIds(tree: PriceBookCategoryNode[], categoryId: number): Set<number> {
    const node = flattenCategoryTree(tree).find(candidate => candidate.id === categoryId);
    const ids = new Set<number>([categoryId]);
    const visit = (children: PriceBookCategoryNode[]) => {
        for (const child of children) {
            ids.add(child.id);
            visit(child.children);
        }
    };
    if (node) visit(node.children);
    return ids;
}
