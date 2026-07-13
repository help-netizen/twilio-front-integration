import { Badge } from '../ui/badge';
import { X } from 'lucide-react';
import { JOB_SOURCES } from '../../types/lead';
import { LEAD_STATUS_COLORS } from './leadStatusStyles';
import { useAuthz } from '../../hooks/useAuthz';

// ─── LeadsFilterBody ────────────────────────────────────────────────────────────
// The active-filter chip row + the 3 FilterColumns (STATUS / SOURCE / JOB TYPE).
// Extracted verbatim from LeadsFilters' inline `filterContent` so it can be reused
// by BOTH the desktop popover / mobile sheet (LeadsFilters) and the mobile
// "View options" sheet (LeadsMobileBar). Markup/behavior must stay identical to
// the previous inline version — this is a pure move-out.

interface LeadsFilterBodyProps {
    statusFilter: string[]; onToggleStatus: (status: string) => void;
    sourceFilter: string[]; onToggleSource: (source: string) => void;
    jobTypeFilter: string[]; onToggleJobType: (type: string) => void;
    rejectedOnly: boolean; onToggleRejected: () => void;
    /** Statuses to offer — FSM states when available, else LEAD_STATUSES. */
    statuses: string[];
    /** Job-type names from lead-form settings. */
    dynamicJobTypes: string[];
    onClearAll: () => void;
}

export function LeadsFilterBody({
    statusFilter, onToggleStatus,
    sourceFilter, onToggleSource,
    jobTypeFilter, onToggleJobType,
    rejectedOnly, onToggleRejected,
    statuses, dynamicJobTypes, onClearAll,
}: LeadsFilterBodyProps) {
    const { hasPermission } = useAuthz();
    const canViewSource = hasPermission('lead_source.view');
    const activeFilterCount = statusFilter.length + sourceFilter.length + jobTypeFilter.length + (rejectedOnly ? 1 : 0);

    return (
        <>
            {/* Active filter badges */}
            {activeFilterCount > 0 && (
                <div className="flex flex-wrap gap-1.5 p-3 pb-0 items-center">
                    {statusFilter.map(s => (
                        <Badge key={`s-${s}`} variant="secondary" className="gap-1 text-xs">
                            {s}
                            <X className="size-3 cursor-pointer" onClick={() => onToggleStatus(s)} />
                        </Badge>
                    ))}
                    {canViewSource && sourceFilter.map(s => (
                        <Badge key={`src-${s}`} variant="outline" className="gap-1 text-xs">
                            {s}
                            <X className="size-3 cursor-pointer" onClick={() => onToggleSource(s)} />
                        </Badge>
                    ))}
                    {jobTypeFilter.map(t => (
                        <Badge key={`jt-${t}`} variant="default" className="gap-1 text-xs">
                            {t}
                            <X className="size-3 cursor-pointer" onClick={() => onToggleJobType(t)} />
                        </Badge>
                    ))}
                    {rejectedOnly && (
                        <Badge variant="outline" className="gap-1 text-xs">
                            Rejected
                            <X className="size-3 cursor-pointer" onClick={onToggleRejected} />
                        </Badge>
                    )}
                    <button
                        onClick={onClearAll}
                        className="text-xs ml-1 transition-opacity hover:opacity-70"
                        style={{ color: 'var(--blanc-ink-3)' }}
                    >
                        Clear all
                    </button>
                </div>
            )}

            {/* Columns */}
            <div className="grid grid-cols-1 sm:grid-cols-4 p-3 gap-3 sm:gap-0" style={{ borderTop: activeFilterCount > 0 ? '1px solid var(--blanc-line)' : undefined, marginTop: activeFilterCount > 0 ? 8 : 0 }}>
                <FilterColumn title="STATUS" items={statuses} selected={statusFilter} onToggle={onToggleStatus} colorMap={LEAD_STATUS_COLORS} />
                {canViewSource && <FilterColumn title="SOURCE" items={JOB_SOURCES as unknown as string[]} selected={sourceFilter} onToggle={onToggleSource} />}
                <FilterColumn title="JOB TYPE" items={dynamicJobTypes} selected={jobTypeFilter} onToggle={onToggleJobType} />
                <FilterColumn title="FLAGS" items={['Rejected']} selected={rejectedOnly ? ['Rejected'] : []} onToggle={onToggleRejected} />
            </div>
        </>
    );
}

/* ────────────── Filter Column sub-component ────────────── */

export function FilterColumn({
    title,
    items,
    selected,
    onToggle,
    colorMap,
}: {
    title: string;
    items: string[];
    selected: string[];
    onToggle: (item: string) => void;
    colorMap?: Record<string, string>;
}) {
    return (
        <div className="px-3 space-y-1">
            <div
                className="text-[11px] font-semibold tracking-wider uppercase mb-2"
                style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.08em' }}
            >
                {title}
            </div>
            <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                {items.map((item) => {
                    const isSelected = selected.includes(item);
                    const dotColor = colorMap?.[item];
                    return (
                        <button
                            key={item}
                            type="button"
                            onClick={() => onToggle(item)}
                            className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-lg text-sm transition-colors"
                            style={{
                                background: isSelected ? 'rgba(37, 99, 235, 0.08)' : undefined,
                                color: isSelected ? 'var(--blanc-info)' : 'var(--blanc-ink-1)',
                                fontWeight: isSelected ? 500 : 400,
                            }}
                        >
                            {dotColor && (
                                <span
                                    className="shrink-0 rounded-full"
                                    style={{ width: 10, height: 10, background: dotColor, opacity: isSelected ? 1 : 0.55, flexShrink: 0 }}
                                />
                            )}
                            {item}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
