/**
 * tasksService.js — TASKS-COUNT-BADGE-001.
 *
 * emitTaskChange — a single coarse, PII-free `task.changed` SSE ping fired
 * whenever the open-task count visible to some user could have changed
 * (create / complete / reopen / reassign / delete). Mirrors emitLeadChange
 * (leadsService.js): best-effort, company-scoped, never blocks the write.
 *
 * The payload is EXACTLY { company_id } — no owner_user_id / id / status / PII.
 * realtimeService broadcasts only to same-company clients. A richer payload
 * would tempt client-side count math that could drift from the server predicate
 * (the very failure AC-3 forbids), so clients simply refetch their own
 * company-scoped /api/tasks/count.
 */

function emitTaskChange(companyId) {
    if (!companyId) return;
    try {
        require('./realtimeService').broadcast('task.changed', { company_id: companyId });
    } catch (err) {
        console.warn('[tasksService] task event broadcast failed:', err.message);
    }
}

module.exports = { emitTaskChange };
