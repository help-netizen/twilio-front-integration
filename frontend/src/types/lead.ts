/**
 * Lead data model types for Workiz integration.
 * Uses Tech Spec types with nullable fields to match Workiz API reality.
 */

export type Lead = {
    UUID: string;
    SerialId?: number | null;
    LeadDateTime?: string | null;
    LeadEndDateTime?: string | null;
    CreatedDate?: string | null;
    ClientId?: number | string | null;
    Status: string;
    SubStatus?: string | null;
    LeadLost?: number | boolean | null;
    PaymentDueDate?: string | null;

    Phone?: string | null;
    PhoneExt?: string | null;
    SecondPhone?: string | null;
    SecondPhoneExt?: string | null;
    SecondPhoneName?: string | null;
    Email?: string | null;

    FirstName?: string | null;
    LastName?: string | null;
    Company?: string | null;

    Address?: string | null;
    Unit?: string | null;
    City?: string | null;
    State?: string | null;
    PostalCode?: string | null;
    Country?: string | null;
    Latitude?: string | number | null;
    Longitude?: string | number | null;

    JobType?: string | null;
    ReferralCompany?: string | null;
    Timezone?: string | null;
    JobSource?: string | null;
    Description?: string | null;
    Comments?: string | null;

    Tags?: string[] | null;
    Team?: Array<{ id: string | number; name: string }> | null;
    WorkizLink?: string | null;
    Metadata?: Record<string, string> | null;
    ContactId?: number | null;
    ContactName?: string | null;
};

export type LeadsListParams = {
    start_date?: string; // YYYY-MM-DD
    offset?: number;
    records?: number;
    only_open?: boolean;
    status?: string[];
};

export type LeadsPagination = {
    offset: number;
    records: number;
    returned: number;
    has_more: boolean;
};

export type LeadsListResponse = {
    ok: true;
    data: {
        results: Lead[];
        pagination: LeadsPagination;
        filters: {
            start_date: string | null;
            only_open: boolean;
            status: string[];
        };
    };
    meta: { request_id: string; timestamp: string };
};

export type LeadDetailResponse = {
    ok: true;
    data: {
        lead: Lead;
    };
    meta: { request_id: string; timestamp: string };
};

export type LeadMutationResponse = {
    ok: true;
    data: {
        UUID?: string;
        ClientId?: string;
        link?: string;
        message?: string;
        job_id?: number;
        zenbooker_job_id?: string;
        contact_resolution?: {
            contact_id: number | null;
            status: 'matched' | 'created' | 'ambiguous';
            matched_by: 'phone' | 'email' | 'none';
            email_enriched: boolean;
            warnings: string[];
        };
    };
    meta: { request_id: string; timestamp: string };
};

export type ApiError = {
    ok: false;
    error: {
        code: string;
        message: string;
        details?: unknown;
        correlation_id: string;
    };
};

export type CreateLeadInput = {
    LeadDateTime?: string;
    LeadEndDateTime?: string;
    FirstName: string;
    LastName: string;
    Phone: string;
    PhoneExt?: string;
    SecondPhone?: string;
    SecondPhoneExt?: string;
    SecondPhoneName?: string;
    Email?: string;
    Company?: string;
    Address?: string;
    Unit?: string;
    City?: string;
    State?: string;
    PostalCode?: string;
    Country?: string;
    Latitude?: number | null;
    Longitude?: number | null;
    JobType?: string;
    JobSource?: string;
    ReferralCompany?: string;
    Timezone?: string;
    Description?: string;
    Status?: string;
    Tags?: string[];
    Metadata?: Record<string, string>;
};

export type UpdateLeadInput = Partial<Omit<CreateLeadInput, 'FirstName' | 'LastName' | 'Phone'>> & {
    FirstName?: string;
    LastName?: string;
    Phone?: string;
    Comments?: string;
};

export type TableColumn = {
    id: string;
    label: string;
    visible: boolean;
    order: number;
    locked?: boolean;
};

export const DEFAULT_COLUMNS: TableColumn[] = [
    { id: 'status', label: 'Status', visible: true, order: 0 },
    { id: 'name', label: 'Name', visible: true, order: 1 },
    { id: 'phone', label: 'Phone', visible: true, order: 2 },
    { id: 'email', label: 'Email', visible: true, order: 3 },
    { id: 'location', label: 'Location', visible: true, order: 4 },
    { id: 'jobType', label: 'Job Type', visible: true, order: 5 },
    { id: 'jobSource', label: 'Source', visible: true, order: 6 },
    { id: 'contact', label: 'Contact', visible: true, order: 7 },
    { id: 'created', label: 'Created', visible: true, order: 8 },
    { id: 'serialId', label: 'ID', visible: true, order: 9 },
];

export type LeadStatus =
    | 'Submitted'
    | 'New'
    | 'Contacted'
    | 'Qualified'
    | 'Proposal Sent'
    | 'Negotiation'
    | 'Lost'
    | 'Converted';

export const LEAD_STATUSES: LeadStatus[] = [
    'Submitted',
    'New',
    'Contacted',
    'Qualified',
    'Proposal Sent',
    'Negotiation',
    'Lost',
    'Converted',
];

export const JOB_SOURCES = [
    'eLocals',
    'ServiceDirect',
    'Inquirly',
    'Rely',
    'LHG',
    'NSA',
    'Website',
    'Google',
] as const;


export const JOB_TYPES = [
    'COD Service',
    'COD Repair',
    'Warranty',
    'INS Service',
    'INS Repair',
] as const;
