/**
 * ROLE-JOB-CLOSE-PERMS-001 — which permission a closing / terminal job transition needs.
 *
 * Single source of truth so the three job-transition surfaces can't drift apart (the
 * original bug: `Visit completed` was gated on /complete but NOT on PATCH /:id/status
 * or the FSM /apply side-door, so a provider whose closing permissions were revoked
 * could still mark a job Visit completed — and, via the FSM picker, Job is Done):
 *   - PATCH /api/jobs/:id/status        (mobile + web status change)
 *   - POST  /api/fsm/:machineKey/apply  (desktop FSM action buttons)
 *   - GET   /api/fsm/:machineKey/actions (which action buttons to even show)
 *
 * Owner semantics (2026-07-30):
 *   'Job is Done'     → jobs.close  (the final, approved close)
 *   'Visit completed' → jobs.done_pending_approval OR jobs.close
 *                       (a field provider marks the visit done pending approval; anyone
 *                        who can close a job can obviously also mark it visit-completed)
 *   'Canceled'        → jobs.close  (a dispatch decision — unchanged)
 * Any other target state has no closing gate here; it is still subject to the route's
 * own base requirePermission() guard.
 *
 * Returns { status, error } when the permission set is INSUFFICIENT for the target,
 * or null when the transition is allowed (or is not a gated closing transition).
 */
function closePermissionError(permissions, targetState) {
    const has = (key) => Array.isArray(permissions) && permissions.includes(key);

    if (targetState === 'Canceled' && !has('jobs.close')) {
        return { status: 403, error: 'Insufficient permissions to cancel jobs' };
    }
    if (targetState === 'Job is Done' && !has('jobs.close')) {
        return { status: 403, error: 'Insufficient permissions to close jobs' };
    }
    if (targetState === 'Visit completed'
        && !has('jobs.close') && !has('jobs.done_pending_approval')) {
        return { status: 403, error: 'Insufficient permissions to mark a job visit-completed' };
    }
    return null;
}

module.exports = { closePermissionError };
