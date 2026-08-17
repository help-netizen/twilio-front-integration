'use strict';

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

describe('per-company Invoice number sequencing', () => {
    test('lead documents use lead_seq and seed from the old lead prefix', async () => {
        const client = mockClient(5);
        const seq = await invoicesQueries.nextInvoiceSequence('co', {
            leadSeq: 31,
            legacyLeadSerialId: 1528,
            leadId: 73,
        }, client);

        expect(seq).toBe(5);
        expect(client.calls[0].params).toEqual([
            'co', 'INVOICE L31-%', 'INVOICE L-1528-%', null, 73,
        ]);
    });

    test('job documents use bare job_seq and seed from the old job namespace', async () => {
        const client = mockClient(3);
        await invoicesQueries.nextInvoiceSequence('co', {
            jobSeq: 42,
            legacyJobId: 1528,
            jobId: 1528,
        }, client);

        expect(client.calls[0].params).toEqual([
            'co', 'INVOICE 42-%', 'INVOICE J-1528-%', 1528, null,
        ]);
    });

    test('build-prefix and LIKE-prefix invariants cover lead and job forms', async () => {
        const client = mockClient();
        await invoicesQueries.nextInvoiceSequence('co', {
            jobSeq: 42,
            legacyJobId: 1528,
            jobId: 1528,
        }, client);

        expect(invoicesQueries.buildInvoiceNumber({ leadSeq: 31, sequence: 2 }))
            .toBe('INVOICE L31-2');
        expect(invoicesQueries.buildInvoiceNumber({ jobSeq: 42, sequence: 1 }))
            .toBe('INVOICE 42-1');
        expect(invoicesQueries.buildInvoiceNumber({ jobSeq: 42, sequence: 8 })
            .startsWith(client.calls[0].params[1].slice(0, -1))).toBe(true);
    });

    test('copied conversion numbers participate through the same trailing-sequence MAX', async () => {
        const client = mockClient(7);
        await expect(invoicesQueries.nextInvoiceSequence('co', {
            leadSeq: 31,
            legacyLeadSerialId: 1528,
            leadId: 73,
        }, client)).resolves.toBe(7);

        expect(client.calls[0].sql)
            .toContain("MAX(CAST(substring(invoice_number FROM '[0-9]+$') AS INTEGER))");
    });
});
