/**
 * ALB-107 — telephonyTenantService unit tests.
 */

process.env.TELEPHONY_TOKEN_KEY = 'test-telephony-key';
process.env.TWILIO_ACCOUNT_SID = 'ACmaster00000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'master-token';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/twilioClient', () => ({ getTwilioClient: jest.fn() }));

const db = require('../backend/src/db/connection');
const svc = require('../backend/src/services/telephonyTenantService');

const COMPANY = '11111111-1111-1111-1111-111111111111';

beforeEach(() => db.query.mockReset());

describe('token encryption at rest', () => {
    it('round-trips and never stores plaintext', () => {
        const enc = svc._encryptToken('sub-secret-token');
        expect(enc).not.toContain('sub-secret-token');
        expect(enc.split(':')).toHaveLength(3); // iv:tag:ciphertext
        expect(svc._decryptToken(enc)).toBe('sub-secret-token');
    });
});

describe('getTelephonyState', () => {
    it('default company is always connected in master mode', async () => {
        const st = await svc.getTelephonyState(svc.DEFAULT_COMPANY_ID);
        expect(st).toMatchObject({ connected: true, mode: 'master' });
        expect(db.query).not.toHaveBeenCalled();
    });

    it('tenant without a subaccount → not connected', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const st = await svc.getTelephonyState(COMPANY);
        expect(st).toEqual({ connected: false });
    });
});

describe('getClientForCompany', () => {
    it('fails closed when company context is absent', async () => {
        await expect(svc.getClientForCompany())
            .rejects.toMatchObject({ code: 'TWILIO_TENANT_UNRESOLVED', httpStatus: 403 });
        expect(db.query).not.toHaveBeenCalled();
    });

    it('throws TELEPHONY_NOT_CONNECTED for an unconnected tenant', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(svc.getClientForCompany(COMPANY))
            .rejects.toMatchObject({ code: 'TELEPHONY_NOT_CONNECTED', httpStatus: 409 });
    });

    it('throws TELEPHONY_SUSPENDED for a suspended tenant', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ twilio_subaccount_sid: 'ACsub', twilio_auth_token_enc: svc._encryptToken('t'), status: 'suspended' }],
        });
        await expect(svc.getClientForCompany(COMPANY))
            .rejects.toMatchObject({ code: 'TELEPHONY_SUSPENDED', httpStatus: 403 });
    });
});

describe('resolveCompanyByAccountSid', () => {
    it('master AccountSid → default company', async () => {
        const out = await svc.resolveCompanyByAccountSid(process.env.TWILIO_ACCOUNT_SID);
        expect(out).toBe(svc.DEFAULT_COMPANY_ID);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('subaccount AccountSid → its tenant', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ company_id: COMPANY }] });
        const out = await svc.resolveCompanyByAccountSid('ACsub123');
        expect(out).toBe(COMPANY);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain("status = 'connected'");
        expect(params).toEqual(['ACsub123']);
    });

    it('unknown AccountSid → null (never default fallback)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        expect(await svc.resolveCompanyByAccountSid('ACghost')).toBeNull();
    });
});

describe('getAuthTokenForAccountSid', () => {
    it('missing sid does not fall back to the master token', async () => {
        expect(await svc.getAuthTokenForAccountSid()).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });

    it('master sid → master token; subaccount sid → decrypted token', async () => {
        expect(await svc.getAuthTokenForAccountSid(process.env.TWILIO_ACCOUNT_SID)).toBe('master-token');
        db.query.mockResolvedValueOnce({ rows: [{ twilio_auth_token_enc: svc._encryptToken('sub-token') }] });
        expect(await svc.getAuthTokenForAccountSid('ACsub')).toBe('sub-token');
    });
});

describe('buyNumber validation', () => {
    it('rejects non-E.164 input before any Twilio call', async () => {
        await expect(svc.buyNumber(svc.DEFAULT_COMPANY_ID, { phoneNumber: '617-555' }))
            .rejects.toMatchObject({ httpStatus: 422 });
    });
});

