'use strict';

const db = require('../backend/src/db/connection');
const eventBus = require('../backend/src/services/eventBus');
const {
    NOTIFICATION_EVENT_CATALOG,
} = require('../backend/src/services/notificationEventCatalog');

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const EXPECTED_AVAILABLE = [
    'agent_task.failed',
    'ai_call.booked',
    'ai_call.declined',
    'ai_call.exhausted',
    'ai_call.failed',
    'call.missed',
    'call.voicemail_received',
    'email.inbound',
    'estimate.client_accepted',
    'estimate.client_declined',
    'estimate.send_failed',
    'invoice.send_failed',
    'job.assigned',
    'job.created',
    'job.rescheduled',
    'job.status_changed',
    'job.unassigned',
    'lead.assigned',
    'lead.converted',
    'lead.created',
    'lead.review_required',
    'lead.unassigned',
    'message.delivery_failed',
    'payment.disputed',
    'payment.failed',
    'payment.refunded',
    'payment.succeeded',
    'payment.voided',
    'review.received',
    'sms.inbound',
    'task.assigned',
    'task.due',
    'task.overdue',
    'task.reassigned',
    'yelp.message_received',
];

describe('typed notification producers', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    });

    test('only the wired V1 producer set is advertised as available', () => {
        const available = NOTIFICATION_EVENT_CATALOG
            .filter(entry => entry.producer_available)
            .map(entry => entry.event_type)
            .sort();
        expect(available).toEqual(EXPECTED_AVAILABLE);
    });

    test('transactional emit persists through the mutation client and dispatches after commit only', async () => {
        const afterCommit = [];
        const client = {
            query: jest.fn().mockResolvedValue({
                rows: [{ id: 91, created_at: new Date('2026-08-01T12:00:00Z') }],
            }),
            afterCommit: callback => afterCommit.push(callback),
        };
        const handled = jest.fn();
        eventBus.subscribe('notif-t4-after-commit', 'task.assigned', handled);

        await eventBus.emit(
            '00000000-0000-4000-8000-00000000a001',
            'task.assigned',
            { task_id: 10, record_refs: [{ type: 'task', id: 10 }] },
            {
                actorType: 'user',
                actorId: '00000000-0000-4000-8000-00000000a002',
                aggregateType: 'task',
                aggregateId: 10,
                client,
            }
        );

        expect(client.query).toHaveBeenCalledTimes(1);
        expect(db.query).not.toHaveBeenCalled();
        expect(handled).not.toHaveBeenCalled();
        expect(afterCommit).toHaveLength(1);
        await afterCommit[0]();
        await new Promise(resolve => setImmediate(resolve));
        expect(handled).toHaveBeenCalledWith(expect.objectContaining({
            company_id: '00000000-0000-4000-8000-00000000a001',
            event_type: 'task.assigned',
            aggregate_type: 'task',
            aggregate_id: '10',
        }));
    });
});
