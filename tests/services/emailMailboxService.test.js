/**
 * EmailMailboxService — Unit Tests
 * Token encryption, OAuth state signing, mailbox lifecycle.
 */

// Mock dependencies
jest.mock('../../backend/src/db/emailQueries', () => ({
    getMailboxByCompany: jest.fn(),
    getMailboxWithTokens: jest.fn(),
    upsertMailbox: jest.fn(),
    updateMailboxStatus: jest.fn(),
    updateMailboxTokens: jest.fn(),
    disconnectMailbox: jest.fn(),
    upsertSyncState: jest.fn(),
}));

jest.mock('googleapis', () => ({
    google: {
        auth: { OAuth2: jest.fn().mockImplementation(() => ({
            generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?test'),
            getToken: jest.fn().mockResolvedValue({ tokens: { access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600000 } }),
            setCredentials: jest.fn(),
            refreshAccessToken: jest.fn().mockResolvedValue({ credentials: { access_token: 'new_at', expiry_date: Date.now() + 3600000 } }),
        }))},
        gmail: jest.fn().mockReturnValue({
            users: {
                getProfile: jest.fn().mockResolvedValue({ data: { emailAddress: 'test@company.com', historyId: '12345' } }),
            },
        }),
    },
}));

// Set required env vars BEFORE importing the module
process.env.EMAIL_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64); // 32-byte hex
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.EMAIL_OAUTH_STATE_SECRET = 'test-state-secret';

const emailMailboxService = require('../../backend/src/services/emailMailboxService');
const emailQueries = require('../../backend/src/db/emailQueries');

