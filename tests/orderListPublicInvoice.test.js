'use strict';

jest.mock('../backend/src/services/stripeConnectProvider', () => ({}));
jest.mock('../backend/src/db/stripePaymentsQueries', () => ({
    getAccountByCompany: jest.fn(),
}));
jest.mock('../backend/src/db/paymentsQueries', () => ({}));
jest.mock('../backend/src/services/paymentsService', () => ({}));
jest.mock('../backend/src/services/invoicesService', () => ({}));
jest.mock('../backend/src/db/invoicesQueries', () => ({
    getInvoiceByPublicToken: jest.fn(),
}));
jest.mock('../backend/src/services/marketplaceService', () => ({}));
jest.mock('../backend/src/db/marketplaceQueries', () => ({}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn() }));
jest.mock('../backend/src/db/companyQueries', () => ({
    getCompanyById: jest.fn(),
}));
jest.mock('../backend/src/services/technicianProfilesService', () => ({
    getTechnicianForInvoice: jest.fn(),
}));

const stripeQueries = require('../backend/src/db/stripePaymentsQueries');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const companyQueries = require('../backend/src/db/companyQueries');
const technicianProfilesService = require('../backend/src/services/technicianProfilesService');
const stripePaymentsService = require('../backend/src/services/stripePaymentsService');

const SECRET_PART = 'PUBLIC-INVOICE-ORDER-LIST-SECRET';

beforeEach(() => {
    jest.clearAllMocks();
    invoicesQueries.getInvoiceByPublicToken.mockResolvedValue({
        id: 91,
        company_id: 'company-a',
        invoice_number: 'INVOICE 91',
        status: 'sent',
        total: '100',
        amount_paid: '30',
        balance_due: '100',
        currency: 'USD',
        order_list: [{
            part_number: SECRET_PART,
            part_name: 'Internal-only compressor',
            quantity: 1,
        }],
    });
    stripeQueries.getAccountByCompany.mockResolvedValue({
        status: 'connected_ready',
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { card_payments: 'active' },
        requirements_past_due: [],
    });
    companyQueries.getCompanyById.mockResolvedValue({ name: 'Albusto Test' });
    technicianProfilesService.getTechnicianForInvoice.mockResolvedValue(null);
});

test('ORDER-LIST-001 public invoice pay-info excludes order_list', async () => {
    const result = await stripePaymentsService.getPublicPayInfo('invoice_token_123');

    expect(result).toMatchObject({
        invoice_number: 'INVOICE 91',
        balance_due: 70,
        company_name: 'Albusto Test',
    });
    expect(result).not.toHaveProperty('order_list');
    expect(JSON.stringify(result)).not.toContain(SECRET_PART);
});
