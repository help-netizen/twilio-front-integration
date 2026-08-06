/**
 * EST-DUP-001 (invoice mirror) — invoice numbers use the same "L-<leadSerial>-" / "J-<jobId>-"
 * scheme as estimates, and the sequence was counted by job_id/lead_id while the number is keyed on
 * the lead serial / job id. Same collision class → duplicate invoice number → save failure. Fix:
 * count the sequence by the number PREFIX itself, matching buildInvoiceNumber.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const invoicesQueries = require('../backend/src/db/invoicesQueries');

function mockClient(nextSequence = 1) {
    const calls = [];
    return {
        calls,
        query: async (sql, params) => {
            calls.push({ sql, params });
            return { rows: [{ next_sequence: String(nextSequence) }] };
        },
    };
}

describe('nextInvoiceSequence (EST-DUP-001 mirror)', () => {
    test('a lead-linked invoice counts by the L- prefix (max trailing seq)', async () => {
        const client = mockClient(2);
        const seq = await invoicesQueries.nextInvoiceSequence('co', { leadSerialId: 1528, jobId: 1632 }, client);

        expect(seq).toBe(2);
        expect(client.calls[0].sql).toContain('invoice_number LIKE $2');
        expect(client.calls[0].sql).not.toContain('job_id = $2');
        expect(client.calls[0].params).toEqual(['co', 'INVOICE L-1528-%']);
    });

    test('a job-only invoice (no lead) counts by the J- prefix', async () => {
        const client = mockClient(1);
        await invoicesQueries.nextInvoiceSequence('co', { leadSerialId: null, jobId: 1528 }, client);

        expect(client.calls[0].params).toEqual(['co', 'INVOICE J-1528-%']);
    });

    test('the LIKE prefix matches buildInvoiceNumber for both L- and J- forms', () => {
        expect(invoicesQueries.buildInvoiceNumber({ leadSerialId: 1528, sequence: 2 })).toBe('INVOICE L-1528-2');
        expect(invoicesQueries.buildInvoiceNumber({ leadSerialId: null, jobId: 1528, sequence: 1 })).toBe('INVOICE J-1528-1');
    });
});
