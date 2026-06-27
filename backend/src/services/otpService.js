/**
 * OTP Service — ALB-101
 *
 * 6-digit SMS codes for signup phone verification and login 2FA.
 * Codes are stored hashed (sha256 with server pepper) and rate-limited.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db/connection');
const { toE164 } = require('../utils/phoneUtils');

const PEPPER = process.env.OTP_PEPPER || process.env.BLANC_SERVER_PEPPER || '';
const JWT_SECRET = process.env.JWT_SECRET;
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// AUTH-FLOW-FIX-001 (R6): escalating per-phone SMS throttle. The ladder counts
// sends since the last successful verify (within the last hour — older sends are
// an idle reset). N = number of prior sends in the current burst; the value is
// the minimum gap (seconds) required before the NEXT send.
//   N<=2 -> 30s  (sends #1,#2,#3 keep the base 30s cooldown)
//   N==3 -> 60s   (#4)
//   N==4 -> 300s  (#5)
//   N==5 -> 900s  (#6)
//   N>=6 -> 3600s (#7+)
const THROTTLE_TIERS = [
    { maxPriorSends: 2, gapSec: 30 },
    { maxPriorSends: 3, gapSec: 60 },
    { maxPriorSends: 4, gapSec: 300 },
    { maxPriorSends: 5, gapSec: 900 },
    { maxPriorSends: Infinity, gapSec: 3600 },
];

/** Minimum gap (seconds) required before a send when `n` sends already exist in the burst. */
function requiredGapSec(n) {
    return THROTTLE_TIERS.find((t) => n <= t.maxPriorSends).gapSec;
}

/** Human-readable duration for a throttle wait message. */
function humanDuration(sec) {
    if (sec < 60) return `${sec}s`;
    const mins = Math.ceil(sec / 60);
    if (mins < 60) return `${mins} min`;
    return `${Math.ceil(mins / 60)}h`;
}

function hashCode(code) {
    return crypto.createHash('sha256').update(PEPPER + code).digest('hex');
}

function normalizePhone(phone) {
    const e164 = toE164(phone);
    return e164 && /^\+1\d{10}$/.test(e164) ? e164 : null;
}

/**
 * Generate + store + send a code. Returns { ok, resend_after_sec } or throws
 * OtpError with httpStatus/code.
 */
async function sendCode({ phone, purpose, ip }) {
    const e164 = normalizePhone(phone);
    if (!e164) throw new OtpError('VALIDATION_ERROR', 'Invalid US phone number', 422);

    // Escalating per-phone throttle (R6) — across ALL purposes, since abuse is
    // per number. Count sends in the current burst: those since the last
    // successful verify, bounded to the last hour (older sends = idle reset).
    const { rows: countRows } = await db.query(
        `WITH last_verify AS (
             SELECT MAX(verified_at) AS at FROM phone_otp WHERE phone = $1
         )
         SELECT
             COUNT(*) FILTER (
                 WHERE created_at > GREATEST(
                     COALESCE((SELECT at FROM last_verify), 'epoch'::timestamptz),
                     now() - INTERVAL '1 hour'
                 )
             ) AS n,
             MAX(created_at) AS last
         FROM phone_otp
         WHERE phone = $1`,
        [e164]
    );
    const n = parseInt(countRows[0].n, 10) || 0;
    const last = countRows[0].last ? new Date(countRows[0].last).getTime() : null;
    const gapSec = requiredGapSec(n);

    if (last !== null) {
        const elapsedMs = Date.now() - last;
        if (elapsedMs < gapSec * 1000) {
            const retryAfterSec = Math.ceil((gapSec * 1000 - elapsedMs) / 1000);
            throw new OtpError(
                'OTP_RATE_LIMITED',
                `Too many codes — try again in ${humanDuration(retryAfterSec)}`,
                429,
                { retry_after_sec: retryAfterSec }
            );
        }
    }

    // Gap that will apply before the NEXT send (so the UI countdown is correct).
    const resendAfterSec = requiredGapSec(n + 1);

    // Invalidate previous unconsumed codes
    await db.query(
        `UPDATE phone_otp SET consumed_at = now()
         WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL`,
        [e164, purpose]
    );

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.query(
        `INSERT INTO phone_otp (phone, purpose, code_hash, created_ip, expires_at)
         VALUES ($1, $2, $3, $4, now() + INTERVAL '5 minutes')`,
        [e164, purpose, hashCode(code), ip || null]
    );

    await deliverSms(e164, `Albusto: your verification code is ${code}. Valid 5 minutes.`);
    return { ok: true, resend_after_sec: resendAfterSec, phone: e164 };
}

