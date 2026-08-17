import {
    request as playwrightRequest,
    type APIRequestContext,
    type APIResponse,
    type Page,
} from '@playwright/test';
import {
    ADMIN_PASS,
    ADMIN_USER,
    BASE_URL,
    KEYCLOAK_CLIENT_ID,
    KEYCLOAK_TOKEN_URL,
    RUN_ID,
} from './env';

type JsonObject = Record<string, unknown>;

export interface SessionInfo {
    company: { id: string | number; name?: string; timezone?: string };
    user?: JsonObject;
    permissions?: string[];
}

export interface ContactRecord {
    id: number;
    name: string;
    phone: string;
    email: string;
    leadUuid: string;
}

export interface Technician {
    id: string;
    name: string;
}

export interface ProvisionedTechnicians {
    technicians: Technician[];
    userIdsToRestore: string[];
}

export interface JobRecord extends JsonObject {
    id: number;
    job_seq?: number | null;
    start_date?: string | null;
    end_date?: string | null;
    assigned_techs?: Array<{ id?: string; name?: string }>;
}

export interface CreatedJob {
    id: number;
    marker: string;
    contact: ContactRecord;
    start: string | null;
    end: string | null;
}

export interface CreatedEstimate {
    id: number;
    marker: string;
}

export interface CreatedInvoice {
    id: number;
    marker: string;
    invoiceNumber: string;
}

export interface InvoiceSeedItem {
    name: string;
    description?: string;
    quantity?: number;
    unitPrice: number;
    taxable?: boolean;
}

export interface CreatedPriceBookItem {
    id: number;
    marker: string;
}

export interface CreatedTask {
    id: number;
    marker: string;
}

export type TaskParentType = 'job' | 'lead' | 'contact' | 'estimate' | 'invoice' | 'timeline';

export type CleanupEntity =
    | { type: 'contact'; id: number }
    | { type: 'lead'; id: string }
    | { type: 'job'; id: number }
    | { type: 'estimate'; id: number }
    | { type: 'invoice'; id: number }
    | { type: 'price_book_item'; id: number }
    | { type: 'task'; id: number };

interface Envelope<T> {
    ok?: boolean;
    data?: T;
    error?: unknown;
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, label: string): JsonObject {
    if (!isObject(value)) throw new Error(`${label} was not an object`);
    return value;
}

