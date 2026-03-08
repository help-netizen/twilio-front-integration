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
import { createLeadActions } from '../hooks/useLeadsActions';

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
    const [columns, setColumns] = useState<TableColumn[]>(() => { const saved = localStorage.getItem(STORAGE_KEY); return saved ? JSON.parse(saved) : DEFAULT_COLUMNS; });
    const [filters, setFilters] = useState<LeadsListParams>({ start_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], end_date: new Date().toISOString().split('T')[0], offset: 0, records: 100, only_open: true, status: [] });
    const [searchQuery, setSearchQuery] = useState('');
    const [sourceFilter, setSourceFilter] = useState<string[]>([]);
    const [jobTypeFilter, setJobTypeFilter] = useState<string[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [searchableFields, setSearchableFields] = useState<{ api_name: string }[]>([]);

    useEffect(() => { authedFetch('/api/settings/lead-form').then(r => r.json()).then(d => { if (d.success && d.customFields) setSearchableFields(d.customFields.filter((f: any) => f.is_searchable && !f.is_system).map((f: any) => ({ api_name: f.api_name }))); }).catch(() => { }); }, []);

    const loadLeads = async (newFilters?: LeadsListParams) => {
        setLoading(true);
        try { const params = newFilters || filters; const response = await leadsApi.listLeads(params); setLeads(response.data.results); setHasMore(response.data.pagination.has_more); }
        catch (error) { toast.error('Failed to load leads', { description: error instanceof Error ? error.message : 'Unknown error' }); }
        finally { setLoading(false); }
    };

    useEffect(() => { loadLeads(); }, [filters.start_date, filters.end_date, filters.only_open, filters.status, filters.offset]);

    useEffect(() => {
        if (!leadId) return; const numericId = Number(leadId); if (!numericId || isNaN(numericId)) return;
        if (selectedLead?.ClientId === String(numericId)) return;
        (async () => { try { const detail = await leadsApi.getLeadById(numericId); setSelectedLead(detail.data.lead); } catch (err) { console.warn('[LeadsPage] Failed to load lead from URL:', leadId, err); } })();
    }, [leadId]);

    const filteredLeads = useMemo(() => {
        let result = leads;
        if (searchQuery.trim()) { const q = searchQuery.toLowerCase(); result = result.filter(lead => { const fn = `${lead.FirstName || ''} ${lead.LastName || ''}`.toLowerCase(); if (fn.includes(q) || lead.Company?.toLowerCase().includes(q) || lead.Phone?.includes(q) || lead.Email?.toLowerCase().includes(q) || String(lead.SerialId)?.includes(q)) return true; if (lead.Metadata && searchableFields.length > 0) { for (const f of searchableFields) { const v = (lead.Metadata as any)[f.api_name]; if (v && String(v).toLowerCase().includes(q)) return true; } } return false; }); }
        if (sourceFilter.length > 0) result = result.filter(l => l.JobSource && sourceFilter.includes(l.JobSource));
        if (jobTypeFilter.length > 0) result = result.filter(l => l.JobType && jobTypeFilter.includes(l.JobType));
        return result;
    }, [leads, searchQuery, sourceFilter, jobTypeFilter, searchableFields]);

    const handleFiltersChange = (nf: Partial<LeadsListParams>) => setFilters(prev => ({ ...prev, ...nf, offset: 0 }));
    const handleNextPage = () => { if (hasMore) setFilters(prev => ({ ...prev, offset: (prev.offset || 0) + (prev.records || 100) })); };
    const handlePrevPage = () => { setFilters(prev => ({ ...prev, offset: Math.max(0, (prev.offset || 0) - (prev.records || 100)) })); };
    const handleSelectLead = async (lead: Lead) => { const id = lead.SerialId || lead.ClientId; if (id) navigate(`/leads/${id}`, { replace: true }); try { const d = await leadsApi.getLeadByUUID(lead.UUID); setSelectedLead(d.data.lead); } catch { setSelectedLead(lead); } };
    const handleSaveColumns = (nc: TableColumn[]) => { setColumns(nc); localStorage.setItem(STORAGE_KEY, JSON.stringify(nc)); };

    const actions = createLeadActions(leads, selectedLead, setLeads, setSelectedLead, setEditingLead, setConvertingLead, setCreateDialogOpen);

    return (
        <div className="flex h-full overflow-hidden">
            <div className={`flex-1 flex flex-col border-r overflow-x-auto ${selectedLead ? 'hidden md:flex' : 'flex'}`}>
                <div className="border-b p-4 space-y-4"><div className="flex items-center justify-between"><h2 className="text-xl font-semibold">Leads</h2><div className="flex items-center gap-2"><Button variant="outline" size="icon" onClick={() => setSettingsDialogOpen(true)} title="Column settings"><Settings className="size-4" /></Button><Button onClick={() => setCreateDialogOpen(true)}><Plus className="size-4 mr-2" />Create Lead</Button></div></div>
                    <LeadsFilters filters={filters} searchQuery={searchQuery} sourceFilter={sourceFilter} jobTypeFilter={jobTypeFilter} onFiltersChange={handleFiltersChange} onSearchChange={setSearchQuery} onSourceFilterChange={setSourceFilter} onJobTypeFilterChange={setJobTypeFilter} />
                </div>
                <LeadsTable leads={filteredLeads} loading={loading} selectedLeadId={selectedLead?.UUID} columns={columns} onSelectLead={handleSelectLead} onMarkLost={actions.handleMarkLost} onActivate={actions.handleActivate} onConvert={actions.handleConvert} offset={filters.offset || 0} hasMore={hasMore} onNextPage={handleNextPage} onPrevPage={handlePrevPage} />
            </div>
            <LeadDetailPanel lead={selectedLead} onClose={() => { setSelectedLead(null); navigate('/leads', { replace: true }); }} onEdit={l => setEditingLead(l)} onMarkLost={actions.handleMarkLost} onActivate={actions.handleActivate} onConvert={actions.handleConvert} onUpdateComments={actions.handleUpdateComments} onUpdateStatus={actions.handleUpdateStatus} onUpdateSource={actions.handleUpdateSource} onDelete={actions.handleDelete} />
            <CreateLeadDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} onSuccess={actions.handleCreateLead} />
            {editingLead && <EditLeadDialog lead={editingLead} open={!!editingLead} onOpenChange={open => !open && setEditingLead(null)} onSuccess={actions.handleUpdateLead} />}
            <ColumnSettingsDialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen} columns={columns} onSave={handleSaveColumns} />
            {convertingLead && <ConvertToJobDialog lead={convertingLead} open={!!convertingLead} onOpenChange={open => !open && setConvertingLead(null)} onSuccess={actions.handleConvertSuccess} />}
        </div>
    );
}

export default LeadsPage;
