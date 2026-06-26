import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Camera, CheckCircle2, MapPin, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { techniciansApi, type Technician } from '../services/techniciansApi';
import {
    technicianBaseLocationsApi,
    type TechnicianBaseLocation,
} from '../services/technicianBaseLocationsApi';
import { AddressAutocomplete, EMPTY_ADDRESS, type AddressFields } from '../components/AddressAutocomplete';

function initials(name?: string | null) {
    if (!name) return '🙂';
    return name.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

/** Compose a single-line address string from the autocomplete fields. */
function composeAddress(a: AddressFields): string {
    const street = [a.street, a.apt].filter(Boolean).join(' ');
    const cityState = [a.city, a.state].filter(Boolean).join(', ');
    return [street, cityState, a.zip].filter(Boolean).join(', ').trim();
}

type TechRow = Technician & { base?: TechnicianBaseLocation };

export default function TechnicianPhotosPage() {
    const navigate = useNavigate();
    const [techs, setTechs] = useState<TechRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState<string | null>(null);
    const [editingBase, setEditingBase] = useState<string | null>(null);
    const [savingBase, setSavingBase] = useState<string | null>(null);
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

    const onSelectBase = async (techId: string, fields: AddressFields) => {
        // The autocomplete fires onChange on every keystroke; only commit once we
        // have coordinates (i.e. the user picked a real suggestion via Place Details).
        if (fields.lat == null || fields.lng == null) return;
        const address = composeAddress(fields);
        setSavingBase(techId);
        try {
            const saved = await technicianBaseLocationsApi.upsert(techId, {
                lat: fields.lat,
                lng: fields.lng,
                address,
                label: address,
            });
            toast.success('Base location set');
            setTechs(ts => ts.map(t => t.tech_id === techId
                ? { ...t, base: { tech_id: techId, name: t.name, lat: saved.lat, lng: saved.lng, label: saved.label, address: saved.address, has_base: true } }
                : t));
            setEditingBase(null);
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

    return (
        <div className="max-w-2xl mx-auto px-6 py-8" style={{ color: 'var(--blanc-ink-1)' }}>
            <button onClick={() => navigate('/settings/integrations')} className="flex items-center gap-1.5 text-sm mb-6" style={{ color: 'var(--blanc-ink-3)' }}>
                <ArrowLeft className="h-4 w-4" /> Settings
            </button>
            <h2 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading, inherit)' }}>Technicians</h2>
            <p className="text-sm mt-1 mb-6" style={{ color: 'var(--blanc-ink-3)' }}>
                A photo builds trust on the payment page and lifts tips. A base location lets the scheduler suggest the best arrival times.
            </p>

            {loading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : techs.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>No technicians found yet — they appear here once assigned to jobs.</p>
            ) : (
                <div className="space-y-2">
                    {techs.map(t => {
                        const hasBase = !!t.base?.has_base;
                        const isEditing = editingBase === t.tech_id;
                        const busy = savingBase === t.tech_id;
                        return (
                            <div key={t.tech_id} className="rounded-xl border px-4 py-3" style={{ borderColor: 'var(--blanc-line)' }}>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="h-11 w-11 rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: '#efe7d8', color: '#8a7d68' }}>
                                            {t.has_photo ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : initials(t.name)}
                                        </div>
                                        <div className="min-w-0">
                                            <div className="font-medium truncate">{t.name || 'Unnamed technician'}</div>
                                            <div className="flex items-center gap-2 flex-wrap mt-0.5">
                                                <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{t.has_photo ? 'Photo set' : 'No photo'}</span>
                                                {hasBase && (
                                                    <span
                                                        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                                                        style={{ background: 'rgba(117, 106, 89, 0.08)', color: 'var(--blanc-ink-2)' }}
                                                        title={t.base?.address || t.base?.label || undefined}
                                                    >
                                                        <MapPin className="h-3 w-3" /> Base set ✓
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => setEditingBase(isEditing ? null : t.tech_id)}
                                            style={{ color: 'var(--blanc-ink-2)' }}
                                        >
                                            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <MapPin className="h-4 w-4 mr-2" />}
                                            {hasBase ? 'Base' : 'Set base'}
                                        </Button>
                                        <input ref={el => { fileInputs.current[t.tech_id] = el; }} type="file" accept="image/*" hidden
                                            onChange={e => onPick(t.tech_id, e.target.files?.[0])} />
                                        <Button variant="outline" size="sm" disabled={uploading === t.tech_id}
                                            onClick={() => fileInputs.current[t.tech_id]?.click()}>
                                            {uploading === t.tech_id ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Camera className="h-4 w-4 mr-2" />}
                                            {t.has_photo ? 'Replace' : 'Upload'}
                                        </Button>
                                    </div>
                                </div>

                                {isEditing && (
                                    <div className="mt-3 rounded-2xl p-3.5" style={{ background: 'rgba(117, 106, 89, 0.04)' }}>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="blanc-eyebrow" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--blanc-ink-3)' }}>
                                                Base location
                                            </span>
                                            {hasBase && (
                                                <button
                                                    type="button"
                                                    onClick={() => onClearBase(t.tech_id)}
                                                    disabled={busy}
                                                    className="inline-flex items-center gap-1 text-xs"
                                                    style={{ color: 'var(--blanc-ink-3)' }}
                                                >
                                                    <X className="h-3 w-3" /> Clear
                                                </button>
                                            )}
                                        </div>
                                        {hasBase && t.base?.address && (
                                            <p className="text-xs mb-2" style={{ color: 'var(--blanc-ink-2)' }}>Current: {t.base.address}</p>
                                        )}
                                        <AddressAutocomplete
                                            value={EMPTY_ADDRESS}
                                            onChange={fields => onSelectBase(t.tech_id, fields)}
                                            idPrefix={`base-${t.tech_id}`}
                                            streetLabel="Base address"
                                            defaultUseDetails
                                            hideDetailsToggle
                                        />
                                        <p className="text-[11px] mt-2" style={{ color: 'var(--blanc-ink-3)' }}>
                                            Pick an address from the suggestions to save (coordinates are required).
                                        </p>
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
