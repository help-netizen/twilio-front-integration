// PRICEBOOK-001 — Price Book management API client (categories / groups / items).
import { authedFetch } from './apiClient';

const BASE = '/api/price-book';

async function ok<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Request failed: ${res.status} ${text}`);
        (err as Error & { status: number }).status = res.status;
        throw err;
    }
    return res.json() as Promise<T>;
}
const json = (method: string, body?: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

// ── Types ────────────────────────────────────────────────────────────────────
export interface PriceBookCategory { id: number; parent_id: number | null; name: string; description: string | null; sort_order: number; archived_at: string | null; }
export interface PriceBookCategoryNode extends PriceBookCategory { depth: number; children: PriceBookCategoryNode[]; }
export interface PriceBookItem {
    id: number; name: string; description: string | null;
    default_quantity: number | null; default_unit_price: number | null; default_taxable: boolean;
    category_id: number | null; category_name: string | null; code: string | null; unit: string | null;
    archived_at: string | null;
}
export interface PriceBookGroupItem {
    link_id: number; item_id: number; quantity: number; sort_order: number;
    name: string; description: string | null; default_unit_price: number; default_taxable: boolean; unit: string | null; code: string | null; item_archived: boolean;
}
export interface PriceBookGroup {
    id: number; name: string; description: string | null; category_id: number | null; category_name?: string | null;
    sort_order: number; archived_at: string | null; item_count?: number; total?: number; items?: PriceBookGroupItem[];
}
export interface GroupItemInput { item_id: number; quantity: number; }
export interface ExpandedLineItem { name: string; description: string; quantity: string; unit: string | null; unit_price: string; taxable: boolean; }

// ── Categories ───────────────────────────────────────────────────────────────
export async function listCategories(includeArchived = false): Promise<PriceBookCategory[]> {
    const res = await authedFetch(`${BASE}/categories?includeArchived=${includeArchived}`);
    return (await ok<{ categories: PriceBookCategory[] }>(res)).categories;
}
export async function listCategoryTree(): Promise<PriceBookCategoryNode[]> {
    const res = await authedFetch(`${BASE}/categories/tree`);
    return (await ok<{ categories: PriceBookCategoryNode[] }>(res)).categories;
}
export const createCategory = (b: { name: string; description?: string | null; parent_id?: number | null }) => authedFetch(`${BASE}/categories`, json('POST', b)).then(ok<PriceBookCategory>);
export const updateCategory = (id: number, b: Partial<{ name: string; description: string | null; parent_id: number | null; sort_order: number }>) => authedFetch(`${BASE}/categories/${id}`, json('PATCH', b)).then(ok<PriceBookCategory>);
export const archiveCategory = (id: number) => authedFetch(`${BASE}/categories/${id}`, json('DELETE')).then(ok<PriceBookCategory>);

// ── Items ────────────────────────────────────────────────────────────────────
export async function listItems(opts: { search?: string; category_id?: number | null; uncategorized?: boolean; includeArchived?: boolean; limit?: number } = {}): Promise<PriceBookItem[]> {
    const p = new URLSearchParams();
    if (opts.search) p.set('search', opts.search);
    if (opts.category_id != null) p.set('category_id', String(opts.category_id));
    if (opts.uncategorized) p.set('uncategorized', 'true');
    if (opts.includeArchived) p.set('includeArchived', 'true');
    if (opts.limit != null) p.set('limit', String(opts.limit));
    const res = await authedFetch(`${BASE}/items?${p.toString()}`);
    return (await ok<{ items: PriceBookItem[] }>(res)).items;
}
export interface ItemInput { name: string; description?: string | null; default_quantity?: number; default_unit_price?: number; default_taxable?: boolean; category_id?: number | null; code?: string | null; unit?: string | null; }
export const createItem = (b: ItemInput) => authedFetch(`${BASE}/items`, json('POST', b)).then(ok<PriceBookItem>);
export const updateItem = (id: number, b: Partial<ItemInput>) => authedFetch(`${BASE}/items/${id}`, json('PATCH', b)).then(ok<PriceBookItem>);
export const archiveItem = (id: number) => authedFetch(`${BASE}/items/${id}`, json('DELETE')).then(ok<PriceBookItem>);

// ── Bulk items save (PRICEBOOK-002 — spreadsheet grid) ─────────────────────────
export interface BulkItemCreate { clientKey?: string; name: string; description?: string | null; code?: string | null; unit?: string | null; default_unit_price?: number; default_taxable?: boolean; category_id?: number | null; }
export interface BulkItemUpdate extends BulkItemCreate { id: number; }
export interface BulkItemsPayload { creates: BulkItemCreate[]; updates: BulkItemUpdate[]; deletes: number[]; }
export interface BulkItemsResult { items: PriceBookItem[]; summary: { created: number; updated: number; deleted: number }; createdMap: { clientKey: string; id: number }[]; }
export const bulkSaveItems = (b: BulkItemsPayload) => authedFetch(`${BASE}/items/bulk`, json('PUT', b)).then(ok<BulkItemsResult>);

// ── Groups ───────────────────────────────────────────────────────────────────
export async function listGroups(opts: { search?: string; category_id?: number | null; uncategorized?: boolean; includeArchived?: boolean } = {}): Promise<PriceBookGroup[]> {
    const p = new URLSearchParams();
    if (opts.search) p.set('search', opts.search);
    if (opts.category_id != null) p.set('category_id', String(opts.category_id));
    if (opts.uncategorized) p.set('uncategorized', 'true');
    if (opts.includeArchived) p.set('includeArchived', 'true');
    const res = await authedFetch(`${BASE}/groups?${p.toString()}`);
    return (await ok<{ groups: PriceBookGroup[] }>(res)).groups;
}
export const getGroup = (id: number) => authedFetch(`${BASE}/groups/${id}`).then(ok<PriceBookGroup>);
export interface GroupInput { name: string; description?: string | null; category_id?: number | null; items?: GroupItemInput[]; }
export const createGroup = (b: GroupInput) => authedFetch(`${BASE}/groups`, json('POST', b)).then(ok<PriceBookGroup>);
export const updateGroup = (id: number, b: Partial<GroupInput>) => authedFetch(`${BASE}/groups/${id}`, json('PATCH', b)).then(ok<PriceBookGroup>);
export const archiveGroup = (id: number) => authedFetch(`${BASE}/groups/${id}`, json('DELETE')).then(ok<PriceBookGroup>);
export async function expandGroup(id: number): Promise<ExpandedLineItem[]> {
    const res = await authedFetch(`${BASE}/groups/${id}/expand`);
    return (await ok<{ items: ExpandedLineItem[] }>(res)).items;
}

// ── Import / Export (CSV) ────────────────────────────────────────────────────
async function downloadCsv(path: string, filename: string) {
    const res = await authedFetch(`${BASE}${path}`);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
}
export const downloadTemplate = () => downloadCsv('/template', 'price-book-template.csv');
export const exportItemsCsv = () => downloadCsv('/export', 'price-book.csv');

export interface ImportSummary {
    rows: number; items_created: number; items_updated: number;
    categories_created: number; groups_created: number; memberships: number;
    errors: { row: number; error: string }[];
}
export async function importCsv(csv: string): Promise<ImportSummary> {
    const res = await authedFetch(`${BASE}/import`, json('POST', { csv }));
    return ok<ImportSummary>(res);
}
