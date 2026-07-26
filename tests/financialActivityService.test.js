'use strict';

const mockLogActivity = jest.fn();

jest.mock('../backend/src/services/activityLogService', () => ({
    logActivity: (...args) => mockLogActivity(...args),
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: jest.fn(),
}));

const {
    aiActor,
    clientActor,
    logFinancialActivity,
    stripeActor,
    userActor,
    zenbookerActor,
} = require('../backend/src/services/financialActivityService');

const COMPANY = '00000000-0000-4000-8000-000000000001';
const CRM_USER = '10000000-0000-4000-8000-000000000001';

function relationClient({ estimates = {}, invoices = {} } = {}) {
    return {
        query: jest.fn(async (sql, params) => {
            if (/FROM estimates/i.test(sql)) {
                return { rows: estimates[String(params[0])] ? [estimates[String(params[0])]] : [] };
            }
            if (/FROM invoices/i.test(sql)) {
                return { rows: invoices[String(params[0])] ? [invoices[String(params[0])]] : [] };
            }
            throw new Error(`Unexpected relation query: ${sql}`);
        }),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockLogActivity.mockResolvedValue({ ok: true, id: 1 });
});

describe('financial parent snapshots', () => {
    test('Estimate uses direct Job before Lead and Contact', async () => {
        const client = relationClient();
        await logFinancialActivity({
            companyId: COMPANY,
            entityType: 'estimate',
            action: 'estimate.sent',
            entity: { id: 11, job_id: 7, lead_id: 8, contact_id: 9 },
            actor: userActor(CRM_USER),
        }, { client });

        expect(mockLogActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                actor_id: CRM_USER,
                details: expect.objectContaining({
                    actor_type: 'user',
                    actor_label: null,
                    parent_type: 'job',
                    parent_id: '7',
                }),
            }),
            { client }
        );
    });

    test('Invoice inherits a Lead from its Estimate before falling back to Contact', async () => {
        const client = relationClient({
            estimates: {
                31: { id: 31, job_id: null, lead_id: 18, contact_id: 19 },
            },
        });
        await logFinancialActivity({
            companyId: COMPANY,
            entityType: 'invoice',
            action: 'invoice.sent',
            entity: {
                id: 22,
                estimate_id: 31,
                job_id: null,
                lead_id: null,
                contact_id: 20,
            },
            actor: aiActor('Sara'),
        }, { client });

        expect(mockLogActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                actor_id: null,
                details: expect.objectContaining({
                    actor_type: 'ai',
                    actor_label: 'Sara',
                    parent_type: 'lead',
                    parent_id: '18',
                }),
            }),
            { client }
        );
    });

    test('Payment derives through Invoice then its Estimate and supports Contact-only rows', async () => {
        const client = relationClient({
            invoices: {
                41: {
                    id: 41,
                    job_id: null,
                    lead_id: null,
                    contact_id: null,
                    estimate_id: 51,
                },
            },
            estimates: {
                51: { id: 51, job_id: 17, lead_id: 18, contact_id: 19 },
            },
        });
        await logFinancialActivity({
            companyId: COMPANY,
            entityType: 'payment',
            action: 'payment.succeeded',
            entity: {
                id: 33,
                invoice_id: 41,
                estimate_id: null,
                job_id: null,
                contact_id: 20,
            },
            actor: stripeActor(),
        }, { client });

        expect(mockLogActivity).toHaveBeenLastCalledWith(
            expect.objectContaining({
                actor_id: null,
                details: expect.objectContaining({
                    actor_type: 'system',
                    actor_label: 'Stripe',
                    parent_type: 'job',
                    parent_id: '17',
                }),
            }),
            { client }
        );

        await logFinancialActivity({
            companyId: COMPANY,
            entityType: 'payment',
            action: 'payment.recorded',
            entity: {
                id: 34,
                invoice_id: null,
                estimate_id: null,
                job_id: null,
                contact_id: 20,
            },
            actor: clientActor(),
        }, { client });

        expect(mockLogActivity).toHaveBeenLastCalledWith(
            expect.objectContaining({
                details: expect.objectContaining({
                    actor_type: 'client',
                    parent_type: 'contact',
                    parent_id: '20',
                }),
            }),
            { client }
        );
    });
});

describe.each([
    ['estimate', [
        'estimate.created',
        'estimate.updated',
        'estimate.sent',
        'estimate.approved',
        'estimate.declined',
        'estimate.client_accepted',
        'estimate.client_declined',
        'estimate.converted',
        'estimate.linked_job',
        'estimate.archived',
        'estimate.restored',
        'estimate.viewed',
        'estimate.send_failed',
    ]],
    ['invoice', [
        'invoice.created',
        'invoice.updated',
        'invoice.sent',
        'invoice.voided',
        'invoice.deleted',
        'invoice.payment_recorded',
        'invoice.payment_voided',
        'invoice.link_created',
        'invoice.link_sent',
        'invoice.card_session_started',
        'invoice.payment_succeeded',
        'invoice.payment_failed',
        'invoice.refunded',
        'invoice.items_synced',
        'invoice.viewed',
        'invoice.send_failed',
    ]],
    ['payment', [
        'payment.recorded',
        'payment.succeeded',
        'payment.failed',
        'payment.refunded',
        'payment.voided',
        'payment.disputed',
        'payment.receipt_sent',
        'payment.portal_submitted',
        'payment.session_started',
        'payment.receipt_send_failed',
        'refund.failed',
    ]],
])('%s action catalog parent snapshots', (entityType, actions) => {
    test.each(actions)('%s carries the write-time Job parent', async (action) => {
        const client = relationClient();
        await logFinancialActivity({
            companyId: COMPANY,
            entityType,
            action,
            entity: {
                id: 91,
                job_id: 77,
                lead_id: 78,
                contact_id: 79,
            },
            actor: userActor(CRM_USER),
        }, { client });

        expect(mockLogActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                action,
                target_type: entityType,
                target_id: '91',
                details: expect.objectContaining({
                    parent_type: 'job',
                    parent_id: '77',
                }),
            }),
            { client }
        );
    });
});

test('actor factories never put a non-human identity in actor_id', () => {
    expect(clientActor()).toEqual({
        id: null, type: 'client', label: 'Client', source: 'portal',
    });
    expect(stripeActor()).toEqual({
        id: null, type: 'system', label: 'Stripe', source: 'webhook',
    });
    expect(aiActor('Sara')).toEqual({
        id: null, type: 'ai', label: 'Sara', source: 'mcp',
    });
    expect(zenbookerActor()).toEqual({
        id: null, type: 'integration', label: 'Zenbooker', source: 'sync',
    });
});
