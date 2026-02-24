/**
 * Contact data model types.
 */

export type ContactAddress = {
    formatted?: string;
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    lat?: number;
    lng?: number;
    nickname?: string;
    is_default_address_for_customer?: boolean;
    id?: string;
};

export type Contact = {
    id: number;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    phone_e164: string | null;
    secondary_phone: string | null;
    secondary_phone_name: string | null;
    email: string | null;
    notes: string | null;
    zenbooker_customer_id: string | null;
    zenbooker_sync_status: 'not_linked' | 'linked' | 'pending' | 'error' | null;
    zenbooker_synced_at: string | null;
    zenbooker_last_error: string | null;
    created_at: string;
    updated_at: string;
    // Zenbooker-sourced data
    addresses: ContactAddress[];
    jobs: string[];
    recurring_bookings: string[];
    stripe_customer_id: string | null;
    zenbooker_creation_date: string | null;
    zenbooker_id: string | null;
};

export type DedupeCandidate = {
    id: number;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    phone_e164: string | null;
    secondary_phone: string | null;
    email: string | null;
    company_name: string | null;
    city: string | null;
    state: string | null;
    name_match: boolean;
    phone_match: boolean;
    email_match: boolean;
};

export type SearchCandidatesResponse = {
    ok: true;
    data: {
        candidates: DedupeCandidate[];
    };
    meta: { request_id: string; timestamp: string };
};

export type ContactLead = {
    id: number;
    uuid: string;
    status: string;
    sub_status: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
    job_type: string | null;
    job_source: string | null;
    lead_notes: string | null;
    serial_id: number;
    created_at: string;
};

export type ContactsListParams = {
    search?: string;
    offset?: number;
    limit?: number;
};

export type ContactsPagination = {
    offset: number;
    limit: number;
    returned: number;
    has_more: boolean;
};

export type ContactsListResponse = {
    ok: true;
    data: {
        results: Contact[];
        pagination: ContactsPagination;
    };
    meta: { request_id: string; timestamp: string };
};

export type ContactDetailResponse = {
    ok: true;
    data: {
        contact: Contact;
        leads: ContactLead[];
    };
    meta: { request_id: string; timestamp: string };
};
