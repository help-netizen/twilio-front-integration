import { useState } from 'react';
import { Plus, Navigation, Play, CheckCircle2 } from 'lucide-react';
import type { LocalJob, JobTag } from '../../services/jobsApi';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { TagBadge } from './jobHelpers';
import { OnTheWayModal } from './OnTheWayModal';
import { useAuthz } from '../../hooks/useAuthz';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobOpsSectionProps {
    job: LocalJob;
    allTags: JobTag[];
    onTagsChange: (jobId: number, tagIds: number[]) => void;
    onMarkEnroute: (id: number) => void;
    onMarkInProgress: (id: number) => void;
    onMarkComplete: (id: number) => void;
    onCancel: (id: number) => void;
    /** Refresh the job after the "On the way" notification (afterMutation). */
    onNotified?: (id: number) => void;
}

// ONWAY-001 — pre-visit statuses where the "On the way" CTA is offered.
const ONWAY_SOURCE_STATUSES = ['Submitted', 'Rescheduled'];

// ─── Component ───────────────────────────────────────────────────────────────

export function JobOpsSection({
    job, allTags, onTagsChange,
    onMarkEnroute, onMarkInProgress, onMarkComplete, onNotified,
}: JobOpsSectionProps) {
    const isActionable = !job.zb_canceled && job.zb_status !== 'complete';
    const { hasPermission } = useAuthz();
    const [onWayOpen, setOnWayOpen] = useState(false);

    // ONWAY-001: primary CTA only from a pre-visit status, and only with messages.send.
    const showOnWayCta =
        ONWAY_SOURCE_STATUSES.includes(job.blanc_status) && hasPermission('messages.send');

    return (
        <div className="px-5 pb-4 space-y-3">
            {/* ── Tags ── */}
            <div className="flex items-center gap-1.5 flex-wrap">
                <span
                    className="text-[10px] font-semibold uppercase shrink-0 mr-0.5"
                    style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.08em' }}
                >
                    Tags
                </span>

                {job.tags && job.tags.length > 0 && job.tags.map((t: JobTag) => (
                    <button key={t.id} className="group/tag relative" title={`Remove "${t.name}"`}
                        onClick={() => {
                            const newIds = (job.tags || []).filter(x => x.id !== t.id).map(x => x.id);
                            onTagsChange(job.id, newIds);
                        }}>
                        <TagBadge tag={t} small />
                        <span className="absolute -top-1.5 -right-1.5 size-4 bg-destructive text-white rounded-full text-[9px] leading-4 text-center hidden group-hover/tag:block max-md:block">×</span>
                    </button>
                ))}

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button type="button"
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs transition-colors hover:bg-muted"
                            style={{ color: 'var(--blanc-ink-3)' }}>
                            <Plus className="size-3" /> Add
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56 max-h-72 overflow-y-auto p-1">
                        {(() => {
                            const assignedIds = new Set((job.tags || []).map(t => t.id));
                            const activeTags = allTags.filter(t => t.is_active);
                            const inactiveAssigned = allTags.filter(t => !t.is_active && assignedIds.has(t.id));
                            return [...activeTags, ...inactiveAssigned].map(t => {
                                const isAssigned = assignedIds.has(t.id);
                                const isInactive = !t.is_active;
                                return (
                                    <DropdownMenuItem key={t.id}
                                        disabled={isInactive && !isAssigned}
                                        onClick={() => {
                                            if (isInactive && !isAssigned) return;
                                            const currentIds = (job.tags || []).map(x => x.id);
                                            const newIds = isAssigned
                                                ? currentIds.filter(id => id !== t.id)
                                                : [...currentIds, t.id];
                                            onTagsChange(job.id, newIds);
                                        }}>
                                        <span className="flex items-center gap-2 w-full">
                                            <span className={`size-3 rounded-full shrink-0 ${isInactive ? 'opacity-40' : ''}`}
                                                style={{ backgroundColor: t.color }} />
                                            <span className={`flex-1 ${isInactive ? 'text-muted-foreground' : ''}`}>
                                                {t.name}
                                                {isInactive && <span className="text-[10px] ml-1 text-muted-foreground">(Archived)</span>}
                                            </span>
                                            {isAssigned && <CheckCircle2 className="size-3.5 text-primary" />}
                                        </span>
                                    </DropdownMenuItem>
                                );
                            });
                        })()}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* ── ONWAY-001: primary "On the way" CTA (pre-visit statuses) ── */}
            {showOnWayCta && (
                <button onClick={() => setOnWayOpen(true)}
                    className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-semibold"
                    style={{
                        minHeight: 40, borderRadius: 12,
                        background: 'linear-gradient(180deg, #f5874a 0%, #e06020 100%)',
                        color: '#fff', border: 'none',
                        boxShadow: '0 4px 12px rgba(224,96,32,0.25)',
                        cursor: 'pointer',
                    }}>
                    <Navigation className="size-4" /> On the way
                </button>
            )}

            {/* ── JOB-ACTIONS-SLIM-001: curated framed primary actions per state ── */}
            {isActionable && (
                <div className="flex items-stretch gap-2 max-md:flex-wrap">
                    {/* Submitted/scheduled → On the way (secondary outline) + Start job.
                        Suppressed when the ONWAY-001 primary CTA above already offers
                        "On the way" (same action) — otherwise a Submitted/Rescheduled
                        job with messages.send shows the button twice. Kept as the
                        fallback when the CTA is absent (no send perm, or a `scheduled`
                        job whose blanc_status isn't a pre-visit source status). */}
                    {job.zb_status === 'scheduled' && !showOnWayCta && (
                        <button onClick={() => onMarkEnroute(job.id)}
                            className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 text-sm font-semibold"
                            style={{
                                minHeight: 40, borderRadius: 12,
                                background: '#fff',
                                color: 'var(--blanc-ink-1)',
                                border: '1px solid var(--blanc-line)',
                                cursor: 'pointer',
                            }}>
                            <Navigation className="size-4" /> On the way
                        </button>
                    )}
                    {(job.zb_status === 'scheduled' || job.zb_status === 'en-route') && (
                        <button onClick={() => onMarkInProgress(job.id)}
                            className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 text-sm font-semibold"
                            style={{
                                minHeight: 40, borderRadius: 12,
                                background: 'linear-gradient(180deg, #f5874a 0%, #e06020 100%)',
                                color: '#fff', border: 'none',
                                boxShadow: '0 4px 12px rgba(224,96,32,0.25)',
                                cursor: 'pointer',
                            }}>
                            <Play className="size-4" /> Start job
                        </button>
                    )}
                    {job.zb_status === 'in-progress' && (
                        <button onClick={() => onMarkComplete(job.id)}
                            className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 text-sm font-semibold"
                            style={{
                                minHeight: 40, borderRadius: 12,
                                background: 'linear-gradient(180deg, #4ade80 0%, #22c55e 100%)',
                                color: '#fff', border: 'none',
                                boxShadow: '0 4px 12px rgba(34,197,94,0.25)',
                                cursor: 'pointer',
                            }}>
                            <CheckCircle2 className="size-4" /> Complete job
                        </button>
                    )}
                </div>
            )}

            {/* ── ONWAY-001: "On the way" modal ── */}
            {showOnWayCta && (
                <OnTheWayModal
                    open={onWayOpen}
                    onClose={() => setOnWayOpen(false)}
                    job={job}
                    onDone={() => onNotified?.(job.id)}
                />
            )}
        </div>
    );
}
