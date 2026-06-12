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

function getProviderScope(req) {
    const visibility = req.authz?.scopes?.job_visibility || 'all';
    if (visibility !== 'assigned_only') {
        return { assignedOnly: false, userId: null };
    }
    const userId = req.user?.crmUser?.id ? String(req.user.crmUser.id) : null;
    return { assignedOnly: true, userId };
}

module.exports = { getProviderScope };
