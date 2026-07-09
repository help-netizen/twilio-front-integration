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
const tasksService = require('../services/tasksService');
const jobsService = require('../services/jobsService');
const taskActions = require('../services/taskActions/registry');
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

// ── GET /count — open-task badge count (role-scoped; mirrors GET / verbatim) ──
// TASKS-COUNT-BADGE-001. Static segment: mounted above the /:id param routes so
// a future GET /:id can never swallow it. Count == GET /?status=open row count.
router.get('/count', requirePermission('tasks.view'), async (req, res) => {
    try {
        const filters = { status: 'open' };
        // Same visibility branch as GET /: managers count all; everyone else own.
        if (canManage(req)) {
            if (req.query.assignee_id) filters.assignee_id = req.query.assignee_id;
        } else {
            filters.scopeOwnerId = actorId(req);
        }
        const count = await tasksQueries.countTasks(companyId(req), filters);
        res.json({ ok: true, data: { count } });
    } catch (err) {
        console.error('[Tasks] GET /count failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to count tasks' } });
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
        // TASKS-COUNT-BADGE-001: a new open task always changes the count. Best-effort.
        tasksService.emitTaskChange(companyId(req));
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
        // TASKS-COUNT-BADGE-001: emit ONCE when a status flip (complete/reopen) or
        // an owner reassign was in the patch — those move the open-count. A pure
        // description/due/snooze edit does NOT change any count → stay silent (S7).
        if ('status' in patch || 'owner_user_id' in patch) {
            tasksService.emitTaskChange(companyId(req));
        }
        res.json({ ok: true, data: { task } });
    } catch (err) {
        console.error('[Tasks] PATCH /:id failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to update task' } });
    }
});

// ── POST /:id/actions/:type — execute a typed task action ────────────────────
// OUTBOUND-PARTS-CALL-001 (spec Part A / arch §3). Runs a CLOSED registry action
// (robot_call / manual_call). Guarded requirePermission('tasks.manage') — it
// executes a server action, stronger than tasks.view. company scope is strictly
// req.companyFilter.company_id; the task is loaded scoped to it → foreign/unknown
// id = 404 (never a leak); an unknown :type not in the registry = 400.
router.post('/:id/actions/:type', requirePermission('tasks.manage'), async (req, res) => {
    try {
        const { type } = req.params;

        // Unknown action type → 400 (no handler invoked). S11.
        if (!taskActions.isKnownAction(type)) {
            return bad(res, 'UNKNOWN_ACTION', `Unknown task action: ${type}`);
        }

        // Load the task scoped to the company → foreign/absent = 404 (S10). No leak.
        const task = await tasksQueries.getTaskById(companyId(req), req.params.id);
        if (!task) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Task not found' } });
        }

        // Resolve the related job (company-scoped) so handlers have the customer
        // phone/name without re-deriving scope. Absent → null (manual_call still
        // returns a well-formed no-phone directive; robot_call's startRobotCall
        // resolves the job itself and safe-fails on a stale/missing one).
        //
        // NB: getTaskById projects the parent as `parent_type`/`parent_id`, NOT a raw
        // `job_id` column — so read the job id from the parent projection (OPC1-T17
        // fix: `task.job_id` was always undefined here, which made robot_call return
        // `not_dialable` on every real request).
        const jobId = task.parent_type === 'job' ? task.parent_id : null;
        let job = null;
        if (jobId != null) {
            job = await jobsService.getJobById(jobId, companyId(req));
        }

        const result = await taskActions.runAction(type, {
            task,
            job,
            jobId,
            // SLOTPICK-001: thread the (optional) dispatcher-picked window through to
            // robot_call's handler. Absent → undefined → startRobotCall auto-computes
            // (backward-compat). The client window NEVER influences company scope.
            slot: req.body?.slot,
            companyId: companyId(req),
        });

        // SLOTPICK-001: a dispatcher-picked slot that fails server validation
        // (bad/expired/out-of-horizon window) is a CLIENT error → HTTP 400, surfaced
        // live in the modal so the dispatcher can re-pick. Nothing was enqueued and
        // the task was NOT stamped failed. Every OTHER outcome (incl. domain refusals
        // like no_phone / not_dialable) stays the 200 envelope below.
        if (result && result.ok === false && result.reason === 'invalid_slot') {
            return res.status(400).json({ ok: false, error: { code: 'INVALID_SLOT' }, reason: 'invalid_slot' });
        }

        // Envelope: { ok, state, client? } (spec §A.3). robot_call → state; a
        // failure carries a reason (no_slots / engine_error / …) but is still a
        // 200 — the action ran, it just couldn't dial.
        return res.json({ ok: true, data: result });
    } catch (err) {
        // A slipped-through unknown action (defensive) maps to 400; everything else 500.
        if (err && err.code === 'UNKNOWN_ACTION') {
            return bad(res, 'UNKNOWN_ACTION', err.message);
        }
        console.error('[Tasks] POST /:id/actions/:type failed:', err.message);
        return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to run task action' } });
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
        // TASKS-COUNT-BADGE-001: removing a task always changes the count. Best-effort.
        tasksService.emitTaskChange(companyId(req));
        res.json({ ok: true });
    } catch (err) {
        console.error('[Tasks] DELETE /:id failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to delete task' } });
    }
});

module.exports = router;
