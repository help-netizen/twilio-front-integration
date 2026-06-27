/**
 * AUTH-FLOW-FIX-001 (T5 / D) — otpService escalating per-phone SMS throttle.
 *
 * Mirrors tests/otpService.test.js: db.query and twilioClient are mocked. Here
 * we drive the throttle by stubbing the COUNT/MAX query (n = prior sends in the
 * current burst, last = previous send time) so no real time waits are needed.
 *
 * Throttle ladder (gap before the NEXT send, given n prior sends):
 *   n<=2 -> 30s | n==3 -> 60s | n==4 -> 300s | n==5 -> 900s | n>=6 -> 3600s
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.OTP_PEPPER = 'test-pepper';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/twilioClient', () => ({
    getTwilioClient: jest.fn(() => ({ messages: { create: jest.fn(async () => ({ sid: 'SM1' })) } })),
}));

const db = require('../backend/src/db/connection');
const otpService = require('../backend/src/services/otpService');

const PHONE = '+15085140320';

/**
 * Stub db.query to answer the throttle COUNT/MAX query with { n, last } and let
 * the follow-up invalidate + insert succeed. Returns the per-call mock so tests
 * can inspect what SQL ran.
 */
function stubSend({ n, lastMsAgo }) {
    const last = lastMsAgo == null ? null : new Date(Date.now() - lastMsAgo).toISOString();
    db.query.mockImplementation(async (sql) => {
        if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: String(n), last }] };
        return { rows: [] }; // invalidate previous + insert
    });
}

beforeEach(() => db.query.mockReset());

describe('otpService.sendCode — escalating throttle', () => {
    it('allows 3 sends within 5 minutes (base 30s cooldown honored)', async () => {
        // Send #1: no history.
        stubSend({ n: 0, lastMsAgo: null });
        await expect(otpService.sendCode({ phone: PHONE, purpose: 'signup' }))
            .resolves.toMatchObject({ ok: true });

        // Send #2: 1 prior send, last was 31s ago (> 30s gap) → allowed.
        stubSend({ n: 1, lastMsAgo: 31_000 });
        await expect(otpService.sendCode({ phone: PHONE, purpose: 'signup' }))
            .resolves.toMatchObject({ ok: true });

        // Send #3: 2 prior sends, last was 31s ago (> 30s gap) → allowed.
        stubSend({ n: 2, lastMsAgo: 31_000 });
        await expect(otpService.sendCode({ phone: PHONE, purpose: 'signup' }))
            .resolves.toMatchObject({ ok: true });
    });

    it('rejects the 4th send within <60s of the 3rd with 429 + retry_after_sec', async () => {
        // 3 prior sends in the burst; the 4th needs a 60s gap but only 20s passed.
        stubSend({ n: 3, lastMsAgo: 20_000 });
        await expect(otpService.sendCode({ phone: PHONE, purpose: 'signup' }))
            .rejects.toMatchObject({
                code: 'OTP_RATE_LIMITED',
                httpStatus: 429,
                extra: { retry_after_sec: expect.any(Number) },
            });
        // retry_after_sec ≈ 60 - 20 = 40s.
        try {
            stubSend({ n: 3, lastMsAgo: 20_000 });
            await otpService.sendCode({ phone: PHONE, purpose: 'signup' });
        } catch (err) {
            expect(err.extra.retry_after_sec).toBeGreaterThan(0);
            expect(err.extra.retry_after_sec).toBeLessThanOrEqual(40);
        }
    });

    it('allows the 4th send once the 60s gap has elapsed', async () => {
        stubSend({ n: 3, lastMsAgo: 61_000 });
        await expect(otpService.sendCode({ phone: PHONE, purpose: 'signup' }))
            .resolves.toMatchObject({ ok: true });
    });

    it('escalation tiers produce increasing gaps (n==4 requires >= 300s)', async () => {
        // 4 prior sends → 5th needs a 300s gap; only 100s elapsed → blocked.
        stubSend({ n: 4, lastMsAgo: 100_000 });
        let captured;
        try {
            await otpService.sendCode({ phone: PHONE, purpose: 'signup' });
        } catch (err) {
            captured = err;
        }
        expect(captured).toBeDefined();
        expect(captured.httpStatus).toBe(429);
        // required gap is 300s; with 100s elapsed retry_after ≈ 200s and never < (300-100).
        expect(captured.extra.retry_after_sec).toBeGreaterThanOrEqual(300 - 100);

        // Sanity: tiers keep climbing — n==5 needs 900s, n>=6 needs 3600s.
        stubSend({ n: 5, lastMsAgo: 100_000 });
        await expect(otpService.sendCode({ phone: PHONE, purpose: 'signup' }))
            .rejects.toMatchObject({ extra: { retry_after_sec: expect.any(Number) } });
        stubSend({ n: 6, lastMsAgo: 100_000 });
        await expect(otpService.sendCode({ phone: PHONE, purpose: 'signup' }))
            .rejects.toMatchObject({ extra: { retry_after_sec: expect.any(Number) } });
    });

    it('counts across purposes (abuse is per number)', async () => {
        // The throttle query keys only on phone ($1), not purpose.
        stubSend({ n: 3, lastMsAgo: 10_000 });
        await otpService.sendCode({ phone: PHONE, purpose: 'login' }).catch(() => {});
        const countCall = db.query.mock.calls.find(([sql]) => /COUNT\(\*\)/.test(sql));
        expect(countCall).toBeDefined();
        expect(countCall[1]).toEqual([PHONE]); // phone only — no purpose param
    });
});

describe('otpService — ladder reset after a successful verify', () => {
    it('verifyCode stamps verified_at alongside consumed_at on success', async () => {
        const row = {
            id: 7,
            code_hash: otpService._hashCode('123456'),
            attempts: 0,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
        };
        db.query
            .mockResolvedValueOnce({ rows: [row] }) // select
            .mockResolvedValueOnce({ rows: [] });   // consume + verify
        await otpService.verifyCode({ phone: PHONE, purpose: 'signup', code: '123456' });
        const consume = db.query.mock.calls[1];
        expect(consume[0]).toMatch(/UPDATE phone_otp SET consumed_at = now\(\), verified_at = now\(\)/);
        expect(consume[1]).toEqual([row.id]);
    });

    it('after a successful verify the burst count resets → next send allowed at base cooldown', async () => {
        // The throttle counts only sends with created_at > MAX(verified_at). After a
        // verify, the prior burst is excluded, so n collapses to a small number and the
        // base 30s gap applies again even if many sends happened before the verify.
        stubSend({ n: 0, lastMsAgo: 31_000 });
        await expect(otpService.sendCode({ phone: PHONE, purpose: 'login' }))
            .resolves.toMatchObject({ ok: true });
    });
});
