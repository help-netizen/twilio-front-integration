import { authedFetch } from './apiClient';

const API_BASE = '/api/settings/company-profile';

/** Bank / direct-transfer details that surface on invoices and estimates. */
export interface CompanyPaymentDetails {
    bank_name: string | null;
    account_name: string | null;
    account_number: string | null;
    routing_number: string | null;
    swift: string | null;
    instructions: string | null;
}

/** The company profile as returned by GET /api/settings/company-profile. */
export interface CompanyProfile {
    name: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    billing_email: string | null;
    /** Address fields are read-only here — edited via the base-address component. */
    city: string | null;
    state: string | null;
    zip: string | null;
    logo_url: string | null;
    payment: CompanyPaymentDetails;
}

/** Fields accepted by PATCH (any subset). Address is excluded — it has its own editor. */
export interface CompanyProfilePatch {
    name?: string;
    contact_email?: string;
    contact_phone?: string;
    billing_email?: string;
    payment_bank_name?: string;
    payment_account_name?: string;
    payment_account_number?: string;
    payment_routing_number?: string;
    payment_swift?: string;
    payment_instructions?: string;
}

/** Unwrap a `{ ok, data, message }` envelope, throwing the server message on failure. */
async function unwrap<T>(res: Response): Promise<T> {
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) {
        throw new Error(json?.message || json?.error?.message || `Request failed: ${res.status}`);
    }
    return json.data as T;
}

export const companyProfileApi = {
    get: async (): Promise<CompanyProfile> => {
        const res = await authedFetch(API_BASE);
        return unwrap<CompanyProfile>(res);
    },

    update: async (patch: CompanyProfilePatch): Promise<CompanyProfile> => {
        const res = await authedFetch(API_BASE, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        return unwrap<CompanyProfile>(res);
    },

    uploadLogo: async (file: File): Promise<{ logo_url: string }> => {
        const fd = new FormData();
        fd.append('file', file);
        // Do NOT set Content-Type — the browser adds the multipart boundary.
        const res = await authedFetch(`${API_BASE}/logo`, { method: 'POST', body: fd });
        return unwrap<{ logo_url: string }>(res);
    },
};

// Named helpers matching the spec's verb-style API, delegating to companyProfileApi.
export const getCompanyProfile = (): Promise<CompanyProfile> => companyProfileApi.get();
export const updateCompanyProfile = (patch: CompanyProfilePatch): Promise<CompanyProfile> =>
    companyProfileApi.update(patch);
export const uploadCompanyLogo = (file: File): Promise<{ logo_url: string }> =>
    companyProfileApi.uploadLogo(file);
