'use strict';

const crypto = require('node:crypto');

const mockGetClient = jest.fn();
const mockQuery = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    getClient: mockGetClient,
    query: mockQuery,
}));

const repository = require('../backend/src/services/appBuilderRepository');

const SOURCE = 'export async function run(ctx) { return ctx.input; }';
const SHA = crypto.createHash('sha256').update(SOURCE).digest('hex');
const BASE = {
    companyId: '10000000-0000-4000-8000-000000000001',
    actorId: '20000000-0000-4000-8000-000000000001',
    chatId: '30000000-0000-4000-8000-000000000001',
    source: SOURCE,
    sourceSha256: SHA,
    tools: [],
    description: 'Test.',
    model: 'test-model',
    tokenUsage: {},
    newApp: { appKey: 'unused', name: 'Unused', metadata: {} },
};

describe('APP-GAP-FIX-001 persistence attestation boundary', () => {
    beforeEach(() => jest.clearAllMocks());

    test.each([
        ['missing dry-run attestation', { scannerReport: { parsed: true } }],
        [
            'source hash mismatch',
            { scannerReport: { dry_run: { ok: true } }, sourceSha256: '0'.repeat(64) },
        ],
    ])('F4 direct persistSuccess rejects %s before any version write', async (_label, override) => {
        await expect(repository.persistSuccess({ ...BASE, ...override })).rejects.toMatchObject({
            code: 'APP_BUILDER_GATE_ATTESTATION_INVALID',
            httpStatus: 422,
        });
        expect(mockGetClient).not.toHaveBeenCalled();
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('Phase D invalid data declarations are rejected before a version transaction starts', async () => {
        await expect(repository.persistSuccess({
            ...BASE,
            scannerReport: { dry_run: { ok: true } },
            dataCollections: Array.from({ length: 5 }, (_, index) => ({
                name: `collection_${index}`,
                key_fields: ['id'],
                columns: [{ key: 'id', type: 'number' }],
            })),
        })).rejects.toMatchObject({
            code: 'DATA_COLLECTIONS_INVALID',
            httpStatus: 422,
        });
        expect(mockGetClient).not.toHaveBeenCalled();
    });

    test.each([
        ['more than eight actions', Array.from({ length: 9 }, (_, index) => ({
            id: `action_${index}`,
            label: `Action ${index}`,
        }))],
        ['an invalid action id', [{ id: 'Mark-ordered', label: 'Mark ordered' }]],
    ])('Phase E rejects %s before a version transaction starts', async (_label, actions) => {
        await expect(repository.persistSuccess({
            ...BASE,
            scannerReport: { dry_run: { ok: true } },
            actions,
        })).rejects.toMatchObject({
            code: 'APP_ACTIONS_INVALID',
            httpStatus: 422,
        });
        expect(mockGetClient).not.toHaveBeenCalled();
    });

    test.each([
        ['an unknown event', ['estimate.approved', 'unknown.event']],
        ['more than five events', [
            'estimate.approved',
            'job.status_changed',
            'lead.created',
            'payment.recorded',
            'invoice.sent',
            'estimate.approved',
        ]],
        ['a duplicate event', ['lead.created', 'lead.created']],
    ])('Phase F rejects %s before a version transaction starts', async (_label, subscribes) => {
        await expect(repository.persistSuccess({
            ...BASE,
            scannerReport: { dry_run: { ok: true } },
            subscribes,
        })).rejects.toMatchObject({
            code: 'APP_EVENT_SUBSCRIPTIONS_INVALID',
            httpStatus: 422,
        });
        expect(mockGetClient).not.toHaveBeenCalled();
    });
});
