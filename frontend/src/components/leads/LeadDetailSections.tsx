import { Edit, PhoneOff, CheckCircle2, Briefcase, Trash2, MoreVertical } from 'lucide-react';
import { format } from 'date-fns';
import type { Lead } from '../../types/lead';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';

export function MetadataSection({ lead }: { lead: Lead }) {
    const { customFields } = useLeadFormSettings();

    // Only show fields that have data
    const filledCustomFields = customFields.filter(f => lead.Metadata?.[f.api_name]);
    const hasCreatedDate = !!lead.CreatedDate;

    if (!hasCreatedDate && filledCustomFields.length === 0) return null;

    return (
        <div>
            <h4 className="blanc-eyebrow mb-2">Metadata</h4>
            <div className="space-y-2">
                {hasCreatedDate && (
                    <div>
                        <div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Created</div>
                        <div className="text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                            {format(new Date(lead.CreatedDate!), 'MMM dd, yyyy HH:mm')}
                        </div>
                    </div>
                )}
                {filledCustomFields.map(field => (
                    <div key={field.id}>
                        <div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{field.display_name}</div>
                        <div className="text-sm font-medium whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-1)' }}>
                            {lead.Metadata?.[field.api_name]}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

interface FooterProps {
    lead: Lead;
    onEdit: (lead: Lead) => void;
    onMarkLost: (uuid: string) => void;
    onActivate: (uuid: string) => void;
    onConvert: (uuid: string) => void;
    onDelete: (uuid: string) => void;
}

export function LeadDetailFooter({ lead, onEdit, onMarkLost, onActivate, onConvert, onDelete }: FooterProps) {
    return (
        <div className="px-5 py-3 shrink-0" style={{ background: 'var(--blanc-surface-strong)' }}>
            {lead.Status !== 'Converted' && !lead.LeadLost && (
                <div className="flex gap-2">
                    <button
                        onClick={() => onEdit(lead)}
                        className="inline-flex items-center justify-center gap-2 h-11 px-4 text-sm font-medium rounded-xl transition-colors"
                        style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-2)', background: 'var(--blanc-surface-strong)' }}
                    >
                        <Edit className="size-4" />Edit
                    </button>
                    <button
                        onClick={() => onConvert(lead.UUID)}
                        className="flex-1 inline-flex items-center justify-center gap-2 h-11 px-4 text-sm font-semibold rounded-xl transition-opacity"
                        style={{ background: 'var(--blanc-info)', color: '#fff' }}
                    >
                        <Briefcase className="size-4" />Convert to Job
                    </button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className="inline-flex items-center justify-center h-11 w-11 rounded-xl transition-colors"
                                style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-3)', background: 'var(--blanc-surface-strong)' }}
                            >
                                <MoreVertical className="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => onMarkLost(lead.UUID)} style={{ color: 'var(--blanc-warning)' }}>
                                <PhoneOff className="size-4 mr-2" />Mark Lost
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onDelete(lead.UUID)} className="text-destructive">
                                <Trash2 className="size-4 mr-2" />Delete Lead
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
            {(lead.Status === 'Converted' || lead.LeadLost) && (
                <div className="flex gap-2">
                    <button
                        onClick={() => onEdit(lead)}
                        className="inline-flex items-center justify-center gap-2 h-11 px-4 text-sm font-medium rounded-xl transition-colors"
                        style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-2)', background: 'var(--blanc-surface-strong)' }}
                    >
                        <Edit className="size-4" />Edit
                    </button>
                    {lead.LeadLost && (
                        <button
                            onClick={() => onActivate(lead.UUID)}
                            className="flex-1 inline-flex items-center justify-center gap-2 h-11 px-4 text-sm font-semibold rounded-xl transition-opacity"
                            style={{ background: 'var(--blanc-success)', color: '#fff' }}
                        >
                            <CheckCircle2 className="size-4" />Activate
                        </button>
                    )}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className="inline-flex items-center justify-center h-11 w-11 rounded-xl transition-colors"
                                style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-3)', background: 'var(--blanc-surface-strong)' }}
                            >
                                <MoreVertical className="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {!lead.LeadLost && (
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
            )}
        </div>
    );
}
