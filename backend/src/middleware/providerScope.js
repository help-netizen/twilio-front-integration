/**
 * Provider scope helper — PF007-HARDENING-001
 *
 * Derives the effective record-level visibility for the current request from
 * req.authz (never from client input):
 *
 *   - job_visibility = 'all'           → tenant-wide visibility (company scope only)
 *   - job_visibility = 'assigned_only' → only records whose internal assignee
 *     mirror contains the current crm_users.id
 *
 * When assigned_only is active but the request has no resolved internal user,
 * visibility degrades to NOTHING (deny-by-default), never to tenant-wide.
 */

/**
 * ROLE-PULSE-SCOPE-001 — a provider's Pulse is scoped to contacts on which they have an
 * ACTIVE job (owner's decision). "Active" = these blanc_status values (NOT leads, NOT
 * closed/canceled). Applied to the Pulse sidebar list + opening a Pulse timeline + SMS-
 * conversation visibility. NOT applied to contact-detail access (a provider still opens a
 * contact from any job they're assigned) or to Jobs/Schedule/etc.
 */
const PULSE_ACTIVE_JOB_STATUSES = ['Submitted', 'Rescheduled', 'Waiting for parts', 'Visit completed'];

function resolveProviderScope(scopes, userId) {
    const visibility = scopes?.job_visibility;
    // `all` is the only value that may widen beyond the current actor. Missing,
    // malformed, and future/unknown values stay on the restrictive branch.
    if (visibility === 'all') {
        return { assignedOnly: false, userId: null };
    }
    return { assignedOnly: true, userId: userId ? String(userId) : null };
}

function getProviderScope(req) {
    return resolveProviderScope(
        req.authz?.scopes,
        req.user?.crmUser?.id
    );
}

module.exports = { getProviderScope, resolveProviderScope, PULSE_ACTIVE_JOB_STATUSES };
