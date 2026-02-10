import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '../ui/table';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Skeleton } from '../ui/skeleton';
import { formatPhone } from '../../lib/formatPhone';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Phone, MoreVertical, PhoneOff, CheckCircle2, Briefcase, Copy } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import type { Lead, TableColumn } from '../../types/lead';

interface LeadsTableProps {
    leads: Lead[];
    loading: boolean;
    selectedLeadId?: string;
    columns: TableColumn[];
    onSelectLead: (lead: Lead) => void;
    onMarkLost: (uuid: string) => void;
    onActivate: (uuid: string) => void;
    onConvert: (uuid: string) => void;
    offset: number;
    hasMore: boolean;
    onNextPage: () => void;
    onPrevPage: () => void;
}

export function LeadsTable({
    leads,
    loading,
    selectedLeadId,
    columns,
    onSelectLead,
    onMarkLost,
    onActivate,
    onConvert,
    offset,
    hasMore,
    onNextPage,
    onPrevPage,
}: LeadsTableProps) {
    const handleCopyPhone = (phone: string, e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(phone);
        toast.success('Phone number copied to clipboard');
    };

    const handleCall = (phone: string, e: React.MouseEvent) => {
        e.stopPropagation();
        window.location.href = `tel:${phone}`;
    };

    const getStatusBadgeVariant = (status: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
        switch (status) {
            case 'New':
            case 'Submitted':
                return 'default';
            case 'Contacted':
                return 'secondary';
            case 'Qualified':
            case 'Proposal Sent':
            case 'Negotiation':
                return 'default';
            case 'Converted':
                return 'outline';
            case 'Lost':
                return 'destructive';
            default:
                return 'secondary';
        }
    };

    // Get visible columns sorted by order
    const visibleColumns = columns
        .filter(col => col.visible)
        .sort((a, b) => a.order - b.order);

    // Render cell content based on column id
    const renderCell = (columnId: string, lead: Lead, key: string) => {
        switch (columnId) {
            case 'status':
                return (
                    <TableCell key={key}>
                        <Badge variant={getStatusBadgeVariant(lead.Status)}>
                            {lead.Status}
                        </Badge>
                    </TableCell>
                );
            case 'name':
                return (
                    <TableCell key={key}>
                        <div>
                            <div className="font-medium">
                                {lead.FirstName} {lead.LastName}
                            </div>
                            {lead.Company && (
                                <div className="text-sm text-muted-foreground">{lead.Company}</div>
                            )}
                        </div>
                    </TableCell>
                );
            case 'phone':
                return (
                    <TableCell key={key}>
                        <div className="flex items-center gap-2">
                            {lead.Phone ? (
                                <a href={`tel:${lead.Phone}`} className="font-mono text-sm text-inherit no-underline hover:text-inherit" onClick={(e) => e.stopPropagation()}>
                                    {formatPhone(lead.Phone)}
                                </a>
                            ) : (
                                <span className="font-mono text-sm">-</span>
                            )}
                            {lead.Phone && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="size-7 p-0"
                                    onClick={(e) => handleCopyPhone(lead.Phone!, e)}
                                >
                                    <Copy className="size-3" />
                                </Button>
                            )}
                        </div>
                    </TableCell>
                );
            case 'email':
                return (
                    <TableCell key={key}>
                        {lead.Email ? (
                            <a href={`mailto:${lead.Email}`} className="text-sm text-inherit no-underline hover:text-inherit" onClick={(e) => e.stopPropagation()}>
                                {lead.Email}
                            </a>
                        ) : '-'}
                    </TableCell>
                );
            case 'location':
                return (
                    <TableCell key={key}>
                        {lead.City && lead.State ? `${lead.City}, ${lead.State}` : '-'}
                    </TableCell>
                );
            case 'jobType':
                return <TableCell key={key}>{lead.JobType || '-'}</TableCell>;
            case 'jobSource':
                return <TableCell key={key}>{lead.JobSource || '-'}</TableCell>;
            case 'created':
                return (
                    <TableCell key={key}>
                        {lead.CreatedDate ? format(new Date(lead.CreatedDate), 'MMM dd, yyyy HH:mm') : '-'}
                    </TableCell>
                );
            case 'serialId':
                return (
                    <TableCell key={key}>
                        <span className="font-mono text-sm">{lead.SerialId}</span>
                    </TableCell>
                );
            default:
                return <TableCell key={key}>-</TableCell>;
        }
    };

    if (loading) {
        return (
            <div className="flex-1 overflow-auto p-4">
                <div className="space-y-3">
                    {[...Array(8)].map((_, i) => (
                        <Skeleton key={i} className="h-16 w-full" />
                    ))}
                </div>
            </div>
        );
    }

    if (leads.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                    <p className="text-lg mb-2">No leads found</p>
                    <p className="text-sm text-muted-foreground">
                        Try adjusting your filters or create a new lead
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
                <Table>
                    <TableHeader className="sticky top-0 bg-background z-10">
                        <TableRow>
                            {visibleColumns.map((column) => (
                                <TableHead key={column.id}>{column.label}</TableHead>
                            ))}
                            <TableHead className="w-[50px]"></TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {leads.map((lead) => (
                            <TableRow
                                key={lead.UUID}
                                className={`cursor-pointer ${selectedLeadId === lead.UUID ? 'bg-muted' : ''
                                    }`}
                                onClick={() => onSelectLead(lead)}
                            >
                                {visibleColumns.map((column) =>
                                    renderCell(column.id, lead, column.id)
                                )}
                                <TableCell onClick={(e) => e.stopPropagation()}>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button variant="ghost" size="sm" className="size-8 p-0">
                                                <MoreVertical className="size-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            {lead.Phone && (
                                                <DropdownMenuItem onClick={(e) => handleCall(lead.Phone!, e)}>
                                                    <Phone className="size-4 mr-2" />
                                                    Call
                                                </DropdownMenuItem>
                                            )}
                                            <DropdownMenuSeparator />
                                            {!lead.LeadLost ? (
                                                <DropdownMenuItem
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onMarkLost(lead.UUID);
                                                    }}
                                                >
                                                    <PhoneOff className="size-4 mr-2" />
                                                    Mark Lost
                                                </DropdownMenuItem>
                                            ) : (
                                                <DropdownMenuItem
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onActivate(lead.UUID);
                                                    }}
                                                >
                                                    <CheckCircle2 className="size-4 mr-2" />
                                                    Activate
                                                </DropdownMenuItem>
                                            )}
                                            {lead.Status !== 'Converted' && !lead.LeadLost && (
                                                <>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onConvert(lead.UUID);
                                                        }}
                                                    >
                                                        <Briefcase className="size-4 mr-2" />
                                                        Convert to Job
                                                    </DropdownMenuItem>
                                                </>
                                            )}
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            {/* Pagination */}
            <div className="border-t p-4 flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                    Showing {offset + 1} - {offset + leads.length} leads
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={onPrevPage}
                        disabled={offset === 0}
                    >
                        Previous
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={onNextPage}
                        disabled={!hasMore}
                    >
                        Next
                    </Button>
                </div>
            </div>
        </div>
    );
}
