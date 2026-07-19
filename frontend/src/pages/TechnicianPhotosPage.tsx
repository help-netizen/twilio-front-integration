import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CalendarClock, CheckCircle2, Loader2, Mail, MapPin, MapPinned, Phone, Wrench, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { technicianScheduleDisplay, techniciansApi } from '../services/techniciansApi';
import { technicianBaseLocationsApi } from '../services/technicianBaseLocationsApi';
import { EMPTY_ADDRESS, fieldsFromStored, type AddressFields } from '../components/addressAutoHelpers';
import { CompanyBaseAddress, type CompanyBase } from '../components/settings/CompanyBaseAddress';
import { BaseAddressForm } from '../components/settings/BaseAddressForm';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { TechnicianSettingsPanel } from '../components/settings/TechnicianSettingsPanel';
import { technicianServiceAreaSummary } from '../components/settings/TechnicianServiceAreas';
import {
    mergeTechnicianRosterRows,
    type TechnicianRosterRow,
} from '../components/settings/technicianRosterModel';
import type { TechnicianSettings } from '../services/techniciansApi';

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

function formatPhone(phone: string) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits.startsWith('1')) {
        return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return phone;
}

function avatarUrl(value?: string | null): string | undefined {
    if (!value) return undefined;
    return value.startsWith('//') ? `https:${value}` : value;
}

function humanizeStatus(value: string) {
    return value.replaceAll('_', ' ').replace(/^./, first => first.toUpperCase());
}

