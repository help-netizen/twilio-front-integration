import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useEstimates } from '../hooks/useEstimates';
import { EstimateDetailPanel } from '../components/estimates/EstimateDetailPanel';
import { EstimateEditorDialog } from '../components/estimates/EstimateEditorDialog';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { StatusPill } from '../components/estimates/EstimateStatusPill';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Loader2, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { Estimate, EstimateCreateData } from '../services/estimatesApi';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';

// ── Status helpers ───────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
    { value: '', label: 'All Statuses' },
    { value: 'draft', label: 'Draft' },
    { value: 'sent', label: 'Sent' },
    { value: 'viewed', label: 'Viewed' },
    { value: 'approved', label: 'Approved' },
    { value: 'declined', label: 'Declined' },
];

function formatMoney(value: string | number): string {
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Component ────────────────────────────────────────────────────────────────

export function EstimatesPage() {
    const page = useEstimates();
    const [editorOpen, setEditorOpen] = useState(false);
    const [editingEstimate, setEditingEstimate] = useState<Estimate | null>(null);
    const [searchParams, setSearchParams] = useSearchParams();

    // Auto-open an estimate when navigated with ?openId=<id> (e.g. from a Task).
    useEffect(() => {
        const openId = searchParams.get('openId');
        if (!openId) return;
        const idNum = Number(openId);
        if (Number.isFinite(idNum)) page.selectEstimate(idNum);
        searchParams.delete('openId');
        setSearchParams(searchParams, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    /**
     * Hydrate before opening. A list row carries no line items, and the editor
     * used to read that as "this estimate has none" and save a full replacement
     * over the real ones — so editing from a row could delete every line, with
     * nothing on screen to suggest it had happened. The backend now treats an
     * absent `items` key as "leave them alone" (ESTIMATE-REDESIGN-001 P3), which
     * makes the deletion impossible; loading the real estimate first is what
     * makes the EDITOR honest, since it can only offer to change what it has.
     */
    const handleEdit = async (estimate: Estimate) => {
        setEditingEstimate(estimate);
        setEditorOpen(true);
        if (estimate.items) return;
        try {
            const { fetchEstimate } = await import('../services/estimatesApi');
            const full = await fetchEstimate(estimate.id);
            setEditingEstimate(current => (current?.id === full.id ? full : current));
        } catch {
            // Leave the row in place: the editor shows what it knows, and an
            // omitted `items` key no longer destroys anything on save.
        }
    };

    /**
     * Creating an estimate from the estimates page did not exist: the page mounted
     * an editor with no way to open it for a new record, and the save callback
     * only handled an existing one. A page whose whole subject is estimates could
     * not make one — you had to find a job or a lead first.
     *
     * A parentless estimate is allowed (P4 backend): you often start pricing
     * before you know which job it will belong to. Sending it and turning it into
     * an invoice both still require a customer, which is where that actually
     * matters.
     */
    const handleNew = () => {
        setEditingEstimate(null);
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

    return (
        <div className="blanc-page-wrapper">
            {/* ── Unified Header ──────────────────────────────────────── */}
            <div className="blanc-unified-header">
                <h1 className="blanc-header-title">Estimates</h1>

                <div className="blanc-search-wrapper">
                    <input
                        type="text"
                        placeholder="type to find anything..."
                        value={page.filters.search}
                        onChange={e => page.setSearch(e.target.value)}
                        className="blanc-search-input"
                    />
                </div>

                <div className="blanc-controls-group">
                    <div className="inline-flex rounded-md border bg-background p-0.5">
                        <button
                            className={`px-3 py-1 text-sm ${!page.filters.includeArchived ? 'rounded bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                            onClick={() => page.setIncludeArchived(false)}
                        >
                            Only Open
                        </button>
                        <button
                            className={`px-3 py-1 text-sm ${page.filters.includeArchived ? 'rounded bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                            onClick={() => page.setIncludeArchived(true)}
                        >
                            All
                        </button>
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
                    <Button onClick={handleNew} data-testid="estimate-new">
                        <Plus className="mr-1.5 size-4" />New estimate
                    </Button>
                </div>
            </div>

            {/* Аквариум снесён (правило 7): невидимый layout-контейнер */}
            <div className="flex flex-1 flex-col min-h-0">
            {/* ── Left: Estimates List ──────────────────────────────────── */}
            <div className="flex flex-1 flex-col overflow-hidden">

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
                        /* ESTIMATE-REDESIGN-001 S1 — rows, not a seven-column table
                           squeezed onto a phone. Each row answers the three things
                           you scan a proposal list for: whose it is, how much, and
                           where it stands — with the age built into the status,
                           because how long it has been waiting IS the reason to act.
                           Opening the row is the action; there is no per-row menu. */
                        <div className="space-y-2 px-3 py-2" data-testid="estimates-list">
                            {page.estimates.map(est => (
                                <button
                                    key={est.id}
                                    type="button"
                                    onClick={() => page.selectEstimate(est.id)}
                                    data-testid={`estimate-row-${est.id}`}
                                    className={`block w-full rounded-2xl px-4 py-3.5 text-left transition-colors ${
                                        page.selectedEstimate?.id === est.id ? 'ring-1' : ''
                                    } ${est.archived_at ? 'opacity-60' : ''}`}
                                    style={{
                                        background: 'var(--blanc-surface-strong)',
                                        ...(page.selectedEstimate?.id === est.id
                                            ? { boxShadow: 'inset 0 0 0 1px var(--blanc-accent)' }
                                            : {}),
                                    }}
                                >
                                    <div className="flex items-baseline justify-between gap-3">
                                        <span className="blanc-l2 truncate" style={{ fontWeight: 600 }}>
                                            {est.contact_name || est.title || 'No customer yet'}
                                        </span>
                                        <span
                                            className="shrink-0 text-[20px] font-semibold tabular-nums"
                                            style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.02em' }}
                                        >
                                            ${formatMoney(est.total)}
                                        </span>
                                    </div>
                                    <div className="blanc-l2 blanc-l2-quiet mt-0.5 truncate">
                                        {est.estimate_number}
                                        {est.summary ? ` · ${est.summary}` : ''}
                                    </div>
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                        <StatusPill estimate={est} />
                                        {est.archived_at && <Badge variant="outline">Archived</Badge>}
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Pagination */}
                {page.totalPages > 1 && (
                    <div className="px-4 py-2 flex items-center justify-between text-sm text-muted-foreground">
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

            {/* ── Dialogs ─────────────────────────────────────────────── */}
            <EstimateEditorDialog
                open={editorOpen}
                onOpenChange={setEditorOpen}
                estimate={editingEstimate}
                onSave={handleEditorSave}
            />

            {/* Sending lives on the estimate you opened, and nowhere else.
                This page used to host its own send dialog fed by the row's id and
                by `selectedEstimate`'s recipient — two different estimates could
                supply the two halves, so one customer's proposal could be
                addressed to another's inbox. One object, one estimate, no seam. */}
            </div>

            <FloatingDetailPanel open={!!page.selectedEstimate} onClose={page.closeDetail} wide>
                {page.selectedEstimate && (
                    <EstimateDetailPanel
                        estimate={page.selectedEstimate}
                        events={page.events}
                        loading={page.detailLoading}
                        onClose={page.closeDetail}
                        onEdit={() => handleEdit(page.selectedEstimate!)}
                        onSend={data => page.handleSendEstimate(page.selectedEstimate!.id, data)}
                        onApprove={() => page.handleApproveEstimate(page.selectedEstimate!.id)}
                        onDecline={(reason: string) => page.handleDeclineEstimate(page.selectedEstimate!.id, reason)}
                        onArchive={() => page.handleArchiveEstimate(page.selectedEstimate!.id)}
                        onRestore={() => page.handleRestoreEstimate(page.selectedEstimate!.id)}
                        onLinkJob={(jobId: number) => page.handleLinkJob(page.selectedEstimate!.id, jobId)}
                    />
                )}
            </FloatingDetailPanel>
        </div>
    );
}

export default EstimatesPage;
