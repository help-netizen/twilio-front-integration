import { ChevronDown, RotateCcw } from 'lucide-react';
import type { Lead } from '../../types/lead';
import { LEAD_STATUSES } from '../../types/lead';
import { useFsmActions, useFsmStates } from '../../hooks/useFsmActions';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { getLeadStatusPillStyle } from './leadStatusStyles';

interface LeadStatusDropdownProps {
    lead: Lead;
    onUpdateStatus: (uuid: string, status: string) => void;
    compact?: boolean;
}

/**
 * One DB-driven status control for both the full LeadDetailPanel and Pulse bar.
 * The full-pill shape, tint, and leading dot distinguish state from an action.
 */
export function LeadStatusDropdown({ lead, onUpdateStatus, compact = false }: LeadStatusDropdownProps) {
    const { data: fsmData } = useFsmStates('lead', true);
    const allStatuses = fsmData?.states && fsmData.states.length > 0
        ? fsmData.states
        : (LEAD_STATUSES as unknown as string[]);
    const initialState = fsmData?.initialState || null;
    const { data: fsmActions } = useFsmActions('lead', lead.Status);
    const allowedTargets = new Set(fsmActions?.map(action => action.target) || []);
    const reachable = allStatuses.filter(status => status !== lead.Status && allowedTargets.has(status));
    const unreachable = allStatuses.filter(status => status !== lead.Status && !allowedTargets.has(status));
    const canReset = initialState && lead.Status !== initialState;
    const pill = getLeadStatusPillStyle(lead.Status);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={['lead-status-pill', compact ? 'lead-status-pill-compact' : '', 'inline-flex items-center font-semibold transition-opacity focus:outline-none'].filter(Boolean).join(' ')}
                    style={{
                        minHeight: compact ? 26 : 42,
                        padding: compact ? '0 10px' : '0 14px',
                        gap: compact ? 6 : 7,
                        borderRadius: 999,
                        border: '1px solid ' + pill.border,
                        background: pill.bg,
                        color: pill.color,
                        fontSize: compact ? 11 : 14,
                        whiteSpace: 'nowrap',
                    }}
                    aria-label={'Lead status: ' + lead.Status}
                >
                    <span
                        className="lead-status-pill-dot"
                        aria-hidden
                        style={{ width: 7, height: 7, borderRadius: 999, background: pill.color, flex: '0 0 auto' }}
                    />
                    {lead.Status}
                    <ChevronDown aria-hidden className={compact ? 'size-[13px]' : 'size-3.5'} />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                {reachable.map(status => (
                    <DropdownMenuItem key={status} onClick={() => onUpdateStatus(lead.UUID, status)}>
                        {status}
                    </DropdownMenuItem>
                ))}
                {unreachable.length > 0 && reachable.length > 0 && <div className="my-1" />}
                {unreachable.map(status => (
                    <DropdownMenuItem key={status} disabled className="text-[var(--blanc-ink-3)] opacity-50">
                        {status}
                    </DropdownMenuItem>
                ))}
                {canReset && (
                    <>
                        <div className="my-1.5 mx-2 h-px" style={{ background: 'var(--blanc-line)' }} />
                        <DropdownMenuItem
                            onClick={() => onUpdateStatus(lead.UUID, initialState!)}
                            className="flex items-center gap-2 text-xs font-medium mx-1 mb-1 rounded-md"
                            style={{ background: 'rgba(25,25,25,0.06)', color: 'var(--blanc-ink-2)' }}
                        >
                            <RotateCcw className="size-3" />
                            Reset to {initialState}
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
