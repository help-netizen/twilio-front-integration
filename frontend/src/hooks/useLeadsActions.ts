import type { Dispatch, SetStateAction } from 'react';
import { toast } from 'sonner';
import * as leadsApi from '../services/leadsApi';
import type { Lead } from '../types/lead';

type SetLeads = Dispatch<SetStateAction<Lead[]>>;
type SetLead = Dispatch<SetStateAction<Lead | null>>;

async function refreshLead(uuid: string, setLeads: SetLeads, selectedLead: Lead | null, setSelectedLead: SetLead) {
    const detail = await leadsApi.getLeadByUUID(uuid);
    const updated = detail.data.lead;
    setLeads(prev => prev.map(l => l.UUID === uuid ? updated : l));
    if (selectedLead?.UUID === uuid) setSelectedLead(updated);
    return updated;
}

export function createLeadActions(leads: Lead[], selectedLead: Lead | null, setLeads: SetLeads, setSelectedLead: SetLead, setEditingLead: SetLead, setConvertingLead: SetLead, setCreateDialogOpen: (v: boolean) => void) {
    const handleMarkLost = async (uuid: string) => {
        try { await leadsApi.markLost(uuid); await refreshLead(uuid, setLeads, selectedLead, setSelectedLead); toast.success('Lead marked as lost'); }
        catch { toast.error('Failed to mark lead as lost'); }
    };

    const handleActivate = async (uuid: string) => {
        try { await leadsApi.activateLead(uuid); await refreshLead(uuid, setLeads, selectedLead, setSelectedLead); toast.success('Lead activated'); }
        catch { toast.error('Failed to activate lead'); }
    };

    const handleConvert = (uuid: string) => {
        const lead = leads.find(l => l.UUID === uuid) || selectedLead;
        if (lead) setConvertingLead(lead);
    };

    const handleConvertSuccess = async (updatedLead: Lead) => {
        try { await refreshLead(updatedLead.UUID, setLeads, selectedLead, setSelectedLead); } catch { setLeads(prev => prev.map(l => l.UUID === updatedLead.UUID ? updatedLead : l)); }
        setConvertingLead(null);
    };

    const handleUpdateComments = async (uuid: string, comments: string) => {
        try { await leadsApi.updateLead(uuid, { Comments: comments }); await refreshLead(uuid, setLeads, selectedLead, setSelectedLead); toast.success('Comments saved'); }
        catch { toast.error('Failed to save comments'); }
    };

    const handleUpdateStatus = async (uuid: string, status: string) => {
        try { await leadsApi.updateLead(uuid, { Status: status } as any); await refreshLead(uuid, setLeads, selectedLead, setSelectedLead); toast.success('Status updated'); }
        catch { toast.error('Failed to update status'); }
    };

    const handleUpdateSource = async (uuid: string, source: string) => {
        try { await leadsApi.updateLead(uuid, { JobSource: source }); await refreshLead(uuid, setLeads, selectedLead, setSelectedLead); toast.success('Source updated'); }
        catch { toast.error('Failed to update source'); }
    };

    const handleDelete = async (uuid: string) => { await handleMarkLost(uuid); };
    const handleCreateLead = async (lead: Lead) => { setLeads(prev => [lead, ...prev]); setCreateDialogOpen(false); toast.success('Lead created successfully'); };
    const handleUpdateLead = async (lead: Lead) => { setLeads(prev => prev.map(l => l.UUID === lead.UUID ? lead : l)); if (selectedLead?.UUID === lead.UUID) setSelectedLead(lead); setEditingLead(null); toast.success('Lead updated successfully'); };

    return { handleMarkLost, handleActivate, handleConvert, handleConvertSuccess, handleUpdateComments, handleUpdateStatus, handleUpdateSource, handleDelete, handleCreateLead, handleUpdateLead };
}
