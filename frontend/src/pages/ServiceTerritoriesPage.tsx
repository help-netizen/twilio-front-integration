import React, { useState, useMemo, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../services/apiClient';
import { Plus, Upload, Download, Trash2, Loader2, Search, ChevronUp, ChevronDown, MapPin, ArrowLeft, LayoutGrid, List } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
const API = '/api/settings/service-territories';

interface Territory {
    zip: string;
    area: string;
    city: string | null;
    state: string | null;
    county: string | null;
    created_at: string;
}

async function fetchTerritories(): Promise<Territory[]> {
    const r = await authedFetch(API);
    if (!r.ok) throw new Error('Failed to load');
    const data = await r.json();
    return data.territories;
}

async function fetchAreas(): Promise<string[]> {
    const r = await authedFetch(`${API}/areas`);
    if (!r.ok) throw new Error('Failed to load areas');
    const data = await r.json();
    return data.areas;
}

async function addZipCode(body: { zip: string; area: string; city?: string; state?: string; county?: string }) {
    const r = await authedFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (r.status === 409) throw new Error('Zip code already exists');
    if (!r.ok) throw new Error('Failed to add');
    return r.json();
}

async function removeZipCode(zip: string) {
    const r = await authedFetch(`${API}/${zip}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('Failed to remove');
}

async function bulkImport(rows: Record<string, string>[]) {
    const r = await authedFetch(`${API}/bulk-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
    });
    if (!r.ok) throw new Error('Failed to import');
    return r.json();
}

async function exportCsv() {
    const r = await authedFetch(`${API}/export`);
    if (!r.ok) throw new Error('Failed to export');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'service-territories.csv';
    a.click();
    URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// CSV parser (simple, no dep)
// ---------------------------------------------------------------------------
function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let i = 0;
    while (i <= line.length) {
        if (i === line.length) { result.push(''); break; }
        if (line[i] === '"') {
            let val = '';
            i++; // skip opening quote
            while (i < line.length) {
                if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
                else if (line[i] === '"') { i++; break; }
                else { val += line[i]; i++; }
            }
            result.push(val);
            if (line[i] === ',') i++; // skip comma after closing quote
        } else {
            const next = line.indexOf(',', i);
            if (next === -1) { result.push(line.slice(i)); break; }
            result.push(line.slice(i, next));
            i = next + 1;
        }
    }
    return result;
}

function parseCsvText(text: string): Record<string, string>[] {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
    return lines.slice(1).map(line => {
        const vals = parseCsvLine(line);
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => {
            obj[h] = (vals[i] || '').trim();
        });
        return obj;
    });
}

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------
type SortKey = 'zip' | 'area' | 'city' | 'state' | 'county';
type SortDir = 'asc' | 'desc';

function SortIcon({ column, sortKey, sortDir }: { column: SortKey; sortKey: SortKey; sortDir: SortDir }) {
    if (column !== sortKey) return <ChevronUp className="size-3 opacity-20" />;
    return sortDir === 'asc' ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />;
}

// ---------------------------------------------------------------------------
// US states for select
// ---------------------------------------------------------------------------
const US_STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
    'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
    'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

