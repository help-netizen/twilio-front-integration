'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-001 — DETECTION truth table (YLA-D-01..07).
 * Target: yelpLeadService.detectYelpLead(msg) (pure; no I/O).
 *
 * Sabotage YLA-N-01 (procedure, run manually): in detectYelpLead make the
 * @messaging.yelp.com domain check always-true (drop the AND). Then the named
 * checks DET-reply-not-detected (YLA-D-02) and DET-confirm-not-detected (YLA-D-03)
 * must turn RED. Revert after confirming.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpLeadService.detect.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

// Keep the suite hermetic: mock the DB seam so requiring the service opens no pool.
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const { detectYelpLead } = require('../backend/src/services/yelpLeadService');
const { yNew, yReply, yConfirm, nonYelp } = require('./yelpFixtures');

describe('detectYelpLead — truth table (P0)', () => {
    it('YLA-D-01: new-lead sample → DETECTED (relay domain + first_message signal)', () => {
        expect(detectYelpLead(yNew())).toBeTruthy();
    });

    it('YLA-D-02 · DET-reply-not-detected: customer reply (request_a_quote_new_message) → NOT detected', () => {
        // Same relay domain, but no first-message signal → must stay out.
        expect(detectYelpLead(yReply())).toBeFalsy();
    });

    it('YLA-D-03 · DET-confirm-not-detected: no-reply@notify.yelp.com confirmation → NOT detected', () => {
        // notify.yelp.com !== messaging.yelp.com — the domain gate rejects it even
        // though the word "request" appears.
        expect(detectYelpLead(yConfirm())).toBeFalsy();
    });

    it('YLA-D-04: non-Yelp email → NOT detected (fails the domain gate)', () => {
        expect(detectYelpLead(nonYelp())).toBeFalsy();
    });

    it('YLA-D-05: domain match is case-insensitive; bare-address From still resolves', () => {
        const msg = yNew({ from_email: 'reply+abc123@Messaging.Yelp.Com' });
        expect(detectYelpLead(msg)).toBeTruthy();
    });

    it('YLA-D-06: utm present but NON-Yelp domain → NOT (both conditions required)', () => {
        const msg = yNew({
            from_email: 'marketing@othersite.com',
            body_text: 'Promo! click https://x.com/?utm_source=request_a_quote_first_message',
        });
        expect(detectYelpLead(msg)).toBeFalsy();
    });

    it('YLA-D-07: messaging.yelp.com but NO first-message signal → NOT (domain alone insufficient)', () => {
        const msg = yNew({
            from_email: 'reply+xyz789@messaging.yelp.com',
            body_text: 'This is a routine Yelp system notice with no quote request at all.',
        });
        expect(detectYelpLead(msg)).toBeFalsy();
    });

    it('guards: null / missing from_email → NOT detected, never throws', () => {
        expect(detectYelpLead(null)).toBeFalsy();
        expect(detectYelpLead({})).toBeFalsy();
        expect(detectYelpLead({ body_text: 'utm_source=request_a_quote_first_message' })).toBeFalsy();
    });
});
