import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner@2.0.3';
import { LeadsTable } from '../leads/LeadsTable';
import { LeadsFilters } from '../leads/LeadsFilters';
import { LeadDetailPanel } from '../leads/LeadDetailPanel';
import { CreateLeadDialog } from '../leads/CreateLeadDialog';
import { EditLeadDialog } from '../leads/EditLeadDialog';
import { ColumnSettingsDialog } from '../leads/ColumnSettingsDialog';
import { Button } from '../ui/button';
import { Plus, Settings } from 'lucide-react';
import { mockLeadsAPI } from '../../lib/mock-api';
import type { Lead, LeadsListParams } from '../../types/lead';
import type { TableColumn } from '../../types/table-settings';
import { DEFAULT_COLUMNS } from '../../types/table-settings';

const STORAGE_KEY = 'leads-table-columns';

export function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  
  // Column settings state
  const [columns, setColumns] = useState<TableColumn[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : DEFAULT_COLUMNS;
  });
  
  // Filters state
  const [filters, setFilters] = useState<LeadsListParams>({
    start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Last 7 days
    offset: 0,
    records: 100,
    only_open: true,
    status: [],
  });
  
  const [searchQuery, setSearchQuery] = useState('');
  const [hasMore, setHasMore] = useState(false);

  // Load leads
  const loadLeads = async (newFilters?: LeadsListParams) => {
    setLoading(true);
    try {
      const params = newFilters || filters;
      const response = await mockLeadsAPI.list(params);
      setLeads(response.results);
      setHasMore(response.has_more);
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

  // Client-side search
  const filteredLeads = useMemo(() => {
    if (!searchQuery.trim()) return leads;
    
    const query = searchQuery.toLowerCase();
    return leads.filter(lead => 
      lead.FirstName?.toLowerCase().includes(query) ||
      lead.LastName?.toLowerCase().includes(query) ||
      lead.Company?.toLowerCase().includes(query) ||
      lead.Phone?.includes(query) ||
      lead.Email?.toLowerCase().includes(query) ||
      lead.SerialId?.toLowerCase().includes(query)
    );
  }, [leads, searchQuery]);

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

  // Handle lead selection
  const handleSelectLead = (lead: Lead) => {
    setSelectedLead(lead);
  };

  // Handle column settings
  const handleSaveColumns = (newColumns: TableColumn[]) => {
    setColumns(newColumns);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newColumns));
  };

  // Handle lead actions
  const handleMarkLost = async (uuid: string) => {
    try {
      const updatedLead = await mockLeadsAPI.markLost(uuid);
      setLeads(prev => prev.map(l => l.UUID === uuid ? updatedLead : l));
      if (selectedLead?.UUID === uuid) {
        setSelectedLead(updatedLead);
      }
      toast.success('Lead marked as lost');
    } catch (error) {
      toast.error('Failed to mark lead as lost');
    }
  };

  const handleActivate = async (uuid: string) => {
    try {
      const updatedLead = await mockLeadsAPI.activate(uuid);
      setLeads(prev => prev.map(l => l.UUID === uuid ? updatedLead : l));
      if (selectedLead?.UUID === uuid) {
        setSelectedLead(updatedLead);
      }
      toast.success('Lead activated');
    } catch (error) {
      toast.error('Failed to activate lead');
    }
  };

  const handleConvert = async (uuid: string) => {
    try {
      const result = await mockLeadsAPI.convert(uuid);
      setLeads(prev => prev.map(l => l.UUID === uuid ? result.lead : l));
      if (selectedLead?.UUID === uuid) {
        setSelectedLead(result.lead);
      }
      toast.success('Lead converted to job', {
        description: `Job ID: ${result.jobId}`
      });
    } catch (error) {
      toast.error('Failed to convert lead');
    }
  };

  const handleUpdateComments = async (uuid: string, comments: string) => {
    try {
      const updatedLead = await mockLeadsAPI.update(uuid, { Comments: comments });
      setLeads(prev => prev.map(l => l.UUID === uuid ? updatedLead : l));
      if (selectedLead?.UUID === uuid) {
        setSelectedLead(updatedLead);
      }
      toast.success('Comments saved');
    } catch (error) {
      toast.error('Failed to save comments');
    }
  };

  const handleUpdateStatus = async (uuid: string, status: string) => {
    try {
      const updatedLead = await mockLeadsAPI.update(uuid, { Status: status });
      setLeads(prev => prev.map(l => l.UUID === uuid ? updatedLead : l));
      if (selectedLead?.UUID === uuid) {
        setSelectedLead(updatedLead);
      }
      toast.success('Status updated');
    } catch (error) {
      toast.error('Failed to update status');
    }
  };

  const handleUpdateSource = async (uuid: string, source: string) => {
    try {
      const updatedLead = await mockLeadsAPI.update(uuid, { JobSource: source });
      setLeads(prev => prev.map(l => l.UUID === uuid ? updatedLead : l));
      if (selectedLead?.UUID === uuid) {
        setSelectedLead(updatedLead);
      }
      toast.success('Source updated');
    } catch (error) {
      toast.error('Failed to update source');
    }
  };

  const handleDelete = async (uuid: string) => {
    try {
      await mockLeadsAPI.delete(uuid);
      setLeads(prev => prev.filter(l => l.UUID !== uuid));
      if (selectedLead?.UUID === uuid) {
        setSelectedLead(null);
      }
      toast.success('Lead deleted');
    } catch (error) {
      toast.error('Failed to delete lead');
    }
  };

  const handleAssign = async (uuid: string, user: string) => {
    try {
      const updatedLead = await mockLeadsAPI.assign({ UUID: uuid, User: user });
      setLeads(prev => prev.map(l => l.UUID === uuid ? updatedLead : l));
      if (selectedLead?.UUID === uuid) {
        setSelectedLead(updatedLead);
      }
      toast.success(`Lead assigned to ${user}`);
    } catch (error) {
      toast.error('Failed to assign lead');
    }
  };

  const handleUnassign = async (uuid: string) => {
    try {
      const updatedLead = await mockLeadsAPI.unassign(uuid);
      setLeads(prev => prev.map(l => l.UUID === uuid ? updatedLead : l));
      if (selectedLead?.UUID === uuid) {
        setSelectedLead(updatedLead);
      }
      toast.success('Lead unassigned');
    } catch (error) {
      toast.error('Failed to unassign lead');
    }
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
            onFiltersChange={handleFiltersChange}
            onSearchChange={setSearchQuery}
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
        onClose={() => setSelectedLead(null)}
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
    </div>
  );
}