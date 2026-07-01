/**
 * Telephony Tenant Service — ALB-107
 *
 * One Twilio SUBACCOUNT per tenant company (ISV model): numbers, calls and
 * usage are isolated on Twilio's side. The legacy default company keeps using
 * the master account credentials.
 *
 * Subaccount management REQUIRES the master Account SID + Auth Token
 * (Twilio rejects API Keys for /Accounts operations — error 20003).
 */

const crypto = require('crypto');
const twilio = require('twilio');
const db = require('../db/connection');
const auditService = require('./auditService');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// ── Token encryption (AES-256-GCM at rest) ───────────────────────────────────

function encKey() {
    const secret = process.env.TELEPHONY_TOKEN_KEY || process.env.BLANC_SERVER_PEPPER;
    if (!secret) throw new Error('TELEPHONY_TOKEN_KEY or BLANC_SERVER_PEPPER required');
    return crypto.createHash('sha256').update(secret).digest();
}

function encryptToken(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

function decryptToken(stored) {
    const [ivHex, tagHex, dataHex] = String(stored).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

// ── Master client ────────────────────────────────────────────────────────────

function masterClient() {
    const { getTwilioClient } = require('./twilioClient');
    return getTwilioClient();
}

// ── Tenant connection state ──────────────────────────────────────────────────

async function getTelephonyState(companyId) {
    if (companyId === DEFAULT_COMPANY_ID) {
        return { connected: true, provider: 'twilio', mode: 'master', status: 'connected' };
    }
    const { rows } = await db.query(
        `SELECT provider, twilio_subaccount_sid, status, connected_at, suspended_at
         FROM company_telephony WHERE company_id = $1`,
        [companyId]
    );
    if (!rows[0] || !rows[0].twilio_subaccount_sid) {
        return { connected: false };
    }
    return {
        connected: true,
        provider: rows[0].provider,
        mode: 'subaccount',
        status: rows[0].status,
        subaccount_sid: rows[0].twilio_subaccount_sid,
        connected_at: rows[0].connected_at,
    };
}

// ── Autonomous mode (force every inbound call down the After-Hours branch) ───

/**
 * Whether company-wide Autonomous mode is ON. A missing company_telephony row
 * (company never connected a subaccount) reads as OFF. Single indexed PK lookup.
 */
async function getAutonomousMode(companyId) {
    if (!companyId) return false;
    const { rows } = await db.query(
        `SELECT autonomous_mode FROM company_telephony WHERE company_id = $1`,
        [companyId]
    );
    return rows[0]?.autonomous_mode === true;
}

/**
 * Set company-wide Autonomous mode. Upserts so it works even when the company
 * has no company_telephony row yet (e.g. the master/default company that never
 * created a subaccount). Returns the persisted boolean.
 */
async function setAutonomousMode(companyId, on, actorId) {
    const value = on === true;
    const { rows } = await db.query(
        `INSERT INTO company_telephony (company_id, autonomous_mode)
         VALUES ($1, $2)
         ON CONFLICT (company_id) DO UPDATE SET
            autonomous_mode = EXCLUDED.autonomous_mode,
            updated_at = now()
         RETURNING autonomous_mode`,
        [companyId, value]
    );

    auditService.log({
        actor_id: actorId || null,
        action: 'telephony.autonomous_mode_changed',
        target_type: 'company', target_id: companyId, company_id: companyId,
        details: { autonomous_mode: value },
    }).catch(() => {});

    return rows[0].autonomous_mode === true;
}

/**
 * Connect telephony for a tenant: create a Twilio subaccount and store its
 * credentials (token encrypted). Idempotent — an existing connection is
 * returned as-is.
 */
async function connectTelephony(companyId, { actorId, companyName } = {}) {
    const existing = await getTelephonyState(companyId);
    if (existing.connected) return existing;

    const friendly = `Albusto ${companyName || companyId}`.slice(0, 64);
    const sub = await masterClient().api.v2010.accounts.create({ friendlyName: friendly });

    await db.query(
        `INSERT INTO company_telephony (company_id, twilio_subaccount_sid, twilio_auth_token_enc, status, connected_by)
         VALUES ($1, $2, $3, 'connected', $4)
         ON CONFLICT (company_id) DO UPDATE SET
            twilio_subaccount_sid = EXCLUDED.twilio_subaccount_sid,
            twilio_auth_token_enc = EXCLUDED.twilio_auth_token_enc,
            status = 'connected', suspended_at = NULL, updated_at = now()`,
        [companyId, sub.sid, encryptToken(sub.authToken), actorId || null]
    );

    auditService.log({
        actor_id: actorId, action: 'telephony.connected',
        target_type: 'company', target_id: companyId, company_id: companyId,
        details: { subaccount_sid: sub.sid },
    }).catch(() => {});

    return { connected: true, provider: 'twilio', mode: 'subaccount', status: 'connected', subaccount_sid: sub.sid };
}

// ── Per-company Twilio client ────────────────────────────────────────────────

const clientCache = new Map(); // companyId → { client, sid }

async function getClientForCompany(companyId) {
    if (!companyId || companyId === DEFAULT_COMPANY_ID) {
        return { client: masterClient(), accountSid: process.env.TWILIO_ACCOUNT_SID, mode: 'master' };
    }
    const cached = clientCache.get(companyId);
    if (cached) return cached;

    const { rows } = await db.query(
        `SELECT twilio_subaccount_sid, twilio_auth_token_enc, status
         FROM company_telephony WHERE company_id = $1`,
        [companyId]
    );
    if (!rows[0]?.twilio_subaccount_sid) {
        const err = new Error('Telephony is not connected for this company');
        err.code = 'TELEPHONY_NOT_CONNECTED'; err.httpStatus = 409;
        throw err;
    }
    if (rows[0].status !== 'connected') {
        const err = new Error('Telephony is suspended for this company');
        err.code = 'TELEPHONY_SUSPENDED'; err.httpStatus = 403;
        throw err;
    }
    const entry = {
        client: twilio(rows[0].twilio_subaccount_sid, decryptToken(rows[0].twilio_auth_token_enc)),
        accountSid: rows[0].twilio_subaccount_sid,
        mode: 'subaccount',
    };
    clientCache.set(companyId, entry);
    return entry;
}

/** Resolve a webhook's company from the Twilio AccountSid in the payload. */
async function resolveCompanyByAccountSid(accountSid) {
    if (!accountSid) return null;
    if (accountSid === process.env.TWILIO_ACCOUNT_SID) return DEFAULT_COMPANY_ID;
    const { rows } = await db.query(
        `SELECT company_id FROM company_telephony WHERE twilio_subaccount_sid = $1 AND status = 'connected'`,
        [accountSid]
    );
    return rows[0]?.company_id || null;
}

/** Auth token used to validate webhook signatures for a given AccountSid. */
async function getAuthTokenForAccountSid(accountSid) {
    if (!accountSid || accountSid === process.env.TWILIO_ACCOUNT_SID) {
        return process.env.TWILIO_AUTH_TOKEN;
    }
    const { rows } = await db.query(
        `SELECT twilio_auth_token_enc FROM company_telephony WHERE twilio_subaccount_sid = $1`,
        [accountSid]
    );
    return rows[0] ? decryptToken(rows[0].twilio_auth_token_enc) : null;
}

// ── Numbers: search / buy / list / release ───────────────────────────────────

async function searchNumbers(companyId, { areaCode, contains, locality, tollFree } = {}) {
    const { client } = await getClientForCompany(companyId);
    const params = { limit: 15 };
    if (areaCode) params.areaCode = String(areaCode).replace(/\D/g, '').slice(0, 3);
    if (contains) params.contains = String(contains).replace(/[^0-9A-Za-z*]/g, '');
    if (locality) params.inLocality = locality;
    const kind = tollFree ? 'tollFree' : 'local';
    const list = await client.availablePhoneNumbers('US')[kind].list(params);
    return list.map(n => ({
        phone_number: n.phoneNumber,
        friendly_name: n.friendlyName,
        locality: n.locality || null,
        region: n.region || null,
        capabilities: { voice: !!n.capabilities?.voice, sms: !!(n.capabilities?.SMS ?? n.capabilities?.sms) },
        monthly_price_usd: tollFree ? 2.15 : 1.15,
    }));
}

function webhookBase() {
    return process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://api.albusto.com';
}

async function buyNumber(companyId, { phoneNumber, friendlyName, actorId } = {}) {
    if (!/^\+1\d{10}$/.test(String(phoneNumber || ''))) {
        const err = new Error('phoneNumber must be E.164 (+1XXXXXXXXXX)');
        err.httpStatus = 422; throw err;
    }

    // Hard plan cap: never provision on Twilio beyond the plan's number limit.
    const billingService = require('./billingService');
    const plan = await billingService.getPlanForCompany(companyId);
    const max = plan?.max_phone_numbers;
    if (max != null) {
        const { rows } = await db.query(
            'SELECT count(*)::int AS n FROM phone_number_settings WHERE company_id = $1', [companyId]
        );
        if (rows[0].n >= max) {
            const err = new Error(
                `Your ${plan.name} plan includes up to ${max} phone number${max === 1 ? '' : 's'}. Upgrade your plan to add more.`
            );
            err.httpStatus = 422; err.code = 'NUMBER_LIMIT'; throw err;
        }
    }

    const { client } = await getClientForCompany(companyId);
    const base = webhookBase();

    const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber,
        friendlyName: friendlyName || undefined,
        voiceUrl: `${base}/webhooks/twilio/voice-inbound`,
        voiceMethod: 'POST',
        voiceFallbackUrl: `${base}/webhooks/twilio/voice-fallback`,
        statusCallback: `${base}/webhooks/twilio/voice-status`,
        statusCallbackMethod: 'POST',
    });

    await db.query(
        `INSERT INTO phone_number_settings
            (phone_number, friendly_name, routing_mode, company_id, twilio_number_sid, locality, capabilities, purchased_at)
         VALUES ($1, $2, 'client', $3, $4, $5, $6::jsonb, now())
         ON CONFLICT (phone_number) DO UPDATE SET
            company_id = EXCLUDED.company_id,
            twilio_number_sid = EXCLUDED.twilio_number_sid,
            friendly_name = COALESCE(EXCLUDED.friendly_name, phone_number_settings.friendly_name),
            -- QA-MIG-004: when a number moves to a new company, drop the old
            -- tenant-scoped routing group and metadata to avoid stale scope.
            group_id = CASE WHEN phone_number_settings.company_id IS DISTINCT FROM EXCLUDED.company_id
                            THEN NULL ELSE phone_number_settings.group_id END,
            capabilities = EXCLUDED.capabilities,
            updated_at = now()`,
        [purchased.phoneNumber, friendlyName || null, companyId, purchased.sid,
         null, JSON.stringify({ voice: true, sms: true })]
    );

    auditService.log({
        actor_id: actorId, action: 'telephony.number_purchased',
        target_type: 'phone_number', target_id: purchased.phoneNumber,
        company_id: companyId, details: { sid: purchased.sid },
    }).catch(() => {});

    return { phone_number: purchased.phoneNumber, sid: purchased.sid, friendly_name: purchased.friendlyName };
}

