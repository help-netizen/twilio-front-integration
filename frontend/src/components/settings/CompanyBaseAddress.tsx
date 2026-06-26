import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MapPin, X } from 'lucide-react';
import { Button } from '../ui/button';
import { technicianBaseLocationsApi, COMPANY_BASE_TECH_ID } from '../../services/technicianBaseLocationsApi';
import { AddressAutocomplete, EMPTY_ADDRESS, type AddressFields } from '../AddressAutocomplete';

export interface CompanyBase { lat: number; lng: number; address: string | null }

function composeAddress(a: AddressFields): string {
    const street = [a.street, a.apt].filter(Boolean).join(' ');
    const cityState = [a.city, a.state].filter(Boolean).join(', ');
    return [street, cityState, a.zip].filter(Boolean).join(', ').trim();
}

/**
 * The single company-level base address (stored under the COMPANY_BASE_TECH_ID
 * sentinel). Self-contained: loads + saves itself and reports the current value to
 * the parent via `onChange`. Used both on Settings → Company and on the Technicians
 * page, so the address can be edited from either place.
 */
export function CompanyBaseAddress({
    title = 'Company base address',
    hint,
    onChange,
}: {
    title?: string;
    hint?: string;
    onChange?: (base: CompanyBase | null) => void;
}) {
    const [base, setBase] = useState<CompanyBase | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState(false);

    useEffect(() => {
        technicianBaseLocationsApi.list()
            .then(rows => {
                const c = rows.find(r => r.tech_id === COMPANY_BASE_TECH_ID);
                const b = (c && c.lat != null && c.lng != null) ? { lat: c.lat, lng: c.lng, address: c.address || c.label } : null;
                setBase(b); onChange?.(b);
            })
            .catch(() => { /* base-locations optional; degrade quietly */ })
            .finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const save = async (fields: AddressFields) => {
        // AddressAutocomplete fires per-keystroke; only commit once we have coords.
        if (fields.lat == null || fields.lng == null) return;
        const address = composeAddress(fields);
        setSaving(true);
        try {
            const saved = await technicianBaseLocationsApi.upsert(COMPANY_BASE_TECH_ID, {
                lat: fields.lat, lng: fields.lng, address, label: address,
            });
            const b: CompanyBase = { lat: saved.lat as number, lng: saved.lng as number, address: saved.address || address };
            setBase(b); onChange?.(b); setEditing(false);
            toast.success('Company address saved');
        } catch (e: any) { toast.error(e.message || 'Failed to save company address'); }
        finally { setSaving(false); }
    };

    const clear = async () => {
        setSaving(true);
        try {
            await technicianBaseLocationsApi.remove(COMPANY_BASE_TECH_ID);
            setBase(null); onChange?.(null); setEditing(false);
            toast.success('Company address cleared');
        } catch (e: any) { toast.error(e.message || 'Failed to clear company address'); }
        finally { setSaving(false); }
    };

    return (
        <div className="rounded-2xl p-4" style={{ background: 'rgba(117, 106, 89, 0.04)' }}>
            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                    <div className="blanc-eyebrow" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--blanc-ink-3)' }}>{title}</div>
                    {loading ? (
                        <div className="mt-1 flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
                    ) : base ? (
                        <div className="mt-1 flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                            <MapPin className="h-4 w-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            <span className="truncate">{base.address || `${base.lat.toFixed(4)}, ${base.lng.toFixed(4)}`}</span>
                        </div>
                    ) : (
                        <div className="mt-1 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Not set</div>
                    )}
                    {hint && !editing && <p className="mt-1 text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>{hint}</p>}
                </div>
                {!loading && (
                    <div className="flex items-center gap-2 shrink-0">
                        {base && editing && (
                            <button type="button" onClick={clear} disabled={saving} className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                <X className="h-3 w-3" /> Clear
                            </button>
                        )}
                        <Button variant="ghost" size="sm" disabled={saving} onClick={() => setEditing(e => !e)} style={{ color: 'var(--blanc-ink-2)' }}>
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? 'Close' : base ? 'Edit' : 'Set address'}
                        </Button>
                    </div>
                )}
            </div>
            {editing && (
                <div className="mt-3">
                    <AddressAutocomplete value={EMPTY_ADDRESS} onChange={save} idPrefix="company-base" streetLabel="Company address" defaultUseDetails hideDetailsToggle />
                    <p className="text-[11px] mt-2" style={{ color: 'var(--blanc-ink-3)' }}>Pick an address from the suggestions to save (coordinates are required).</p>
                </div>
            )}
        </div>
    );
}
