import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LeadsTable } from '../components/leads/LeadsTable';
import { LeadsFilters } from '../components/leads/LeadsFilters';
import { LeadsMobileBar } from '../components/leads/LeadsMobileBar';
import { LeadsMobileList } from '../components/leads/LeadsMobileList';
import { LeadDetailPanel } from '../components/leads/LeadDetailPanel';
import { CreateLeadDialog } from '../components/leads/CreateLeadDialog';
import { EditLeadDialog } from '../components/leads/EditLeadDialog';
import { ColumnSettingsDialog } from '../components/leads/ColumnSettingsDialog';
import { ConvertToJobDialog } from '../components/leads/ConvertToJobDialog';
import { Plus, Settings } from 'lucide-react';
import * as leadsApi from '../services/leadsApi';
import type { Lead, LeadsListParams, TableColumn } from '../types/lead';
import { serverNow, serverDate } from '../utils/serverClock';
import { DEFAULT_COLUMNS } from '../types/lead';
import { createLeadActions } from '../hooks/useLeadsActions';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';
import { MobileListPage } from '../components/layout/MobileListPage';
import { useIsMobile } from '../hooks/useIsMobile';
import { useAuthz } from '../hooks/useAuthz';
import { useLoadMoreList } from '../hooks/useLoadMoreList';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch';
import type { LoadMoreFooterProps } from '../components/lists/LoadMoreFooter';

const STORAGE_KEY = 'leads-table-columns';
const LEADS_PAGE_SIZE = 100;
const leadKey = (lead: Lead) => lead.UUID;

