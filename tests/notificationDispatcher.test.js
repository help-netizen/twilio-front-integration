'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/pushService', () => ({
    sendWebPushToUser: jest.fn(),
    sendNativePushToUser: jest.fn(),
}));
jest.mock('../backend/src/services/notificationRecipientResolver', () => ({
    resolveNotificationRecipients: jest.fn(),
}));

const {
    DISPATCHER_EVENT_TYPES,
    createNotificationDispatcher,
} = require('../backend/src/services/notificationDispatcher');
const { NOTIFICATION_EVENT_CATALOG } = require('../backend/src/services/notificationEventCatalog');

const COMPANY = '00000000-0000-4000-8000-00000000a001';
const USER = '00000000-0000-4000-8000-00000000a002';

function domainEvent(overrides = {}) {
    return {
        id: '101',
        company_id: COMPANY,
        event_type: 'job.created',
        aggregate_type: 'job',
        aggregate_id: '42',
        payload: {
            record_refs: [{ type: 'job', id: 42 }],
            customer_phone: '+15555550123',
            message_body: 'never deliver me',
        },
        ...overrides,
    };
}

function recipient() {
    return {
        user_id: USER,
        role_key: 'provider',
        destinations: {
            browser_push: [{ id: '00000000-0000-4000-8000-00000000b001' }],
            native_push: [{ id: '71' }],
        },
        delivery_ids: {
            browser_push: '00000000-0000-4000-8000-00000000d001',
            native_push: '00000000-0000-4000-8000-00000000d002',
        },
    };
}

function harness({ beginRows = null, resolverResult = [recipient()] } = {}) {
    const resolver = jest.fn().mockResolvedValue(resolverResult);
    const transports = {
        sendWebPushToUser: jest.fn().mockResolvedValue({ targeted: 1, sent: 1, failed: 0 }),
        sendNativePushToUser: jest.fn().mockResolvedValue({ targeted: 1, sent: 1, failed: 0 }),
    };
    const finishCalls = [];
    let beginIndex = 0;
    const claims = [
        { id: recipient().delivery_ids.browser_push, event_type: 'job.created', record_type: 'job', record_id: '42' },
        { id: recipient().delivery_ids.native_push, event_type: 'job.created', record_type: 'job', record_id: '42' },
    ];
    const query = jest.fn(async (sql, params) => {
        if (String(sql).includes("status = 'sending',")) {
            const row = beginRows === null ? claims[beginIndex] : beginRows[beginIndex];
            beginIndex += 1;
            return { rows: row ? [row] : [] };
        }
        if (String(sql).includes('SET status = $5')) {
            finishCalls.push(params);
            return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    const logger = { error: jest.fn() };
    return {
        dispatcher: createNotificationDispatcher({
            database: { query }, resolver, transports, logger,
        }),
        resolver,
        transports,
        query,
        finishCalls,
        logger,
    };
}

describe('notificationDispatcher', () => {
    test('subscribes only to catalog events with available producers', () => {
        const { dispatcher } = harness();
        const eventBus = { subscribe: jest.fn() };
        dispatcher.register(eventBus);
        expect(eventBus.subscribe).toHaveBeenCalledWith(
            'notification-dispatcher',
            NOTIFICATION_EVENT_CATALOG.filter(entry => entry.producer_available).map(entry => entry.event_type),
            dispatcher.dispatch
        );
        expect(DISPATCHER_EVENT_TYPES).not.toContain('job.updated');
    });

    test('uses the resolver once, sends each claimed channel to the exact user and device ids', async () => {
        const { dispatcher, resolver, transports, finishCalls } = harness();
        await expect(dispatcher.dispatch(domainEvent())).resolves.toEqual({ recipients: 1, deliveries: 2 });

        expect(resolver).toHaveBeenCalledWith(COMPANY, domainEvent(), { client: null });
        expect(transports.sendWebPushToUser).toHaveBeenCalledWith(
            COMPANY,
            USER,
            expect.objectContaining({
                title: 'Job created',
                body: 'Open Albusto to view this update.',
                record_ref: { type: 'job', id: '42' },
                url: '/jobs/42',
            }),
            { destinationIds: ['00000000-0000-4000-8000-00000000b001'] }
        );
        expect(transports.sendNativePushToUser).toHaveBeenCalledWith(
            COMPANY, USER, expect.any(Object), { destinationIds: ['71'] }
        );
        expect(JSON.stringify(transports.sendWebPushToUser.mock.calls[0][2])).not.toContain('+15555550123');
        expect(JSON.stringify(transports.sendWebPushToUser.mock.calls[0][2])).not.toContain('never deliver me');
        expect(finishCalls.map(call => call[4])).toEqual(['sent', 'sent']);
        expect(finishCalls.every(call => call[1] === COMPANY && call[2] === USER)).toBe(true);
    });

    test('a previously consumed claim cannot send again', async () => {
        const { dispatcher, transports } = harness({ beginRows: [null, null] });
        await expect(dispatcher.dispatch(domainEvent())).resolves.toEqual({ recipients: 1, deliveries: 2 });
        expect(transports.sendWebPushToUser).not.toHaveBeenCalled();
        expect(transports.sendNativePushToUser).not.toHaveBeenCalled();
    });

    test('provider failures are fail-soft and recorded without leaking provider text', async () => {
        const { dispatcher, transports, finishCalls, logger } = harness({
            resolverResult: [{
                ...recipient(),
                destinations: { browser_push: recipient().destinations.browser_push, native_push: [] },
                delivery_ids: { browser_push: recipient().delivery_ids.browser_push },
            }],
        });
        transports.sendWebPushToUser.mockRejectedValue(new Error('private provider response'));

        await expect(dispatcher.dispatch(domainEvent())).resolves.toEqual({ recipients: 1, deliveries: 1 });
        expect(finishCalls[0][4]).toBe('failed');
        expect(finishCalls[0][5]).toBe('PROVIDER_SEND_FAILED');
        expect(JSON.stringify(finishCalls[0])).not.toContain('private provider response');
        expect(logger.error).toHaveBeenCalled();
    });

    test('missing tenant, unknown event, and resolver errors all fail closed', async () => {
        const { dispatcher, resolver, transports, logger } = harness();
        await expect(dispatcher.dispatch(domainEvent({ company_id: null })))
            .resolves.toEqual({ recipients: 0, deliveries: 0 });
        await expect(dispatcher.dispatch(domainEvent({ event_type: 'unknown.event' })))
            .resolves.toEqual({ recipients: 0, deliveries: 0 });
        expect(resolver).not.toHaveBeenCalled();

        resolver.mockRejectedValue(new Error('resolver down'));
        await expect(dispatcher.dispatch(domainEvent()))
            .resolves.toEqual({ recipients: 0, deliveries: 0, failed: true });
        expect(transports.sendWebPushToUser).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
    });
});
