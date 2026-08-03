const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const registry = require('../../backend/src/services/nativeVoiceRegistration');

beforeEach(() => mockQuery.mockReset());

describe('native Voice registration registry', () => {
    test('upserts the authenticated tenant/user pair with a 30-day TTL', async () => {
        mockQuery.mockResolvedValue({
            rows: [{ inserted: true, expires_at: '2026-09-02T12:00:00.000Z' }],
        });

        await expect(registry.upsertNativeRegistration('user-1', 'company-1')).resolves.toEqual({
            inserted: true,
            expiresAt: '2026-09-02T12:00:00.000Z',
        });

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/ON CONFLICT \(company_id, user_id\) DO UPDATE/);
        expect(sql).toMatch(/expires_at = NOW\(\) \+ \(\$3::int \* INTERVAL '1 day'\)/);
        expect(params).toEqual(['company-1', 'user-1', 30]);
    });

    test('deletes only the authenticated tenant/user pair', async () => {
        mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

        await expect(registry.deleteNativeRegistration('shared-user', 'company-a')).resolves.toBe(true);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringMatching(/WHERE company_id = \$1 AND user_id = \$2/),
            ['company-a', 'shared-user']
        );
    });

    test('loads only unexpired registrations for candidate users in one company', async () => {
        mockQuery.mockResolvedValue({ rows: [{ user_id: 'user-2' }] });

        await expect(registry.getActiveNativeUserIds(['user-1', 'user-2'], 'company-a'))
            .resolves.toEqual(new Set(['user-2']));
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringMatching(/company_id = \$1[\s\S]*user_id::text = ANY\(\$2::text\[\]\)[\s\S]*expires_at > NOW\(\)/),
            ['company-a', ['user-1', 'user-2']]
        );
    });
});