// ---------------------------------------------------------------------------
// View toggle button
// ---------------------------------------------------------------------------
function ViewToggle({ view, onChange }: { view: 'areas' | 'table'; onChange: (v: 'areas' | 'table') => void }) {
    return (
        <div className="inline-flex rounded-lg" style={{ border: '1px solid var(--blanc-line)', overflow: 'hidden' }}>
            {([['areas', LayoutGrid, 'By Area'], ['table', List, 'All Zip Codes']] as const).map(([v, Icon, label]) => (
                <button
                    key={v}
                    onClick={() => onChange(v as 'areas' | 'table')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5"
                    style={{
                        fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer',
                        background: view === v ? 'rgba(117,106,89,0.08)' : 'transparent',
                        color: view === v ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-3)',
                    }}
                >
                    <Icon className="size-3.5" />{label}
                </button>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Area cards grid
// ---------------------------------------------------------------------------
function AreaCardsGrid({ territories, onSelectArea }: {
    territories: Territory[];
    onSelectArea: (area: string) => void;
}) {
    const areaStats = useMemo(() => {
        const map = new Map<string, { count: number; states: Set<string> }>();
        for (const t of territories) {
            const area = t.area || '(No area)';
            if (!map.has(area)) map.set(area, { count: 0, states: new Set() });
            const s = map.get(area)!;
            s.count++;
            if (t.state) s.states.add(t.state);
        }
        return [...map.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([area, { count, states }]) => ({ area, count, states: [...states].sort().join(', ') }));
    }, [territories]);

    if (areaStats.length === 0) return null;

    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {areaStats.map(({ area, count, states }) => (
                <button
                    key={area}
                    onClick={() => onSelectArea(area === '(No area)' ? '' : area)}
                    className="text-left"
                    style={{
                        padding: '16px 18px', borderRadius: 16, cursor: 'pointer',
                        background: 'rgba(117,106,89,0.04)', border: '1px solid var(--blanc-line)',
                        transition: 'border-color 0.15s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(117,106,89,0.35)')}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--blanc-line)')}
                >
                    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>{area}</div>
                    <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)', marginTop: 4 }}>
                        {count} zip code{count !== 1 ? 's' : ''}
                        {states && <span style={{ marginLeft: 6 }}>{states}</span>}
                    </div>
                </button>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Zip codes table (reusable)
// ---------------------------------------------------------------------------
function ZipTable({ rows, onRemove, removing }: {
    rows: Territory[];
    onRemove: (zip: string) => void;
    removing: boolean;
}) {
    const [sortKey, setSortKey] = useState<SortKey>('zip');
    const [sortDir, setSortDir] = useState<SortDir>('asc');
    const [zipFilter, setZipFilter] = useState('');

    const toggleSort = (key: SortKey) => {
        if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        else { setSortKey(key); setSortDir('asc'); }
    };

    const sorted = useMemo(() => {
        let r = rows;
        if (zipFilter) r = r.filter(row => row.zip.includes(zipFilter));
        return [...r].sort((a, b) => {
            const av = (a[sortKey] || '') as string;
            const bv = (b[sortKey] || '') as string;
            return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
        });
    }, [rows, zipFilter, sortKey, sortDir]);

    return (
        <>
            <div className="mb-3">
                <div className="relative" style={{ maxWidth: 220 }}>
                    <Search className="absolute left-2.5 top-2.5 size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                    <Input
                        placeholder="Filter by ZIP..."
                        value={zipFilter}
                        onChange={e => setZipFilter(e.target.value)}
                        className="pl-8 h-9"
                        style={{ fontSize: 13 }}
                    />
                </div>
            </div>
            <div style={{ border: '1px solid var(--blanc-line)', borderRadius: 12, overflow: 'hidden' }}>
                <table className="w-full" style={{ fontSize: 13 }}>
                    <thead>
                        <tr style={{ background: 'rgba(117,106,89,0.04)' }}>
                            {([['zip','ZIP'],['area','Area'],['city','City'],['state','State'],['county','County']] as [SortKey, string][]).map(([key, label]) => (
                                <th
                                    key={key}
                                    onClick={() => toggleSort(key)}
                                    className="text-left cursor-pointer select-none"
                                    style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--blanc-ink-2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}
                                >
                                    <span className="inline-flex items-center gap-1">{label}<SortIcon column={key} sortKey={sortKey} sortDir={sortDir} /></span>
                                </th>
                            ))}
                            <th style={{ width: 60, padding: '10px 14px' }} />
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.length === 0 ? (
                            <tr><td colSpan={6} className="text-center py-8" style={{ color: 'var(--blanc-ink-3)' }}>No results</td></tr>
                        ) : sorted.map(row => (
                            <tr key={row.zip} style={{ borderTop: '1px solid var(--blanc-line)' }} className="hover:bg-[rgba(117,106,89,0.02)]">
                                <td style={{ padding: '8px 14px', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{row.zip}</td>
                                <td style={{ padding: '8px 14px' }}>{row.area || <span style={{ color: 'var(--blanc-ink-3)' }}>—</span>}</td>
                                <td style={{ padding: '8px 14px', color: 'var(--blanc-ink-2)' }}>{row.city || ''}</td>
                                <td style={{ padding: '8px 14px', color: 'var(--blanc-ink-2)' }}>{row.state || ''}</td>
                                <td style={{ padding: '8px 14px', color: 'var(--blanc-ink-2)' }}>{row.county || ''}</td>
                                <td style={{ padding: '8px 14px', textAlign: 'right' }}>
                                    <button
                                        onClick={() => onRemove(row.zip)}
                                        disabled={removing}
                                        className="inline-flex items-center justify-center rounded-md"
                                        style={{ width: 28, height: 28, color: 'var(--blanc-ink-3)', cursor: 'pointer', border: 'none', background: 'transparent' }}
                                        title="Remove"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const ServiceTerritoriesPage: React.FC = () => {
    const qc = useQueryClient();
    const { data: territories = [], isLoading } = useQuery({ queryKey: ['service-territories'], queryFn: fetchTerritories });
    const { data: areas = [] } = useQuery({ queryKey: ['service-territories-areas'], queryFn: fetchAreas });

    // View mode
    const [view, setView] = useState<'areas' | 'table'>('areas');
    const [activeArea, setActiveArea] = useState<string | null>(null);

    // Rows for current context
    const areaRows = useMemo(() => {
        if (activeArea === null) return territories;
        return territories.filter(t => (activeArea === '' ? !t.area : t.area === activeArea));
    }, [territories, activeArea]);

    // Stats
    const uniqueAreas = useMemo(() => new Set(territories.map(t => t.area).filter(Boolean)).size, [territories]);

    // Modals
    const [addOpen, setAddOpen] = useState(false);
    const [importOpen, setImportOpen] = useState(false);

    const invalidate = () => { qc.invalidateQueries({ queryKey: ['service-territories'] }); qc.invalidateQueries({ queryKey: ['service-territories-areas'] }); };

    // Mutations
    const addMut = useMutation({
        mutationFn: addZipCode,
        onSuccess: () => { invalidate(); toast.success('Zip code added'); setAddOpen(false); },
        onError: (e: Error) => toast.error(e.message),
    });
    const removeMut = useMutation({
        mutationFn: removeZipCode,
        onSuccess: () => { invalidate(); toast.success('Zip code removed'); },
        onError: () => toast.error('Failed to remove'),
    });
    const importMut = useMutation({
        mutationFn: bulkImport,
        onSuccess: (data) => { invalidate(); toast.success(`Imported ${data.imported} zip codes`); setImportOpen(false); },
        onError: () => toast.error('Import failed'),
    });

    const handleSelectArea = (area: string) => { setActiveArea(area); };
    const handleBackToAreas = () => { setActiveArea(null); };

    return (
        <div className="max-w-5xl mx-auto p-6">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading)' }}>
                    Service Territories
                </h1>
                <p style={{ color: 'var(--blanc-ink-2)', fontSize: 14, marginTop: 4 }}>
                    Manage zip codes your company services, grouped by area.
                </p>
            </div>

            {/* Stats + actions */}
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <div className="flex items-center gap-4">
                    <div style={{ fontSize: 13, color: 'var(--blanc-ink-3)' }}>
                        Total: <strong style={{ color: 'var(--blanc-ink-1)' }}>{territories.length}</strong> zip codes in <strong style={{ color: 'var(--blanc-ink-1)' }}>{uniqueAreas}</strong> areas
                    </div>
                    <ViewToggle view={activeArea !== null ? 'areas' : view} onChange={v => { if (v === 'areas') setActiveArea(null); setView(v); }} />
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                        <Upload className="size-3.5 mr-1.5" />Import CSV
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => exportCsv()} disabled={territories.length === 0}>
                        <Download className="size-3.5 mr-1.5" />Export
                    </Button>
                    <Button size="sm" onClick={() => setAddOpen(true)}>
                        <Plus className="size-3.5 mr-1.5" />Add Zip Code
                    </Button>
                </div>
            </div>

            {/* Breadcrumb when inside an area */}
            {activeArea !== null && (
                <div className="flex items-center gap-2 mb-4">
                    <button
                        onClick={handleBackToAreas}
                        className="inline-flex items-center gap-1.5"
                        style={{ fontSize: 13, color: 'var(--blanc-ink-3)', cursor: 'pointer', border: 'none', background: 'transparent', padding: 0 }}
                    >
                        <ArrowLeft className="size-3.5" />All Areas
                    </button>
                    <span style={{ color: 'var(--blanc-ink-3)', fontSize: 13 }}>/</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--blanc-ink-1)' }}>{activeArea || '(No area)'}</span>
                    <span style={{ fontSize: 12, color: 'var(--blanc-ink-3)', marginLeft: 4 }}>{areaRows.length} zip codes</span>
                </div>
            )}

            {/* Content */}
            {isLoading ? (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="size-6 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
                </div>
            ) : territories.length === 0 ? (
                <div className="text-center py-16" style={{ border: '2px dashed var(--blanc-line)', borderRadius: 16 }}>
                    <MapPin className="size-10 mx-auto mb-3" style={{ color: 'var(--blanc-ink-3)', opacity: 0.5 }} />
                    <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--blanc-ink-2)' }}>No zip codes yet</div>
                    <div style={{ fontSize: 13, color: 'var(--blanc-ink-3)', marginTop: 4 }}>Add zip codes manually or import from a CSV file.</div>
                </div>
            ) : activeArea !== null ? (
                /* Area detail — filtered table */
                <ZipTable rows={areaRows} onRemove={zip => removeMut.mutate(zip)} removing={removeMut.isPending} />
            ) : view === 'areas' ? (
                /* Area cards grid */
                <AreaCardsGrid territories={territories} onSelectArea={handleSelectArea} />
            ) : (
                /* Flat table */
                <ZipTable rows={territories} onRemove={zip => removeMut.mutate(zip)} removing={removeMut.isPending} />
            )}

            {/* Add dialog — pre-fill area when inside an area */}
            <AddZipDialog open={addOpen} onOpenChange={setAddOpen} areas={areas} onAdd={addMut.mutate} isPending={addMut.isPending} defaultArea={activeArea} />

            {/* Import dialog */}
            <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImport={importMut.mutate} isPending={importMut.isPending} />
        </div>
    );
};

// ---------------------------------------------------------------------------
// Add Zip Code Dialog
// ---------------------------------------------------------------------------
function AddZipDialog({ open, onOpenChange, areas, onAdd, isPending, defaultArea }: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    areas: string[];
    onAdd: (body: { zip: string; area: string; city?: string; state?: string; county?: string }) => void;
    isPending: boolean;
    defaultArea?: string | null;
}) {
    const [zip, setZip] = useState('');
    const [area, setArea] = useState(defaultArea || '');
    const [newArea, setNewArea] = useState('');
    const [city, setCity] = useState('');
    const [state, setState] = useState('');
    const [county, setCounty] = useState('');

    const reset = () => { setZip(''); setArea(defaultArea || ''); setNewArea(''); setCity(''); setState(''); setCounty(''); };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const finalArea = area === '__new__' ? newArea.trim() : area;
        if (!zip.trim() || !finalArea) return;
        onAdd({ zip: zip.trim(), area: finalArea, city: city.trim() || undefined, state: state || undefined, county: county.trim() || undefined });
        reset();
    };

    return (
        <Dialog open={open} onOpenChange={v => { if (!v) reset(); onOpenChange(v); }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Add Zip Code</DialogTitle>
                    <DialogDescription>Add a new zip code to your service territory.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-2">
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <Label className="text-xs mb-1.5 block" style={{ color: 'var(--blanc-ink-2)' }}>ZIP Code *</Label>
                            <Input value={zip} onChange={e => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))} placeholder="10001" maxLength={5} required autoFocus />
                        </div>
                        <div>
                            <Label className="text-xs mb-1.5 block" style={{ color: 'var(--blanc-ink-2)' }}>Area *</Label>
                            <select
                                value={area}
                                onChange={e => setArea(e.target.value)}
                                required
                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                            >
                                <option value="">Select area...</option>
                                {areas.map(a => <option key={a} value={a}>{a}</option>)}
                                <option value="__new__">+ Create new area</option>
                            </select>
                        </div>
                    </div>
                    {area === '__new__' && (
                        <div>
                            <Label className="text-xs mb-1.5 block" style={{ color: 'var(--blanc-ink-2)' }}>New Area Name *</Label>
                            <Input value={newArea} onChange={e => setNewArea(e.target.value)} placeholder="e.g. Manhattan" required autoFocus />
                        </div>
                    )}
                    <div className="grid grid-cols-3 gap-3">
                        <div>
                            <Label className="text-xs mb-1.5 block" style={{ color: 'var(--blanc-ink-2)' }}>City</Label>
                            <Input value={city} onChange={e => setCity(e.target.value)} placeholder="New York" />
                        </div>
                        <div>
                            <Label className="text-xs mb-1.5 block" style={{ color: 'var(--blanc-ink-2)' }}>State</Label>
                            <select
                                value={state}
                                onChange={e => setState(e.target.value)}
                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                            >
                                <option value="">—</option>
                                {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                        </div>
                        <div>
                            <Label className="text-xs mb-1.5 block" style={{ color: 'var(--blanc-ink-2)' }}>County</Label>
                            <Input value={county} onChange={e => setCounty(e.target.value)} placeholder="New York" />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                        <Button type="submit" disabled={isPending || zip.length !== 5 || (!area || (area === '__new__' && !newArea.trim()))}>
                            {isPending ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" />Adding...</> : 'Add'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// Import CSV Dialog
// ---------------------------------------------------------------------------
function ImportDialog({ open, onOpenChange, onImport, isPending }: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    onImport: (rows: Record<string, string>[]) => void;
    isPending: boolean;
}) {
    const [parsed, setParsed] = useState<Record<string, string>[] | null>(null);
    const [error, setError] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);

    const reset = useCallback(() => { setParsed(null); setError(''); if (fileRef.current) fileRef.current.value = ''; }, []);

    const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        setError('');
        setParsed(null);
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const rows = parseCsvText(reader.result as string);
                if (rows.length === 0) { setError('No data rows found in CSV'); return; }
                // Map common header variations
                const mapped = rows.map(r => ({
                    zip: r.zip || r['zip code'] || r.zipcode || r['postal code'] || r.postalcode || '',
                    area: r.area || r['service zone'] || r['service_zone'] || r.zone || '',
                    city: r.city || '',
                    state: r.state || '',
                    county: r.county || '',
                })).filter(r => r.zip);
                if (mapped.length === 0) { setError('No valid zip codes found. Ensure CSV has a "ZIP" column.'); return; }
                setParsed(mapped);
            } catch {
                setError('Failed to parse CSV file');
            }
        };
        reader.readAsText(file);
    };

    const handleImport = () => {
        if (!parsed) return;
        onImport(parsed);
        reset();
    };

    return (
        <Dialog open={open} onOpenChange={v => { if (!v) reset(); onOpenChange(v); }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Import from CSV</DialogTitle>
                    <DialogDescription>
                        Upload a CSV file with columns: ZIP, Area, City, State, County. This will replace all existing zip codes.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4 mt-2">
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".csv,.txt"
                        onChange={handleFile}
                        className="text-sm"
                    />
                    {error && <div className="text-sm" style={{ color: '#dc2626' }}>{error}</div>}
                    {parsed && (
                        <div className="text-sm" style={{ color: 'var(--blanc-ink-2)', padding: '10px 14px', borderRadius: 10, background: 'rgba(117,106,89,0.04)' }}>
                            Found <strong>{parsed.length}</strong> zip codes.
                            {parsed.filter(r => r.area).length > 0 && <> In <strong>{new Set(parsed.filter(r => r.area).map(r => r.area)).size}</strong> areas.</>}
                            <div className="mt-1" style={{ color: '#b45309', fontSize: 12 }}>This will replace all existing zip codes for your company.</div>
                        </div>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                        <Button onClick={handleImport} disabled={!parsed || isPending}>
                            {isPending ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" />Importing...</> : `Import ${parsed?.length || 0} zip codes`}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export default ServiceTerritoriesPage;
