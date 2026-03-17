import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Button } from '../ui/button';
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

    if (loading) return <div className="flex-1 overflow-auto p-4"><div className="space-y-3">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div></div>;
    if (leads.length === 0) return <div className="flex-1 flex items-center justify-center"><div className="text-center"><p className="text-lg mb-2">No leads found</p><p className="text-sm text-muted-foreground">Try adjusting your filters or create a new lead</p></div></div>;

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
                <Table>
                    <TableHeader className="sticky top-0 bg-background z-10"><TableRow>{visibleColumns.map(c => <TableHead key={c.id}>{c.label}</TableHead>)}<TableHead className="w-[50px]" /></TableRow></TableHeader>
                    <TableBody>{leads.map(lead => (
                        <TableRow key={lead.UUID} className={`cursor-pointer ${selectedLeadId === lead.UUID ? 'bg-muted' : ''}`} onClick={() => onSelectLead(lead)}>
                            {visibleColumns.map(c => renderCell(c.id, lead, c.id))}
                            <TableCell onClick={e => e.stopPropagation()}>
                                <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="size-8 p-0"><MoreVertical className="size-4" /></Button></DropdownMenuTrigger>
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
            <div className="border-t p-4 flex items-center justify-between"><div className="text-sm text-muted-foreground">Showing {offset + 1} - {offset + leads.length} leads</div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={onPrevPage} disabled={offset === 0}>Previous</Button><Button variant="outline" size="sm" onClick={onNextPage} disabled={!hasMore}>Next</Button></div></div>
        </div>
    );
}
