/**
 * PriceBookPage — PRICEBOOK-001. Settings → Price Book.
 * Three tabs: Items / Groups / Categories. Manage the catalog that feeds
 * estimate & invoice line items. A Group expands into its Items when added to a
 * document (handled in the estimate/invoice pickers, not here).
 *
 * Editors follow the canonical right-side slide-over "layer" (variant="panel" +
 * floating-label fields) — see CLAUDE.md "Layers & overlays" + docs/specs/FORM-CANON.md.
 */
import { useCallback, useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { FloatingField } from '../components/ui/floating-field';
import { FloatingSelect } from '../components/ui/floating-select';
import { SelectItem } from '../components/ui/select';
import { Checkbox } from '../components/ui/checkbox';
import { toast } from 'sonner';
import { Plus, Pencil, Archive, Trash2, Loader2, Upload, Download, FileDown, CheckCircle2 } from 'lucide-react';
import * as api from '../services/priceBookApi';
import type { PriceBookCategory, PriceBookItem, PriceBookGroup, GroupItemInput, ImportSummary } from '../services/priceBookApi';

const money = (n: number | null | undefined) => `$${(Number(n) || 0).toFixed(2)}`;

export default function PriceBookPage() {
    const [categories, setCategories] = useState<PriceBookCategory[]>([]);
    const [version, setVersion] = useState(0);          // bump to force tab re-fetch (after import)
    const [ioOpen, setIoOpen] = useState(false);
    const loadCategories = useCallback(async () => { try { setCategories(await api.listCategories()); } catch { /* */ } }, []);
    useEffect(() => { loadCategories(); }, [loadCategories, version]);
    const refreshAll = () => { setVersion(v => v + 1); loadCategories(); };

    return (
        <div className="p-6 max-w-5xl mx-auto">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 className="blanc-heading blanc-heading-lg" style={{ color: 'var(--blanc-ink-1)' }}>Price Book</h2>
                    <p className="blanc-eyebrow mb-5">Manage items, groups &amp; categories for estimates and invoices</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <Button variant="ghost" onClick={() => setIoOpen(true)}><Upload size={16} /> Import</Button>
                    <Button variant="ghost" onClick={() => setIoOpen(true)}><Download size={16} /> Export</Button>
                </div>
            </div>
            <Tabs defaultValue="items">
                <TabsList>
                    <TabsTrigger value="items">Items &amp; products</TabsTrigger>
                    <TabsTrigger value="groups">Item groups</TabsTrigger>
                    <TabsTrigger value="categories">Item categories</TabsTrigger>
                </TabsList>
                <TabsContent value="items"><ItemsTab categories={categories} version={version} /></TabsContent>
                <TabsContent value="groups"><GroupsTab categories={categories} version={version} /></TabsContent>
                <TabsContent value="categories"><CategoriesTab onChanged={loadCategories} version={version} /></TabsContent>
            </Tabs>
            <ImportExportPanel open={ioOpen} onClose={() => setIoOpen(false)} onImported={refreshAll} />
        </div>
    );
}

// ─────────────────────────── Import / Export layer ───────────────────────────
function ImportExportPanel({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
    const [busy, setBusy] = useState(false);
    const [summary, setSummary] = useState<ImportSummary | null>(null);
    useEffect(() => { if (open) setSummary(null); }, [open]);

    const onFile = async (file: File | undefined) => {
        if (!file) return;
        setBusy(true); setSummary(null);
        try {
            const text = await file.text();
            const s = await api.importCsv(text);
            setSummary(s);
            toast.success(`Imported: ${s.items_created} new, ${s.items_updated} updated`);
            onImported();
        } catch { toast.error('Import failed — check the file format'); }
        finally { setBusy(false); }
    };

    return (
        <Dialog open={open} onOpenChange={o => !o && onClose()}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle className="text-[22px] font-semibold leading-tight" style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}>Import / Export</DialogTitle>
                    <DialogDescription className="sr-only">Import items from a CSV file or export the current price book</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-7">
                        {/* Import */}
                        <div className="space-y-3">
                            <div className="blanc-eyebrow">Import items</div>
                            <label className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 cursor-pointer text-center"
                                style={{ borderColor: 'var(--blanc-line)', background: 'rgba(117,106,89,0.03)' }}
                                onDragOver={e => e.preventDefault()}
                                onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}>
                                {busy ? <Loader2 className="animate-spin" style={{ color: 'var(--blanc-ink-3)' }} /> : <Upload style={{ color: 'var(--blanc-ink-3)' }} />}
                                <div className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>Drop a CSV here, or click to choose a file</div>
                                <div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>New categories &amp; groups are created; existing ones get the item added</div>
                                <input type="file" accept=".csv,text/csv" className="hidden" disabled={busy} onChange={e => onFile(e.target.files?.[0])} />
                            </label>
                            <button type="button" onClick={() => api.downloadTemplate()} className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--blanc-job)' }}>
                                <FileDown size={15} /> Download the fill-in template
                            </button>
                            {summary && (
                                <div className="rounded-lg border px-4 py-3 text-sm space-y-1" style={{ borderColor: 'var(--blanc-line)', background: 'rgba(27,139,99,0.06)' }}>
                                    <div className="flex items-center gap-2" style={{ color: 'var(--blanc-ink-1)' }}><CheckCircle2 size={16} style={{ color: 'var(--blanc-task,#1b8b63)' }} /> Imported {summary.rows} row(s)</div>
                                    <div style={{ color: 'var(--blanc-ink-2)' }}>{summary.items_created} items created · {summary.items_updated} updated · {summary.categories_created} categories · {summary.groups_created} groups · {summary.memberships} group links</div>
                                    {summary.errors.length > 0 && <div style={{ color: 'var(--blanc-danger,#d44d3c)' }}>{summary.errors.length} row(s) skipped: {summary.errors.slice(0, 3).map(e => `row ${e.row}`).join(', ')}{summary.errors.length > 3 ? '…' : ''}</div>}
                                </div>
                            )}
                        </div>
                        {/* Export */}
                        <div className="space-y-3">
                            <div className="blanc-eyebrow">Export</div>
                            <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>Download all items with their category and group columns (CSV).</p>
                            <Button type="button" variant="secondary" onClick={() => api.exportItemsCsv()}><Download size={16} /> Export price book</Button>
                        </div>
                    </div>
                </DialogBody>
                <DialogPanelFooter>
                    <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─────────────────────────── Items ───────────────────────────
function ItemsTab({ categories, version }: { categories: PriceBookCategory[]; version: number }) {
    const [items, setItems] = useState<PriceBookItem[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<PriceBookItem | 'new' | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try { setItems(await api.listItems({ search })); } catch { toast.error('Failed to load items'); }
        finally { setLoading(false); }
    }, [search]);
    useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load, version]);

    return (
        <div className="mt-4">
            <div className="flex items-center gap-2 mb-3">
                <Input placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} className="max-w-xs" />
                <div className="flex-1" />
                <Button onClick={() => setEditing('new')}><Plus size={16} /> Add item</Button>
            </div>
            {loading ? <Spinner /> : items.length === 0 ? <Empty label="No items yet" /> : (
                <Table head={['Name', 'Code', 'Unit', 'Price', 'Taxable', 'Category', '']}>
                    {items.map(it => (
                        <tr key={it.id} className="border-t" style={{ borderColor: 'var(--blanc-line)' }}>
                            <Td>{it.name}</Td><Td muted>{it.code || '—'}</Td><Td muted>{it.unit || '—'}</Td>
                            <Td>{money(it.default_unit_price)}</Td><Td muted>{it.default_taxable ? 'Yes' : 'No'}</Td>
                            <Td muted>{it.category_name || '—'}</Td>
                            <Td><RowActions onEdit={() => setEditing(it)} onArchive={async () => { await api.archiveItem(it.id); toast.success('Archived'); load(); }} /></Td>
                        </tr>
                    ))}
                </Table>
            )}
            <ItemPanel open={!!editing} item={editing === 'new' ? null : editing} categories={categories} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
        </div>
    );
}

