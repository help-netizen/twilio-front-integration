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
    /** APP-VIEW-001: set by App Studio on every app it generates. Such an app has
     *  a screen of its own, so the detail panel offers Open rather than Setup. */
    app_studio?: { generated?: boolean };
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
    /** MARKETPLACE-RATINGS-001: per-app pricing (all Free for now). */
    pricing?: {
        paid: boolean;
        label: string;
        text: string;
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
    /** Cross-company aggregate over posted reviews. null avg until first rating. */
    avg_rating: number | null;
    rating_count: number;
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

export interface OutboundPartsCallerSettings {
    max_attempts: number;
    backoff_schedule: string[];
    next_morning_hour: number;
    enabled: boolean;
    calling_window_mode: 'custom' | null;
    custom_start_time: string | null;
    custom_end_time: string | null;
    calling_window_work_days: number[] | null;
    updated_at?: string | null;
}

export interface OutboundPartsCallerSettingsResponse {
    app_key: 'outbound-parts-caller';
    installation_id: number;
    settings: OutboundPartsCallerSettings;
}

export interface InspectorSettings {
    enabled: boolean;
    ignored_job_statuses: string[];
    ignored_lead_statuses: string[];
    instruction: string;
}

export interface InspectorSettingsResponse {
    app_key: 'inspector';
    installation_id: number;
    settings: InspectorSettings;
    catalogs: {
        job_statuses: string[];
        lead_statuses: string[];
    };
    schedule: {
        frequency: 'daily';
        after_local_time: string;
        timezone: string;
    };
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

export interface ReportToEstimateSettingsResponse {
    app_key: string;
    /** True when the app is connected (generation allowed). */
    enabled: boolean;
    installation_id: number | null;
    /** Effective estimate-generation instruction — per-company custom text, or default. */
    instruction_text: string;
    /** Effective report-polish instruction — per-company custom text, or default. */
    report_instruction_text: string;
}

/** A partial patch — send only the block(s) being saved; the other is left untouched. */
export interface ReportToEstimateSettingsPatch {
    instruction_text?: string;
    report_instruction_text?: string;
}

export async function fetchReportToEstimateSettings(): Promise<ReportToEstimateSettingsResponse> {
    return request<ReportToEstimateSettingsResponse>(`${API_BASE}/apps/report-to-estimate/settings`);
}

export async function saveReportToEstimateSettings(patch: ReportToEstimateSettingsPatch): Promise<ReportToEstimateSettingsResponse> {
    return request<ReportToEstimateSettingsResponse>(`${API_BASE}/apps/report-to-estimate/settings`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    });
}

export async function fetchOutboundPartsCallerSettings(): Promise<OutboundPartsCallerSettingsResponse> {
    return request<OutboundPartsCallerSettingsResponse>(`${API_BASE}/apps/outbound-parts-caller/settings`);
}

export async function saveOutboundPartsCallerSettings(
    settings: Pick<OutboundPartsCallerSettings,
        'calling_window_mode' | 'custom_start_time' | 'custom_end_time' | 'calling_window_work_days'>,
): Promise<OutboundPartsCallerSettingsResponse> {
    return request<OutboundPartsCallerSettingsResponse>(`${API_BASE}/apps/outbound-parts-caller/settings`, {
        method: 'PUT',
        body: JSON.stringify(settings),
    });
}

export async function fetchInspectorSettings(): Promise<InspectorSettingsResponse> {
    return request<InspectorSettingsResponse>(`${API_BASE}/apps/inspector/settings`);
}

export async function saveInspectorSettings(
    settings: InspectorSettings,
): Promise<InspectorSettingsResponse> {
    return request<InspectorSettingsResponse>(`${API_BASE}/apps/inspector/settings`, {
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

export interface ChatgptMcpWriteSettings {
    writes_enabled: boolean;
    sends_enabled: boolean;
    grant_version: number;
}

export interface ChatgptMcpWriteSettingsResponse {
    settings: ChatgptMcpWriteSettings;
}

export async function fetchChatgptMcpWriteSettings(): Promise<ChatgptMcpWriteSettingsResponse> {
    return request<ChatgptMcpWriteSettingsResponse>(`${API_BASE}/apps/chatgpt-crm-mcp/settings`);
}

export async function setChatgptMcpWrites(enabled: boolean): Promise<ChatgptMcpWriteSettings> {
    return request<ChatgptMcpWriteSettings>(
        `${API_BASE}/apps/chatgpt-crm-mcp/writes/${enabled ? 'enable' : 'disable'}`,
        { method: 'POST', body: JSON.stringify({}) }
    );
}

export async function setChatgptMcpSends(enabled: boolean): Promise<ChatgptMcpWriteSettings> {
    return request<ChatgptMcpWriteSettings>(
        `${API_BASE}/apps/chatgpt-crm-mcp/sends/${enabled ? 'enable' : 'disable'}`,
        { method: 'POST', body: JSON.stringify({}) }
    );
}

// ── MARKETPLACE-RATINGS-001: ratings, reviews & moderation ──────────────────
export type AppReviewStatus = 'posted' | 'pending' | 'rejected';
export type ModerationSource = 'security' | 'llm' | 'manual';

/** A review as shown on the public app detail: global posted + the viewer's own. */
export interface AppReview {
    id: number;
    app_key: string;
    stars: number;
    comment: string | null;
    status: AppReviewStatus;
    reviewer_first_name: string | null;
    is_mine: boolean;
    created_at: string;
    updated_at: string;
}

export interface AppRatingSubmitResult {
    status: AppReviewStatus;
    review: {
        id: number;
        app_key: string;
        stars: number;
        comment: string | null;
        status: AppReviewStatus;
        moderation_reason: string | null;
        moderation_source: ModerationSource | null;
        created_at: string;
        updated_at: string;
    };
}

/** Carries the server error `code` (e.g. REVIEW_LINKS_NOT_ALLOWED) for inline UI. */
export class MarketplaceRatingError extends Error {
    code: string;
    constructor(message: string, code: string) {
        super(message);
        this.name = 'MarketplaceRatingError';
        this.code = code;
    }
}

export async function fetchAppReviews(appKey: string): Promise<AppReview[]> {
    const data = await request<{ reviews: AppReview[] }>(`${API_BASE}/apps/${appKey}/reviews`);
    return data.reviews;
}

export async function submitAppRating(
    appKey: string,
    input: { stars: number; comment?: string },
): Promise<AppRatingSubmitResult> {
    const res = await authedFetch(`${API_BASE}/apps/${appKey}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) {
        throw new MarketplaceRatingError(
            (body as { message?: string }).message || `Request failed: ${res.status}`,
            (body as { code?: string }).code || 'REQUEST_FAILED',
        );
    }
    return body as unknown as AppRatingSubmitResult;
}

export async function deleteMyAppRating(appKey: string): Promise<boolean> {
    const data = await request<{ deleted: boolean }>(`${API_BASE}/apps/${appKey}/rating`, {
        method: 'DELETE',
    });
    return data.deleted;
}

// ── super-admin moderation queue (/api/platform/app-reviews, super_admin only) ──
export interface AppModerationReview {
    id: number;
    app_key: string;
    app_name: string;
    stars: number;
    comment: string | null;
    status: AppReviewStatus;
    moderation_reason: string | null;
    moderation_source: ModerationSource | null;
    reviewer_first_name: string | null;
    company_id: string;
    company_name: string;
    moderated_by: string | null;
    moderator_first_name: string | null;
    created_at: string;
    updated_at: string;
}

export interface AppReviewsQueue {
    reviews: AppModerationReview[];
    total: number;
    page: number;
    limit: number;
}

export async function fetchAppReviewQueue(status: AppReviewStatus, page = 1): Promise<AppReviewsQueue> {
    const data = await request<AppReviewsQueue & { ok: boolean }>(
        `/api/platform/app-reviews/ratings?status=${status}&page=${page}`,
    );
    return { reviews: data.reviews, total: data.total, page: data.page, limit: data.limit };
}

export async function moderateAppReview(
    id: number,
    action: 'approve' | 'reject',
    reason?: string,
): Promise<AppModerationReview> {
    const data = await request<{ review: AppModerationReview }>(
        `/api/platform/app-reviews/${id}/moderate`,
        { method: 'POST', body: JSON.stringify({ action, ...(reason ? { reason } : {}) }) },
    );
    return data.review;
}
