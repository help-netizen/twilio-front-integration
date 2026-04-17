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