async function listNumbers(companyId) {
    const { client } = await getClientForCompany(companyId);
    const twilioNumbers = await client.incomingPhoneNumbers.list({ limit: 100 });

    const { rows: settings } = await db.query(
        `SELECT pns.phone_number, pns.friendly_name AS local_name, pns.group_id,
                pns.routing_mode, pns.purchased_at, ug.name AS group_name
         FROM phone_number_settings pns
         LEFT JOIN user_groups ug ON ug.id = pns.group_id
         WHERE pns.company_id = $1`,
        [companyId]
    );
    const byNumber = Object.fromEntries(settings.map(s => [s.phone_number, s]));

    return twilioNumbers.map(n => ({
        sid: n.sid,
        phone_number: n.phoneNumber,
        friendly_name: byNumber[n.phoneNumber]?.local_name || n.friendlyName || n.phoneNumber,
        capabilities: { voice: !!n.capabilities?.voice, sms: !!(n.capabilities?.SMS ?? n.capabilities?.sms) },
        group_id: byNumber[n.phoneNumber]?.group_id || null,
        group_name: byNumber[n.phoneNumber]?.group_name || null,
        routing_mode: byNumber[n.phoneNumber]?.routing_mode || null,
        purchased_at: byNumber[n.phoneNumber]?.purchased_at || n.dateCreated || null,
        webhook_ok: (n.voiceUrl || '').startsWith(webhookBase()),
    }));
}

