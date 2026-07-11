'use strict';

/**
 * YELP-CONVO-BOOKING-001 — CONV-ID PARSER (YCB-CID-01..05), pure unit, no IO.
 * Target: yelpConversationId.parseConversationId(msg). Depends on the extended
 * fixtures (conv-id URLs + varying reply+<hex>).
 *
 * The whole threading design rests on YCB-CID-03: three DIFFERENT relay hexes
 * (yNew 8160…, yReplyRespondable aa11…, yReply2 ee55…) must all resolve to the ONE
 * stable conv-id — proving the parser reads the body conv-id and NOTHING from
 * from_email. Named check: CID-stable-not-reply-hex.
 *
 * Sabotage SAB-CID-USE-REPLY-HEX (procedure, run manually): make the conversation
 * key derive from from_email's reply+<hex> (or provider_thread_id) instead of the
 * parsed body id. Then YCB-CID-03 turns RED — the two replies map to two different
 * keys and no longer thread to one conversation. Revert after confirming.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpConversationId.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const { parseConversationId, parseLeadId } = require('../backend/src/services/yelpConversationId');
const { CONV_ID, yNew, yReplyRespondable, yReply2, yConfirm, nonYelp } = require('./yelpFixtures');

describe('parseConversationId — both forms, fail-safe (YCB-CID-01..05)', () => {
    it('YCB-CID-01 · first-message form message_to_business_conversation/<id> → stable id', () => {
        expect(parseConversationId(yNew())).toBe('9Xk2mZ7bQ1');
        expect(parseConversationId(yNew())).toBe(CONV_ID);
    });

    it('YCB-CID-02 · reply form %2Fthread%2F<id> (URL-encoded) → SAME stable id', () => {
        expect(parseConversationId(yReplyRespondable())).toBe(CONV_ID);
        // The first email and the reply thread to ONE id.
        expect(parseConversationId(yReplyRespondable())).toBe(parseConversationId(yNew()));
    });

    it('YCB-CID-03 · CID-stable-not-reply-hex: varying reply+<hex>@ is NOT the thread key', () => {
        // Three distinct relay hexes across the fixtures…
        expect(yNew().from_email).toBe('reply+8160b36a1c2d3e4f@messaging.yelp.com');
        expect(yReplyRespondable().from_email).toBe('reply+aa11bb22cc33dd44@messaging.yelp.com');
        expect(yReply2().from_email).toBe('reply+ee55ff66aa77bb88@messaging.yelp.com');

        // …all resolve to the ONE conv-id parsed from the body.
        expect(parseConversationId(yNew())).toBe(CONV_ID);
        expect(parseConversationId(yReplyRespondable())).toBe(CONV_ID);
        expect(parseConversationId(yReply2())).toBe(CONV_ID);

        // The parser reads NOTHING from from_email: swapping the relay hex to a wild
        // value leaves the parsed id unchanged (it is the body that carries the key).
        const swapped = yReplyRespondable({ from_email: 'reply+ffffffffffffffff@messaging.yelp.com' });
        expect(parseConversationId(swapped)).toBe(CONV_ID);
    });

    it('YCB-CID-04 · no conv-id in body → null (fail-safe, no throw, not undefined)', () => {
        expect(parseConversationId(nonYelp())).toBeNull();
        // A Yelp-shaped body with the tracking URL stripped.
        const stripped = yNew({ body_text: 'Kim requested a quote from ABC Homes for a dishwasher repair.' });
        const r = parseConversationId(stripped);
        expect(r).toBeNull();
        expect(r).not.toBeUndefined();
    });

    it('YCB-CID-05 · malformed / adversarial URLs → null, never throws, never a garbage key', () => {
        const cases = [
            // truncated reply form (no id after the encoded /thread/)
            'View: https://www.yelp.com/x?url=%2Fthread%2F&utm_source=request_a_quote_new_message',
            // doubled first-message slash (no id segment)
            'View: https://www.yelp.com/message_to_business_conversation//?utm_source=x',
            // a plain, unrelated ".../thread/<x>" (NOT the encoded reply form) must not cross-thread
            'See https://example.com/thread/somethingElse for details',
            // an over-long junk run after a valid prefix → rejected by the length bound
            `x %2Fthread%2F${'A'.repeat(200)} y`,
        ];
        for (const body of cases) {
            let out;
            expect(() => { out = parseConversationId(yReplyRespondable({ body_text: body })); }).not.toThrow();
            expect(out).toBeNull();
        }
        // …but a well-formed reply form in the same hostile shape still parses cleanly.
        const ok = 'noise %2Fthread%2F9Xk2mZ7bQ1 %3Futm=1 noise';
        expect(parseConversationId(yReplyRespondable({ body_text: ok }))).toBe(CONV_ID);
    });

    it('never throws on garbage input; from_email is ignored entirely', () => {
        expect(() => parseConversationId(null)).not.toThrow();
        expect(() => parseConversationId({})).not.toThrow();
        expect(() => parseConversationId({ body_text: {} })).not.toThrow();
        expect(parseConversationId(null)).toBeNull();
        // A conv-id sitting ONLY in from_email must NOT be read (body is empty → null).
        expect(parseConversationId({ from_email: 'reply+message_to_business_conversation/9Xk2mZ7bQ1@x' })).toBeNull();
    });
});

describe('parseLeadId — optional best-effort (parallel form)', () => {
    it('returns null when the body has no message_to_business_lead/<id>', () => {
        expect(parseLeadId(yNew())).toBeNull();
        expect(parseLeadId(nonYelp())).toBeNull();
    });
    it('parses the parallel lead form when present; fail-safe on garbage', () => {
        const msg = yNew({ body_text: 'x https://www.yelp.com/message_to_business_lead/TtsMvp3tpn1SKsnOp3t5pA?y' });
        expect(parseLeadId(msg)).toBe('TtsMvp3tpn1SKsnOp3t5pA');
        expect(() => parseLeadId(null)).not.toThrow();
    });
    // yConfirm (no-reply@notify.yelp.com) has no conv-id URL either → null.
    it('yConfirm has no conv-id → null', () => {
        expect(parseConversationId(yConfirm())).toBeNull();
    });
});