export function LeadsPage() {
    const navigate = useNavigate();
    const { leadId } = useParams<{ leadId?: string }>();
    const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
    const [editingLead, setEditingLead] = useState<Lead | null>(null);
    const [createDialogOpen, setCreateDialogOpen] = useState(false);
    const [convertingLead, setConvertingLead] = useState<Lead | null>(null);
    const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
    const [columns, setColumns] = useState<TableColumn[]>(() => { const saved = localStorage.getItem(STORAGE_KEY); return saved ? JSON.parse(saved) : DEFAULT_COLUMNS; });
    const [filters, setFilters] = useState<LeadsListParams>({ start_date: new Date(serverNow() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], end_date: serverDate().toISOString().split('T')[0], only_open: true, status: [] });
    const [searchQuery, setSearchQuery] = useState('');
    const [sourceFilter, setSourceFilter] = useState<string[]>([]);
    const [jobTypeFilter, setJobTypeFilter] = useState<string[]>([]);
    const [rejectedOnly, setRejectedOnly] = useState(false);
    const [sortBy, setSortBy] = useState<string>('CreatedDate');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
    const isMobile = useIsMobile();
    const { company, hasPermission } = useAuthz();
    const canCreateLead = hasPermission('leads.create');
    const debouncedSearch = useDebouncedSearch(searchQuery, 300);
    const normalizedStatuses = [...(filters.status || [])].sort();
    const normalizedSources = [...sourceFilter].sort();
    const normalizedJobTypes = [...jobTypeFilter].sort();
    const leadsList = useLoadMoreList<Lead>({
        queryKey: [
            'leads-list',
            company?.id ?? null,
            filters.start_date ?? null,
            filters.end_date ?? null,
            filters.only_open ?? true,
            normalizedStatuses,
            debouncedSearch,
            normalizedSources,
            normalizedJobTypes,
            rejectedOnly,
            sortBy,
            sortOrder,
        ],
        pageSize: LEADS_PAGE_SIZE,
        enabled: !!company?.id,
        fetchPage: async ({ cursor, limit, signal }) => {
            const response = await leadsApi.listLeads({
                start_date: filters.start_date,
                end_date: filters.end_date,
                only_open: filters.only_open,
                status: normalizedStatuses,
                search: debouncedSearch || undefined,
                source: normalizedSources,
                job_type: normalizedJobTypes,
                rejected_only: rejectedOnly,
                sort_by: sortBy,
                sort_order: sortOrder,
                limit,
                cursor: cursor ?? undefined,
            }, signal);
            return {
                items: response.data.results,
                pagination: {
                    ...response.data.pagination,
                    mode: 'cursor' as const,
                },
                meta: null,
            };
        },
        getItemKey: leadKey,
    });
    const leads = leadsList.items;
    const loading = leadsList.isLoadingFirst;

    useEffect(() => {
        if (!leadId) return; const numericId = Number(leadId); if (!numericId || isNaN(numericId)) return;
        if (selectedLead?.ClientId === String(numericId)) return;
        (async () => { try { const detail = await leadsApi.getLeadById(numericId); setSelectedLead(detail.data.lead); } catch (err) { console.warn('[LeadsPage] Failed to load lead from URL:', leadId, err); } })();
    }, [leadId]);

    const handleFiltersChange = (nextFilters: Partial<LeadsListParams>) => setFilters(previous => ({ ...previous, ...nextFilters }));
    const handleSelectLead = async (lead: Lead) => { const id = lead.SerialId || lead.ClientId; if (id) navigate(`/leads/${id}`, { replace: true }); try { const d = await leadsApi.getLeadByUUID(lead.UUID); setSelectedLead(d.data.lead); } catch { setSelectedLead(lead); } };
    const handleSaveColumns = (nc: TableColumn[]) => { setColumns(nc); localStorage.setItem(STORAGE_KEY, JSON.stringify(nc)); };

    const actions = createLeadActions(leads, selectedLead, leadsList.reset, leadsList.updateItem, setSelectedLead, setEditingLead, setConvertingLead, setCreateDialogOpen);
    const footerProps: LoadMoreFooterProps = {
        state: leadsList.state,
        loadedCount: leads.length,
        totalCount: leadsList.total,
        singularLabel: 'lead',
        pluralLabel: 'leads',
        errorPhase: leadsList.errorPhase,
        onLoadMore: () => { void leadsList.loadMore(); },
        onRetry: () => { void leadsList.retry(); },
    };

    const detailAndDialogs = (
        <>
            <FloatingDetailPanel open={!!selectedLead} onClose={() => { setSelectedLead(null); navigate('/leads', { replace: true }); }} wide>
                <LeadDetailPanel lead={selectedLead} onClose={() => { setSelectedLead(null); navigate('/leads', { replace: true }); }} onEdit={l => setEditingLead(l)} onMarkLost={actions.handleMarkLost} onActivate={actions.handleActivate} onConvert={actions.handleConvert} onUpdateComments={actions.handleUpdateComments} onUpdateStatus={actions.handleUpdateStatus} onUpdateSource={actions.handleUpdateSource} onDelete={actions.handleDelete} />
            </FloatingDetailPanel>
            <CreateLeadDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} onSuccess={actions.handleCreateLead} />
            {editingLead && <EditLeadDialog lead={editingLead} open={!!editingLead} onOpenChange={open => !open && setEditingLead(null)} onSuccess={actions.handleUpdateLead} />}
            <ColumnSettingsDialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen} columns={columns} onSave={handleSaveColumns} />
            {convertingLead && <ConvertToJobDialog lead={convertingLead} open={!!convertingLead} onOpenChange={open => !open && setConvertingLead(null)} onSuccess={actions.handleConvertSuccess} />}
        </>
    );

    if (isMobile) {
        return (
            <>
                <MobileListPage
                    stickyBar={
                        <LeadsMobileBar
                            searchQuery={searchQuery} setSearchQuery={setSearchQuery}
                            filters={filters} onFiltersChange={handleFiltersChange}
                            sourceFilter={sourceFilter} onSourceFilterChange={setSourceFilter}
                            jobTypeFilter={jobTypeFilter} onJobTypeFilterChange={setJobTypeFilter}
                            rejectedOnly={rejectedOnly} onToggleRejected={() => setRejectedOnly(current => !current)}
                            sortBy={sortBy} sortOrder={sortOrder} onSortChange={(field, order) => { setSortBy(field); setSortOrder(order); }}
                            onNewLead={() => setCreateDialogOpen(true)}
                            canCreateLead={canCreateLead}
                        />
                    }
                >
                    <LeadsMobileList
                        filteredLeads={leads}
                        loading={loading}
                        footerProps={footerProps}
                        onSelectLead={handleSelectLead}
                        timezone={company?.timezone}
                    />
                </MobileListPage>
                {detailAndDialogs}
            </>
        );
    }

    // Desktop only — mobile early-returns above.
    return (
        <div className="blanc-page-wrapper">
            {!isMobile && (
                <>
                    {/* Unified header: title + search + controls in one row */}
                    <div className="blanc-unified-header">
                        <h1 className="blanc-header-title">Leads</h1>

                        <div className="blanc-search-wrapper">
                            <input
                                type="text"
                                placeholder="type to find anything..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="blanc-search-input"
                            />
                        </div>

                        <div className="blanc-controls-group">
                            <LeadsFilters filters={filters} sourceFilter={sourceFilter} jobTypeFilter={jobTypeFilter} rejectedOnly={rejectedOnly} onFiltersChange={handleFiltersChange} onSourceFilterChange={setSourceFilter} onJobTypeFilterChange={setJobTypeFilter} onToggleRejected={() => setRejectedOnly(current => !current)} />
                            <button
                                onClick={() => setSettingsDialogOpen(true)}
                                className="blanc-control-chip-icon"
                                title="Column settings"
                            >
                                <Settings className="size-4" />
                            </button>
                            {canCreateLead && (
                                <button
                                    onClick={() => setCreateDialogOpen(true)}
                                    className="blanc-control-chip-primary"
                                >
                                    <Plus className="size-4" />Create Lead
                                </button>
                            )}
                        </div>
                    </div>
                    {/* Аквариум .blanc-page-card снесён (правило 7): невидимый layout-контейнер */}
                    <div className="flex flex-1 flex-col min-h-0">
                        <div className="flex-1 flex flex-col overflow-x-auto">
                            <LeadsTable leads={leads} loading={loading} selectedLeadId={selectedLead?.UUID} columns={columns} onSelectLead={handleSelectLead} onMarkLost={actions.handleMarkLost} onActivate={actions.handleActivate} onConvert={actions.handleConvert} footerProps={footerProps} sortBy={sortBy} sortOrder={sortOrder} onSortChange={(field, order) => { setSortBy(field); setSortOrder(order); }} />
                        </div>
                    </div>
                </>
            )}
            {detailAndDialogs}
        </div>
    );
}

export default LeadsPage;
