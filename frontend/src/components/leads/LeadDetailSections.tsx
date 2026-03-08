import { useState, useEffect } from 'react';
import { authedFetch } from '../../services/apiClient';
import { Calendar, Tag, FileText, Edit, PhoneOff, CheckCircle2, Briefcase, Trash2, MoreVertical } from 'lucide-react';
import { format } from 'date-fns';
import type { Lead } from '../../types/lead';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';

interface CustomFieldDef { id: string; display_name: string; api_name: string; field_type: string; is_system: boolean; sort_order: number; }

export function MetadataSection({ lead }: { lead: Lead }) {
    const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);
    useEffect(() => { authedFetch('/api/settings/lead-form').then(r => r.json()).then(data => { if (data.success) setCustomFields(data.customFields.filter((f: CustomFieldDef) => !f.is_system)); }).catch(() => { }); }, []);

    return (
        <div>
            <h4 className="font-medium mb-3">Metadata</h4>
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
        <div className="p-4 border-t space-y-2">
            {lead.Status !== 'Converted' && !lead.LeadLost && (
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => onEdit(lead)} className="h-12"><Edit className="size-4 mr-2" />Edit</Button>
                    <Button size="sm" onClick={() => onConvert(lead.UUID)} className="flex-1 h-12"><Briefcase className="size-4 mr-2" />Convert to Job</Button>
                    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-12"><MoreVertical className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => onMarkLost(lead.UUID)} className="text-orange-600"><PhoneOff className="size-4 mr-2" />Mark Lost</DropdownMenuItem><DropdownMenuItem onClick={() => onDelete(lead.UUID)} className="text-destructive"><Trash2 className="size-4 mr-2" />Delete Lead</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
                </div>
            )}
            {(lead.Status === 'Converted' || lead.LeadLost) && (
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => onEdit(lead)} className="h-12"><Edit className="size-4 mr-2" />Edit</Button>
                    {lead.LeadLost && <Button size="sm" onClick={() => onActivate(lead.UUID)} className="flex-1 h-12"><CheckCircle2 className="size-4 mr-2" />Activate</Button>}
                    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-12"><MoreVertical className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{!lead.LeadLost && <DropdownMenuItem onClick={() => onMarkLost(lead.UUID)} className="text-orange-600"><PhoneOff className="size-4 mr-2" />Mark Lost</DropdownMenuItem>}<DropdownMenuItem onClick={() => onDelete(lead.UUID)} className="text-destructive"><Trash2 className="size-4 mr-2" />Delete Lead</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
                </div>
            )}
        </div>
    );
}
