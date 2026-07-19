import type { Dispatch, SetStateAction } from 'react';
import { toast } from 'sonner';
import * as leadsApi from '../services/leadsApi';
import type { Lead } from '../types/lead';

type SetLead = Dispatch<SetStateAction<Lead | null>>;
type ResetLeads = () => Promise<void>;
type UpdateLeadItem = (key: string, update: (lead: Lead) => Lead) => void;

async function refreshLead(
    uuid: string,
    updateItem: UpdateLeadItem,
    selectedLead: Lead | null,
    setSelectedLead: SetLead,
) {
    const detail = await leadsApi.getLeadByUUID(uuid);
    const updated = detail.data.lead;
    updateItem(uuid, () => updated);
    if (selectedLead?.UUID === uuid) setSelectedLead(updated);
    return updated;
}

export function createLeadActions(
    leads: Lead[],
    selectedLead: Lead | null,
    resetLeads: ResetLeads,
    updateItem: UpdateLeadItem,
    setSelectedLead: SetLead,
    setEditingLead: SetLead,
    setConvertingLead: SetLead,
    setCreateDialogOpen: (value: boolean) => void,
) {
    const resetAfterMutation = async (uuid: string) => {
        await refreshLead(uuid, updateItem, selectedLead, setSelectedLead);
        await resetLeads();
    };

    const handleMarkLost = async (uuid: string) => {
        try {
            await leadsApi.markLost(uuid);
            await resetAfterMutation(uuid);
            toast.success('Lead marked as lost');
        } catch {
            toast.error('Failed to mark lead as lost');
        }
    };

    const handleActivate = async (uuid: string) => {
        try {
            await leadsApi.activateLead(uuid);
            await resetAfterMutation(uuid);
            toast.success('Lead activated');
        } catch {
            toast.error('Failed to activate lead');
        }
    };

    const handleConvert = (uuid: string) => {
        const lead = leads.find(item => item.UUID === uuid) || selectedLead;
        if (lead) setConvertingLead(lead);
    };

    const handleConvertSuccess = async (updatedLead: Lead) => {
        updateItem(updatedLead.UUID, () => updatedLead);
        if (selectedLead?.UUID === updatedLead.UUID) setSelectedLead(updatedLead);
        await resetLeads();
        setConvertingLead(null);
    };

    const handleUpdateComments = async (uuid: string, comments: string) => {
        try {
            await leadsApi.updateLead(uuid, { Comments: comments });
            await refreshLead(uuid, updateItem, selectedLead, setSelectedLead);
            toast.success('Comments saved');
        } catch {
            toast.error('Failed to save comments');
        }
    };

    const handleUpdateStatus = async (uuid: string, status: string) => {
        try {
            await leadsApi.updateLead(uuid, { Status: status } as any);
            await resetAfterMutation(uuid);
            toast.success('Status updated');
        } catch {
            toast.error('Failed to update status');
        }
    };

    const handleUpdateSource = async (uuid: string, source: string) => {
        try {
            await leadsApi.updateLead(uuid, { JobSource: source });
            await resetAfterMutation(uuid);
            toast.success('Source updated');
        } catch {
            toast.error('Failed to update source');
        }
    };

    const handleDelete = async (uuid: string) => {
        await handleMarkLost(uuid);
    };

    const handleCreateLead = async () => {
        setCreateDialogOpen(false);
        await resetLeads();
        toast.success('Lead created successfully');
    };

    const handleUpdateLead = async (lead: Lead) => {
        updateItem(lead.UUID, () => lead);
        if (selectedLead?.UUID === lead.UUID) setSelectedLead(lead);
        setEditingLead(null);
        await resetLeads();
        toast.success('Lead updated successfully');
    };

    return {
        handleMarkLost,
        handleActivate,
        handleConvert,
        handleConvertSuccess,
        handleUpdateComments,
        handleUpdateStatus,
        handleUpdateSource,
        handleDelete,
        handleCreateLead,
        handleUpdateLead,
    };
}
