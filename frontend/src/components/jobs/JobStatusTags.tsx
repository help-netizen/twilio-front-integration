import { Tag, ChevronDown, Plus, CheckCircle2, CircleDot } from 'lucide-react';
import type { LocalJob, JobTag } from '../../services/jobsApi';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { BLANC_STATUSES, TagBadge, BlancBadge, ZbBadge } from './jobHelpers';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobStatusTagsProps {
    job: LocalJob;
    allTags: JobTag[];
    onBlancStatusChange: (id: number, s: string) => void;
    onTagsChange: (jobId: number, tagIds: number[]) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function JobStatusTags({ job, allTags, onBlancStatusChange, onTagsChange }: JobStatusTagsProps) {
    return (
        <>
            {/* Status row */}
            <div className="flex items-center gap-2 px-4 py-3">
                <CircleDot className="size-4 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground font-medium shrink-0">Status:</span>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button className="inline-flex items-center gap-1 focus:outline-none rounded-sm">
                            <BlancBadge status={job.blanc_status} />
                            <ChevronDown className="size-3 text-muted-foreground" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        {BLANC_STATUSES.map(s => (
                            <DropdownMenuItem
                                key={s}
                                onClick={() => onBlancStatusChange(job.id, s)}
                                className={s === job.blanc_status ? 'bg-accent' : ''}
                            >
                                {s}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
                {job.zb_status && <ZbBadge status={job.zb_status} />}
            </div>

            {/* Tag selector */}
            <div className="flex items-center gap-2 px-4 py-3 flex-wrap">
                <Tag className="size-4 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground font-medium shrink-0">Tags:</span>
                {job.tags && job.tags.length > 0 && job.tags.map((t: JobTag) => (
                    <button
                        key={t.id}
                        onClick={() => {
                            const newIds = (job.tags || []).filter(x => x.id !== t.id).map(x => x.id);
                            onTagsChange(job.id, newIds);
                        }}
                        className="group relative"
                        title={`Remove "${t.name}"`}
                    >
                        <TagBadge tag={t} />
                        <span className="absolute -top-1.5 -right-1.5 size-4 bg-destructive text-white rounded-full text-[9px] leading-4 text-center hidden group-hover:block">×</span>
                    </button>
                ))}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:bg-muted transition-colors">
                            <Plus className="size-3" /> Add
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56 max-h-72 overflow-y-auto p-1">
                        {(() => {
                            const assignedIds = new Set((job.tags || []).map(t => t.id));
                            const activeTags = allTags.filter(t => t.is_active);
                            const inactiveAssigned = allTags.filter(t => !t.is_active && assignedIds.has(t.id));
                            const combined = [...activeTags, ...inactiveAssigned];
                            return combined.map(t => {
                                const isAssigned = assignedIds.has(t.id);
                                const isInactive = !t.is_active;
                                return (
                                    <DropdownMenuItem
                                        key={t.id}
                                        disabled={isInactive && !isAssigned}
                                        onClick={() => {
                                            if (isInactive && !isAssigned) return;
                                            const currentIds = (job.tags || []).map(x => x.id);
                                            const newIds = isAssigned
                                                ? currentIds.filter(id => id !== t.id)
                                                : [...currentIds, t.id];
                                            onTagsChange(job.id, newIds);
                                        }}
                                    >
                                        <span className="flex items-center gap-2 w-full">
                                            <span
                                                className={`size-3 rounded-full shrink-0 ${isInactive ? 'opacity-40' : ''}`}
                                                style={{ backgroundColor: t.color }}
                                            />
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
        </>
    );
}
