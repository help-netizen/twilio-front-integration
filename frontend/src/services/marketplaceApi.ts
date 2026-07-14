import { authedFetch } from './apiClient';

const API_BASE = '/api/marketplace';

export type MarketplaceInstallationStatus = 'connected' | 'provisioning_failed' | 'disconnected' | 'revoked';
export type MarketplaceProvisioningMode = 'manual' | 'push_credentials' | 'none';

export interface MarketplaceInstallationSummary {
    id: number;
    status: MarketplaceInstallationStatus;
    installed_at: string | null;
    disconnected_at?: string | null;
    provisioning_error: string | null;
    last_used_at: string | null;
}

export interface MarketplaceAppMetadata {
    access_summary?: string[];
    requires_connected_gmail?: boolean;
    dependency_cta?: {
        label: string;
        path: string;
    };
    data_retention?: {
        stores_raw_email?: boolean;
        persistent_reference?: string;
        stores_derived_results?: boolean;
    };
    [key: string]: unknown;
}

export interface MarketplaceApp {
    id: number;
    app_key: string;
    name: string;
    provider_name: string;
    category: string;
    app_type: 'external' | 'internal' | 'private';
    short_description: string;
    long_description: string | null;
    logo_url: string | null;
    docs_url: string | null;
    support_email: string | null;
    privacy_url: string | null;
    requested_scopes: string[];
    access_summary: string[];
    provisioning_mode: MarketplaceProvisioningMode;
    status: 'published';
    metadata: MarketplaceAppMetadata;
    installation: MarketplaceInstallationSummary | null;
}

export interface MarketplaceInstallation {
    id: number;
    app_key: string;
    app_name: string;
    provider_name: string;
    category: string;
    status: MarketplaceInstallationStatus;
    requested_scopes: string[];
    installed_at: string | null;
    disconnected_at: string | null;
    provisioning_error: string | null;
    external_installation_id: string | null;
    key_id?: string;
    revoked_at?: string | null;
    last_used_at: string | null;
}

export interface RelyLeadsSettings {
    zone: {
        mode: 'company' | 'custom';
        custom_zips: string[];
    };
    unit_types: string[];
    brands: string[];
}

export interface RelyLeadsSettingsResponse {
    settings: RelyLeadsSettings;
    catalogs: {
        unit_types: string[];
        brands: string[];
    };
    territory: {
        active_mode: 'list' | 'radius';
        has_data: boolean;
    };
}

export interface RateMeDomain {
    domain: string;
    status: 'pending' | 'verified' | 'active' | 'failed';
    verified_at: string | null;
    activated_at: string | null;
    last_checked_at: string | null;
    last_error: string | null;
}

export interface RateMeSettingsResponse {
    settings: {
        google_review_url: string | null;
        booking_url: string | null;
    };
    domain: RateMeDomain | null;
    public_host: string;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Request failed: ${res.status}`);
    }
    return res.json();
}

export async function fetchMarketplaceApps(): Promise<MarketplaceApp[]> {
    const data = await request<{ apps: MarketplaceApp[] }>(`${API_BASE}/apps`);
    return data.apps;
}

export async function fetchMarketplaceInstallations(includeInactive = false): Promise<MarketplaceInstallation[]> {
    const data = await request<{ installations: MarketplaceInstallation[] }>(
        `${API_BASE}/installations?include_inactive=${includeInactive ? 'true' : 'false'}`
    );
    return data.installations;
}

export async function installMarketplaceApp(appKey: string): Promise<MarketplaceInstallation> {
    const data = await request<{ installation: MarketplaceInstallation }>(`${API_BASE}/apps/${appKey}/install`, {
        method: 'POST',
        body: JSON.stringify({}),
    });
    return data.installation;
}

export async function disconnectMarketplaceInstallation(installationId: number): Promise<Pick<MarketplaceInstallation, 'id' | 'status' | 'disconnected_at'>> {
    const data = await request<{ installation: Pick<MarketplaceInstallation, 'id' | 'status' | 'disconnected_at'> }>(
        `${API_BASE}/installations/${installationId}/disconnect`,
        { method: 'POST', body: JSON.stringify({}) }
    );
    return data.installation;
}

export async function retryMarketplaceProvisioning(installationId: number): Promise<MarketplaceInstallation> {
    const data = await request<{ installation: MarketplaceInstallation }>(
        `${API_BASE}/installations/${installationId}/retry-provisioning`,
        { method: 'POST', body: JSON.stringify({}) }
    );
    return data.installation;
}

export async function fetchRelyLeadsSettings(): Promise<RelyLeadsSettingsResponse> {
    return request<RelyLeadsSettingsResponse>(`${API_BASE}/apps/rely-leads/settings`);
}

export async function saveRelyLeadsSettings(settings: RelyLeadsSettings): Promise<RelyLeadsSettingsResponse> {
    return request<RelyLeadsSettingsResponse>(`${API_BASE}/apps/rely-leads/settings`, {
        method: 'PUT',
        body: JSON.stringify(settings),
    });
}

export async function fetchRateMeSettings(): Promise<RateMeSettingsResponse> {
    return request<RateMeSettingsResponse>(`${API_BASE}/apps/rate-me/settings`);
}

export async function saveRateMeSettings(settings: RateMeSettingsResponse['settings']): Promise<RateMeSettingsResponse> {
    return request<RateMeSettingsResponse>(`${API_BASE}/apps/rate-me/settings`, {
        method: 'PUT',
        body: JSON.stringify(settings),
    });
}

export async function setRateMeDomain(domain: string): Promise<RateMeDomain> {
    const data = await request<{ domain: RateMeDomain }>(`${API_BASE}/apps/rate-me/domain`, {
        method: 'PUT',
        body: JSON.stringify({ domain }),
    });
    return data.domain;
}

export async function verifyRateMeDomain(): Promise<RateMeDomain> {
    const data = await request<{ domain: RateMeDomain }>(`${API_BASE}/apps/rate-me/domain/verify`, {
        method: 'POST',
        body: JSON.stringify({}),
    });
    return data.domain;
}

export async function removeRateMeDomain(): Promise<void> {
    await request<{ success: true }>(`${API_BASE}/apps/rate-me/domain`, {
        method: 'DELETE',
    });
}
