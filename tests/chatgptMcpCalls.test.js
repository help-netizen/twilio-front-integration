'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/chatgptMcpQueries');

const COMPANY = '00000000-0000-0000-0000-000000000111';

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({
        rows: [{
            id: 7,
            direction: 'inbound',
            status: 'completed',
            started_at: '2026-07-22T14:00:00.000Z',
            answered_at: '2026-07-22T14:00:02.000Z',
            ended_at: '2026-07-22T14:03:00.000Z',
            duration_sec: 178,
            from_number: '+16175550101',
            to_number: '+16175550202',
            contact_id: 9,
            contact_name: 'Caller',
            answered_by: 'ai',
            _total: 3,
        }],
    });
});

describe('CHATGPT-CRM-MCP S1.1 call-history query', () => {
    test('defaults to 20 rows and a 14-day company-local window', async () => {
        await expect(queries.listCalls(COMPANY)).resolves.toEqual({
            rows: [expect.objectContaining({ id: 7, answered_by: 'ai' })],
            total: 3,
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual([COMPANY, null, null, null, null, 20]);
        expect(sql).toContain('WHERE c.company_id = tenant.id');
        expect(sql).toContain("COALESCE(tenant.timezone, 'America/New_York')");
        expect(sql).toContain('::date - 13');
        expect(sql).toContain('ORDER BY c.started_at DESC NULLS LAST, c.id DESC');
        expect(sql).toContain('AND c.parent_call_sid IS NULL');
    });

    test('threads limit, direction, contact, and inclusive local-date filters', async () => {
        await queries.listCalls(COMPANY, {
            limit: 50,
            direction: 'outbound',
            contact_id: 42,
            date_from: '2026-07-01',
            date_to: '2026-07-15',
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual([
            COMPANY,
            'outbound',
            42,
            '2026-07-01',
            '2026-07-15',
            50,
        ]);
        expect(sql).toContain('($2::text IS NULL OR c.direction = $2)');
        expect(sql).toContain('($3::bigint IS NULL OR c.contact_id = $3)');
        expect(sql).toContain('$4::date');
        expect(sql).toContain('$5::date');
        expect(sql).toContain(') + 1');
    });

    test.each([
        [{ limit: 0 }, 'limit'],
        [{ limit: 51 }, 'limit'],
        [{ direction: 'internal' }, 'direction'],
        [{ contact_id: 0 }, 'contact_id'],
        [{ date_from: '2026-02-30' }, 'date_from'],
        [{ date_from: '2026-07-20', date_to: '2026-07-01' }, 'date_from'],
    ])('rejects invalid filters before SQL: %j', async (filters, field) => {
        await expect(queries.listCalls(COMPANY, filters)).rejects.toMatchObject({
            code: 'INVALID_QUERY',
            message: expect.stringContaining(field),
        });
        expect(db.query).not.toHaveBeenCalled();
    });
});
