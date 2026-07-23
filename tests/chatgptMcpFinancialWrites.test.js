'use strict';

const mockEstimates = {
    createEstimate: jest.fn(),
    updateEstimate: jest.fn(),
    addItems: jest.fn(),
    updateItem: jest.fn(),
    removeItem: jest.fn(),
    getEstimate: jest.fn(),
};
const mockInvoices = {
    createInvoice: jest.fn(),
    updateInvoice: jest.fn(),
    addItems: jest.fn(),
    updateItem: jest.fn(),
    removeItem: jest.fn(),
    getInvoice: jest.fn(),
};

jest.mock('../backend/src/services/estimatesService', () => mockEstimates);
jest.mock('../backend/src/services/invoicesService', () => mockInvoices);

const permissions = require('../backend/src/services/chatgptMcpPermissions');
const registry = require('../backend/src/services/agentSkillsMcpRegistry');
const { validateArguments } = require('../backend/src/services/crmMcpSchemaValidator');
const writeService = require('../backend/src/services/chatgptMcpWriteService');

const CONTEXT = Object.freeze({
    companyId: '00000000-0000-4000-8000-00000000000a',
    actorId: '10000000-0000-4000-8000-00000000000a',
    bindingId: '20000000-0000-4000-8000-00000000000a',
});