function asNumber(value: unknown, label: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${label} was not numeric`);
    return parsed;
}

function errorText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (isObject(value)) {
        if (typeof value.message === 'string') return value.message;
        if (typeof value.code === 'string') return value.code;
    }
    return JSON.stringify(value);
}

function prefixed(label: string): string {
    return label.startsWith(RUN_ID) ? label : `${RUN_ID} ${label}`;
}

function uniquePhone(): string {
    const tail = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-7);
    return `+1202${tail}`;
}

export function futureSlot(daysAhead = 1, durationMinutes = 120): { start: string; end: string } {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + daysAhead);
    start.setUTCHours(15, 0, 0, 0);
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    return { start: start.toISOString(), end: end.toISOString() };
}

async function passwordGrantToken(): Promise<string> {
    const auth = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    try {
        const response = await auth.post(KEYCLOAK_TOKEN_URL, {
            form: {
                grant_type: 'password',
                client_id: KEYCLOAK_CLIENT_ID,
                username: ADMIN_USER,
                password: ADMIN_PASS,
            },
        });
        const payload: unknown = await response.json().catch(() => ({}));
        if (!response.ok()) {
            throw new Error(`Keycloak password grant returned ${response.status()}: ${errorText(payload)}`);
        }
        const token = asObject(payload, 'Keycloak token response').access_token;
        if (typeof token !== 'string' || !token) throw new Error('Keycloak response had no access_token');
        return token;
    } finally {
        await auth.dispose();
    }
}

/**
 * AuthProvider keeps the JWT in Keycloak's module memory, so page.evaluate
 * cannot read it reliably. The browser fallback captures the same Bearer header
 * the app sends to /api/auth/me after an authenticated reload.
 */
async function browserBearerToken(page: Page): Promise<string> {
    const bearerRequest = page.waitForRequest((candidate) => {
        const authorization = candidate.headers().authorization || '';
        return candidate.url().includes('/api/') && authorization.startsWith('Bearer ');
    }, { timeout: 30_000 });

    if (page.url() === 'about:blank') await page.goto('/');
    else await page.reload();

    const request = await bearerRequest;
    const authorization = request.headers().authorization;
    if (!authorization?.startsWith('Bearer ')) throw new Error('Authenticated request had no Bearer token');
    return authorization.slice('Bearer '.length);
}

export class ApiClient {
    readonly session: SessionInfo;
    readonly tokenSource: 'password-grant' | 'browser-request';
    private readonly request: APIRequestContext;

    private constructor(request: APIRequestContext, session: SessionInfo, tokenSource: 'password-grant' | 'browser-request') {
        this.request = request;
        this.session = session;
        this.tokenSource = tokenSource;
    }

    static async forPage(page: Page): Promise<ApiClient> {
        let token: string;
        let tokenSource: 'password-grant' | 'browser-request';
        // Browser-Bearer capture is the default (robust, no Keycloak host needed). ROPG is
        // attempted first ONLY when an issuer is explicitly configured (E2E_KEYCLOAK_URL).
        if (KEYCLOAK_TOKEN_URL) {
            try {
                token = await passwordGrantToken();
                tokenSource = 'password-grant';
            } catch {
                token = await browserBearerToken(page);
                tokenSource = 'browser-request';
            }
        } else {
            token = await browserBearerToken(page);
            tokenSource = 'browser-request';
        }

        const request = await playwrightRequest.newContext({
            baseURL: BASE_URL,
            ignoreHTTPSErrors: true,
            extraHTTPHeaders: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        });

        try {
            const session = await ApiClient.read<SessionInfo>(await request.get('/api/auth/me'));
            if (!session.company?.id) throw new Error('/api/auth/me returned no tenant company');
            return new ApiClient(request, session, tokenSource);
        } catch (error) {
            await request.dispose();
            throw error;
        }
    }

    static runName(label: string): string {
        return prefixed(label);
    }

    private static async read<T>(response: APIResponse): Promise<T> {
        const payload: unknown = await response.json().catch(async () => ({ raw: await response.text() }));
        if (!response.ok()) {
            const envelope = isObject(payload) ? payload as Envelope<unknown> : {};
            throw new Error(`${response.url()} returned ${response.status()}: ${errorText(envelope.error ?? payload)}`);
        }
        if (isObject(payload) && 'ok' in payload && payload.ok === false) {
            throw new Error(`${response.url()} failed: ${errorText(payload.error)}`);
        }
        if (isObject(payload) && 'data' in payload) return payload.data as T;
        return payload as T;
    }

    private async get<T>(path: string): Promise<T> {
        return ApiClient.read<T>(await this.request.get(path));
    }

    private async post<T>(path: string, data: unknown = {}): Promise<T> {
        return ApiClient.read<T>(await this.request.post(path, { data }));
    }

    private async patch<T>(path: string, data: unknown): Promise<T> {
        return ApiClient.read<T>(await this.request.patch(path, { data }));
    }

    private async put<T>(path: string, data: unknown): Promise<T> {
        return ApiClient.read<T>(await this.request.put(path, { data }));
    }

    private async delete<T>(path: string): Promise<T> {
        return ApiClient.read<T>(await this.request.delete(path));
    }

    async createContact(label = 'Contact'): Promise<ContactRecord> {
        const name = prefixed(label);
        const [firstName, ...rest] = name.split(' ');
        const phone = uniquePhone();
        const email = `${RUN_ID}-${Date.now()}@e2e.local`;
        const data = await this.post<JsonObject>('/api/leads', {
            FirstName: firstName,
            LastName: rest.join(' ') || 'Contact',
            Phone: phone,
            Email: email,
            JobType: 'COD Service',
            JobSource: 'Other',
            Status: 'Submitted',
            Description: prefixed('API contact seed'),
            Address: '100 Test Street',
            City: 'New York',
            State: 'NY',
            PostalCode: '10001',
        });
        const resolution = asObject(data.contact_resolution, 'contact_resolution');
        return {
            id: asNumber(resolution.contact_id, 'contact_resolution.contact_id'),
            name,
            phone,
            email,
            leadUuid: String(data.UUID ?? data.uuid ?? ''),
        };
    }

    async createLead(label = 'Lead'): Promise<{ uuid: string; marker: string; contactId: number }> {
        const contact = await this.createContact(label);
        if (!contact.leadUuid) throw new Error('Lead create response had no UUID');
        return { uuid: contact.leadUuid, marker: contact.name, contactId: contact.id };
    }

    async findContact(marker: string): Promise<JsonObject | undefined> {
        const data = await this.get<JsonObject>(`/api/contacts?search=${encodeURIComponent(marker)}&limit=20`);
        const results = Array.isArray(data.results) ? data.results : [];
        return results.find((item) => isObject(item) && String(item.full_name ?? item.name ?? '').includes(marker)) as JsonObject | undefined;
    }

    async findLead(marker: string): Promise<JsonObject | undefined> {
        const data = await this.get<JsonObject>(`/api/leads?search=${encodeURIComponent(marker)}&only_open=false&limit=20`);
        const results = Array.isArray(data.results) ? data.results : [];
        return results.find((item) => isObject(item) && JSON.stringify(item).includes(marker)) as JsonObject | undefined;
    }

    async ensureTimeline(contact: Pick<ContactRecord, 'id' | 'phone'>): Promise<number> {
        const data = await this.post<JsonObject>('/api/pulse/ensure-timeline', {
            phone: contact.phone,
            contactId: contact.id,
        });
        return asNumber(data.timelineId, 'timelineId');
    }

    async createTask(parentType: TaskParentType, parentId: number | string, label = 'Task'): Promise<CreatedTask> {
        const marker = prefixed(label);
        const data = await this.post<JsonObject>('/api/tasks', {
            parent_type: parentType,
            parent_id: parentId,
            description: marker,
        });
        const task = asObject(data.task, 'task');
        return { id: asNumber(task.id, 'task.id'), marker };
    }

    async findTask(marker: string): Promise<CreatedTask | undefined> {
        const data = await this.get<JsonObject>(`/api/tasks?status=all&search=${encodeURIComponent(marker)}&limit=20`);
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        const task = tasks.find((item) => isObject(item) && String(item.description ?? '').includes(marker));
        if (!isObject(task)) return undefined;
        return {
            id: asNumber(task.id, 'task.id'),
            marker: String(task.description),
        };
    }

    async createJob(options: {
        label?: string;
        contact?: ContactRecord;
        scheduled?: boolean;
        start?: string;
        end?: string;
        technician?: Technician;
    } = {}): Promise<CreatedJob> {
        const marker = prefixed(options.label || 'Job');
        const contact = options.contact || await this.createContact(`${options.label || 'Job'} Customer`);
        const slot: { start?: string; end?: string; tech_id?: string } = options.scheduled === false
            ? {}
            : {
                ...(options.start && options.end ? { start: options.start, end: options.end } : futureSlot()),
                ...(options.technician ? { tech_id: options.technician.id } : {}),
            };
        const data = await this.post<JsonObject>('/api/jobs', {
            contact: { contact_id: contact.id },
            address: {
                line1: '100 Test Street',
                city: 'New York',
                state: 'NY',
                postal_code: '10001',
            },
            slot,
            job_type: marker,
            description: `${marker} description`,
            lead_source: 'Other',
        });
        return {
            id: asNumber(data.job_id, 'job_id'),
            marker,
            contact,
            start: typeof slot.start === 'string' ? slot.start : null,
            end: typeof slot.end === 'string' ? slot.end : null,
        };
    }

    async getJob(id: number): Promise<JobRecord> {
        const data = await this.get<JsonObject>(`/api/jobs/${id}`);
        return { ...data, id: asNumber(data.id, 'job.id') };
    }

    async getJobBySeq(seq: number): Promise<JobRecord> {
        const data = await this.get<JsonObject>(`/api/jobs/by-seq/${seq}`);
        return { ...data, id: asNumber(data.id, 'job.id') };
    }

    /**
     * Record a manual payment against a job — the same endpoint the job card's
     * Record-payment sheet posts to. Cash and check only; card runs through
     * Stripe and has no place in an automated run.
     */
    async recordJobPayment(
        jobId: number,
        options: { amount: number; method?: 'cash' | 'check'; memo?: string },
    ): Promise<{ id: number }> {
        const data = await this.post<JsonObject>(`/api/jobs/${jobId}/record-payment`, {
            amount: options.amount,
            payment_method: options.method || 'cash',
            ...(options.memo ? { memo: options.memo } : {}),
        });
        const payload = isObject(data.data) ? data.data : data;
        return { id: asNumber(payload.id, 'payment.id') };
    }

    /** Note bodies on a job, so a test can prove where a note actually landed. */
    async getJobNotes(jobId: number): Promise<string[]> {
        const data = await this.get<unknown>(`/api/jobs/${jobId}/notes`);
        const rows = Array.isArray(data)
            ? data
            : isObject(data) && Array.isArray(data.notes) ? data.notes : [];
        return rows
            .filter(isObject)
            .map((row) => String(row.text ?? row.note ?? row.body ?? ''));
    }

    async createEstimate(jobId: number, label = 'Estimate', unitPrice = 125): Promise<CreatedEstimate> {
        const marker = prefixed(label);
        const data = await this.post<JsonObject>('/api/estimates', {
            job_id: jobId,
            summary: marker,
            tax_rate: 0,
            items: [{ name: `${marker} item`, description: marker, quantity: 1, unit_price: unitPrice, taxable: false }],
        });
        return { id: asNumber(data.id, 'estimate.id'), marker };
    }

    async createInvoiceWithItems(
        jobId: number,
        label: string,
        items: InvoiceSeedItem[],
    ): Promise<CreatedInvoice> {
        const marker = prefixed(label);
        const data = await this.post<JsonObject>('/api/invoices', {
            job_id: jobId,
            notes: marker,
            tax_rate: 0,
            items: items.map((item) => ({
                name: item.name,
                description: item.description ?? marker,
                quantity: item.quantity ?? 1,
                unit_price: item.unitPrice,
                taxable: item.taxable ?? false,
            })),
        });
        return {
            id: asNumber(data.id, 'invoice.id'),
            marker,
            invoiceNumber: String(data.invoice_number || ''),
        };
    }

    async createInvoice(jobId: number, label = 'Invoice', unitPrice = 125): Promise<CreatedInvoice> {
        const marker = prefixed(label);
        return this.createInvoiceWithItems(jobId, marker, [{
            name: `${marker} item`,
            description: marker,
            quantity: 1,
            unitPrice,
            taxable: false,
        }]);
    }

    async createPriceBookItem(label = 'Price Book item', unitPrice = 75): Promise<CreatedPriceBookItem> {
        const marker = prefixed(label);
        const data = await this.post<JsonObject>('/api/estimate-item-presets', {
            name: marker,
            description: `${marker} seeded for Playwright`,
            default_quantity: 1,
            default_unit_price: unitPrice,
            default_taxable: false,
        });
        return { id: asNumber(data.id, 'price_book_item.id'), marker };
    }

    async issueInvoice(invoiceId: number, recipient: string): Promise<JsonObject> {
        return this.post<JsonObject>(`/api/invoices/${invoiceId}/send`, {
            channel: 'email',
            recipient,
            message: prefixed('Playwright invoice issue'),
            includePaymentLink: false,
        });
    }

    async recordInvoicePayment(
        invoiceId: number,
        options: { amount: number; method?: 'cash' | 'check' },
    ): Promise<{ id: number }> {
        const data = await this.post<JsonObject>(`/api/invoices/${invoiceId}/record-payment`, {
            amount: options.amount,
            payment_method: options.method || 'cash',
            memo: prefixed('Playwright invoice payment'),
        });
        return { id: asNumber(data.id, 'invoice payment.id') };
    }

    async getEstimate(id: number): Promise<JsonObject> {
        return this.get<JsonObject>(`/api/estimates/${id}`);
    }

    /** P1 setup seam: public customer actions intentionally require sent/viewed. */
    async prepareEstimateAsSent(id: number): Promise<JsonObject> {
        return this.put<JsonObject>(`/api/estimates/${id}`, { status: 'sent' });
    }

    async ensureEstimatePublicLink(id: number): Promise<string> {
        const data = await this.post<JsonObject>(`/api/estimates/${id}/public-link`);
        if (typeof data.url !== 'string' || !data.url) {
            throw new Error('Estimate public-link response had no url');
        }
        return data.url;
    }

    /** Turn an estimate into an invoice — the P2 shortcut, available at any live status. */
    async convertEstimate(id: number): Promise<JsonObject> {
        return this.post<JsonObject>(`/api/estimates/${id}/convert`, {});
    }

    /** Take that conversion back while it is still untouched (five-minute window). */
    async undoEstimateConversion(id: number, invoiceId: number): Promise<JsonObject> {
        return this.post<JsonObject>(`/api/estimates/${id}/convert/undo`, { invoice_id: invoiceId });
    }

    /** Update an estimate through the same route the editor uses. */
    async updateEstimate(id: number, data: JsonObject): Promise<JsonObject> {
        return this.put<JsonObject>(`/api/estimates/${id}`, data);
    }

    /** Read the customer-facing view by its opaque token, unauthenticated. */
    async readPublicEstimate(token: string): Promise<{ status: number; body: unknown }> {
        const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
        try {
            const response = await anonymous.get(`/api/public/estimates/${token}`);
            return { status: response.status(), body: await response.json().catch(() => null) };
        } finally {
            await anonymous.dispose();
        }
    }

    async getEstimateEvents(id: number): Promise<JsonObject[]> {
        const data = await this.get<unknown>(`/api/estimates/${id}/events`);
        return Array.isArray(data) ? data.filter(isObject) : [];
    }

    async findEstimate(jobId: number, marker: string): Promise<JsonObject | undefined> {
        const data = await this.get<unknown>(`/api/estimates?job_id=${jobId}&limit=50`);
        const results = Array.isArray(data)
            ? data
            : isObject(data) && Array.isArray(data.results)
                ? data.results
                : isObject(data) && Array.isArray(data.rows) ? data.rows : [];
        return results.find((item) => isObject(item) && JSON.stringify(item).includes(marker)) as JsonObject | undefined;
    }

    async getInvoice(id: number): Promise<JsonObject> {
        return this.get<JsonObject>(`/api/invoices/${id}`);
    }

    async findInvoice(jobId: number, marker: string): Promise<JsonObject | undefined> {
        const data = await this.get<unknown>(`/api/invoices?job_id=${jobId}&limit=50`);
        const results = Array.isArray(data)
            ? data
            : isObject(data) && Array.isArray(data.results)
                ? data.results
                : isObject(data) && Array.isArray(data.rows) ? data.rows : [];
        return (results.find((item) => isObject(item) && JSON.stringify(item).includes(marker)) ?? results[0]) as JsonObject | undefined;
    }

    async fetchTechs(minimum = 1): Promise<Technician[]> {
        // ZB-DECOUPLE F1: native dispatch-roster path (the /api/zenbooker alias still resolves).
        const data = await this.get<unknown>('/api/team/team-members');
        const raw = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.results) ? data.results : [];
        const techs = raw.flatMap((item): Technician[] => {
            if (!isObject(item)) return [];
            const id = item.id ?? item.external_id ?? item.zenbooker_id;
            const name = item.name ?? item.display_name ?? [item.first_name, item.last_name].filter(Boolean).join(' ');
            return id != null && typeof name === 'string' && name ? [{ id: String(id), name }] : [];
        });
        if (techs.length < minimum) throw new Error(`Expected at least ${minimum} active technicians, found ${techs.length}`);
        return techs;
    }

    /**
     * Ensure the native directory has enough technicians for multi-provider
     * schedule tests. Existing office users are promoted only for the test and
     * returned for restoration. If the tenant has no second member, create one
     * stable dedicated provider account once and reuse it on later runs.
     */
    async provisionTechnicians(minimum: number): Promise<ProvisionedTechnicians> {
        let technicians = await this.fetchTechs(0);
        if (technicians.length >= minimum) return { technicians, userIdsToRestore: [] };

        const list = await this.get<JsonObject>('/api/users?status=active&limit=100');
        const users = Array.isArray(list.users) ? list.users.filter(isObject) : [];
        const candidates = users.filter((user) =>
            user.membership_status === 'active'
            && user.is_provider !== true
            && user.role_key !== 'provider'
            && typeof user.id === 'string'
        );
        const userIdsToRestore: string[] = [];

        try {
            for (const user of candidates) {
                const userId = String(user.id);
                await this.patch(`/api/users/${userId}`, { profile: { is_provider: true } });
                userIdsToRestore.push(userId);

                for (let poll = 0; poll < 10; poll += 1) {
                    technicians = await this.fetchTechs(0);
                    if (technicians.length >= minimum) {
                        return { technicians, userIdsToRestore };
                    }
                    await new Promise((resolve) => setTimeout(resolve, 250));
                }
            }

            const seedEmail = 'albusto-e2e-schedule-provider@e2e.local';
            const existingSeed = users.find((user) =>
                String(user.email || '').toLowerCase() === seedEmail
            );
            if (!existingSeed) {
                await this.post('/api/users', {
                    email: seedEmail,
                    full_name: 'E2E Schedule Provider',
                    role: 'company_member',
                    role_key: 'provider',
                    profile: { is_provider: true },
                });
            } else if (typeof existingSeed.id === 'string') {
                await this.patch(`/api/users/${existingSeed.id}`, {
                    role_key: 'provider',
                    profile: { is_provider: true },
                });
            }

            for (let poll = 0; poll < 10; poll += 1) {
                technicians = await this.fetchTechs(0);
                if (technicians.length >= minimum) {
                    return { technicians, userIdsToRestore };
                }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        } catch (error) {
            await this.restoreProvisionedTechnicians(userIdsToRestore);
            throw error;
        }

        await this.restoreProvisionedTechnicians(userIdsToRestore);
        throw new Error(`Unable to provision ${minimum} active technicians from the tenant's existing users`);
    }

    async restoreProvisionedTechnicians(userIds: string[]): Promise<void> {
        for (const userId of [...userIds].reverse()) {
            try {
                await this.patch(`/api/users/${userId}`, { profile: { is_provider: false } });
            } catch {
                // Teardown is best-effort and must not mask the schedule result.
            }
        }
    }

    /**
     * Ensure the given tenant user is a field technician (profile.is_provider = true).
     * In native mode this projects them into the technician directory (USERS-FIRST).
     * Idempotent — safe to call every run. Returns the resolved technician handle.
     */
    async ensureFieldTech(email: string): Promise<Technician> {
        const list = await this.get<JsonObject>(`/api/users?search=${encodeURIComponent(email)}&limit=20`);
        const rows = (Array.isArray((list as JsonObject).users) ? (list as JsonObject).users
            : Array.isArray((list as JsonObject).results) ? (list as JsonObject).results
            : Array.isArray(list) ? list : []) as JsonObject[];
        const user = rows.find(u => isObject(u) && String(u.email || '').toLowerCase() === email.toLowerCase());
        if (!user) throw new Error(`ensureFieldTech: user ${email} not found in tenant roster`);
        if (user.is_provider !== true) {
            await this.patch(`/api/users/${String(user.id)}`, { profile: { is_provider: true } });
        }
        return { id: String(user.id), name: String(user.full_name || email) };
    }

    async reassignJob(jobId: number, technicians: Technician[]): Promise<void> {
        await this.patch(`/api/schedule/items/job/${jobId}/reassign`, {
            assignees: technicians.map((tech) => ({ id: tech.id, name: tech.name })),
        });
    }

    async getScheduleItem(jobId: number): Promise<JsonObject> {
        return this.get<JsonObject>(`/api/schedule/items/job/${jobId}`);
    }

    async deleteEntity(entity: CleanupEntity): Promise<void> {
        try {
            if (entity.type === 'estimate') await this.delete(`/api/estimates/${entity.id}`);
            else if (entity.type === 'invoice') {
                try {
                    await this.delete(`/api/invoices/${entity.id}`);
                } catch {
                    // Issued invoices cannot be deleted. Void them so residual
                    // RUN_ID data is terminal and cannot be collected or resent.
                    await this.post(`/api/invoices/${entity.id}/void`);
                }
            }
            else if (entity.type === 'price_book_item') {
                await this.delete(`/api/estimate-item-presets/${entity.id}`);
            }
            else if (entity.type === 'task') await this.delete(`/api/tasks/${entity.id}`);
            else if (entity.type === 'job') await this.post(`/api/jobs/${entity.id}/cancel`, { reason: 'E2E cleanup' });
            else if (entity.type === 'lead') await this.post(`/api/leads/${encodeURIComponent(entity.id)}/mark-lost`, { reason: 'E2E cleanup' });
            // There is no contact DELETE endpoint. Its provisioning lead is marked
            // lost and the RUN_ID prefix makes the residual contact identifiable.
        } catch {
            // Teardown is deliberately best-effort and must never mask a test result.
        }
    }

    async cleanup(entities: CleanupEntity[]): Promise<void> {
        for (const entity of [...entities].reverse()) await this.deleteEntity(entity);
    }

    async dispose(): Promise<void> {
        await this.request.dispose();
    }
}
