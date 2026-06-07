const mockQuery = jest.fn();
jest.mock('../../backend/src/db/connection', () => ({ query: mockQuery }));

const mockBroadcast = jest.fn();
jest.mock('../../backend/src/services/realtimeService', () => ({
    broadcast: (...args) => mockBroadcast(...args),
}));

const agentPresence = require('../../backend/src/services/agentPresence');

describe('F017 agentPresence automatic statuses', () => {
    const presenceRows = new Map();

    beforeEach(() => {
        jest.clearAllMocks();
        presenceRows.clear();
        mockQuery.mockImplementation((sql, params = []) => {
            if (sql.includes('FROM user_group_members')) {
                return Promise.resolve({ rows: [{ group_id: 'ug-1' }, { group_id: 'ug-2' }] });
            }
            if (sql.includes('FROM agent_presence') && sql.includes('LIMIT 1')) {
                const key = `${params[0]}:${params[1]}`;
                const row = presenceRows.get(key);
                return Promise.resolve({ rows: row ? [row] : [] });
            }
            if (sql.includes('INSERT INTO agent_presence')) {
                const [companyId, userId, status, groupIds, details] = params;
                const row = {
                    company_id: companyId,
                    user_id: userId,
                    status,
                    group_ids: JSON.parse(groupIds),
                    details: JSON.parse(details),
                    updated_at: new Date('2026-06-07T12:00:00.000Z').toISOString(),
                    expires_at: new Date('2026-06-07T12:01:30.000Z').toISOString(),
                };
                presenceRows.set(`${companyId}:${userId}`, row);
                return Promise.resolve({ rows: [row] });
            }
            if (sql.includes('FROM agent_presence') && sql.includes('user_id = ANY')) {
                const [companyId, userIds] = params;
                return Promise.resolve({
                    rows: userIds
                        .map(userId => presenceRows.get(`${companyId}:${userId}`))
                        .filter(Boolean)
                        .map(row => ({ user_id: row.user_id, status: row.status })),
                });
            }
            return Promise.resolve({ rows: [] });
        });
    });

    test('sets available/on_call/offline and broadcasts group-scoped SSE event', async () => {
        await agentPresence.setAgentStatus('user-presence-1', 'company-1', 'available', { source: 'test' });
        expect(await agentPresence.getAgentStatus('user-presence-1', 'company-1')).toBe('available');
        expect(mockBroadcast).toHaveBeenCalledWith('agent.status.changed', expect.objectContaining({
            userId: 'user-presence-1',
            companyId: 'company-1',
            groupIds: ['ug-1', 'ug-2'],
            status: 'available',
        }));

        await agentPresence.setAgentStatus('user-presence-1', 'company-1', 'on_call', { source: 'test' });
        expect(await agentPresence.getAgentStatus('user-presence-1', 'company-1')).toBe('on_call');

        await agentPresence.setAgentStatus('user-presence-1', 'company-1', 'offline', { source: 'test' });
        expect(await agentPresence.getAgentStatus('user-presence-1', 'company-1')).toBe('offline');
    });

    test('keeps the same user id isolated across companies', async () => {
        await agentPresence.setAgentStatus('shared-user', 'company-1', 'available', { source: 'test' });
        await agentPresence.setAgentStatus('shared-user', 'company-2', 'on_call', { source: 'test' });

        expect(await agentPresence.getAgentStatus('shared-user', 'company-1')).toBe('available');
        expect(await agentPresence.getAgentStatus('shared-user', 'company-2')).toBe('on_call');

        const companyOneSnapshot = await agentPresence.getPresenceSnapshot(['shared-user'], 'company-1');
        const companyTwoSnapshot = await agentPresence.getPresenceSnapshot(['shared-user'], 'company-2');
        expect(companyOneSnapshot.get('shared-user')).toBe('available');
        expect(companyTwoSnapshot.get('shared-user')).toBe('on_call');
    });
});