describe('emailMailboxService', () => {
    beforeEach(() => jest.clearAllMocks());

    // ─── Encryption ──────────────────────────────────────────────────────
    describe('encrypt/decrypt', () => {
        test('round-trips plaintext correctly', () => {
            const plaintext = 'my-secret-token-12345';
            const encrypted = emailMailboxService.encrypt(plaintext);
            const decrypted = emailMailboxService.decrypt(encrypted);
            expect(decrypted).toBe(plaintext);
        });

        test('encrypted output is different from plaintext', () => {
            const plaintext = 'access-token';
            const encrypted = emailMailboxService.encrypt(plaintext);
            expect(encrypted).not.toBe(plaintext);
            expect(encrypted).toContain(':'); // iv:authTag:data format
        });

        test('different encryptions of same value produce different ciphertext', () => {
            const plaintext = 'same-token';
            const e1 = emailMailboxService.encrypt(plaintext);
            const e2 = emailMailboxService.encrypt(plaintext);
            expect(e1).not.toBe(e2); // random IV
        });
    });

    // ─── OAuth state signing ─────────────────────────────────────────────
    describe('signOAuthState/validateOAuthState', () => {
        test('produces a valid signed state that can be validated', () => {
            const state = emailMailboxService.signOAuthState('company-123', 'user-456');
            const payload = emailMailboxService.validateOAuthState(state);
            expect(payload).not.toBeNull();
            expect(payload.company_id).toBe('company-123');
            expect(payload.user_id).toBe('user-456');
        });

        test('rejects tampered state', () => {
            const state = emailMailboxService.signOAuthState('company-123', 'user-456');
            const tampered = state.slice(0, -4) + 'xxxx';
            expect(emailMailboxService.validateOAuthState(tampered)).toBeNull();
        });

        test('rejects invalid format', () => {
            expect(emailMailboxService.validateOAuthState('invalid')).toBeNull();
            expect(emailMailboxService.validateOAuthState('')).toBeNull();
        });
    });

    // ─── buildAuthUrl ────────────────────────────────────────────────────
    describe('buildAuthUrl', () => {
        test('returns a Google OAuth URL', () => {
            const url = emailMailboxService.buildAuthUrl('company-123', 'user-456');
            expect(url).toContain('accounts.google.com');
        });
    });

    // ─── getMailboxStatus ────────────────────────────────────────────────
    describe('getMailboxStatus', () => {
        test('returns null when no mailbox exists', async () => {
            emailQueries.getMailboxByCompany.mockResolvedValue(null);
            const result = await emailMailboxService.getMailboxStatus('company-1');
            expect(result).toBeNull();
        });

        test('returns mailbox without encrypted tokens', async () => {
            emailQueries.getMailboxByCompany.mockResolvedValue({
                id: 'mb-1',
                provider: 'gmail',
                email_address: 'test@company.com',
                status: 'connected',
                access_token_encrypted: 'should-not-appear',
                refresh_token_encrypted: 'should-not-appear',
                last_synced_at: '2026-04-17T00:00:00Z',
                last_sync_status: 'ok',
                last_sync_error: null,
                created_at: '2026-04-17T00:00:00Z',
            });

            const result = await emailMailboxService.getMailboxStatus('company-1');
            expect(result.email_address).toBe('test@company.com');
            expect(result.status).toBe('connected');
            expect(result.access_token_encrypted).toBeUndefined();
            expect(result.refresh_token_encrypted).toBeUndefined();
        });
    });

    // ─── getDecryptedTokens — undecryptable tokens ───────────────────────
    //
    // Regression: a token the current key cannot open used to let the raw crypto
    // error ("Invalid key length" / "unable to authenticate data") escape
    // getDecryptedTokens → getValidAccessToken → sendInvoice, where the route
    // turned it into `500 {"code":"INTERNAL","message":"Invalid key length"}`.
    // getMailboxStatus does NOT decrypt, so the send paths' own pre-check still
    // reported `connected` and waved the send through to fail unguarded.
    //
    // Contract now: undecryptable ⇒ reconnect_required (recorded), and a
    // 409-shaped error — the shape invoicesService / estimatesService /
    // paymentsService / emailTimelineService already map to MAILBOX_NOT_CONNECTED.
    describe('getDecryptedTokens — undecryptable token', () => {
        // Seal a token under a DIFFERENT 32-byte key, in this service's own
        // `iv:authTag:data` hex envelope. This is the real-world case: the key was
        // rotated while mailbox rows still hold tokens from the previous one.
        function encryptUnderForeignKey(plaintext) {
            const crypto = require('crypto');
            const foreignKey = Buffer.from('b'.repeat(64), 'hex'); // module's key is 'a'*64
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', foreignKey, iv);
            const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
            return [
                iv.toString('hex'),
                cipher.getAuthTag().toString('hex'),
                data.toString('hex'),
            ].join(':');
        }

        beforeEach(() => {
            jest.spyOn(console, 'error').mockImplementation(() => {});
            emailQueries.getMailboxWithTokens.mockResolvedValue({
                id: 'mb-1',
                company_id: 'c1',
                status: 'connected',
                access_token_encrypted: encryptUnderForeignKey('stale-access-token'),
                refresh_token_encrypted: encryptUnderForeignKey('stale-refresh-token'),
                token_expires_at: new Date(Date.now() + 3600000),
            });
            emailQueries.updateMailboxStatus.mockResolvedValue({ id: 'mb-1', status: 'reconnect_required' });
        });

        afterEach(() => { console.error.mockRestore(); });

        test('throws the 409-shaped error the send paths map to MAILBOX_NOT_CONNECTED', async () => {
            await expect(emailMailboxService.getDecryptedTokens('c1')).rejects.toMatchObject({
                statusCode: 409,
                code: 'MAILBOX_RECONNECT_REQUIRED',
            });
        });

        test('flips the mailbox to reconnect_required with a last_sync_error', async () => {
            await expect(emailMailboxService.getDecryptedTokens('c1')).rejects.toThrow();

            expect(emailQueries.updateMailboxStatus).toHaveBeenCalledWith('mb-1', expect.objectContaining({
                status: 'reconnect_required',
                last_sync_status: 'error',
                last_sync_error: expect.stringMatching(/could not be decrypted/i),
            }));
        });

        test('never leaks the crypto internal to the caller', async () => {
            const err = await emailMailboxService.getDecryptedTokens('c1').catch(e => e);
            expect(err.message).toBe('Mailbox requires reconnection');
            expect(err.message).not.toMatch(/invalid key length|unable to authenticate|cipher|decipher/i);
        });

        test('getValidAccessToken propagates the 409 unchanged (no 500 upstream)', async () => {
            await expect(emailMailboxService.getValidAccessToken('c1')).rejects.toMatchObject({
                statusCode: 409,
                code: 'MAILBOX_RECONNECT_REQUIRED',
            });
        });

        // The pre-check the send paths run BEFORE deciding to send reads the same row
        // and must now agree — this is what turns the failure into an up-front 409.
        test('the recorded status is what getMailboxStatus will report next', async () => {
            await expect(emailMailboxService.getDecryptedTokens('c1')).rejects.toThrow();
            const [, patch] = emailQueries.updateMailboxStatus.mock.calls[0];

            emailQueries.getMailboxByCompany.mockResolvedValue({ id: 'mb-1', status: patch.status });
            const status = await emailMailboxService.getMailboxStatus('c1');
            expect(status.status).not.toBe('connected'); // ⇒ 409 before any Gmail call
        });
    });

    // ─── A broken KEY is not a broken tenant row ─────────────────────────
    describe('getDecryptedTokens — EMAIL_TOKEN_ENCRYPTION_KEY itself is malformed', () => {
        let isolatedService;
        let isolatedQueries;
        const REAL_KEY = process.env.EMAIL_TOKEN_ENCRYPTION_KEY;

        beforeEach(() => {
            jest.spyOn(console, 'error').mockImplementation(() => {});
            jest.resetModules();
            process.env.EMAIL_TOKEN_ENCRYPTION_KEY = 'abc123'; // set, but not 32 bytes
            jest.isolateModules(() => {
                isolatedService = require('../../backend/src/services/emailMailboxService');
                isolatedQueries = require('../../backend/src/db/emailQueries');
            });
            isolatedQueries.getMailboxWithTokens.mockResolvedValue({
                id: 'mb-1',
                company_id: 'c1',
                status: 'connected',
                access_token_encrypted: 'aa:bb:cc',
            });
        });

        afterEach(() => {
            process.env.EMAIL_TOKEN_ENCRYPTION_KEY = REAL_KEY;
            jest.resetModules();
            console.error.mockRestore();
        });

        test('still 409-shaped — the client is never handed "Invalid key length"', async () => {
            const err = await isolatedService.getDecryptedTokens('c1').catch(e => e);
            expect(err.statusCode).toBe(409);
            expect(err.code).toBe('MAILBOX_ENCRYPTION_KEY_INVALID');
            expect(err.message).not.toMatch(/invalid key length/i);
        });

        // A server-wide misconfiguration must NOT mark tenant rows: nothing flips a
        // mailbox back to 'connected' except a fresh OAuth connect, so flipping here
        // would make every company re-authorize after ops merely fixes the env var.
        test('does NOT touch mailbox rows', async () => {
            await expect(isolatedService.getDecryptedTokens('c1')).rejects.toThrow();
            expect(isolatedQueries.updateMailboxStatus).not.toHaveBeenCalled();
        });
    });

    // ─── connectMailbox ──────────────────────────────────────────────────
    describe('connectMailbox', () => {
        test('upserts mailbox with encrypted tokens and creates sync state', async () => {
            emailQueries.upsertMailbox.mockResolvedValue({ id: 'mb-new', company_id: 'c1' });
            emailQueries.upsertSyncState.mockResolvedValue({});

            const result = await emailMailboxService.connectMailbox({
                companyId: 'c1',
                userId: 'u1',
                tokens: { access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600000 },
                profile: { email_address: 'test@company.com', history_id: '99' },
            });

            expect(emailQueries.upsertMailbox).toHaveBeenCalledTimes(1);
            const call = emailQueries.upsertMailbox.mock.calls[0][0];
            expect(call.company_id).toBe('c1');
            expect(call.email_address).toBe('test@company.com');
            expect(call.access_token_encrypted).not.toBe('at'); // encrypted
            expect(call.status).toBe('connected');

            expect(emailQueries.upsertSyncState).toHaveBeenCalledTimes(1);
        });
    });

    // ─── disconnectMailbox ───────────────────────────────────────────────
    describe('disconnectMailbox', () => {
        test('disconnects existing mailbox', async () => {
            emailQueries.getMailboxByCompany.mockResolvedValue({ id: 'mb-1' });
            emailQueries.disconnectMailbox.mockResolvedValue({ id: 'mb-1', status: 'disconnected' });

            const result = await emailMailboxService.disconnectMailbox('c1', 'u1');
            expect(emailQueries.disconnectMailbox).toHaveBeenCalledWith('mb-1', 'u1');
            expect(result.status).toBe('disconnected');
        });

        test('returns null when no mailbox exists', async () => {
            emailQueries.getMailboxByCompany.mockResolvedValue(null);
            const result = await emailMailboxService.disconnectMailbox('c1', 'u1');
            expect(result).toBeNull();
        });
    });
});
