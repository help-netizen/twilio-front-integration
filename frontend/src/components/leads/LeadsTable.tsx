import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Skeleton } from '../ui/skeleton';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Phone, MoreVertical, PhoneOff, CheckCircle2, Briefcase } from 'lucide-react';
import type { Lead, TableColumn } from '../../types/lead';
import { renderCell, handleCall } from './leadsTableHelpers';

interface LeadsTableProps {
    leads: Lead[]; loading: boolean; selectedLeadId?: string; columns: TableColumn[];
    onSelectLead: (lead: Lead) => void; onMarkLost: (uuid: string) => void;
    onActivate: (uuid: string) => void; onConvert: (uuid: string) => void;
    offset: number; hasMore: boolean; onNextPage: () => void; onPrevPage: () => void;
}

export function LeadsTable({ leads, loading, selectedLeadId, columns, onSelectLead, onMarkLost, onActivate, onConvert, offset, hasMore, onNextPage, onPrevPage }: LeadsTableProps) {
    const visibleColumns = columns.filter(col => col.visible).sort((a, b) => a.order - b.order);

    if (loading) return <div className="flex-1 overflow-auto p-5"><div className="space-y-3">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div></div>;
    if (leads.length === 0) return <div className="flex-1 flex items-center justify-center"><div className="text-center"><p className="text-lg mb-2" style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>No leads found</p><p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Try adjusting your filters or create a new lead</p></div></div>;

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
                <Table>
                    <TableHeader className="sticky top-0 z-10" style={{ background: 'var(--blanc-surface-strong)' }}>
                        <TableRow style={{ borderColor: 'var(--blanc-line)' }}>
                            {visibleColumns.map(c => (
                                <TableHead
                                    key={c.id}
                                    className="text-[11px] font-semibold uppercase tracking-wider px-4 h-11"
                                    style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.08em' }}
                                >
                                    {c.label}
                                </TableHead>
                            ))}
                            <TableHead className="w-[50px]" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>{leads.map(lead => (
                        <TableRow
                            key={lead.UUID}
                            className="cursor-pointer transition-colors"
                            style={{
                                borderColor: 'var(--blanc-line)',
                                background: selectedLeadId === lead.UUID ? 'rgba(117, 106, 89, 0.06)' : undefined,
                            }}
                            onMouseEnter={e => { if (selectedLeadId !== lead.UUID) e.currentTarget.style.background = 'rgba(117, 106, 89, 0.03)'; }}
                            onMouseLeave={e => { if (selectedLeadId !== lead.UUID) e.currentTarget.style.background = ''; }}
                            onClick={() => onSelectLead(lead)}
                        >
                            {visibleColumns.map(c => renderCell(c.id, lead, c.id))}
                            <TableCell className="px-3" onClick={e => e.stopPropagation()}>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <button
                                            className="inline-flex items-center justify-center transition-opacity hover:opacity-70"
                                            style={{ width: 32, height: 32, borderRadius: 10, border: '1px solid rgba(104, 95, 80, 0.1)', color: 'var(--blanc-ink-3)', background: 'transparent' }}
                                        >
                                            <MoreVertical className="size-3.5" />
                                        </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        {lead.Phone && <DropdownMenuItem onClick={e => handleCall(lead.Phone!, e)}><Phone className="size-4 mr-2" />Call</DropdownMenuItem>}
                                        <DropdownMenuSeparator />
                                        {!lead.LeadLost ? <DropdownMenuItem onClick={e => { e.stopPropagation(); onMarkLost(lead.UUID); }}><PhoneOff className="size-4 mr-2" />Mark Lost</DropdownMenuItem> : <DropdownMenuItem onClick={e => { e.stopPropagation(); onActivate(lead.UUID); }}><CheckCircle2 className="size-4 mr-2" />Activate</DropdownMenuItem>}
                                        {lead.Status !== 'Converted' && !lead.LeadLost && <><DropdownMenuSeparator /><DropdownMenuItem onClick={e => { e.stopPropagation(); onConvert(lead.UUID); }}><Briefcase className="size-4 mr-2" />Convert to Job</DropdownMenuItem></>}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </TableCell>
                        </TableRow>
                    ))}</TableBody>
                </Table>
            </div>
            {/* Pagination */}
            <div className="px-5 py-3.5 flex items-center justify-between" style={{ borderTop: '1px solid var(--blanc-line)' }}>
                <span className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    Showing {offset + 1} - {offset + leads.length} leads
                </span>
                <div className="flex gap-2">
                    <button
                        onClick={onPrevPage}
                        disabled={offset === 0}
                        className="inline-flex items-center px-4 text-sm font-medium transition-opacity hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ minHeight: 38, borderRadius: 12, border: '1px solid rgba(104, 95, 80, 0.14)', background: 'var(--blanc-surface-strong)', color: 'var(--blanc-ink-2)', boxShadow: 'rgba(48, 39, 28, 0.04) 0px 4px 12px' }}
                    >
                        Previous
                    </button>
                    <button
                        onClick={onNextPage}
                        disabled={!hasMore}
                        className="inline-flex items-center px-4 text-sm font-medium transition-opacity hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ minHeight: 38, borderRadius: 12, border: '1px solid rgba(104, 95, 80, 0.14)', background: 'var(--blanc-surface-strong)', color: 'var(--blanc-ink-2)', boxShadow: 'rgba(48, 39, 28, 0.04) 0px 4px 12px' }}
                    >
                        Next
                    </button>
                </div>
            </div>
        </div>
    );
}
