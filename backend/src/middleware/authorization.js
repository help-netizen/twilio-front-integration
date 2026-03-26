/**
 * Authorization Middleware — PF007
 * 
 * New middleware functions for permission-based access control:
 *   - requirePlatformRole(...roles): checks req.authz.platform_role
 *   - requireTenantContext(): ensures tenant membership exists
 *   - requirePermission(...keys): checks effective permission keys
 * 
 * These are designed to replace the legacy requireRole() over time.
 */

const auditService = require('../services/auditService');

/**
 * Require the user to have one of the specified platform roles.
 * 
 * Usage: router.get('/companies', authenticate, requirePlatformRole('super_admin'), handler)
 */
function requirePlatformRole(...roles) {
    return (req, res, next) => {
        if (req.user?._devMode) return next();

        const platformRole = req.authz?.platform_role;
        if (!platformRole || !roles.includes(platformRole)) {
            auditService.log({
                actor_id: req.user?.crmUser?.id,
                actor_email: req.user?.email,
                actor_ip: req.ip,
                action: 'access_denied_403',
                target_type: 'route',
                target_id: `${req.method} ${req.originalUrl}`,
                company_id: req.authz?.company?.id,
                details: { required_platform_roles: roles, user_platform_role: platformRole },
                trace_id: req.traceId,
            }).catch(() => {});

            return res.status(403).json({
                code: 'ACCESS_DENIED',
                message: 'Platform role required',
                trace_id: req.traceId,
            });
        }
        next();
    };
}

/**
 * Require the user to have an active tenant membership.
 * super_admin without tenant membership gets PLATFORM_SCOPE_ONLY.
 * 
 * Usage: router.get('/jobs', authenticate, requireTenantContext(), handler)
 */
function requireTenantContext() {
    return (req, res, next) => {
        if (req.user?._devMode) return next();

        // If user is platform-only super_admin, deny tenant access
        if (req.authz?.scope === 'platform') {
            return res.status(403).json({
                code: 'PLATFORM_SCOPE_ONLY',
                message: 'Platform admins cannot access tenant resources',
                trace_id: req.traceId,
            });
        }

        if (!req.authz?.membership || !req.authz?.company) {
            return res.status(403).json({
                code: 'TENANT_CONTEXT_REQUIRED',
                message: 'Tenant membership required',
                trace_id: req.traceId,
            });
        }

        // Check if company is suspended
        if (req.authz._suspended || req.authz.company.status !== 'active') {
            return res.status(403).json({
                code: 'COMPANY_SUSPENDED',
                message: 'Company is suspended',
                trace_id: req.traceId,
            });
        }

        // Set backward-compatible companyFilter
        req.companyFilter = { company_id: req.authz.company.id };

        next();
    };
}

/**
 * Require the user to have at least one of the specified permission keys.
 * 
 * Usage: router.post('/jobs', authenticate, requirePermission('jobs.create'), handler)
 */
function requirePermission(...keys) {
    return (req, res, next) => {
        if (req.user?._devMode) return next();

        const userPermissions = req.authz?.permissions || [];
        const hasPermission = keys.some(k => userPermissions.includes(k));

        if (!hasPermission) {
            auditService.log({
                actor_id: req.user?.crmUser?.id,
                actor_email: req.user?.email,
                actor_ip: req.ip,
                action: 'access_denied_403',
                target_type: 'route',
                target_id: `${req.method} ${req.originalUrl}`,
                company_id: req.authz?.company?.id,
                details: { required_permissions: keys, user_permissions: userPermissions },
                trace_id: req.traceId,
            }).catch(() => {});

            return res.status(403).json({
                code: 'ACCESS_DENIED',
                message: 'Insufficient permissions',
                trace_id: req.traceId,
            });
        }
        next();
    };
}

module.exports = { requirePlatformRole, requireTenantContext, requirePermission };
