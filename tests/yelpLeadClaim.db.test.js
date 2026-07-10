'use strict';

/**
 * YELP-LEAD-AUTORESPONDER-001 — REAL-POSTGRES claim / idempotency (YLA-C-02, C-03).
 * The DB seam is NOT mocked here — the UNIQUE(company_id, provider_message_id)
 * constraint (migration 162) is what we are proving. Collaborators (leadsService,
 * emailService, yelpGreetingService) ARE mocked.
 *
 * SELF-SKIPS when no test DB is reachable (or the migration is not applied): the
 * probe in beforeAll sets dbReady=false and every case no-ops with a SKIPPED-NEEDS-DB
 * warning — the run does NOT fail. To actually exercise it: point DATABASE_URL at a
 * DB with migration 162 applied.
 *
 * Sabotage YLA-N-02 (procedure, run manually, needs DB): replace the claim's
 * INSERT … ON CONFLICT DO NOTHING RETURNING with an unconditional "proceed". Then
 * the named check CLAIM-single-greet-on-reingest (YLA-C-03) must turn RED
 * (createLead/sendEmail fire twice on re-ingest). Revert after confirming.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpLeadClaim.db.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const mockCreateLead = jest.fn();
const mockSendEmail = jest.fn();
const mockBuildGreeting = jest.fn();
jest.mock('../backend/src/services/leadsService', () => ({ createLead: mockCreateLead }));
jest.mock('../backend/src/services/emailService', () => ({ sendEmail: mockSendEmail }));
jest.mock('../backend/src/services/yelpGreetingService', () => ({ buildGreeting: mockBuildGreeting }));

const db = require('../backend/src/db/connection');
const yelpLeadQueries = require('../backend/src/db/yelpLeadQueries');
const { maybeHandleYelpLead, DEFAULT_COMPANY_ID } = require('../backend/src/services/yelpLeadService');
const { yNew } = require('./yelpFixtures');

let dbReady = false;
const usedPmids = [];

function uniquePmid(tag) {
    const id = `ymsg-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    usedPmids.push(id);
    return id;
}

beforeAll(async () => {
    try {
        await db.query('SELECT 1 FROM yelp_lead_events LIMIT 1');
        dbReady = true;
    } catch (e) {
        console.warn('\n[yelpLeadClaim.db] SKIPPED-NEEDS-DB —', e.message, '\n');
        dbReady = false;
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    process.env.YELP_AUTORESPONDER_ENABLED = 'true';
    delete process.env.GEMINI_API_KEY;
    mockCreateLead.mockResolvedValue({ UUID: 'u', SerialId: 1, ClientId: '55' });
    mockSendEmail.mockResolvedValue({ provider_message_id: 'sent-1' });
    mockBuildGreeting.mockResolvedValue('Hi Kim, thanks for reaching out.');
});

afterAll(async () => {
    if (dbReady && usedPmids.length) {
        try {
            await db.query('DELETE FROM yelp_lead_events WHERE provider_message_id = ANY($1)', [usedPmids]);
        } catch (e) {
            console.warn('[yelpLeadClaim.db] cleanup failed:', e.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

describe('YLA-C-02: real Postgres — two inserts of one (company, pmid) → exactly ONE row (P0)', () => {
    it('constraint (not app logic) enforces single-claim', async () => {
        if (!dbReady) return console.warn('YLA-C-02 SKIPPED-NEEDS-DB');
        const company = DEFAULT_COMPANY_ID;
        const pmid = uniquePmid('DUP');

        const first = await yelpLeadQueries.claimYelpLead(company, pmid);
        const second = await yelpLeadQueries.claimYelpLead(company, pmid);

        expect(first.claimed).toBe(true);
        expect(second.claimed).toBe(false);

        const { rows } = await db.query(
            'SELECT count(*)::int AS n FROM yelp_lead_events WHERE company_id = $1 AND provider_message_id = $2',
            [company, pmid]
        );
        expect(rows[0].n).toBe(1);
    });
});

describe('YLA-C-03 · CLAIM-single-greet-on-reingest: re-scan → ONE lead + ONE greeting (P0)', () => {
    it('second maybeHandleYelpLead on the same pmid short-circuits at the lost claim', async () => {
        if (!dbReady) return console.warn('YLA-C-03 SKIPPED-NEEDS-DB');
        const msg = yNew({ provider_message_id: uniquePmid('C03') });

        await maybeHandleYelpLead(DEFAULT_COMPANY_ID, msg); // push
        await maybeHandleYelpLead(DEFAULT_COMPANY_ID, msg); // poll re-scan of the SAME message

        expect(mockCreateLead).toHaveBeenCalledTimes(1);
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
    });
});
