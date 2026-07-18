/**
 * LIST-PAGINATION-001
 *
 * The Pulse sidebar list endpoint GET /api/calls/by-contact is now ONE
 * timeline-rooted, SQL-ordered, offset/limit page unifying calls + SMS + email.
 *
 * Two layers are covered:
 *   1. DB layer  — timelinesQueries.getUnifiedTimelinePage emits the right SQL
 *      (mandatory company scope, channel-scoped laterals, GREATEST over 3
 *      channels, COUNT(*) OVER(), the 3 sort bands + timeline_id DESC tiebreak,
 *      LIMIT/OFFSET). Asserted on the emitted SQL string + params, mocking the
 *      db connection (house style, cf. contactsPulseTenantIsolation.test.js).
 *   2. Route layer — the handler preserves DB order (no JS re-sort), returns the
 *      exact envelope, paginates (page-2 disjoint from page-1 over a 120-row
 *      fixture), surfaces email-only / AR rows, and hard-rejects a missing
 *      tenant with no page query.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const http = require('http');
const express = require('express');
const db = require('../backend/src/db/connection');
const timelinesQueries = require('../backend/src/db/timelinesQueries');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';

beforeEach(() => db.query.mockReset());

// ─── Layer 1: getUnifiedTimelinePage SQL ──────────────────────────────────────

describe('getUnifiedTimelinePage — SQL shape', () => {
    async function run(opts = {}) {
        db.query.mockResolvedValue({ rows: [] });
        await timelinesQueries.getUnifiedTimelinePage({
            limit: 50, offset: 0, companyId: COMPANY_A, ...opts,
        });
        return db.query.mock.calls[0]; // [sql, params]
    }

    // EMAIL-OUTBOUND-001: slice the emitted SQL down to the email_by_contact CTE
    // (from the WITH intro to the first top-level select column), so CTE-shape
    // assertions cannot accidentally match tokens from the outer query.
    function cteSlice(sql) {
        const start = sql.indexOf('WITH email_by_contact AS');
        const end = sql.indexOf('latest_call.*');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        return sql.slice(start, end);
    }

    it('company scope is mandatory: outer WHERE + param $1 = companyId', async () => {
        const [sql, params] = await run();
        expect(sql).toContain('tl.company_id = $1');
        expect(params[0]).toBe(COMPANY_A);
        // companyId must NEVER be interpolated into the SQL text.
        expect(sql).not.toContain(COMPANY_A);
    });

    it('SMS lateral is company-scoped (closes the cross-tenant SMS leak)', async () => {
        const [sql] = await run();
        expect(sql).toContain('sc.company_id = tl.company_id');
    });

    it('email lateral / CTE is company-scoped to $1 (Scope A, normalized from_email)', async () => {
        const [sql] = await run();
        expect(sql).toContain('em.company_id = $1');
        expect(sql).toContain('et.company_id = $1');
        // Scope A: inbound from_email → contact_emails.email_normalized → contact.
        expect(sql).toContain("em.direction = 'inbound'");
        expect(sql).toContain('ce.email_normalized = lower(trim(em.from_email))');
    });

    it('last_interaction_at = GREATEST over all THREE channels (email term gated by MAIL-MUTE-001)', async () => {
        const [sql] = await run();
        // MAIL-MUTE-001 wraps ONLY the email term in `CASE WHEN NOT em.email_muted …`
        // so a muted email no longer bumps ordering; call/SMS terms are unchanged.
        // YELP-TIMELINE-DEDUP-001 appends the contactless timeline-email leg
        // (eml_tl.last_message_at) as a 4th GREATEST arg so a Yelp conv-id timeline
        // orders by its latest message; call/SMS/contact-email terms are unchanged.
        expect(sql).toContain(
            'GREATEST(latest_call.started_at, sms.last_message_at, CASE WHEN NOT em.email_muted THEN eml.last_message_at END, eml_tl.last_message_at)'
        );
        // Call & SMS remain the first two GREATEST args, byte-for-byte.
        expect(sql).toContain('GREATEST(latest_call.started_at, sms.last_message_at,');
    });

    it('any_unread rolls up timeline + sms + email + contact', async () => {
        const [sql] = await run();
        expect(sql).toContain('COALESCE(eml.unread_count, 0) > 0');
        expect(sql).toContain('COALESCE(co.has_unread, false)');
    });

    it('total = COUNT(*) OVER() on the unified set', async () => {
        const [sql] = await run();
        expect(sql).toContain('COUNT(*) OVER()');
    });

    it('ORDER BY = AR-band CASE + unread band + last_interaction DESC + timeline_id DESC tiebreak', async () => {
        const [sql] = await run();
        const orderIdx = sql.indexOf('ORDER BY');
        expect(orderIdx).toBeGreaterThan(-1);
        const order = sql.slice(orderIdx);
        // Band 1: Action-Required (open task) AND not snoozed → 0
        expect(order).toContain('open_task.id IS NOT NULL');
        expect(order).toContain('tl.snoozed_until IS NULL OR tl.snoozed_until <= now()');
        // AR rows ordered by action_required_set_at DESC
        expect(order).toContain('tl.action_required_set_at END DESC NULLS LAST');
        // Band 2: any-unread
        expect(order).toContain('tl.has_unread = true');
        // Band 3: recency — the ORDER-BY GREATEST mirrors the SELECT exactly, so the
        // email term is likewise gated by MAIL-MUTE-001 (ranking must not desync from
        // the reported last_interaction_at); call/SMS terms unchanged.
        // YELP-TIMELINE-DEDUP-001: the ORDER-BY GREATEST likewise gains the
        // eml_tl.last_message_at leg so ranking stays in sync with the SELECT value.
        expect(order).toContain(
            'GREATEST(latest_call.started_at, sms.last_message_at, CASE WHEN NOT em.email_muted THEN eml.last_message_at END, eml_tl.last_message_at) DESC'
        );
        // Deterministic final tiebreak
        expect(order.trimEnd().endsWith('tl.id DESC') || order.includes('tl.id DESC\n')).toBe(true);
        expect(order).toContain('tl.id DESC');
    });

    it('LIMIT/OFFSET are parameterized ($2 limit, $3 offset)', async () => {
        const [sql, params] = await run({ limit: 50, offset: 100 });
        expect(sql).toContain('LIMIT $2 OFFSET $3');
        expect(params[1]).toBe(50);
        expect(params[2]).toBe(100);
    });

    // BLOCKER 1 — an open-task-only timeline (no call/sms/email, is_action_required
    // false, has_unread false) must still SURFACE. The regression was a WHERE that
    // dropped `open_task.id IS NOT NULL`; the AR band pins exactly those rows, so
    // the surfacing predicate must include it (mirrors the pre-rewrite route).
    it('surfacing WHERE includes open_task.id IS NOT NULL (open-task-only rows appear)', async () => {
        const [sql] = await run();
        // The outer WHERE is uniquely `WHERE tl.company_id = $1` (inner laterals use
        // their own aliases); the top-level ORDER BY is the LAST one (laterals/CTE
        // have their own earlier ORDER BYs).
        const whereIdx = sql.indexOf('WHERE tl.company_id = $1');
        const orderIdx = sql.lastIndexOf('ORDER BY');
        expect(whereIdx).toBeGreaterThan(-1);
        expect(orderIdx).toBeGreaterThan(whereIdx);
        const where = sql.slice(whereIdx, orderIdx);
        expect(where).toContain('open_task.id IS NOT NULL');
        // The full surfacing set (all 3 channels + open task + legacy flag + unread).
        expect(where).toContain('latest_call.id IS NOT NULL');
        expect(where).toContain('sms.sms_conversation_id IS NOT NULL');
        expect(where).toContain('eml.email_thread_id IS NOT NULL');
        expect(where).toContain('tl.is_action_required = true');
        expect(where).toContain('tl.has_unread = true');
    });

    // BLOCKER 2 — a contactless orphan timeline whose phone is already covered by a
    // contact-linked timeline (primary OR secondary) in the same company must be
    // dropped IN SQL, before the LIMIT, so a person with a leftover orphan on a
    // secondary number does not appear twice.
    it('orphan-shadow dedup: WHERE has the contact_id-IS-NULL NOT EXISTS exclusion', async () => {
        const [sql] = await run();
        const whereIdx = sql.indexOf('WHERE tl.company_id = $1');
        const orderIdx = sql.lastIndexOf('ORDER BY');
        const where = sql.slice(whereIdx, orderIdx);
        // The exclusion only fires for orphans (contact_id IS NULL) …
        expect(where).toContain('tl.contact_id IS NULL');
        // … and only when a contact-linked timeline in the same company covers the
        // orphan's phone via primary OR secondary.
        expect(where).toContain('FROM timelines tl2');
        expect(where).toContain('JOIN contacts c2 ON c2.id = tl2.contact_id');
        expect(where).toContain('tl2.company_id = tl.company_id');
        expect(where).toMatch(/c2\.phone_e164/);
        expect(where).toMatch(/c2\.secondary_phone/);
        // Guard against '' = '' matching a digit-less orphan/contact (NULLIF).
        expect(where).toContain('NULLIF(regexp_replace(tl.phone_e164');
        // It is a NOT (...) exclusion, i.e. removes rows rather than requiring them.
        expect(where).toMatch(/AND NOT \(/);
    });

    // SHOULD-FIX — AR must mean ONE thing. Both the WHERE surfacing and the ORDER BY
    // tier-0 band key on open_task.id (the signal the frontend pins on); the legacy
    // is_action_required is a surfacing-only signal, never the pin.
    it('AR signal is consistent: open_task.id in BOTH the surfacing WHERE and the tier-0 ORDER BY band', async () => {
        const [sql] = await run();
        // Strip -- line comments so token assertions test real SQL, not prose.
        const code = sql.replace(/--[^\n]*/g, '');
        const whereIdx = code.indexOf('WHERE tl.company_id = $1');
        const orderIdx = code.lastIndexOf('ORDER BY');
        const where = code.slice(whereIdx, orderIdx);
        const order = code.slice(orderIdx);
        // Same AR signal on both sides.
        expect(where).toContain('open_task.id IS NOT NULL');
        expect(order).toContain('open_task.id IS NOT NULL');
        // The tier-0 (value 0) band is guarded by open_task.id + not-snoozed.
        expect(order).toMatch(/CASE WHEN open_task\.id IS NOT NULL\s+AND \(tl\.snoozed_until IS NULL OR tl\.snoozed_until <= now\(\)\)\s+THEN 0/);
        // is_action_required is NEVER used to pin (absent from the real ORDER BY SQL).
        expect(order).not.toContain('is_action_required');
    });

    it('search: lead-name subquery is company-scoped (l.company_id) + covers sms/email', async () => {
        const [sql, params] = await run({ search: 'Acme' });
        expect(sql).toContain('l.company_id = tl.company_id');
        expect(sql).toContain('sms.friendly_name ILIKE');
        // Must reference the CTE's aliased column `email_subject`, NOT `eml.subject`
        // (which doesn't exist on the CTE and 500s the search path in real Postgres).
        expect(sql).toContain('eml.email_subject ILIKE');
        expect(sql).not.toContain('eml.subject ILIKE');
        expect(params).toContain('%Acme%');
    });

    // ─── EMAIL-OUTBOUND-001 — direction-agnostic email CTE (TC-EO-U02…U07) ──────
    // The email_by_contact CTE is now a two-leg UNION ALL: leg 1 (inbound) stays
    // byte-identical to the pre-change CTE (its predicates are pinned by the
    // existing tests above, untouched — TC-EO-U01); leg 2 (outbound) reads ONLY
    // the persisted mig-129 link. The cases below pin the NEW shape.

    it('email CTE is a two-leg UNION ALL; outbound leg carries the three exact persisted-link predicates (TC-EO-U02)', async () => {
        const [sql] = await run();
        const cte = cteSlice(sql);
        expect(cte).toContain('UNION ALL');
        // Outbound leg reads ONLY the persisted mig-129 link — exact predicate text.
        expect(cte).toContain("em.direction = 'outbound'");
        expect(cte).toContain('em.contact_id IS NOT NULL');
        expect(cte).toContain('em.on_timeline = true');
        // Thread-level fields come from email_threads (et), joined by thread_id.
        expect(cte).toContain('JOIN email_threads et ON et.id = em.thread_id');
    });

    it('$1 company scope on BOTH tables in BOTH legs of the email CTE (TC-EO-U03)', async () => {
        const [sql, params] = await run();
        // Strip -- line comments so the occurrence counts hit real SQL, not prose.
        const cte = cteSlice(sql).replace(/--[^\n]*/g, '');
        expect((cte.match(/em\.company_id = \$1/g) || []).length).toBeGreaterThanOrEqual(2);
        expect((cte.match(/et\.company_id = \$1/g) || []).length).toBeGreaterThanOrEqual(2);
        expect(params[0]).toBe(COMPANY_A);
        // companyId must NEVER be interpolated into the SQL text.
        expect(sql).not.toContain(COMPANY_A);
    });

    it('hot query never references recipient JSON — plain and search variants (TC-EO-U04)', async () => {
        const [plainSql] = await run();
        db.query.mockReset();
        const [searchSql] = await run({ search: 'x' });
        for (const sql of [plainSql, searchSql]) {
            expect(sql).not.toContain('to_recipients_json');
            expect(sql).not.toContain('jsonb_array_elements');
        }
    });

    it('email CTE dedups DISTINCT ON (contact_id) with deterministic email_thread_id DESC tie-break (TC-EO-U05)', async () => {
        const [sql] = await run();
        const cte = cteSlice(sql);
        // Bare aliases: dedup + ordering run over the union subquery (legs), so
        // no ce./et. prefixes.
        expect(cte).toContain('SELECT DISTINCT ON (contact_id)');
        expect(cte).not.toContain('DISTINCT ON (ce.contact_id)');
        // The email_thread_id DESC tie-break is mandatory — it is the NEW
        // deterministic equal-timestamp rule (absence = plan-dependent ordering).
        expect(cte).toContain(
            'ORDER BY contact_id, last_message_at DESC NULLS LAST, email_thread_id DESC'
        );
    });

    it('email CTE output shape frozen: exactly six aliases; outer consumers unchanged (TC-EO-U06)', async () => {
        const [sql] = await run();
        const cte = cteSlice(sql).replace(/--[^\n]*/g, '');
        // Leg 1 sets the canonical aliases…
        expect(cte).toContain('et.id AS email_thread_id');
        expect(cte).toContain('et.subject AS email_subject');
        // …and the wrapper re-projects EXACTLY the six columns (no seventh).
        expect(cte).toMatch(
            /SELECT DISTINCT ON \(contact_id\)\s+contact_id,\s+email_thread_id,\s+email_subject,\s+last_message_at,\s+last_message_direction,\s+unread_count\s+FROM \(/
        );
        // Outside the CTE the contact leg is unchanged; YELP-TIMELINE-DEDUP-001 adds a
        // SIBLING email_by_timeline leg (eml_tl) and COALESCEs the two email columns so
        // a contactless conv-id timeline surfaces its email. The contact-email CTE shape
        // and the unread_count alias are untouched.
        expect(sql).toContain('LEFT JOIN email_by_contact eml ON eml.contact_id = tl.contact_id');
        expect(sql).toContain('LEFT JOIN email_by_timeline eml_tl ON eml_tl.timeline_id = tl.id');
        expect(sql).toContain('eml.email_thread_id IS NOT NULL');
        expect(sql).toContain('COALESCE(eml.last_message_at, eml_tl.last_message_at) as email_last_message_at');
        expect(sql).toContain('COALESCE(eml.last_message_direction, eml_tl.last_message_direction) as email_last_message_direction');
        expect(sql).toContain('eml.unread_count as email_unread_count');
    });

    it('search variant keeps eml.email_subject and the rewritten CTE shape (TC-EO-U07)', async () => {
        const [sql, params] = await run({ search: 'Acme' });
        expect(sql).toContain('eml.email_subject ILIKE');
        expect(sql).not.toContain('eml.subject ILIKE');
        expect(params).toContain('%Acme%');
        // Same builder path — the U02/U03/U05 CTE shape holds identically here.
        const cte = cteSlice(sql);
        expect(cte).toContain('UNION ALL');
        expect(cte).toContain("em.direction = 'outbound'");
        expect(cte).toContain('em.contact_id IS NOT NULL');
        expect(cte).toContain('em.on_timeline = true');
        expect(cte).toContain(
            'ORDER BY contact_id, last_message_at DESC NULLS LAST, email_thread_id DESC'
        );
        const code = cte.replace(/--[^\n]*/g, '');
        expect((code.match(/em\.company_id = \$1/g) || []).length).toBeGreaterThanOrEqual(2);
        expect((code.match(/et\.company_id = \$1/g) || []).length).toBeGreaterThanOrEqual(2);
    });
});