function ItemPanel({ open, item, categories, onClose, onSaved }: { open: boolean; item: PriceBookItem | null; categories: PriceBookCategory[]; onClose: () => void; onSaved: () => void }) {
    const empty = { name: '', code: '', unit: '', default_unit_price: '', default_taxable: false, category_id: '', description: '' };
    const [f, setF] = useState(empty);
    useEffect(() => {
        if (!open) return;
        setF(item ? {
            name: item.name || '', code: item.code || '', unit: item.unit || '',
            default_unit_price: String(item.default_unit_price ?? ''), default_taxable: item.default_taxable ?? false,
            category_id: item.category_id != null ? String(item.category_id) : '', description: item.description || '',
        } : empty);
    }, [open, item]);
    const [busy, setBusy] = useState(false);
    const canSave = f.name.trim().length > 0;
    const save = async () => {
        if (!canSave) return;
        setBusy(true);
        try {
            const body = { name: f.name.trim(), code: f.code.trim() || null, unit: f.unit.trim() || null, default_unit_price: Number(f.default_unit_price) || 0, default_taxable: f.default_taxable, category_id: f.category_id ? Number(f.category_id) : null, description: f.description.trim() || null };
            if (item) await api.updateItem(item.id, body); else await api.createItem(body);
            toast.success(item ? 'Item updated' : 'Item created'); onSaved();
        } catch { toast.error('Save failed'); } finally { setBusy(false); }
    };
    return (
        <Dialog open={open} onOpenChange={o => !o && onClose()}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle className="text-[22px] font-semibold leading-tight" style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}>{item ? 'Edit item' : 'New item'}</DialogTitle>
                    <DialogDescription className="sr-only">Add or edit a price-book item</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <div className="space-y-3.5">
                            <FloatingField id="pb-item-name" label="Name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />
                            <FloatingField id="pb-item-desc" label="Description" textarea rows={3} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} />
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingField id="pb-item-code" label="Code / SKU" value={f.code} onChange={e => setF({ ...f, code: e.target.value })} />
                                <FloatingField id="pb-item-unit" label="Unit (hr, ea…)" value={f.unit} onChange={e => setF({ ...f, unit: e.target.value })} />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingField id="pb-item-price" label="Unit price" inputMode="decimal" value={f.default_unit_price} onChange={e => setF({ ...f, default_unit_price: e.target.value })} />
                                <FloatingSelect id="pb-item-cat" label="Category" value={f.category_id || 'none'} onValueChange={v => setF({ ...f, category_id: v === 'none' ? '' : v })}>
                                    <SelectItem value="none">Uncategorized</SelectItem>
                                    {categories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                                </FloatingSelect>
                            </div>
                        </div>
                        <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--blanc-ink-1)' }}>
                            <Checkbox checked={f.default_taxable} onCheckedChange={c => setF({ ...f, default_taxable: !!c })} /> Taxable
                        </label>
                    </div>
                </DialogBody>
                <DialogPanelFooter>
                    <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button type="button" onClick={save} disabled={!canSave || busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : (item ? 'Save changes' : 'Add item')}</Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─────────────────────────── Groups ───────────────────────────
