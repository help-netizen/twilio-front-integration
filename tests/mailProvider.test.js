'use strict';

/**
 * EMAIL-TIMELINE-001 — provider seam (MailProvider / GmailProvider / providerRegistry).
 * Covers TC-ET-037 (AC-12 static seam: timeline layer has no Gmail imports),
 * TC-ET-038 (base stubs throw "not implemented"), TC-ET-039 (GmailProvider.sendMessage
 * reply-vs-new on providerThreadId), TC-ET-040 (handlePushNotification decode + resolve),
 * and providerRegistry.get returning the provider.
 *
 * Strategy: googleapis + the EMAIL-001 services GmailProvider delegates to are mocked
 * so constructing/exercising it touches no network. The AC-12 case is a pure
 * source-text assertion (regex over the files) — no execution.
 *
 * Run:
 *   npx jest --runTestsByPath tests/mailProvider.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

// googleapis is imported at the top of GmailProvider for users.watch/stop only.
jest.mock('googleapis', () => ({ google: { gmail: jest.fn(() => ({ users: {} })) } }));
jest.mock('../backend/src/services/emailMailboxService', () => ({
    getValidAccessToken: jest.fn(),
    createOAuth2Client: jest.fn(() => ({ setCredentials: jest.fn() })),
    getMailboxStatus: jest.fn(),
}));
jest.mock('../backend/src/services/emailSyncService', () => ({ pullChangesNormalized: jest.fn() }));
jest.mock('../backend/src/services/emailService', () => ({
    replyToThread: jest.fn(),
    sendEmail: jest.fn(),
}));
jest.mock('../backend/src/db/emailQueries', () => ({
    getMailboxByEmail: jest.fn(),
    updateWatchState: jest.fn(),
    clearWatchState: jest.fn(),
}));

const fs = require('fs');
const path = require('path');

const MailProvider = require('../backend/src/services/mail/MailProvider');
const providerRegistry = require('../backend/src/services/mail/providerRegistry');
const GmailProvider = require('../backend/src/services/mail/GmailProvider');
const emailService = require('../backend/src/services/emailService');
const emailQueries = require('../backend/src/db/emailQueries');

const SRC = path.join(__dirname, '..', 'backend', 'src');
const COMPANY = '00000000-0000-0000-0000-00000000000a';

beforeEach(() => jest.clearAllMocks());

// ─── MailProvider base — every method throws "not implemented" (P2, TC-ET-038) ─────

describe('MailProvider base stubs (TC-ET-038)', () => {
    const base = new MailProvider();

    it('all base methods throw "not implemented"', async () => {
        await expect(base.getConnectionStatus(COMPANY)).rejects.toThrow(/not implemented/);
        await expect(base.startWatch(COMPANY)).rejects.toThrow(/not implemented/);
        await expect(base.renewWatch(COMPANY)).rejects.toThrow(/not implemented/);
        await expect(base.stopWatch(COMPANY)).rejects.toThrow(/not implemented/);
        await expect(base.handlePushNotification({})).rejects.toThrow(/not implemented/);
        await expect(base.pullChanges(COMPANY, '1')).rejects.toThrow(/not implemented/);
        await expect(base.sendMessage(COMPANY, {})).rejects.toThrow(/not implemented/);
    });

    it('GmailProvider extends MailProvider and overrides every base method', () => {
        const p = new GmailProvider();
        expect(p).toBeInstanceOf(MailProvider);
        for (const m of ['getConnectionStatus', 'startWatch', 'renewWatch', 'stopWatch',
            'handlePushNotification', 'pullChanges', 'sendMessage']) {
            expect(p[m]).not.toBe(MailProvider.prototype[m]); // genuinely overridden
        }
    });
});

// ─── providerRegistry.get — returns a MailProvider (the seam handle) ───────────────

describe('providerRegistry', () => {
    it('get() / getProvider() return the same GmailProvider singleton (a MailProvider)', () => {
        const a = providerRegistry.get(COMPANY);
        const b = providerRegistry.getProvider(COMPANY);
        expect(a).toBeInstanceOf(MailProvider);
        expect(a).toBe(b);
    });
});

// ─── GmailProvider.sendMessage — reply vs new on providerThreadId (P1, TC-ET-039) ──

describe('GmailProvider.sendMessage (TC-ET-039)', () => {
    const p = new GmailProvider();

    it('providerThreadId present → replyToThread(companyId, threadId, …); returns ids', async () => {
        emailService.replyToThread.mockResolvedValue({ provider_message_id: 'm1', provider_thread_id: 't1' });
        const out = await p.sendMessage(COMPANY, { to: 'a@b.com', body: 'hi', providerThreadId: 't1' });
        // Signature is replyToThread(companyId, providerThreadId, { to, subject, body, userId, userEmail }).
        expect(emailService.replyToThread).toHaveBeenCalledWith(
            COMPANY, 't1', expect.objectContaining({ to: 'a@b.com', body: 'hi' })
        );
        expect(emailService.sendEmail).not.toHaveBeenCalled();
        expect(out).toEqual({ provider_message_id: 'm1', provider_thread_id: 't1' });
    });

    it('no providerThreadId → sendEmail(companyId, …) (new thread); returns ids', async () => {
        emailService.sendEmail.mockResolvedValue({ provider_message_id: 'm2', provider_thread_id: 't2' });
        const out = await p.sendMessage(COMPANY, { to: 'a@b.com', subject: 'Message from Acme', body: 'hi' });
        expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
        expect(emailService.sendEmail.mock.calls[0][0]).toBe(COMPANY);
        expect(emailService.replyToThread).not.toHaveBeenCalled();
        expect(out).toEqual({ provider_message_id: 'm2', provider_thread_id: 't2' });
    });

    it('inReplyTo (without providerThreadId) also takes the reply branch', async () => {
        emailService.replyToThread.mockResolvedValue({ provider_message_id: 'm3', provider_thread_id: 't3' });
        await p.sendMessage(COMPANY, { to: 'a@b.com', body: 'hi', inReplyTo: '<msg@id>' });
        expect(emailService.replyToThread).toHaveBeenCalledTimes(1);
        expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('sendMessage is the one method that propagates (does NOT swallow) errors', async () => {
        const err = new Error('reconnect'); err.statusCode = 409;
        emailService.sendEmail.mockRejectedValue(err);
        await expect(p.sendMessage(COMPANY, { to: 'a@b.com', body: 'hi' })).rejects.toThrow('reconnect');
    });
});

// ─── GmailProvider.handlePushNotification — decode + resolve mailbox (P1, TC-ET-040) ─

describe('GmailProvider.handlePushNotification (TC-ET-040)', () => {
    const p = new GmailProvider();
    const envelope = (obj) => ({
        message: { data: Buffer.from(JSON.stringify(obj)).toString('base64') },
    });

    it('decodes {emailAddress, historyId} → {companyId, cursor} from getMailboxByEmail', async () => {
        emailQueries.getMailboxByEmail.mockResolvedValue({ company_id: COMPANY });
        const out = await p.handlePushNotification(envelope({ emailAddress: 'mb@co.com', historyId: 777 }));
        expect(emailQueries.getMailboxByEmail).toHaveBeenCalledWith('mb@co.com');
        expect(out).toEqual({ companyId: COMPANY, cursor: '777' });
    });

    it('unknown/foreign mailbox → null (no throw)', async () => {
        emailQueries.getMailboxByEmail.mockResolvedValue(null);
        await expect(p.handlePushNotification(envelope({ emailAddress: 'who@dis.com', historyId: 1 })))
            .resolves.toBeNull();
    });

    it('missing message.data → null (no throw)', async () => {
        await expect(p.handlePushNotification({ message: {} })).resolves.toBeNull();
        expect(emailQueries.getMailboxByEmail).not.toHaveBeenCalled();
    });

    it('decode error (bad base64 JSON) → null (safe-fail, no throw)', async () => {
        const bad = { message: { data: Buffer.from('not json').toString('base64') } };
        await expect(p.handlePushNotification(bad)).resolves.toBeNull();
    });
});

// ─── AC-12 static seam — no Gmail imports leak into the timeline layer (P0, TC-ET-037) ─

describe('AC-12 seam: timeline layer has no Gmail / EMAIL-001 imports (TC-ET-037)', () => {
    const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

    // require('googleapis') / require("googleapis") in any quote style.
    const requires = (src, mod) =>
        new RegExp(`require\\(\\s*['"\`]${mod.replace(/[/\\]/g, '\\$&')}['"\`]\\s*\\)`).test(src);

    it('emailTimelineService.js imports neither googleapis nor the EMAIL-001 services directly', () => {
        const src = read('services/email/emailTimelineService.js');
        expect(requires(src, 'googleapis')).toBe(false);
        expect(requires(src, '../emailService')).toBe(false);
        expect(requires(src, '../emailSyncService')).toBe(false);
        expect(requires(src, '../emailMailboxService')).toBe(false);
        // It DOES depend on the seam + the query layer.
        expect(requires(src, '../mail/providerRegistry')).toBe(true);
    });

    it('MailProvider.js + providerRegistry.js contain no require("googleapis")', () => {
        expect(requires(read('services/mail/MailProvider.js'), 'googleapis')).toBe(false);
        expect(requires(read('services/mail/providerRegistry.js'), 'googleapis')).toBe(false);
    });

    it('GmailProvider.js is the ONE place allowed to import googleapis (sanity: it does)', () => {
        // Confirms the assertion above is meaningful — the dependency exists, just confined here.
        expect(requires(read('services/mail/GmailProvider.js'), 'googleapis')).toBe(true);
    });
});
