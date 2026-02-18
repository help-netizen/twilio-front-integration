/**
 * Contact data model types.
 */

export type Contact = {
    id: number;
    full_name: string | null;
    phone_e164: string | null;
    email: string | null;
    notes: string | null;
    zenbooker_customer_id: string | null;
    created_at: string;
    updated_at: string;
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
