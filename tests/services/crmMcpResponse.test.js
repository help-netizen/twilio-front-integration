const { CrmServiceError } = require('../../backend/src/services/crmErrors');
const response = require('../../backend/src/services/crmMcpResponse');

describe('crmMcpResponse', () => {
    test('maps CRM bad request to invalid_request', () => {
        const body = response.error('crm.get_sales_list', new CrmServiceError('BAD_REQUEST', 'Unsupported CRM list', 400), { requestId: 'req-1' });

        expect(body.error).toMatchObject({
            code: 'invalid_request',
            message: 'Unsupported CRM list',
            details: { crm_code: 'BAD_REQUEST' },
        });
        expect(body.meta.request_id).toBe('req-1');
    });

    test('maps CRM not found to not_found', () => {
        const body = response.error('crm.get_deal', new CrmServiceError('NOT_FOUND', 'Deal not found', 404), {});

        expect(body.error.code).toBe('not_found');
        expect(body.error.details.crm_code).toBe('NOT_FOUND');
    });

    test('does not leak unexpected error internals', () => {
        const err = new Error('SELECT * FROM secrets WHERE token = abc');
        err.stack = 'stack with password';

        const body = response.error('crm.get_deal', err, {});

        expect(body.error).toEqual({
            code: 'internal_error',
            message: 'Unexpected CRM MCP error',
            details: {},
        });
    });

    test('sanitizes secret-like keys and nested object values in error details', () => {
        const err = response.mcpError('invalid_request', 'Bad request', {
            token: 'secret-token',
            safe: 'visible',
            items: [
                'plain',
                { password: 'hidden', nested: 'object' },
            ],
            nested: { oauth_token: 'hidden' },
        });

        const body = response.error('crm.get_sales_list', err, { requestId: 'req-2' });

        expect(body.error.details).toEqual({
            safe: 'visible',
            items: ['plain', '[redacted]'],
            nested: '[redacted]',
        });
        expect(JSON.stringify(body)).not.toContain('secret-token');
        expect(JSON.stringify(body)).not.toContain('password');
        expect(JSON.stringify(body)).not.toContain('oauth_token');
    });
});
