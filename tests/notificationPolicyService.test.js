'use strict';

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
}));

const {
    NOTIFICATION_EVENT_CATALOG,
    getNotificationCatalogEntry,
} = require('../backend/src/services/notificationEventCatalog');
const service = require('../backend/src/services/notificationPolicyService');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';
const USER_A = '10000000-0000-4000-8000-00000000000a';
const ROLE_A = '20000000-0000-4000-8000-00000000000a';
const ROLE_B = '20000000-0000-4000-8000-00000000000b';

describe('notificationPolicyService effective policy', () => {
    const entry = getNotificationCatalogEntry('lead.created');

    test('user enabled cannot widen disabled company or role policy', () => {
        const result = service.computeEffectivePolicyEntry(entry, {
            companyEnabled: false,
            roleChannels: { browser_push: false },
            preferences: { browser_push: 'enabled' },
            permissions: ['leads.view'],
            destinations: { browser_push: true },
        });
        expect(result.channels.browser_push.enabled).toBe(false);
        expect(result.channels.browser_push.reason_codes).toEqual(expect.arrayContaining([
            'COMPANY_EVENT_DISABLED',
            'ROLE_CHANNEL_DISABLED',
        ]));
    });

    test('live permission and destination remain mandatory', () => {
        const result = service.computeEffectivePolicyEntry(entry, {
            companyEnabled: true,
            roleChannels: { browser_push: true },
            preferences: { browser_push: 'inherit' },
            permissions: [],
            destinations: { browser_push: false },
        });
        expect(result.channels.browser_push).toEqual({
            enabled: false,
            reason_codes: ['MISSING_PERMISSION', 'NO_ACTIVE_DESTINATION'],
        });
    });

    test('all gates allow an available producer', () => {
        const result = service.computeEffectivePolicyEntry(entry, {
            companyEnabled: true,
            roleChannels: { browser_push: true },
            preferences: { browser_push: 'inherit' },
            permissions: ['leads.view'],
            destinations: { browser_push: true },
        });
        expect(result.channels.browser_push).toEqual({ enabled: true, reason_codes: [] });
    });
});

describe('notificationPolicyService reads and writes', () => {
    test('non-admin snapshot query is constrained to the caller role and missing rows fail closed', async () => {
        const client = { query: jest.fn() };
        client.query
            .mockResolvedValueOnce({ rows: [{ event_type: 'lead.created', enabled: true }] })
            .mockResolvedValueOnce({ rows: [{
                id: ROLE_A,
                role_key: 'provider',
                display_name: 'Provider',
                event_type: null,
                channel: null,
                enabled: null,
            }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ browser_push: true, native_push: true }] });

        const data = await service.getPolicySnapshot(COMPANY_A, {
            userId: USER_A,
            roleKey: 'provider',
            permissions: ['leads.view'],
            includeAllRoles: false,
            client,
        });

        expect(client.query.mock.calls[1][1]).toEqual([
            COMPANY_A,
            NOTIFICATION_EVENT_CATALOG.map(entry => entry.event_type),
            false,
            'provider',
        ]);
        expect(data.role_delivery).toHaveLength(1);
        expect(data.role_delivery[0].role_key).toBe('provider');
        expect(data.company_policy.find(row => row.event_type === 'job.assigned').enabled).toBe(false);
        expect(data.effective_policy.find(row => row.event_type === 'lead.created')
            .channels.browser_push.reason_codes).toContain('ROLE_CHANNEL_DISABLED');
    });

    test('unknown event and unavailable producer are rejected before any write', async () => {
        const client = { query: jest.fn() };
        await expect(service.updateCompanyPolicy(
            COMPANY_A,
            'client.supplied',
            { company_enabled: true },
            USER_A,
            { client }
        )).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_EVENT_TYPE' });
        await expect(service.updateCompanyPolicy(
            COMPANY_A,
            'call.voicemail_received',
            { company_enabled: true },
            USER_A,
            { client }
        )).rejects.toMatchObject({ status: 409, code: 'PRODUCER_UNAVAILABLE' });
        expect(client.query).not.toHaveBeenCalled();
    });

    test('foreign role returns 404 before policy writes', async () => {
        const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        await expect(service.updateCompanyPolicy(
            COMPANY_A,
            'lead.created',
            { roles: [{ role_config_id: ROLE_B, channels: { browser_push: true } }] },
            USER_A,
            { client }
        )).rejects.toMatchObject({ status: 404, code: 'ROLE_CONFIG_NOT_FOUND' });
        expect(client.query).toHaveBeenCalledTimes(1);
        expect(client.query.mock.calls[0][1]).toEqual([COMPANY_A, [ROLE_B]]);
    });

    test('preference identity/audience fields are rejected and cannot select another user', async () => {
        const client = { query: jest.fn() };
        await expect(service.updateCurrentUserPreference(
            COMPANY_A,
            USER_A,
            'provider',
            ['leads.view'],
            'lead.created',
            { user_id: 'someone-else', channels: { browser_push: 'enabled' } },
            { client }
        )).rejects.toMatchObject({ status: 400, code: 'INVALID_NOTIFICATION_POLICY' });
        expect(client.query).not.toHaveBeenCalled();
    });

    test('new-company seed writes code defaults and explicit role/channel defaults', async () => {
        const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        await service.seedNotificationDefaultsForCompany(COMPANY_B, { client });
        expect(client.query).toHaveBeenCalledTimes(2);
        const companyDefaults = JSON.parse(client.query.mock.calls[0][1][1]);
        const roleDefaults = JSON.parse(client.query.mock.calls[1][1][1]);
        expect(companyDefaults).toHaveLength(54);
        expect(companyDefaults.find(row => row.event_type === 'lead.created').default_enabled).toBe(true);
        expect(companyDefaults.find(row => row.event_type === 'job.created').default_enabled).toBe(false);
        expect(roleDefaults).toContainEqual({
            event_type: 'lead.created',
            channel: 'browser_push',
            role_key: 'provider',
            enabled: false,
        });
    });
});
