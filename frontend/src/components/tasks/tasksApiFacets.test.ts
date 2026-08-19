import { describe, it, expect, vi, beforeEach } from 'vitest';

// TASKS-ASSIGNEE-FILTERS-001 phase 1 — the OR-union facet filters must reach the
// query string; absent → no facet params (default = all tasks).

const h = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock('../../services/apiClient', () => ({ authedFetch: h.authedFetch }));

import { listTasksPage, getTaskFacets } from './tasksApi';

const okList = () => ({ ok: true, json: async () => ({ ok: true, data: { tasks: [], pagination: {} } }) });
const okFacets = () => ({ ok: true, json: async () => ({ ok: true, data: { byRole: {}, byUser: {}, mineAuthor: 2, mineAssignee: 3, total: 5 } }) });

beforeEach(() => { h.authedFetch.mockReset(); });

describe('listTasksPage — facet params', () => {
    it('appends role[] / assignee[] / author_mine / assignee_mine', async () => {
        h.authedFetch.mockResolvedValue(okList());
        await listTasksPage({ role: ['dispatcher', 'provider'], assignee: ['u1', 'u2'], author_mine: true, assignee_mine: true });
        const url = h.authedFetch.mock.calls[0][0] as string;
        expect(url).toContain('role=dispatcher');
        expect(url).toContain('role=provider');
        expect(url).toContain('assignee=u1');
        expect(url).toContain('assignee=u2');
        expect(url).toContain('author_mine=1');
        expect(url).toContain('assignee_mine=1');
    });

    it('omits every facet param when unset (default = all)', async () => {
        h.authedFetch.mockResolvedValue(okList());
        await listTasksPage({});
        const url = h.authedFetch.mock.calls[0][0] as string;
        expect(url).not.toContain('role=');
        expect(url).not.toContain('assignee=');
        expect(url).not.toContain('author_mine');
        expect(url).not.toContain('assignee_mine');
    });
});

describe('getTaskFacets', () => {
    it('GETs /api/tasks/facets and unwraps the counts envelope', async () => {
        h.authedFetch.mockResolvedValue(okFacets());
        const facets = await getTaskFacets();
        expect((h.authedFetch.mock.calls[0][0] as string)).toContain('/api/tasks/facets');
        expect(facets).toEqual({ byRole: {}, byUser: {}, mineAuthor: 2, mineAssignee: 3, total: 5 });
    });
});
