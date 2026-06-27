/**
 * ALB-101 — otpService unit tests (TC-101-01..04, 2FA trusted devices).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.OTP_PEPPER = 'test-pepper';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/twilioClient', () => ({
    getTwilioClient: jest.fn(() => ({ messages: { create: jest.fn(async () => ({ sid: 'SM1' })) } })),
}));

const db = require('../backend/src/db/connection');
const otpService = require('../backend/src/services/otpService');

beforeEach(() => db.query.mockReset());

describe('otpService.sendCode', () => {
    it('normalizes the phone, stores a hash (not the code) with 5-minute TTL', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ n: '0', last: null }] }) // hourly count
            .mockResolvedValueOnce({ rows: [] })                       // invalidate previous
            .mockResolvedValueOnce({ rows: [] });                      // insert
        const out = await otpService.sendCode({ phone: '(508) 514-0320', purpose: 'signup' });
        expect(out.ok).toBe(true);
        expect(out.phone).toBe('+15085140320');
        const insert = db.query.mock.calls[2];
        expect(insert[0]).toContain('INSERT INTO phone_otp');
        expect(insert[0]).toContain("INTERVAL '5 minutes'");
        expect(insert[1][2]).toMatch(/^[0-9a-f]{64}$/); // sha256 hash, never the code
    });

    it('throttles a send that is within the escalation gap (6th send → 15-min tier)', async () => {
        // AUTH-FLOW-FIX-001: with 5 prior sends in the burst the next send needs a
        // 900s gap; only 100s have elapsed → rejected with retry_after_sec.
        db.query.mockResolvedValueOnce({ rows: [{ n: '5', last: new Date(Date.now() - 100e3).toISOString() }] });
        await expect(otpService.sendCode({ phone: '+15085140320', purpose: 'signup' }))
            .rejects.toMatchObject({ code: 'OTP_RATE_LIMITED', httpStatus: 429, extra: { retry_after_sec: expect.any(Number) } });
    });

    it('rejects invalid phone numbers', async () => {
        await expect(otpService.sendCode({ phone: '12345', purpose: 'signup' }))
            .rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('otpService.verifyCode', () => {
    const row = (over = {}) => ({
        id: 1,
        code_hash: otpService._hashCode('123456'),
        attempts: 0,
        expires_at: new Date(Date.now() + 60e3).toISOString(),
        ...over,
    });

    it('correct code → consumed + otp_token JWT with purpose', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [row()] })   // select
            .mockResolvedValueOnce({ rows: [] });       // consume
        const out = await otpService.verifyCode({ phone: '+15085140320', purpose: 'signup', code: '123456' });
        expect(out.otp_token).toBeTruthy();
        const parsed = otpService.validateOtpToken(out.otp_token, 'signup');
        expect(parsed).toEqual({ phone: '+15085140320', purpose: 'signup' });
        // wrong-purpose validation fails
        expect(otpService.validateOtpToken(out.otp_token, 'login')).toBeNull();
    });

    it('wrong code decrements attempts and reports attempts_left', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [row()] })
            .mockResolvedValueOnce({ rows: [{ attempts: 1 }] }); // attempts update
        await expect(otpService.verifyCode({ phone: '+15085140320', purpose: 'signup', code: '000000' }))
            .rejects.toMatchObject({ code: 'OTP_INVALID', httpStatus: 401, extra: { attempts_left: 2 } });
    });

    it('expired code → 410', async () => {
        db.query.mockResolvedValueOnce({ rows: [row({ expires_at: new Date(Date.now() - 1000).toISOString() })] });
        await expect(otpService.verifyCode({ phone: '+15085140320', purpose: 'signup', code: '123456' }))
            .rejects.toMatchObject({ code: 'OTP_EXPIRED', httpStatus: 410 });
    });

    it('third failed attempt consumes the code', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [row({ attempts: 2 })] })
            .mockResolvedValueOnce({ rows: [{ attempts: 3 }] })
            .mockResolvedValueOnce({ rows: [] }); // consume
        await expect(otpService.verifyCode({ phone: '+15085140320', purpose: 'signup', code: '000000' }))
            .rejects.toMatchObject({ code: 'OTP_EXPIRED', httpStatus: 410 });
    });
});

describe('trusted devices', () => {
    it('trustDevice stores a hash and returns the raw id once', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const { deviceId, maxAgeSec } = await otpService.trustDevice('user-1', { ip: '1.2.3.4' });
        expect(deviceId).toMatch(/^[0-9a-f]{32}$/);
        expect(maxAgeSec).toBe(30 * 24 * 3600);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO trusted_devices');
        expect(params[1]).not.toBe(deviceId); // hashed
    });

    it('isDeviceTrusted false without cookie value', async () => {
        expect(await otpService.isDeviceTrusted('user-1', null)).toBe(false);
        expect(db.query).not.toHaveBeenCalled();
    });
});
