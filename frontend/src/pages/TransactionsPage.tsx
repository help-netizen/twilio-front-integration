import { useState } from 'react';
import { useTransactions } from '../hooks/useTransactions';
import { TransactionDetailPanel } from '../components/transactions/TransactionDetailPanel';
import { RecordPaymentDialog } from '../components/transactions/RecordPaymentDialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Plus, Search, MoreHorizontal, Loader2, ChevronLeft, ChevronRight, DollarSign, TrendingDown, Clock, Minus } from 'lucide-react';

// -- Constants ----------------------------------------------------------------

const STATUS_OPTIONS = [
    { value: '', label: 'All Statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'processing', label: 'Processing' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'refunded', label: 'Refunded' },
    { value: 'voided', label: 'Voided' },
];

const TYPE_OPTIONS = [
    { value: '', label: 'All Types' },
    { value: 'payment', label: 'Payment' },
    { value: 'refund', label: 'Refund' },
    { value: 'adjustment', label: 'Adjustment' },
];

const TYPE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    payment: 'default',
    refund: 'destructive',
    adjustment: 'secondary',
};

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    pending: 'outline',
    processing: 'outline',
    completed: 'default',
    failed: 'destructive',
    refunded: 'secondary',
    voided: 'secondary',
};

const METHOD_LABELS: Record<string, string> = {
    credit_card: 'Credit Card',
    ach: 'ACH',
    check: 'Check',
    cash: 'Cash',
    other: 'Other',
    zenbooker_sync: 'Zenbooker',
};

