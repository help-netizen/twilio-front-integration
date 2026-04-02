/**
 * LeadDetailPanel — lead detail view, Blanc design.
 *
 * Layout (embedded / Pulse mode):
 *   Header — two-column grid: left (name + status + contacts), right (comments sticky note)
 *   Tab bar — Details | Estimates & Invoices
 *   Body   — two-column grid: left (job info + metadata), right (address)
 *   Footer — action buttons
 */
import { X, Phone, Mail, MapPin, ChevronDown, Users } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { Lead } from '../../types/lead';
import { LEAD_STATUSES } from '../../types/lead';
import { Button } from '../ui/button';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { MetadataSection, LeadDetailFooter } from './LeadDetailSections';
import { LeadFinancialsTab } from './LeadFinancialsTab';

interface LeadDetailPanelProps {
    lead: Lead | null;
    onClose: () => void;
    onEdit: (lead: Lead) => void;
    onMarkLost: (uuid: string) => void;
    onActivate: (uuid: string) => void;
    onConvert: (uuid: string) => void;
    onUpdateComments: (uuid: string, comments: string) => void;
    onUpdateStatus: (uuid: string, status: string) => void;
    onUpdateSource: (uuid: string, source: string) => void;
    onDelete: (uuid: string) => void;
    embedded?: boolean;
}

const JOB_SOURCES = ['Website', 'Referral', 'Google Ads', 'Facebook', 'Yelp', 'Direct Call', 'Email', 'Instagram', 'LinkedIn', 'Twitter', 'Other'];

