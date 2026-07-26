'use strict';

const COMPANY_A = '00000000-0000-0000-0000-0000000000a1';
const COMPANY_B = '00000000-0000-0000-0000-0000000000b2';
const USER_ID = '10000000-0000-0000-0000-0000000000a1';

const mockEstimateQueries = {
    getEstimateById: jest.fn(),
    getEstimateItems: jest.fn(),
    getJobContext: jest.fn(),
    getLeadContext: jest.fn(),
    getContactContext: jest.fn(),
    nextEstimateSequence: jest.fn(),
    buildEstimateNumber: jest.fn(({ leadSerialId, sequence }) => `ESTIMATE L-${leadSerialId}-${sequence}`),
    createEstimate: jest.fn(),
    updateEstimate: jest.fn(),
    replaceEstimateItems: jest.fn(),
    recalculateEstimateTotals: jest.fn(),
    createEvent: jest.fn(),
    createRevision: jest.fn(),
};

const mockInvoiceQueries = {
    getInvoiceById: jest.fn(),
    getInvoiceItems: jest.fn(),
    nextInvoiceSequence: jest.fn(),
    buildInvoiceNumber: jest.fn(),
    createInvoice: jest.fn(),
    updateInvoice: jest.fn(),
    replaceInvoiceItems: jest.fn(),
    recalculateInvoiceTotals: jest.fn(),
    createEvent: jest.fn(),
    createRevision: jest.fn(),
};

jest.mock('../backend/src/db/estimatesQueries', () => mockEstimateQueries);
jest.mock('../backend/src/db/invoicesQueries', () => mockInvoiceQueries);
jest.mock('../backend/src/db/estimateItemPresetsQueries', () => ({
    findActiveIdsScoped: jest.fn().mockResolvedValue([]),
}));
jest.mock('../backend/src/services/paymentsService', () => ({}));

const estimatesService = require('../backend/src/services/estimatesService');
const invoicesService = require('../backend/src/services/invoicesService');
const {
    MAX_ORDER_LIST_ROWS,
    MAX_PART_NAME_CHARS,
    MAX_PART_NUMBER_CHARS,
} = require('../backend/src/utils/orderList');

const ESTIMATE_ID = 41;
const INVOICE_ID = 51;
const ITEMS = [{
    id: 1,
    name: 'Labor',
    quantity: 1,
    unit_price: 100,
    amount: 100,
    taxable: false,
}];

let storedEstimate;
let storedInvoice;

beforeEach(() => {
    jest.clearAllMocks();

    storedEstimate = null;
    mockEstimateQueries.getJobContext.mockResolvedValue({
        id: 12,
        lead_id: 22,
        lead_serial_id: 220,
        contact_id: 32,
    });
    mockEstimateQueries.getContactContext.mockResolvedValue({ id: 32, company_id: COMPANY_A });
    mockEstimateQueries.getLeadContext.mockResolvedValue({ id: 22, company_id: COMPANY_A });
    mockEstimateQueries.nextEstimateSequence.mockResolvedValue(1);
    mockEstimateQueries.createEstimate.mockImplementation(async (companyId, data) => {
        storedEstimate = {
            id: ESTIMATE_ID,
            company_id: companyId,
            status: 'draft',
            archived_at: null,
            approved_snapshot: null,
            ...data,
        };
        return storedEstimate;
    });
    mockEstimateQueries.getEstimateById.mockImplementation(async (companyId, id) => (
        companyId === COMPANY_A && Number(id) === ESTIMATE_ID ? storedEstimate : null
    ));
    mockEstimateQueries.updateEstimate.mockImplementation(async (id, companyId, data) => {
        if (companyId !== COMPANY_A || Number(id) !== ESTIMATE_ID) return null;
        storedEstimate = { ...storedEstimate, ...data };
        return storedEstimate;
    });
    mockEstimateQueries.getEstimateItems.mockResolvedValue(ITEMS);
    mockEstimateQueries.replaceEstimateItems.mockResolvedValue(ITEMS);
    mockEstimateQueries.recalculateEstimateTotals.mockResolvedValue({});
    mockEstimateQueries.createEvent.mockResolvedValue({});

    storedInvoice = null;
    mockInvoiceQueries.createInvoice.mockImplementation(async (companyId, data) => {
        storedInvoice = {
            id: INVOICE_ID,
            company_id: companyId,
            status: 'draft',
            ...data,
        };
        return storedInvoice;
    });
    mockInvoiceQueries.getInvoiceById.mockImplementation(async (companyId, id) => (
        companyId === COMPANY_A && Number(id) === INVOICE_ID ? storedInvoice : null
    ));
    mockInvoiceQueries.updateInvoice.mockImplementation(async (id, companyId, data) => {
        if (companyId !== COMPANY_A || Number(id) !== INVOICE_ID) return null;
        storedInvoice = { ...storedInvoice, ...data };
        return storedInvoice;
    });
    mockInvoiceQueries.getInvoiceItems.mockResolvedValue([]);
    mockInvoiceQueries.createEvent.mockResolvedValue({});
});

