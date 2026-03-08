import { toast } from 'sonner';
import * as leadsApi from '../services/leadsApi';
import type { Lead } from '../types/lead';

type LeadSetter = (lead: Lead | null) => void;

export function makePulseLeadActions(setLeadOverride: LeadSetter) {
    const handleUpdateStatus = async (uuid: string, status: string) => {
        try { await leadsApi.updateLead(uuid, { Status: status } as any); const d = await leadsApi.getLeadByUUID(uuid); setLeadOverride(d.data.lead); toast.success('Status updated'); }
        catch { toast.error('Failed to update status'); }
    };
    const handleUpdateSource = async (uuid: string, source: string) => {
        try { await leadsApi.updateLead(uuid, { JobSource: source }); const d = await leadsApi.getLeadByUUID(uuid); setLeadOverride(d.data.lead); toast.success('Source updated'); }
        catch { toast.error('Failed to update source'); }
    };
    const handleUpdateComments = async (uuid: string, comments: string) => {
        try { await leadsApi.updateLead(uuid, { Comments: comments }); const d = await leadsApi.getLeadByUUID(uuid); setLeadOverride(d.data.lead); toast.success('Comments saved'); }
        catch { toast.error('Failed to save comments'); }
    };
    const handleMarkLost = async (uuid: string) => {
        try { await leadsApi.markLost(uuid); const d = await leadsApi.getLeadByUUID(uuid); setLeadOverride(d.data.lead); toast.success('Lead marked as lost'); }
        catch { toast.error('Failed to mark lead as lost'); }
    };
    const handleActivate = async (uuid: string) => {
        try { await leadsApi.activateLead(uuid); const d = await leadsApi.getLeadByUUID(uuid); setLeadOverride(d.data.lead); toast.success('Lead activated'); }
        catch { toast.error('Failed to activate lead'); }
    };
    const handleConvertSuccess = async (updatedLead: Lead) => {
        try { const d = await leadsApi.getLeadByUUID(updatedLead.UUID); setLeadOverride(d.data.lead); }
        catch { setLeadOverride(updatedLead); }
    };

    return { handleUpdateStatus, handleUpdateSource, handleUpdateComments, handleMarkLost, handleActivate, handleConvertSuccess };
}
