/**
 * EST-DUP-001 — the estimate number is "ESTIMATE L-<leadSerialId>-<seq>", where leadSerialId is
 * derived from a lead serial, a lead id, or a job id (fallback). Those id spaces can numerically
 * collide (job #383221: an estimate "L-1528-1" already existed from job id 1528 with no lead, and
 * a new estimate for a lead whose SERIAL is 1528 minted the same "L-1528-1"). The sequence was
 * counted by lead_id/job_id, so it never saw the colliding row → duplicate number →
 * uq_estimates_number_company violation → the save failed silently (buttons flicker, nothing saves).
 *
 * Fix: count the sequence by the number PREFIX itself, so it is unique across whatever produced the
 * key, and buildEstimateNumber shares that exact prefix.
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

describe('nextEstimateSequence (EST-DUP-001)', () => {
    test('counts by the estimate-number prefix, not lead_id/job_id', async () => {
        const client = mockClient(2);
        const seq = await estimatesQueries.nextEstimateSequence('co', { leadSerialId: 1528 }, client);

        expect(seq).toBe(2);
        expect(client.calls).toHaveLength(1);
        expect(client.calls[0].sql).toContain('estimate_number LIKE $2');
        expect(client.calls[0].sql).not.toContain('job_id = $2');
        expect(client.calls[0].sql).not.toContain('lead_id = $2');
        expect(client.calls[0].params).toEqual(['co', 'ESTIMATE L-1528-%']);
    });

    test('the LIKE pattern is exactly buildEstimateNumber’s prefix + % (collision guard)', async () => {
        const client = mockClient(3);
        await estimatesQueries.nextEstimateSequence('co', { leadSerialId: 53 }, client);

        const likeParam = client.calls[0].params[1];
        const number = estimatesQueries.buildEstimateNumber({ leadSerialId: 53, sequence: 1 });
        expect(likeParam).toBe('ESTIMATE L-53-%');
        // Any minted number for this key must be captured by the sequence's LIKE prefix.
        expect(number.startsWith(likeParam.slice(0, -1))).toBe(true);
    });

    test('buildEstimateNumber keeps the L-<serial>-<seq> shape', () => {
        expect(estimatesQueries.buildEstimateNumber({ leadSerialId: 1528, sequence: 2 })).toBe('ESTIMATE L-1528-2');
        expect(estimatesQueries.buildEstimateNumber({ leadSerialId: 53, sequence: 1 })).toBe('ESTIMATE L-53-1');
    });
});
