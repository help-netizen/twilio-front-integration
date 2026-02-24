import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { LeadsTable } from '../components/leads/LeadsTable';
import { LeadsFilters } from '../components/leads/LeadsFilters';
import { LeadDetailPanel } from '../components/leads/LeadDetailPanel';
import { CreateLeadDialog } from '../components/leads/CreateLeadDialog';
import { EditLeadDialog } from '../components/leads/EditLeadDialog';
import { ColumnSettingsDialog } from '../components/leads/ColumnSettingsDialog';
import { ConvertToJobDialog } from '../components/leads/ConvertToJobDialog';
import { Button } from '../components/ui/button';
import { Plus, Settings } from 'lucide-react';
import * as leadsApi from '../services/leadsApi';
import { authedFetch } from '../services/apiClient';
import type { Lead, LeadsListParams, TableColumn } from '../types/lead';
import { DEFAULT_COLUMNS } from '../types/lead';

const STORAGE_KEY = 'leads-table-columns';

export function LeadsPage() {
    const navigate = useNavigate();
    const { leadId } = useParams<{ leadId?: string }>();
    const [leads, setLeads] = useState<Lead[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
    const [editingLead, setEditingLead] = useState<Lead | null>(null);
    const [createDialogOpen, setCreateDialogOpen] = useState(false);
    const [convertingLead, setConvertingLead] = useState<Lead | null>(null);
    const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);

    // Column settings state
    const [columns, setColumns] = useState<TableColumn[]>(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved ? JSON.parse(saved) : DEFAULT_COLUMNS;
    });

    // Filters state
    const [filters, setFilters] = useState<LeadsListParams>({
        start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        offset: 0,
        records: 100,
        only_open: true,
        status: [],
    });

    const [searchQuery, setSearchQuery] = useState('');
    const [sourceFilter, setSourceFilter] = useState<string[]>([]);
    const [jobTypeFilter, setJobTypeFilter] = useState<string[]>([]);
    const [hasMore, setHasMore] = useState(false);

    // Searchable custom field definitions (for metadata search)
    const [searchableFields, setSearchableFields] = useState<{ api_name: string }[]>([]);
    useEffect(() => {
        authedFetch('/api/settings/lead-form')
            .then(res => res.json())
            .then(data => {
                if (data.success && data.customFields) {
                    setSearchableFields(
                        data.customFields
                            .filter((f: any) => f.is_searchable && !f.is_system)
                            .map((f: any) => ({ api_name: f.api_name }))
                    );
                }
            })
            .catch(() => { /* best-effort */ });
    }, []);

    // Load leads
    const loadLeads = async (newFilters?: LeadsListParams) => {
        setLoading(true);
        try {
            const params = newFilters || filters;
            const response = await leadsApi.listLeads(params);
            setLeads(response.data.results);
            setHasMore(response.data.pagination.has_more);
        } catch (error) {
            toast.error('Failed to load leads', {
                description: error instanceof Error ? error.message : 'Unknown error'
            });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadLeads();
    }, [filters.start_date, filters.only_open, filters.status, filters.offset]);

    // Auto-open lead from URL param (e.g. /leads/:leadId)
    useEffect(() => {
        if (!leadId) return;
        const numericId = Number(leadId);
        if (!numericId || isNaN(numericId)) return;
        // Don't re-fetch if already selected
        if (selectedLead?.ClientId === String(numericId)) return;
        (async () => {
            try {
                const detail = await leadsApi.getLeadById(numericId);
                setSelectedLead(detail.data.lead);
            } catch (err) {
                console.warn('[LeadsPage] Failed to load lead from URL:', leadId, err);
            }
        })();
    }, [leadId]);

    // Client-side search + filter
    const filteredLeads = useMemo(() => {
        let result = leads;

        // Text search
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            result = result.filter(lead => {
                // Standard fields
                if (
                    lead.FirstName?.toLowerCase().includes(query) ||
                    lead.LastName?.toLowerCase().includes(query) ||
                    lead.Company?.toLowerCase().includes(query) ||
                    lead.Phone?.includes(query) ||
                    lead.Email?.toLowerCase().includes(query) ||
                    String(lead.SerialId)?.includes(query)
                ) return true;

                // Searchable metadata fields
                if (lead.Metadata && searchableFields.length > 0) {
                    for (const f of searchableFields) {
                        const val = (lead.Metadata as any)[f.api_name];
                        if (val && String(val).toLowerCase().includes(query)) return true;
                    }
                }

                return false;
            });
        }

        // Source filter
        if (sourceFilter.length > 0) {
            result = result.filter(lead =>
                lead.JobSource && sourceFilter.includes(lead.JobSource)
            );
        }

        // Job type filter
        if (jobTypeFilter.length > 0) {
            result = result.filter(lead =>
                lead.JobType && jobTypeFilter.includes(lead.JobType)
            );
        }

        return result;
    }, [leads, searchQuery, sourceFilter, jobTypeFilter, searchableFields]);

    // Handle filter changes
    const handleFiltersChange = (newFilters: Partial<LeadsListParams>) => {
        setFilters(prev => ({ ...prev, ...newFilters, offset: 0 }));
    };

    // Handle pagination
    const handleNextPage = () => {
        if (hasMore) {
            setFilters(prev => ({ ...prev, offset: (prev.offset || 0) + (prev.records || 100) }));
        }
    };

    const handlePrevPage = () => {
        setFilters(prev => ({
            ...prev,
            offset: Math.max(0, (prev.offset || 0) - (prev.records || 100))
        }));
    };

    // Handle lead selection — fetch full detail
    const handleSelectLead = async (lead: Lead) => {
        // Update URL to reflect selected lead
        const leadUrlId = lead.SerialId || lead.ClientId;
        if (leadUrlId) navigate(`/leads/${leadUrlId}`, { replace: true });
        try {
            const detail = await leadsApi.getLeadByUUID(lead.UUID);
            setSelectedLead(detail.data.lead);
        } catch {
            setSelectedLead(lead);
        }
    };

    // Handle column settings
    const handleSaveColumns = (newColumns: TableColumn[]) => {
        setColumns(newColumns);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newColumns));
    };

    // Handle lead actions
    const handleMarkLost = async (uuid: string) => {
        try {
            await leadsApi.markLost(uuid);
            // Refresh
            const detail = await leadsApi.getLeadByUUID(uuid);
            const updated = detail.data.lead;
            setLeads(prev => prev.map(l => l.UUID === uuid ? updated : l));
            if (selectedLead?.UUID === uuid) setSelectedLead(updated);
            toast.success('Lead marked as lost');
        } catch (error) {
            toast.error('Failed to mark lead as lost');
        }
    };

    const handleActivate = async (uuid: string) => {
        try {
            await leadsApi.activateLead(uuid);
            const detail = await leadsApi.getLeadByUUID(uuid);
            const updated = detail.data.lead;
            setLeads(prev => prev.map(l => l.UUID === uuid ? updated : l));
            if (selectedLead?.UUID === uuid) setSelectedLead(updated);
            toast.success('Lead activated');
        } catch (error) {
            toast.error('Failed to activate lead');
        }
    };

    const handleConvert = (uuid: string) => {
        // Find the lead and open the booking dialog
        const lead = leads.find(l => l.UUID === uuid) || selectedLead;
        if (lead) {
            setConvertingLead(lead);
        }
    };

    const handleConvertSuccess = async (updatedLead: Lead) => {
        // Refresh the lead from server
        try {
            const detail = await leadsApi.getLeadByUUID(updatedLead.UUID);
            const freshLead = detail.data.lead;
            setLeads(prev => prev.map(l => l.UUID === freshLead.UUID ? freshLead : l));
            if (selectedLead?.UUID === freshLead.UUID) setSelectedLead(freshLead);
        } catch {
            // Fallback: use the lead data we have
            setLeads(prev => prev.map(l => l.UUID === updatedLead.UUID ? updatedLead : l));
        }
        setConvertingLead(null);
    };

    const handleUpdateComments = async (uuid: string, comments: string) => {
        try {
            await leadsApi.updateLead(uuid, { Comments: comments });
            const detail = await leadsApi.getLeadByUUID(uuid);
            const updated = detail.data.lead;
            setLeads(prev => prev.map(l => l.UUID === uuid ? updated : l));
            if (selectedLead?.UUID === uuid) setSelectedLead(updated);
            toast.success('Comments saved');
        } catch (error) {
            toast.error('Failed to save comments');
        }
    };

    const handleUpdateStatus = async (uuid: string, status: string) => {
        try {
            await leadsApi.updateLead(uuid, { Status: status } as any);
            const detail = await leadsApi.getLeadByUUID(uuid);
            const updated = detail.data.lead;
            setLeads(prev => prev.map(l => l.UUID === uuid ? updated : l));
            if (selectedLead?.UUID === uuid) setSelectedLead(updated);
            toast.success('Status updated');
        } catch (error) {
            toast.error('Failed to update status');
        }
    };

    const handleUpdateSource = async (uuid: string, source: string) => {
        try {
            await leadsApi.updateLead(uuid, { JobSource: source });
            const detail = await leadsApi.getLeadByUUID(uuid);
            const updated = detail.data.lead;
            setLeads(prev => prev.map(l => l.UUID === uuid ? updated : l));
            if (selectedLead?.UUID === uuid) setSelectedLead(updated);
            toast.success('Source updated');
        } catch (error) {
            toast.error('Failed to update source');
        }
    };

    const handleDelete = async (uuid: string) => {
        // No delete endpoint yet — mark as lost instead
        await handleMarkLost(uuid);
    };

    const handleCreateLead = async (lead: Lead) => {
        setLeads(prev => [lead, ...prev]);
        setCreateDialogOpen(false);
        toast.success('Lead created successfully');
    };

    const handleUpdateLead = async (lead: Lead) => {
        setLeads(prev => prev.map(l => l.UUID === lead.UUID ? lead : l));
        if (selectedLead?.UUID === lead.UUID) {
            setSelectedLead(lead);
        }
        setEditingLead(null);
        toast.success('Lead updated successfully');
    };

    return (
        <div className="flex h-full overflow-hidden">
            {/* Left: Leads List */}
            <div className={`flex-1 flex flex-col border-r overflow-x-auto ${selectedLead ? 'hidden md:flex' : 'flex'}`}>
                {/* Filters Bar */}
                <div className="border-b p-4 space-y-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-xl font-semibold">Leads</h2>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="icon"
                                onClick={() => setSettingsDialogOpen(true)}
                                title="Column settings"
                            >
                                <Settings className="size-4" />
                            </Button>
                            <Button onClick={() => setCreateDialogOpen(true)}>
                                <Plus className="size-4 mr-2" />
                                Create Lead
                            </Button>
                        </div>
                    </div>

                    <LeadsFilters
                        filters={filters}
                        searchQuery={searchQuery}
                        sourceFilter={sourceFilter}
                        jobTypeFilter={jobTypeFilter}
                        onFiltersChange={handleFiltersChange}
                        onSearchChange={setSearchQuery}
                        onSourceFilterChange={setSourceFilter}
                        onJobTypeFilterChange={setJobTypeFilter}
                    />
                </div>

                {/* Leads Table */}
                <LeadsTable
                    leads={filteredLeads}
                    loading={loading}
                    selectedLeadId={selectedLead?.UUID}
                    columns={columns}
                    onSelectLead={handleSelectLead}
                    onMarkLost={handleMarkLost}
                    onActivate={handleActivate}
                    onConvert={handleConvert}
                    offset={filters.offset || 0}
                    hasMore={hasMore}
                    onNextPage={handleNextPage}
                    onPrevPage={handlePrevPage}
                />
            </div>

            {/* Right: Detail Panel */}
            <LeadDetailPanel
                lead={selectedLead}
                onClose={() => { setSelectedLead(null); navigate('/leads', { replace: true }); }}
                onEdit={(lead) => setEditingLead(lead)}
                onMarkLost={handleMarkLost}
                onActivate={handleActivate}
                onConvert={handleConvert}
                onUpdateComments={handleUpdateComments}
                onUpdateStatus={handleUpdateStatus}
                onUpdateSource={handleUpdateSource}
                onDelete={handleDelete}
            />

            {/* Dialogs */}
            <CreateLeadDialog
                open={createDialogOpen}
                onOpenChange={setCreateDialogOpen}
                onSuccess={handleCreateLead}
            />

            {editingLead && (
                <EditLeadDialog
                    lead={editingLead}
                    open={!!editingLead}
                    onOpenChange={(open) => !open && setEditingLead(null)}
                    onSuccess={handleUpdateLead}
                />
            )}

            <ColumnSettingsDialog
                open={settingsDialogOpen}
                onOpenChange={setSettingsDialogOpen}
                columns={columns}
                onSave={handleSaveColumns}
            />

            {convertingLead && (
                <ConvertToJobDialog
                    lead={convertingLead}
                    open={!!convertingLead}
                    onOpenChange={(open) => !open && setConvertingLead(null)}
                    onSuccess={handleConvertSuccess}
                />
            )}
        </div>
    );
}

export default LeadsPage;
