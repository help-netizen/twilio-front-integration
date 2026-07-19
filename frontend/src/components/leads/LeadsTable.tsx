import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Skeleton } from '../ui/skeleton';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Phone, MoreVertical, PhoneOff, CheckCircle2, Briefcase, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import type { Lead, TableColumn } from '../../types/lead';
import { renderCell } from './leadsTableHelpers';
import { useAuthz } from '../../hooks/useAuthz';
import { LoadMoreFooter, type LoadMoreFooterProps } from '../lists/LoadMoreFooter';

interface LeadsTableProps {
    leads: Lead[]; loading: boolean; selectedLeadId?: string; columns: TableColumn[];
    onSelectLead: (lead: Lead) => void; onMarkLost: (uuid: string) => void;
    onActivate: (uuid: string) => void; onConvert: (uuid: string) => void;
    footerProps: LoadMoreFooterProps;
    sortBy?: string; sortOrder?: 'asc' | 'desc';
    onSortChange?: (field: string, order: 'asc' | 'desc') => void;
}

export function LeadsTable({ leads, loading, selectedLeadId, columns, onSelectLead, onMarkLost, onActivate, onConvert, footerProps, sortBy, sortOrder, onSortChange }: LeadsTableProps) {
    const { hasPermission } = useAuthz();
    const canViewSource = hasPermission('lead_source.view');
    const visibleColumns = columns
        .filter(col => col.visible && (canViewSource || col.id !== 'jobSource'))
        .sort((a, b) => a.order - b.order);

    const handleHeaderClick = (col: TableColumn) => {
        if (!col.sortKey || !onSortChange) return;
        if (sortBy === col.sortKey) {
            onSortChange(col.sortKey, sortOrder === 'asc' ? 'desc' : 'asc');
        } else {
            onSortChange(col.sortKey, 'asc');
        }
    };

    if (loading) return <div className="flex-1 overflow-auto p-5"><div className="space-y-3">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div></div>;
    if (leads.length === 0) {
        if (footerProps.state === 'error+retry') {
            return <div className="flex-1 flex items-center justify-center"><LoadMoreFooter {...footerProps} /></div>;
        }
        return <div className="flex-1 flex items-center justify-center"><div className="text-center"><p className="text-lg mb-2" style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>No leads found</p><p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Try adjusting your filters or create a new lead</p></div></div>;
    }

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
                {/* Ряды-тайлы на канвасе (LAYOUT-CANON правило 7, .blanc-table-tiles) */}
                <Table className="blanc-table-tiles">
                    <TableHeader>
                        <TableRow>
                            {visibleColumns.map(c => (
                                <TableHead
                                    key={c.id}
                                    className={`text-[11px] font-semibold uppercase tracking-wider px-4 h-11 select-none${c.sortKey ? ' cursor-pointer hover:opacity-70 transition-opacity' : ''}`}
                                    style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.08em' }}
                                    onClick={() => handleHeaderClick(c)}
                                >
                                    <span className="inline-flex items-center gap-1">
                                        {c.label}
                                        {c.sortKey && (
                                            sortBy === c.sortKey
                                                ? (sortOrder === 'asc'
                                                    ? <ArrowUp className="size-3" />
                                                    : <ArrowDown className="size-3" />)
                                                : <ArrowUpDown className="size-3 opacity-30" />
                                        )}
                                    </span>
                                </TableHead>
                            ))}
                            <TableHead className="w-[50px]" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>{leads.map(lead => (
                        <TableRow
                            key={lead.UUID}
                            className={`cursor-pointer ${selectedLeadId === lead.UUID ? 'blanc-tile-row-selected' : ''}`}
                            onClick={() => onSelectLead(lead)}
                        >
                            {visibleColumns.map(c => renderCell(c.id, lead, c.id))}
                            <TableCell className="px-3" onClick={e => e.stopPropagation()}>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <button
                                            className="inline-flex items-center justify-center transition-opacity hover:opacity-70 max-md:min-w-[44px] max-md:min-h-[44px]"
                                            style={{ width: 32, height: 32, borderRadius: 10, color: 'var(--blanc-ink-3)', background: 'transparent' }}
                                        >
                                            <MoreVertical className="size-3.5" />
                                        </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        {lead.Phone && <DropdownMenuItem asChild><a href={`tel:${lead.Phone.replace(/[^\d+]/g, '')}`} onClick={e => e.stopPropagation()} className="flex items-center cursor-pointer"><Phone className="size-4 mr-2" />Call</a></DropdownMenuItem>}
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
            <LoadMoreFooter {...footerProps} />
        </div>
    );
}
