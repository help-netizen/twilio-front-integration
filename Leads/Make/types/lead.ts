// Lead data model types for Workiz integration

export interface Lead {
  // Identity
  UUID: string;
  SerialId: string;
  ClientId: string;
  
  // Timing
  LeadEndDateTime?: string;
  CreatedDate: string;
  Timezone?: string;
  
  // Status
  Status: string;
  SubStatus?: string;
  LeadLost: boolean;
  PaymentDueDate?: string;
  
  // Contact
  FirstName: string;
  LastName: string;
  Company?: string;
  Phone: string;
  PhoneExt?: string;
  SecondPhone?: string;
  SecondPhoneExt?: string;
  Email?: string;
  
  // Address
  Address?: string;
  Unit?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
  Country?: string;
  Latitude?: number;
  Longitude?: number;
  
  // Meta
  JobType?: string;
  ReferralCompany?: string;
  JobSource?: string;
  LeadNotes?: string;
  Comments?: string;
  Team?: string;
  
  // Optional link from API
  link?: string;
}

export interface LeadsListParams {
  start_date: string; // yyyy-MM-dd
  offset?: number;
  records?: number;
  only_open?: boolean;
  status?: string[];
}

export interface LeadsListResponse {
  results: Lead[];
  offset: number;
  records: number;
  has_more: boolean;
}

export interface CreateLeadInput {
  FirstName: string;
  LastName: string;
  Phone: string;
  Email?: string;
  Company?: string;
  Address?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
  JobType?: string;
  JobSource?: string;
  LeadNotes?: string;
  Status?: string;
}

export interface UpdateLeadInput extends Partial<CreateLeadInput> {
  UUID: string;
}

export interface AssignLeadInput {
  UUID: string;
  User: string;
}

export type LeadStatus =
  | 'New'
  | 'Contacted'
  | 'Qualified'
  | 'Proposal Sent'
  | 'Negotiation'
  | 'Lost'
  | 'Converted';

export const LEAD_STATUSES: LeadStatus[] = [
  'New',
  'Contacted',
  'Qualified',
  'Proposal Sent',
  'Negotiation',
  'Lost',
  'Converted'
] as const;