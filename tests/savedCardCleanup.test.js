'use strict';

jest.mock('../backend/src/services/stripeConnectProvider');
jest.mock('../backend/src/db/stripeSavedCardsQueries');

const provider = require('../backend/src/services/stripeConnectProvider');
const queries = require('../backend/src/db/stripeSavedCardsQueries');
const cleanup = require('../backend/src/services/savedCardCleanupService');
const scheduler = require('../backend/src/services/savedCardCleanupScheduler');

const COMPANY = '11111111-1111-4111-8111-111111111111';
const EXPIRED = {
    id: 41,
    company_id: COMPANY,
    stripe_account_id: 'acct_company_a',
    stripe_payment_method_id: 'pm_expired_41',
};

beforeEach(() => {
    jest.clearAllMocks();
    scheduler._resetForTests();
    queries.listExpiredCards.mockResolvedValue([EXPIRED]);
    queries.deleteExpiredCard.mockResolvedValue({ id: EXPIRED.id });
    queries.listExpiredCompanyIds.mockResolvedValue([COMPANY]);
    provider.detachPaymentMethod.mockResolvedValue({ id: EXPIRED.stripe_payment_method_id });
});

describe('CARD-ON-FILE-001 expired-card cleanup', () => {
    it('detaches on the tenant connected account and deletes the expired cache row', async () => {
        await expect(cleanup.cleanupExpiredSavedCards(COMPANY)).resolves.toEqual({
            company_id: COMPANY,
            scanned: 1,
            detached: 1,
            failed: 0,
        });
        expect(queries.listExpiredCards).toHaveBeenCalledWith(COMPANY, 100);
        expect(provider.detachPaymentMethod).toHaveBeenCalledWith(
            'acct_company_a',
            'pm_expired_41'
        );
        expect(queries.deleteExpiredCard).toHaveBeenCalledWith(COMPANY, 41);
    });

    it('is idempotent when Stripe already detached the PaymentMethod', async () => {
        provider.detachPaymentMethod.mockRejectedValue(Object.assign(
            new Error('No such PaymentMethod'),
            { stripeCode: 'resource_missing' }
        ));

        await expect(cleanup.cleanupExpiredSavedCards(COMPANY)).resolves.toMatchObject({
            detached: 1,
            failed: 0,
        });
        expect(queries.deleteExpiredCard).toHaveBeenCalledWith(COMPANY, 41);
    });

    it('keeps the row for the next tick when Stripe fails, then retries successfully', async () => {
        provider.detachPaymentMethod.mockRejectedValueOnce(new Error('Stripe unavailable'));

        await expect(cleanup.cleanupExpiredSavedCards(COMPANY)).resolves.toMatchObject({
            detached: 0,
            failed: 1,
        });
        expect(queries.deleteExpiredCard).not.toHaveBeenCalled();

        await expect(cleanup.cleanupExpiredSavedCards(COMPANY)).resolves.toMatchObject({
            detached: 1,
            failed: 0,
        });
        expect(provider.detachPaymentMethod).toHaveBeenCalledTimes(2);
        expect(queries.deleteExpiredCard).toHaveBeenCalledTimes(1);
    });

    it('runs at most once per six-hour scheduler window', async () => {
        await scheduler.tick(new Date('2026-08-02T00:00:00Z'));
        await expect(scheduler.tick(new Date('2026-08-02T05:59:59Z')))
            .resolves.toEqual({ skipped: true });
        await scheduler.tick(new Date('2026-08-02T06:00:00Z'));

        expect(queries.listExpiredCompanyIds).toHaveBeenCalledTimes(2);
    });
});
