'use strict';

class CrmServiceError extends Error {
    constructor(code, message, httpStatus = 400, details = null) {
        super(message);
        this.name = 'CrmServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }
}

function notFound(message = 'Not found') {
    return new CrmServiceError('NOT_FOUND', message, 404);
}

function badRequest(message, details = null) {
    return new CrmServiceError('BAD_REQUEST', message, 400, details);
}

module.exports = {
    CrmServiceError,
    notFound,
    badRequest,
};
