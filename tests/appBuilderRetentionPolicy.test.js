'use strict';

const policy = require('../backend/src/services/appBuilderRetentionPolicy');

const ORIGINAL_RETENTION = process.env.APP_BUILDER_MESSAGE_RETENTION_DAYS;

afterEach(() => {
    if (ORIGINAL_RETENTION === undefined) {
        delete process.env.APP_BUILDER_MESSAGE_RETENTION_DAYS;
    } else {
        process.env.APP_BUILDER_MESSAGE_RETENTION_DAYS = ORIGINAL_RETENTION;
    }
});

describe('APP-GAP-FIX-001 builder retention policy', () => {
    test('F3 defaults to 365 days and accepts a bounded configured window', () => {
        delete process.env.APP_BUILDER_MESSAGE_RETENTION_DAYS;
        const now = new Date('2026-08-01T00:00:00.000Z');
        expect(policy.retentionDays()).toBe(365);
        expect(policy.retentionExpiresAt(now).toISOString()).toBe('2027-08-01T00:00:00.000Z');

        process.env.APP_BUILDER_MESSAGE_RETENTION_DAYS = '30';
        expect(policy.retentionDays()).toBe(30);
        expect(policy.retentionExpiresAt(now).toISOString()).toBe('2026-08-31T00:00:00.000Z');
    });
});