// ─── MAIL-MUTE-001 — mutedEmails/mutedDomains plumbing (TC-MM-U23) ─────────────
//
// SCOPE OF THESE CASES (be honest — LIST-PAGINATION-001 lesson): db is MOCKED, so
// these assert only the emitted SQL STRING and the bound PARAM SHAPE — that the two
// new params bind as $4/$5, that the `email_muted` scalar + the five gated email
// terms are present, and that DEFAULTED calls stay byte-compatible so other
// getUnifiedTimelinePage callers don't regress. They CANNOT prove the suppression
// actually works (that timeline 2915 left the page, that a call still ranked a
// phone+email contact above its gated email, or that company B was isolated) —
// that is validated by T5's real-DB verify script (scripts/verify-mail-mute-001.js),
// NOT by a green mocked run. A green pass here does NOT satisfy AC-2/AC-3/AC-7/AC-11.
describe('getUnifiedTimelinePage — MAIL-MUTE-001 muted-set plumbing', () => {
    async function run(opts = {}) {
        db.query.mockResolvedValue({ rows: [] });
        await timelinesQueries.getUnifiedTimelinePage({
            limit: 50, offset: 0, companyId: COMPANY_A, ...opts,
        });
        return db.query.mock.calls[0]; // [sql, params]
    }

    it('TC-MM-U23: default params → mutedEmails/mutedDomains bind empty text[] at $4/$5', async () => {
        const [sql, params] = await run(); // NO muted params (sync/other caller)
        // $1 companyId, $2 limit, $3 offset, then the two new muted params.
        expect(params[0]).toBe(COMPANY_A);
        expect(params[1]).toBe(50);
        expect(params[2]).toBe(0);
        expect(params[3]).toEqual([]); // $4 mutedEmails
        expect(params[4]).toEqual([]); // $5 mutedDomains
        // …and the SQL references them positionally as $4 / $5.
        expect(sql).toContain('lower(co.email) = ANY($4)');
        expect(sql).toContain("split_part(lower(co.email), '@', 2) = ANY($5)");
    });

    it('TC-MM-U23: the email_muted scalar is computed once in an em LATERAL (referenceable in WHERE/ORDER BY)', async () => {
        const [sql] = await run();
        // A single LATERAL exposes `email_muted` by name (a SELECT-list alias is not
        // visible in WHERE/ORDER BY in Postgres), checking BOTH co.email and the
        // contact_emails set via a PK-indexed EXISTS on contact_id.
        expect(sql).toContain(') AS email_muted');
        expect(sql).toContain(') em ON true');
        expect(sql).toContain('SELECT 1 FROM contact_emails ce2');
        expect(sql).toContain('WHERE ce2.contact_id = tl.contact_id');
        expect(sql).toContain('ce2.email_normalized = ANY($4)');
        expect(sql).toContain("split_part(ce2.email_normalized, '@', 2) = ANY($5)");
    });

    it('TC-MM-U23: exactly the FIVE email terms are gated with NOT em.email_muted', async () => {
        const [sql] = await run();
        // Strip -- line comments so we count real SQL sites, not the prose that also
        // mentions email_muted in explanatory comments.
        const code = sql.replace(/--[^\n]*/g, '');
        // (1) SELECT last_interaction_at GREATEST email term
        // (5) ORDER BY recency GREATEST email term  → the CASE appears twice.
        expect((code.match(/CASE WHEN NOT em\.email_muted THEN eml\.last_message_at END/g) || []).length).toBe(2);
        // (2) SELECT any_unread email term + (4) ORDER BY unread-tier email term
        //     → the gated unread expression appears twice.
        expect((code.match(/COALESCE\(eml\.unread_count, 0\) > 0 AND NOT em\.email_muted/g) || []).length).toBe(2);
        // (3) surfacing predicate email term.
        expect(code).toContain('(eml.email_thread_id IS NOT NULL AND NOT em.email_muted)');
    });

    it('TC-MM-U23: DEFAULTED path is byte-compatible — the five email terms exist regardless of the set', async () => {
        const [sql] = await run(); // empty set
        // The gated terms are present even with nothing muted; ANY(ARRAY[]::text[])
        // is false at runtime, so email_muted is always false → today's behavior.
        expect(sql).toContain('CASE WHEN NOT em.email_muted THEN eml.last_message_at END');
        expect(sql).toContain('(eml.email_thread_id IS NOT NULL AND NOT em.email_muted)');
        // Call/SMS/task/dedup/pagination anchors are untouched (protected).
        expect(sql).toContain('sms.sms_conversation_id IS NOT NULL');
        expect(sql).toContain('COUNT(*) OVER() AS total_count');
        expect(sql).toContain('LIMIT $2 OFFSET $3');
        expect(sql).toContain('AND NOT (');
    });

    it('TC-MM-U23: non-empty muted params are passed through positionally to $4/$5', async () => {
        const emails = ['customerservice@relyhome.com'];
        const domains = ['relyhome.com'];
        const [, params] = await run({ mutedEmails: emails, mutedDomains: domains });
        expect(params[3]).toEqual(emails);
        expect(params[4]).toEqual(domains);
        // companyId must NEVER be interpolated into the SQL text (still parameterized).
        const [sql] = db.query.mock.calls[0];
        expect(sql).not.toContain(COMPANY_A);
    });

    it('TC-MM-U23: with a search term, muted params keep $4/$5 and search shifts to $6+', async () => {
        const [sql, params] = await run({ search: 'Acme', mutedEmails: ['a@b.com'], mutedDomains: [] });
        // The muted params still occupy $4/$5…
        expect(params[3]).toEqual(['a@b.com']);
        expect(params[4]).toEqual([]);
        expect(sql).toContain('lower(co.email) = ANY($4)');
        // …and the first search text param lands at $6 (the params.length + 1 idiom
        // stays dynamic — muted binds happen BEFORE the search growth).
        expect(params[5]).toBe('%Acme%');
        expect(sql).toContain('co.full_name ILIKE $6');
        // Email subject search still references the CTE alias (unchanged path).
        expect(sql).toContain('eml.email_subject ILIKE $6');
    });
});

