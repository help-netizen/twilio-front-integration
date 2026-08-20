'use strict';

const {
    parseArgs,
    runAudit,
} = require('../scripts/audit-invoice-removal-data');

const COMPANY = '00000000-0000-4000-8000-000000000070';

function databaseWith(query) {
    const client = { query, release: jest.fn() };
    return {
        client,
        database: { getClient: jest.fn().mockResolvedValue(client) },
    };
}

describe('invoice removal audit CLI', () => {
    it('is dry-run by default and requires an explicit company', () => {
        expect(parseArgs(['--company-id', COMPANY])).toEqual({
            companyId: COMPANY,
            apply: false,
        });
        expect(parseArgs(['--company-id', COMPANY, '--apply'])).toEqual({
            companyId: COMPANY,
            apply: true,
        });
        expect(() => parseArgs([])).toThrow('--company-id is required');
    });

    it('dry-run executes no UPDATE and rolls the read transaction back', async () => {
        const audit = { linked_without_origin: [71] };
        const query = jest.fn(async sql => {
            if (sql.includes('WITH owned_invoices')) return { rows: [audit] };
            return { rows: [], rowCount: 0 };
        });
        const { client, database } = databaseWith(query);

        await expect(runAudit({ companyId: COMPANY }, database)).resolves.toEqual({
            mode: 'dry-run',
            company_id: COMPANY,
            before: audit,
            repairs: null,
            after: audit,
        });

        const sql = query.mock.calls.map(([text]) => text).join('\n');
        expect(sql).not.toContain('UPDATE payment_transactions');
        expect(sql).not.toContain('UPDATE stripe_payment_sessions');
        expect(query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('--apply runs only tenant-parameterized repairs and commits', async () => {
        const before = { payments_linked_to_terminal_invoice: [72] };
        const after = { payments_linked_to_terminal_invoice: [] };
        let auditCount = 0;
        const query = jest.fn(async (sql, params) => {
            if (sql.includes('WITH owned_invoices')) {
                auditCount += 1;
                return { rows: [auditCount === 1 ? before : after] };
            }
            if (sql.includes('UPDATE payment_transactions pt')) {
                expect(params).toEqual([COMPANY]);
                return { rows: [{ id: 72 }], rowCount: 1 };
            }
            if (sql.includes('UPDATE stripe_payment_sessions s')) {
                expect(params).toEqual([COMPANY]);
                return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
        });
        const { client, database } = databaseWith(query);

        const result = await runAudit({ companyId: COMPANY, apply: true }, database);

        expect(result.mode).toBe('apply');
        expect(result.before).toBe(before);
        expect(result.after).toBe(after);
        expect(result.repairs).toEqual({
            linked_rows_normalized: 1,
            terminal_payments_detached: 1,
            terminal_sessions_detached: 0,
        });
        expect(query.mock.calls.at(-1)[0]).toBe('COMMIT');
        expect(client.release).toHaveBeenCalledTimes(1);
    });
});
