/**
 * Tests for the Twilio REST client singleton (TWC-001).
 */

describe('twilioClient — singleton getter', () => {
    const ORIGINAL_ENV = { ...process.env };
    const FAKE_INSTANCE = { __id: 'fake-twilio' };
    let twilioFactory;

    beforeEach(() => {
        jest.resetModules();
        twilioFactory = jest.fn(() => FAKE_INSTANCE);
        jest.doMock('twilio', () => twilioFactory);
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.resetModules();
    });

    test('TC-TWC-001-001: returns the same instance on repeat calls', () => {
        process.env.TWILIO_ACCOUNT_SID = 'ACtest';
        process.env.TWILIO_AUTH_TOKEN = 'tok123';

        const { getTwilioClient } = require('../../backend/src/services/twilioClient');
        const a = getTwilioClient();
        const b = getTwilioClient();

        expect(a).toBe(b);
        expect(a).toBe(FAKE_INSTANCE);
        expect(twilioFactory).toHaveBeenCalledTimes(1);
        expect(twilioFactory).toHaveBeenCalledWith('ACtest', 'tok123');
    });

    test('TC-TWC-001-002: throws when TWILIO_ACCOUNT_SID is missing', () => {
        delete process.env.TWILIO_ACCOUNT_SID;
        process.env.TWILIO_AUTH_TOKEN = 'tok';

        const { getTwilioClient } = require('../../backend/src/services/twilioClient');
        expect(() => getTwilioClient()).toThrow(/TWILIO_ACCOUNT_SID.*TWILIO_AUTH_TOKEN/);
        expect(twilioFactory).not.toHaveBeenCalled();
    });

    test('TC-TWC-001-003: throws when TWILIO_AUTH_TOKEN is missing', () => {
        process.env.TWILIO_ACCOUNT_SID = 'ACtest';
        delete process.env.TWILIO_AUTH_TOKEN;

        const { getTwilioClient } = require('../../backend/src/services/twilioClient');
        expect(() => getTwilioClient()).toThrow(/TWILIO_ACCOUNT_SID.*TWILIO_AUTH_TOKEN/);
        expect(twilioFactory).not.toHaveBeenCalled();
    });

    test('TC-TWC-001-004: require() does not throw when env is missing', () => {
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;

        expect(() => {
            require('../../backend/src/services/twilioClient');
        }).not.toThrow();
        expect(twilioFactory).not.toHaveBeenCalled();
    });

    test('TC-TWC-001-005: re-init succeeds after env becomes available', () => {
        delete process.env.TWILIO_ACCOUNT_SID;
        delete process.env.TWILIO_AUTH_TOKEN;

        const { getTwilioClient } = require('../../backend/src/services/twilioClient');
        expect(() => getTwilioClient()).toThrow();

        process.env.TWILIO_ACCOUNT_SID = 'ACtest';
        process.env.TWILIO_AUTH_TOKEN = 'tok';

        const c = getTwilioClient();
        expect(c).toBe(FAKE_INSTANCE);
        expect(twilioFactory).toHaveBeenCalledTimes(1);
    });
});
