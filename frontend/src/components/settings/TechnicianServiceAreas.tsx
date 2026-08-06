import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, MapPinned } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Switch } from '../ui/switch';
import {
    techniciansApi,
    type TechnicianServiceAreas,
} from '../../services/techniciansApi';

type AreaEditorMode = 'districts' | 'radii';

export function toggleServiceArea(values: string[], id: string): string[] {
    return values.includes(id) ? values.filter(value => value !== id) : [...values, id];
}

export function technicianServiceAreaSummary(value: TechnicianServiceAreas): string {
    const active = value.active_mode === 'radius'
        ? value.radius_assignments.map(id => {
            const radius = value.radii.find(item => item.id === id);
            return radius ? `${radius.zip} · ${radius.radius_miles} mi` : id;
        })
        : value.district_assignments.map(id =>
            value.districts.find(item => item.id === id)?.name || id || 'Uncategorized ZIPs');
    if (value.serves_all_territory) return 'Whole territory';
    if (active.length === 0) {
        // ZONE-STRICT-001: an empty list is no longer "everywhere" — it is nowhere.
        return value.active_mode === 'radius' ? 'No radii — not offered' : 'No districts — not offered';
    }
    return active.length === 1 ? active[0] : `${active[0]} +${active.length - 1}`;
}

export function serviceAreaModeStatus(
    activeMode: TechnicianServiceAreas['active_mode'],
    editorMode: AreaEditorMode,
): 'Active mode' | 'Saved for later' {
    return (editorMode === 'districts' && activeMode === 'list')
        || (editorMode === 'radii' && activeMode === 'radius')
        ? 'Active mode'
        : 'Saved for later';
}

export function TechnicianServiceAreasEditor({
    technicianId,
    value,
    onSaved,
}: {
    technicianId: string;
    value: TechnicianServiceAreas;
    onSaved: (value: TechnicianServiceAreas) => void;
}) {
    const queryClient = useQueryClient();
    const [mode, setMode] = useState<AreaEditorMode>(
        value.active_mode === 'radius' ? 'radii' : 'districts'
    );
    const [districtAssignments, setDistrictAssignments] = useState(value.district_assignments);
    const [radiusAssignments, setRadiusAssignments] = useState(value.radius_assignments);
    const [saving, setSaving] = useState(false);
    const [savingScope, setSavingScope] = useState(false);

    useEffect(() => {
        setDistrictAssignments(value.district_assignments);
        setRadiusAssignments(value.radius_assignments);
    }, [value]);

    const selected = mode === 'districts' ? districtAssignments : radiusAssignments;
    const saved = mode === 'districts' ? value.district_assignments : value.radius_assignments;
    const targets = mode === 'districts'
        ? value.districts.map(district => ({ id: district.id, label: district.name }))
        : value.radii.map(radius => ({
            id: radius.id,
            label: `${radius.zip} · ${radius.radius_miles} mi`,
        }));
    const dirty = useMemo(
        () => [...selected].sort().join('\u0000') !== [...saved].sort().join('\u0000'),
        [selected, saved]
    );
    const modeStatus = serviceAreaModeStatus(value.active_mode, mode);

    const setSelected = (next: string[]) => {
        if (mode === 'districts') setDistrictAssignments(next);
        else setRadiusAssignments(next);
    };

    const save = async () => {
        setSaving(true);
        try {
            const updated = await techniciansApi.updateServiceAreas(technicianId, mode, selected);
            onSaved(updated);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['technicians'] }),
                queryClient.invalidateQueries({ queryKey: ['service-territory-assignments'] }),
                queryClient.invalidateQueries({ queryKey: ['service-territories-config'] }),
            ]);
            toast.success('Service-area assignments saved');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to save service-area assignments');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <div className="blanc-eyebrow">Service areas</div>
                    <p className="mt-1 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                        Albusto districts and radii are saved independently.
                    </p>
                </div>
                <span className="text-xs font-medium" style={{ color: 'var(--blanc-ink-3)' }}>
                    {modeStatus}
                </span>
            </div>

            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Technician service-area mode">
                {(['districts', 'radii'] as const).map(item => (
                    <button
                        key={item}
                        type="button"
                        role="tab"
                        aria-selected={mode === item}
                        className="blanc-control-chip"
                        data-active={mode === item ? '' : undefined}
                        onClick={() => setMode(item)}
                    >
                        {item === 'districts' ? 'Districts' : 'Radii'}
                    </button>
                ))}
            </div>

            {/* ZONE-STRICT-001 — working everywhere is now stated, not inferred from
                an empty list. Off by default, so a technician nobody zoned is simply
                not offered instead of being offered across the whole map. */}
            <label
                className="flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-xl px-3.5 py-3"
                style={{ border: '1px solid var(--blanc-line)' }}
            >
                <span className="min-w-0">
                    <span className="block text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                        Works across the whole territory
                    </span>
                    <span className="mt-0.5 block text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                        Offered for every ZIP the company covers, whatever is selected below.
                    </span>
                </span>
                <Switch
                    checked={value.serves_all_territory}
                    disabled={savingScope}
                    onCheckedChange={async next => {
                        setSavingScope(true);
                        try {
                            const updated = await techniciansApi.setServesAllTerritory(technicianId, next);
                            onSaved(updated);
                            await queryClient.invalidateQueries({ queryKey: ['service-territory-assignments'] });
                            toast.success(next ? 'Now serving the whole territory' : 'Limited to the selected areas');
                        } catch (error) {
                            toast.error(error instanceof Error ? error.message : 'Failed to save');
                        } finally {
                            setSavingScope(false);
                        }
                    }}
                />
            </label>

            {targets.length === 0 ? (
                <p className="py-3 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    No {mode} are configured yet, so nothing can be assigned in this mode.
                </p>
            ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {targets.map(target => (
                        <label
                            key={target.id}
                            className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3"
                            style={{ border: '1px solid var(--blanc-line)' }}
                        >
                            <Checkbox
                                checked={selected.includes(target.id)}
                                onCheckedChange={() => setSelected(toggleServiceArea(selected, target.id))}
                            />
                            <span className="min-w-0 text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                                {target.label}
                            </span>
                        </label>
                    ))}
                </div>
            )}

            {selected.length === 0 && !value.serves_all_territory && (
                <div
                    className="flex gap-2 rounded-xl px-3.5 py-3 text-sm"
                    style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-ink-1)' }}
                >
                    <MapPinned className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        With nothing selected, this technician is not offered any {mode === 'districts' ? 'district' : 'radius'} while this mode is active. Pick areas, or turn on the whole-territory switch above.
                    </span>
                </div>
            )}

            <Button type="button" variant="outline" onClick={save} disabled={!dirty || saving}>
                {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : `Save ${mode}`}
            </Button>
        </div>
    );
}
