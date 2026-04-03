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
        <div className="px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))] shrink-0" style={{ background: 'var(--blanc-surface-strong)', borderTop: '1px solid var(--blanc-line)' }}>
            {lead.Status !== 'Converted' && !lead.LeadLost && (
                <div className="flex gap-2">
                    <button
                        onClick={() => onEdit(lead)}
                        className="inline-flex items-center justify-center transition-opacity hover:opacity-70"
                        style={{ width: 42, height: 42, borderRadius: 14, border: '1px solid rgba(104, 95, 80, 0.14)', color: 'var(--blanc-ink-3)', background: 'var(--blanc-surface-strong)', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
                    >
                        <Edit className="size-4" />
                    </button>
                    <button
                        onClick={() => onConvert(lead.UUID)}
                        className="inline-flex items-center justify-center gap-2 px-5 text-sm font-semibold transition-opacity hover:opacity-85"
                        style={{ background: 'var(--blanc-info)', color: '#fff', minHeight: 42, borderRadius: 14, border: 'none', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
                    >
                        <Briefcase className="size-4" />Convert to Job
                    </button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className="inline-flex items-center justify-center transition-opacity hover:opacity-70"
                                style={{ width: 42, height: 42, borderRadius: 14, border: '1px solid rgba(104, 95, 80, 0.14)', color: 'var(--blanc-ink-3)', background: 'var(--blanc-surface-strong)', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
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
                        className="inline-flex items-center justify-center transition-opacity hover:opacity-70"
                        style={{ width: 42, height: 42, borderRadius: 14, border: '1px solid rgba(104, 95, 80, 0.14)', color: 'var(--blanc-ink-3)', background: 'var(--blanc-surface-strong)', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
                    >
                        <Edit className="size-4" />
                    </button>
                    {lead.LeadLost && (
                        <button
                            onClick={() => onActivate(lead.UUID)}
                            className="inline-flex items-center justify-center gap-2 px-5 text-sm font-semibold transition-opacity hover:opacity-85"
                            style={{ background: 'var(--blanc-success)', color: '#fff', minHeight: 42, borderRadius: 14, border: 'none', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
                        >
                            <CheckCircle2 className="size-4" />Activate
                        </button>
                    )}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className="inline-flex items-center justify-center transition-opacity hover:opacity-70"
                                style={{ width: 42, height: 42, borderRadius: 14, border: '1px solid rgba(104, 95, 80, 0.14)', color: 'var(--blanc-ink-3)', background: 'var(--blanc-surface-strong)', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
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
