'use strict';

const {
    APP_EVENT_CATALOG,
    APP_EVENT_TYPES,
    projectAppEventPayload,
    renderAppEventCatalogContract,
    validateSyntheticEvent,
} = require('../backend/src/services/appEventCatalog');
const { buildPrompt } = require('../backend/src/services/appBuilderService');
const { versionResponse } = require('../backend/src/services/appVersionTransitionService');

describe('APP-DATA-001 Phase F app event catalog', () => {
    test('the closed v1 catalog contains exactly the five approved events', () => {
        expect(APP_EVENT_TYPES).toEqual([
            'estimate.approved',
            'job.status_changed',
            'lead.created',
            'payment.recorded',
            'invoice.sent',
        ]);
    });

    test('rendered documentation cannot drift from event names or payload schemas', () => {
        const documentation = renderAppEventCatalogContract();
        for (const event of APP_EVENT_CATALOG) {
            expect(documentation).toContain(event.type);
            expect(documentation).toContain(event.description);
            for (const field of Object.keys(event.payload_schema)) {
                expect(documentation).toContain(`${field}:`);
            }
        }
        expect((documentation.match(/^- /gm) || [])).toHaveLength(APP_EVENT_CATALOG.length);
        expect(buildPrompt({ history: [], current_source: null })).toContain(documentation);
    });

    test('outbox projection strips internal bus fields', () => {
        expect(projectAppEventPayload('lead.created', {
            id: 41,
            lead_id: 41,
            serial_id: 'L-41',
            source: 'Referral',
            record_refs: [{ type: 'lead', id: 41 }],
        })).toEqual({ lead_id: 41, serial_id: 'L-41', source: 'Referral' });
    });

    test('job status events retain native identifiers and the legacy number', () => {
        expect(projectAppEventPayload('job.status_changed', {
            job_id: 71,
            job_number: null,
            job_seq: 171,
            public_code: 'aB3xZ',
            old_status: 'Submitted',
            new_status: 'On the way',
            record_refs: [{ type: 'job', id: 71 }],
        })).toEqual({
            job_id: 71,
            job_number: null,
            job_seq: 171,
            public_code: 'aB3xZ',
            old_status: 'Submitted',
            new_status: 'On the way',
        });
    });

    test('synthetic events use the catalog and enforce the 8 KiB payload boundary', () => {
        expect(validateSyntheticEvent({
            type: 'invoice.sent',
            payload: { invoice_id: 9 },
        })).toEqual({ type: 'invoice.sent', payload: { invoice_id: 9 } });
        expect(() => validateSyntheticEvent({
            type: 'unknown.event',
            payload: {},
        })).toThrow(/not a supported app event/);
        expect(() => validateSyntheticEvent({
            type: 'invoice.sent',
            payload: { value: 'x'.repeat(8 * 1024) },
        })).toThrow(/8192 bytes/);
    });

    test('moderation responses expose the version-pinned subscriptions', () => {
        expect(versionResponse({
            id: '40000000-0000-4000-8000-000000000001',
            app_id: '91',
            scanner_report: { subscribes: ['lead.created'] },
            status: 'submitted',
        })).toMatchObject({ subscribes: ['lead.created'] });
    });
});
