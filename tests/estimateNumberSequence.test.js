/**
 * EST-DUP-001 — the estimate number is keyed on the LEAD ("ESTIMATE L-<leadSerial>-<seq>"),
 * so the sequence must be counted per-LEAD (across all of that customer's jobs). The old code
 * scoped the sequence to job_id, so a repeat customer's second job restarted the sequence at 1
 * and produced a duplicate number → uq_estimates_number_company violation → the estimate save
 * failed silently (buttons flicker, nothing saves). These tests pin the scope to the lead.
 */

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

describe('nextEstimateSequence scope (EST-DUP-001)', () => {
    test('a job WITH a lead counts across the whole lead, never just that job', async () => {
        const client = mockClient(3);
        const seq = await estimatesQueries.nextEstimateSequence('co', { jobId: 9, leadId: 5 }, client);

        expect(seq).toBe(3);
        expect(client.calls).toHaveLength(1);
        // Lead-scoped: matches the L-<leadSerial>- number space, across all the lead's jobs.
        expect(client.calls[0].sql).toContain('lead_id = $2');
        expect(client.calls[0].sql).not.toContain('job_id = $2');
        expect(client.calls[0].params).toEqual(['co', 5]);
    });

    test('a pure lead (no job) stays lead-scoped', async () => {
        const client = mockClient(2);
        await estimatesQueries.nextEstimateSequence('co', { leadId: 5 }, client);

        expect(client.calls[0].sql).toContain('lead_id = $2');
        expect(client.calls[0].params).toEqual(['co', 5]);
    });

    test('a job with NO lead falls back to a job scope keyed on lead_id IS NULL', async () => {
        const client = mockClient(1);
        await estimatesQueries.nextEstimateSequence('co', { jobId: 9, leadId: null }, client);

        expect(client.calls[0].sql).toContain('job_id = $2 AND lead_id IS NULL');
        expect(client.calls[0].params).toEqual(['co', 9]);
    });

    test('buildEstimateNumber is lead-keyed — uniqueness depends on the per-lead sequence', () => {
        expect(estimatesQueries.buildEstimateNumber({ leadSerialId: 53, sequence: 1 })).toBe('ESTIMATE L-53-1');
        expect(estimatesQueries.buildEstimateNumber({ leadSerialId: 53, sequence: 2 })).toBe('ESTIMATE L-53-2');
    });
});
