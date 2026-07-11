'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-001 — MAIL-SECRETARY ADDITIVITY over
 * emailTimelineService.linkInboundMessage (YLA-M-01, YLA-M-02).
 * Mirrors tests/emailTimelineInbound.test.js mocks + the new yelpLeadService.
 *
 * Sabotage YLA-N-03 (procedure, run manually): relocate the maybeHandleYelpLead
 * interception BELOW the no-contact reviewInboundEmail branch in linkInboundMessage.
 * Then the named check HOOK-yelp-not-reviewed (YLA-M-02) must turn RED
 * (reviewInboundEmail is now called for a Yelp lead). Revert after confirming.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpLeadHook.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockProvider = {
    getConnectionStatus: jest.fn(),
    pullChanges: jest.fn(),
    handlePushNotification: jest.fn(),
    sendMessage: jest.fn(),
};
jest.mock('../backend/src/services/mail/providerRegistry', () => ({
    get: jest.fn(() => mockProvider),
    getProvider: jest.fn(() => mockProvider),
}));
jest.mock('../backend/src/db/emailQueries', () => ({
    findEmailContact: jest.fn(),
    getMessageLinkState: jest.fn(),
    linkMessageToContact: jest.fn(),
    listUnlinkedInboundForTimeline: jest.fn(),
    listUnlinkedOutboundForTimeline: jest.fn(() => Promise.resolve([])),
    getTimelineEmailByContact: jest.fn(),
    getNewestThreadIdForContact: jest.fn(),
}));
jest.mock('../backend/src/db/timelinesQueries', () => ({
    findOrCreateTimelineByContact: jest.fn(),
    markTimelineUnread: jest.fn(),
    setActionRequired: jest.fn(),
    createTask: jest.fn(),
}));
jest.mock('../backend/src/db/queries', () => ({ markContactUnread: jest.fn() }));
jest.mock('../backend/src/db/companyQueries', () => ({ getCompanyById: jest.fn() }));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/realtimeService', () => ({
    publishMessageAdded: jest.fn(),
    broadcast: jest.fn(),
}));
jest.mock('../backend/src/services/arConfigHelper', () => ({
    getTriggerConfig: jest.fn(async () => ({ enabled: false })),
}));
jest.mock('../backend/src/services/mailAgentService', () => ({
    isSenderMuted: jest.fn(async () => false),
    reviewInboundEmail: jest.fn(async () => ({})),
    isActive: jest.fn(async () => false),
}));
// The new seam: the Yelp autoresponder. Default = not-handled (so non-Yelp mail
// behaves exactly as today).
const mockMaybeHandleYelpLead = jest.fn(async () => ({ handled: false }));
jest.mock('../backend/src/services/yelpLeadService', () => ({
    maybeHandleYelpLead: mockMaybeHandleYelpLead,
}));

const emailQueries = require('../backend/src/db/emailQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const queries = require('../backend/src/db/queries');
const realtimeService = require('../backend/src/services/realtimeService');
const mailAgentService = require('../backend/src/services/mailAgentService');
const svc = require('../backend/src/services/email/emailTimelineService');
const { yNew, nonYelp } = require('./yelpFixtures');

const COMPANY = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
    jest.clearAllMocks();
    mockMaybeHandleYelpLead.mockResolvedValue({ handled: false });
    mailAgentService.isSenderMuted.mockResolvedValue(false);
});

describe('linkInboundMessage — Yelp additivity (P0/P1)', () => {
    it('YLA-M-01: non-Yelp no-contact inbound still reaches the Mail Secretary (unchanged)', async () => {
        emailQueries.findEmailContact.mockResolvedValue(null);

        const res = await svc.linkInboundMessage(COMPANY, nonYelp());

        expect(res).toEqual({ skipped: 'no_contact' });
        expect(mailAgentService.reviewInboundEmail).toHaveBeenCalledTimes(1);
        expect(mailAgentService.reviewInboundEmail).toHaveBeenCalledWith(
            COMPANY, expect.any(Object), { noContact: true }
        );
    });

    it('YLA-M-02 · HOOK-yelp-not-reviewed: detected Yelp lead → {skipped:yelp_lead}; NO review/task/unread/SSE', async () => {
        mockMaybeHandleYelpLead.mockResolvedValue({ handled: true, skipped: 'yelp_lead' });

        const res = await svc.linkInboundMessage(COMPANY, yNew());

        expect(res).toEqual({ skipped: 'yelp_lead' });
        // The autoresponder was consulted with the ingestion company + the raw msg.
        expect(mockMaybeHandleYelpLead).toHaveBeenCalledWith(
            COMPANY, expect.objectContaining({ from_email: 'reply+8160b36a1c2d3e4f@messaging.yelp.com' })
        );
        // No Mail-Secretary review, no AR task, no unread, no SSE for a Yelp lead.
        expect(mailAgentService.reviewInboundEmail).not.toHaveBeenCalled();
        expect(timelinesQueries.createTask).not.toHaveBeenCalled();
        expect(queries.markContactUnread).not.toHaveBeenCalled();
        expect(realtimeService.publishMessageAdded).not.toHaveBeenCalled();
        // It also never reached the contact lookup.
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
    });

    it('additivity: a handler returning not-handled leaves the normal pipeline intact', async () => {
        // Yelp says not-handled → non-Yelp msg proceeds exactly as before.
        emailQueries.findEmailContact.mockResolvedValue(null);
        const res = await svc.linkInboundMessage(COMPANY, nonYelp());
        expect(mockMaybeHandleYelpLead).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ skipped: 'no_contact' });
    });

    it('fail-open: maybeHandleYelpLead throwing does NOT early-return and does NOT throw out', async () => {
        mockMaybeHandleYelpLead.mockRejectedValue(new Error('yelp boom'));
        emailQueries.findEmailContact.mockResolvedValue(null);
        const res = await svc.linkInboundMessage(COMPANY, nonYelp());
        // The try/catch around the hook keeps the pipeline running.
        expect(res).toEqual({ skipped: 'no_contact' });
    });

    it('gated on !opts.skipAgent: the agent re-entry does not re-invoke the Yelp handler', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ contact_id: 'c1' });
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 't1' });
        emailQueries.getMessageLinkState.mockResolvedValue(null);
        emailQueries.linkMessageToContact.mockResolvedValue({ id: 1, direction: 'inbound' });

        await svc.linkInboundMessage(COMPANY, nonYelp(), { skipAgent: true });
        expect(mockMaybeHandleYelpLead).not.toHaveBeenCalled();
    });
});

// YELP-LEAD-AUTORESPONDER-002 · E-03 — the Yelp path is structurally decoupled from
// the Mail Secretary: neither the detector nor the yelp_lead handler closure imports
// mailAgentService / mailAgentClassifier / reviewInboundEmail. The two are independent
// consumers of the ingest seam; removing the Secretary must not break Yelp.
describe('E-03 · module decoupling from the Mail Secretary (structural)', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

    it('yelpLeadService.js requires no mailAgentService / mailAgentClassifier / reviewInboundEmail', () => {
        const src = read('../backend/src/services/yelpLeadService.js');
        expect(src).not.toMatch(/mailAgentService|mailAgentClassifier|reviewInboundEmail/);
    });

    it('agentHandlers.js (host of the yelp_lead handler) requires no mailAgentService / reviewInboundEmail', () => {
        const src = read('../backend/src/services/agentHandlers.js');
        expect(src).toMatch(/yelp_lead/);                 // handler present…
        expect(src).not.toMatch(/mailAgentService|reviewInboundEmail/); // …with no Secretary coupling
    });
});
