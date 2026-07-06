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
    /** Additional contact emails (EMAIL-TIMELINE-001). Optional until the backend surfaces it. Primary-first string[]. */
    contact_emails?: string[];
    /** Richer email list (CONTACT-EMAIL-MERGE-001). Optional; when present, preferred over contact_emails for the editor. */
    emails?: { email: string; is_primary?: boolean }[];
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
    secondary_phone_name: string | null;
    email: string | null;
    company_name: string | null;
    city: string | null;
    state: string | null;
    name_match: boolean;
    phone_match: boolean;
    email_match: boolean;
    addresses?: Array<{
        line1: string | null;
        line2: string | null;
        city: string | null;
        state: string | null;
        postal_code: string | null;
        lat?: number | null;
        lng?: number | null;
    }>;
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

// ─── CONTACT-MERGE-001 — 409 CONTACT_ATTRIBUTE_CONFLICT contract ──────────────
// Shapes are fixed by Docs/specs/CONTACT-MERGE-001.md §API contract (Decision A):
// PATCH /api/contacts/:id detects that an added phone/email belongs to ANOTHER
// contact, rolls back, and returns this payload; the retry echoes `resolutions`.

/** One conflicting attribute as detected server-side (round-1 payload). */
export type ContactConflictAttribute = {
    kind: 'phone' | 'email';
    /** The value as submitted by the editor (display form). */
    value: string;
    /** Server-normalized form (digits for phones, lowercased for emails). */
    normalized: string;
};

/** A phone row inside a conflict party composition. */
export type ContactConflictPartyPhone = {
    value: string;
    /** Slot label (secondary_phone_name) when present. */
    label: string | null;
    slot: 'primary' | 'secondary';
};

/** An email row inside a conflict party composition. */
export type ContactConflictPartyEmail = {
    email: string;
    is_primary: boolean;
};

/** Full composition of one side of the dialog (owner or the contact being edited). */
export type ContactConflictParty = {
    id: number;
    full_name: string | null;
    company_name: string | null;
    phones: ContactConflictPartyPhone[];
    emails: ContactConflictPartyEmail[];
};

/**
 * One dialog's worth of conflict: grouped BY OWNER — several conflicting
 * attributes of one owner arrive as a single entry (one dialog).
 */
export type ContactConflict = {
    owner: ContactConflictParty;
    editing: ContactConflictParty;
    attributes: ContactConflictAttribute[];
    /** Server-computed FR-3 gate: false ⇒ the owner would be left with no phone and no email — Transfer is hidden. */
    transfer_allowed: boolean;
};

/** The `conflict` sibling of the 409 error envelope. */
export type ContactConflictPayload = {
    conflicts: ContactConflict[];
};

/**
 * The client's answer for ONE owner, echoed on the retry PATCH.
 * `attributes` must echo the detected set (strict-echo staleness check).
 */
export type ContactConflictResolution = {
    owner_contact_id: number;
    action: 'merge' | 'transfer';
    attributes: { kind: 'phone' | 'email'; value: string }[];
};
