import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogPanelFooter,
    DialogPanelHeader,
    DialogTitle,
} from '../ui/dialog';
import {
    serviceTerritoryAssignmentsApi,
    type ServiceTerritoryAssignmentState,
    type TerritoryAssignmentTechnician,
} from '../../services/serviceTerritoryAssignmentsApi';

export interface TerritoryAssignmentTarget {
    mode: 'district' | 'radius';
    id: string;
    label: string;
}

export function toggleTerritoryTechnician(values: string[], id: string): string[] {
    return values.includes(id) ? values.filter(value => value !== id) : [...values, id];
}

export function TerritoryTechnicianPanel({
    open,
    target,
    technicians,
    selectedIds,
    onClose,
    onSaved,
}: {
    open: boolean;
    target: TerritoryAssignmentTarget | null;
    technicians: TerritoryAssignmentTechnician[];
    selectedIds: string[];
    onClose: () => void;
    onSaved: (state: ServiceTerritoryAssignmentState) => void;
}) {
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState(selectedIds);
    const [saving, setSaving] = useState(false);

    useEffect(() => setSelected(selectedIds), [selectedIds, target]);

    const save = async () => {
        if (!target) return;
        setSaving(true);
        try {
            const state = target.mode === 'district'
                ? await serviceTerritoryAssignmentsApi.replaceDistrict(target.id, selected)
                : await serviceTerritoryAssignmentsApi.replaceRadius(target.id, selected);
            queryClient.setQueryData(['service-territory-assignments'], state);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['service-territory-assignments'] }),
                queryClient.invalidateQueries({ queryKey: ['technicians'] }),
            ]);
            onSaved(state);
            toast.success('Technician assignments saved');
            onClose();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to save technician assignments');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle className="text-2xl font-semibold leading-tight">
                        {target?.label || 'Service area'}
                    </DialogTitle>
                    <DialogDescription>
                        Assign any number of active technicians. Technician wildcard behavior is configured by having no assignments in the active mode.
                    </DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <div className="space-y-3.5">
                            <div className="blanc-eyebrow">Assigned technicians</div>
                            {technicians.length === 0 ? (
                                <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                                    No active technicians are available.
                                </p>
                            ) : (
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    {technicians.map(technician => (
                                        <label
                                            key={technician.id}
                                            className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3"
                                            style={{ border: '1px solid var(--blanc-line)' }}
                                        >
                                            <Checkbox
                                                checked={selected.includes(technician.id)}
                                                onCheckedChange={() => setSelected(
                                                    toggleTerritoryTechnician(selected, technician.id)
                                                )}
                                            />
                                            <span className="text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                                                {technician.name}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </DialogBody>
                <DialogPanelFooter>
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button onClick={save} disabled={!target || saving}>
                        {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Save assignments'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