async function releaseNumber(companyId, numberSid, { actorId } = {}) {
    const { client } = await getClientForCompany(companyId);
    // Ownership check: the SID must exist INSIDE this company's (sub)account —
    // a foreign SID 404s on Twilio's side, which we surface as 404.
    let number;
    try {
        number = await client.incomingPhoneNumbers(numberSid).fetch();
    } catch (err) {
        if (err.status === 404) { const e = new Error('Number not found'); e.httpStatus = 404; throw e; }
        throw err;
    }
    await client.incomingPhoneNumbers(numberSid).remove();
    await db.query(
        `DELETE FROM phone_number_settings WHERE phone_number = $1 AND company_id = $2`,
        [number.phoneNumber, companyId]
    );
    auditService.log({
        actor_id: actorId, action: 'telephony.number_released',
        target_type: 'phone_number', target_id: number.phoneNumber,
        company_id: companyId, details: { sid: numberSid },
    }).catch(() => {});
    return { released: number.phoneNumber };
}

/** Platform admin: suspend/reactivate the tenant's subaccount. */
async function setSubaccountStatus(companyId, status, { actorId } = {}) {
    if (!['suspended', 'active'].includes(status)) {
        const err = new Error('status must be suspended|active'); err.httpStatus = 422; throw err;
    }
    const { rows } = await db.query(
        `SELECT twilio_subaccount_sid FROM company_telephony WHERE company_id = $1`,
        [companyId]
    );
    const sid = rows[0]?.twilio_subaccount_sid;
    if (!sid) return { skipped: true };

    await masterClient().api.v2010.accounts(sid).update({ status: status === 'active' ? 'active' : 'suspended' });
    await db.query(
        `UPDATE company_telephony SET status = $2,
                suspended_at = CASE WHEN $2 = 'suspended' THEN now() ELSE NULL END,
                updated_at = now()
         WHERE company_id = $1`,
        [companyId, status === 'active' ? 'connected' : 'suspended']
    );
    clientCache.delete(companyId);
    auditService.log({
        actor_id: actorId, action: `telephony.subaccount_${status}`,
        target_type: 'company', target_id: companyId, company_id: companyId,
        details: { subaccount_sid: sid },
    }).catch(() => {});
    return { ok: true };
}

