import { describe, it, expect } from 'vitest';
import { roleGroupsOf } from './taskUtils';
import type { Task } from './tasksApi';

// TASKS-ASSIGNEE-FILTERS-001 phase 2 — the active list is grouped by the ASSIGNEE's
// role, your role first, then a fixed order, then Unassigned; overdue floats to the
// top of each group. This locks that contract.

const mk = (id: number, owner: string | null, due: string | null): Task => ({
    id, description: `t${id}`, status: 'open', due_at: due, snoozed_until: null,
    completed_at: null, created_at: '2020-01-01T00:00:00Z', owner_user_id: owner,
    author_user_id: null, assignee_name: null, assignee_email: null, author_name: null,
    parent_type: 'job', parent_id: 1, parent_label: null,
});

const roleOf = new Map<string, string>([
    ['u_admin', 'tenant_admin'], ['u_disp', 'dispatcher'],
    ['u_prov1', 'provider'], ['u_prov2', 'provider'],
]);
const label = (rk: string) => rk; // identity — assert on keys/labels directly
const FUTURE = '2999-01-01T00:00:00Z';   // never overdue
const PAST = '2019-01-01T00:00:00Z';     // always overdue (status open + due in the past)

describe('roleGroupsOf', () => {
    it('groups by the assignee role — MY role first, Unassigned last', () => {
        const tasks = [mk(1, 'u_admin', FUTURE), mk(2, 'u_prov1', FUTURE), mk(3, null, FUTURE), mk(4, 'u_disp', FUTURE)];
        const groups = roleGroupsOf(tasks, roleOf, 'provider', label);
        expect(groups.map(g => g.key)).toEqual(['provider', 'tenant_admin', 'dispatcher', 'unassigned']);
    });

    it('falls back to the fixed order when my role has no tasks', () => {
        const tasks = [mk(1, 'u_disp', FUTURE), mk(2, 'u_admin', FUTURE)];
        const groups = roleGroupsOf(tasks, roleOf, 'manager', label);
        expect(groups.map(g => g.key)).toEqual(['tenant_admin', 'dispatcher']); // no empty "manager" group
    });

    it('only includes roles that actually have tasks', () => {
        const groups = roleGroupsOf([mk(1, 'u_prov1', FUTURE)], roleOf, null, label);
        expect(groups.map(g => g.key)).toEqual(['provider']);
    });

    it('floats overdue tasks to the top of a group, preserving order otherwise', () => {
        const tasks = [
            mk(10, 'u_prov1', FUTURE),  // ok
            mk(11, 'u_prov1', PAST),    // overdue
            mk(12, 'u_prov1', FUTURE),  // ok
            mk(13, 'u_prov1', PAST),    // overdue
        ];
        const g = roleGroupsOf(tasks, roleOf, null, label)[0];
        expect(g.tasks.map(t => t.id)).toEqual([11, 13, 10, 12]); // overdue (input order) then rest (input order)
    });

    it('a task with no owner lands in Unassigned', () => {
        const groups = roleGroupsOf([mk(1, null, FUTURE)], roleOf, 'provider', label);
        expect(groups.map(g => g.key)).toEqual(['unassigned']);
    });

    it('unknown roles sit between the known order and Unassigned', () => {
        const roleOf2 = new Map([['u_x', 'estimator']]);
        const tasks = [mk(1, 'u_x', FUTURE), mk(2, null, FUTURE)];
        expect(roleGroupsOf(tasks, roleOf2, null, label).map(g => g.key)).toEqual(['estimator', 'unassigned']);
    });

    it('applies labelOf for the group label', () => {
        const groups = roleGroupsOf([mk(1, 'u_admin', FUTURE)], roleOf, null, rk => rk === 'tenant_admin' ? 'Admin' : rk);
        expect(groups[0].label).toBe('Admin');
    });
});