describe('ORDER-LIST-001 authenticated storage round trips', () => {
    test('estimate create/update normalize order_list and internal GET returns it', async () => {
        const created = await estimatesService.createEstimate(COMPANY_A, USER_ID, {
            job_id: 12,
            items: ITEMS,
            order_list: [{
                part_number: `  ${'P'.repeat(MAX_PART_NUMBER_CHARS + 10)}  `,
                part_name: `  ${'N'.repeat(MAX_PART_NAME_CHARS + 10)}  `,
                quantity: '2.5',
                price: 999,
            }],
        });

        expect(created.order_list).toEqual([{
            part_number: 'P'.repeat(MAX_PART_NUMBER_CHARS),
            part_name: 'N'.repeat(MAX_PART_NAME_CHARS),
            quantity: 2.5,
        }]);
        expect(mockEstimateQueries.createEstimate).toHaveBeenCalledWith(
            COMPANY_A,
            expect.objectContaining({ order_list: created.order_list }),
            null
        );

        const updated = await estimatesService.updateEstimate(
            COMPANY_A,
            USER_ID,
            ESTIMATE_ID,
            {
                order_list: [{
                    part_number: '  WH-100  ',
                    part_name: '  Drain   pump ',
                    quantity: 3,
                }],
            }
        );
        expect(updated.order_list).toEqual([{
            part_number: 'WH-100',
            part_name: 'Drain pump',
            quantity: 3,
        }]);
        await expect(estimatesService.getEstimate(COMPANY_A, ESTIMATE_ID))
            .resolves.toMatchObject({ order_list: updated.order_list });
    });

    test('invoice create/update normalize order_list and internal GET returns it', async () => {
        const created = await invoicesService.createInvoice(COMPANY_A, USER_ID, {
            contact_id: 32,
            invoice_number: 'INVOICE 51',
            due_date: '2026-08-15',
            order_list: [{
                part_number: '  P-51 ',
                part_name: ' Inlet   valve ',
                quantity: '1',
            }],
        });

        expect(created.order_list).toEqual([{
            part_number: 'P-51',
            part_name: 'Inlet valve',
            quantity: 1,
        }]);
        expect(mockInvoiceQueries.createInvoice).toHaveBeenCalledWith(
            COMPANY_A,
            expect.objectContaining({ order_list: created.order_list }),
            null
        );

        const updated = await invoicesService.updateInvoice(
            COMPANY_A,
            USER_ID,
            INVOICE_ID,
            {
                order_list: [{
                    part_number: 'P-52',
                    part_name: 'Control board',
                    quantity: 2,
                }],
            }
        );
        expect(updated.order_list).toEqual([{
            part_number: 'P-52',
            part_name: 'Control board',
            quantity: 2,
        }]);
        await expect(invoicesService.getInvoice(COMPANY_A, INVOICE_ID))
            .resolves.toMatchObject({ order_list: updated.order_list });
    });
});