// ── Softphone per tenant (Voice SDK creds in the subaccount) ─────────────────

/**
 * Ensure the tenant subaccount has an API Key + TwiML App for the browser
 * softphone. Idempotent; returns decrypted creds for token minting.
 */
async function ensureSoftphoneSetup(companyId) {
    const { rows } = await db.query(
        `SELECT twilio_subaccount_sid, twilio_auth_token_enc, twiml_app_sid, api_key_sid, api_key_secret_enc, status
         FROM company_telephony WHERE company_id = $1`,
        [companyId]
    );
    if (!rows[0]?.twilio_subaccount_sid) {
        const err = new Error('Telephony is not connected'); err.code = 'TELEPHONY_NOT_CONNECTED'; err.httpStatus = 409; throw err;
    }
    const row = rows[0];
    const { client } = await getClientForCompany(companyId);
    const base = webhookBase();

    let twimlAppSid = row.twiml_app_sid;
    if (!twimlAppSid) {
        const app = await client.applications.create({
            friendlyName: 'Albusto SoftPhone',
            voiceUrl: `${base}/api/voice/twiml/outbound`,
            voiceMethod: 'POST',
        });
        twimlAppSid = app.sid;
    }

    let apiKeySid = row.api_key_sid;
    let apiKeySecret = row.api_key_secret_enc ? decryptToken(row.api_key_secret_enc) : null;
    if (!apiKeySid || !apiKeySecret) {
        const key = await client.newKeys.create({ friendlyName: 'Albusto SoftPhone' });
        apiKeySid = key.sid;
        apiKeySecret = key.secret;
    }

    await db.query(
        `UPDATE company_telephony SET twiml_app_sid = $2, api_key_sid = $3, api_key_secret_enc = $4, updated_at = now()
         WHERE company_id = $1`,
        [companyId, twimlAppSid, apiKeySid, encryptToken(apiKeySecret)]
    );

    return {
        accountSid: row.twilio_subaccount_sid,
        apiKeySid,
        apiKeySecret,
        twimlAppSid,
    };
}

