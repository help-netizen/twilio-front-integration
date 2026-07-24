'use strict';

const mockEstimates = {
    sendEstimate: jest.fn(),
};
const mockInvoices = {
    sendInvoice: jest.fn(),
};

jest.mock('../backend/src/services/estimatesService', () => mockEstimates);
jest.mock('../backend/src/services/invoicesService', () => mockInvoices);
jest.mock('../backend/src/db/chatgptMcpQueries', () => ({}));

const permissions = require('../backend/src/services/chatgptMcpPermissions');
const registry = require('../backend/src/services/agentSkillsMcpRegistry');
const authorization = require('../backend/src/services/mcpToolAuthorization');
const responseMapper = require('../backend/src/services/crmMcpResponse');
const { validateArguments } = require('../backend/src/services/crmMcpSchemaValidator');
const writeService = require('../backend/src/services/chatgptMcpWriteService');

const COMPANY = '00000000-0000-4000-8000-00000000000a';
const ACTOR = '10000000-0000-4000-8000-00000000000a';
const CONTEXT = Object.freeze({
    companyId: COMPANY,
    actorId: ACTOR,
    actorName: 'Avatar of Morgan A',
    actorEmail: 'chatgpt-agent@albusto.invalid',
    bindingId: '20000000-0000-4000-8000-00000000000a',
});

function transactionClient({
    documentId = 41,
    contactId = 51,
    email = 'primary@example.test',
    phone = '+16175550199',
    replay = null,
} = {}) {
    return {
        query: jest.fn(async (sql) => {
            if (/INSERT INTO mcp_tool_idempotency/i.test(sql)) {
                return replay
                    ? { rows: [], rowCount: 0 }
                    : { rows: [{ id: 71 }], rowCount: 1 };
            }
            if (/SELECT id, argument_hash, state, safe_result/i.test(sql)) {
                return {
                    rows: [{
                        id: 71,
                        argument_hash: replay.hash,
                        state: 'succeeded',
                        safe_result: replay.result,
                    }],
                    rowCount: 1,
                };
            }
            if (/FROM (estimates|invoices)/i.test(sql) && /contact_id/i.test(sql)) {
                return documentId == null
                    ? { rows: [], rowCount: 0 }
                    : { rows: [{ id: documentId, contact_id: contactId }], rowCount: 1 };
            }
            if (/FROM contacts c/i.test(sql)) {
                return contactId == null
                    ? { rows: [], rowCount: 0 }
                    : {
                        rows: [{
                            id: contactId,
                            primary_email: email,
                            primary_phone: phone,
                        }],
                        rowCount: 1,
                    };
            }
            return { rows: [], rowCount: 1 };
        }),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockEstimates.sendEstimate.mockResolvedValue({ id: 41, status: 'sent' });
    mockInvoices.sendInvoice.mockResolvedValue({ id: 42, status: 'sent' });
});

describe('CHATGPT-CRM-MCP S3 send descriptors and consent gates', () => {
    test('registers exactly two strict W tools with independent send scope and permissions', () => {
        expect(permissions.SEND_BUNDLE_VERSION).toBe(4);
        expect(permissions.SEND_TOOL_NAMES).toEqual([
            'svc.send_estimate',
            'svc.send_invoice',
        ]);
        const expectedPermissions = {
            'svc.send_estimate': 'estimates.send',
            'svc.send_invoice': 'invoices.send',
        };
        for (const [name, businessPermission] of Object.entries(expectedPermissions)) {
            const tool = registry.getTool(name);
            expect(tool).toMatchObject({
                kind: 'write',
                requiresConfirmation: true,
                confirmationClass: 'W',
                destructiveHint: false,
                requiredOAuthScopes: [permissions.SEND_SCOPE],
                requiredPermissions: expect.arrayContaining([
                    businessPermission,
                    `mcp.tool.${name}`,
                ]),
                inputSchema: {
                    type: 'object',
                    additionalProperties: false,
                },
            });
            expect(tool.inputSchema.properties).not.toHaveProperty('recipient');
            expect(tool.inputSchema.properties).not.toHaveProperty('company_id');
        }
    });

    test('writes consent and write scope alone expose 31 tools, send consent plus send scope exposes 33', () => {
        const tools = registry.listTools({
            includeDispatcher: true,
            dispatcherOnly: true,
        });
        expect(tools).toHaveLength(33);
        const internalGrants = [...permissions.S1_GRANTS, ...permissions.S2_WRITE_GRANTS];
        expect(authorization.filterTools(
            tools,
            internalGrants,
            [permissions.READ_SCOPE, permissions.WRITE_SCOPE, permissions.SEND_SCOPE]
        )).toHaveLength(31);
        expect(authorization.filterTools(
            tools,
            [...internalGrants, ...permissions.S3_SEND_GRANTS],
            [permissions.READ_SCOPE, permissions.WRITE_SCOPE]
        )).toHaveLength(31);
        expect(authorization.filterTools(
            tools,
            [...internalGrants, ...permissions.S3_SEND_GRANTS],
            [permissions.READ_SCOPE, permissions.WRITE_SCOPE, permissions.SEND_SCOPE]
        )).toHaveLength(33);
    });

    test.each([
        ['svc.send_estimate', { estimate_id: 1, channel: 'email', recipient: 'attacker@example.test' }],
        ['svc.send_invoice', { invoice_id: 1, channel: 'sms', recipient: '+16175550000' }],
        ['svc.send_estimate', { estimate_id: 1, channel: 'email', message: 'x'.repeat(501) }],
        ['svc.send_estimate', { estimate_id: 1, channel: 'email', message: null }],
        ['svc.send_invoice', { invoice_id: 1, channel: 'fax' }],
    ])('%s rejects recipient injection and invalid bounded input %#', (name, args) => {
        expect(() => validateArguments(registry.getTool(name), args))
            .toThrow(expect.objectContaining({ mcpCode: 'invalid_request' }));
    });
});

