import { type CSSProperties, type ReactNode } from 'react';
import {
    Plus, Navigation, Play, CheckCircle2, X, Ban, RotateCcw, ArrowRight, Wrench, PhoneCall,
    type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { LocalJob, JobTag } from '../../services/jobsApi';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { TagBadge } from './jobHelpers';
import { JobRateMeBlock } from './JobRateMeBlock';
import { useAuthz } from '../../hooks/useAuthz';
import { useFsmActions, useApplyTransition, useFsmStates, type FsmAction } from '../../hooks/useFsmActions';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobOpsSectionProps {
    job: LocalJob;
    allTags: JobTag[];
    onTagsChange: (jobId: number, tagIds: number[]) => void;
    /** Cancel opens the reason dialog (a terminal action kept outside the FSM button row). */
    onCancel: (id: number) => void;
    /** Refresh the job after the "On the way" notification (afterMutation). */
    onNotified?: (id: number) => void;
    /** FSM-SYSTEM-TRANSITIONS-001: open the notify-ETA modal after a plain transition
     *  into an arrival_eta status (the panel owns the modal). */
    onRequestEta?: (id: number) => void;
}

// FSM-JOB-ACTIONS-001 — job status buttons are rendered from the per-company FSM's
// action-transitions (blanc:action + blanc:button) and applied through POST /api/fsm/job/apply,
// which validates the transition against the published graph. No more hardcoded zb_status.

const ICON_MAP: Record<string, LucideIcon> = {
    Navigation, Play, CheckCircle2, X, Ban, RotateCcw, ArrowRight, Wrench, PhoneCall,
};

/** Icon from the SCXML `blanc:icon`, else a sensible default by op/variant. */
function actionIcon(action: FsmAction): ReactNode {
    const Named = action.icon ? ICON_MAP[action.icon] : undefined;
    const Ico = Named
        || (action.op === 'arrival_eta' ? Navigation
            : action.variant === 'success' ? CheckCircle2
                : action.variant === 'danger' ? Ban
                    : undefined);
    return Ico ? <Ico className="size-4" /> : null;
}

const BTN_BASE: CSSProperties = { minHeight: 40, borderRadius: 12, cursor: 'pointer' };

/** Map the FSM `blanc:variant` to a button style (on-brand: violet primary, green success…). */
function variantStyle(variant: string): CSSProperties {
    switch (variant) {
        case 'success':
            return { ...BTN_BASE, background: 'linear-gradient(180deg, #4ade80 0%, #22c55e 100%)', color: '#fff', border: 'none', boxShadow: '0 4px 12px rgba(34,197,94,0.25)' };
        case 'danger':
            return { ...BTN_BASE, background: '#fff', color: 'var(--blanc-danger)', border: '1px solid var(--blanc-danger)' };
        case 'secondary':
            return { ...BTN_BASE, background: '#fff', color: 'var(--blanc-ink-1)', border: '1px solid var(--blanc-line)' };
        case 'neutral':
            return { ...BTN_BASE, background: '#fff', color: 'var(--blanc-ink-2)', border: '1px solid var(--blanc-line)' };
        case 'primary':
        default:
            return { ...BTN_BASE, background: 'var(--blanc-accent)', color: '#fff', border: 'none', boxShadow: '0 4px 12px rgba(127,66,225,0.22)' };
    }
}

// ─── Component ───────────────────────────────────────────────────────────────

export function JobOpsSection({
    job, allTags, onTagsChange, onCancel, onNotified, onRequestEta,
}: JobOpsSectionProps) {
    const { hasPermission } = useAuthz();

    const { data: fsmActions } = useFsmActions('job', job.blanc_status);
    const applyMutation = useApplyTransition('job');
    const { data: fsmStates } = useFsmStates('job', true);
    const initialState = fsmStates?.initialState || null;

    // Prominent buttons = FSM action-transitions flagged blanc:button (server-defaulted), by order,
    // EXCEPT the corrective/terminal ones: Cancel (→ Canceled) and "back to the start" (→ the
    // initial state, e.g. Back to Submitted) stay dropdown-only in the JobDetailHeader status picker.
    const buttons = (fsmActions || [])
        .filter(a => a.button && a.target !== 'Canceled' && a.target !== initialState)
        .slice()
        .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));

    const runAction = async (action: FsmAction) => {
        if (applyMutation.isPending) return;
        // Cancel keeps its dedicated reason dialog (always-available terminal action).
        if (action.target === 'Canceled') { onCancel(job.id); return; }
        if (action.confirm && !window.confirm(action.confirmText || `${action.label}?`)) return;
        try {
            await applyMutation.mutateAsync({ entityId: job.id, event: action.event });
            toast.success(`${action.label} — done`);
            // FSM-SYSTEM-TRANSITIONS-001: "On the way" is a plain transition (status
            // already changed above). If the target carries the arrival_eta op and the
            // user can message, offer the notify-ETA modal afterwards — closing it never
            // reverts the status.
            if (action.op === 'arrival_eta' && hasPermission('messages.send')) {
                onRequestEta?.(job.id);
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Action failed');
        }
    };

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

            {/* ── FSM-driven status actions (FSM-JOB-ACTIONS-001) ── */}
            {buttons.length > 0 && (
                <div className="flex items-stretch gap-2 max-md:flex-wrap">
                    {buttons.map((action) => (
                        <button
                            key={action.event}
                            onClick={() => runAction(action)}
                            disabled={applyMutation.isPending}
                            className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 text-sm font-semibold transition-opacity disabled:opacity-60"
                            style={variantStyle(action.variant)}
                        >
                            {actionIcon(action)} {action.label}
                        </button>
                    ))}
                </div>
            )}

            <JobRateMeBlock
                jobId={job.id}
                customerName={job.customer_name}
                customerPhone={job.customer_phone}
                customerEmail={job.customer_email}
                technicianName={job.assigned_techs?.[0]?.name}
                canSend={hasPermission('messages.send')}
                onSent={onNotified}
            />
        </div>
    );
}
