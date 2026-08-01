'use strict';

class AppRunnerError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = 'AppRunnerError';
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

class GatewayError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.name = 'GatewayError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

module.exports = {
    AppRunnerError,
    GatewayError,
};