function GroupsTab({ categories, version }: { categories: PriceBookCategory[]; version: number }) {
    const [groups, setGroups] = useState<PriceBookGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<PriceBookGroup | 'new' | null>(null);
    const load = useCallback(async () => { setLoading(true); try { setGroups(await api.listGroups()); } catch { toast.error('Failed to load groups'); } finally { setLoading(false); } }, []);
    useEffect(() => { load(); }, [load, version]);
    return (
        <div className="mt-4">
            <div className="flex items-center mb-3">
                <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>Groups add multiple items to an estimate/invoice at once.</p>
                <div className="flex-1" />
                <Button onClick={() => setEditing('new')}><Plus size={16} /> Add group</Button>
            </div>
            {loading ? <Spinner /> : groups.length === 0 ? <Empty label="No groups yet" /> : (
                <Table head={['Name', 'Items', 'Total', 'Category', '']}>
                    {groups.map(g => (
                        <tr key={g.id} className="border-t" style={{ borderColor: 'var(--blanc-line)' }}>
                            <Td>{g.name}</Td><Td muted>{g.item_count ?? 0}</Td><Td>{money(g.total)}</Td><Td muted>{g.category_name || '—'}</Td>
                            <Td><RowActions onEdit={async () => setEditing(await api.getGroup(g.id))} onArchive={async () => { await api.archiveGroup(g.id); toast.success('Archived'); load(); }} /></Td>
                        </tr>
                    ))}
                </Table>
            )}
            <GroupPanel open={!!editing} group={editing === 'new' ? null : editing} categories={categories} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
        </div>
    );
}

