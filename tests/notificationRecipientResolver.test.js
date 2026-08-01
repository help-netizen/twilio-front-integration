'use strict';

const mockAvailableEvents = new Set();

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/authorizationService', () => ({
    resolveCompanyUserAuthz: jest.fn(),
}));
jest.mock('../backend/src/db/tasksQueries', () => ({ jobParentVisible: jest.fn() }));
jest.mock('../backend/src/db/providerContactAccessQueries', () => ({
    providerHasActiveJobForContact: jest.fn(),
    listProvidersWithActiveJobForContact: jest.fn(),
}));
jest.mock('../backend/src/services/notificationEventCatalog', () => {
    const actual = jest.requireActual('../backend/src/services/notificationEventCatalog');
    return {
        ...actual,
        getNotificationCatalogEntry: eventType => {
            const entry = actual.getNotificationCatalogEntry(eventType);
            return entry && mockAvailableEvents.has(eventType)
                ? { ...entry, producer_available: true }
                : entry;
        },
    };
});

const authorizationService = require('../backend/src/services/authorizationService');
const tasksQueries = require('../backend/src/db/tasksQueries');
const contactAccess = require('../backend/src/db/providerContactAccessQueries');
const {
    resolveNotificationRecipients,
} = require('../backend/src/services/notificationRecipientResolver');

const COMPANY = '00000000-0000-4000-8000-00000000a001';
const OFFICE = '00000000-0000-4000-8000-00000000a002';
const PROVIDER = '00000000-0000-4000-8000-00000000a003';

function event(overrides = {}) {
    return {
        id: '101',
        company_id: COMPANY,
        event_type: 'job.status_changed',
        aggregate_type: 'job',
        aggregate_id: '10',
        payload: { to: 'Canceled' },
        actor_type: 'system',
        actor_id: null,
        ...overrides,
    };
}

function authz(roleKey, permissions) {
    return {
        company: { id: COMPANY },
        role_key: roleKey,
        permissions,
        scopes: { job_visibility: roleKey === 'provider' ? 'assigned_only' : 'all' },
    };
}

function fakeClient({
    candidateIds = [OFFICE, PROVIDER],
    jobRows = { '10': { id: 10, contact_id: null, assigned_provider_user_ids: [PROVIDER] } },
    leadRows = {},
    paymentRows = {},
    contactRows = {},
    smsRows = {},
    eventDataById = { '101': { to: 'Canceled' } },
    categoryEnabled,
    browserDestinations = [{ id: 'web-1', endpoint: 'https://push/1', p256dh: 'p', auth: 'a' }],
    nativeDestinations = [],
} = {}) {
    const claims = new Set();
    const query = jest.fn(async (sql, params = []) => {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        if (text.includes('FROM domain_events')) {
            return {
                rows: [{
                    event_data: eventDataById[String(params[1])] || {},
                    actor_type: 'system',
                    actor_id: null,
                    created_at: new Date('2026-07-31T12:00:00Z'),
                }],
            };
        }
        if (text.includes('FROM companies WHERE id')) {
            return { rows: String(params[1]) === COMPANY ? [{ id: COMPANY }] : [] };
        }
        if (text.includes('FROM jobs WHERE company_id')) {
            const row = jobRows[String(params[1])];
            return { rows: row ? [row] : [] };
        }
        if (text.includes('FROM contacts WHERE company_id')) {
            const row = contactRows[String(params[1])];
            return { rows: row ? [row] : [] };
        }
        if (text.includes('FROM leads')) {
            const row = leadRows[String(params[1])];
            return { rows: row ? [row] : [] };
        }
        if (text.includes('FROM payment_transactions')) {
            const row = paymentRows[String(params[1])];
            return { rows: row ? [row] : [] };
        }
        if (text.includes('FROM sms_conversations sc')) {
            const row = smsRows[String(params[1])];
            return { rows: row ? [row] : [] };
        }
        if (text.includes('FROM company_memberships m')) {
            return { rows: candidateIds.map(user_id => ({ user_id })) };
        }
        if (text.includes('FROM user_notification_preferences')) {
            return { rows: categoryEnabled === undefined ? [] : [{ enabled: categoryEnabled }] };
        }
        if (text.includes('FROM push_subscriptions')) return { rows: browserDestinations };
        if (text.includes('FROM device_tokens')) return { rows: nativeDestinations };
        if (text.startsWith('INSERT INTO notification_deliveries')) {
            const key = `${params[0]}:${params[1]}:${params[2]}:${params[4]}`;
            if (claims.has(key)) return { rows: [] };
            claims.add(key);
            return { rows: [{ id: `delivery-${params[2]}-${params[4]}` }] };
        }
        throw new Error(`Unexpected resolver SQL: ${text}`);
    });
    return { query, claims };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockAvailableEvents.clear();
    tasksQueries.jobParentVisible.mockResolvedValue(false);
    contactAccess.providerHasActiveJobForContact.mockResolvedValue(false);
    contactAccess.listProvidersWithActiveJobForContact.mockResolvedValue([]);
    authorizationService.resolveCompanyUserAuthz.mockImplementation(async (_companyId, userId) => (
        userId === PROVIDER
            ? authz('provider', ['jobs.view', 'messages.view_client'])
            : authz('dispatcher', ['jobs.view', 'messages.view_client'])
    ));
});