export function LeadDetailPanel({ lead, onClose, onEdit, onMarkLost, onActivate, onConvert, onUpdateComments, onUpdateStatus, onUpdateSource, onDelete, embedded }: LeadDetailPanelProps) {
    const [comments, setComments] = useState('');

    const [activeTab, setActiveTab] = useState<'details' | 'financials'>('details');

    useEffect(() => {
        if (lead) { setComments(lead.Comments || ''); setActiveTab('details'); }
    }, [lead]);

    const handleSaveComments = () => {
        if (lead && comments !== lead.Comments) onUpdateComments(lead.UUID, comments);
    };

    if (!lead) return embedded ? null : (
        <div className="w-[400px] min-w-[240px] border-l bg-muted/20 hidden md:flex items-center justify-center shrink-0">
            <div className="text-center text-muted-foreground">
                <Users className="size-12 mx-auto mb-3 opacity-20" />
                <p>Select a lead to view details</p>
            </div>
        </div>
    );

    const contactName = [lead.FirstName, lead.LastName].filter(Boolean).join(' ');
    const hasAddress = !!(lead.Address || lead.City);

    return (
        <div
            className={embedded ? 'flex flex-col' : 'fixed inset-0 z-50 bg-background md:relative md:inset-auto md:z-auto md:w-[400px] md:min-w-[240px] md:border-l md:h-full flex flex-col md:bg-background shrink-0'}
            style={{ background: 'var(--blanc-surface-strong)' }}
        >
            {/* ── Header: two-column grid — left: identity, right: comments ── */}
            <div className={embedded ? 'pulse-contact-header-grid px-5 pt-5 pb-4' : 'px-5 pt-5 pb-4'}>
                {/* Left: Name + status badges + contacts */}
                <div>
                    {/* Type label */}
                    <span className="text-[10px] font-semibold uppercase tracking-widest mb-1 inline-block" style={{ color: 'var(--blanc-info)', letterSpacing: '0.12em' }}>Lead</span>

                    {/* Name + Edit + Close */}
                    <div className="flex items-center gap-2 mb-1">
                        <h2
                            className="font-bold text-2xl leading-tight truncate"
                            style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}
                        >
                            {contactName || 'Unknown'}
                        </h2>
                        <button
                            onClick={() => onEdit(lead)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors shrink-0"
                            style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-3)' }}
                        >
                            Edit
                        </button>
                        {!embedded && (
                            <Button variant="ghost" size="sm" onClick={onClose} className="ml-auto shrink-0">
                                <X className="size-4" />
                            </Button>
                        )}
                    </div>

                    {lead.Company && <p className="text-sm mb-2" style={{ color: 'var(--blanc-ink-3)' }}>{lead.Company}</p>}
                    {!lead.Company && <div className="mb-2" />}

                    {/* Status + Source badges */}
                    <div className="flex items-center gap-2 flex-wrap mb-3">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm font-semibold transition-colors focus:outline-none"
                                    style={{
                                        background: lead.LeadLost ? 'rgba(212,77,60,0.1)' : 'rgba(27,139,99,0.1)',
                                        color: lead.LeadLost ? '#d44d3c' : 'var(--blanc-success)',
                                    }}
                                >
                                    {lead.Status}<ChevronDown className="size-3.5" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                {LEAD_STATUSES.map(status => (
                                    <DropdownMenuItem key={status} onClick={() => onUpdateStatus(lead.UUID, status)} className={status === lead.Status ? 'bg-accent' : ''}>
                                        {status}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm font-medium transition-colors focus:outline-none"
                                    style={{ background: 'rgba(117,106,89,0.08)', color: 'var(--blanc-ink-2)', border: '1px solid var(--blanc-line)' }}
                                >
                                    {lead.JobSource || 'No Source'}<ChevronDown className="size-3.5" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                {JOB_SOURCES.map(source => (
                                    <DropdownMenuItem key={source} onClick={() => onUpdateSource(lead.UUID, source)} className={source === lead.JobSource ? 'bg-accent' : ''}>
                                        {source}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        {lead.SubStatus && (
                            <span className="px-2.5 py-1 rounded-lg text-sm font-medium" style={{ background: 'rgba(117,106,89,0.08)', color: 'var(--blanc-ink-2)', border: '1px solid var(--blanc-line)' }}>
                                {lead.SubStatus}
                            </span>
                        )}
                    </div>

                    {/* Phone + Email — inline, no section header */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <Phone className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            <a href={`tel:${lead.Phone}`} className="text-[15px] font-semibold text-foreground no-underline hover:underline">
                                {formatPhone(lead.Phone)}
                            </a>
                            <ClickToCallButton phone={lead.Phone || ''} contactName={contactName} />
                            <OpenTimelineButton phone={lead.Phone || ''} contactId={lead.ContactId} />
                            {lead.PhoneExt && <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>ext. {lead.PhoneExt}</span>}
                        </div>
                        {lead.SecondPhone && (
                            <div className="flex items-center gap-2">
                                <Phone className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                <a href={`tel:${lead.SecondPhone}`} className="text-sm text-foreground no-underline hover:underline">
                                    {formatPhone(lead.SecondPhone)}
                                </a>
                                {lead.SecondPhoneName && <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{lead.SecondPhoneName}</span>}
                                <ClickToCallButton phone={lead.SecondPhone} contactName={contactName} />
                                <OpenTimelineButton phone={lead.SecondPhone || ''} contactId={lead.ContactId} />
                                {lead.SecondPhoneExt && <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>ext. {lead.SecondPhoneExt}</span>}
                            </div>
                        )}
                        {lead.Email && (
                            <div className="flex items-center gap-2">
                                <Mail className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                <a href={`mailto:${lead.Email}`} className="text-sm text-foreground no-underline hover:underline">{lead.Email}</a>
                            </div>
                        )}
                    </div>
                </div>

                {/* Right: Notes — sticky note style */}
                {embedded && (
                    <div style={{ padding: '14px 16px 16px', borderRadius: 16, background: '#fef9e7', borderLeft: '3px solid #f6d860' }}>
                        <h4 className="blanc-eyebrow mb-2">Notes</h4>
                        <textarea
                            ref={el => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                            className="w-full text-sm resize-none bg-transparent border-none outline-none leading-6"
                            style={{ minHeight: 36, color: comments ? 'var(--blanc-ink-1)' : undefined }}
                            value={comments}
                            onChange={e => setComments(e.target.value)}
                            onBlur={handleSaveComments}
                            onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
                            placeholder="Add comments…"
                            rows={2}
                        />
                    </div>
                )}

                {/* Non-embedded: comments below header as sticky note */}
                {!embedded && (
                    <div style={{ padding: '14px 16px 16px', borderRadius: 16, background: '#fef9e7', borderLeft: '3px solid #f6d860', marginTop: 12 }}>
                        <h4 className="blanc-eyebrow mb-2">Notes</h4>
                        <textarea
                            ref={el => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                            className="w-full text-sm resize-none bg-transparent border-none outline-none leading-6"
                            style={{ minHeight: 36, color: comments ? 'var(--blanc-ink-1)' : undefined }}
                            value={comments}
                            onChange={e => setComments(e.target.value)}
                            onBlur={handleSaveComments}
                            onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
                            placeholder="Add comments…"
                            rows={2}
                        />
                    </div>
                )}
            </div>

            {/* Tab bar — no border-b */}
            <div className="shrink-0 px-5">
                <Tabs value={activeTab} onValueChange={v => setActiveTab(v as 'details' | 'financials')}>
                    <TabsList className="h-10 gap-1 bg-transparent p-0">
                        <TabsTrigger value="details" className="text-sm font-medium px-4 h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-current data-[state=active]:shadow-none bg-transparent data-[state=active]:bg-transparent">Details</TabsTrigger>
                        <TabsTrigger value="financials" className="text-sm font-medium px-4 h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-current data-[state=active]:shadow-none bg-transparent data-[state=active]:bg-transparent">Estimates &amp; Invoices</TabsTrigger>
                    </TabsList>
                </Tabs>
            </div>

            {/* ── Details tab ── */}
            {activeTab === 'details' && (
                <div className={embedded ? '' : 'flex-1 overflow-y-auto'}>
                    <div className={embedded ? 'grid grid-cols-2 gap-x-6 gap-y-4 p-5' : 'p-5 space-y-4'}>
                        {/* Left column: Job Details + Metadata */}
                        <div className="space-y-4">
                            {/* Job type + description — flat, no section card */}
                            {(lead.JobType || lead.Description) && (
                                <div>
                                    <h4 className="blanc-eyebrow mb-2">Job Details</h4>
                                    <div className="space-y-2">
                                        {lead.JobType && (
                                            <div className="text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>{lead.JobType}</div>
                                        )}
                                        {lead.Description && (
                                            <div className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--blanc-ink-2)' }}>{lead.Description}</div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Metadata — custom fields */}
                            <MetadataSection lead={lead} />
                        </div>

                        {/* Right column: Address */}
                        <div>
                            {hasAddress && (
                                <div>
                                    <h4 className="blanc-eyebrow flex items-center gap-1.5 mb-2">
                                        <MapPin className="size-3.5" />Address
                                    </h4>
                                    <div className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                                        {lead.Address && <div>{lead.Address}{lead.Unit && `, Unit ${lead.Unit}`}</div>}
                                        {lead.City && <div>{lead.City}, {lead.State} {lead.PostalCode}</div>}
                                        {lead.Country && <div>{lead.Country}</div>}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Financials tab ── */}
            {activeTab === 'financials' && (
                <div className={embedded ? 'p-5' : 'flex-1 overflow-y-auto p-5'}>
                    {lead.SerialId ? (
                        <LeadFinancialsTab leadId={lead.SerialId} />
                    ) : (
                        <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Lead ID not available</p>
                    )}
                </div>
            )}

            <LeadDetailFooter lead={lead} onEdit={onEdit} onMarkLost={onMarkLost} onActivate={onActivate} onConvert={onConvert} onDelete={onDelete} />
        </div>
    );
}
