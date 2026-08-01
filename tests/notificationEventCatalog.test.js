'use strict';

const {
    NOTIFICATION_CATALOG_VERSION,
    NOTIFICATION_EVENT_CATALOG,
    getNotificationCatalogEntry,
    getPublicNotificationEventCatalog,
} = require('../backend/src/services/notificationEventCatalog');

const PUBLIC_KEYS = [
    'category',
    'default_audience_summary',
    'default_enabled',
    'description',
    'event_type',
    'label',
    'producer_available',
    'required_permission',
    'supported_channels',
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

    test('M1.T2 exposes only deployed channels and truthfully marks producer gaps', () => {
        for (const entry of getPublicNotificationEventCatalog()) {
            expect(entry.supported_channels.every(channel => (
                channel === 'browser_push' || channel === 'native_push'
            ))).toBe(true);
        }
        expect(getNotificationCatalogEntry('lead.created').producer_available).toBe(true);
        expect(getNotificationCatalogEntry('sms.inbound').producer_available).toBe(true);
        expect(getNotificationCatalogEntry('call.voicemail_received').producer_available).toBe(false);
        expect(getNotificationCatalogEntry('call.missed').producer_available).toBe(false);
    });

    test('financial event family uses the notification-only permission', () => {
        const financial = NOTIFICATION_EVENT_CATALOG.filter(entry => (
            entry.category === 'Estimates, invoices & payments'
        ));
        expect(financial.length).toBeGreaterThan(0);
        expect(financial.every(entry => (
            entry.required_permission === 'notifications.financial.receive'
        ))).toBe(true);
    });

    test('unknown event keys are not catalog entries', () => {
        expect(getNotificationCatalogEntry('anything.from.the.client')).toBeNull();
    });
});