describe('resolveNotificationRecipients fail-closed pipeline', () => {
    test('rejects missing/mismatched tenant context before SQL', async () => {
        const client = fakeClient();
        await expect(resolveNotificationRecipients(null, event(), { client }))
            .rejects.toMatchObject({ code: 'NOTIFICATION_COMPANY_REQUIRED' });
        await expect(resolveNotificationRecipients(
            COMPANY,
            event({ company_id: 'foreign-company' }),
            { client }
        )).rejects.toMatchObject({ code: 'NOTIFICATION_COMPANY_MISMATCH' });
        expect(client.query).not.toHaveBeenCalled();
    });

    test('unknown and unavailable catalog events produce no recipients before SQL', async () => {
        const client = fakeClient();
        await expect(resolveNotificationRecipients(
            COMPANY,
            event({ event_type: 'unknown.event' }),
            { client }
        )).resolves.toEqual([]);
        await expect(resolveNotificationRecipients(COMPANY, event({
            event_type: 'call.inbound_started', aggregate_type: 'call', aggregate_id: 'CA1',
        }), { client })).resolves.toEqual([]);
        expect(client.query).not.toHaveBeenCalled();
    });

    test('T-own: office plus assigned provider use default-on category and claim once', async () => {
        const client = fakeClient();
        tasksQueries.jobParentVisible.mockResolvedValue(true);

        const first = await resolveNotificationRecipients(COMPANY, event(), { client });
        expect(first.map(recipient => ({
            user_id: recipient.user_id,
            role_key: recipient.role_key,
            channels: Object.keys(recipient.delivery_ids),
        }))).toEqual([
            { user_id: OFFICE, role_key: 'dispatcher', channels: ['browser_push'] },
            { user_id: PROVIDER, role_key: 'provider', channels: ['browser_push'] },
        ]);
        expect(first.every(recipient => recipient.destinations.browser_push.length === 1)).toBe(true);
        await expect(resolveNotificationRecipients(COMPANY, event(), { client })).resolves.toEqual([]);
        expect(authorizationService.resolveCompanyUserAuthz)
            .toHaveBeenCalledWith(COMPANY, PROVIDER, { client });
        expect(tasksQueries.jobParentVisible).toHaveBeenCalledWith(
            COMPANY,
            '10',
            { assignedOnly: true, userId: PROVIDER },
            client
        );
    });

    test('returns and claims every active browser and native destination', async () => {
        const browserDestinations = [
            { id: 'web-1', endpoint: 'https://push/1', p256dh: 'p1', auth: 'a1' },
            { id: 'web-2', endpoint: 'https://push/2', p256dh: 'p2', auth: 'a2' },
        ];
        const nativeDestinations = [
            { id: 1, apns_token: 'native-1' },
            { id: 2, apns_token: 'native-2' },
        ];
        const client = fakeClient({
            candidateIds: [OFFICE], browserDestinations, nativeDestinations,
        });

        const [recipient] = await resolveNotificationRecipients(COMPANY, event(), { client });
        expect(recipient.destinations).toEqual({
            browser_push: browserDestinations,
            native_push: nativeDestinations,
        });
        expect(Object.keys(recipient.delivery_ids).sort()).toEqual(['browser_push', 'native_push']);
        expect(client.claims).toHaveProperty('size', 2);
    });

    test('T-foreign aggregate is denied before candidate authorization', async () => {
        const client = fakeClient({ jobRows: {} });
        await expect(resolveNotificationRecipients(
            COMPANY,
            event({ aggregate_id: '999' }),
            { client }
        )).resolves.toEqual([]);
        expect(authorizationService.resolveCompanyUserAuthz).not.toHaveBeenCalled();
    });

    test('R-provider-foreign: a same-company job assigned to someone else denies the provider', async () => {
        const client = fakeClient({ candidateIds: [PROVIDER] });
        tasksQueries.jobParentVisible.mockResolvedValue(false);

        await expect(resolveNotificationRecipients(COMPANY, event(), { client })).resolves.toEqual([]);
        expect(tasksQueries.jobParentVisible).toHaveBeenCalled();
        expect(client.claims.size).toBe(0);
    });

    test('a custom role with live assigned_only scope is never treated office-wide', async () => {
        const client = fakeClient({ candidateIds: [OFFICE] });
        authorizationService.resolveCompanyUserAuthz.mockResolvedValue({
            ...authz('custom_dispatch', ['jobs.view']),
            scopes: { job_visibility: 'assigned_only' },
        });
        tasksQueries.jobParentVisible.mockResolvedValue(false);

        await expect(resolveNotificationRecipients(COMPANY, event(), { client })).resolves.toEqual([]);
        expect(tasksQueries.jobParentVisible).toHaveBeenCalledWith(
            COMPANY,
            '10',
            { assignedOnly: true, userId: OFFICE },
            client
        );
        expect(client.claims.size).toBe(0);
    });

    test('live RBAC denial cannot be widened by an enabled category', async () => {
        const client = fakeClient({ candidateIds: [PROVIDER], categoryEnabled: true });
        tasksQueries.jobParentVisible.mockResolvedValue(true);
        authorizationService.resolveCompanyUserAuthz.mockResolvedValue(authz('provider', []));

        await expect(resolveNotificationRecipients(COMPANY, event(), { client })).resolves.toEqual([]);
        expect(tasksQueries.jobParentVisible).not.toHaveBeenCalled();
        expect(client.claims.size).toBe(0);
    });

    test('disabled category and missing destinations are terminal denies', async () => {
        for (const options of [
            { categoryEnabled: false },
            { browserDestinations: [], nativeDestinations: [] },
        ]) {
            const client = fakeClient({ candidateIds: [OFFICE], ...options });
            await expect(resolveNotificationRecipients(COMPANY, event(), { client })).resolves.toEqual([]);
            expect(client.claims.size).toBe(0);
        }
    });

    test('admin_system ignores user preferences but requires tenant.company.manage', async () => {
        const client = fakeClient({ candidateIds: [OFFICE], categoryEnabled: false });
        authorizationService.resolveCompanyUserAuthz.mockResolvedValue(
            authz('manager', ['tenant.company.manage'])
        );
        await expect(resolveNotificationRecipients(COMPANY, event({
            event_type: 'agent_task.failed',
            aggregate_type: 'company',
            aggregate_id: COMPANY,
            payload: {},
        }), { client })).resolves.toHaveLength(1);
        expect(client.query.mock.calls.some(([sql]) => (
            String(sql).includes('user_notification_preferences')
        ))).toBe(false);

        const denied = fakeClient({ candidateIds: [OFFICE] });
        authorizationService.resolveCompanyUserAuthz.mockResolvedValue(authz('manager', []));
        await expect(resolveNotificationRecipients(COMPANY, event({
            id: '102',
            event_type: 'agent_task.failed',
            aggregate_type: 'company',
            aggregate_id: COMPANY,
            payload: {},
        }), { client: denied })).resolves.toEqual([]);
    });

    test('providers are denied lead and orphan-message records', async () => {
        const leadClient = fakeClient({
            candidateIds: [PROVIDER],
            leadRows: { '20': { id: 20, uuid: 'L20', contact_id: null } },
        });
        await expect(resolveNotificationRecipients(COMPANY, event({
            event_type: 'lead.created', aggregate_type: 'lead', aggregate_id: '20', payload: {},
        }), { client: leadClient })).resolves.toEqual([]);

        const smsClient = fakeClient({
            candidateIds: [PROVIDER],
            smsRows: { 'conv-1': { id: 'conv-1', contact_ids: [] } },
        });
        await expect(resolveNotificationRecipients(COMPANY, event({
            event_type: 'sms.inbound', aggregate_type: 'sms', aggregate_id: 'conv-1', payload: {},
        }), { client: smsClient })).resolves.toEqual([]);
        expect(contactAccess.providerHasActiveJobForContact).not.toHaveBeenCalled();
    });

    test('pre-change recipient passes only when the authoritative before snapshot contains it', async () => {
        mockAvailableEvents.add('job.unassigned');
        const previousPayload = {
            previous_recipient_user_ids: [PROVIDER],
            previous_assigned_provider_user_ids: [PROVIDER],
        };
        const client = fakeClient({
            candidateIds: [PROVIDER],
            eventDataById: { '101': previousPayload },
        });
        const unassigned = event({ event_type: 'job.unassigned', payload: previousPayload });
        await expect(resolveNotificationRecipients(COMPANY, unassigned, { client }))
            .resolves.toHaveLength(1);
        const preChangeInsert = client.query.mock.calls.find(([sql]) => (
            String(sql).includes('INSERT INTO notification_deliveries')
        ));
        expect(preChangeInsert[1].slice(5, 8)).toEqual([null, null, true]);

        const invalidPayload = {
            previous_recipient_user_ids: [PROVIDER],
            previous_assigned_provider_user_ids: [OFFICE],
        };
        const invalidClient = fakeClient({
            candidateIds: [PROVIDER],
            eventDataById: { '102': invalidPayload },
        });
        await expect(resolveNotificationRecipients(COMPANY, event({
            ...unassigned,
            id: '102',
            payload: previousPayload,
        }), { client: invalidClient })).resolves.toEqual([]);
    });

    test('financial events require notifications.financial.receive, never financial_data.view', async () => {
        mockAvailableEvents.add('payment.succeeded');
        const financialEvent = event({
            event_type: 'payment.succeeded',
            aggregate_type: 'payment',
            aggregate_id: '30',
            payload: {},
        });
        const rows = {
            paymentRows: {
                '30': {
                    id: 30, job_id: 10, contact_id: null, estimate_id: null,
                    invoice_id: null, recorded_by: null,
                },
            },
        };
        const client = fakeClient({
            candidateIds: [OFFICE], ...rows, eventDataById: { '101': {} },
        });
        authorizationService.resolveCompanyUserAuthz.mockResolvedValue(
            authz('dispatcher', ['notifications.financial.receive'])
        );
        await expect(resolveNotificationRecipients(COMPANY, financialEvent, { client }))
            .resolves.toHaveLength(1);
        const financialInsert = client.query.mock.calls.find(([sql]) => (
            String(sql).includes('INSERT INTO notification_deliveries')
        ));
        expect(financialInsert[1].slice(5, 8)).toEqual(['job', '10', false]);

        const deniedClient = fakeClient({
            candidateIds: [OFFICE], ...rows, eventDataById: { '103': {} },
        });
        authorizationService.resolveCompanyUserAuthz.mockResolvedValue(
            authz('dispatcher', ['financial_data.view'])
        );
        await expect(resolveNotificationRecipients(COMPANY, {
            ...financialEvent, id: '103',
        }, { client: deniedClient })).resolves.toEqual([]);
    });

    test('assigned-only financial access requires the exact parent job, not another job for its contact', async () => {
        const client = fakeClient({
            candidateIds: [PROVIDER],
            paymentRows: {
                '30': {
                    id: 30, job_id: 20, contact_id: 50, estimate_id: null,
                    invoice_id: null, recorded_by: null,
                },
            },
            jobRows: {
                '20': { id: 20, contact_id: 50, assigned_provider_user_ids: [] },
            },
            contactRows: { '50': { id: 50 } },
            eventDataById: { '101': {} },
        });
        authorizationService.resolveCompanyUserAuthz.mockResolvedValue(
            authz('provider', ['notifications.financial.receive'])
        );
        tasksQueries.jobParentVisible.mockResolvedValue(false);
        // The provider owns another active job for contact 50. That must not
        // authorize this payment, whose operational parent is job 20.
        contactAccess.providerHasActiveJobForContact.mockResolvedValue(true);

        await expect(resolveNotificationRecipients(COMPANY, event({
            event_type: 'payment.succeeded',
            aggregate_type: 'payment',
            aggregate_id: '30',
            payload: {},
        }), { client })).resolves.toEqual([]);
        expect(tasksQueries.jobParentVisible).toHaveBeenCalledWith(
            COMPANY,
            '20',
            { assignedOnly: true, userId: PROVIDER },
            client
        );
        expect(contactAccess.providerHasActiveJobForContact).not.toHaveBeenCalled();
    });
});
