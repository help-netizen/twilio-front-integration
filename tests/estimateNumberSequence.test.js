'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const estimatesQueries = require('../backend/src/db/estimatesQueries');

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

describe('per-company Estimate number sequencing', () => {
    test('parent context queries project the per-company job and lead sequences', async () => {
        const client = mockClient();
        await estimatesQueries.getJobContext('co', 519, client);
        await estimatesQueries.getLeadContext('co', 73, client);

        expect(client.calls[0].sql).toContain('j.job_seq');
        expect(client.calls[0].sql).toContain('l.lead_seq AS lead_seq');
        expect(client.calls[1].sql).toContain('serial_id, lead_seq');
    });

    test('lead documents use lead_seq and seed from that lead’s old global-serial prefix', async () => {
        const client = mockClient(6);
        const seq = await estimatesQueries.nextEstimateSequence('co', {
            leadSeq: 31,
            legacyLeadSerialId: 1528,
            leadId: 73,
        }, client);

        expect(seq).toBe(6);
        expect(client.calls[0].params).toEqual([
            'co', 'ESTIMATE L31-%', 'ESTIMATE L-1528-%', null, 73,
        ]);
        expect(client.calls[0].sql).toContain('lead_id = $5 AND job_id IS NULL');
    });

    test('job documents use bare job_seq and seed from that job’s legacy prefix', async () => {
        const client = mockClient(4);
        await estimatesQueries.nextEstimateSequence('co', {
            jobSeq: 53,
            legacyLeadSerialId: 700,
            jobId: 519,
        }, client);

        expect(client.calls[0].params).toEqual([
            'co', 'ESTIMATE 53-%', 'ESTIMATE L-700-%', 519, null,
        ]);
        expect(client.calls[0].sql).toContain('job_id = $4');
    });

    test('the build prefix exactly matches the new LIKE prefix', async () => {
        const client = mockClient(3);
        await estimatesQueries.nextEstimateSequence('co', {
            leadSeq: 12,
            legacyLeadSerialId: 99,
            leadId: 8,
        }, client);

        const likePrefix = client.calls[0].params[1].slice(0, -1);
        expect(estimatesQueries.buildEstimateNumber({ leadSeq: 12, sequence: 3 }))
            .toBe('ESTIMATE L12-3');
        expect(estimatesQueries.buildEstimateNumber({ jobSeq: 45, sequence: 2 }))
            .toBe('ESTIMATE 45-2');
        expect(estimatesQueries.buildEstimateNumber({ leadSeq: 12, sequence: 1 })
            .startsWith(likePrefix)).toBe(true);
    });

    test('standalone estimates retain one company-scoped fallback namespace', async () => {
        const client = mockClient(4);
        const seq = await estimatesQueries.nextEstimateSequence('co', {}, client);

        expect(client.calls[0].params).toEqual([
            'co', 'ESTIMATE L0-%', 'ESTIMATE L-0-%', null, null,
        ]);
        expect(estimatesQueries.buildEstimateNumber({ sequence: seq }))
            .toBe('ESTIMATE L0-4');
    });
});
