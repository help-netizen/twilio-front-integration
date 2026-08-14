'use strict';

const TENANT_CONTEXT_REQUIRED = 'TENANT_CONTEXT_REQUIRED';
const TENANT_CONTEXT_MESSAGE = 'Company context is required';

class TenantContextRequiredError extends Error {
    constructor() {
        super(TENANT_CONTEXT_MESSAGE);
        this.name = 'TenantContextRequiredError';
        this.code = TENANT_CONTEXT_REQUIRED;
        this.httpStatus = 403;
        this.statusCode = 403;
    }
}

function requireCompanyId(companyId) {
    if (!companyId) throw new TenantContextRequiredError();
    return companyId;
}

function requireRequestCompanyId(req) {
    return requireCompanyId(req?.companyFilter?.company_id);
}

function sendTenantContextRequired(res, err) {
    if (err?.code !== TENANT_CONTEXT_REQUIRED) return false;
    res.status(403).json({
        code: TENANT_CONTEXT_REQUIRED,
        message: TENANT_CONTEXT_MESSAGE,
    });
    return true;
}

module.exports = {
    TENANT_CONTEXT_REQUIRED,
    TENANT_CONTEXT_MESSAGE,
    TenantContextRequiredError,
    requireCompanyId,
    requireRequestCompanyId,
    sendTenantContextRequired,
};