/** Softphone creds for token minting; null when not set up (caller falls back to env). */
async function getSoftphoneCreds(companyId) {
    if (!companyId || companyId === DEFAULT_COMPANY_ID) return null;
    const { rows } = await db.query(
        `SELECT twilio_subaccount_sid, twiml_app_sid, api_key_sid, api_key_secret_enc
         FROM company_telephony WHERE company_id = $1 AND status = 'connected'`,
        [companyId]
    );
    const r = rows[0];
    if (!r?.twiml_app_sid || !r?.api_key_sid || !r?.api_key_secret_enc) return null;
    return {
        accountSid: r.twilio_subaccount_sid,
        apiKeySid: r.api_key_sid,
        apiKeySecret: decryptToken(r.api_key_secret_enc),
        twimlAppSid: r.twiml_app_sid,
    };
}

// ── Usage (this month) per tenant subaccount ─────────────────────────────────

async function getUsageSummary(companyId) {
    const { client } = await getClientForCompany(companyId);
    const records = await client.usage.records.thisMonth.list({ limit: 200 });
    const pick = (cat) => records.find(r => r.category === cat);
    const totals = records.find(r => r.category === 'totalprice');
    const out = {
        period: records[0] ? { start: records[0].startDate, end: records[0].endDate } : null,
        total_usd: totals ? Number(totals.price || 0) : null,
        calls: { count: Number(pick('calls')?.count || 0), usd: Number(pick('calls')?.price || 0) },
        sms: { count: Number(pick('sms')?.count || 0), usd: Number(pick('sms')?.price || 0) },
        numbers: { count: Number(pick('phonenumbers')?.count || 0), usd: Number(pick('phonenumbers')?.price || 0) },
        recordings_usd: Number(pick('recordings')?.price || 0),
    };
    if (out.total_usd === null) {
        out.total_usd = +(out.calls.usd + out.sms.usd + out.numbers.usd + out.recordings_usd).toFixed(2);
    }
    return out;
}

module.exports = {
    getTelephonyState,
    getAutonomousMode,
    setAutonomousMode,
    connectTelephony,
    getClientForCompany,
    resolveCompanyByAccountSid,
    getAuthTokenForAccountSid,
    searchNumbers,
    buyNumber,
    listNumbers,
    releaseNumber,
    setSubaccountStatus,
    ensureSoftphoneSetup,
    getSoftphoneCreds,
    getUsageSummary,
    DEFAULT_COMPANY_ID,
    _encryptToken: encryptToken,
    _decryptToken: decryptToken,
};
