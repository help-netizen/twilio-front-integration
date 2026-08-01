'use strict';

describe('APP-GW-001 process-local rate limiter', () => {
    let limiter;

    beforeEach(() => {
        jest.resetModules();
        process.env.APP_RUNTIME_INSTALLATION_RATE_LIMIT = '2';
        process.env.APP_RUNTIME_UNAUTHENTICATED_RATE_LIMIT = '2';
        process.env.APP_RUNTIME_RATE_WINDOW_MS = '100';
        limiter = require('../backend/src/services/appRuntimeRateLimit');
        limiter.resetForTests();
    });

    afterAll(() => {
        delete process.env.APP_RUNTIME_INSTALLATION_RATE_LIMIT;
        delete process.env.APP_RUNTIME_UNAUTHENTICATED_RATE_LIMIT;
        delete process.env.APP_RUNTIME_RATE_WINDOW_MS;
    });

    test('SAB rate key is installation: two runs share A while B on the same IP is isolated', () => {
        expect(limiter.consumeInstallation('install-a', 1000).allowed).toBe(true);
        expect(limiter.consumeInstallation('install-a', 1001).allowed).toBe(true);
        expect(limiter.consumeInstallation('install-a', 1002)).toMatchObject({
            allowed: false, retryAfterSeconds: 1,
        });
        expect(limiter.consumeInstallation('install-b', 1002).allowed).toBe(true);
        expect(limiter.consumeInstallation('install-b', 1003).allowed).toBe(true);
        expect(limiter.consumeInstallation('install-b', 1004).allowed).toBe(false);
    });

    test('installation window resets deterministically', () => {
        limiter.consumeInstallation('install-a', 1000);
        limiter.consumeInstallation('install-a', 1001);
        expect(limiter.consumeInstallation('install-a', 1002).allowed).toBe(false);
        expect(limiter.consumeInstallation('install-a', 1100).allowed).toBe(true);
    });

    test('unauthenticated failures share an IP budget and isolate different IPs', () => {
        const requestA = { headers: { 'x-forwarded-for': '192.0.2.1, 10.0.0.1' }, ip: '10.0.0.1' };
        const requestB = { headers: { 'x-forwarded-for': '192.0.2.2' }, ip: '10.0.0.1' };
        expect(limiter.consumeUnauthenticated(requestA, 1000).allowed).toBe(true);
        expect(limiter.consumeUnauthenticated(requestA, 1001).allowed).toBe(true);
        expect(limiter.consumeUnauthenticated(requestA, 1002).allowed).toBe(false);
        expect(limiter.consumeUnauthenticated(requestB, 1002).allowed).toBe(true);
    });
});