// ─── Layer 2: route ───────────────────────────────────────────────────────────

// Mock the query facade the route calls; leadsService kept inert.
const mockGetUnifiedTimelinePage = jest.fn();
jest.mock('../backend/src/db/queries', () => ({
    getUnifiedTimelinePage: (...a) => mockGetUnifiedTimelinePage(...a),
}));
jest.mock('../backend/src/services/leadsService', () => ({
    getLeadsByPhones: jest.fn(async () => ({})),
}));
// MAIL-MUTE-001 (T4): the route resolves the per-company muted sender set from
// mailAgentService before querying. Mock it at the module boundary (as with the
// queries facade above) so the route tests can assert it is called with the
// request's company and that its {emails,domains} are forwarded — WITHOUT pulling
// in the real service's DB/settings reads. Default = empty set (feature-off).
const mockGetMutedSenderSet = jest.fn(async () => ({ emails: [], domains: [] }));
jest.mock('../backend/src/services/mailAgentService', () => ({
    getMutedSenderSet: (...a) => mockGetMutedSenderSet(...a),
}));

function request(app, method, path) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const req = http.request({
                hostname: '127.0.0.1', port: server.address().port, path, method,
                headers: { 'Content-Type': 'application/json' },
            }, (res) => {
                let data = '';
                res.on('data', c => (data += c));
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
            });
            req.on('error', e => { server.close(); reject(e); });
            req.end();
        });
    });
}

