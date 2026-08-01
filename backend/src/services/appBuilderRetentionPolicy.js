'use strict';

const DEFAULT_RETENTION_DAYS = 365;
const MAX_RETENTION_DAYS = 3650;

function retentionDays() {
    const parsed = Number.parseInt(process.env.APP_BUILDER_MESSAGE_RETENTION_DAYS || '', 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_RETENTION_DAYS
        ? parsed
        : DEFAULT_RETENTION_DAYS;
}

function retentionExpiresAt(now = new Date()) {
    return new Date(now.getTime() + retentionDays() * 24 * 60 * 60 * 1000);
}

module.exports = {
    DEFAULT_RETENTION_DAYS,
    MAX_RETENTION_DAYS,
    retentionDays,
    retentionExpiresAt,
};

