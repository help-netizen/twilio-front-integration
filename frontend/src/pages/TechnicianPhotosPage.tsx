import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, CheckCircle2, MapPin, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { techniciansApi, type Technician } from '../services/techniciansApi';
import {
    technicianBaseLocationsApi,
    type TechnicianBaseLocation,
} from '../services/technicianBaseLocationsApi';
import { AddressAutocomplete, EMPTY_ADDRESS, type AddressFields } from '../components/AddressAutocomplete';
import { CompanyBaseAddress, type CompanyBase } from '../components/settings/CompanyBaseAddress';

function initials(name?: string | null) {
    if (!name) return '—';
    return name.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

/** Compose a single-line address string from the autocomplete fields. */
function composeAddress(a: AddressFields): string {
    const street = [a.street, a.apt].filter(Boolean).join(' ');
    const cityState = [a.city, a.state].filter(Boolean).join(', ');
    return [street, cityState, a.zip].filter(Boolean).join(', ').trim();
}

/** Whether a stored base sits at the same point as the company address. */
function sameCoords(a?: CompanyBase | null, b?: { lat: number | null; lng: number | null } | null) {
    if (!a || !b || b.lat == null || b.lng == null) return false;
    return Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;
}

type TechRow = Technician & { base?: TechnicianBaseLocation };

export default function TechnicianPhotosPage() {
    const navigate = useNavigate();
    const [techs, setTechs] = useState<TechRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState<string | null>(null);
    const [editingBase, setEditingBase] = useState<string | null>(null);
    const [savingBase, setSavingBase] = useState<string | null>(null);
    const [baseMode, setBaseMode] = useState<'company' | 'own'>('own');
    const [companyBase, setCompanyBase] = useState<CompanyBase | null>(null);
    const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

    const load = () => {
        setLoading(true);
        Promise.all([
            techniciansApi.list(),
            technicianBaseLocationsApi.list().catch(() => [] as TechnicianBaseLocation[]),
        ])
            .then(([list, bases]) => {
                const byTech = new Map(bases.map(b => [b.tech_id, b]));
                setTechs(list.map(t => ({ ...t, base: byTech.get(t.tech_id) })));
            })
            .catch(e => toast.error(e.message))
            .finally(() => setLoading(false));
    };
    useEffect(load, []);

    const onPick = async (techId: string, file?: File) => {
        if (!file) return;
        setUploading(techId);
        try {
            await techniciansApi.uploadPhoto(techId, file);
            toast.success('Photo updated');
            setTechs(ts => ts.map(t => t.tech_id === techId ? { ...t, has_photo: true } : t));
        } catch (e: any) { toast.error(e.message || 'Upload failed'); }
        finally { setUploading(null); }
    };

    const openEdit = (t: TechRow) => {
        if (editingBase === t.tech_id) { setEditingBase(null); return; }
        setEditingBase(t.tech_id);
        const hasBase = !!t.base?.has_base;
        if (hasBase && sameCoords(companyBase, t.base)) setBaseMode('company');
        else if (hasBase) setBaseMode('own');
        else setBaseMode(companyBase ? 'company' : 'own');
    };

    const applyBase = (techId: string, saved: { lat: number | null; lng: number | null; label: string | null; address: string | null }) => {
        setTechs(ts => ts.map(t => t.tech_id === techId
            ? { ...t, base: { tech_id: techId, name: t.name, lat: saved.lat, lng: saved.lng, label: saved.label, address: saved.address, has_base: true } }
            : t));
        setEditingBase(null);
    };

    const onSelectOwnBase = async (techId: string, fields: AddressFields) => {
        // Only commit once the autocomplete resolves coordinates (real pick).
        if (fields.lat == null || fields.lng == null) return;
        const address = composeAddress(fields);
        setSavingBase(techId);
        try {
            const saved = await technicianBaseLocationsApi.upsert(techId, { lat: fields.lat, lng: fields.lng, address, label: address });
            toast.success('Base location set');
            applyBase(techId, saved);
        } catch (e: any) { toast.error(e.message || 'Failed to save base location'); }
        finally { setSavingBase(null); }
    };

    const onUseCompanyBase = async (techId: string) => {
        if (!companyBase) return;
        setSavingBase(techId);
        try {
            const saved = await technicianBaseLocationsApi.upsert(techId, {
                lat: companyBase.lat, lng: companyBase.lng,
                address: companyBase.address ?? undefined, label: companyBase.address ?? undefined,
            });
            toast.success('Base set to company address');
            applyBase(techId, saved);
        } catch (e: any) { toast.error(e.message || 'Failed to save base location'); }
        finally { setSavingBase(null); }
    };

    const onClearBase = async (techId: string) => {
        setSavingBase(techId);
        try {
            await technicianBaseLocationsApi.remove(techId);
            toast.success('Base location cleared');
            setTechs(ts => ts.map(t => t.tech_id === techId ? { ...t, base: undefined } : t));
            setEditingBase(null);
        } catch (e: any) { toast.error(e.message || 'Failed to clear base location'); }
        finally { setSavingBase(null); }
    };

    const segBtn = (active: boolean, disabled?: boolean): CSSProperties => active
        ? { background: 'var(--blanc-panel-surface, #fffdf9)', color: 'var(--blanc-ink-1)' }
        : { color: 'var(--blanc-ink-3)', opacity: disabled ? 0.5 : 1 };

    return (
        <div className="max-w-2xl mx-auto px-6 py-8" style={{ color: 'var(--blanc-ink-1)' }}>
            <button onClick={() => navigate('/settings/integrations')} className="flex items-center gap-1.5 text-sm mb-6" style={{ color: 'var(--blanc-ink-3)' }}>
                <ArrowLeft className="h-4 w-4" /> Settings
            </button>
            <h2 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading, inherit)' }}>Technicians</h2>
            <p className="text-sm mt-1 mb-5" style={{ color: 'var(--blanc-ink-3)' }}>
                A photo builds trust on the payment page and lifts tips. A base location lets the scheduler suggest the best arrival times.
            </p>

            <div className="mb-6">
                <CompanyBaseAddress
                    title="Company base address"
                    hint="The default base for technicians who match it. Also editable in Settings → Company."
                    onChange={setCompanyBase}
                />
            </div>

            {loading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : techs.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>No technicians found yet — they appear here once assigned to jobs.</p>
            ) : (
                <div className="space-y-3">
                    {techs.map(t => {
                        const hasBase = !!t.base?.has_base;
                        const isEditing = editingBase === t.tech_id;
                        const busy = savingBase === t.tech_id;
                        const matchesCompany = hasBase && sameCoords(companyBase, t.base);
                        return (
                            <div key={t.tech_id} className="rounded-xl border px-4 py-4" style={{ borderColor: 'var(--blanc-line)' }}>
                                <div className="flex gap-4">
                                    {/* Left: avatar + upload directly beneath it */}
                                    <div className="flex flex-col items-center gap-2 shrink-0" style={{ width: 92 }}>
                                        <div className="h-16 w-16 rounded-full flex items-center justify-center font-bold text-lg shrink-0" style={{ background: '#efe7d8', color: '#8a7d68' }}>
                                            {t.has_photo ? <CheckCircle2 className="h-7 w-7 text-emerald-600" /> : initials(t.name)}
                                        </div>
                                        <input ref={el => { fileInputs.current[t.tech_id] = el; }} type="file" accept="image/*" hidden
                                            onChange={e => onPick(t.tech_id, e.target.files?.[0])} />
                                        <button
                                            type="button"
                                            onClick={() => fileInputs.current[t.tech_id]?.click()}
                                            disabled={uploading === t.tech_id}
                                            className="text-[12px] font-medium text-center leading-tight"
                                            style={{ color: 'var(--blanc-job)' }}
                                        >
                                            {uploading === t.tech_id
                                                ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Uploading…</span>
                                                : t.has_photo ? 'Replace photo' : 'Upload new photo'}
                                        </button>
                                    </div>

                                    {/* Right: name + base */}
                                    <div className="flex-1 min-w-0">
                                        <div className="font-medium truncate">{t.name || 'Unnamed technician'}</div>
                                        <div className="text-xs mt-0.5" style={{ color: 'var(--blanc-ink-3)' }}>{t.has_photo ? 'Photo set' : 'No photo'}</div>
                                        <div className="mt-3 flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                {hasBase ? (
                                                    <div className="flex items-start gap-1.5 text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                                                        <MapPin className="h-4 w-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                                        <span className="min-w-0 break-words">
                                                            {t.base?.address || t.base?.label || 'Base set'}
                                                            {matchesCompany && <span className="ml-1.5 text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>· company</span>}
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <span className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>No base location</span>
                                                )}
                                            </div>
                                            <Button variant="ghost" size="sm" disabled={busy} onClick={() => openEdit(t)} className="shrink-0" style={{ color: 'var(--blanc-ink-2)' }}>
                                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : hasBase ? 'Edit' : 'Set base'}
                                            </Button>
                                        </div>
                                    </div>
                                </div>

                                {isEditing && (
                                    <div className="mt-3 rounded-2xl p-3.5" style={{ background: 'rgba(117, 106, 89, 0.04)' }}>
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="inline-flex rounded-lg p-0.5" style={{ background: 'rgba(117, 106, 89, 0.08)' }}>
                                                <button type="button" onClick={() => companyBase && setBaseMode('company')} disabled={!companyBase}
                                                    className="px-3 py-1.5 text-xs rounded-md font-medium transition-colors" style={segBtn(baseMode === 'company', !companyBase)}>
                                                    Company address
                                                </button>
                                                <button type="button" onClick={() => setBaseMode('own')}
                                                    className="px-3 py-1.5 text-xs rounded-md font-medium transition-colors" style={segBtn(baseMode === 'own')}>
                                                    Own address
                                                </button>
                                            </div>
                                            {hasBase && (
                                                <button type="button" onClick={() => onClearBase(t.tech_id)} disabled={busy}
                                                    className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                                    <X className="h-3 w-3" /> Clear
                                                </button>
                                            )}
                                        </div>

                                        {baseMode === 'company' ? (
                                            companyBase ? (
                                                <div>
                                                    <p className="text-sm mb-3 flex items-start gap-1.5" style={{ color: 'var(--blanc-ink-2)' }}>
                                                        <MapPin className="h-4 w-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                                        <span>{companyBase.address || `${companyBase.lat.toFixed(4)}, ${companyBase.lng.toFixed(4)}`}</span>
                                                    </p>
                                                    <Button size="sm" disabled={busy || matchesCompany} onClick={() => onUseCompanyBase(t.tech_id)}>
                                                        {matchesCompany ? 'Already using company address' : 'Use company address'}
                                                    </Button>
                                                </div>
                                            ) : (
                                                <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Set the company base address above first.</p>
                                            )
                                        ) : (
                                            <>
                                                {hasBase && t.base?.address && (
                                                    <p className="text-xs mb-2" style={{ color: 'var(--blanc-ink-2)' }}>Current: {t.base.address}</p>
                                                )}
                                                <AddressAutocomplete
                                                    value={EMPTY_ADDRESS}
                                                    onChange={fields => onSelectOwnBase(t.tech_id, fields)}
                                                    idPrefix={`base-${t.tech_id}`}
                                                    streetLabel="Base address"
                                                    defaultUseDetails
                                                    hideDetailsToggle
                                                />
                                                <p className="text-[11px] mt-2" style={{ color: 'var(--blanc-ink-3)' }}>
                                                    Pick an address from the suggestions to save (coordinates are required).
                                                </p>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
