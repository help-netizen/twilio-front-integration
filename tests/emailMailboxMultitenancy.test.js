'use strict';

/**
 * EMAIL-001 / EMAIL-TIMELINE-001 — multi-tenant ISOLATION guards (audit gaps).
 *
 * GAP #1 (HIGH) — one Gmail address may be connected by at most ONE workspace:
 *   (a) emailQueries.upsertMailbox translates a Postgres 23505 (the migration-130
 *       uniq_email_mailboxes_address index) into a 409 EMAIL_ALREADY_CONNECTED_ELSEWHERE,
 *       and connectMailbox propagates it.
 *   (b) a SAME-company reconnect (the ON CONFLICT (company_id, provider) upsert) still
 *       succeeds — no 409.
 *   (c) getMailboxByEmail (the push-payload → tenant resolver) is deterministic:
 *       its SQL carries `ORDER BY updated_at DESC NULLS LAST, id ASC` before LIMIT 1.
 *
 * GAP #2 (LOW) — OAuth state is never signed with a hardcoded public secret:
 *   (d) with EMAIL_OAUTH_STATE_SECRET unset the module loads with a RANDOM per-process
 *       secret (no throw), and a state it signs is NOT verifiable under the old
 *       hardcoded literal.
 *
 * Strategy: mock the raw `db` pool (./connection) so emailQueries' OWN translation /
 * SQL is exercised over controllable rows/errors — we are testing emailQueries, not
 * Postgres. emailMailboxService is tested twice: once with a mocked emailQueries (to
 * prove the 409 propagates through connectMailbox), and once in an ISOLATED module
 * registry with the env var deleted (to prove the STATE_SECRET fallback is random).
 *
 * Run:
 *   npx jest --runTestsByPath tests/emailMailboxMultitenancy.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

const crypto = require('crypto');

const OLD_HARDCODED_STATE_SECRET = 'blanc-email-oauth-state-secret';

// ───────────────────────────────────────────────────────────────────────────
// GAP #1 (a)+(b)+(c): emailQueries over a mocked db pool.
// ───────────────────────────────────────────────────────────────────────────
describe('emailQueries — multi-tenant isolation (GAP #1)', () => {
    let emailQueries;
    let db;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../backend/src/db/connection', () => ({ query: jest.fn() }));
        emailQueries = require('../backend/src/db/emailQueries');
        db = require('../backend/src/db/connection');
    });

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    test('(a) upsertMailbox translates a 23505 (cross-tenant address collision) into a 409 EMAIL_ALREADY_CONNECTED_ELSEWHERE', async () => {
        const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "uniq_email_mailboxes_address"'), { code: '23505' });
        db.query.mockRejectedValueOnce(pgErr);

        await expect(emailQueries.upsertMailbox({
            company_id: 'company-B',
            email_address: 'shared@gmail.com',
            access_token_encrypted: 'enc',
        })).rejects.toMatchObject({
            httpStatus: 409,
            code: 'EMAIL_ALREADY_CONNECTED_ELSEWHERE',
        });
    });

    test('(a) a non-23505 db error is rethrown untranslated (not masked as a 409)', async () => {
        const other = Object.assign(new Error('connection terminated'), { code: '57P01' });
        db.query.mockRejectedValueOnce(other);

        await expect(emailQueries.upsertMailbox({
            company_id: 'company-B',
            email_address: 'shared@gmail.com',
        })).rejects.toMatchObject({ code: '57P01' });
    });

    test('(b) SAME-company reconnect succeeds — the ON CONFLICT (company_id, provider) upsert returns a row, no 409', async () => {
        const row = { id: 'mb-1', company_id: 'company-A', email_address: 'shared@gmail.com', status: 'connected' };
        db.query.mockResolvedValueOnce({ rows: [row] });

        const result = await emailQueries.upsertMailbox({
            company_id: 'company-A',
            email_address: 'shared@gmail.com',
            access_token_encrypted: 'enc',
        });
        expect(result).toEqual(row);
        // The upsert SQL still routes the same-company case through ON CONFLICT (company_id, provider).
        expect(db.query.mock.calls[0][0]).toContain('ON CONFLICT (company_id, provider)');
    });

    test('(c) getMailboxByEmail is deterministic — SQL carries ORDER BY updated_at DESC NULLS LAST, id ASC before LIMIT 1', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 'mb-1', company_id: 'company-A' }] });

        const mailbox = await emailQueries.getMailboxByEmail('Shared@Gmail.com');
        expect(mailbox).toMatchObject({ company_id: 'company-A' });

        const sql = db.query.mock.calls[0][0];
        expect(sql).toMatch(/ORDER BY\s+updated_at DESC NULLS LAST,\s*id ASC/);
        expect(sql).toContain('LIMIT 1');
        expect(sql).toContain('lower(email_address) = lower($1)');
        // case-insensitive resolution: the raw address is passed through, lower()'d in SQL
        expect(db.query.mock.calls[0][1]).toEqual(['Shared@Gmail.com']);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// GAP #1 (a) continued: the 409 propagates through the service layer.
// ───────────────────────────────────────────────────────────────────────────
describe('emailMailboxService.connectMailbox — propagates the 409 (GAP #1)', () => {
    let emailMailboxService;
    let emailQueries;

    beforeEach(() => {
        jest.resetModules();
        process.env.EMAIL_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
        process.env.GOOGLE_CLIENT_ID = 'test-client-id';
        process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
        process.env.EMAIL_OAUTH_STATE_SECRET = 'test-state-secret';
        jest.doMock('../backend/src/db/emailQueries', () => ({
            upsertMailbox: jest.fn(),
            upsertSyncState: jest.fn(),
        }));
        jest.doMock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn() }, gmail: jest.fn() } }));
        emailMailboxService = require('../backend/src/services/emailMailboxService');
        emailQueries = require('../backend/src/db/emailQueries');
    });

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    test('(a) a 409 thrown by upsertMailbox surfaces unchanged from connectMailbox; sync state is NOT initialized', async () => {
        const conflict = Object.assign(new Error('This Google account is already connected to another workspace.'), {
            httpStatus: 409, code: 'EMAIL_ALREADY_CONNECTED_ELSEWHERE',
        });
        emailQueries.upsertMailbox.mockRejectedValueOnce(conflict);

        await expect(emailMailboxService.connectMailbox({
            companyId: 'company-B',
            userId: 'u1',
            tokens: { access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600000 },
            profile: { email_address: 'shared@gmail.com' },
        })).rejects.toMatchObject({ httpStatus: 409, code: 'EMAIL_ALREADY_CONNECTED_ELSEWHERE' });

        // The conflict short-circuits before sync-state init (no half-connected mailbox).
        expect(emailQueries.upsertSyncState).not.toHaveBeenCalled();
    });

    test('(b) SAME-company reconnect resolves a mailbox and initializes sync state (no throw)', async () => {
        emailQueries.upsertMailbox.mockResolvedValueOnce({ id: 'mb-1', company_id: 'company-A' });
        emailQueries.upsertSyncState.mockResolvedValueOnce({});

        const mailbox = await emailMailboxService.connectMailbox({
            companyId: 'company-A',
            userId: 'u1',
            tokens: { access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600000 },
            profile: { email_address: 'shared@gmail.com', history_id: '99' },
        });
        expect(mailbox).toMatchObject({ id: 'mb-1' });
        expect(emailQueries.upsertSyncState).toHaveBeenCalledTimes(1);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// GAP #2 (d): STATE_SECRET is random (never the old hardcoded literal) when unset.
// ───────────────────────────────────────────────────────────────────────────
describe('emailMailboxService — STATE_SECRET hardening (GAP #2)', () => {
    const ENV_KEYS = ['EMAIL_OAUTH_STATE_SECRET', 'EMAIL_TOKEN_ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
    let saved;
    let warnSpy;

    beforeEach(() => {
        jest.resetModules();
        saved = {};
        for (const k of ENV_KEYS) saved[k] = process.env[k];
        // The point of the test: EMAIL_OAUTH_STATE_SECRET is UNSET at module load.
        delete process.env.EMAIL_OAUTH_STATE_SECRET;
        process.env.EMAIL_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
        process.env.GOOGLE_CLIENT_ID = 'test-client-id';
        process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
        jest.doMock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn() }, gmail: jest.fn() } }));
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
        jest.resetModules();
        jest.clearAllMocks();
    });

    // Recompute what the OLD vulnerable code would have produced for the same payload:
    // an HMAC over the SAME base64url(payload) using the hardcoded literal. If the
    // module still used that literal, this would validate. It must not.
    function hmacUnderOldSecret(encoded) {
        const payload = Buffer.from(encoded, 'base64url').toString('utf8');
        return crypto.createHmac('sha256', OLD_HARDCODED_STATE_SECRET).update(payload).digest('hex');
    }

    test('(d) module loads (no throw) and warns when EMAIL_OAUTH_STATE_SECRET is unset', () => {
        expect(() => require('../backend/src/services/emailMailboxService')).not.toThrow();
        expect(warnSpy).toHaveBeenCalled();
        expect(String(warnSpy.mock.calls[0][0])).toContain('EMAIL_OAUTH_STATE_SECRET');
    });

    test('(d) a signed state is NOT forgeable under the old hardcoded literal, yet round-trips under the live secret', () => {
        const svc = require('../backend/src/services/emailMailboxService');
        const state = svc.signOAuthState('company-123', 'user-456');
        const [encoded, hmac] = state.split('.');

        // The real signature must differ from what the hardcoded-literal code would have made.
        expect(hmac).not.toBe(hmacUnderOldSecret(encoded));

        // Forging a state with the old public literal must be rejected by validateOAuthState.
        const forged = `${encoded}.${hmacUnderOldSecret(encoded)}`;
        expect(svc.validateOAuthState(forged)).toBeNull();

        // The genuinely-signed state still validates (random secret is internally consistent).
        const ok = svc.validateOAuthState(state);
        expect(ok).toMatchObject({ company_id: 'company-123', user_id: 'user-456' });
    });

    test('(d) two separate process loads mint DIFFERENT random secrets (not a shared constant)', () => {
        const svc1 = require('../backend/src/services/emailMailboxService');
        const s1 = svc1.signOAuthState('c', 'u');
        jest.resetModules();
        jest.doMock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn() }, gmail: jest.fn() } }));
        const svc2 = require('../backend/src/services/emailMailboxService');
        const s2 = svc2.signOAuthState('c', 'u');
        // Different per-process secrets ⇒ a state from load #1 does not validate under load #2.
        expect(svc2.validateOAuthState(s1)).toBeNull();
        // And the second module signs its own states consistently.
        expect(svc2.validateOAuthState(s2)).toMatchObject({ company_id: 'c', user_id: 'u' });
    });
});
