'use strict';

/**
 * YELP-CONVO-CONTEXT-002 T3 — post-send Yelp agent-message linker.
 * Covers TC-B1-02, TC-B3-01, TC-B4-01, TC-B4-02, TC-B5-02,
 * TC-B7-01, TC-B8-01, TC-B-ARGS-01, and the helper warn share of TC-D2-01.
 */

const fs = require('fs');
const util = require('util');

const mockProvider = {
    pullChanges: jest.fn(),
};

jest.mock('../backend/src/services/mail/providerRegistry', () => ({
    get: jest.fn(() => mockProvider),
    getProvider: jest.fn(() => mockProvider),
}));

jest.mock('../backend/src/db/emailQueries', () => ({
    getMessageLinkState: jest.fn(),
    linkMessageToContact: jest.fn(),
    markThreadRead: jest.fn(),
    markReadAfterReply: jest.fn(),
    createContact: jest.fn(),
    findOrCreateContact: jest.fn(),
}));

jest.mock('../backend/src/db/timelinesQueries', () => ({
    findOrCreateTimelineByContact: jest.fn(),
    markTimelineUnread: jest.fn(),
    markContactUnread: jest.fn(),
    setActionRequired: jest.fn(),
}));

jest.mock('../backend/src/db/companyQueries', () => ({
    getCompanyById: jest.fn(),
}));

jest.mock('../backend/src/db/queries', () => ({
    markContactUnread: jest.fn(),
}));

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
}));

jest.mock('../backend/src/services/realtimeService', () => ({
    publishMessageAdded: jest.fn(),
    broadcast: jest.fn(),
}));