describe('CHATGPT-CRM-MCP S3 canonical dispatch and recipient invariant', () => {
    test('send_estimate resolves the primary Contact email and stamps the AI CRM actor', async () => {
        const tx = transactionClient({
            documentId: 41,
            contactId: 51,
            email: 'primary@example.test',
        });
        const result = await writeService.execute(
            'sendEstimate',
            'svc.send_estimate',
            CONTEXT,
            { estimate_id: 41, channel: 'email', message: 'Please review.' },
            tx
        );

        expect(mockEstimates.sendEstimate).toHaveBeenCalledWith(
            COMPANY,
            ACTOR,
            41,
            {
                channel: 'email',
                recipient: 'primary@example.test',
                message: 'Please review.',
                userEmail: CONTEXT.actorEmail,
                noteActor: {
                    id: ACTOR,
                    name: CONTEXT.actorName,
                },
            },
            tx
        );
        expect(result).toEqual({
            sent: true,
            estimate_id: 41,
            status: 'sent',
            channel: 'email',
            recipient_source: 'linked_contact',
        });
        const contactSql = tx.query.mock.calls
            .map(([sql]) => sql)
            .find((sql) => /FROM contacts c/i.test(sql));
        expect(contactSql).toContain('ce_contact.company_id = $2');
        expect(contactSql).toContain('c.id = $1 AND c.company_id = $2');
        expect(contactSql).toContain('ce.is_primary = true');
        expect(contactSql).toContain('ORDER BY ce.is_primary DESC');
    });

    test('send_invoice resolves the Contact phone and defaults include_payment_link to true', async () => {
        const tx = transactionClient({
            documentId: 42,
            contactId: 52,
            phone: '+16175550200',
        });
        const result = await writeService.execute(
            'sendInvoice',
            'svc.send_invoice',
            CONTEXT,
            { invoice_id: 42, channel: 'sms' },
            tx
        );

        expect(mockInvoices.sendInvoice).toHaveBeenCalledWith(
            COMPANY,
            ACTOR,
            42,
            expect.objectContaining({
                channel: 'sms',
                recipient: '+16175550200',
                includePaymentLink: true,
                noteActor: { id: ACTOR, name: CONTEXT.actorName },
            }),
            tx
        );
        expect(result).toMatchObject({
            sent: true,
            invoice_id: 42,
            include_payment_link: true,
            recipient_source: 'linked_contact',
        });
    });

    test.each([
        ['sendEstimate', 'svc.send_estimate', { estimate_id: 41, channel: 'email' }, {
            email: null,
        }],
        ['sendInvoice', 'svc.send_invoice', { invoice_id: 42, channel: 'sms' }, {
            phone: null,
        }],
    ])('%s fails NO_RECIPIENT before invoking the canonical send service', async (
        handler,
        toolName,
        args,
        clientOptions
    ) => {
        const tx = transactionClient(clientOptions);
        await expect(writeService.execute(handler, toolName, CONTEXT, args, tx))
            .rejects.toMatchObject({ code: 'NO_RECIPIENT', httpStatus: 422 });
        expect(mockEstimates.sendEstimate).not.toHaveBeenCalled();
        expect(mockInvoices.sendInvoice).not.toHaveBeenCalled();
    });

    test('foreign document is not_found before recipient lookup or provider dispatch', async () => {
        const tx = transactionClient({ documentId: null });
        await expect(writeService.execute(
            'sendEstimate',
            'svc.send_estimate',
            CONTEXT,
            { estimate_id: 999, channel: 'email' },
            tx
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(mockEstimates.sendEstimate).not.toHaveBeenCalled();
        expect(mockInvoices.sendInvoice).not.toHaveBeenCalled();
    });

    test('idempotent replay returns the original safe result and never dispatches again', async () => {
        const args = { invoice_id: 42, channel: 'email', message: 'Invoice attached.' };
        const stored = {
            sent: true,
            invoice_id: 42,
            status: 'sent',
            channel: 'email',
            recipient_source: 'linked_contact',
            include_payment_link: true,
        };
        const tx = transactionClient({
            replay: {
                hash: writeService.argumentHash(args),
                result: stored,
            },
        });
        await expect(writeService.execute(
            'sendInvoice',
            'svc.send_invoice',
            CONTEXT,
            args,
            tx
        )).resolves.toEqual(stored);
        expect(mockInvoices.sendInvoice).not.toHaveBeenCalled();
        expect(tx.query.mock.calls.some(([sql]) => /FROM invoices/i.test(sql))).toBe(false);
    });

    test('MAILBOX_NOT_CONNECTED remains a safe, understandable MCP error', async () => {
        mockEstimates.sendEstimate.mockRejectedValueOnce(Object.assign(
            new Error('Connect Google Email to send.'),
            {
                name: 'EstimatesServiceError',
                code: 'MAILBOX_NOT_CONNECTED',
                httpStatus: 409,
            }
        ));
        const tx = transactionClient();
        let error;
        try {
            await writeService.execute(
                'sendEstimate',
                'svc.send_estimate',
                CONTEXT,
                { estimate_id: 41, channel: 'email' },
                tx
            );
        } catch (err) {
            error = err;
        }
        expect(error).toMatchObject({
            code: 'MAILBOX_NOT_CONNECTED',
            httpStatus: 409,
        });
        expect(responseMapper.mapError(error)).toEqual({
            code: 'invalid_request',
            message: 'Connect Google Email to send.',
            details: { crm_code: 'MAILBOX_NOT_CONNECTED' },
        });
    });
});
