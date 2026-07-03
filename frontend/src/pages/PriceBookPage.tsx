/**
 * PriceBookPage — PRICEBOOK-001. Settings → Price Book.
 * Three tabs: Items / Groups / Categories. Manage the catalog that feeds
 * estimate & invoice line items. A Group expands into its Items when added to a
 * document (handled in the estimate/invoice pickers, not here).
 *
 * Editors follow the canonical right-side slide-over "layer" (variant="panel" +
 * floating-label fields) — see CLAUDE.md "Layers & overlays" + docs/specs/FORM-CANON.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Button } from '../components/ui/button';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { FloatingField } from '../components/ui/floating-field';
import { FloatingSelect } from '../components/ui/floating-select';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select';
import { Checkbox } from '../components/ui/checkbox';
import { toast } from 'sonner';
import { Plus, Pencil, Archive, Trash2, Loader2, Upload, Download, FileDown, CheckCircle2, RotateCcw } from 'lucide-react';
import * as api from '../services/priceBookApi';
import type { PriceBookCategory, PriceBookItem, PriceBookGroup, GroupItemInput, ImportSummary, BulkItemsPayload } from '../services/priceBookApi';

const money = (n: number | null | undefined) => `$${(Number(n) || 0).toFixed(2)}`;

export default function PriceBookPage() {
    const [categories, setCategories] = useState<PriceBookCategory[]>([]);
    const [version, setVersion] = useState(0);          // bump to force tab re-fetch (after import)
    const [ioOpen, setIoOpen] = useState(false);
    const [tab, setTab] = useState('items');
    // Items tab reports its dirty state up here so tab-switching can guard it.
    const itemsDirtyRef = useRef(false);
    const loadCategories = useCallback(async () => { try { setCategories(await api.listCategories()); } catch { /* */ } }, []);
    useEffect(() => { loadCategories(); }, [loadCategories, version]);
    const refreshAll = () => { setVersion(v => v + 1); loadCategories(); };

    const changeTab = (next: string) => {
        if (next === tab) return;
        if (tab === 'items' && itemsDirtyRef.current && !window.confirm('Discard unsaved changes?')) return;
        setTab(next);
    };

    return (
        <SettingsPageShell
            title="Price Book"
            description="Manage items, groups & categories for estimates and invoices"
            actions={
                <>
                    <Button variant="ghost" onClick={() => setIoOpen(true)}><Upload size={16} /> Import</Button>
                    <Button variant="ghost" onClick={() => setIoOpen(true)}><Download size={16} /> Export</Button>
                </>
            }
        >
            <Tabs value={tab} onValueChange={changeTab}>
                <TabsList>
                    <TabsTrigger value="items">Items &amp; products</TabsTrigger>
                    <TabsTrigger value="groups">Item groups</TabsTrigger>
                    <TabsTrigger value="categories">Item categories</TabsTrigger>
                </TabsList>
                <TabsContent value="items"><ItemsTab categories={categories} version={version} dirtyRef={itemsDirtyRef} /></TabsContent>
                <TabsContent value="groups"><GroupsTab categories={categories} version={version} /></TabsContent>
                <TabsContent value="categories"><CategoriesTab onChanged={loadCategories} version={version} /></TabsContent>
            </Tabs>
            <ImportExportPanel open={ioOpen} onClose={() => setIoOpen(false)} onImported={refreshAll} />
        </SettingsPageShell>
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

// ─────────────────────────── Items (spreadsheet grid) ───────────────────────────
type RowStatus = 'pristine' | 'new' | 'edited' | 'deleted';
interface RowDraft {
    key: string;
    id: number | null;
    name: string;
    description: string;
    code: string;
    unit: string;
    default_unit_price: string;
    default_taxable: boolean;
    category_id: string;   // '' = uncategorized
    status: RowStatus;
}

const rowFromItem = (it: PriceBookItem): RowDraft => ({
    key: `row-${it.id}`,
    id: it.id,
    name: it.name || '',
    description: it.description || '',
    code: it.code || '',
    unit: it.unit || '',
    default_unit_price: it.default_unit_price != null ? String(it.default_unit_price) : '',
    default_taxable: it.default_taxable ?? false,
    category_id: it.category_id != null ? String(it.category_id) : '',
    status: 'pristine',
});

// A `new` row with everything blank is dropped at save (mirrors server).
const isBlankNewRow = (r: RowDraft) =>
    !r.name.trim() && !r.description.trim() && !r.code.trim() && !r.unit.trim() &&
    !r.default_unit_price.trim() && r.category_id === '' && !r.default_taxable;

// Opt grid inputs out of browser autofill / password-manager injection, which
// otherwise writes into the first row's Name cell on load and falsely dirties it.
const NO_AUTOFILL = { autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'off', spellCheck: false, 'data-1p-ignore': true, 'data-lpignore': 'true', 'data-form-type': 'other' } as const;

// Description cell: single line at rest; on focus expands to ≥3 lines (grows to fit
// content) and collapses back on blur.
function DescriptionCell({ className, style, value, disabled, onChange }: {
    className: string; style?: React.CSSProperties; value: string; disabled?: boolean;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const [focused, setFocused] = useState(false);
    const grow = () => {
        const el = ref.current; if (!el) return;
        el.style.height = 'auto';
        const cs = getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight) || 20;
        const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        el.style.height = `${Math.max(el.scrollHeight, lh * 3 + pad)}px`;
    };
    return (
        <textarea
            ref={ref}
            className={`${className} resize-none`}
            style={{ ...style, overflow: 'hidden' }}
            rows={1}
            value={value}
            disabled={disabled}
            onFocus={() => { setFocused(true); grow(); }}
            onBlur={() => { setFocused(false); const el = ref.current; if (el) el.style.height = ''; }}
            onChange={(e) => { onChange(e); if (focused) grow(); }}
            {...NO_AUTOFILL}
        />
    );
}

// Validation-error cell key: `${scope}:${index}:${field}`.
type CellErrors = Record<string, string>;

function ItemsTab({ categories, version, dirtyRef }: { categories: PriceBookCategory[]; version: number; dirtyRef: React.MutableRefObject<boolean> }) {
    const [rows, setRows] = useState<RowDraft[]>([]);
    const [loaded, setLoaded] = useState<RowDraft[]>([]);   // snapshot for Discard
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [cellErrors, setCellErrors] = useState<CellErrors>({});
    const tmpSeq = useRef(0);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const items = await api.listItems({ limit: 500 });
            const next = items.map(rowFromItem);
            setRows(next);
            setLoaded(next);
            setCellErrors({});
        } catch { toast.error('Failed to load items'); }
        finally { setLoading(false); }
    }, []);
    useEffect(() => { load(); }, [load, version]);

    const dirty = rows.some(r => r.status !== 'pristine');

    // Report dirty state up (tab-switch guard) + guard browser navigation while dirty.
    useEffect(() => { dirtyRef.current = dirty; }, [dirty, dirtyRef]);
    useEffect(() => {
        if (!dirty) return;
        const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [dirty]);
    useEffect(() => () => { dirtyRef.current = false; }, [dirtyRef]);

    // Edit a field on a row — pristine → edited, new stays new, deleted untouched.
    const editRow = (key: string, patch: Partial<RowDraft>) => {
        setRows(prev => prev.map(r => {
            if (r.key !== key) return r;
            const status: RowStatus = r.status === 'new' ? 'new' : r.status === 'deleted' ? 'deleted' : 'edited';
            return { ...r, ...patch, status };
        }));
    };

    const removeRow = (r: RowDraft) => {
        if (r.id == null) setRows(prev => prev.filter(x => x.key !== r.key));   // new → drop
        else setRows(prev => prev.map(x => x.key === r.key ? { ...x, status: 'deleted' } : x));
    };
    const undoRemove = (r: RowDraft) => {
        // Restore to edited if it differs from the loaded snapshot, else pristine.
        const orig = loaded.find(x => x.key === r.key);
        setRows(prev => prev.map(x => x.key === r.key
            ? { ...x, status: orig && sameRow(orig, x) ? 'pristine' : 'edited' }
            : x));
    };

    const addRow = () => {
        tmpSeq.current += 1;
        const key = `tmp-${tmpSeq.current}`;
        setRows(prev => [...prev, {
            key, id: null, name: '', description: '', code: '', unit: '',
            default_unit_price: '', default_taxable: false, category_id: '', status: 'new',
        }]);
    };

    const discard = () => { setRows(loaded.map(r => ({ ...r }))); setCellErrors({}); };

    const save = async () => {
        setSaving(true);
        setCellErrors({});
        const creates: BulkItemsPayload['creates'] = [];
        const updates: BulkItemsPayload['updates'] = [];
        const deletes: number[] = [];
        for (const r of rows) {
            if (r.status === 'deleted') { if (r.id != null) deletes.push(r.id); continue; }
            if (r.status === 'new') {
                if (isBlankNewRow(r)) continue;   // drop empty new rows
                creates.push({
                    clientKey: r.key, name: r.name.trim(), description: r.description.trim() || null,
                    code: r.code.trim() || null, unit: r.unit.trim() || null,
                    default_unit_price: Number(r.default_unit_price) || 0, default_taxable: r.default_taxable,
                    category_id: r.category_id ? Number(r.category_id) : null,
                });
            } else if (r.status === 'edited' && r.id != null) {
                updates.push({
                    id: r.id, name: r.name.trim(), description: r.description.trim() || null,
                    code: r.code.trim() || null, unit: r.unit.trim() || null,
                    default_unit_price: Number(r.default_unit_price) || 0, default_taxable: r.default_taxable,
                    category_id: r.category_id ? Number(r.category_id) : null,
                });
            }
        }
        try {
            const res = await api.bulkSaveItems({ creates, updates, deletes });
            const next = res.items.map(rowFromItem);
            setRows(next);
            setLoaded(next);
            const { created, updated, deleted } = res.summary;
            toast.success(`Saved: ${created} added · ${updated} updated · ${deleted} archived`);
        } catch (e) {
            const err = e as Error & { status?: number };
            const body = parseValidation(err.message);
            if (err.status === 422 && body) {
                const errs: CellErrors = {};
                for (const d of body.details) errs[`${d.scope}:${d.index}:${d.field}`] = d.error;
                setCellErrors(errs);
                toast.error(body.message || 'Some rows have errors — check the highlighted cells');
            } else {
                toast.error('Save failed');
            }
        } finally { setSaving(false); }
    };

    // Map the offending-cell key back to a row key for red-border rendering.
    const errKeyFor = (r: RowDraft): CellErrors => {
        if (Object.keys(cellErrors).length === 0) return {};
        // Rebuild the same partition indexing used in save().
        let ci = 0, ui = 0;
        const out: CellErrors = {};
        for (const row of rows) {
            if (row.status === 'deleted') continue;
            if (row.status === 'new') {
                if (isBlankNewRow(row)) continue;
                if (row.key === r.key) { for (const k in cellErrors) { const [s, i, f] = k.split(':'); if (s === 'creates' && Number(i) === ci) out[f] = cellErrors[k]; } }
                ci += 1;
            } else if (row.status === 'edited') {
                if (row.key === r.key) { for (const k in cellErrors) { const [s, i, f] = k.split(':'); if (s === 'updates' && Number(i) === ui) out[f] = cellErrors[k]; } }
                ui += 1;
            }
        }
        return out;
    };

    const q = search.trim().toLowerCase();
    const visible = q
        ? rows.filter(r => r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
        : rows;

    const inputBase = 'w-full rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[var(--blanc-ink-3)]';
    const noAutofill = NO_AUTOFILL;

    return (
        <div className="mt-4">
            <div className="flex items-center gap-2 mb-3">
                <Input placeholder="Search items…" autoComplete="off" value={search} onChange={e => setSearch(e.target.value)} className="max-w-xs" />
                <div className="flex-1" />
                <Button variant="ghost" onClick={discard} disabled={!dirty || saving}>Discard</Button>
                <Button onClick={save} disabled={!dirty || saving}>{saving ? <Loader2 size={16} className="animate-spin" /> : 'Save changes'}</Button>
            </div>
            {loading ? <Spinner /> : (
                <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--blanc-line)' }}>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm" style={{ minWidth: 920 }}>
                            <thead>
                                <tr style={{ background: 'rgba(117,106,89,0.04)' }}>
                                    {['Name', 'Description', 'Code / SKU', 'Unit', 'Unit price', 'Taxable', 'Category', ''].map((h, i) => (
                                        <th key={i} className="text-left px-3 py-2 font-medium" style={{ color: 'var(--blanc-ink-2)' }}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {visible.length === 0 ? (
                                    <tr><td colSpan={8} className="text-center py-10 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>{q ? 'No matching items' : 'No items yet'}</td></tr>
                                ) : visible.map(r => {
                                    const deleted = r.status === 'deleted';
                                    const errs = errKeyFor(r);
                                    const nameMissing = !deleted && !r.name.trim();
                                    const cell = (field: string, bad?: boolean) =>
                                        `${inputBase} ${errs[field] || bad ? 'border-[var(--blanc-danger,#d44d3c)]' : 'border-[var(--blanc-line)]'}`;
                                    const struck = deleted ? { textDecoration: 'line-through', opacity: 0.5 } as React.CSSProperties : undefined;
                                    return (
                                        <tr key={r.key} className="border-t align-top" style={{ borderColor: 'var(--blanc-line)' }}>
                                            <td className="px-2 py-1.5" style={{ minWidth: 180 }}>
                                                <input className={cell('name', nameMissing)} style={struck} value={r.name} disabled={deleted} placeholder="Name" onChange={e => editRow(r.key, { name: e.target.value })} {...noAutofill} />
                                            </td>
                                            <td className="px-2 py-1.5" style={{ minWidth: 200 }}>
                                                <DescriptionCell className={cell('description')} style={struck} value={r.description} disabled={deleted} onChange={e => editRow(r.key, { description: e.target.value })} />
                                            </td>
                                            <td className="px-2 py-1.5" style={{ minWidth: 120 }}>
                                                <input className={cell('code')} style={struck} value={r.code} disabled={deleted} onChange={e => editRow(r.key, { code: e.target.value })} {...noAutofill} />
                                            </td>
                                            <td className="px-2 py-1.5" style={{ minWidth: 80 }}>
                                                <input className={cell('unit')} style={struck} value={r.unit} disabled={deleted} onChange={e => editRow(r.key, { unit: e.target.value })} {...noAutofill} />
                                            </td>
                                            <td className="px-2 py-1.5" style={{ minWidth: 100 }}>
                                                <input className={`${cell('default_unit_price')} text-right`} style={struck} inputMode="decimal" value={r.default_unit_price} disabled={deleted} onChange={e => editRow(r.key, { default_unit_price: e.target.value })} {...noAutofill} />
                                            </td>
                                            <td className="px-2 py-1.5 text-center">
                                                <Checkbox checked={r.default_taxable} disabled={deleted} onCheckedChange={c => editRow(r.key, { default_taxable: !!c })} />
                                            </td>
                                            <td className="px-2 py-1.5" style={{ minWidth: 150 }}>
                                                <Select value={r.category_id || 'none'} disabled={deleted} onValueChange={v => editRow(r.key, { category_id: v === 'none' ? '' : v })}>
                                                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="none">Uncategorized</SelectItem>
                                                        {categories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                                                    </SelectContent>
                                                </Select>
                                            </td>
                                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                                                {deleted
                                                    ? <button type="button" onClick={() => undoRemove(r)} aria-label="Undo remove" style={{ color: 'var(--blanc-ink-3)' }}><RotateCcw size={15} /></button>
                                                    : <button type="button" onClick={() => removeRow(r)} aria-label="Remove item" style={{ color: 'var(--blanc-ink-3)' }}><Trash2 size={15} /></button>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <button type="button" onClick={addRow} className="flex w-full items-center justify-center gap-1.5 px-3 py-2.5 text-sm border-t" style={{ borderColor: 'var(--blanc-line)', color: 'var(--blanc-ink-2)', background: 'rgba(117,106,89,0.02)' }}>
                        <Plus size={15} /> Add row
                    </button>
                </div>
            )}
        </div>
    );
}

// Two drafts equal on the persisted fields (for undo → pristine detection).
function sameRow(a: RowDraft, b: RowDraft) {
    return a.name === b.name && a.description === b.description && a.code === b.code &&
        a.unit === b.unit && a.default_unit_price === b.default_unit_price &&
        a.default_taxable === b.default_taxable && a.category_id === b.category_id;
}

interface ValidationBody { message: string; details: { scope: 'creates' | 'updates'; index: number; field: string; error: string }[]; }
// bulkSaveItems throws Error(`Request failed: 422 {json}`) — pull the JSON tail out.
function parseValidation(msg: string): ValidationBody | null {
    const i = msg.indexOf('{');
    if (i < 0) return null;
    try {
        const body = JSON.parse(msg.slice(i)) as { error?: string; message?: string; details?: ValidationBody['details'] };
        if (body.error !== 'validation_failed' || !Array.isArray(body.details)) return null;
        return { message: body.message || '', details: body.details };
    } catch { return null; }
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
