/**
 * tasks.js — TASKS-001 cross-entity tasks API.
 *
 * Tasks attach to exactly one parent (job/lead/estimate/invoice/contact) and have
 * no standalone view. Mounted:
 *   app.use('/api/tasks', authenticate, requireCompanyAccess, tasksRouter)
 *
 * Company scope is strictly req.companyFilter.company_id. author/owner FKs use
 * req.user.crmUser.id (FK → crm_users.id; NOT req.user.sub). Visibility:
 * tasks.manage → all company tasks; otherwise the global list is scoped to the
 * caller's own (assigned) tasks. Mutations require manage OR ownership/authorship.
 */

const express = require('express');
const router = express.Router();

const tasksQueries = require('../db/tasksQueries');
const userService = require('../services/userService');
const { requirePermission } = require('../middleware/authorization');

function companyId(req) {
    return req.companyFilter?.company_id;
}
function actorId(req) {
    return req.user?.crmUser?.id || null;
}
function canManage(req) {
    return !!req.user?._devMode || (req.authz?.permissions || []).includes('tasks.manage');
}

function bad(res, code, message) {
    return res.status(400).json({ ok: false, error: { code, message } });
}

function canActOn(req, task) {
    const me = actorId(req);
    return canManage(req) || (me && (task.owner_user_id === me || task.author_user_id === me));
}

// ── GET / — global cross-entity list (role-scoped) ──────────────────────────
router.get('/', requirePermission('tasks.view'), async (req, res) => {
    try {
        const filters = {
            status: req.query.status === 'all' ? undefined : (req.query.status || 'open'),
            parent_type: req.query.parent_type || undefined,
            overdue: req.query.overdue === '1' || req.query.overdue === 'true',
            due_from: req.query.due_from || undefined,
            due_to: req.query.due_to || undefined,
            limit: req.query.limit,
            offset: req.query.offset,
        };
        // Managers (tasks.manage) see all; everyone else only their own.
        if (canManage(req)) {
            if (req.query.assignee_id) filters.assignee_id = req.query.assignee_id;
        } else {
            filters.scopeOwnerId = actorId(req);
        }
        const tasks = await tasksQueries.listTasks(companyId(req), filters);
        res.json({ ok: true, data: { tasks } });
    } catch (err) {
        console.error('[Tasks] GET / failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to load tasks' } });
    }
});

// ── GET /assignees — company users for the assignee picker ──────────────────
// Self-contained (gated tasks.create) so dispatchers/providers can pick an
// assignee without tenant.users.manage. Returns id + name only.
router.get('/assignees', requirePermission('tasks.create', 'tasks.manage'), async (req, res) => {
    try {
        const { users } = await userService.listUsers(companyId(req), { limit: 1000, status: 'active' });
        const list = (users || []).map(u => ({ id: u.id, name: u.full_name, email: u.email }));
        res.json({ ok: true, data: { users: list } });
    } catch (err) {
        console.error('[Tasks] GET /assignees failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to load assignees' } });
    }
});

// ── GET /entity/:parentType/:parentId — tasks for one parent card ────────────
router.get('/entity/:parentType/:parentId', requirePermission('tasks.view'), async (req, res) => {
    try {
        const { parentType, parentId } = req.params;
        if (!tasksQueries.isValidParentType(parentType)) {
            return bad(res, 'INVALID_PARENT_TYPE', 'Unknown parent type');
        }
        const exists = await tasksQueries.parentExists(companyId(req), parentType, parentId);
        if (!exists) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Parent not found' } });
        }
        const includeDone = req.query.include_done === '1' || req.query.include_done === 'true';
        const tasks = await tasksQueries.listEntityTasks(companyId(req), { parentType, parentId, includeDone });
        res.json({ ok: true, data: { tasks } });
    } catch (err) {
        console.error('[Tasks] GET /entity failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to load tasks' } });
    }
});

// ── POST / — create a task on a parent ──────────────────────────────────────
router.post('/', requirePermission('tasks.create'), async (req, res) => {
    try {
        const { parent_type, parent_id, description, owner_user_id, due_at } = req.body || {};

        if (!parent_type || parent_id === undefined || parent_id === null || parent_id === '') {
            return bad(res, 'MISSING_PARENT', 'parent_type and parent_id are required');
        }
        if (!tasksQueries.isValidParentType(parent_type)) {
            return bad(res, 'INVALID_PARENT_TYPE', 'Unknown parent type');
        }
        if (!description || !String(description).trim()) {
            return bad(res, 'DESCRIPTION_REQUIRED', 'A task description is required');
        }
        if (due_at !== undefined && due_at !== null && Number.isNaN(Date.parse(due_at))) {
            return bad(res, 'INVALID_DUE_AT', 'due_at must be a valid timestamp');
        }

        const exists = await tasksQueries.parentExists(companyId(req), parent_type, parent_id);
        if (!exists) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Parent not found' } });
        }

        const task = await tasksQueries.createTask(companyId(req), {
            parentType: parent_type,
            parentId: parent_id,
            description: String(description).trim(),
            owner_user_id: owner_user_id || actorId(req),
            author_user_id: actorId(req),
            due_at: due_at || null,
        });
        res.status(201).json({ ok: true, data: { task } });
    } catch (err) {
        console.error('[Tasks] POST / failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to create task' } });
    }
});

// ── PATCH /:id — edit / complete / snooze ───────────────────────────────────
router.patch('/:id', requirePermission('tasks.view'), async (req, res) => {
    try {
        const existing = await tasksQueries.getTaskById(companyId(req), req.params.id);
        if (!existing) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Task not found' } });
        }
        if (!canActOn(req, existing)) {
            return res.status(403).json({ ok: false, error: { code: 'ACCESS_DENIED', message: 'Cannot modify this task' } });
        }

        const { description, owner_user_id, due_at, status } = req.body || {};
        const patch = {};
        if (description !== undefined) {
            if (!String(description).trim()) return bad(res, 'DESCRIPTION_REQUIRED', 'A task description is required');
            patch.description = String(description).trim();
        }
        if (owner_user_id !== undefined) patch.owner_user_id = owner_user_id || null;
        if (due_at !== undefined) {
            if (due_at !== null && Number.isNaN(Date.parse(due_at))) return bad(res, 'INVALID_DUE_AT', 'due_at must be a valid timestamp');
            patch.due_at = due_at || null;
        }
        if (status !== undefined) {
            if (!['open', 'done'].includes(status)) return bad(res, 'INVALID_STATUS', "status must be 'open' or 'done'");
            patch.status = status;
        }

        const task = await tasksQueries.updateTask(companyId(req), req.params.id, patch);
        res.json({ ok: true, data: { task } });
    } catch (err) {
        console.error('[Tasks] PATCH /:id failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to update task' } });
    }
});

// ── DELETE /:id ─────────────────────────────────────────────────────────────
router.delete('/:id', requirePermission('tasks.view'), async (req, res) => {
    try {
        const existing = await tasksQueries.getTaskById(companyId(req), req.params.id);
        if (!existing) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Task not found' } });
        }
        if (!canActOn(req, existing)) {
            return res.status(403).json({ ok: false, error: { code: 'ACCESS_DENIED', message: 'Cannot delete this task' } });
        }
        await tasksQueries.deleteTask(companyId(req), req.params.id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Tasks] DELETE /:id failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to delete task' } });
    }
});

module.exports = router;