/**
 * Verify a code. On success consumes it and returns a short-lived otp_token
 * (JWT) the next step presents as proof of phone possession.
 */
async function verifyCode({ phone, purpose, code }) {
    const e164 = normalizePhone(phone);
    if (!e164 || !/^\d{6}$/.test(String(code || ''))) {
        throw new OtpError('OTP_INVALID', 'Invalid code', 401);
    }

    const { rows } = await db.query(
        `SELECT * FROM phone_otp
         WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [e164, purpose]
    );
    const row = rows[0];
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
        throw new OtpError('OTP_EXPIRED', 'Code expired — request a new one', 410);
    }
    if (row.attempts >= MAX_ATTEMPTS) {
        await db.query(`UPDATE phone_otp SET consumed_at = now() WHERE id = $1`, [row.id]);
        throw new OtpError('OTP_EXPIRED', 'Too many attempts — request a new code', 410);
    }

    if (row.code_hash !== hashCode(String(code))) {
        const { rows: upd } = await db.query(
            `UPDATE phone_otp SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
            [row.id]
        );
        const left = MAX_ATTEMPTS - upd[0].attempts;
        if (left <= 0) {
            await db.query(`UPDATE phone_otp SET consumed_at = now() WHERE id = $1`, [row.id]);
            throw new OtpError('OTP_EXPIRED', 'Too many attempts — request a new code', 410);
        }
        throw new OtpError('OTP_INVALID', 'Incorrect code', 401, { attempts_left: left });
    }

    // SUCCESS: consume + stamp verified_at so the send throttle ladder resets (R6/B3).
    await db.query(`UPDATE phone_otp SET consumed_at = now(), verified_at = now() WHERE id = $1`, [row.id]);

    const otpToken = jwt.sign({ phone: e164, purpose, typ: 'otp' }, JWT_SECRET, { expiresIn: '10m' });
    return { ok: true, otp_token: otpToken, phone: e164 };
}

/** Validate an otp_token produced by verifyCode. Returns {phone, purpose} or null. */
function validateOtpToken(token, expectedPurpose) {
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.typ !== 'otp') return null;
        if (expectedPurpose && payload.purpose !== expectedPurpose) return null;
        return { phone: payload.phone, purpose: payload.purpose };
    } catch {
        return null;
    }
}

// ── Trusted devices ──────────────────────────────────────────────────────────

const TRUST_TTL_DAYS = parseInt(process.env.TRUSTED_DEVICE_TTL_DAYS || '30', 10);

function hashDeviceId(deviceId) {
    return crypto.createHash('sha256').update(PEPPER + deviceId).digest('hex');
}

async function trustDevice(userId, { ip, label } = {}) {
    const deviceId = crypto.randomBytes(16).toString('hex');
    await db.query(
        `INSERT INTO trusted_devices (user_id, device_id_hash, label, created_ip, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval)`,
        [userId, hashDeviceId(deviceId), label || null, ip || null, String(TRUST_TTL_DAYS)]
    );
    return { deviceId, maxAgeSec: TRUST_TTL_DAYS * 24 * 3600 };
}

async function isDeviceTrusted(userId, deviceId) {
    if (!deviceId) return false;
    const { rows } = await db.query(
        `UPDATE trusted_devices SET last_used_at = now()
         WHERE user_id = $1 AND device_id_hash = $2
           AND revoked_at IS NULL AND expires_at > now()
         RETURNING id`,
        [userId, hashDeviceId(deviceId)]
    );
    return rows.length > 0;
}

async function revokeUserDevices(userId) {
    await db.query(
        `UPDATE trusted_devices SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
    );
}

// ── SMS delivery ─────────────────────────────────────────────────────────────

async function deliverSms(to, body) {
    const { getTwilioClient } = require('./twilioClient');
    const from = process.env.SIGNUP_SMS_FROM || process.env.SOFTPHONE_CALLER_ID;
    try {
        const client = getTwilioClient();
        await client.messages.create({ to, from, body });
    } catch (err) {
        console.error('[OTP] SMS delivery failed:', err.message);
        throw new OtpError('OTP_DELIVERY_FAILED', 'Could not deliver the SMS code', 502);
    }
}

class OtpError extends Error {
    constructor(code, message, httpStatus, extra = {}) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
        this.extra = extra;
    }
}

module.exports = {
    sendCode,
    verifyCode,
    validateOtpToken,
    trustDevice,
    isDeviceTrusted,
    revokeUserDevices,
    normalizePhone,
    OtpError,
    _hashCode: hashCode,
};