function GroupPanel({ open, group, categories, onClose, onSaved }: { open: boolean; group: PriceBookGroup | null; categories: PriceBookCategory[]; onClose: () => void; onSaved: () => void }) {
    const [name, setName] = useState('');
    const [categoryId, setCategoryId] = useState('');
    const [rows, setRows] = useState<{ item_id: number; name: string; quantity: string }[]>([]);
    const [picker, setPicker] = useState('');
    const [found, setFound] = useState<PriceBookItem[]>([]);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(group?.name || '');
        setCategoryId(group?.category_id != null ? String(group.category_id) : '');
        setRows((group?.items || []).map(i => ({ item_id: i.item_id, name: i.name, quantity: String(i.quantity) })));
        setPicker(''); setFound([]);
    }, [open, group]);

    useEffect(() => {
        if (picker.trim().length < 1) { setFound([]); return; }
        const t = setTimeout(async () => { try { setFound(await api.listItems({ search: picker })); } catch { /* */ } }, 200);
        return () => clearTimeout(t);
    }, [picker]);

    const addRow = (it: PriceBookItem) => { if (!rows.some(r => r.item_id === it.id)) setRows([...rows, { item_id: it.id, name: it.name, quantity: '1' }]); setPicker(''); setFound([]); };
    const canSave = name.trim().length > 0 && rows.length > 0;

    const save = async () => {
        if (!canSave) return;
        setBusy(true);
        try {
            const items: GroupItemInput[] = rows.map(r => ({ item_id: r.item_id, quantity: Number(r.quantity) || 1 }));
            const body = { name: name.trim(), category_id: categoryId ? Number(categoryId) : null, items };
            if (group) await api.updateGroup(group.id, body); else await api.createGroup(body);
            toast.success(group ? 'Group updated' : 'Group created'); onSaved();
        } catch { toast.error('Save failed'); } finally { setBusy(false); }
    };

    return (
        <Dialog open={open} onOpenChange={o => !o && onClose()}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle className="text-[22px] font-semibold leading-tight" style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}>{group ? 'Edit group' : 'New group'}</DialogTitle>
                    <DialogDescription className="sr-only">A group inserts all its items into an estimate or invoice at once</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                            <FloatingField id="pb-group-name" label="Name" value={name} onChange={e => setName(e.target.value)} />
                            <FloatingSelect id="pb-group-cat" label="Category" value={categoryId || 'none'} onValueChange={v => setCategoryId(v === 'none' ? '' : v)}>
                                <SelectItem value="none">Uncategorized</SelectItem>
                                {categories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                            </FloatingSelect>
                        </div>
                        <div className="space-y-2">
                            <div className="blanc-eyebrow">Items in this group</div>
                            {rows.map((r, i) => (
                                <div key={r.item_id} className="flex items-center gap-2">
                                    <span className="flex-1 text-sm" style={{ color: 'var(--blanc-ink-1)' }}>{r.name}</span>
                                    <Input type="number" step="0.01" value={r.quantity} onChange={e => { const c = [...rows]; c[i] = { ...r, quantity: e.target.value }; setRows(c); }} className="w-20" aria-label={`Quantity for ${r.name}`} />
                                    <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove" style={{ color: 'var(--blanc-ink-3)' }}><Trash2 size={15} /></button>
                                </div>
                            ))}
                            <div className="relative">
                                <Input placeholder="Add an item…" value={picker} onChange={e => setPicker(e.target.value)} />
                                {found.length > 0 && (
                                    <div className="absolute z-10 left-0 right-0 mt-1 rounded-md border shadow" style={{ borderColor: 'var(--blanc-line)', background: 'var(--blanc-panel-surface,#fffdf9)' }}>
                                        {found.slice(0, 8).map(it => (
                                            <button key={it.id} type="button" onClick={() => addRow(it)} className="block w-full text-left px-3 py-2 text-sm hover:bg-[rgba(117,106,89,0.06)]">{it.name} <span style={{ color: 'var(--blanc-ink-3)' }}>· {money(it.default_unit_price)}</span></button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </DialogBody>
                <DialogPanelFooter>
                    <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button type="button" onClick={save} disabled={!canSave || busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : (group ? 'Save changes' : 'Add group')}</Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─────────────────────────── Categories ───────────────────────────
function CategoriesTab({ onChanged, version }: { onChanged: () => void; version: number }) {
    const [cats, setCats] = useState<PriceBookCategory[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<PriceBookCategory | 'new' | null>(null);
    const load = useCallback(async () => { setLoading(true); try { setCats(await api.listCategories()); } catch { toast.error('Failed to load categories'); } finally { setLoading(false); } }, []);
    useEffect(() => { load(); }, [load, version]);
    const after = () => { setEditing(null); load(); onChanged(); };
    return (
        <div className="mt-4">
            <div className="flex items-center mb-3">
                <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>Categories only organize items &amp; groups — they aren't added to documents.</p>
                <div className="flex-1" />
                <Button onClick={() => setEditing('new')}><Plus size={16} /> Add category</Button>
            </div>
            {loading ? <Spinner /> : cats.length === 0 ? <Empty label="No categories yet" /> : (
                <Table head={['Name', 'Description', '']}>
                    {cats.map(c => (
                        <tr key={c.id} className="border-t" style={{ borderColor: 'var(--blanc-line)' }}>
                            <Td>{c.name}</Td><Td muted>{c.description || '—'}</Td>
                            <Td><RowActions onEdit={() => setEditing(c)} onArchive={async () => { await api.archiveCategory(c.id); toast.success('Archived'); after(); }} /></Td>
                        </tr>
                    ))}
                </Table>
            )}
            <CategoryPanel open={!!editing} cat={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={after} />
        </div>
    );
}

function CategoryPanel({ open, cat, onClose, onSaved }: { open: boolean; cat: PriceBookCategory | null; onClose: () => void; onSaved: () => void }) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => { if (open) { setName(cat?.name || ''); setDescription(cat?.description || ''); } }, [open, cat]);
    const canSave = name.trim().length > 0;
    const save = async () => {
        if (!canSave) return;
        setBusy(true);
        try {
            const body = { name: name.trim(), description: description.trim() || null };
            if (cat) await api.updateCategory(cat.id, body); else await api.createCategory(body);
            toast.success(cat ? 'Category updated' : 'Category created'); onSaved();
        } catch { toast.error('Save failed'); } finally { setBusy(false); }
    };
    return (
        <Dialog open={open} onOpenChange={o => !o && onClose()}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle className="text-[22px] font-semibold leading-tight" style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}>{cat ? 'Edit category' : 'New category'}</DialogTitle>
                    <DialogDescription className="sr-only">Categories organize items and groups</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-3.5">
                        <FloatingField id="pb-cat-name" label="Name" value={name} onChange={e => setName(e.target.value)} />
                        <FloatingField id="pb-cat-desc" label="Description" textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} />
                    </div>
                </DialogBody>
                <DialogPanelFooter>
                    <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button type="button" onClick={save} disabled={!canSave || busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : (cat ? 'Save changes' : 'Add category')}</Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─────────────────────────── shared bits ───────────────────────────
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
    return (
        <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--blanc-line)' }}>
            <table className="w-full text-sm">
                <thead><tr style={{ background: 'rgba(117,106,89,0.04)' }}>{head.map((h, i) => <th key={i} className="text-left px-3 py-2 font-medium" style={{ color: 'var(--blanc-ink-2)' }}>{h}</th>)}</tr></thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}
const Td = ({ children, muted }: { children: React.ReactNode; muted?: boolean }) => <td className="px-3 py-2" style={muted ? { color: 'var(--blanc-ink-3)' } : undefined}>{children}</td>;
function RowActions({ onEdit, onArchive }: { onEdit: () => void; onArchive: () => void }) {
    return (
        <div className="flex items-center gap-2 justify-end">
            <button type="button" onClick={onEdit} aria-label="Edit" style={{ color: 'var(--blanc-ink-3)' }}><Pencil size={15} /></button>
            <button type="button" onClick={onArchive} aria-label="Archive" style={{ color: 'var(--blanc-ink-3)' }}><Archive size={15} /></button>
        </div>
    );
}
const Spinner = () => <div className="flex justify-center py-10"><Loader2 className="animate-spin" style={{ color: 'var(--blanc-ink-3)' }} /></div>;
const Empty = ({ label }: { label: string }) => <div className="text-center py-10 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>{label}</div>;