export default function TechnicianPhotosPage() {
    const [techs, setTechs] = useState<TechnicianRosterRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState<string | null>(null);
    const [editingBase, setEditingBase] = useState<string | null>(null);
    const [savingBase, setSavingBase] = useState<string | null>(null);
    const [baseMode, setBaseMode] = useState<'company' | 'own'>('own');
    const [companyBase, setCompanyBase] = useState<CompanyBase | null>(null);
    const [selectedTech, setSelectedTech] = useState<TechnicianRosterRow | null>(null);
    const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

    // Deep link: /settings/technicians?tech=<tech_id> opens that technician's
    // panel once the roster arrives (Service areas links here to fix a
    // technician with no assignments). Consumed once so closing the panel does
    // not immediately reopen it.
    const [searchParams, setSearchParams] = useSearchParams();
    const deepLinkTech = searchParams.get('tech');
    const consumedDeepLink = useRef<string | null>(null);

    const clearDeepLink = useCallback(() => {
        setSearchParams(current => {
            const next = new URLSearchParams(current);
            next.delete('tech');
            return next;
        }, { replace: true });
    }, [setSearchParams]);

    const load = () => {
        setLoading(true);
        Promise.all([
            techniciansApi.list(),
            technicianBaseLocationsApi.list().catch(() => []),
        ])
            .then(([list, bases]) => setTechs(mergeTechnicianRosterRows(list, bases)))
            .catch(e => toast.error(e.message))
            .finally(() => setLoading(false));
    };
    useEffect(load, []);

    useEffect(() => {
        if (!deepLinkTech || techs.length === 0) return;
        if (consumedDeepLink.current === deepLinkTech) return;
        consumedDeepLink.current = deepLinkTech;
        const match = techs.find(tech => String(tech.tech_id) === deepLinkTech);
        if (match) setSelectedTech(match);
        else toast.error('That technician is no longer on the active roster.');
        clearDeepLink();
    }, [deepLinkTech, techs, clearDeepLink]);

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

    const openEdit = (t: TechnicianRosterRow) => {
        if (editingBase === t.tech_id) { setEditingBase(null); return; }
        setEditingBase(t.tech_id);
        const hasBase = !!t.base?.has_base;
        if (hasBase && sameCoords(companyBase, t.base)) setBaseMode('company');
        else if (hasBase) setBaseMode('own');
        else setBaseMode(companyBase ? 'company' : 'own');
    };

    const applyBase = (techId: string, saved: {
        lat: number | null; lng: number | null; label: string | null; address: string | null;
        street: string | null; apt: string | null; city: string | null; state: string | null; zip: string | null;
    }) => {
        setTechs(ts => ts.map(t => t.tech_id === techId
            ? { ...t, base: { tech_id: techId, name: t.name, lat: saved.lat, lng: saved.lng, label: saved.label, address: saved.address, street: saved.street, apt: saved.apt, city: saved.city, state: saved.state, zip: saved.zip, has_base: true } }
            : t));
        setEditingBase(null);
    };

    const onSaveOwnBase = async (techId: string, fields: AddressFields) => {
        // Explicit save (ADDR-UX-001): no auto-save on suggestion select. lat/lng may be
        // null on manual entry — the backend geocodes `address` and returns 422 if unresolved.
        const address = composeAddress(fields);
        setSavingBase(techId);
        try {
            const saved = await technicianBaseLocationsApi.upsert(techId, {
                lat: fields.lat ?? null, lng: fields.lng ?? null, address, label: address,
                street: fields.street, apt: fields.apt, city: fields.city, state: fields.state, zip: fields.zip,
            });
            toast.success('Base location set');
            applyBase(techId, saved);
        } catch (e: any) {
            // Includes geocode-fail (422): toast the server message and stay in edit.
            toast.error(e.message || 'Failed to save base location');
            throw e;
        } finally {
            setSavingBase(null);
        }
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

    const onScheduleSaved = (settings: TechnicianSettings) => {
        setTechs(current => current.map(technician => technician.tech_id === settings.technician_id
            ? {
                ...technician,
                inherits_company_schedule: settings.inherits_company_schedule,
                effective_schedule: settings.effective_week,
                schedule_summary: settings.schedule_summary,
                exceeds_company_hours: settings.exceeds_company_hours,
                degraded_to_company_schedule: settings.degraded_to_company_schedule,
                service_area_mode: settings.service_areas.active_mode,
                service_area_summary: technicianServiceAreaSummary(settings.service_areas),
                service_area_wildcard: settings.service_areas.wildcard_in_active_mode,
            }
            : technician));
    };

    return (
        <SettingsPageShell
            backTo="/settings/scheduling"
            backLabel="Settings"
            title="Technicians"
            description="Active Zenbooker technicians, contact and skill details, recurring work schedules, payment-page photos, and scheduling bases."
        >
            <CompanyBaseAddress
                title="Company base address"
                hint="The default base for technicians who match it. Also editable in Settings → Company."
                onChange={setCompanyBase}
            />

            {loading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : techs.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>No active service-provider technicians were found in Zenbooker.</p>
            ) : (
                <div className="space-y-3">
                    {techs.map(t => {
                        const scheduleDisplay = technicianScheduleDisplay(t);
                        const hasBase = !!t.base?.has_base;
                        const isEditing = editingBase === t.tech_id;
                        const busy = savingBase === t.tech_id;
                        const matchesCompany = hasBase && sameCoords(companyBase, t.base);
                        const zenbooker = t.zenbooker;
                        const territories = zenbooker?.assigned_territories ?? [];
                        const skills = zenbooker?.skill_tags ?? [];
                        return (
                            <div
                                key={t.tech_id}
                                role="button"
                                tabIndex={0}
                                onClick={() => setSelectedTech(t)}
                                onKeyDown={event => {
                                    if (event.key === 'Enter' || event.key === ' ') setSelectedTech(t);
                                }}
                                className="rounded-xl border px-4 py-4 text-left transition-colors hover:bg-[var(--blanc-surface-muted)]"
                                style={{ borderColor: 'var(--blanc-line)' }}
                            >
                                <div className="flex gap-4">
                                    {/* Left: avatar + upload directly beneath it */}
                                    <div className="flex flex-col items-center gap-2 shrink-0" style={{ width: 92 }}>
                                        <div
                                            className="h-16 w-16 rounded-full flex items-center justify-center font-bold text-lg shrink-0"
                                            style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-ink-2)' }}
                                        >
                                            {t.has_photo ? <CheckCircle2 className="h-7 w-7" style={{ color: 'var(--blanc-success)' }} /> : initials(t.name)}
                                        </div>
                                        <input ref={el => { fileInputs.current[t.tech_id] = el; }} type="file" accept="image/*" hidden
                                            onChange={e => onPick(t.tech_id, e.target.files?.[0])} />
                                        <button
                                            type="button"
                                            onClick={event => {
                                                event.stopPropagation();
                                                fileInputs.current[t.tech_id]?.click();
                                            }}
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
                                        <div className="flex flex-wrap items-center gap-2">
                                            <div className="font-medium truncate">{t.name || 'Unnamed technician'}</div>
                                            {zenbooker?.user_status && (
                                                <span
                                                    className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                                                    style={{ background: 'var(--blanc-surface-muted)', color: 'var(--blanc-ink-2)' }}
                                                >
                                                    {humanizeStatus(zenbooker.user_status)}
                                                </span>
                                            )}
                                            <span
                                                className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                                                style={{
                                                    background: t.inherits_company_schedule ? 'var(--blanc-surface-muted)' : 'var(--blanc-accent-soft)',
                                                    color: t.inherits_company_schedule ? 'var(--blanc-ink-2)' : 'var(--blanc-accent)',
                                                }}
                                            >
                                                {scheduleDisplay.state}
                                            </span>
                                            {scheduleDisplay.wider && (
                                                <span className="text-[11px] font-medium" style={{ color: 'var(--blanc-warning)' }}>
                                                    Wider hours
                                                </span>
                                            )}
                                            {scheduleDisplay.degraded && (
                                                <span className="text-[11px] font-medium" style={{ color: 'var(--blanc-danger)' }}>
                                                    Company fallback
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-xs mt-0.5" style={{ color: 'var(--blanc-ink-3)' }}>{t.has_photo ? 'Photo set' : 'No photo'}</div>
                                        {zenbooker && (
                                            <div
                                                className="mt-3 space-y-2.5 rounded-xl px-3 py-2.5"
                                                style={{ background: 'var(--blanc-surface-muted)' }}
                                            >
                                                <div className="flex items-center gap-2">
                                                    {zenbooker.avatar ? (
                                                        <img
                                                            src={avatarUrl(zenbooker.avatar)}
                                                            alt=""
                                                            className="size-8 shrink-0 rounded-full object-cover"
                                                        />
                                                    ) : (
                                                        <div
                                                            className="flex size-8 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                                                            style={{
                                                                background: zenbooker.calendar_color || 'var(--blanc-accent-soft)',
                                                                color: 'var(--blanc-ink-2)',
                                                            }}
                                                        >
                                                            {initials(zenbooker.name)}
                                                        </div>
                                                    )}
                                                    <div className="blanc-eyebrow">Zenbooker profile</div>
                                                </div>
                                                {(zenbooker.phone || zenbooker.email) && (
                                                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--blanc-ink-2)' }}>
                                                        {zenbooker.phone && (
                                                            <span className="inline-flex items-center gap-1">
                                                                <Phone className="size-3" /> {formatPhone(zenbooker.phone)}
                                                            </span>
                                                        )}
                                                        {zenbooker.email && (
                                                            <span className="inline-flex min-w-0 items-center gap-1 break-all">
                                                                <Mail className="size-3 shrink-0" /> {zenbooker.email}
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                                {territories.length > 0 && (
                                                    <div>
                                                        <div className="mb-1 flex items-center gap-1 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                                            <MapPin className="size-3" /> Zenbooker territories
                                                        </div>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {territories.map(territory => (
                                                                <span
                                                                    key={territory.id}
                                                                    className="rounded-full px-2 py-0.5 text-[11px]"
                                                                    style={{ background: 'var(--blanc-panel-surface)', color: 'var(--blanc-ink-2)' }}
                                                                >
                                                                    {territory.name.trim()}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                {skills.length > 0 && (
                                                    <div>
                                                        <div className="mb-1 flex items-center gap-1 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                                            <Wrench className="size-3" /> Skills
                                                        </div>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {skills.map(skill => (
                                                                <span
                                                                    key={skill.id}
                                                                    className="rounded-full px-2 py-0.5 text-[11px]"
                                                                    style={{ background: 'var(--blanc-panel-surface)', color: 'var(--blanc-ink-2)' }}
                                                                >
                                                                    {skill.name}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        <button
                                            type="button"
                                            className="mt-3 flex w-full items-start gap-2 text-left"
                                            onClick={event => {
                                                event.stopPropagation();
                                                setSelectedTech(t);
                                            }}
                                        >
                                            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                                            <span>
                                                <span className="block text-xs font-medium" style={{ color: 'var(--blanc-ink-2)' }}>Weekly schedule</span>
                                                <span className="mt-0.5 block text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                                                    {scheduleDisplay.summary}
                                                </span>
                                            </span>
                                        </button>
                                        <div className="mt-3 flex items-start gap-2">
                                            <MapPinned className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                                            <span>
                                                <span className="block text-xs font-medium" style={{ color: 'var(--blanc-ink-2)' }}>
                                                    {t.service_area_mode === 'radius' ? 'Radii served' : 'Districts served'}
                                                </span>
                                                <span className="mt-0.5 block text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                                                    {t.service_area_summary || 'Service areas unavailable'}
                                                </span>
                                            </span>
                                        </div>
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
                                            <Button variant="ghost" size="sm" disabled={busy} onClick={event => { event.stopPropagation(); openEdit(t); }} className="shrink-0" style={{ color: 'var(--blanc-ink-2)' }}>
                                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : hasBase ? 'Edit' : 'Set base'}
                                            </Button>
                                        </div>
                                    </div>
                                </div>

                                {isEditing && (
                                    <div className="mt-3 rounded-2xl p-3.5" style={{ background: 'rgba(25, 25, 25, 0.03)' }} onClick={event => event.stopPropagation()}>
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="inline-flex rounded-lg p-0.5" style={{ background: 'rgba(25, 25, 25, 0.06)' }}>
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
                                            <BaseAddressForm
                                                initial={t.base ? fieldsFromStored(t.base) : EMPTY_ADDRESS}
                                                onSave={fields => onSaveOwnBase(t.tech_id, fields)}
                                                onCancel={() => setEditingBase(null)}
                                                idPrefix={`base-${t.tech_id}`}
                                                streetLabel="Base address"
                                                saving={busy}
                                            />
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            <TechnicianSettingsPanel
                open={selectedTech !== null}
                technician={selectedTech}
                onClose={() => setSelectedTech(null)}
                onSaved={onScheduleSaved}
            />
        </SettingsPageShell>
    );
}
