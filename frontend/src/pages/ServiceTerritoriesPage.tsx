import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../services/apiClient';
import { AlertTriangle, Plus, Upload, Download, Trash2, Loader2, Search, ChevronUp, ChevronDown, MapPin, ArrowLeft, LayoutGrid, List, Users } from 'lucide-react';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { FloatingField } from '../components/ui/floating-field';
import { FloatingSelect } from '../components/ui/floating-select';
import { SelectItem } from '../components/ui/select';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { TerritoryCoverageMap } from '../components/settings/TerritoryCoverageMap';
import { TerritoryTechnicianPanel, type TerritoryAssignmentTarget } from '../components/settings/TerritoryTechnicianPanel';
import {
    serviceTerritoryAssignmentsApi,
    wildcardTechniciansForMode,
    type ServiceTerritoryAssignmentState,
} from '../services/serviceTerritoryAssignmentsApi';
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

type TerritoryMode = 'list' | 'radius';

interface TerritoryRadius {
    id: string;
    zip: string;
    radius_miles: number;
    lat: number;
    lon: number;
    position: number;
    city: string | null;
    state: string | null;
}

interface TerritoryConfig {
    active_mode: TerritoryMode;
    radii: TerritoryRadius[];
    counts: { list_zips: number; radii: number };
    company_zip: string | null;
    list_centroids: { zip: string; lat: number; lon: number }[];
}

function technicianNames(
    state: ServiceTerritoryAssignmentState | undefined,
    technicianIds: string[],
): string[] {
    if (!state) return [];
    const names = new Map(state.technicians.map(technician => [technician.id, technician.name]));
    return technicianIds.map(id => names.get(id) || id);
}