describe('ORDER-LIST-001 validation and tenant guards', () => {
    test.each([
        [{ part_number: '', part_name: 'Pump', quantity: 1 }, 'part_number'],
        [{ part_number: 'P-1', part_name: '', quantity: 1 }, 'part_name'],
        [{ part_number: 'P-1', part_name: 'Pump', quantity: 0 }, 'positive number'],
        [{ part_number: 'P-1', part_name: 'Pump', quantity: 'NaN' }, 'positive number'],
    ])('invalid order_list row %# is rejected before an estimate write', async (row, message) => {
        storedEstimate = {
            id: ESTIMATE_ID,
            company_id: COMPANY_A,
            status: 'draft',
            archived_at: null,
            summary: 'Existing',
        };

        await expect(estimatesService.updateEstimate(
            COMPANY_A,
            USER_ID,
            ESTIMATE_ID,
            { order_list: [row] }
        )).rejects.toMatchObject({ code: 'VALIDATION', httpStatus: 400 });
        await expect(estimatesService.updateEstimate(
            COMPANY_A,
            USER_ID,
            ESTIMATE_ID,
            { order_list: [row] }
        )).rejects.toThrow(message);
        expect(mockEstimateQueries.updateEstimate).not.toHaveBeenCalled();
    });

    test('the 60-row cap is enforced for both estimate and invoice writes', async () => {
        const tooMany = Array.from({ length: MAX_ORDER_LIST_ROWS + 1 }, (_, index) => ({
            part_number: `P-${index}`,
            part_name: `Part ${index}`,
            quantity: 1,
        }));
        storedEstimate = {
            id: ESTIMATE_ID,
            company_id: COMPANY_A,
            status: 'draft',
            archived_at: null,
            summary: 'Existing',
        };
        storedInvoice = {
            id: INVOICE_ID,
            company_id: COMPANY_A,
            status: 'draft',
            contact_id: 32,
        };

        await expect(estimatesService.updateEstimate(
            COMPANY_A, USER_ID, ESTIMATE_ID, { order_list: tooMany }
        )).rejects.toMatchObject({ code: 'VALIDATION', httpStatus: 400 });
        await expect(invoicesService.updateInvoice(
            COMPANY_A, USER_ID, INVOICE_ID, { order_list: tooMany }
        )).rejects.toMatchObject({ code: 'VALIDATION', httpStatus: 400 });
        expect(mockEstimateQueries.updateEstimate).not.toHaveBeenCalled();
        expect(mockInvoiceQueries.updateInvoice).not.toHaveBeenCalled();
    });

    test('T-foreign: estimate and invoice updates 404 and leave owned rows unchanged', async () => {
        storedEstimate = {
            id: ESTIMATE_ID,
            company_id: COMPANY_A,
            status: 'draft',
            archived_at: null,
            summary: 'Existing',
            order_list: [{ part_number: 'A', part_name: 'Owned estimate part', quantity: 1 }],
        };
        storedInvoice = {
            id: INVOICE_ID,
            company_id: COMPANY_A,
            status: 'draft',
            contact_id: 32,
            order_list: [{ part_number: 'B', part_name: 'Owned invoice part', quantity: 1 }],
        };
        const beforeEstimate = structuredClone(storedEstimate);
        const beforeInvoice = structuredClone(storedInvoice);

        await expect(estimatesService.updateEstimate(
            COMPANY_B,
            USER_ID,
            ESTIMATE_ID,
            { order_list: [{ part_number: 'X', part_name: 'Foreign', quantity: 1 }] }
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        await expect(invoicesService.updateInvoice(
            COMPANY_B,
            USER_ID,
            INVOICE_ID,
            { order_list: [{ part_number: 'X', part_name: 'Foreign', quantity: 1 }] }
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        expect(storedEstimate).toEqual(beforeEstimate);
        expect(storedInvoice).toEqual(beforeInvoice);
        expect(mockEstimateQueries.updateEstimate).not.toHaveBeenCalled();
        expect(mockInvoiceQueries.updateInvoice).not.toHaveBeenCalled();
    });
});