function callsApp({ permissions = ['pulse.view'], company = COMPANY_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', email: 'p@x.com', crmUser: { id: 'u1' } };
        req.authz = { scope: 'tenant', permissions, scopes: {}, membership: { role_key: 'manager' } };
        if (company) req.companyFilter = { company_id: company };
        next();
    });
    app.use('/api/calls', require('../backend/src/routes/calls'));
    return app;
}

// Fixture row as returned by getUnifiedTimelinePage (SQL already ordered these).
function row(i, over = {}) {
    return {
        id: i, call_sid: `CA${i}`, parent_call_sid: null, direction: 'inbound',
        from_number: `+1508500${String(1000 + i)}`, to_number: '+15085550000',
        status: 'completed', is_final: true,
        started_at: `2026-06-30T10:${String(i % 60).padStart(2, '0')}:00Z`,
        answered_at: null, ended_at: null, duration_sec: 30,
        created_at: '2026-06-30T10:00:00Z', updated_at: '2026-06-30T10:00:00Z',
        contact: { id: 1000 + i, phone_e164: `+1508500${String(1000 + i)}`, full_name: `C${i}` },
        tl_id: i, timeline_id: i, tl_has_unread: false,
        tl_phone: `+1508500${String(1000 + i)}`,
        is_action_required: false, action_required_reason: null, action_required_set_at: null,
        snoozed_until: null, owner_user_id: null,
        contact_has_unread: false,
        open_task_id: null, open_task_count: 0,
        sms_last_message_at: null, sms_last_message_direction: null, sms_has_unread: false,
        sms_conversation_id: null,
        email_thread_id: null, email_subject: null, email_last_message_at: null,
        email_last_message_direction: null, email_unread_count: 0,
        any_unread: false,
        total_count: 120,
        ...over,
    };
}

