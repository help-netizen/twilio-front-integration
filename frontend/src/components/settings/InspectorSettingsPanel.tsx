import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
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
import { FloatingField, FloatingLabel } from '../ui/floating-field';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Switch } from '../ui/switch';
import {
    fetchInspectorSettings,
    saveInspectorSettings,
    type InspectorSettings,
    type InspectorSettingsResponse,
} from '../../services/marketplaceApi';

interface InspectorSettingsPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function toggleInspectorStatus(statuses: string[], status: string): string[] {
    return statuses.includes(status)
        ? statuses.filter(candidate => candidate !== status)
        : [...statuses, status];
}

export function formatInspectorSchedule(schedule: InspectorSettingsResponse['schedule']): string {
    const [hourText, minuteText] = schedule.after_local_time.split(':');
    const hour = Number(hourText);
    const minute = Number(minuteText || '0');
    const clock = `${hour === 0 ? 12 : hour > 12 ? hour - 12 : hour}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
    return `After ${clock} · ${schedule.timezone}`;
}

function StatusPicker({
    label,
    options,
    selected,
    onChange,
}: {
    label: string;
    options: string[];
    selected: string[];
    onChange: (statuses: string[]) => void;
}) {
    const [search, setSearch] = useState('');
    const visibleOptions = options.filter(status =>
        status.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    );
    return (
        <FloatingLabel label={label} filled>
            <div className="flex min-h-[64px] items-center gap-2 px-3.5 pb-2 pt-[22px]">
                <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    {selected.map(status => (
                        <span
                            key={status}
                            className="inline-flex items-center gap-1 rounded-full bg-[var(--blanc-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--blanc-accent)]"
                        >
                            {status}
                            <button
                                type="button"
                                aria-label={`Remove ${status}`}
                                onClick={() => onChange(toggleInspectorStatus(selected, status))}
                                className="rounded-full text-[var(--blanc-ink-3)] hover:text-[var(--blanc-ink-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blanc-accent)]"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                    {selected.length === 0 && (
                        <span className="py-1 text-sm text-[var(--blanc-ink-3)]">Choose statuses</span>
                    )}
                </div>
                <Popover sheetTitle={label}>
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            aria-label={`Choose ${label.toLowerCase()}`}
                            className="rounded-lg p-2 text-[var(--blanc-ink-3)] hover:bg-[var(--blanc-surface-muted)] hover:text-[var(--blanc-ink-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blanc-accent)]"
                        >
                            <ChevronDown className="h-4 w-4" />
                        </button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-72 p-2">
                        <Input
                            type="search"
                            aria-label={`Search ${label.toLowerCase()}`}
                            placeholder="Search statuses"
                            value={search}
                            onChange={event => setSearch(event.target.value)}
                            className="mb-2"
                        />
                        <div className="max-h-64 space-y-1 overflow-y-auto">
                            {visibleOptions.map(status => {
                                const checked = selected.includes(status);
                                return (
                                    <label
                                        key={status}
                                        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-[var(--blanc-ink-1)] hover:bg-[var(--blanc-surface-muted)]"
                                    >
                                        <Checkbox
                                            checked={checked}
                                            onCheckedChange={() => onChange(toggleInspectorStatus(selected, status))}
                                        />
                                        <span className="min-w-0 flex-1">{status}</span>
                                        {checked && <Check className="h-3.5 w-3.5 text-[var(--blanc-accent)]" />}
                                    </label>
                                );
                            })}
                        </div>
                    </PopoverContent>
                </Popover>
            </div>
        </FloatingLabel>
    );
}

export function InspectorSettingsPanel({ open, onOpenChange }: InspectorSettingsPanelProps) {
    const queryClient = useQueryClient();
    const [draft, setDraft] = useState<InspectorSettings | null>(null);
    const [hydratedAt, setHydratedAt] = useState<number | null>(null);

    const settingsQuery = useQuery({
        queryKey: ['inspector-settings'],
        queryFn: fetchInspectorSettings,
        enabled: open,
        refetchOnMount: 'always',
    });

    useEffect(() => {
        if (!open) {
            setDraft(null);
            setHydratedAt(null);
            return;
        }
        if (!settingsQuery.data || settingsQuery.dataUpdatedAt === hydratedAt) return;
        setDraft({
            ...settingsQuery.data.settings,
            ignored_job_statuses: [...settingsQuery.data.settings.ignored_job_statuses],
            ignored_lead_statuses: [...settingsQuery.data.settings.ignored_lead_statuses],
        });
        setHydratedAt(settingsQuery.dataUpdatedAt);
    }, [hydratedAt, open, settingsQuery.data, settingsQuery.dataUpdatedAt]);

    useEffect(() => {
        if (open && settingsQuery.error) {
            toast.error(settingsQuery.error.message || 'Failed to load Inspector settings');
        }
    }, [open, settingsQuery.error]);

    const saveMutation = useMutation({
        mutationFn: saveInspectorSettings,
        onSuccess: response => {
            queryClient.setQueryData(['inspector-settings'], response);
            toast.success('Inspector settings saved');
            onOpenChange(false);
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to save Inspector settings');
        },
    });

    const response = settingsQuery.data;
    const loading = settingsQuery.isFetching && !draft;
    const loadError = settingsQuery.isError && !draft;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader className="md:px-8 md:pt-7">
                    <div className="blanc-eyebrow">Marketplace agent</div>
                    <DialogTitle
                        className="text-2xl font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Inspector
                    </DialogTitle>
                    <DialogDescription>
                        Review stalled jobs and leads, then create a task only when your dispatcher should act.
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        {loading ? (
                            <div className="flex items-center gap-2 text-sm text-[var(--blanc-ink-3)]">
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading Inspector settings…
                            </div>
                        ) : loadError ? (
                            <div className="space-y-3">
                                <p className="text-sm text-[var(--blanc-danger)]">Inspector settings could not be loaded.</p>
                                <Button variant="outline" onClick={() => settingsQuery.refetch()}>Try again</Button>
                            </div>
                        ) : draft && response ? (
                            <>
                                <section className="space-y-3.5">
                                    <div className="blanc-eyebrow">Status</div>
                                    <div className="flex items-start justify-between gap-5 rounded-xl bg-[var(--blanc-field)] px-4 py-4">
                                        <div>
                                            <label htmlFor="inspector-enabled" className="text-sm font-medium text-[var(--blanc-ink-1)]">
                                                Enable Inspector
                                            </label>
                                            <p className="mt-0.5 text-xs text-[var(--blanc-ink-3)]">
                                                Inspector can review eligible records and create unassigned tasks.
                                            </p>
                                        </div>
                                        <Switch
                                            id="inspector-enabled"
                                            aria-label="Enable Inspector"
                                            checked={draft.enabled}
                                            onCheckedChange={enabled => setDraft(current => current ? { ...current, enabled } : current)}
                                        />
                                    </div>
                                </section>

                                <section className="space-y-3.5">
                                    <div className="blanc-eyebrow">Schedule</div>
                                    <FloatingField
                                        label="Daily review"
                                        value={formatInspectorSchedule(response.schedule)}
                                        disabled
                                    />
                                    <p className="text-xs text-[var(--blanc-ink-3)]">
                                        Read-only. Inspector runs once per day in the company time zone.
                                    </p>
                                </section>

                                <section className="space-y-3.5">
                                    <div className="blanc-eyebrow">Eligibility</div>
                                    <StatusPicker
                                        label="Ignore job statuses"
                                        options={response.catalogs.job_statuses}
                                        selected={draft.ignored_job_statuses}
                                        onChange={ignored_job_statuses => setDraft(current => current ? { ...current, ignored_job_statuses } : current)}
                                    />
                                    <StatusPicker
                                        label="Ignore lead statuses"
                                        options={response.catalogs.lead_statuses}
                                        selected={draft.ignored_lead_statuses}
                                        onChange={ignored_lead_statuses => setDraft(current => current ? { ...current, ignored_lead_statuses } : current)}
                                    />
                                </section>

                                <section className="space-y-3.5">
                                    <div className="blanc-eyebrow">Judgment</div>
                                    <FloatingField
                                        id="inspector-instruction"
                                        label="Agent instruction"
                                        textarea
                                        rows={16}
                                        className="min-h-[360px]"
                                        value={draft.instruction}
                                        onChange={event => setDraft(current => current ? { ...current, instruction: event.target.value } : current)}
                                    />
                                    <p className="text-xs text-[var(--blanc-ink-3)]">
                                        Inspector applies this instruction separately to each eligible job or lead.
                                    </p>
                                </section>
                            </>
                        ) : null}
                    </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button
                        onClick={() => draft && saveMutation.mutate(draft)}
                        disabled={!draft || loading || saveMutation.isPending || !draft.instruction.trim()}
                    >
                        {saveMutation.isPending
                            ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
                            : 'Save settings'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
