'use strict';

// OB-72: the server must let a dispatcher collect on a DRAFT invoice (owner
// directive 2026-08-16 — accepted on the spot, no reason to email first).
// void/refunded/paid stay blocked; a job link is still required.
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../backend/src/services/paymentsService', () => ({
    recordManualPayment: jest.fn().mockResolvedValue({ id: 99, amount: 50 }),
}));

const invoicesService = require('../backend/src/services/invoicesService');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const paymentsService = require('../backend/src/services/paymentsService');

const CO = '00000000-0000-0000-0000-00000000000a';
const USER = 7;
const draftInvoice = (status) => ({
    id: 1, company_id: CO, status, job_id: 5, contact_id: null, balance_due: '100.00',
});

beforeEach(() => jest.clearAllMocks());

test('OB-72: a DRAFT invoice accepts an offline payment', async () => {
    jest.spyOn(invoicesQueries, 'getInvoiceById').mockResolvedValue(draftInvoice('draft'));
    const res = await invoicesService.recordOfflinePayment(
        CO, USER, 1, { amount: 50, payment_method: 'cash' }, null,
    );
    expect(res).toMatchObject({ id: 99 });
    expect(paymentsService.recordManualPayment).toHaveBeenCalledTimes(1);
});

test('OB-72: void is still rejected (nothing to pay)', async () => {
    jest.spyOn(invoicesQueries, 'getInvoiceById').mockResolvedValue(draftInvoice('void'));
    await expect(
        invoicesService.recordOfflinePayment(CO, USER, 1, { amount: 50, payment_method: 'cash' }, null),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    expect(paymentsService.recordManualPayment).not.toHaveBeenCalled();
});

test('OB-72: an unlinked invoice (no job) is still rejected', async () => {
    jest.spyOn(invoicesQueries, 'getInvoiceById').mockResolvedValue({ ...draftInvoice('draft'), job_id: null });
    await expect(
        invoicesService.recordOfflinePayment(CO, USER, 1, { amount: 50, payment_method: 'cash' }, null),
    ).rejects.toMatchObject({ code: 'JOB_REQUIRED' });
});
