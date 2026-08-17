'use strict';

const COMPANY_ID = '00000000-0000-0000-0000-00000000000a';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const INVOICE_ID = 77;

const mockGetInvoiceById = jest.fn();
const mockGetInvoiceItems = jest.fn();
const mockSetPublicToken = jest.fn();
const mockUpdateInvoiceStatus = jest.fn();
const mockCreateEvent = jest.fn();

jest.mock('../backend/src/db/invoicesQueries', () => ({
    getInvoiceById: (...args) => mockGetInvoiceById(...args),
    getInvoiceItems: (...args) => mockGetInvoiceItems(...args),
    setPublicToken: (...args) => mockSetPublicToken(...args),
    updateInvoiceStatus: (...args) => mockUpdateInvoiceStatus(...args),
    createEvent: (...args) => mockCreateEvent(...args),
}));
jest.mock('../backend/src/db/estimatesQueries', () => ({}));
jest.mock('../backend/src/services/paymentsService', () => ({}));
jest.mock('../backend/src/services/documentSendNoteService', () => ({
    recordDocumentSendNote: jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    logFinancialActivity: jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/services/emailMailboxService', () => ({
    getMailboxStatus: jest.fn().mockResolvedValue({ status: 'connected' }),
}));
jest.mock('../backend/src/services/emailService', () => ({
    sendEmail: jest.fn().mockResolvedValue({ provider_message_id: 'gmail-1' }),
}));
jest.mock('../backend/src/db/companyQueries', () => ({
    getCompanyById: jest.fn().mockResolvedValue({ name: 'Albusto Test' }),
}));
jest.mock('../backend/src/services/documentTemplatesService', () => ({
    resolveTemplate: jest.fn().mockResolvedValue({ key: 'invoice' }),
}));
jest.mock('../backend/src/services/documentTemplates', () => ({
    get: jest.fn(() => ({ render: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')) })),
}));

const invoicesService = require('../backend/src/services/invoicesService');

function invoiceRow(overrides = {}) {
    return {
        id: INVOICE_ID,
        company_id: COMPANY_ID,
        invoice_number: 'INVOICE L31-2',
        public_code: 'I7b2Q',
        public_token: 'existing-token',
        public_token_expires_at: '2099-01-01T00:00:00.000Z',
        status: 'draft',
        contact_id: 41,
        job_id: null,
        total: '100.00',
        amount_paid: '0.00',
        balance_due: '100.00',
        order_list: [],
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetInvoiceById.mockResolvedValue(invoiceRow());
    mockGetInvoiceItems.mockResolvedValue([]);
    mockSetPublicToken.mockResolvedValue(invoiceRow());
    mockUpdateInvoiceStatus.mockResolvedValue(invoiceRow({ status: 'sent' }));
    mockCreateEvent.mockResolvedValue({});
    process.env.PUBLIC_APP_URL = 'https://app.albusto.test';
});

test('plain invoice public-link lookup reuses a live token', async () => {
    await expect(invoicesService.ensurePublicLink(COMPANY_ID, INVOICE_ID)).resolves.toEqual({
        token: 'existing-token',
        url: 'https://app.albusto.test/i/existing-token',
    });
    expect(mockSetPublicToken).not.toHaveBeenCalled();
});

test('expired invoice public links rotate and receive an 18-month expiry', async () => {
    mockGetInvoiceById.mockResolvedValue(invoiceRow({
        public_token_expires_at: '2020-01-01T00:00:00.000Z',
    }));

    const result = await invoicesService.ensurePublicLink(COMPANY_ID, INVOICE_ID);

    expect(result.token).not.toBe('existing-token');
    expect(mockSetPublicToken).toHaveBeenCalledWith(
        INVOICE_ID,
        COMPANY_ID,
        result.token,
        null,
        18
    );
});

test('resending rotates even an unexpired invoice token before dispatch', async () => {
    await invoicesService.sendInvoice(
        COMPANY_ID,
        USER_ID,
        INVOICE_ID,
        { channel: 'email', recipient: 'client@example.com', message: 'Please review' }
    );

    const rotatedToken = mockSetPublicToken.mock.calls[0][2];
    expect(rotatedToken).not.toBe('existing-token');
    expect(mockSetPublicToken).toHaveBeenCalledWith(
        INVOICE_ID,
        COMPANY_ID,
        rotatedToken,
        null,
        18
    );
    expect(mockUpdateInvoiceStatus).toHaveBeenCalledWith(
        INVOICE_ID,
        COMPANY_ID,
        'sent',
        'sent_at'
    );
});
