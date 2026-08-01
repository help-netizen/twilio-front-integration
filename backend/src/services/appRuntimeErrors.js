'use strict';

class AppRuntimeError extends Error {
    constructor(code, message, httpStatus = 400, details = {}) {
        super(message);
        this.name = 'AppRuntimeError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }
}

function appRuntimeError(code, message, httpStatus, details) {
    return new AppRuntimeError(code, message, httpStatus, details);
}

module.exports = {
    AppRuntimeError,
    appRuntimeError,
};
