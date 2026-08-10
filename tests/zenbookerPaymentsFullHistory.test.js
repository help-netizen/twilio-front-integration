/**
 * ZB-DECOUPLE F4 — the Payments page remains a local data layer, while every
 * API-backed sync entry point is absent.
 */

'use strict';

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
}));

const paymentsService = require('../backend/src/services/zenbookerPaymentsSyncService');
const paymentsRouter = require('../backend/src/routes/zenbooker/payments');

describe('Zenbooker payment API sync decommission', () => {
    test('the service exposes only the retained local data and reconciliation API', () => {
        expect(paymentsService.syncPayments).toBeUndefined();
        expect(paymentsService.isDefaultSyncCompany).toBeUndefined();
        expect(paymentsService).toEqual(expect.objectContaining({
            listPayments: expect.any(Function),
            listPaymentsForExport: expect.any(Function),
            getPaymentDetail: expect.any(Function),
            updateCheckDeposited: expect.any(Function),
            projectCompanyLedger: expect.any(Function),
            reconcileJobLinks: expect.any(Function),
            resolveZbJobId: expect.any(Function),
            resolveZbInvoiceId: expect.any(Function),
            extractSource: expect.any(Function),
        }));
    });

    test('the HTTP router has no POST /sync endpoint', () => {
        const syncLayer = paymentsRouter.stack.find(candidate =>
            candidate.route?.path === '/sync' && candidate.route.methods.post
        );
        expect(syncLayer).toBeUndefined();
    });
});
