'use strict';

/**
 * GMAIL-PUSH-FIX-001 — FIX#3 observability log (TC-GPF-005).
 *
 * `emailTimelineService.ingestPushNotification` must emit exactly one
 * `[EmailPush] push handled …` console.log — WITH the processed/linked counts — on
 * the success ({handled:true}) path, and must NOT emit it when the decode resolves
 * null ({handled:false}, an unknown/foreign mailbox), so a live push can be confirmed
 * (and a dropped one distinguished) from prod logs.
 *
 * Strategy (mirrors the provider/registry mock pattern used across the email suite,
 * e.g. mailProvider.test.js / emailTimelineInbound.test.js): the seam
 * `providerRegistry.get()` returns a FAKE provider (no googleapis / Gmail / Pub-Sub).
 * `pullChanges` returns `{messages:[]}` so the link-loop is skipped and NO db is
 * touched (processed:0, linked:0). The DB / query / realtime modules that
 * emailTimelineService requires at load are stubbed so no real pool or socket is
 * created. `console.log` is spied. No new production module is required beyond the
 * service under test.
 *
 * Run:
 *   node node_modules/jest/bin/jest.js tests/emailPushIngestLog.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const util = require('util');

const COMPANY = '00000000-0000-0000-0000-00000000000a';

// ── The seam: a FAKE provider. providerRegistry.get() (called with no args) → it. ──
const mockProvider = {
    handlePushNotification: jest.fn(),
    pullChanges: jest.fn(),
};
jest.mock('../backend/src/services/mail/providerRegistry', () => ({
    get: jest.fn(() => mockProvider),
    getProvider: jest.fn(() => mockProvider),
}));

// Load-time isolation: the messages:[] path never CALLS these, but emailTimelineService
// requires them at module load — stub so no real pg pool / socket.io is constructed.
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/emailQueries', () => ({}));
jest.mock('../backend/src/db/timelinesQueries', () => ({}));
jest.mock('../backend/src/db/companyQueries', () => ({}));
jest.mock('../backend/src/db/queries', () => ({}));
jest.mock('../backend/src/services/realtimeService', () => ({
    publishMessageAdded: jest.fn(),
    broadcast: jest.fn(),
}));

const emailTimelineService = require('../backend/src/services/email/emailTimelineService');

// Any well-formed Pub/Sub envelope — the FAKE provider ignores its contents.
const ENVELOPE = {
    message: { data: Buffer.from(JSON.stringify({ emailAddress: 'mb@co.com', historyId: 777 })).toString('base64') },
};

const PUSH_LOG = /\[EmailPush\] push handled/;
// console.log here is printf-style: (format, companyId, processed, linked, skipped).
// Render each matching call with util.format so the substituted counts are assertable.
const renderedPushLogs = (spy) =>
    spy.mock.calls
        .filter((c) => typeof c[0] === 'string' && PUSH_LOG.test(c[0]))
        .map((c) => util.format(...c));

let logSpy;
beforeEach(() => {
    jest.clearAllMocks();
    mockProvider.handlePushNotification.mockResolvedValue({ companyId: COMPANY, cursor: null });
    mockProvider.pullChanges.mockResolvedValue({ messages: [] });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); });

describe('ingestPushNotification — [EmailPush] push handled log (TC-GPF-005)', () => {
    it('emits the log WITH counts on the {handled:true} success path', async () => {
        const out = await emailTimelineService.ingestPushNotification(ENVELOPE);

        expect(out).toEqual({ handled: true, company: COMPANY, processed: 0, linked: 0, skipped: 0 });

        const logs = renderedPushLogs(logSpy);
        expect(logs).toHaveLength(1);
        // counts surfaced (assert on the numbers, not exact punctuation).
        expect(logs[0]).toMatch(/company=00000000-0000-0000-0000-00000000000a/);
        expect(logs[0]).toMatch(/processed=0/);
        expect(logs[0]).toMatch(/linked=0/);
    });

    it('does NOT emit the log on the {handled:false} path (unknown mailbox → decode null)', async () => {
        mockProvider.handlePushNotification.mockResolvedValueOnce(null);

        const out = await emailTimelineService.ingestPushNotification(ENVELOPE);

        expect(out).toEqual({ handled: false });
        expect(renderedPushLogs(logSpy)).toHaveLength(0);
        // decode short-circuits BEFORE the pull — no downstream work on a foreign mailbox.
        expect(mockProvider.pullChanges).not.toHaveBeenCalled();
    });
});
