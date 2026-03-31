import { X, Phone, Mail, MapPin, ChevronDown, CornerDownLeft, Users } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { Lead } from '../../types/lead';
import { LEAD_STATUSES } from '../../types/lead';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Separator } from '../ui/separator';
import { Label } from '../ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { MetadataSection, LeadDetailFooter } from './LeadDetailSections';
import { LeadFinancialsTab } from './LeadFinancialsTab';

interface LeadDetailPanelProps { lead: Lead | null; onClose: () => void; onEdit: (lead: Lead) => void; onMarkLost: (uuid: string) => void; onActivate: (uuid: string) => void; onConvert: (uuid: string) => void; onUpdateComments: (uuid: string, comments: string) => void; onUpdateStatus: (uuid: string, status: string) => void; onUpdateSource: (uuid: string, source: string) => void; onDelete: (uuid: string) => void; }

const JOB_SOURCES = ['Website', 'Referral', 'Google Ads', 'Facebook', 'Yelp', 'Direct Call', 'Email', 'Instagram', 'LinkedIn', 'Twitter', 'Other'];

export function LeadDetailPanel({ lead, onClose, onEdit, onMarkLost, onActivate, onConvert, onUpdateComments, onUpdateStatus, onUpdateSource, onDelete }: LeadDetailPanelProps) {
    const [comments, setComments] = useState('');
    const [isFocused, setIsFocused] = useState(false);
    const [isEditingComments, setIsEditingComments] = useState(false);
    const [activeTab, setActiveTab] = useState<'details' | 'financials'>('details');

    useEffect(() => { if (lead) { setComments(lead.Comments || ''); setIsEditingComments(false); setActiveTab('details'); } }, [lead]);
    const handleSaveComments = () => { if (lead && comments !== lead.Comments) onUpdateComments(lead.UUID, comments); setIsFocused(false); if (!comments.trim()) setIsEditingComments(false); };
    const handleBlur = () => handleSaveComments();
    const handleAddComment = () => { setIsEditingComments(true); setIsFocused(true); };

    if (!lead) return (<div className="w-[400px] min-w-[240px] border-l bg-muted/20 hidden md:flex items-center justify-center shrink-0"><div className="text-center text-muted-foreground"><Users className="size-12 mx-auto mb-3 opacity-20" /><p>Select a lead to view details</p></div></div>);

    return (
        <div className="fixed inset-0 z-50 bg-background md:relative md:inset-auto md:z-auto md:w-[400px] md:min-w-[240px] md:border-l md:h-full flex flex-col md:bg-background shrink-0">
            {/* Header */}
            <div className="p-4 border-b">
                <div className="flex items-start justify-between mb-3"><div className="flex-1"><h3 className="font-semibold text-lg">{lead.FirstName} {lead.LastName}</h3>{lead.Company && <p className="text-sm text-muted-foreground">{lead.Company}</p>}</div><Button variant="ghost" size="sm" onClick={onClose}><X className="size-4" /></Button></div>
                <div className="flex items-center gap-2">
                    <DropdownMenu><DropdownMenuTrigger asChild><button className="inline-flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-sm"><Badge variant={lead.LeadLost ? 'destructive' : 'default'} className="cursor-pointer hover:opacity-80 transition-opacity">{lead.Status}</Badge><ChevronDown className="size-3 text-muted-foreground" /></button></DropdownMenuTrigger><DropdownMenuContent align="start">{LEAD_STATUSES.map(status => <DropdownMenuItem key={status} onClick={() => onUpdateStatus(lead.UUID, status)} className={status === lead.Status ? 'bg-accent' : ''}>{status}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
                    <DropdownMenu><DropdownMenuTrigger asChild><button className="inline-flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-sm"><Badge variant="outline" className="cursor-pointer hover:opacity-80 transition-opacity">{lead.JobSource || 'No Source'}</Badge><ChevronDown className="size-3 text-muted-foreground" /></button></DropdownMenuTrigger><DropdownMenuContent align="start">{JOB_SOURCES.map(source => <DropdownMenuItem key={source} onClick={() => onUpdateSource(lead.UUID, source)} className={source === lead.JobSource ? 'bg-accent' : ''}>{source}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
                    {lead.SubStatus && <Badge variant="outline">{lead.SubStatus}</Badge>}
                    <span className="text-xs text-muted-foreground font-mono ml-auto">{lead.SerialId}</span>
                </div>
            </div>

            {/* Tab bar */}
            <div className="border-b px-4 pt-2 shrink-0">
                <Tabs value={activeTab} onValueChange={v => setActiveTab(v as 'details' | 'financials')}>
                    <TabsList className="h-8">
                        <TabsTrigger value="details" className="text-xs">Details</TabsTrigger>
                        <TabsTrigger value="financials" className="text-xs">Estimates &amp; Invoices</TabsTrigger>
                    </TabsList>
                </Tabs>
            </div>

            {/* Details tab */}
            {activeTab === 'details' && (
                <div className="flex-1 overflow-y-auto">
                    <div className="p-4 space-y-4">
                        <div><h4 className="font-medium mb-3">Contact Information</h4>
                            <div className="space-y-3">
                                {(comments.trim() || isEditingComments) ? (
                                    <div className="relative bg-rose-50 rounded-lg border border-rose-100 py-1 px-2">
                                        <textarea ref={el => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }} className="w-full text-sm resize-none bg-transparent border-none outline-none min-h-[24px] pr-16 leading-6" value={comments} onChange={e => setComments(e.target.value)} onFocus={() => setIsFocused(true)} onBlur={handleBlur} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveComments(); } }} placeholder="Add comments..." rows={1} autoFocus={isEditingComments} style={{ height: 'auto', minHeight: '24px' }} onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }} />
                                        {isFocused && <Button size="sm" className="absolute top-1 right-1.5 h-6 px-2 text-xs" onMouseDown={e => e.preventDefault()} onClick={handleSaveComments}><CornerDownLeft className="size-3 mr-1" />Enter</Button>}
                                    </div>
                                ) : (<button onClick={handleAddComment} className="text-sm text-muted-foreground hover:text-foreground transition-colors underline decoration-dashed decoration-1 underline-offset-4">+ Add comment</button>)}

                                <div className="flex items-start gap-3"><Phone className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Phone</Label><div className="flex items-center gap-2"><a href={`tel:${lead.Phone}`} className="text-sm font-medium text-foreground no-underline hover:underline">{formatPhone(lead.Phone)}</a><ClickToCallButton phone={lead.Phone || ''} contactName={[lead.FirstName, lead.LastName].filter(Boolean).join(' ')} /><OpenTimelineButton phone={lead.Phone || ''} contactId={lead.ContactId} />{lead.PhoneExt && <span className="text-xs text-muted-foreground">ext. {lead.PhoneExt}</span>}</div></div></div>
                                {lead.SecondPhone && <div className="flex items-start gap-3"><Phone className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">{lead.SecondPhoneName ? `Secondary Phone (${lead.SecondPhoneName})` : 'Secondary Phone'}</Label><div className="flex items-center gap-2"><a href={`tel:${lead.SecondPhone}`} className="text-sm font-medium text-foreground no-underline hover:underline">{formatPhone(lead.SecondPhone)}</a><ClickToCallButton phone={lead.SecondPhone} contactName={[lead.FirstName, lead.LastName].filter(Boolean).join(' ')} /><OpenTimelineButton phone={lead.SecondPhone || ''} contactId={lead.ContactId} />{lead.SecondPhoneExt && <span className="text-xs text-muted-foreground">ext. {lead.SecondPhoneExt}</span>}</div></div></div>}
                                {lead.Email && <div className="flex items-start gap-3"><Mail className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Email</Label><a href={`mailto:${lead.Email}`} className="text-sm font-medium text-foreground no-underline hover:underline block">{lead.Email}</a></div></div>}
                                {(lead.Address || lead.City) && <div className="flex items-start gap-3"><MapPin className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Address</Label><div className="text-sm font-medium mt-1">{lead.Address && <div>{lead.Address}{lead.Unit && `, Unit ${lead.Unit}`}</div>}{lead.City && <div>{lead.City}, {lead.State} {lead.PostalCode}</div>}{lead.Country && <div>{lead.Country}</div>}</div></div></div>}
                            </div>
                        </div>
                        <Separator />
                        <div><h4 className="font-medium mb-3">Job Details</h4><div className="space-y-3"><div><Label className="text-xs text-muted-foreground">Job Type</Label><div className="text-sm font-medium mt-1">{lead.JobType || <span className="text-muted-foreground">N/A</span>}</div></div><div><Label className="text-xs text-muted-foreground">Description</Label><div className="text-sm mt-1 whitespace-pre-wrap">{lead.Description || <span className="text-muted-foreground">N/A</span>}</div></div></div></div>
                        <Separator />
                        <MetadataSection lead={lead} />
                    </div>
                </div>
            )}

            {/* Financials tab */}
            {activeTab === 'financials' && (
                <div className="flex-1 overflow-y-auto p-4">
                    {lead.SerialId ? (
                        <LeadFinancialsTab leadId={lead.SerialId} />
                    ) : (
                        <p className="text-sm text-muted-foreground">Lead ID not available</p>
                    )}
                </div>
            )}

            <LeadDetailFooter lead={lead} onEdit={onEdit} onMarkLost={onMarkLost} onActivate={onActivate} onConvert={onConvert} onDelete={onDelete} />
        </div>
    );
}
