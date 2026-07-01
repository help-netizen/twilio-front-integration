/**
 * JobTechnicianControl — assign / change / unassign the job's provider(s) from the
 * Job detail card, WITHOUT touching the schedule (JOB-TECH-ASSIGN-001).
 *
 * Multi-select (JOB-PROVIDER-MULTI-001): pick one OR many providers, then Save —
 * the change is pushed to Zenbooker server-side. Gated on `schedule.dispatch`;
 * non-dispatchers see the providers read-only. On desktop the picker is a popover;
 * on mobile it's the canonical bottom sheet.
 */

import { useState, useEffect, type CSSProperties } from 'react';
import { Pencil, Check, UserRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { LocalJob } from '../../services/jobsApi';
import { setJobProviders } from '../../services/scheduleApi';
import { useAuthz } from '../../hooks/useAuthz';
import { useProviders } from '../../hooks/useProviders';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '../ui/command';
import { BottomSheet } from '../ui/BottomSheet';
import { Button } from '../ui/button';

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
    const isMobile = useIsMobile();

    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());

    // Fetch the roster lazily — only for dispatchers, only once the picker opens.
    const { providers, loading } = useProviders(canAssign && open);

    const assigned = job.assigned_techs ?? [];

    // Seed the selection from the job's current providers each time the picker opens.
    useEffect(() => {
        if (open) setSelected(new Set(assigned.map(t => String(t.id))));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const toggle = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const save = async () => {
        if (busy) return;
        setBusy(true);
        // Build [{id,name}] for the selected set — names from the roster, falling back
        // to the existing chips (a currently-assigned provider might not be in the
        // freshly-loaded roster, e.g. deactivated).
        const nameById = new Map<string, string>();
        for (const t of assigned) nameById.set(String(t.id), t.name || '');
        for (const p of providers) nameById.set(p.id, p.name || '');
        const list = [...selected].map(id => ({ id, name: nameById.get(id) || '' }));
        try {
            await setJobProviders(job.id, list);
            toast.success(list.length ? 'Providers updated' : 'Providers cleared');
            onJobUpdated?.({ ...job, assigned_techs: list });
            setOpen(false);
        } catch (err) {
            toast.error('Failed to update providers', {
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setBusy(false);
        }
    };

    // The picker body — shared by the desktop popover and the mobile bottom sheet.
    const picker = (
        <div>
            <Command>
                <CommandInput placeholder="Search providers…" />
                <CommandList>
                    {loading ? (
                        <div className="py-6 flex justify-center">
                            <Loader2 className="size-4 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
                        </div>
                    ) : (
                        <>
                            <CommandEmpty>No providers found.</CommandEmpty>
                            <CommandGroup>
                                {providers.map((p) => (
                                    <CommandItem key={p.id} value={p.name} onSelect={() => toggle(p.id)}>
                                        <Check className={`mr-2 size-4 ${selected.has(p.id) ? 'opacity-100' : 'opacity-0'}`} />
                                        {p.name}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </>
                    )}
                </CommandList>
            </Command>
            <div className="flex items-center justify-between gap-2 border-t p-2" style={{ borderColor: 'rgba(117,106,89,0.14)' }}>
                <span className="text-[12px] pl-1" style={{ color: 'var(--blanc-ink-3)' }}>
                    {selected.size} selected
                </span>
                <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                    <Button size="sm" onClick={save} disabled={busy}>
                        {busy ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}Save
                    </Button>
                </div>
            </div>
        </div>
    );

    const changeBtn = (
        <button
            type="button"
            onClick={isMobile ? () => setOpen(true) : undefined}
            className="inline-flex items-center gap-1 min-h-[34px] px-3 rounded-full text-[12px] font-semibold transition-opacity hover:opacity-70"
            style={{ border: '1px solid rgba(117,106,89,0.18)', color: 'var(--blanc-ink-2)', background: '#fff' }}
        >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Pencil className="size-3.5" />}
            {assigned.length ? 'Change' : 'Assign'}
        </button>
    );

    return (
        <div>
            <p style={eyebrow}>Provider</p>
            <div className="flex items-center gap-2 flex-wrap">
                {assigned.length > 0 ? (
                    assigned.map((t) => (
                        <span
                            key={t.id}
                            className="inline-flex items-center gap-1.5 min-h-[34px] px-3.5 rounded-full text-[13px] font-medium"
                            style={{ background: 'rgba(117,106,89,0.07)', border: '1px solid rgba(117,106,89,0.14)', color: 'var(--blanc-ink-1)' }}
                        >
                            <UserRound className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                            {t.name}
                        </span>
                    ))
                ) : (
                    <span className="text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>Unassigned</span>
                )}

                {canAssign && !isMobile && (
                    <Popover open={open} onOpenChange={setOpen}>
                        <PopoverTrigger asChild>{changeBtn}</PopoverTrigger>
                        <PopoverContent align="start" className="p-0 w-[280px]">
                            {picker}
                        </PopoverContent>
                    </Popover>
                )}

                {canAssign && isMobile && (
                    <>
                        {changeBtn}
                        <BottomSheet
                            open={open}
                            onClose={() => setOpen(false)}
                            size="auto"
                            title={assigned.length ? 'Change provider' : 'Assign provider'}
                        >
                            {picker}
                        </BottomSheet>
                    </>
                )}
            </div>
        </div>
    );
}
