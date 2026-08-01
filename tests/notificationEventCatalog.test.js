'use strict';

const {
    NOTIFICATION_CATALOG_VERSION,
    NOTIFICATION_CATEGORIES,
    NOTIFICATION_EVENT_CATALOG,
    getNotificationCatalogEntry,
    getPublicNotificationEventCatalog,
} = require('../backend/src/services/notificationEventCatalog');

const PUBLIC_KEYS = [
    'category_key',
    'category_label',
    'default_audience_summary',
    'description',
    'event_type',
    'label',
    'producer_available',
    'required_permission',
].sort();

describe('notification event catalog', () => {
    test('is versioned, ordered, unique, and contains the approved 54 V1 events', () => {
        expect(NOTIFICATION_CATALOG_VERSION).toBe(1);
        expect(NOTIFICATION_EVENT_CATALOG).toHaveLength(54);
        expect(new Set(NOTIFICATION_EVENT_CATALOG.map(entry => entry.event_type)).size).toBe(54);
        expect(NOTIFICATION_EVENT_CATALOG[0].event_type).toBe('lead.created');
        expect(NOTIFICATION_EVENT_CATALOG.at(-1).event_type).toBe('contact.updated');
    });

    test('public projection has exactly the UI contract fields and no internal scope fields', () => {
        const publicCatalog = getPublicNotificationEventCatalog();
        for (const entry of publicCatalog) {
            expect(Object.keys(entry).sort()).toEqual(PUBLIC_KEYS);
            expect(entry).not.toHaveProperty('record_scope');
            expect(entry).not.toHaveProperty('default_role_keys');
            expect(entry).not.toHaveProperty('source_event_type');
        }
    });

    test('defines five ordered user categories plus one internal always-on category', () => {
        expect(NOTIFICATION_CATEGORIES.map(category => category.key)).toEqual([
            'job_schedule', 'leads', 'calls_messages', 'finance', 'tasks', 'admin_system',
        ]);
        expect(NOTIFICATION_CATEGORIES.filter(category => category.user_configurable)).toHaveLength(5);
        expect(NOTIFICATION_EVENT_CATALOG.every(entry => (
            NOTIFICATION_CATEGORIES.some(category => category.key === entry.category_key)
        ))).toBe(true);
    });

    test('truthfully marks producer gaps', () => {
        expect(getNotificationCatalogEntry('lead.created').producer_available).toBe(true);
        expect(getNotificationCatalogEntry('sms.inbound').producer_available).toBe(true);
        expect(getNotificationCatalogEntry('call.voicemail_received').producer_available).toBe(true);
        expect(getNotificationCatalogEntry('call.missed').producer_available).toBe(true);
        expect(getNotificationCatalogEntry('job.updated').producer_available).toBe(false);
    });

    test('financial event family uses the notification-only permission', () => {
        const financial = NOTIFICATION_EVENT_CATALOG.filter(entry => (
            entry.category_key === 'finance'
        ));
        expect(financial.length).toBeGreaterThan(0);
        expect(financial.every(entry => (
            entry.required_permission === 'notifications.financial.receive'
        ))).toBe(true);
    });

    test('maps all event families to the binding categories', () => {
        for (const entry of NOTIFICATION_EVENT_CATALOG) {
            let expected;
            if (entry.event_type.startsWith('job.') || entry.event_type === 'review.received') expected = 'job_schedule';
            else if (entry.event_type.startsWith('lead.')) expected = 'leads';
            else if (/^(sms\.|email\.|yelp\.|call\.|ai_call\.)/.test(entry.event_type)
                || ['message.delivery_failed', 'contact.updated'].includes(entry.event_type)) expected = 'calls_messages';
            else if (/^(estimate\.|invoice\.|payment\.)/.test(entry.event_type)) expected = 'finance';
            else if (entry.event_type.startsWith('task.')) expected = 'tasks';
            else expected = 'admin_system';
            expect(entry.category_key).toBe(expected);
        }
    });

    test('unknown event keys are not catalog entries', () => {
        expect(getNotificationCatalogEntry('anything.from.the.client')).toBeNull();
    });
});
