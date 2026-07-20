/**
 * LeadDetailPanel — two-column layout matching JobDetailPanel.
 *
 * LEFT:  Header (eyebrow + name + status/source pills) → Contact tile → Address tile
 * RIGHT: Tabs (Details | Finance) → Notes + Job Details + Metadata | LeadFinancialsTab
 *
 * Embedded mode (Pulse): single-column with tiles, notes in header area.
 */
import { ChevronDown, Users } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { Lead } from '../../types/lead';
import { NotesHistoryTabs } from '../shared/NotesHistoryTabs';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { MetadataSection, LeadDetailFooter } from './LeadDetailSections';
import { LeadInfoSections } from './LeadInfoSections';
import { LeadFinancialsTab } from './LeadFinancialsTab';
import { REJECTED_REASON_COPY } from './leadConstants';
import { hexToRgba } from './leadStatusStyles';
import { useAuthz } from '../../hooks/useAuthz';
import { LeadStatusDropdown } from './LeadStatusDropdown';

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

// ─── Job Details section ─────────────────────────────────────────────────────

function JobDetailsSection({ lead }: { lead: Lead }) {
    if (!lead.JobType && !lead.Description) return null;
    return (
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
    );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function LeadDetailPanel({ lead, onClose: _onClose, onEdit, onMarkLost, onActivate, onConvert, onUpdateComments: _onUpdateComments, onUpdateStatus, onUpdateSource, onDelete, embedded }: LeadDetailPanelProps) {
    const [rightTab, setRightTab] = useState<'details' | 'financials'>('details');

    useEffect(() => {
        if (lead) { setRightTab('details'); }
    }, [lead]);

    if (!lead) return embedded ? null : (
        <div className="w-[400px] min-w-[240px] border-l bg-muted/20 hidden md:flex items-center justify-center shrink-0">
            <div className="text-center text-muted-foreground">
                <Users className="size-12 mx-auto mb-3 opacity-20" />
                <p>Select a lead to view details</p>
            </div>
        </div>
    );

    const contactName = [lead.FirstName, lead.LastName].filter(Boolean).join(' ');
    // ─── Embedded (Pulse) — single column ────────────────────────────────────
    if (embedded) {
        return (
            <div className="flex flex-col">
                {/* Header */}
                <div className="pulse-contact-header-grid px-5 pt-5 pb-4">
                    <div>
                        <LeadHeader lead={lead} contactName={contactName} onUpdateStatus={onUpdateStatus} onUpdateSource={onUpdateSource} />
                    </div>
                    <NotesHistoryTabs entityType="lead" entityId={lead.UUID} />
                </div>

                {/* Tiles */}
                <LeadInfoSections lead={lead} />

                {/* Details */}
                <div className="px-5 pb-5 space-y-4">
                    <JobDetailsSection lead={lead} />
                    <MetadataSection lead={lead} />
                    {lead.SerialId && (
                        <>
                            <p className="blanc-eyebrow pt-2">Estimates &amp; Invoices</p>
                            <LeadFinancialsTab leadId={lead.SerialId} />
                        </>
                    )}
                </div>

                <LeadDetailFooter lead={lead} onEdit={onEdit} onMarkLost={onMarkLost} onActivate={onActivate} onConvert={onConvert} onDelete={onDelete} />
            </div>
        );
    }

    // ─── Standard — two-column layout ────────────────────────────────────────
    return (
        <div className="flex flex-col h-full">
            <div className="flex flex-col md:flex-row flex-1 overflow-hidden">

                {/* ═══ LEFT COLUMN — Identity + Tiles ═══ */}
                <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
                    {/* Header */}
                    <div className="px-5 pt-5 pb-3">
                        <LeadHeader lead={lead} contactName={contactName} onUpdateStatus={onUpdateStatus} onUpdateSource={onUpdateSource} />
                    </div>

                    {/* Contact + Address tiles */}
                    <LeadInfoSections lead={lead} />

                    {/* Mobile-only: right column content inline */}
                    <div className="md:hidden px-5 pb-6 space-y-5">
                        <NotesHistoryTabs entityType="lead" entityId={lead.UUID} />
                        <JobDetailsSection lead={lead} />
                        <MetadataSection lead={lead} />
                        {lead.SerialId && (
                            <>
                                <p className="blanc-eyebrow pt-2">Estimates &amp; Invoices</p>
                                <LeadFinancialsTab leadId={lead.SerialId} />
                            </>
                        )}
                    </div>
                </div>

                {/* ═══ RIGHT COLUMN (desktop) — Details & Finance ═══ */}
                <div
                    className="w-full md:w-1/2 flex-col overflow-y-auto hidden md:flex"
                    style={{ borderLeft: '1px solid var(--blanc-line)' }}
                >
                    <Tabs value={rightTab} onValueChange={v => setRightTab(v as 'details' | 'financials')} className="flex flex-col h-full">
                        <div className="shrink-0" style={{ padding: '8px 16px 0' }}>
                            <TabsList className="h-9">
                                <TabsTrigger value="details" className="text-xs">Details</TabsTrigger>
                                <TabsTrigger value="financials" className="text-xs">Finance</TabsTrigger>
                            </TabsList>
                        </div>

                        <TabsContent value="details" className="flex-1 flex flex-col mt-0 min-h-0 data-[state=inactive]:hidden">
                            <div className="flex-1 overflow-y-auto p-4 space-y-5">
                                <NotesHistoryTabs entityType="lead" entityId={lead.UUID} />
                                <JobDetailsSection lead={lead} />
                                <MetadataSection lead={lead} />
                            </div>
                        </TabsContent>

                        <TabsContent value="financials" className="flex-1 flex flex-col mt-0 data-[state=inactive]:hidden">
                            {lead.SerialId ? (
                                <LeadFinancialsTab leadId={lead.SerialId} />
                            ) : (
                                <div className="p-4 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Lead ID not available</div>
                            )}
                        </TabsContent>
                    </Tabs>
                </div>
            </div>

            {/* Footer: full width, bottom */}
            <LeadDetailFooter lead={lead} onEdit={onEdit} onMarkLost={onMarkLost} onActivate={onActivate} onConvert={onConvert} onDelete={onDelete} />
        </div>
    );
}

// ─── LeadHeader sub-component ────────────────────────────────────────────────

function LeadHeader({ lead, contactName, onUpdateStatus, onUpdateSource }: {
    lead: Lead;
    contactName: string;
    onUpdateStatus: (uuid: string, status: string) => void;
    onUpdateSource: (uuid: string, source: string) => void;
}) {
    const { hasPermission } = useAuthz();
    const canViewSource = hasPermission('lead_source.view');
    const rejectedReason = lead.rely_filter?.reason
        ? REJECTED_REASON_COPY[lead.rely_filter.reason] ?? 'Rejected'
        : 'Rejected';

    return (
        <>
            {/* Eyebrow */}
            <div className="mb-2">
                <span
                    className="text-[10px] font-semibold uppercase tracking-widest inline-flex items-center gap-1.5"
                    style={{ color: 'var(--blanc-info)', letterSpacing: '0.12em' }}
                >
                    Lead
                    {lead.SerialId && <span className="font-mono">#{lead.SerialId}</span>}
                </span>
            </div>

            {/* Name */}
            <h2
                className="text-2xl font-bold leading-tight mb-3"
                style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)', letterSpacing: '-0.03em' }}
            >
                {contactName || 'Unknown'}
            </h2>

            {lead.Company && <p className="text-sm mb-2" style={{ color: 'var(--blanc-ink-3)' }}>{lead.Company}</p>}

            {/* Status + Source pills */}
            <div className="flex items-center gap-2 flex-wrap">
                <LeadStatusDropdown lead={lead} onUpdateStatus={onUpdateStatus} />

                {canViewSource && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className="inline-flex items-center gap-1.5 px-4 text-sm font-medium transition-colors focus:outline-none"
                                style={{ background: 'rgba(25,25,25,0.06)', color: 'var(--blanc-ink-2)', border: '1px solid var(--blanc-line)', minHeight: 42, borderRadius: 14 }}
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
                )}

                {lead.SubStatus && (
                    <span className="inline-flex items-center px-4 text-sm font-medium" style={{ background: 'rgba(25,25,25,0.06)', color: 'var(--blanc-ink-2)', border: '1px solid var(--blanc-line)', minHeight: 42, borderRadius: 14 }}>
                        {lead.SubStatus}
                    </span>
                )}

                {lead.rely_filter?.rejected && (
                    <span
                        title={rejectedReason}
                        className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap"
                        style={{ background: hexToRgba('#DC2626', 0.1), color: '#DC2626' }}
                    >
                        Rejected
                    </span>
                )}
            </div>

            {lead.rely_filter?.rejected && (
                <p className="text-[13px] mt-2" style={{ color: '#DC2626' }}>{rejectedReason}</p>
            )}
        </>
    );
}
