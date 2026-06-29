/**
 * JobTechnicianControl — assign / change / unassign the job's technician from the
 * Job detail card, WITHOUT touching the schedule (JOB-TECH-ASSIGN-001).
 *
 * Shows the current tech (or "Unassigned") + a "Change" button → a popover with a
 * searchable technician list and an Unassign row (with inline confirm). Reuses the
 * existing reassign endpoint (scheduleApi.reassignItem) which updates assigned_techs
 * and recalcs routes but never changes start/end. Gated on `schedule.dispatch`;
 * non-dispatchers see the tech read-only.
 */

import { useState, type CSSProperties } from 'react';
import { Pencil, Check, X, UserRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { LocalJob } from '../../services/jobsApi';
import { reassignItem } from '../../services/scheduleApi';
import { useAuthz } from '../../hooks/useAuthz';
import { useProviders } from '../../hooks/useProviders';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '../ui/command';

interface JobTechnicianControlProps {
    job: LocalJob;
    onJobUpdated?: (job: LocalJob) => void;
}

const eyebrow: CSSProperties = {
    fontSize: 11, fontWeight: 600, letterSpacing: '0.14em',
    textTransform: 'uppercase', color: 'var(--blanc-ink-3)', marginBottom: 8,
};

export function JobTechnicianControl({ job, onJobUpdated }: JobTechnicianControlProps) {
    const { hasPermission } = useAuthz();
    const canAssign = hasPermission('schedule.dispatch');

    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmingUnassign, setConfirmingUnassign] = useState(false);

    // Fetch the roster lazily — only for dispatchers, only once the popover opens.
    const { providers, loading } = useProviders(canAssign && open);

    const currentTech = job.assigned_techs?.[0] ?? null;
    const currentId = currentTech?.id != null ? String(currentTech.id) : null;

    const doReassign = async (id: string | null, name: string | null) => {
        if (busy) return;
        if (id === currentId) { setOpen(false); return; } // no-op reselect
        setBusy(true);
        try {
            await reassignItem('job', job.id, id, name);      // assignee only — no time change
            toast.success(id ? `Assigned to ${name}` : 'Technician unassigned');
            onJobUpdated?.({ ...job, assigned_techs: id ? [{ id, name: name || '' }] : [] });
            setOpen(false);
            setConfirmingUnassign(false);
        } catch (err) {
            toast.error('Failed to update technician', {
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <p style={eyebrow}>Technician</p>
            <div className="flex items-center gap-2 flex-wrap">
                {currentTech ? (
                    <span
                        className="inline-flex items-center gap-1.5 min-h-[34px] px-3.5 rounded-full text-[13px] font-medium"
                        style={{ background: 'rgba(117,106,89,0.07)', border: '1px solid rgba(117,106,89,0.14)', color: 'var(--blanc-ink-1)' }}
                    >
                        <UserRound className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                        {currentTech.name}
                    </span>
                ) : (
                    <span className="text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>Unassigned</span>
                )}

                {canAssign && (
                    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setConfirmingUnassign(false); }}>
                        <PopoverTrigger asChild>
                            <button
                                type="button"
                                className="inline-flex items-center gap-1 min-h-[34px] px-3 rounded-full text-[12px] font-semibold transition-opacity hover:opacity-70"
                                style={{ border: '1px solid rgba(117,106,89,0.18)', color: 'var(--blanc-ink-2)', background: '#fff' }}
                            >
                                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Pencil className="size-3.5" />}
                                {currentTech ? 'Change' : 'Assign'}
                            </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="p-0 w-[260px]">
                            <Command>
                                <CommandInput placeholder="Search technicians…" />
                                <CommandList>
                                    {loading ? (
                                        <div className="py-6 flex justify-center">
                                            <Loader2 className="size-4 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
                                        </div>
                                    ) : (
                                        <>
                                            <CommandEmpty>No technicians found.</CommandEmpty>
                                            <CommandGroup>
                                                {providers.map((p) => (
                                                    <CommandItem key={p.id} value={p.name} onSelect={() => doReassign(p.id, p.name)}>
                                                        <Check className={`mr-2 size-4 ${currentId === p.id ? 'opacity-100' : 'opacity-0'}`} />
                                                        {p.name}
                                                    </CommandItem>
                                                ))}
                                            </CommandGroup>
                                        </>
                                    )}
                                </CommandList>
                            </Command>

                            {currentTech && (
                                <div className="border-t p-2" style={{ borderColor: 'rgba(117,106,89,0.14)' }}>
                                    {confirmingUnassign ? (
                                        <div className="flex items-center justify-between gap-2 px-1">
                                            <span className="text-[12px]" style={{ color: 'var(--blanc-ink-2)' }}>Remove {currentTech.name}?</span>
                                            <div className="flex items-center gap-1.5 shrink-0">
                                                <button
                                                    type="button"
                                                    onClick={() => doReassign(null, null)}
                                                    disabled={busy}
                                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-semibold text-white disabled:opacity-50"
                                                    style={{ background: 'var(--blanc-danger, #d44d3c)' }}
                                                >
                                                    {busy ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />} Remove
                                                </button>
                                                <button type="button" onClick={() => setConfirmingUnassign(false)} className="px-2.5 py-1 rounded-lg text-[12px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => setConfirmingUnassign(true)}
                                            className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-[13px] transition-colors hover:bg-black/[0.03]"
                                            style={{ color: 'var(--blanc-danger, #d44d3c)' }}
                                        >
                                            <X className="size-4" /> Unassign technician
                                        </button>
                                    )}
                                </div>
                            )}
                        </PopoverContent>
                    </Popover>
                )}
            </div>
        </div>
    );
}