describe('GET /api/calls/by-contact — route', () => {
    beforeEach(() => {
        mockGetUnifiedTimelinePage.mockReset();
        // MAIL-MUTE-001 (T4): reset to the fail-open default (empty set) each test.
        mockGetMutedSenderSet.mockReset();
        mockGetMutedSenderSet.mockResolvedValue({ emails: [], domains: [] });
    });

    it('tenant guard: no company context → 401 and NO page query', async () => {
        const res = await request(callsApp({ company: null }), 'GET', '/api/calls/by-contact');
        expect(res.status).toBe(401);
        expect(mockGetUnifiedTimelinePage).not.toHaveBeenCalled();
        // MAIL-MUTE-001 (T4, TC-MM-U13): the muted-set fetch is gated behind the same
        // tenant guard — a missing company must not even resolve the muted set.
        expect(mockGetMutedSenderSet).not.toHaveBeenCalled();
    });

    it('passes limit/offset/companyId/search + muted sets through to the unified query', async () => {
        mockGetUnifiedTimelinePage.mockResolvedValue([]);
        await request(callsApp(), 'GET', '/api/calls/by-contact?limit=50&offset=50&search=bob');
        // MAIL-MUTE-001 (T4): the call now also carries mutedEmails/mutedDomains
        // (empty here — nothing muted) ALONGSIDE the pre-existing four args.
        expect(mockGetUnifiedTimelinePage).toHaveBeenCalledWith({
            limit: 50, offset: 50, companyId: COMPANY_A, search: 'bob',
            mutedEmails: [], mutedDomains: [],
        });
    });

    it('envelope keys are EXACTLY {conversations, leads_map, total, limit, offset}', async () => {
        mockGetUnifiedTimelinePage.mockResolvedValue([row(1)]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact?limit=50&offset=0');
        expect(Object.keys(res.body).sort()).toEqual(
            ['conversations', 'leads_map', 'limit', 'offset', 'total'].sort()
        );
        expect(res.body.limit).toBe(50);
        expect(res.body.offset).toBe(0);
    });

    it('first page returns 50 rows; total reflects total_count', async () => {
        const page1 = Array.from({ length: 50 }, (_, i) => row(i + 1));
        mockGetUnifiedTimelinePage.mockResolvedValue(page1);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact?limit=50&offset=0');
        expect(res.body.conversations).toHaveLength(50);
        expect(res.body.total).toBe(120);
    });

    it('preserves answered_by=ai for the Pulse sidebar icon selector', async () => {
        mockGetUnifiedTimelinePage.mockResolvedValue([row(1, { answered_by: 'ai' })]);

        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');

        expect(res.status).toBe(200);
        expect(res.body.conversations[0].answered_by).toBe('ai');
    });

    it('page-2 (offset 50) shares NO timeline_id with page-1 over a 120-row fixture', async () => {
        const all = Array.from({ length: 120 }, (_, i) => row(i + 1));
        mockGetUnifiedTimelinePage.mockImplementation(async ({ limit, offset }) =>
            all.slice(offset, offset + limit)
        );
        const p1 = await request(callsApp(), 'GET', '/api/calls/by-contact?limit=50&offset=0');
        const p2 = await request(callsApp(), 'GET', '/api/calls/by-contact?limit=50&offset=50');
        const ids1 = new Set(p1.body.conversations.map(c => c.timeline_id));
        const ids2 = p2.body.conversations.map(c => c.timeline_id);
        expect(ids2.some(id => ids1.has(id))).toBe(false);
        expect(p2.body.conversations).toHaveLength(50);
    });

    it('preserves DB row order — the route does NOT re-sort', async () => {
        // Deliberately hand rows in a non-time order; route must keep it verbatim.
        const ordered = [row(3), row(1), row(2)];
        mockGetUnifiedTimelinePage.mockResolvedValue(ordered);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');
        expect(res.body.conversations.map(c => c.timeline_id)).toEqual([3, 1, 2]);
    });

    it('empty page → total 0, no rows', async () => {
        mockGetUnifiedTimelinePage.mockResolvedValue([]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');
        expect(res.body.total).toBe(0);
        expect(res.body.conversations).toEqual([]);
    });

    it('email-only-attributed timeline appears, sorts by email recency, type email_*', async () => {
        // Timeline with NO call / NO sms, only an inbound email thread that is
        // more recent than a later call row → SQL placed it first; route must
        // label it email_inbound and keep its position.
        const emailRow = row(9, {
            id: null, call_sid: null, started_at: null, direction: null,
            from_number: null, to_number: null,
            email_thread_id: 777, email_subject: 'Quote please',
            email_last_message_at: '2026-06-30T12:00:00Z',
            email_last_message_direction: 'inbound',
            email_unread_count: 1, any_unread: true,
        });
        const callRow = row(1, { started_at: '2026-06-30T09:00:00Z' });
        mockGetUnifiedTimelinePage.mockResolvedValue([emailRow, callRow]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');
        const first = res.body.conversations[0];
        expect(first.timeline_id).toBe(9);
        expect(first.email_thread_id).toBe(777);
        expect(first.last_interaction_type).toBe('email_inbound');
        expect(first.last_interaction_at).toBe('2026-06-30T12:00:00Z');
        expect(first.has_unread).toBe(true);
    });

    it('outbound-email attribution → type email_outbound', async () => {
        const r = row(5, {
            id: null, call_sid: null, started_at: null,
            email_thread_id: 42, email_last_message_at: '2026-06-30T13:00:00Z',
            email_last_message_direction: 'outbound',
        });
        mockGetUnifiedTimelinePage.mockResolvedValue([r]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');
        expect(res.body.conversations[0].last_interaction_type).toBe('email_outbound');
    });

    it('AR-not-snoozed pins first; a snoozed AR row is NOT pinned (trusts SQL order)', async () => {
        // The route trusts SQL order. Model the SQL result: not-snoozed AR first,
        // snoozed AR demoted below a fresh normal row.
        const arActive = row(2, {
            is_action_required: true, action_required_set_at: '2026-06-30T08:00:00Z',
            open_task_id: 55, open_task_count: 1, snoozed_until: null,
        });
        const normalRecent = row(3, { started_at: '2026-06-30T11:59:00Z' });
        const arSnoozed = row(4, {
            is_action_required: true, action_required_set_at: '2026-06-30T07:00:00Z',
            open_task_id: 56, open_task_count: 1,
            snoozed_until: '2026-07-05T00:00:00Z', started_at: '2026-06-30T06:00:00Z',
        });
        mockGetUnifiedTimelinePage.mockResolvedValue([arActive, normalRecent, arSnoozed]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');
        const ids = res.body.conversations.map(c => c.timeline_id);
        expect(ids[0]).toBe(2);            // active AR pinned first
        expect(ids.indexOf(4)).toBeGreaterThan(ids.indexOf(3)); // snoozed AR NOT pinned
        expect(res.body.conversations[0].has_open_task).toBe(true);
        expect(res.body.conversations[0].open_task).toMatchObject({ id: 55 });
    });

    // BLOCKER 1 (route layer) — an open-task-only timeline (no call/sms/email,
    // is_action_required=false, has_unread=false) is surfaced by the SQL and must
    // pass through the route as an Action-Required row. Before the WHERE fix the
    // SQL never emitted it, so it silently vanished from Pulse.
    it('open-task-only timeline is returned and flagged has_open_task', async () => {
        const openTaskOnly = row(11, {
            id: null, call_sid: null, started_at: null, direction: null,
            from_number: null, to_number: null,
            sms_conversation_id: null, sms_last_message_at: null,
            email_thread_id: null, email_last_message_at: null,
            is_action_required: false, has_unread: false,
            tl_has_unread: false, sms_has_unread: false, email_unread_count: 0,
            any_unread: false,
            open_task_id: 900, open_task_count: 1, open_task_title: 'Follow up',
            snoozed_until: null,
        });
        mockGetUnifiedTimelinePage.mockResolvedValue([openTaskOnly]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');
        const ids = res.body.conversations.map(c => c.timeline_id);
        expect(ids).toContain(11);
        const conv = res.body.conversations.find(c => c.timeline_id === 11);
        expect(conv.has_open_task).toBe(true);
        expect(conv.open_task).toMatchObject({ id: 900 });
    });

    // BLOCKER 2 (route contract) — dedup happens in SQL, so the route receives ONE
    // canonical (contact-linked) row per person and must not re-expand it. Given the
    // post-dedup SQL result, the response contains exactly one row for that person.
    it('contact + orphan-on-secondary → exactly ONE row (the contact-linked one)', async () => {
        // SQL has already dropped the shadow orphan (contact_id IS NULL, phone=P2);
        // it hands the route only the contact-linked timeline whose SMS lateral
        // surfaced P2's conversation.
        const contactLinked = row(20, {
            id: null, call_sid: null, started_at: null,
            contact: { id: 5000, phone_e164: '+15085551111', secondary_phone: '+15085552222', full_name: 'Jane Doe' },
            tl_phone: '+15085551111',
            sms_conversation_id: 88, sms_last_message_at: '2026-06-30T12:00:00Z',
            sms_last_message_direction: 'inbound',
        });
        mockGetUnifiedTimelinePage.mockResolvedValue([contactLinked]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');
        // Exactly one row, and it is the named contact-linked one (not a bare phone).
        expect(res.body.conversations).toHaveLength(1);
        expect(res.body.conversations[0].timeline_id).toBe(20);
        expect(res.body.conversations[0].contact.full_name).toBe('Jane Doe');
    });

    it('403 without pulse.view / reports.calls.view', async () => {
        const res = await request(callsApp({ permissions: [] }), 'GET', '/api/calls/by-contact');
        expect(res.status).toBe(403);
    });

    // ─── MAIL-MUTE-001 (T4) — route wires getMutedSenderSet → getUnifiedTimelinePage ──
    // SCOPE (honest, per LIST-PAGINATION-001): mailAgentService is MOCKED, so these
    // prove only the WIRING — that the route resolves the muted set with the request's
    // OWN company and forwards {emails,domains} into the query as mutedEmails/mutedDomains,
    // and that a mute-resolution failure is fail-open (empty set, no 500). They do NOT
    // prove real suppression (timeline drop-out / channel-split / cross-tenant); that is
    // T5's real-DB verify script (scripts/verify-mail-mute-001.js). Maps to TC-MM-U14.

    it('TC-MM-U14: getMutedSenderSet is called EXACTLY once with req.companyFilter.company_id', async () => {
        mockGetUnifiedTimelinePage.mockResolvedValue([]);
        await request(callsApp(), 'GET', '/api/calls/by-contact');
        expect(mockGetMutedSenderSet).toHaveBeenCalledTimes(1);
        // Company scoping: the muted set is fetched with the request's company
        // (req.companyFilter.company_id) — NEVER crm_users.company_id / a global.
        expect(mockGetMutedSenderSet).toHaveBeenCalledWith(COMPANY_A);
    });

    it('TC-MM-U14: the resolved muted set is forwarded as mutedEmails/mutedDomains alongside the existing args', async () => {
        const emails = ['customerservice@relyhome.com'];
        const domains = ['relyhome.com'];
        mockGetMutedSenderSet.mockResolvedValue({ emails, domains });
        mockGetUnifiedTimelinePage.mockResolvedValue([]);
        await request(callsApp(), 'GET', '/api/calls/by-contact?limit=25&offset=75&search=vendor');
        // The muted set (from getMutedSenderSet's {emails,domains}) rides ALONGSIDE
        // the pre-existing limit/offset/companyId/search — nothing dropped or renamed.
        expect(mockGetUnifiedTimelinePage).toHaveBeenCalledWith({
            limit: 25, offset: 75, companyId: COMPANY_A, search: 'vendor',
            mutedEmails: emails, mutedDomains: domains,
        });
    });

    it('TC-MM-U14: per-request company scoping — a DIFFERENT tenant resolves ITS OWN muted set', async () => {
        const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
        mockGetUnifiedTimelinePage.mockResolvedValue([]);
        await request(callsApp({ company: COMPANY_B }), 'GET', '/api/calls/by-contact');
        // The muted set is keyed on the request's company, so company B's request
        // fetches company B's set — never company A's (multi-tenant isolation).
        expect(mockGetMutedSenderSet).toHaveBeenCalledWith(COMPANY_B);
        expect(mockGetUnifiedTimelinePage).toHaveBeenCalledWith(
            expect.objectContaining({ companyId: COMPANY_B })
        );
    });

    it('TC-MM-U14: envelope shape is UNCHANGED with a non-empty muted set (rows may just be fewer)', async () => {
        mockGetMutedSenderSet.mockResolvedValue({ emails: ['a@b.com'], domains: [] });
        mockGetUnifiedTimelinePage.mockResolvedValue([row(1)]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact?limit=50&offset=0');
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(
            ['conversations', 'leads_map', 'limit', 'offset', 'total'].sort()
        );
    });

    it('TC-MM-U14: fail-open — getMutedSenderSet REJECTS → route still 200s, empty set forwarded, page still queried', async () => {
        // Belt-and-suspenders: getMutedSenderSet is already fail-open (T1), but even a
        // hard reject must NOT 500 the route or skip the page query. The route awaits
        // it, so a rejection would surface here unless the muting is defended.
        mockGetMutedSenderSet.mockRejectedValue(new Error('settings boom'));
        mockGetUnifiedTimelinePage.mockResolvedValue([]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(0);
        // The list is still queried (feature-off), and with the fail-open empty set.
        expect(mockGetUnifiedTimelinePage).toHaveBeenCalledTimes(1);
        expect(mockGetUnifiedTimelinePage).toHaveBeenCalledWith(
            expect.objectContaining({ mutedEmails: [], mutedDomains: [] })
        );
    });

    // ─── EMAIL-OUTBOUND-001 — outbound-first rows through the route (TC-EO-U08…U10) ──
    // Leg 2 of the rewritten CTE surfaces outbound-first threads; the route is
    // UNTOUCHED, so these pin the existing mapping over the new row shape. The
    // pre-existing `outbound-email attribution → type email_outbound` test above
    // stays as-is; U08 adds the unread/AR halves.

    it('outbound-first email row → email_outbound, not unread, not AR (TC-EO-U08)', async () => {
        const r = row(6, {
            id: null, call_sid: null, started_at: null,
            email_thread_id: 42, email_subject: 'Intro',
            email_last_message_at: '2026-07-03T13:00:00Z',
            email_last_message_direction: 'outbound',
            email_unread_count: 0, any_unread: false, open_task_id: null,
        });
        mockGetUnifiedTimelinePage.mockResolvedValue([r]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');
        const conv = res.body.conversations[0];
        expect(conv.last_interaction_type).toBe('email_outbound');
        expect(conv.last_interaction_at).toBe('2026-07-03T13:00:00Z');
        expect(conv.email_thread_id).toBe(42);
        // Sending an email marks nothing unread (unread_count=0 → any_unread=false)…
        expect(conv.has_unread).toBe(false);
        // …and creates no task, so the row is NOT Action-Required-pinned.
        expect(conv.has_open_task).toBe(false);
    });

    it('frozen envelope + per-row keys for an email-outbound row (TC-EO-U09)', async () => {
        const r = row(6, {
            id: null, call_sid: null, started_at: null,
            email_thread_id: 42, email_subject: 'Intro',
            email_last_message_at: '2026-07-03T13:00:00Z',
            email_last_message_direction: 'outbound',
            email_unread_count: 0, any_unread: false, open_task_id: null,
        });
        mockGetUnifiedTimelinePage.mockResolvedValue([r]);
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact?limit=50&offset=0');
        expect(Object.keys(res.body).sort()).toEqual(
            ['conversations', 'leads_map', 'limit', 'offset', 'total'].sort()
        );
        const conv = res.body.conversations[0];
        // Every frozen field the frontend keys off is present…
        for (const key of [
            'last_interaction_at', 'last_interaction_type', 'last_interaction_phone',
            'email_thread_id', 'has_unread', 'tl_has_unread', 'sms_has_unread',
            'sms_conversation_id', 'timeline_id', 'tl_phone', 'is_action_required',
            'action_required_reason', 'action_required_set_at', 'snoozed_until',
            'owner_user_id', 'has_open_task', 'open_task_count', 'open_task',
        ]) {
            expect(conv).toHaveProperty(key);
        }
        // …and NOTHING was added/removed/renamed vs the pre-change route shape
        // (formatCall spread + contact + the mapped fields; price/price_unit are
        // undefined on this fixture and JSON-dropped, exactly as before).
        // display_name/external_source joined the frozen set in YELP-TL-DEDUP-002
        // (b063142, prod 2026-07-11): the by-contact DTO passes them through so
        // contactless Yelp rows keep their label — the point-deploy shipped the
        // route without updating this expectation (caught by SERVICE-TERR-002 T4).
        expect(Object.keys(conv).sort()).toEqual([
            'action_required_reason', 'action_required_set_at', 'answered_at',
            'answered_by', 'call_sid', 'contact', 'created_at', 'direction',
            'display_name',
            'duration_sec', 'email_thread_id', 'ended_at', 'external_source', 'from_number',
            'has_open_task', 'has_unread', 'id', 'is_action_required', 'is_final',
            'last_interaction_at', 'last_interaction_phone', 'last_interaction_type',
            'open_task', 'open_task_count', 'owner_user_id', 'parent_call_sid',
            'sms_conversation_id', 'sms_has_unread', 'snoozed_until', 'started_at',
            'status', 'timeline_id', 'tl_has_unread', 'tl_phone', 'to_number',
            'updated_at',
        ]);
    });

    it('query failure keeps the existing 500 contract (TC-EO-U10)', async () => {
        mockGetUnifiedTimelinePage.mockRejectedValue(new Error('boom'));
        const res = await request(callsApp(), 'GET', '/api/calls/by-contact');
        expect(res.status).toBe(500);
        // Unchanged message, no stack leak, no new code path.
        expect(res.body).toEqual({ error: 'Failed to fetch calls by contact' });
    });
});
