'use strict';

const {
    NOTIFICATION_EVENT_CATALOG,
} = require('../backend/src/services/notificationEventCatalog');
const {
    GENERIC_BODY,
    PRE_CHANGE_GENERIC_TITLE,
    buildNotificationPayload,
} = require('../backend/src/services/notificationPayloadBuilder');

describe('notification lock-screen payload safety', () => {
    test.each(NOTIFICATION_EVENT_CATALOG.filter(entry => entry.producer_available))(
        '$event_type produces only the fixed, PII-safe payload contract',
        entry => {
            const payload = buildNotificationPayload({
                eventType: entry.event_type,
                deliveryId: '00000000-0000-4000-8000-000000000099',
                recordType: 'job',
                recordId: '42',
                // Poison values document that producer data is not a supported
                // input to this boundary and cannot be reflected by accident.
                message_body: 'PRIVATE-MESSAGE-BODY',
                amount: '987654.32',
                address: '10 Secret Street',
                phone: '+15555550123',
                ai_summary: 'PRIVATE-AI-SUMMARY',
                url: 'https://attacker.invalid/steal',
            });

            expect(payload).toEqual({
                title: entry.label,
                body: GENERIC_BODY,
                tag: 'notification-00000000-0000-4000-8000-000000000099',
                event_type: entry.event_type,
                category_key: entry.category_key,
                category_label: entry.category_label,
                deep_link_kind: 'job',
                record_ref: { type: 'job', id: '42' },
                url: '/jobs/42',
            });
            const serialized = JSON.stringify(payload);
            for (const forbidden of [
                'PRIVATE-MESSAGE-BODY', '987654.32', '10 Secret Street',
                '+15555550123', 'PRIVATE-AI-SUMMARY', 'attacker.invalid',
            ]) {
                expect(serialized).not.toContain(forbidden);
            }
        }
    );

    test('unknown, unavailable, or unclaimed events fail closed', () => {
        expect(buildNotificationPayload({
            eventType: 'not.allowlisted', deliveryId: 'delivery-1', recordType: 'job', recordId: '1',
        })).toBeNull();
        expect(buildNotificationPayload({
            eventType: 'job.updated', deliveryId: 'delivery-1', recordType: 'job', recordId: '1',
        })).toBeNull();
        expect(buildNotificationPayload({
            eventType: 'job.created', recordType: 'job', recordId: '1',
        })).toBeNull();
    });

    test('unknown record types cannot become arbitrary deep links', () => {
        expect(buildNotificationPayload({
            eventType: 'job.created',
            deliveryId: 'delivery-1',
            recordType: 'https://attacker.invalid',
            recordId: '../secret',
        })).toMatchObject({ deep_link_kind: 'home', url: '/' });
    });

    test('pre-change recipients get a generic title and no record or deep-link fields', () => {
        for (const [eventType, categoryKey, categoryLabel] of [
            ['job.unassigned', 'job_schedule', 'Job & schedule updates'],
            ['lead.unassigned', 'leads', 'Leads'],
            ['task.reassigned', 'tasks', 'Tasks'],
        ]) {
            const payload = buildNotificationPayload({
                eventType,
                deliveryId: 'delivery-pre-change',
                recordType: 'job',
                recordId: 'private-job-42',
                isPreChangeRecipient: true,
            });
            expect(payload).toEqual({
                title: PRE_CHANGE_GENERIC_TITLE,
                body: GENERIC_BODY,
                tag: 'notification-delivery-pre-change',
                event_type: eventType,
                category_key: categoryKey,
                category_label: categoryLabel,
            });
            expect(JSON.stringify(payload)).not.toContain('private-job-42');
        }
    });

    test('financial payloads link only to an operational parent and reject raw ledger refs', () => {
        expect(buildNotificationPayload({
            eventType: 'payment.succeeded',
            deliveryId: 'delivery-financial-parent',
            recordType: 'job',
            recordId: '42',
        })).toMatchObject({
            deep_link_kind: 'job',
            record_ref: { type: 'job', id: '42' },
            url: '/jobs/42',
        });

        for (const [recordType, recordId] of [
            [null, null],
            ['payment', 'private-payment-99'],
        ]) {
            const generic = buildNotificationPayload({
                eventType: 'payment.succeeded',
                deliveryId: `delivery-financial-${recordType || 'no-parent'}`,
                recordType,
                recordId,
            });
            expect(generic).not.toHaveProperty('deep_link_kind');
            expect(generic).not.toHaveProperty('record_ref');
            expect(generic).not.toHaveProperty('url');
            expect(JSON.stringify(generic)).not.toContain(String(recordId));
        }

        const rawLedger = buildNotificationPayload({
            eventType: 'payment.succeeded',
            deliveryId: 'delivery-financial-raw',
            recordType: 'payment',
            recordId: 'private-payment-99',
        });
        expect(rawLedger).not.toHaveProperty('deep_link_kind');
        expect(rawLedger).not.toHaveProperty('record_ref');
        expect(rawLedger).not.toHaveProperty('url');
        expect(JSON.stringify(rawLedger)).not.toContain('private-payment-99');
    });
});
