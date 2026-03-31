import { useState } from 'react';
import { useEstimates } from '../hooks/useEstimates';
import { EstimateDetailPanel } from '../components/estimates/EstimateDetailPanel';
import { EstimateEditorDialog } from '../components/estimates/EstimateEditorDialog';
import { EstimateSendDialog } from '../components/estimates/EstimateSendDialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Plus, Search, MoreHorizontal, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Estimate, EstimateCreateData } from '../services/estimatesApi';

// ── Status helpers ───────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
    { value: '', label: 'All Statuses' },
    { value: 'draft', label: 'Draft' },
    { value: 'sent', label: 'Sent' },
    { value: 'viewed', label: 'Viewed' },
    { value: 'accepted', label: 'Accepted' },
    { value: 'declined', label: 'Declined' },
    { value: 'expired', label: 'Expired' },
    { value: 'converted', label: 'Converted' },
];

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'secondary',
    sent: 'outline',
    viewed: 'outline',
    accepted: 'default',
    declined: 'destructive',
    expired: 'secondary',
    converted: 'default',
};

function formatMoney(value: string | number): string {
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(value: string | null): string {
    if (!value) return '-';
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Component ────────────────────────────────────────────────────────────────

export function EstimatesPage() {
    const page = useEstimates();
    const [editorOpen, setEditorOpen] = useState(false);
    const [editingEstimate, setEditingEstimate] = useState<Estimate | null>(null);
    const [sendDialogOpen, setSendDialogOpen] = useState(false);
    const [sendEstimateId, setSendEstimateId] = useState<number | null>(null);

    const handleCreate = () => {
        setEditingEstimate(null);
        setEditorOpen(true);
    };

    const handleEdit = (estimate: Estimate) => {
        setEditingEstimate(estimate);
        setEditorOpen(true);
    };

    const handleEditorSave = async (data: EstimateCreateData) => {
        if (editingEstimate) {
            await page.handleUpdateEstimate(editingEstimate.id, data);
        } else {
            await page.handleCreateEstimate(data);
        }
        setEditorOpen(false);
        setEditingEstimate(null);
    };

    const handleSend = (id: number) => {
        setSendEstimateId(id);
        setSendDialogOpen(true);
    };

    return (
        <div className="blanc-page-wrapper">
            {/* ── Page Header ──────────────────────────────────────────── */}
            <div className="blanc-page-header">
                <h1 className="blanc-heading blanc-heading-lg">Estimates</h1>
                <Button onClick={handleCreate}>
                    <Plus className="size-4 mr-1" />New Estimate
                </Button>
            </div>

            {/* ── Toolbar: Filters ─────────────────────────────────────── */}
            <div className="blanc-page-toolbar">
                <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                        <Input
                            placeholder="Search estimates..."
                            className="pl-8"
                            value={page.filters.search}
                            onChange={e => page.setSearch(e.target.value)}
                        />
                    </div>
                    <Select
                        value={page.filters.status || '_all'}
                        onValueChange={v => page.setStatus(v === '_all' ? '' : v)}
                    >
                        <SelectTrigger className="w-[160px]">
                            <SelectValue placeholder="All Statuses" />
                        </SelectTrigger>
                        <SelectContent>
                            {STATUS_OPTIONS.map(opt => (
                                <SelectItem key={opt.value || '_all'} value={opt.value || '_all'}>{opt.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            {/* ── Content Card ─────────────────────────────────────────── */}
            <div className="blanc-page-card">
            {/* ── Left: Estimates List ──────────────────────────────────── */}
            <div className={`flex flex-col overflow-hidden ${page.selectedEstimate ? 'hidden md:flex md:w-[400px] md:flex-shrink-0 border-r' : 'flex flex-1'}`}>

                {/* Table */}
                <div className="flex-1 overflow-auto">
                    {page.loading ? (
                        <div className="flex items-center justify-center h-32">
                            <Loader2 className="size-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : page.estimates.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm">
                            No estimates found
                        </div>
                    ) : (
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-background border-b">
                                <tr>
                                    <th className="text-left px-4 py-2 font-medium">#</th>
                                    <th className="text-left px-4 py-2 font-medium">Customer</th>
                                    <th className="text-left px-4 py-2 font-medium">Status</th>
                                    <th className="text-right px-4 py-2 font-medium">Total</th>
                                    <th className="text-left px-4 py-2 font-medium">Created</th>
                                    <th className="text-right px-4 py-2 font-medium w-10"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {page.estimates.map(est => (
                                    <tr
                                        key={est.id}
                                        className={`border-b cursor-pointer hover:bg-muted/50 transition-colors ${page.selectedEstimate?.id === est.id ? 'bg-muted' : ''}`}
                                        onClick={() => page.selectEstimate(est.id)}
                                    >
                                        <td className="px-4 py-2 font-mono text-xs">{est.estimate_number}</td>
                                        <td className="px-4 py-2 truncate max-w-[180px]">{est.contact_name || est.title || '-'}</td>
                                        <td className="px-4 py-2">
                                            <Badge variant={STATUS_VARIANT[est.status] || 'secondary'} className="capitalize">
                                                {est.status}
                                            </Badge>
                                        </td>
                                        <td className="px-4 py-2 text-right font-mono">${formatMoney(est.total)}</td>
                                        <td className="px-4 py-2 text-muted-foreground">{formatDate(est.created_at)}</td>
                                        <td className="px-4 py-2 text-right">
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
                                                    <Button variant="ghost" size="sm" className="size-7 p-0">
                                                        <MoreHorizontal className="size-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
                                                    <DropdownMenuItem onClick={() => handleEdit(est)}>Edit</DropdownMenuItem>
                                                    {est.status === 'draft' && (
                                                        <DropdownMenuItem onClick={() => handleSend(est.id)}>Send</DropdownMenuItem>
                                                    )}
                                                    <DropdownMenuItem className="text-red-600" onClick={() => page.handleDeleteEstimate(est.id)}>Delete</DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* Pagination */}
                {page.totalPages > 1 && (
                    <div className="border-t px-4 py-2 flex items-center justify-between text-sm text-muted-foreground">
                        <span>{page.total} estimate{page.total !== 1 ? 's' : ''}</span>
                        <div className="flex items-center gap-1">
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={page.filters.page <= 1}
                                onClick={() => page.setPage(page.filters.page - 1)}
                            >
                                <ChevronLeft className="size-4" />
                            </Button>
                            <span className="px-2">Page {page.filters.page} of {page.totalPages}</span>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={page.filters.page >= page.totalPages}
                                onClick={() => page.setPage(page.filters.page + 1)}
                            >
                                <ChevronRight className="size-4" />
                            </Button>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Right: Detail Panel ──────────────────────────────────── */}
            {page.selectedEstimate && (
                <EstimateDetailPanel
                    estimate={page.selectedEstimate}
                    events={page.events}
                    loading={page.detailLoading}
                    onClose={page.closeDetail}
                    onEdit={() => handleEdit(page.selectedEstimate!)}
                    onSend={() => handleSend(page.selectedEstimate!.id)}
                    onApprove={() => page.handleApproveEstimate(page.selectedEstimate!.id)}
                    onDecline={() => page.handleDeclineEstimate(page.selectedEstimate!.id)}
                    onDelete={() => page.handleDeleteEstimate(page.selectedEstimate!.id)}
                    onLinkJob={(jobId: number) => page.handleLinkJob(page.selectedEstimate!.id, jobId)}
                />
            )}

            {/* ── Dialogs ─────────────────────────────────────────────── */}
            <EstimateEditorDialog
                open={editorOpen}
                onOpenChange={setEditorOpen}
                estimate={editingEstimate}
                onSave={handleEditorSave}
            />

            {sendEstimateId != null && (
                <EstimateSendDialog
                    open={sendDialogOpen}
                    onOpenChange={open => { setSendDialogOpen(open); if (!open) setSendEstimateId(null); }}
                    estimateId={sendEstimateId}
                    contactEmail={page.selectedEstimate?.contact_name || ''}
                    onSend={data => page.handleSendEstimate(sendEstimateId, data)}
                />
            )}
            </div>
        </div>
    );
}

export default EstimatesPage;
