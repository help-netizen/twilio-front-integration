import { Calendar, Tag, FileText, Edit, PhoneOff, CheckCircle2, Briefcase, Trash2, MoreVertical } from 'lucide-react';
import { format } from 'date-fns';
import type { Lead } from '../../types/lead';
import { Label } from '../ui/label';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';

export function MetadataSection({ lead }: { lead: Lead }) {
    const { customFields } = useLeadFormSettings();

    return (
        <div>
            <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--blanc-ink-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Metadata</h4>
            <div className="space-y-3">
                <div className="flex items-start gap-3"><Tag className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Job Source</Label><div className="text-sm font-medium mt-1">{lead.JobSource || <span className="text-muted-foreground">N/A</span>}</div></div></div>
                <div className="flex items-start gap-3"><Calendar className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Created Date</Label><div className="text-sm font-medium mt-1">{lead.CreatedDate ? format(new Date(lead.CreatedDate), 'MMM dd, yyyy HH:mm') : 'N/A'}</div></div></div>
                {customFields.map(field => (
                    <div key={field.id} className="flex items-start gap-3"><FileText className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">{field.display_name}</Label><div className="text-sm font-medium mt-1 whitespace-pre-wrap">{lead.Metadata?.[field.api_name] || <span className="text-muted-foreground">N/A</span>}</div></div></div>
                ))}
            </div>
        </div>
    );
}

interface FooterProps { lead: Lead; onEdit: (lead: Lead) => void; onMarkLost: (uuid: string) => void; onActivate: (uuid: string) => void; onConvert: (uuid: string) => void; onDelete: (uuid: string) => void; }

export function LeadDetailFooter({ lead, onEdit, onMarkLost, onActivate, onConvert, onDelete }: FooterProps) {
    return (
        <div className="px-5 py-3 shrink-0" style={{ borderTop: '1px solid var(--blanc-line)', background: '#fff' }}>
            {lead.Status !== 'Converted' && !lead.LeadLost && (
                <div className="flex gap-2">
                    <button onClick={() => onEdit(lead)} className="inline-flex items-center justify-center gap-2 h-11 px-4 text-sm font-medium rounded-xl transition-colors" style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-2)', background: '#fff' }}><Edit className="size-4" />Edit</button>
                    <button onClick={() => onConvert(lead.UUID)} className="flex-1 inline-flex items-center justify-center gap-2 h-11 px-4 text-sm font-semibold rounded-xl transition-opacity" style={{ background: 'var(--blanc-info)', color: '#fff' }}><Briefcase className="size-4" />Convert to Job</button>
                    <DropdownMenu><DropdownMenuTrigger asChild><button className="inline-flex items-center justify-center h-11 w-11 rounded-xl transition-colors" style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-3)', background: '#fff' }}><MoreVertical className="size-4" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => onMarkLost(lead.UUID)} style={{ color: 'var(--blanc-warning)' }}><PhoneOff className="size-4 mr-2" />Mark Lost</DropdownMenuItem><DropdownMenuItem onClick={() => onDelete(lead.UUID)} className="text-destructive"><Trash2 className="size-4 mr-2" />Delete Lead</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
                </div>
            )}
            {(lead.Status === 'Converted' || lead.LeadLost) && (
                <div className="flex gap-2">
                    <button onClick={() => onEdit(lead)} className="inline-flex items-center justify-center gap-2 h-11 px-4 text-sm font-medium rounded-xl transition-colors" style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-2)', background: '#fff' }}><Edit className="size-4" />Edit</button>
                    {lead.LeadLost && <button onClick={() => onActivate(lead.UUID)} className="flex-1 inline-flex items-center justify-center gap-2 h-11 px-4 text-sm font-semibold rounded-xl transition-opacity" style={{ background: 'var(--blanc-success)', color: '#fff' }}><CheckCircle2 className="size-4" />Activate</button>}
                    <DropdownMenu><DropdownMenuTrigger asChild><button className="inline-flex items-center justify-center h-11 w-11 rounded-xl transition-colors" style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-3)', background: '#fff' }}><MoreVertical className="size-4" /></button></DropdownMenuTrigger><DropdownMenuContent align="end">{!lead.LeadLost && <DropdownMenuItem onClick={() => onMarkLost(lead.UUID)} style={{ color: 'var(--blanc-warning)' }}><PhoneOff className="size-4 mr-2" />Mark Lost</DropdownMenuItem>}<DropdownMenuItem onClick={() => onDelete(lead.UUID)} className="text-destructive"><Trash2 className="size-4 mr-2" />Delete Lead</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
                </div>
            )}
        </div>
    );
}
