import type { Lead, UpdateLeadInput } from '../../types/lead';
import { formatUSPhone } from '../ui/PhoneInput';

export interface EditLeadDialogProps { lead: Lead; open: boolean; onOpenChange: (open: boolean) => void; onSuccess: (lead: Lead) => void; }
export interface CustomFieldDef { id: string; display_name: string; api_name: string; field_type: string; is_system: boolean; sort_order: number; }

export const DEFAULT_JOB_TYPES = ['COD Service', 'COD Repair', 'Warranty', 'INS Service', 'INS Repair'];
export const JOB_SOURCES = ['eLocals', 'Inquirly', 'Servicedirect', 'ProReferral', 'Google', 'Thumbtack', 'Yelp'];

export function makeFormData(lead: Lead): UpdateLeadInput {
    return {
        FirstName: lead.FirstName || '', LastName: lead.LastName || '',
        Phone: formatUSPhone(lead.Phone || ''), SecondPhone: formatUSPhone(lead.SecondPhone || ''),
        SecondPhoneName: lead.SecondPhoneName || '', Email: lead.Email || '', Company: lead.Company || '',
        Address: lead.Address || '', Unit: lead.Unit || '', City: lead.City || '',
        State: lead.State || '', PostalCode: lead.PostalCode || '',
        JobType: lead.JobType || '', JobSource: lead.JobSource || '',
        Description: lead.Description || '', Metadata: lead.Metadata || {},
    };
}
