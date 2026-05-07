/**
 * Bootstrap smoke test for TWC-001.
 *
 * Verifies that requiring Twilio-using modules without TWILIO_* env
 * does NOT throw at module-load time. Errors should be deferred to
 * actual call sites.
 */

const ORIGINAL_ENV = { ...process.env };

const MODULES = [
    '../../backend/src/services/twilioClient',
    '../../backend/src/services/conversationsService',
    '../../backend/src/services/twilioSync',
    '../../backend/src/services/reconcileService',
    '../../backend/src/services/reconcileStale',
    '../../backend/src/services/callAvailability',
    // inboxWorker pulls in callProcessor / many deps; only require if light
    // '../../backend/src/services/inboxWorker',
    '../../backend/src/routes/phoneSettings',
];

describe('TWC-001 bootstrap — modules load without TWILIO_* env', () => {
    beforeEach(() => {
        jest.resetModules();
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;
        // Mock twilio package so static helpers used at module-level (validateRequest etc.)
        // remain accessible if any transitive module needs them.
        jest.doMock('twilio', () => {
            const fn = jest.fn(() => ({}));
            fn.validateRequest = jest.fn(() => true);
            fn.jwt = { AccessToken: jest.fn() };
            return fn;
        });
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.resetModules();
    });

    test.each(MODULES)('require(%s) does not throw without env', (mod) => {
        expect(() => require(mod)).not.toThrow();
    });
});
