'use strict';

/**
 * ROLE-TASKS-SCOPE-001 — effective task-content visibility.
 *
 * `tasks.manage` is the see-all capability. Without it, task reads are scoped to
 * rows assigned to or authored by the current crm_users.id. This intentionally
 * does not inspect role_key: custom/future roles inherit the same content rule.
 */
function resolveTaskContentScope(permissions, userId, devMode = false) {
    if (devMode || (permissions || []).includes('tasks.manage')) {
        return { canViewAll: true, userId: null };
    }
    return {
        canViewAll: false,
        userId: userId ? String(userId) : null,
    };
}

function getTaskContentScope(req) {
    return resolveTaskContentScope(
        req.authz?.permissions,
        req.user?.crmUser?.id,
        !!req.user?._devMode
    );
}

/** Shared SQL predicate used by both Tasks and Pulse task projections. */
function buildTaskActorPredicate(alias, placeholder) {
    return `(
                ${alias}.owner_user_id = ${placeholder}
                OR ${alias}.author_user_id = ${placeholder}
            )`;
}

module.exports = {
    resolveTaskContentScope,
    getTaskContentScope,
    buildTaskActorPredicate,
};