function client() {
    return {
        query: jest.fn(async (sql) => {
            if (/INSERT INTO mcp_tool_idempotency/i.test(sql)) {
                return { rows: [{ id: 77 }], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
        }),
    };
}

const ITEM = Object.freeze({
    name: 'Taxable part',
    description: 'OEM',
    quantity: 2,
    unit_price: 95,
    taxable: true,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockEstimates.createEstimate.mockResolvedValue({ id: 11, total: '201.40' });
    mockEstimates.updateEstimate.mockResolvedValue({ id: 11 });
    mockEstimates.addItems.mockResolvedValue({ added: 1 });
    mockEstimates.updateItem.mockResolvedValue({ id: 111 });
    mockEstimates.removeItem.mockResolvedValue({ deleted: true });
    mockEstimates.getEstimate.mockResolvedValue({ id: 11, total: '201.40', items: [] });
    mockInvoices.createInvoice.mockResolvedValue({ id: 22, total: '201.40' });
    mockInvoices.updateInvoice.mockResolvedValue({ id: 22 });
    mockInvoices.addItems.mockResolvedValue({ added: 1 });
    mockInvoices.updateItem.mockResolvedValue({ id: 222 });
    mockInvoices.removeItem.mockResolvedValue({ deleted: true });
    mockInvoices.getInvoice.mockResolvedValue({ id: 22, total: '201.40', items: [] });
});

describe('CHATGPT-CRM-MCP S2b financial write schemas', () => {
    test('registers four non-destructive W tools with the route-canonical permission pairs', () => {
        const expected = {
            'svc.create_estimate': 'estimates.create',
            'svc.update_estimate': 'estimates.create',
            'svc.create_invoice': 'invoices.create',
            'svc.update_invoice': 'invoices.create',
        };
        for (const [name, businessPermission] of Object.entries(expected)) {
            const tool = registry.getTool(name);
            expect(permissions.WRITE_TOOL_PERMISSIONS[name]).toEqual([businessPermission]);
            expect(tool).toMatchObject({
                kind: 'write',
                requiresConfirmation: true,
                confirmationClass: 'W',
                destructiveHint: false,
                requiredOAuthScopes: [permissions.WRITE_SCOPE],
                requiredPermissions: expect.arrayContaining([
                    businessPermission,
                    `mcp.tool.${name}`,
                ]),
            });
        }
    });

    test.each([
        ['svc.create_estimate', { job_id: 1, summary: 'Inspection' }],
        ['svc.update_estimate', { estimate_id: 1 }],
    ])('%s rejects every client-supplied computed total', (toolName, base) => {
        const tool = registry.getTool(toolName);
        for (const field of ['subtotal', 'total', 'tax_amount', 'discount_amount']) {
            expect(() => validateArguments(tool, {
                ...base,
                [field]: 1,
            })).toThrow(expect.objectContaining({ mcpCode: 'invalid_request' }));
        }
    });

    test.each([
        ['svc.create_invoice', { contact_id: 1 }],
        ['svc.update_invoice', { invoice_id: 1 }],
    ])('%s rejects every client-supplied computed total', (toolName, base) => {
        const tool = registry.getTool(toolName);
        for (const field of ['subtotal', 'total', 'tax_amount']) {
            expect(() => validateArguments(tool, {
                ...base,
                [field]: 1,
            })).toThrow(expect.objectContaining({ mcpCode: 'invalid_request' }));
        }
    });

    test.each([
        ['svc.create_estimate', { job_id: 1, summary: 'Inspection' }],
        ['svc.update_estimate', { estimate_id: 1 }],
        ['svc.create_invoice', { contact_id: 1 }],
        ['svc.update_invoice', { invoice_id: 1 }],
    ])('%s rejects direct status manipulation', (toolName, base) => {
        expect(() => validateArguments(registry.getTool(toolName), {
            ...base,
            status: 'sent',
        })).toThrow(expect.objectContaining({ mcpCode: 'invalid_request' }));
    });

    test('discount_amount is an Invoice source setting, never accepted inside an item', () => {
        const tool = registry.getTool('svc.create_invoice');
        expect(() => validateArguments(tool, {
            contact_id: 1,
            items: [{ ...ITEM, discount_amount: 90 }],
        })).toThrow(expect.objectContaining({ mcpCode: 'invalid_request' }));
    });

    test('items are bounded to 50 and nested item fields/types are validated', () => {
        const tool = registry.getTool('svc.create_estimate');
        expect(() => validateArguments(tool, {
            job_id: 1,
            items: Array.from({ length: 51 }, () => ITEM),
        })).toThrow(expect.objectContaining({ mcpCode: 'invalid_request' }));
        expect(() => validateArguments(tool, {
            job_id: 1,
            items: [{ name: 'Bad', quantity: 0, unit_price: 10 }],
        })).toThrow(expect.objectContaining({ mcpCode: 'invalid_request' }));
        expect(() => validateArguments(tool, {
            job_id: 1,
            items: [{ name: 'Missing quantity', unit_price: 10 }],
        })).toThrow(expect.objectContaining({ mcpCode: 'invalid_request' }));
    });
});

describe('CHATGPT-CRM-MCP S2b canonical service dispatch', () => {
    test('create tools reuse canonical services with the transaction client and idempotency claim', async () => {
        const tx = client();
        await expect(writeService.execute(
            'createEstimate',
            'svc.create_estimate',
            CONTEXT,
            { job_id: 9, items: [ITEM] },
            tx
        )).resolves.toMatchObject({ id: 11 });
        expect(mockEstimates.createEstimate).toHaveBeenCalledWith(
            CONTEXT.companyId,
            CONTEXT.actorId,
            { job_id: 9, items: [ITEM] },
            tx
        );

        await expect(writeService.execute(
            'createInvoice',
            'svc.create_invoice',
            CONTEXT,
            { contact_id: 5, items: [ITEM] },
            tx
        )).resolves.toMatchObject({ id: 22 });
        expect(mockInvoices.createInvoice).toHaveBeenCalledWith(
            CONTEXT.companyId,
            CONTEXT.actorId,
            { contact_id: 5, items: [ITEM] },
            tx
        );
        expect(tx.query.mock.calls.filter(([sql]) => (
            /INSERT INTO mcp_tool_idempotency/i.test(sql)
        ))).toHaveLength(2);
    });

    test('update tools apply scalar plus add/update/remove operations through canonical services', async () => {
        const tx = client();
        await writeService.execute(
            'updateEstimate',
            'svc.update_estimate',
            CONTEXT,
            {
                estimate_id: 11,
                tax_rate: 6,
                items_add: [ITEM],
                items_update: [{ item_id: 111, unit_price: 100 }],
                item_ids_remove: [112],
            },
            tx
        );
        expect(mockEstimates.updateEstimate).toHaveBeenCalledWith(
            CONTEXT.companyId,
            CONTEXT.actorId,
            11,
            { tax_rate: 6 },
            tx
        );
        expect(mockEstimates.addItems).toHaveBeenCalledWith(
            CONTEXT.companyId,
            11,
            CONTEXT.actorId,
            [ITEM],
            tx
        );
        expect(mockEstimates.updateItem).toHaveBeenCalledWith(
            CONTEXT.companyId,
            11,
            CONTEXT.actorId,
            111,
            { unit_price: 100 },
            tx
        );
        expect(mockEstimates.removeItem).toHaveBeenCalledWith(
            CONTEXT.companyId,
            11,
            CONTEXT.actorId,
            112,
            tx
        );

        await writeService.execute(
            'updateInvoice',
            'svc.update_invoice',
            CONTEXT,
            {
                invoice_id: 22,
                due_date: '2026-08-01',
                items_update: [{ item_id: 222, quantity: 3 }],
            },
            tx
        );
        expect(mockInvoices.updateInvoice).toHaveBeenCalledWith(
            CONTEXT.companyId,
            CONTEXT.actorId,
            22,
            { due_date: '2026-08-01' },
            tx
        );
        expect(mockInvoices.updateItem).toHaveBeenCalledWith(
            CONTEXT.companyId,
            22,
            CONTEXT.actorId,
            222,
            { quantity: 3 },
            tx
        );
    });
});
