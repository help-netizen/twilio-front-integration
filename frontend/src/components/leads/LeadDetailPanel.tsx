/**
 * LeadDetailPanel — two-column layout matching JobDetailPanel.
 *
 * LEFT:  Header (eyebrow + name + status/source pills) → Contact tile → Address tile
 * RIGHT: Tabs (Details | Finance) → Notes + Job Details + Metadata | LeadFinancialsTab
 *
 * Embedded mode (Pulse): single-column with tiles, notes in header area.
 */
import { ChevronDown, Users, RotateCcw } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { Lead } from '../../types/lead';
import { LEAD_STATUSES } from '../../types/lead';
import { StructuredNotesSection } from '../shared/StructuredNotesSection';
import { useFsmStates, useFsmActions } from '../../hooks/useFsmActions';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { MetadataSection, LeadDetailFooter } from './LeadDetailSections';
import { LeadInfoSections } from './LeadInfoSections';
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

// ─── Status pill color helpers ───────────────────────────────────────────────

const LEAD_STATUS_COLORS: Record<string, string> = {
    'Submitted': '#3B82F6', 'New': '#8B5CF6', 'Contacted': '#1B8B63',
    'Qualified': '#22C55E', 'Proposal Sent': '#F59E0B',
    'Negotiation': '#F97316', 'Lost': '#EF4444', 'Converted': '#6B7280',
};

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

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
    const statusColor = LEAD_STATUS_COLORS[lead.Status] || '#6B7280';

    // ─── Embedded (Pulse) — single column ────────────────────────────────────
    if (embedded) {
        return (
            <div className="flex flex-col">
                {/* Header */}
                <div className="pulse-contact-header-grid px-5 pt-5 pb-4">
                    <div>
                        <LeadHeader lead={lead} contactName={contactName} statusColor={statusColor} onUpdateStatus={onUpdateStatus} onUpdateSource={onUpdateSource} />
                    </div>
                    <StructuredNotesSection entityType="lead" entityId={lead.UUID} legacyText={lead.Comments || undefined} />
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
                        <LeadHeader lead={lead} contactName={contactName} statusColor={statusColor} onUpdateStatus={onUpdateStatus} onUpdateSource={onUpdateSource} />
                    </div>

                    {/* Contact + Address tiles */}
                    <LeadInfoSections lead={lead} />

                    {/* Mobile-only: right column content inline */}
                    <div className="md:hidden px-5 pb-6 space-y-5">
                        <StructuredNotesSection entityType="lead" entityId={lead.UUID} legacyText={lead.Comments || undefined} />
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
                    style={{ borderLeft: '1px solid rgba(117, 106, 89, 0.07)' }}
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
                                <StructuredNotesSection entityType="lead" entityId={lead.UUID} legacyText={lead.Comments || undefined} />
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

function LeadHeader({ lead, contactName, statusColor, onUpdateStatus, onUpdateSource }: {
    lead: Lead;
    contactName: string;
    statusColor: string;
    onUpdateStatus: (uuid: string, status: string) => void;
    onUpdateSource: (uuid: string, source: string) => void;
}) {
    const { data: fsmData } = useFsmStates('lead', true);
    const allStatuses = fsmData?.states && fsmData.states.length > 0 ? fsmData.states : (LEAD_STATUSES as unknown as string[]);
    const initialState = fsmData?.initialState || null;
    const { data: fsmActions } = useFsmActions('lead', lead.Status);
    const allowedTargets = new Set(fsmActions?.map(a => a.target) || []);
    const reachable = allStatuses.filter(s => s !== lead.Status && allowedTargets.has(s));
    const unreachable = allStatuses.filter(s => s !== lead.Status && !allowedTargets.has(s));
    const canReset = initialState && lead.Status !== initialState;

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
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className="inline-flex items-center gap-1.5 px-4 text-sm font-semibold transition-colors focus:outline-none"
                            style={{
                                background: hexToRgba(statusColor, 0.1),
                                color: statusColor,
                                minHeight: 42, borderRadius: 14, border: 'none',
                            }}
                        >
                            {lead.Status}<ChevronDown className="size-3.5" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        {reachable.map(status => (
                            <DropdownMenuItem key={status} onClick={() => onUpdateStatus(lead.UUID, status)}>
                                {status}
                            </DropdownMenuItem>
                        ))}
                        {unreachable.length > 0 && reachable.length > 0 && (
                            <div className="my-1" />
                        )}
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
                                    style={{ background: 'rgba(117,106,89,0.06)', color: 'var(--blanc-ink-2)' }}
                                >
                                    <RotateCcw className="size-3" />
                                    Reset to {initialState}
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className="inline-flex items-center gap-1.5 px-4 text-sm font-medium transition-colors focus:outline-none"
                            style={{ background: 'rgba(117,106,89,0.08)', color: 'var(--blanc-ink-2)', border: '1px solid var(--blanc-line)', minHeight: 42, borderRadius: 14 }}
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
                    <span className="inline-flex items-center px-4 text-sm font-medium" style={{ background: 'rgba(117,106,89,0.08)', color: 'var(--blanc-ink-2)', border: '1px solid var(--blanc-line)', minHeight: 42, borderRadius: 14 }}>
                        {lead.SubStatus}
                    </span>
                )}
            </div>
        </>
    );
}