class ApiRequestError extends Error {
    readonly status: number;
    readonly code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

async function requestError(response: Response, fallback: string): Promise<never> {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    const apiMessage = data?.error;
    throw new ApiRequestError(apiMessage || fallback, response.status, apiMessage);
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

async function fetchTerritoryConfig(): Promise<TerritoryConfig> {
    const r = await authedFetch(`${API}/config`);
    if (!r.ok) return requestError(r, 'Failed to load service territory config');
    const data = await r.json() as { config: TerritoryConfig };
    return {
        ...data.config,
        radii: data.config.radii.map(radius => ({
            ...radius,
            radius_miles: Number(radius.radius_miles),
            lat: Number(radius.lat),
            lon: Number(radius.lon),
            position: Number(radius.position),
        })),
        list_centroids: data.config.list_centroids.map(centroid => ({
            ...centroid,
            lat: Number(centroid.lat),
            lon: Number(centroid.lon),
        })),
    };
}

async function updateTerritoryMode(active_mode: TerritoryMode) {
    const r = await authedFetch(`${API}/mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_mode }),
    });
    if (!r.ok) return requestError(r, 'Failed to update service territory mode');
    return r.json() as Promise<{ config: { active_mode: TerritoryMode } }>;
}

async function addTerritoryRadius(body: { zip: string; radius_miles: number }) {
    const r = await authedFetch(`${API}/radii`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) return requestError(r, 'Failed to add coverage');
    return r.json() as Promise<{ radius: TerritoryRadius }>;
}

async function removeTerritoryRadius(id: string) {
    const r = await authedFetch(`${API}/radii/${id}`, { method: 'DELETE' });
    if (!r.ok) return requestError(r, 'Failed to remove coverage');
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
                        background: view === v ? 'rgba(25,25,25,0.06)' : 'transparent',
                        color: view === v ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-3)',
                    }}
                >
                    <Icon className="size-3.5" />{label}
                </button>
            ))}
        </div>
    );
}

function ModeToggle({ mode, onChange, disabled }: {
    mode: TerritoryMode;
    onChange: (mode: TerritoryMode) => void;
    disabled: boolean;
}) {
    return (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Service territory mode">
            {([['list', 'Districts'], ['radius', 'Radii']] as const).map(([value, label]) => (
                <button
                    key={value}
                    type="button"
                    className="blanc-control-chip disabled:cursor-not-allowed disabled:opacity-50"
                    data-active={mode === value ? '' : undefined}
                    aria-pressed={mode === value}
                    disabled={disabled}
                    onClick={() => onChange(value)}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Area cards grid
// ---------------------------------------------------------------------------
function AreaCardsGrid({ territories, assignments, assignmentDisabled, onSelectArea, onManage }: {
    territories: Territory[];
    assignments?: ServiceTerritoryAssignmentState;
    assignmentDisabled: boolean;
    onSelectArea: (area: string) => void;
    onManage: (target: TerritoryAssignmentTarget) => void;
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
            {areaStats.map(({ area, count, states }) => {
                const districtId = area === '(No area)' ? '' : area;
                const district = assignments?.districts.find(item => item.id === districtId);
                const assignedNames = technicianNames(assignments, district?.technician_ids || []);
                return (
                <div
                    key={area}
                    className="text-left"
                    style={{
                        padding: '16px 18px', borderRadius: 16, cursor: 'pointer',
                        background: 'rgba(25,25,25,0.03)', border: '1px solid var(--blanc-line)',
                        transition: 'border-color 0.15s',
                    }}
                >
                    <button
                        type="button"
                        className="w-full text-left disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={assignmentDisabled}
                        onClick={() => onManage({ mode: 'district', id: districtId, label: area })}
                    >
                        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>{area}</div>
                        <div className="mt-2 flex items-start gap-1.5 text-xs" style={{ color: 'var(--blanc-ink-2)' }}>
                            <Users className="mt-0.5 size-3.5 shrink-0" />
                            <span>{assignedNames.length > 0 ? assignedNames.join(', ') : 'No direct technician assignments'}</span>
                        </div>
                    </button>
                    <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)', marginTop: 4 }}>
                        {count} zip code{count !== 1 ? 's' : ''}
                        {states && <span style={{ marginLeft: 6 }}>{states}</span>}
                    </div>
                    <button
                        type="button"
                        className="mt-3 text-xs font-medium"
                        style={{ color: 'var(--blanc-accent)' }}
                        onClick={() => onSelectArea(districtId)}
                    >
                        View ZIP codes
                    </button>
                </div>
                );
            })}
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
            <div
                className="max-w-full overflow-x-auto rounded-xl"
                style={{ border: '1px solid var(--blanc-line)', WebkitOverflowScrolling: 'touch' }}
            >
                <table className="w-full min-w-[720px]" style={{ fontSize: 13 }}>
                    <thead>
                        <tr style={{ background: 'rgba(25,25,25,0.03)' }}>
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
                            <tr key={row.zip} style={{ borderTop: '1px solid var(--blanc-line)' }} className="hover:bg-[rgba(25,25,25,0.02)]">
                                <td style={{ padding: '8px 14px', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{row.zip}</td>
                                <td style={{ padding: '8px 14px' }}>{row.area || ''}</td>
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

function RadiusPanel({ config, assignments, assignmentDisabled, onManage }: {
    config: TerritoryConfig;
    assignments?: ServiceTerritoryAssignmentState;
    assignmentDisabled: boolean;
    onManage: (target: TerritoryAssignmentTarget) => void;
}) {
    const qc = useQueryClient();
    const [zip, setZip] = useState('');
    const [radiusMiles, setRadiusMiles] = useState('');
    const prefilledZipRef = useRef(false);
    const zipTouchedRef = useRef(false);

    const orderedRadii = useMemo(
        () => [...config.radii].sort((a, b) => a.position - b.position),
        [config.radii],
    );

    useEffect(() => {
        if (prefilledZipRef.current || zipTouchedRef.current || orderedRadii.length > 0 || !config.company_zip) return;
        const companyZip = String(config.company_zip).replace(/\D/g, '').slice(0, 5);
        if (!companyZip) return;
        setZip(companyZip);
        prefilledZipRef.current = true;
    }, [config.company_zip, orderedRadii.length]);

    const addRadiusMut = useMutation({
        mutationFn: addTerritoryRadius,
        onSuccess: () => {
            setZip('');
            setRadiusMiles('');
            toast.success('Coverage added');
            qc.invalidateQueries({ queryKey: ['service-territories-config'] });
        },
        onError: (error: Error) => {
            if (error instanceof ApiRequestError && error.status === 422 && error.code === 'ZIP_NOT_FOUND') {
                toast.error("We couldn't find that ZIP — check the digits and try again.");
                return;
            }
            toast.error(error.message);
        },
    });

    const deleteRadiusMut = useMutation({
        mutationFn: removeTerritoryRadius,
        onSuccess: () => {
            toast.success('Coverage removed');
            qc.invalidateQueries({ queryKey: ['service-territories-config'] });
        },
        onError: (error: Error) => toast.error(error.message),
    });

    const radiusNumber = Number(radiusMiles);
    const canSubmit = zip.length === 5
        && radiusMiles.trim() !== ''
        && Number.isFinite(radiusNumber)
        && radiusNumber > 0
        && radiusNumber <= 200;

    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        if (!canSubmit || addRadiusMut.isPending) return;
        addRadiusMut.mutate({ zip, radius_miles: radiusNumber });
    };

    return (
        <div className="min-w-0 space-y-6">
            {orderedRadii.length === 0 ? (
                <div className="py-12 text-center" style={{ border: '2px dashed var(--blanc-line)', borderRadius: 16 }}>
                    <MapPin className="mx-auto mb-3 size-10 opacity-50" style={{ color: 'var(--blanc-ink-3)' }} />
                    <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--blanc-ink-2)' }}>No coverage yet</div>
                    <div className="mx-auto mt-1 max-w-lg px-4" style={{ fontSize: 13, color: 'var(--blanc-ink-3)' }}>
                        Add your base ZIP and how far you'll drive — that's your service area.
                    </div>
                </div>
            ) : (
                <div className="space-y-3.5">
                    {orderedRadii.map((radius, index) => {
                        const location = [radius.city, radius.state].filter(Boolean).join(', ');
                        const deleting = deleteRadiusMut.isPending && deleteRadiusMut.variables === radius.id;
                        const assignment = assignments?.radii.find(item => item.id === radius.id);
                        const assignedNames = technicianNames(assignments, assignment?.technician_ids || []);
                        return (
                            <div
                                key={radius.id}
                                className="flex min-w-0 items-center gap-3 rounded-xl p-4"
                                style={{ border: '1px solid var(--blanc-line)' }}
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span style={{ fontWeight: 600, color: 'var(--blanc-ink-1)' }}>
                                            {radius.zip} · {radius.radius_miles} mi
                                        </span>
                                        {index === 0 && (
                                            <span
                                                className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                                                style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-accent)' }}
                                            >
                                                Base
                                            </span>
                                        )}
                                    </div>
                                    {location && (
                                        <div className="mt-1 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>{location}</div>
                                    )}
                                    <button
                                        type="button"
                                        className="mt-2 flex items-start gap-1.5 text-left text-xs disabled:cursor-not-allowed disabled:opacity-60"
                                        style={{ color: 'var(--blanc-ink-2)' }}
                                        disabled={assignmentDisabled}
                                        onClick={() => onManage({
                                            mode: 'radius',
                                            id: radius.id,
                                            label: `${radius.zip} · ${radius.radius_miles} mi`,
                                        })}
                                    >
                                        <Users className="mt-0.5 size-3.5 shrink-0" />
                                        <span>{assignedNames.length > 0 ? assignedNames.join(', ') : 'No direct technician assignments'}</span>
                                    </button>
                                </div>
                                <button
                                    type="button"
                                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg disabled:cursor-not-allowed disabled:opacity-50"
                                    style={{ color: 'var(--blanc-ink-3)' }}
                                    aria-label={`Remove coverage for ${radius.zip}`}
                                    title="Remove coverage"
                                    disabled={deleteRadiusMut.isPending}
                                    onClick={() => deleteRadiusMut.mutate(radius.id)}
                                >
                                    {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                <FloatingField
                    id="territory-radius-zip"
                    label="ZIP code"
                    inputMode="numeric"
                    value={zip}
                    onChange={event => {
                        zipTouchedRef.current = true;
                        setZip(event.target.value.replace(/\D/g, '').slice(0, 5));
                    }}
                />
                <FloatingField
                    id="territory-radius-miles"
                    label="Radius (miles)"
                    type="number"
                    inputMode="decimal"
                    value={radiusMiles}
                    onChange={event => setRadiusMiles(event.target.value)}
                />
                <Button type="submit" className="h-[50px] w-full sm:w-auto" disabled={!canSubmit || addRadiusMut.isPending}>
                    {addRadiusMut.isPending ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Plus className="mr-1.5 size-4" />}
                    Add coverage
                </Button>
            </form>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const ServiceTerritoriesPage: React.FC = () => {
    const qc = useQueryClient();
    const { data: territories = [], isLoading } = useQuery({ queryKey: ['service-territories'], queryFn: fetchTerritories });
    const { data: areas = [] } = useQuery({ queryKey: ['service-territories-areas'], queryFn: fetchAreas });
    const configQuery = useQuery({ queryKey: ['service-territories-config'], queryFn: fetchTerritoryConfig });
    const assignmentQuery = useQuery({
        queryKey: ['service-territory-assignments'],
        queryFn: serviceTerritoryAssignmentsApi.get,
        retry: false,
    });
    const config = configQuery.data;
    const activeMode = config?.active_mode ?? 'list';
    const assignmentState = assignmentQuery.data;
    const assignmentDisabled = assignmentQuery.isLoading || Boolean(assignmentQuery.error);
    const wildcardTechnicians = useMemo(
        () => assignmentState ? wildcardTechniciansForMode(assignmentState, activeMode) : [],
        [assignmentState, activeMode],
    );
    const configErrorToastRef = useRef(false);

    useEffect(() => {
        if (configQuery.error && !configErrorToastRef.current) {
            toast.error(configQuery.error.message);
            configErrorToastRef.current = true;
        } else if (!configQuery.error) {
            configErrorToastRef.current = false;
        }
    }, [configQuery.error]);

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
    const [assignmentTarget, setAssignmentTarget] = useState<TerritoryAssignmentTarget | null>(null);
    const selectedTechnicianIds = useMemo(() => {
        if (!assignmentTarget || !assignmentState) return [];
        return assignmentTarget.mode === 'district'
            ? assignmentState.districts.find(item => item.id === assignmentTarget.id)?.technician_ids || []
            : assignmentState.radii.find(item => item.id === assignmentTarget.id)?.technician_ids || [];
    }, [assignmentTarget, assignmentState]);

    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ['service-territories'] });
        qc.invalidateQueries({ queryKey: ['service-territories-areas'] });
        qc.invalidateQueries({ queryKey: ['service-territories-config'] });
        qc.invalidateQueries({ queryKey: ['service-territory-assignments'] });
    };

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
    const modeMut = useMutation({
        mutationFn: updateTerritoryMode,
        onMutate: async (nextMode) => {
            await qc.cancelQueries({ queryKey: ['service-territories-config'] });
            const previous = qc.getQueryData<TerritoryConfig>(['service-territories-config']);
            qc.setQueryData<TerritoryConfig>(['service-territories-config'], current => (
                current ? { ...current, active_mode: nextMode } : current
            ));
            return { previous };
        },
        onError: (error: Error, _nextMode, context) => {
            if (context?.previous) {
                qc.setQueryData(['service-territories-config'], context.previous);
            }
            toast.error(error.message);
        },
        onSettled: () => {
            qc.invalidateQueries({ queryKey: ['service-territories-config'] });
            qc.invalidateQueries({ queryKey: ['service-territory-assignments'] });
        },
    });

    const handleSelectArea = (area: string) => { setActiveArea(area); };
    const handleBackToAreas = () => { setActiveArea(null); };
    const handleModeChange = (mode: TerritoryMode) => {
        if (mode !== activeMode && !modeMut.isPending) modeMut.mutate(mode);
    };

    return (
        <SettingsPageShell
            title="Service Territories"
            description="Tell Albusto where you work — by ZIP-code districts or by radii around your bases."
        >
            <div className="min-w-0 space-y-6">
                <div className="space-y-3.5">
                    <ModeToggle
                        mode={activeMode}
                        onChange={handleModeChange}
                        disabled={!config || configQuery.isLoading || modeMut.isPending}
                    />
                    <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                        Both setups are saved — switching modes never erases anything.
                    </p>
                </div>

                {assignmentQuery.isLoading ? (
                    <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                        <Loader2 className="size-4 animate-spin" /> Loading technician assignments…
                    </div>
                ) : assignmentQuery.error ? (
                    <div
                        role="alert"
                        className="flex gap-2 rounded-xl px-3.5 py-3 text-sm"
                        style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-ink-1)' }}
                    >
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>
                            The active technician roster could not be loaded. Assignment editing is disabled, and wildcard notices are not hidden as though everyone were assigned.
                        </span>
                    </div>
                ) : (
                    <div className="space-y-3" aria-label="Wildcard technician notices">
                        {wildcardTechnicians.map(technician => (
                            <div
                                key={technician.id}
                                role="status"
                                data-wildcard-technician={technician.id}
                                className="flex gap-2 rounded-xl px-3.5 py-3 text-sm"
                                style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-ink-1)' }}
                            >
                                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                                <span>
                                    <strong>{technician.name}</strong> has no {activeMode === 'radius' ? 'radius' : 'district'} assignments and will receive requests from all {activeMode === 'radius' ? 'radii' : 'districts'} by default.
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                {activeMode === 'list' ? (
                    <div className="min-w-0 space-y-4">
                        <div className="flex flex-wrap gap-2">
                            <Button variant="outline" size="sm" className="min-h-9" onClick={() => setImportOpen(true)}>
                                <Upload className="mr-1.5 size-3.5" />Import CSV
                            </Button>
                            <Button variant="outline" size="sm" className="min-h-9" onClick={() => exportCsv()} disabled={territories.length === 0}>
                                <Download className="mr-1.5 size-3.5" />Export
                            </Button>
                            <Button size="sm" className="min-h-9" onClick={() => setAddOpen(true)}>
                                <Plus className="mr-1.5 size-3.5" />Add Zip Code
                            </Button>
                        </div>

                        {/* Stats + view toggle */}
                        <div className="flex flex-wrap items-center gap-4">
                            <div style={{ fontSize: 13, color: 'var(--blanc-ink-3)' }}>
                                Total: <strong style={{ color: 'var(--blanc-ink-1)' }}>{territories.length}</strong> zip codes in <strong style={{ color: 'var(--blanc-ink-1)' }}>{uniqueAreas}</strong> areas
                            </div>
                            <ViewToggle view={activeArea !== null ? 'areas' : view} onChange={v => { if (v === 'areas') setActiveArea(null); setView(v); }} />
                        </div>

                        {/* Breadcrumb when inside an area */}
                        {activeArea !== null && (
                            <div className="flex flex-wrap items-center gap-2">
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
                            <div className="py-16 text-center" style={{ border: '2px dashed var(--blanc-line)', borderRadius: 16 }}>
                                <MapPin className="mx-auto mb-3 size-10" style={{ color: 'var(--blanc-ink-3)', opacity: 0.5 }} />
                                <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--blanc-ink-2)' }}>No zip codes yet</div>
                                <div style={{ fontSize: 13, color: 'var(--blanc-ink-3)', marginTop: 4 }}>Add zip codes manually or import from a CSV file.</div>
                            </div>
                        ) : activeArea !== null ? (
                            <ZipTable rows={areaRows} onRemove={zip => removeMut.mutate(zip)} removing={removeMut.isPending} />
                        ) : view === 'areas' ? (
                            <AreaCardsGrid
                                territories={territories}
                                assignments={assignmentState}
                                assignmentDisabled={assignmentDisabled}
                                onSelectArea={handleSelectArea}
                                onManage={setAssignmentTarget}
                            />
                        ) : (
                            <ZipTable rows={territories} onRemove={zip => removeMut.mutate(zip)} removing={removeMut.isPending} />
                        )}
                    </div>
                ) : config ? (
                    <RadiusPanel
                        config={config}
                        assignments={assignmentState}
                        assignmentDisabled={assignmentDisabled}
                        onManage={setAssignmentTarget}
                    />
                ) : (
                    <div className="flex items-center justify-center py-16">
                        <Loader2 className="size-6 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
                    </div>
                )}

                {config && (
                    <TerritoryCoverageMap
                        mode={activeMode}
                        radii={config.radii}
                        listCentroids={config.list_centroids}
                    />
                )}
            </div>

            {/* Add dialog — pre-fill area when inside an area */}
            <AddZipDialog open={addOpen} onOpenChange={setAddOpen} areas={areas} onAdd={addMut.mutate} isPending={addMut.isPending} defaultArea={activeArea} />

            {/* Import dialog */}
            <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImport={importMut.mutate} isPending={importMut.isPending} />

            <TerritoryTechnicianPanel
                open={assignmentTarget !== null}
                target={assignmentTarget}
                technicians={assignmentState?.technicians || []}
                selectedIds={selectedTechnicianIds}
                onClose={() => setAssignmentTarget(null)}
                onSaved={state => qc.setQueryData(['service-territory-assignments'], state)}
            />
        </SettingsPageShell>
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
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Add zip code
                    </DialogTitle>
                    <DialogDescription className="sr-only">Add a new zip code to your service territory.</DialogDescription>
                </DialogPanelHeader>

                <form onSubmit={handleSubmit} className="contents">
                    <DialogBody className="md:px-8 md:py-7">
                        <div className="mx-auto w-full max-w-[740px] space-y-6">
                            <div className="space-y-3.5">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                    <FloatingField
                                        id="azd-zip"
                                        label="ZIP code"
                                        inputMode="numeric"
                                        value={zip}
                                        onChange={e => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
                                    />
                                    <FloatingSelect id="azd-area" label="Area" value={area} onValueChange={setArea}>
                                        {areas.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                                        <SelectItem value="__new__">+ Create new area</SelectItem>
                                    </FloatingSelect>
                                </div>
                                {area === '__new__' && (
                                    <FloatingField id="azd-new-area" label="New area name" value={newArea} onChange={e => setNewArea(e.target.value)} />
                                )}
                                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-[2fr_104px_1fr]">
                                    <FloatingField id="azd-city" label="City" value={city} onChange={e => setCity(e.target.value)} />
                                    <FloatingSelect id="azd-state" label="State" value={state} onValueChange={setState}>
                                        {US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                                    </FloatingSelect>
                                    <FloatingField id="azd-county" label="County" value={county} onChange={e => setCounty(e.target.value)} />
                                </div>
                            </div>
                        </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                        <Button type="submit" disabled={isPending || zip.length !== 5 || (!area || (area === '__new__' && !newArea.trim()))}>
                            {isPending ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" />Adding...</> : 'Add'}
                        </Button>
                    </DialogPanelFooter>
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
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Import from CSV
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        Upload a CSV file with columns: ZIP, Area, City, State, County. This will replace all existing zip codes.
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                            Upload a CSV file with columns: ZIP, Area, City, State, County. This will replace all existing zip codes.
                        </p>
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".csv,.txt"
                            onChange={handleFile}
                            className="max-w-full text-sm"
                        />
                        {error && <div className="text-sm" style={{ color: 'var(--blanc-danger)' }}>{error}</div>}
                        {parsed && (
                            <div className="text-sm" style={{ color: 'var(--blanc-ink-2)', padding: '10px 14px', borderRadius: 10, background: 'rgba(25,25,25,0.03)' }}>
                                Found <strong>{parsed.length}</strong> zip codes.
                                {parsed.filter(r => r.area).length > 0 && <> In <strong>{new Set(parsed.filter(r => r.area).map(r => r.area)).size}</strong> areas.</>}
                                <div className="mt-1" style={{ color: 'var(--blanc-warning)', fontSize: 12 }}>This will replace all existing zip codes for your company.</div>
                            </div>
                        )}
                    </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={handleImport} disabled={!parsed || isPending}>
                        {isPending ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" />Importing...</> : `Import ${parsed?.length || 0} zip codes`}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

export default ServiceTerritoriesPage;
