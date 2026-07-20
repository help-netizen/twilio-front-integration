import { Briefcase, CheckCircle2, Edit, MoreVertical, PhoneOff, Trash2 } from 'lucide-react';
import type { Lead } from '../../types/lead';
import { PulsePinnedBarAction } from '../pulse/PulsePinnedBar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';

type LeadActionSubject = Pick<Lead, 'Status' | 'LeadLost'>;

export function getLeadActionVisibility(lead: LeadActionSubject) {
    const lost = Boolean(lead.LeadLost);
    return {
        showConvert: lead.Status !== 'Converted' && !lost,
        showActivate: lost,
        showMarkLost: !lost,
    };
}

interface LeadActionButtonsProps {
    lead: Lead;
    variant: 'bar' | 'footer';
    onEdit: (lead: Lead) => void;
    onMarkLost: (uuid: string) => void;
    onActivate: (uuid: string) => void;
    onConvert: (uuid: string) => void;
    onDelete: (uuid: string) => void;
}

const footerIconStyle = {
    width: 42,
    height: 42,
    borderRadius: 14,
    border: '1px solid rgba(104, 95, 80, 0.14)',
    color: 'var(--blanc-ink-3)',
    background: 'var(--blanc-surface-strong)',
    boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px',
};

export function LeadActionButtons({
    lead, variant, onEdit, onMarkLost, onActivate, onConvert, onDelete,
}: LeadActionButtonsProps) {
    const visibility = getLeadActionVisibility(lead);
    const isBar = variant === 'bar';

    const editButton = isBar ? (
        <PulsePinnedBarAction
            label="Edit"
            icon={<Edit aria-hidden />}
            onClick={() => onEdit(lead)}
        />
    ) : (
        <button type="button" aria-label="Edit lead" title="Edit lead" onClick={() => onEdit(lead)} className="inline-flex items-center justify-center transition-opacity hover:opacity-70" style={footerIconStyle}>
            <Edit className="size-4" />
        </button>
    );

    const convertButton = visibility.showConvert && (isBar ? (
        <PulsePinnedBarAction
            className="is-info-primary"
            label="Convert to Job"
            icon={<Briefcase aria-hidden />}
            onClick={() => onConvert(lead.UUID)}
        />
    ) : (
        <button type="button" onClick={() => onConvert(lead.UUID)} className="inline-flex items-center justify-center gap-2 px-5 text-sm font-semibold transition-opacity hover:opacity-85" style={{ background: 'var(--blanc-info)', color: 'var(--blanc-surface-strong)', minHeight: 42, borderRadius: 14, border: 'none', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}>
            <Briefcase className="size-4" />Convert to Job
        </button>
    ));

    const activateButton = visibility.showActivate && (isBar ? (
        <PulsePinnedBarAction
            className="is-success"
            label="Activate"
            icon={<CheckCircle2 aria-hidden />}
            onClick={() => onActivate(lead.UUID)}
        />
    ) : (
        <button type="button" onClick={() => onActivate(lead.UUID)} className="inline-flex items-center justify-center gap-2 px-5 text-sm font-semibold transition-opacity hover:opacity-85" style={{ background: 'var(--blanc-success)', color: 'var(--blanc-surface-strong)', minHeight: 42, borderRadius: 14, border: 'none', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}>
            <CheckCircle2 className="size-4" />Activate
        </button>
    ));

    return (
        <div className={isBar ? 'pulse-lead-bar-actions' : 'flex gap-2'}>
            {editButton}
            {convertButton}
            {activateButton}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    {isBar ? (
                        <PulsePinnedBarAction
                            label="More lead actions"
                            icon={<MoreVertical aria-hidden />}
                            showLabel={false}
                        />
                    ) : (
                        <button type="button" aria-label="More lead actions" title="More lead actions" className="inline-flex items-center justify-center transition-opacity hover:opacity-70" style={footerIconStyle}>
                            <MoreVertical className="size-4" />
                        </button>
                    )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {visibility.showMarkLost && (
                        <DropdownMenuItem onClick={() => onMarkLost(lead.UUID)} style={{ color: 'var(--blanc-warning)' }}>
                            <PhoneOff className="size-4 mr-2" />Mark Lost
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => onDelete(lead.UUID)} className="text-destructive">
                        <Trash2 className="size-4 mr-2" />Delete Lead
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
