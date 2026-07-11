'use strict';

/**
 * YELP-CONVO-BOOKING-001 — REAL-POSTGRES idempotency + threading (YCB-IDEM-04/05).
 * The DB seam is NOT mocked — migrations 162 (yelp_lead_events) + 164
 * (yelp_conversations, + the conversation_id link column) are what we prove:
 *   • IDEM-04 — running the thin yelp_convo handler TWICE for one inbound
 *     provider_message_id claims ONE ledger row and advances turn_count by 1 (not 2).
 *   • IDEM-05 — three messages with DIFFERENT reply+<hex>@ but the SAME body conv-id
 *     collapse to ONE yelp_conversations row (UNIQUE(company_id, conversation_id)),
 *     with last_reply_to = the MOST RECENT hex (the varying relay is tracked per-turn
 *     but never forks the conversation — the behavioural counterpart to YCB-CID-03).
 *
 * SELF-SKIPS when no test DB (or mig 164) is reachable: the beforeAll probe sets
 * dbReady=false and each case no-ops with a SKIPPED-NEEDS-DB warning. Point
 * DATABASE_URL at a DB with migrations 100 + 136 + 162 + 163 + 164 to exercise it.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpConvoHandler.db.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

// createLead / sendEmail are never reached on the Phase-A paths under test; mock them
// defensively so an accidental call cannot hit the network.
jest.mock('../backend/src/services/leadsService', () => ({ createLead: jest.fn() }));
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: jest.fn() }));
jest.mock('../backend/src/services/yelpGreetingService', () => ({ buildGreeting: jest.fn() }));

const db = require('../backend/src/db/connection');
const convQueries = require('../backend/src/db/yelpConversationQueries');
const agentHandlers = require('../backend/src/services/agentHandlers');
const { maybeHandleYelpReply, DEFAULT_COMPANY_ID } = require('../backend/src/services/yelpLeadService');
const { convTask } = require('./yelpFixtures');

const COMPANY = DEFAULT_COMPANY_ID;
let dbReady = false;
const usedConvIds = [];
const usedPmids = [];

function uniq(tag) {
    return `${tag}${Date.now()}${Math.floor(Math.random() * 1e6)}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}
// A respondable reply carrying MY conv-id in the encoded reply form + a fresh hex.
function replyWithConv(convId, hex) {
    const pmid = `ymsg-${convId}-${hex}`;
    usedPmids.push(pmid);
    return {
        provider_message_id: pmid,
        provider_thread_id: 'ythr-DB',
        from_email: `reply+${hex}@messaging.yelp.com`,
        from_name: 'Kim L.',
        subject: 'Re: quote',
        body_text: `Kim replied. View: https://www.yelp.com/mail/click?url=%2Fthread%2F${convId}&utm_source=request_a_quote_new_message_respondable`,
        labelIds: ['INBOX'],
        is_outbound: false,
    };
}

beforeAll(async () => {
    try {
        await db.query('SELECT 1 FROM yelp_conversations LIMIT 1');
        dbReady = true;
    } catch (e) {
        console.warn('\n[yelpConvoHandler.db] SKIPPED-NEEDS-DB —', e.message, '\n');
        dbReady = false;
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    process.env.YELP_AUTORESPONDER_ENABLED = 'true';
});

afterAll(async () => {
    if (dbReady) {
        try {
            if (usedPmids.length) {
                await db.query('DELETE FROM tasks WHERE agent_type = $1 AND company_id = $2', ['yelp_convo', COMPANY]);
                await db.query('DELETE FROM yelp_lead_events WHERE provider_message_id = ANY($1)', [usedPmids]);
            }
            if (usedConvIds.length) {
                await db.query('DELETE FROM yelp_conversations WHERE conversation_id = ANY($1)', [usedConvIds]);
            }
        } catch (e) {
            console.warn('[yelpConvoHandler.db] cleanup failed:', e.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

describe('YCB-IDEM-04 · re-run same inbound pmid → one claim, one turn (real DB)', () => {
    it('handler twice for one provider_message_id → turn_count advances by 1', async () => {
        if (!dbReady) return console.warn('YCB-IDEM-04 SKIPPED-NEEDS-DB');
        const convId = uniq('cid04');
        const pmid = `ymsg-idem04-${convId}`;
        usedConvIds.push(convId);
        usedPmids.push(pmid);

        // seed one OPEN conversation (turn_count 0)
        await convQueries.upsertConversation(COMPANY, convId, {
            lead_uuid: '00000000-0000-0000-0000-0000000000aa', phase: 'collect', status: 'open',
        });

        const task = convTask({ agent_input: { conversation_id: convId, inbound_provider_message_id: pmid } });
        const first = await agentHandlers.run(task);
        const second = await agentHandlers.run(task);

        expect(first).toMatchObject({ acked: true, turn_count: 1 });
        expect(second).toMatchObject({ skipped: 'already_handled_inbound' });

        const ledger = await db.query(
            'SELECT count(*)::int AS n FROM yelp_lead_events WHERE company_id=$1 AND provider_message_id=$2',
            [COMPANY, pmid]);
        expect(ledger.rows[0].n).toBe(1);                 // one claim row

        const conv = await convQueries.getByConvId(COMPANY, convId);
        expect(conv.turn_count).toBe(1);                  // advanced by 1, not 2
    });
});

describe('YCB-IDEM-05 · varying reply+<hex>, same conv-id → ONE row, newest last_reply_to (real DB)', () => {
    it('first upsert + two replies (aa11, ee55) → count=1, last_reply_to=ee55', async () => {
        if (!dbReady) return console.warn('YCB-IDEM-05 SKIPPED-NEEDS-DB');
        const convId = uniq('cid05');
        usedConvIds.push(convId);

        // first message establishes the row (upsert), pointing at yNew's hex 8160…
        await convQueries.upsertConversation(COMPANY, convId, {
            lead_uuid: '00000000-0000-0000-0000-0000000000bb', phase: 'greet', status: 'open',
            last_reply_to: 'reply+8160b36a1c2d3e4f@messaging.yelp.com',
        });

        // two respondable replies, different relay hexes, SAME conv-id
        await maybeHandleYelpReply(COMPANY, replyWithConv(convId, 'aa11bb22cc33dd44'));
        await maybeHandleYelpReply(COMPANY, replyWithConv(convId, 'ee55ff66aa77bb88'));

        const cnt = await db.query(
            'SELECT count(*)::int AS n FROM yelp_conversations WHERE company_id=$1 AND conversation_id=$2',
            [COMPANY, convId]);
        expect(cnt.rows[0].n).toBe(1);                    // UNIQUE collapses all turns to one row

        const conv = await convQueries.getByConvId(COMPANY, convId);
        expect(conv.last_reply_to).toBe('reply+ee55ff66aa77bb88@messaging.yelp.com'); // newest hex
    });
});