const providerRegistry = require('../backend/src/services/mail/providerRegistry');
const emailQueries = require('../backend/src/db/emailQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const queries = require('../backend/src/db/queries');
const db = require('../backend/src/db/connection');
const realtimeService = require('../backend/src/services/realtimeService');
const { linkYelpAgentSend } = require('../backend/src/services/email/emailTimelineService');
const { DEFAULT_COMPANY_ID } = require('./yelpFixtures');

const PMID = 'sent-1';
const THREAD = 'gt-sent-1';
const TL = 3207;
const YELP_REPLY = 'reply+aa11bb22cc33dd44@messaging.yelp.com';

function sentRow(overrides = {}) {
    return {
        id: 9,
        thread_id: 77,
        provider_thread_id: THREAD,
        direction: 'outbound',
        from_name: 'Acme Support',
        from_email: 'mb@co.com',
        to_recipients_json: [YELP_REPLY],
        subject: 'Message from Acme',
        body_text: 'Hi Kim — new text\n\n' +
            'On Fri, Jul 11, 2026 at 5:39 PM Kim H. ' +
            `<${YELP_REPLY}> wrote:\n> old quoted`,
        body_html: '<p>Hi Kim — new text</p>',
        snippet: null,
        gmail_internal_at: '2026-06-23T13:00:00.000Z',
        sent_by_user_email: 'agent@co.com',
        ...overrides,
    };
}

function linkArgs(overrides = {}) {
    return {
        providerMessageId: PMID,
        providerThreadId: THREAD,
        timelineId: TL,
        ...overrides,
    };
}

let errorSpy;
let warnSpy;

beforeEach(() => {
    jest.clearAllMocks();
    mockProvider.pullChanges.mockResolvedValue({ messages: [], cursor: null });
    emailQueries.getMessageLinkState.mockResolvedValue(null);
    emailQueries.linkMessageToContact.mockResolvedValue(sentRow());
    db.query.mockResolvedValue({ rows: [] });
    realtimeService.publishMessageAdded.mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('linkYelpAgentSend', () => {
    it('TC-B1-02: fresh contactless link publishes one refetch-shaped SSE item', async () => {
        const result = await linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs());

        expect(result).toEqual({ linked: true, outcome: 'linked', timelineId: TL });
        expect(emailQueries.getMessageLinkState).toHaveBeenCalledWith(PMID, DEFAULT_COMPANY_ID);
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledWith(
            PMID,
            DEFAULT_COMPANY_ID,
            { contact_id: null, timeline_id: TL, on_timeline: true }
        );
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 9,
                type: 'email',
                direction: 'outbound',
                is_outbound: true,
                from_email: 'mb@co.com',
                to_email: [YELP_REPLY],
                subject: 'Message from Acme',
                body_text: 'Hi Kim — new text',
                body_html: '<p>Hi Kim — new text</p>',
                sent_at: '2026-06-23T13:00:00.000Z',
                thread_id: 77,
                sent_by_user_email: 'agent@co.com',
            }),
            { id: null },
            TL
        );
        expect(mockProvider.pullChanges).not.toHaveBeenCalled();
    });

    it('TC-B3-01: matching timeline is already_linked with no SSE; another timeline is fresh', async () => {
        emailQueries.getMessageLinkState.mockResolvedValue({
            on_timeline: true,
            timeline_id: TL,
        });

        await expect(linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs())).resolves.toEqual({
            linked: true,
            outcome: 'already_linked',
            timelineId: TL,
        });
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledTimes(1);
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();

        emailQueries.getMessageLinkState.mockResolvedValue({
            on_timeline: true,
            timeline_id: 9999,
        });
        await expect(linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs())).resolves.toEqual({
            linked: true,
            outcome: 'linked',
            timelineId: TL,
        });
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
    });

    it('TC-B4-01: hydration lag reimports once, retries once, then publishes', async () => {
        emailQueries.linkMessageToContact
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(sentRow());

        await expect(linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs())).resolves.toEqual({
            linked: true,
            outcome: 'relinked_after_reimport',
            timelineId: TL,
        });
        expect(providerRegistry.get.mock.calls[0]).toEqual([]);
        expect(mockProvider.pullChanges).toHaveBeenCalledTimes(1);
        expect(mockProvider.pullChanges).toHaveBeenCalledWith(DEFAULT_COMPANY_ID, null);
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledTimes(2);
        expect(realtimeService.publishMessageAdded).toHaveBeenCalledTimes(1);
    });

    it('TC-B4-02/TC-D2-01: two missing rows resolve no_row, warn, and publish nothing', async () => {
        emailQueries.linkMessageToContact.mockResolvedValue(null);

        await expect(linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs())).resolves.toEqual({
            linked: false,
            outcome: 'no_row',
            timelineId: TL,
        });
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledTimes(2);
        expect(mockProvider.pullChanges).toHaveBeenCalledTimes(1);
        const warningLines = warnSpy.mock.calls.map(call => util.format(...call));
        expect(warningLines).toHaveLength(1);
        expect(warningLines[0]).toMatch(/^\[EmailTimeline\] linkYelpAgentSend: no_row /);
        expect(warningLines[0]).toContain(`company ${DEFAULT_COMPANY_ID}`);
        expect(warningLines[0]).toContain(`thread ${THREAD}`);
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });

    it('TC-B4-02: a reimport rejection is swallowed before the honest no_row result', async () => {
        emailQueries.linkMessageToContact.mockResolvedValue(null);
        mockProvider.pullChanges.mockRejectedValue(new Error('history walk boom'));

        await expect(linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs())).resolves.toEqual({
            linked: false,
            outcome: 'no_row',
            timelineId: TL,
        });
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls.map(call => util.format(...call)).join('\n'))
            .toContain('thread re-import failed');
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
    });

    it('TC-B5-02: a database failure resolves error and never rejects', async () => {
        emailQueries.getMessageLinkState.mockRejectedValue(new Error('pg exploded'));

        await expect(linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs())).resolves.toEqual({
            linked: false,
            outcome: 'error',
            timelineId: TL,
        });
        expect(errorSpy.mock.calls.map(call => util.format(...call)).join('\n'))
            .toContain('pg exploded');
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
    });

    it('TC-B5-02: an SSE failure is swallowed without changing the successful link outcome', async () => {
        realtimeService.publishMessageAdded.mockImplementation(() => {
            throw new Error('sse down');
        });

        await expect(linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs())).resolves.toEqual({
            linked: true,
            outcome: 'linked',
            timelineId: TL,
        });
        expect(errorSpy.mock.calls.map(call => util.format(...call)).join('\n'))
            .toContain('sse down');
    });

    it('TC-B7-01: fresh/already/no_row/error paths never touch unread or AR', async () => {
        await linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs());

        emailQueries.getMessageLinkState.mockResolvedValue({ on_timeline: true, timeline_id: TL });
        await linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs());

        emailQueries.getMessageLinkState.mockResolvedValue(null);
        emailQueries.linkMessageToContact.mockResolvedValue(null);
        await linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs());

        emailQueries.getMessageLinkState.mockRejectedValue(new Error('pg exploded'));
        await linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs());

        expect(emailQueries.markThreadRead).not.toHaveBeenCalled();
        expect(emailQueries.markReadAfterReply).not.toHaveBeenCalled();
        expect(timelinesQueries.markTimelineUnread).not.toHaveBeenCalled();
        expect(timelinesQueries.markContactUnread).not.toHaveBeenCalled();
        expect(timelinesQueries.setActionRequired).not.toHaveBeenCalled();
        expect(queries.markContactUnread).not.toHaveBeenCalled();

        const source = fs.readFileSync(
            require.resolve('../backend/src/services/email/emailTimelineService'),
            'utf8'
        );
        const start = source.indexOf('async function linkYelpAgentSend');
        const end = source.indexOf('\nmodule.exports = {', start);
        const helperBody = source.slice(start, end);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        for (const forbidden of [
            'markThreadRead',
            'markReadAfterReply',
            'markTimelineUnread',
            'markContactUnread',
            'setActionRequired',
            'markGreeted',
            'createContact',
            'findOrCreateContact',
        ]) {
            expect(helperBody).not.toContain(forbidden);
        }
    });

    it('TC-B8-01: every attempted write explicitly preserves contact_id NULL', async () => {
        await linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs());

        emailQueries.getMessageLinkState.mockResolvedValue({ on_timeline: true, timeline_id: TL });
        await linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs());

        emailQueries.getMessageLinkState.mockResolvedValue(null);
        emailQueries.linkMessageToContact.mockResolvedValue(null);
        await linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs());

        emailQueries.getMessageLinkState.mockRejectedValue(new Error('pg exploded'));
        await linkYelpAgentSend(DEFAULT_COMPANY_ID, linkArgs());

        expect(emailQueries.linkMessageToContact.mock.calls).toHaveLength(4);
        for (const call of emailQueries.linkMessageToContact.mock.calls) {
            const write = call[2];
            expect(Object.prototype.hasOwnProperty.call(write, 'contact_id')).toBe(true);
            expect(write.contact_id).toBeNull();
        }
        expect(emailQueries.createContact).not.toHaveBeenCalled();
        expect(emailQueries.findOrCreateContact).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
    });

    it('TC-B-ARGS-01: missing provider message or timeline returns error with zero IO', async () => {
        await expect(linkYelpAgentSend(DEFAULT_COMPANY_ID, {
            providerMessageId: null,
            providerThreadId: THREAD,
            timelineId: TL,
        })).resolves.toEqual({ linked: false, outcome: 'error', timelineId: TL });

        await expect(linkYelpAgentSend(DEFAULT_COMPANY_ID, {
            providerMessageId: PMID,
            providerThreadId: THREAD,
            timelineId: null,
        })).resolves.toEqual({ linked: false, outcome: 'error', timelineId: null });

        expect(emailQueries.getMessageLinkState).not.toHaveBeenCalled();
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(providerRegistry.get).not.toHaveBeenCalled();
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(2);
    });
});
