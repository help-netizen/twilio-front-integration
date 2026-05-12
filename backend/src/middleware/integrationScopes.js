function normalizeScopes(scopes) {
    if (Array.isArray(scopes)) return scopes.map(String);
    if (typeof scopes === 'string') {
        try {
            const parsed = JSON.parse(scopes);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return [];
}

function hasIntegrationScope(scopes, requiredScope) {
    const normalized = normalizeScopes(scopes);
    return normalized.includes('full_access') || normalized.includes(requiredScope);
}

function requireIntegrationScope(requiredScope) {
    return function integrationScopeMiddleware(req, res, next) {
        if (hasIntegrationScope(req.integrationScopes || [], requiredScope)) {
            return next();
        }

        return res.status(403).json({
            success: false,
            code: 'SCOPE_INSUFFICIENT',
            message: `This integration does not have ${requiredScope} scope.`,
            request_id: req.requestId,
        });
    };
}

module.exports = {
    normalizeScopes,
    hasIntegrationScope,
    requireIntegrationScope,
};
