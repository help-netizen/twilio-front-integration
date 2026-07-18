import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
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
import { findWiderScheduleDays, TechnicianWeekEditor } from './TechnicianWeekEditor';
import { TechnicianServiceAreasEditor } from './TechnicianServiceAreas';
import {
    techniciansApi,
    type Technician,
    type TechnicianScheduleDay,
    type TechnicianSettings,
} from '../../services/techniciansApi';

interface TechnicianSettingsPanelProps {
    open: boolean;
    technician: Technician | null;
    onClose: () => void;
    onSaved: (settings: TechnicianSettings) => void;
}

export function TechnicianSettingsPanel({
    open,
    technician,
    onClose,
    onSaved,
}: TechnicianSettingsPanelProps) {
    const [settings, setSettings] = useState<TechnicianSettings | null>(null);
    const [inherits, setInherits] = useState(true);
    const [customDays, setCustomDays] = useState<TechnicianScheduleDay[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open || !technician) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setSettings(null);
        techniciansApi.getSettings(technician.tech_id)
            .then(data => {
                if (cancelled) return;
                setSettings(data);
                setInherits(data.inherits_company_schedule);
                setCustomDays(data.saved_week.map(day => ({ ...day })));
            })
            .catch(reason => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : 'Failed to load schedule settings');
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [open, technician]);

    const companyDays = settings?.company_schedule.days || [];
    const displayedDays = inherits ? companyDays : customDays;
    const widerDays = useMemo(
        () => inherits ? [] : findWiderScheduleDays(customDays, companyDays),
        [inherits, customDays, companyDays],
    );

    const save = async () => {
        if (!technician || !settings) return;
        setSaving(true);
        try {
            const updated = await techniciansApi.updateWorkSchedule(technician.tech_id, {
                inherits_company_schedule: inherits,
                ...(inherits ? {} : { days: customDays }),
            });
            const merged = { ...updated, service_areas: settings.service_areas };
            setSettings(merged);
            onSaved(merged);
            toast.success('Technician schedule saved');
            onClose();
        } catch (reason) {
            toast.error(reason instanceof Error ? reason.message : 'Failed to save technician schedule');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-2xl font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        {technician?.name || 'Technician'}
                    </DialogTitle>
                    <DialogDescription>
                        Recurring work schedule. Time off remains an explicit exception.
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        {loading ? (
                            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading schedule…
                            </div>
                        ) : error ? (
                            <div className="space-y-3">
                                <p className="text-sm" style={{ color: 'var(--blanc-danger)' }}>{error}</p>
                                <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                    No hours were fabricated. Close and reopen the panel to retry.
                                </p>
                            </div>
                        ) : settings ? (
                            <>
                                <div className="space-y-3.5">
                                    <label className="flex items-start gap-3">
                                        <Checkbox
                                            checked={inherits}
                                            aria-label="Duplicate company schedule"
                                            onCheckedChange={checked => setInherits(checked === true)}
                                        />
                                        <span>
                                            <span className="block text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                                                Duplicate company schedule
                                            </span>
                                            <span className="mt-0.5 block text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                                Company hours stay visible below. Turn this off to edit the saved technician week.
                                            </span>
                                        </span>
                                    </label>

                                    {!settings.has_schedule && (
                                        <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                            No technician schedule has been saved yet. Company hours currently apply.
                                        </p>
                                    )}
                                    {settings.degraded_to_company_schedule && (
                                        <div
                                            className="flex gap-2 rounded-xl px-3.5 py-3 text-sm"
                                            style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-ink-1)' }}
                                        >
                                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                                            Saved technician hours could not be loaded. Company hours are shown, and saving is disabled until the read succeeds.
                                        </div>
                                    )}
                                </div>

                                <div className="space-y-3.5">
                                    <div className="blanc-eyebrow">Weekly schedule</div>
                                    <TechnicianWeekEditor
                                        days={displayedDays}
                                        companyDays={companyDays}
                                        inherited={inherits || settings.degraded_to_company_schedule}
                                        onChange={setCustomDays}
                                    />
                                </div>

                                {widerDays.length > 0 && (
                                    <div
                                        className="flex gap-2 rounded-xl px-3.5 py-3 text-sm"
                                        style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-ink-1)' }}
                                    >
                                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                                        <div>
                                            <div className="font-medium">Hours exceed company hours</div>
                                            {widerDays.map(day => (
                                                <div key={day.day_of_week} className="mt-0.5 text-xs" style={{ color: 'var(--blanc-ink-2)' }}>
                                                    {day.day_name}: {day.technician_interval}; company {day.company_interval}. This is allowed because the company is open.
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <TechnicianServiceAreasEditor
                                    technicianId={technician!.tech_id}
                                    value={settings.service_areas}
                                    onSaved={serviceAreas => {
                                        const updated = { ...settings, service_areas: serviceAreas };
                                        setSettings(updated);
                                        onSaved(updated);
                                    }}
                                />
                            </>
                        ) : null}
                    </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button
                        onClick={save}
                        disabled={!settings || loading || saving || settings.degraded_to_company_schedule}
                    >
                        {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Save schedule'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