// ── Phase 2 ──────────────────────────────────────────────────────────────────

describe('getSoftphoneCreds', () => {
    it('default company → null (env-based legacy path)', async () => {
        expect(await svc.getSoftphoneCreds(svc.DEFAULT_COMPANY_ID)).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });

    it('returns decrypted creds when the subaccount is provisioned', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{
                twilio_subaccount_sid: 'ACsub',
                twiml_app_sid: 'APx',
                api_key_sid: 'SKx',
                api_key_secret_enc: svc._encryptToken('key-secret'),
            }],
        });
        const creds = await svc.getSoftphoneCreds(COMPANY);
        expect(creds).toEqual({ accountSid: 'ACsub', apiKeySid: 'SKx', apiKeySecret: 'key-secret', twimlAppSid: 'APx' });
    });

    it('returns null when softphone is not provisioned yet', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ twilio_subaccount_sid: 'ACsub', twiml_app_sid: null, api_key_sid: null, api_key_secret_enc: null }] });
        expect(await svc.getSoftphoneCreds(COMPANY)).toBeNull();
    });
});

describe('iOS Voice Push Credential storage', () => {
    const PUSH_SID = `CR${'a'.repeat(32)}`;
    const previousEnv = process.env.TWILIO_IOS_PUSH_CREDENTIAL_SID;

    afterEach(() => {
        if (previousEnv === undefined) delete process.env.TWILIO_IOS_PUSH_CREDENTIAL_SID;
        else process.env.TWILIO_IOS_PUSH_CREDENTIAL_SID = previousEnv;
    });

    it('uses the env fallback only for the master/default company', async () => {
        process.env.TWILIO_IOS_PUSH_CREDENTIAL_SID = PUSH_SID;
        db.query.mockResolvedValue({ rows: [] });

        await expect(svc.getIosPushCredentialSid(svc.DEFAULT_COMPANY_ID)).resolves.toBe(PUSH_SID);
        await expect(svc.getIosPushCredentialSid(COMPANY)).resolves.toBeNull();
        expect(db.query.mock.calls[1][0]).toContain("status = 'connected'");
    });

    it('prefers the tenant-scoped stored SID and upserts only that company row', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ ios_push_credential_sid: PUSH_SID }] })
            .mockResolvedValueOnce({ rows: [{ ios_push_credential_sid: PUSH_SID }] });

        await expect(svc.getIosPushCredentialSid(COMPANY)).resolves.toBe(PUSH_SID);
        await expect(svc.setIosPushCredentialSid(COMPANY, PUSH_SID)).resolves.toBe(PUSH_SID);

        expect(db.query.mock.calls[0][1]).toEqual([COMPANY]);
        expect(db.query.mock.calls[1][0]).toMatch(/ON CONFLICT \(company_id\)/);
        expect(db.query.mock.calls[1][1]).toEqual([COMPANY, PUSH_SID]);
    });
});

describe('a2pService.validateBusinessInfo', () => {
    const a2p = require('../backend/src/services/a2pService');
    const valid = {
        legal_name: 'Acme LLC', ein: '12-3456789', website: 'https://acme.com',
        address_street: '1 Main St', address_city: 'Boston', address_state: 'MA', address_zip: '02101',
        contact_first_name: 'Jane', contact_last_name: 'Doe',
        contact_email: 'j@acme.com', contact_phone: '+16175550100',
    };

    it('accepts a complete profile', () => {
        expect(() => a2p.validateBusinessInfo(valid)).not.toThrow();
    });

    it('rejects missing fields with a 422', () => {
        try {
            a2p.validateBusinessInfo({ ...valid, ein: '' });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.httpStatus).toBe(422);
            expect(err.message).toContain('ein');
        }
    });

    it('rejects malformed EIN', () => {
        try {
            a2p.validateBusinessInfo({ ...valid, ein: '12345' });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.httpStatus).toBe(422);
        }
    });
});