function formatMoney(value: string | number): string {
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(value: string | null): string {
    if (!value) return '-';
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// -- Summary Card -------------------------------------------------------------

function SummaryCard({ label, value, icon: Icon, className }: { label: string; value: string; icon: any; className?: string }) {
    return (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-md border ${className || ''}`}>
            <Icon className="size-4 text-muted-foreground" />
            <div>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-sm font-semibold font-mono">${formatMoney(value)}</p>
            </div>
        </div>
    );
}

// -- Component ----------------------------------------------------------------

export function TransactionsPage() {
    const page = useTransactions();
    const [recordOpen, setRecordOpen] = useState(false);

    return (
        <div className="flex h-full overflow-hidden">
            {/* -- Left: Transactions List ---------------------------------------- */}
            <div className={`flex flex-col overflow-hidden ${page.selectedTransaction ? 'hidden md:flex md:w-[500px] md:flex-shrink-0 border-r' : 'flex flex-1'}`}>
                {/* Summary bar */}
                {page.summary && (
                    <div className="border-b px-4 py-3 flex items-center gap-3 overflow-x-auto">
                        <SummaryCard label="Total Collected" value={page.summary.total_collected} icon={DollarSign} />
                        <SummaryCard label="Total Refunded" value={page.summary.total_refunded} icon={TrendingDown} />
                        <SummaryCard label="Total Pending" value={page.summary.total_pending} icon={Clock} />
                        <SummaryCard label="Net" value={page.summary.net_amount} icon={Minus} />
                    </div>
                )}

                {/* Toolbar */}
                <div className="border-b p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <h2 className="text-lg font-semibold">Transactions</h2>
                        <Button size="sm" onClick={() => setRecordOpen(true)}>
                            <Plus className="size-4 mr-1" />Record Payment
                        </Button>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                            <Input
                                placeholder="Search transactions..."
                                className="pl-8"
                                value={page.filters.search}
                                onChange={e => page.setSearch(e.target.value)}
                            />
                        </div>
                        <Select
                            value={page.filters.status || '_all'}
                            onValueChange={v => page.setStatus(v === '_all' ? '' : v)}
                        >
                            <SelectTrigger className="w-[150px]">
                                <SelectValue placeholder="All Statuses" />
                            </SelectTrigger>
                            <SelectContent>
                                {STATUS_OPTIONS.map(opt => (
                                    <SelectItem key={opt.value || '_all'} value={opt.value || '_all'}>{opt.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select
                            value={page.filters.transaction_type || '_all'}
                            onValueChange={v => page.setType(v === '_all' ? '' : v)}
                        >
                            <SelectTrigger className="w-[140px]">
                                <SelectValue placeholder="All Types" />
                            </SelectTrigger>
                            <SelectContent>
                                {TYPE_OPTIONS.map(opt => (
                                    <SelectItem key={opt.value || '_all'} value={opt.value || '_all'}>{opt.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                {/* Table */}
                <div className="flex-1 overflow-auto">
                    {page.loading ? (
                        <div className="flex items-center justify-center h-32">
                            <Loader2 className="size-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : page.transactions.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm">
                            No transactions found
                        </div>
                    ) : (
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-background border-b">
                                <tr>
                                    <th className="text-left px-4 py-2 font-medium">ID</th>
                                    <th className="text-left px-4 py-2 font-medium">Type</th>
                                    <th className="text-left px-4 py-2 font-medium">Method</th>
                                    <th className="text-right px-4 py-2 font-medium">Amount</th>
                                    <th className="text-left px-4 py-2 font-medium">Status</th>
                                    <th className="text-left px-4 py-2 font-medium">Invoice</th>
                                    <th className="text-left px-4 py-2 font-medium">Date</th>
                                    <th className="text-right px-4 py-2 font-medium w-10"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {page.transactions.map(txn => (
                                    <tr
                                        key={txn.id}
                                        className={`border-b cursor-pointer hover:bg-muted/50 transition-colors ${page.selectedTransaction?.id === txn.id ? 'bg-muted' : ''}`}
                                        onClick={() => page.selectTransaction(txn.id)}
                                    >
                                        <td className="px-4 py-2 font-mono text-xs">#{txn.id}</td>
                                        <td className="px-4 py-2">
                                            <Badge variant={TYPE_VARIANT[txn.transaction_type] || 'secondary'} className="capitalize">
                                                {txn.transaction_type}
                                            </Badge>
                                        </td>
                                        <td className="px-4 py-2 text-muted-foreground">{METHOD_LABELS[txn.payment_method] || txn.payment_method}</td>
                                        <td className="px-4 py-2 text-right font-mono">${formatMoney(txn.amount)}</td>
                                        <td className="px-4 py-2">
                                            <Badge variant={STATUS_VARIANT[txn.status] || 'secondary'} className="capitalize">
                                                {txn.status}
                                            </Badge>
                                        </td>
                                        <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                                            {txn.invoice_id ? `#${txn.invoice_id}` : '-'}
                                        </td>
                                        <td className="px-4 py-2 text-muted-foreground">{formatDate(txn.created_at)}</td>
                                        <td className="px-4 py-2 text-right">
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
                                                    <Button variant="ghost" size="sm" className="size-7 p-0">
                                                        <MoreHorizontal className="size-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
                                                    <DropdownMenuItem onClick={() => page.selectTransaction(txn.id)}>View Details</DropdownMenuItem>
                                                    {txn.status === 'completed' && txn.transaction_type === 'payment' && (
                                                        <DropdownMenuItem onClick={() => page.selectTransaction(txn.id)}>Refund</DropdownMenuItem>
                                                    )}
                                                    {(txn.status === 'pending' || txn.status === 'processing') && (
                                                        <DropdownMenuItem className="text-red-600" onClick={() => page.handleVoid(txn.id)}>Void</DropdownMenuItem>
                                                    )}
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
                        <span>{page.total} transaction{page.total !== 1 ? 's' : ''}</span>
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

            {/* -- Right: Detail Panel -------------------------------------------- */}
            {page.selectedTransaction && (
                <TransactionDetailPanel
                    transaction={page.selectedTransaction}
                    receipt={page.receipt}
                    onClose={page.closeDetail}
                    onRefund={page.handleRefund}
                    onVoid={page.handleVoid}
                    onSendReceipt={page.handleSendReceipt}
                />
            )}

            {/* -- Dialogs -------------------------------------------------------- */}
            <RecordPaymentDialog
                open={recordOpen}
                onOpenChange={setRecordOpen}
                onSave={page.handleRecordManual}
            />
        </div>
    );
}

export default TransactionsPage;
