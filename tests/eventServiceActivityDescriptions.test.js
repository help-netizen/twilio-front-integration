'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const eventService = require('../backend/src/services/eventService');

describe('audit action descriptions', () => {
    test.each([
        ['estimate.created', 'Estimate created.'],
        ['invoice.sent', 'Invoice sent.'],
        ['payment.refunded', 'Payment refunded.'],
        ['job.status_changed', 'Job status changed.'],
        ['lead.converted', 'Lead converted to a job.'],
        ['contact.merged', 'Contacts merged.'],
    ])('%s has a representative human sentence', (action, expected) => {
        expect(eventService.describeActivity(action)).toBe(expected);
    });

    test('safe channel details enrich a sentence without exposing arbitrary details', () => {
        expect(eventService.describeActivity('estimate.sent', {
            summary: {
                channel: 'email',
                message: 'must not appear',
            },
        })).toBe('Estimate sent by EMAIL.');
    });
});

describe('audit History item shape', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        eventService.resetActivityLogCutoverCache();
    });

    test('adds canonical actor and target fields while preserving legacy fields', async () => {
        db.query.mockImplementation(async sql => {
            if (String(sql).includes('FROM activity_log_config')) {
                return { rows: [{ cutover_at: '2026-07-26T12:00:00Z' }] };
            }
            if (String(sql).includes('FROM audit_log')) {
                return {
                    rows: [{
                        id: 9,
                        action: 'payment.refunded',
                        details: {
                            actor_type: 'integration',
                            actor_label: 'Zenbooker',
                            summary: { amount: 25, currency: 'USD' },
                        },
                        actor_id: null,
                        actor_email: null,
                        actor_name: null,
                        actor_user_email: null,
                        target_type: 'payment',
                        target_id: '88',
                        created_at: '2026-07-26T13:00:00Z',
                    }],
                };
            }
            return { rows: [] };
        });

        const history = await eventService.getEntityHistory('company-1', 'job', 42);

        expect(history).toEqual([expect.objectContaining({
            id: 'audit_9',
            type: 'event',
            event_type: 'payment.refunded',
            action: 'payment.refunded',
            description: 'Payment refunded.',
            actor: 'Zenbooker',
            actor_type: 'integration',
            actor_label: 'Zenbooker',
            actor_name: null,
            target_type: 'payment',
            target_id: '88',
            created_at: '2026-07-26T13:00:00.000Z',
            data: expect.objectContaining({ actor_type: 'integration' }),
        })]);
    });

    test('passes the cached cutover to the legacy leg and loads it once', async () => {
        db.query.mockImplementation(async sql => {
            if (String(sql).includes('FROM activity_log_config')) {
                return { rows: [{ cutover_at: '2026-07-26T12:00:00Z' }] };
            }
            return { rows: [] };
        });

        await eventService.getEntityHistory('company-1', 'job', 42);
        await eventService.getEntityHistory('company-1', 'job', 43);

        const configCalls = db.query.mock.calls.filter(([sql]) =>
            String(sql).includes('FROM activity_log_config')
        );
        const legacyCalls = db.query.mock.calls.filter(([sql]) =>
            String(sql).includes('FROM domain_events')
        );
        expect(configCalls).toHaveLength(1);
        expect(legacyCalls).toHaveLength(2);
        expect(legacyCalls[0][0]).toContain('created_at < $5');
        expect(legacyCalls[0][1][4]).toBe('2026-07-26T12:00:00Z');
    });

    test('legacy conversion history prefers job_seq while retaining job_id data', async () => {
        db.query.mockImplementation(async sql => {
            if (String(sql).includes('FROM activity_log_config')) {
                return { rows: [{ cutover_at: '2026-07-26T12:00:00Z' }] };
            }
            if (String(sql).includes('FROM domain_events')) {
                return {
                    rows: [{
                        id: 17,
                        event_type: 'converted',
                        event_data: { job_id: 1131, job_seq: 171 },
                        actor_type: 'user',
                        actor_id: 'actor-1',
                        created_at: '2026-07-25T13:00:00Z',
                    }],
                };
            }
            return { rows: [] };
        });

        const history = await eventService.getEntityHistory('company-1', 'lead', 42);

        expect(history).toEqual([expect.objectContaining({
            description: 'Converted to Job #171',
            data: { job_id: 1131, job_seq: 171 },
        })]);
    });
});
