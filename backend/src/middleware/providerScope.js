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

module.exports = { getProviderScope, resolveProviderScope };
