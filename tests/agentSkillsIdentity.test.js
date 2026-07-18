/**
 * agentSkillsIdentity.test.js — AGENT-SKILLS-001 T9 (Group D — identity resolution)
 *
 * Mocked-unit proof of `identityResolver.resolve` across leads + contacts + jobs
 * (ASK-SKILL-ID-01…06) + the identifyCaller projection over it. The load-bearing
 * real-code fact (spec §3 / §6.2): `leadsService.getLeadByPhone` deliberately
 * RETURNS NULL once the matched contact already has a job — so the resolver must
 * bridge phone → contact → jobs and NOT rely on that getter alone.
 *
 * Harness: mock `db/connection` (the resolver queries `contacts`/`leads`/`jobs`
 * directly) + `leadsService` + `jobsService`. A tiny query router keys off the SQL
 * text so each resolver path (lead getter / bridge contacts / contacts-via-jobs /
 * name+zip) can be independently steered. Company isolation is proven by scoping
 * every seeded row to a companyId and asserting a cross-company twin → 'new'.
 */

'use strict';

const RESOLVER = '../backend/src/services/agentSkills/identityResolver';
const CO = '00000000-0000-0000-0000-000000000001';
const CO_B = '00000000-0000-0000-0000-000000000002';

// The resolver issues raw SQL via db.query for contacts/leads/jobs. We mock the db
// and route by SQL fingerprint so each path is independently controllable.
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/leadsService', () => ({ getLeadByPhone: jest.fn(), getLeadsByPhones: jest.fn() }));
jest.mock('../backend/src/services/jobsService', () => ({ listJobs: jest.fn(async () => ({ results: [] })) }));

const db = require('../backend/src/db/connection');
const leadsService = require('../backend/src/services/leadsService');
const identityResolver = require(RESOLVER);
// identifyCaller derives its context from the gate (which calls the REAL resolver);
// we drive it via the same db mock so its projection is proven end-to-end.
const identifyCaller = require('../backend/src/services/agentSkills/skills/identifyCaller');
const gate = require('../backend/src/services/agentSkills/verificationGate');

/**
 * Route a db.query call to the right stubbed result by SQL fingerprint + the
 * company-id param (2nd or 1st positional, per query). Anything unmatched → [].
 * @param {object} routes { contactsByPhone, contactsFromJobs, contactZips, contactStreets, leadsForContact, jobsForContact, contactsByName }
 */
function routeDb(routes = {}) {
    db.query.mockImplementation(async (sql, params) => {
        const s = String(sql);
        // buildContactRecord: leads/jobs ZIP + street collectors (scoped by contact_id+company)
        if (/SELECT postal_code, address FROM leads/i.test(s)) return { rows: routes.leadZipRows || [] };
        if (/SELECT address FROM leads WHERE contact_id/i.test(s)) return { rows: routes.leadStreetRows || [] };
        if (/SELECT address FROM jobs\s+WHERE contact_id/i.test(s)) return { rows: routes.jobStreetRows || [] };
        // bridgePhoneToContacts (direct contacts phone match)
        if (/FROM contacts c\s+WHERE c\.company_id = \$2/i.test(s)) return { rows: routes.contactsByPhone ? routes.contactsByPhone(params) : [] };
        // contactsFromJobsByPhone (jobs JOIN contacts)
        if (/FROM jobs j\s+JOIN contacts c/i.test(s)) return { rows: routes.contactsFromJobs ? routes.contactsFromJobs(params) : [] };
        // resolveByNameAndAddress (contacts by name)
        if (/FROM contacts c\s+WHERE c\.company_id = \$1/i.test(s)) return { rows: routes.contactsByName ? routes.contactsByName(params) : [] };
        return { rows: [] };
    });
}

const CONTACT_ROW = { id: 501, full_name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith' };

beforeEach(() => {
    jest.clearAllMocks();
    leadsService.getLeadByPhone.mockResolvedValue(null);
    routeDb();
});

// ════════════════════════════════════════════════════════════════════════════
// resolve() — the leads+contacts+jobs bridge
// ════════════════════════════════════════════════════════════════════════════

describe('identityResolver.resolve — leads+contacts+jobs (Group D)', () => {
    test('ASK-SKILL-ID-01: phone → single lead (contact, no job yet) → existing', async () => {
        // Lead getter returns a lead whose contact is 501; no contacts/jobs phone rows needed.
        leadsService.getLeadByPhone.mockResolvedValue({ ContactId: 501, ContactName: 'Jane Smith', FirstName: 'Jane', LastName: 'Smith' });
        routeDb({ contactsByPhone: () => [], contactsFromJobs: () => [] });
        const r = await identityResolver.resolve(CO, { phone: '+16175551212' });
        expect(r.matchType).toBe('existing');
        expect(r.contactId).toBe(501);
        expect(r.customerName).toBe('Jane Smith');
    });

    test('ASK-SKILL-ID-02: getLeadByPhone NULL but contact has a job → bridge to existing (§6.2, THE case)', async () => {
        // Getter suppresses the lead (contact already has a job) → null.
        leadsService.getLeadByPhone.mockResolvedValue(null);
        // The direct-contacts phone match is empty, but contacts-via-jobs finds the contact.
        routeDb({
            contactsByPhone: () => [],
            contactsFromJobs: () => [CONTACT_ROW],
        });
        const r = await identityResolver.resolve(CO, { phone: '+16175551212' });
        expect(r.matchType).toBe('existing'); // did NOT stop at the null getter
        expect(r.contactId).toBe(501);
    });

    test('ASK-SKILL-ID-02b: bridge via the direct contacts phone match also resolves existing', async () => {
        leadsService.getLeadByPhone.mockResolvedValue(null);
        routeDb({ contactsByPhone: () => [CONTACT_ROW], contactsFromJobs: () => [] });
        const r = await identityResolver.resolve(CO, { phone: '(617) 555-1212' });
        expect(r.matchType).toBe('existing');
        expect(r.contactId).toBe(501);
    });

    test('ASK-SKILL-ID-03: masked/no phone → resolve by name + ZIP against contacts+jobs → existing', async () => {
        routeDb({
            contactsByName: () => [CONTACT_ROW],
            // buildContactRecord for the named contact corroborates ZIP 02101 via a lead.
            leadZipRows: [{ postal_code: '02101', address: '12 Walpole St, Boston MA 02101' }],
        });
        const r = await identityResolver.resolve(CO, { name: 'Jane Smith', zip: '02101' });
        expect(r.matchType).toBe('existing');
        expect(r.contactId).toBe(501);
        // the confirmation record carries the normalized ZIP for the gate's L2 factor
        expect(r.contact.zips).toContain('02101');
    });

    test('ASK-SKILL-ID-03b: name matches but NO corroborating zip/street → not confirmed → new', async () => {
        routeDb({ contactsByName: () => [CONTACT_ROW], leadZipRows: [], jobStreetRows: [] });
        const r = await identityResolver.resolve(CO, { name: 'Jane Smith', zip: '02101' });
        expect(r.matchType).toBe('new'); // named contact had no matching zip/street
    });

    test('ASK-SKILL-ID-04: two contacts share a phone → take-latest (newest by created_at), NOT ambiguous (AGENT-SKILLS-002 §1)', async () => {
        // AGENT-SKILLS-002 contract change: the PHONE path never dead-ends into an
        // ambiguity loop. A >1 same-phone match resolves deterministically to the
        // MOST-RECENT contact (created_at DESC). Here 777 is newer than 501 → 777 wins.
        leadsService.getLeadByPhone.mockResolvedValue(null);
        const OLDER = { ...CONTACT_ROW, created_at: '2020-01-01T00:00:00.000Z' };
        const NEWER = { id: 777, full_name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith', created_at: '2024-06-01T00:00:00.000Z' };
        routeDb({
            contactsByPhone: () => [OLDER, NEWER],
            contactsFromJobs: () => [],
        });
        const r = await identityResolver.resolve(CO, { phone: '+16175551212' });
        expect(r.matchType).toBe('existing'); // take-latest, never ambiguous on the phone path
        expect(r.contactId).toBe(777); // the NEWEST contact, not the oldest
        expect(r.ambiguousCount).toBe(0);
        // UNKNOWN-CALLER-LEAD-001: retain the pre-ranking count so createLead can
        // refuse to attach the selected contact without changing voice-gate behavior.
        expect(r.phoneCandidateCount).toBe(2);
    });

    test('ASK-SKILL-ID-04-latest2: created_at ordering is what decides — flip which row is newest and the pick flips', async () => {
        // Same two ids, but now 501 is the newer row → 501 must win (proves it is the
        // timestamp, not the id order / first-seen, that drives take-latest).
        leadsService.getLeadByPhone.mockResolvedValue(null);
        const NEWER501 = { ...CONTACT_ROW, created_at: '2025-01-01T00:00:00.000Z' };
        const OLDER777 = { id: 777, full_name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith', created_at: '2019-01-01T00:00:00.000Z' };
        routeDb({ contactsByPhone: () => [NEWER501, OLDER777], contactsFromJobs: () => [] });
        const r = await identityResolver.resolve(CO, { phone: '+16175551212' });
        expect(r.matchType).toBe('existing');
        expect(r.contactId).toBe(501);
    });

    test('ASK-SKILL-ID-04-namezip: name+zip prefers the MATCHING same-phone contact even when it is the OLDER one (I2)', async () => {
        // Two contacts on one phone; the caller gives name+ZIP that corroborates the
        // OLDER contact (501) via its lead. name+address preference must pick 501,
        // overriding the most-recent (777) fallback (spec §1.2(b) step 2 / I2).
        leadsService.getLeadByPhone.mockResolvedValue(null);
        const OLDER = { ...CONTACT_ROW, created_at: '2018-01-01T00:00:00.000Z' }; // 501 Jane Smith (older)
        const NEWER = { id: 777, full_name: 'Bob Jones', first_name: 'Bob', last_name: 'Jones', created_at: '2025-06-01T00:00:00.000Z' }; // newer, different person
        routeDb({
            contactsByPhone: () => [OLDER, NEWER],
            contactsFromJobs: () => [],
            // buildContactRecord runs per-candidate for the name+addr preference. Route
            // the ZIP collector to corroborate 02101 ONLY for contact 501 (by params).
            // params for the leads-zip collector = [contactId, companyId].
        });
        // Override the db router so the ZIP collector corroborates 02101 for 501 only.
        db.query.mockImplementation(async (sql, params) => {
            const s = String(sql);
            if (/SELECT postal_code, address FROM leads/i.test(s)) {
                return { rows: Number(params[0]) === 501 ? [{ postal_code: '02101', address: '12 Walpole St' }] : [] };
            }
            if (/SELECT address FROM leads WHERE contact_id/i.test(s)) return { rows: [] };
            if (/SELECT address FROM jobs\s+WHERE contact_id/i.test(s)) return { rows: [] };
            if (/FROM contacts c\s+WHERE c\.company_id = \$2/i.test(s)) return { rows: [OLDER, NEWER] };
            if (/FROM jobs j\s+JOIN contacts c/i.test(s)) return { rows: [] };
            return { rows: [] };
        });
        const r = await identityResolver.resolve(CO, { name: 'Jane Smith', zip: '02101', phone: '+16175551212' });
        expect(r.matchType).toBe('existing');
        expect(r.contactId).toBe(501); // name+zip matched the older one → it wins over most-recent
    });

    test('ASK-SKILL-ID-04-namepath: name-path (no usable phone) multi-match STILL ambiguous (I5, unchanged)', async () => {
        // The name path has no "most recent by phone-ownership" semantics, so a
        // name+ZIP corroborating >1 distinct contact must STILL force disambiguation.
        // No phone is supplied → Path B; both named contacts corroborate ZIP 02101.
        const NAMED_A = { id: 501, full_name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith' };
        const NAMED_B = { id: 888, full_name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith' };
        db.query.mockImplementation(async (sql, params) => {
            const s = String(sql);
            // resolveByNameAndAddress: contacts by name (company_id = $1)
            if (/FROM contacts c\s+WHERE c\.company_id = \$1/i.test(s)) return { rows: [NAMED_A, NAMED_B] };
            // buildContactRecord ZIP collector corroborates 02101 for BOTH.
            if (/SELECT postal_code, address FROM leads/i.test(s)) return { rows: [{ postal_code: '02101', address: '12 Walpole St' }] };
            if (/SELECT address FROM leads WHERE contact_id/i.test(s)) return { rows: [] };
            if (/SELECT address FROM jobs\s+WHERE contact_id/i.test(s)) return { rows: [] };
            return { rows: [] };
        });
        const r = await identityResolver.resolve(CO, { name: 'Jane Smith', zip: '02101' });
        expect(r.matchType).toBe('ambiguous'); // name-path multi-match unchanged
        expect(r.ambiguousCount).toBe(2);
        expect(r.contactId).toBeNull();
    });

    test('ASK-SKILL-ID-04b: contactId claim disambiguates 2 phone matches to the pinned one', async () => {
        leadsService.getLeadByPhone.mockResolvedValue(null);
        routeDb({
            contactsByPhone: () => [CONTACT_ROW, { id: 777, full_name: 'Other Person', first_name: 'Other', last_name: 'Person' }],
            contactsFromJobs: () => [],
        });
        const r = await identityResolver.resolve(CO, { phone: '+16175551212', contactId: 777 });
        expect(r.matchType).toBe('existing');
        expect(r.contactId).toBe(777);
    });

    test('ASK-SKILL-ID-05: phone normalization — 3 formats collapse to the same last-10 lookup', async () => {
        const seen = [];
        db.query.mockImplementation(async (sql, params) => {
            const s = String(sql);
            if (/FROM contacts c\s+WHERE c\.company_id = \$2/i.test(s)) { seen.push(params[0]); return { rows: [] }; }
            return { rows: [] };
        });
        await identityResolver.resolve(CO, { phone: '+1 (617) 555-1234' });
        await identityResolver.resolve(CO, { phone: '6175551234' });
        await identityResolver.resolve(CO, { phone: '16175551234' });
        expect(seen).toEqual(['6175551234', '6175551234', '6175551234']);
    });

    test('company isolation — a Company-B-only twin never resolves under Company A (cross-company → new)', async () => {
        // Under Company A the resolver's contacts/jobs queries return nothing (B rows are B-scoped).
        leadsService.getLeadByPhone.mockResolvedValue(null);
        routeDb({ contactsByPhone: () => [], contactsFromJobs: () => [] });
        const r = await identityResolver.resolve(CO, { phone: '+16175551212' });
        expect(r.matchType).toBe('new');
        // Every phone query carried Company A's id as the scope param (never B).
        const scoped = db.query.mock.calls.filter(([sql]) => /company_id = \$2/i.test(String(sql)));
        for (const [, params] of scoped) expect(params[1]).toBe(CO);
        expect(scoped.some(([, params]) => params[1] === CO_B)).toBe(false);
    });

    test('fail-closed — a DB error inside resolve → new (least privilege), never throws out', async () => {
        db.query.mockRejectedValue(new Error('pg down'));
        leadsService.getLeadByPhone.mockResolvedValue(null);
        const r = await identityResolver.resolve(CO, { phone: '+16175551212' });
        expect(r.matchType).toBe('new');
    });

    test('missing companyId → new, no query issued (no cross-company match possible)', async () => {
        const r = await identityResolver.resolve(null, { phone: '+16175551212' });
        expect(r.matchType).toBe('new');
        expect(db.query).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// identifyCaller — speech-safe projection over the resolver (through the gate)
// ════════════════════════════════════════════════════════════════════════════

describe('identifyCaller — derive / greet / ambiguous (ASK-SKILL-ID-06)', () => {
    /** Drive identifyCaller with a server-built context (the choke-point supplies it). */
    async function callWith(ctx, input) {
        return identifyCaller.run(CO, ctx, input);
    }

    test('existing (L1) → greet by name, matchType existing, speech-safe (no phone/address)', async () => {
        const out = await callWith({ level: 'L1', contactId: 501, customerName: 'Jane Smith' }, { phone: '+16175551212' });
        expect(out.matchType).toBe('existing');
        expect(out.customerName).toBe('Jane Smith');
        expect(out.verificationLevel).toBe('L1');
        expect(out.contactId).toBe('501');
        // ASK-SKILL-ID-06: no PII dump — only the allowed keys, no phone/email/full-address.
        expect(Object.keys(out).sort()).toEqual(['ambiguousCount', 'contactId', 'customerName', 'matchType', 'ok', 'speak', 'verificationLevel'].sort());
        expect(JSON.stringify(out)).not.toMatch(/6175551212|walpole|@/i);
    });

    test('ambiguous → matchType ambiguous + ambiguousCount, prompts for ZIP, no name leaked', async () => {
        const out = await callWith({ level: 'L0', contactId: null, customerName: null, ambiguous: true, ambiguousCount: 2 }, { phone: '+16175551212' });
        expect(out.matchType).toBe('ambiguous');
        expect(out.ambiguousCount).toBe(2);
        expect(out.customerName).toBeNull();
        expect(out.speak).toMatch(/zip/i);
    });

    test('no match on a masked number → matchType new, prompts for name + ZIP (not a dead-end)', async () => {
        const out = await callWith({ level: 'L0', contactId: null, customerName: null }, { phone: '' });
        expect(out.matchType).toBe('new');
        expect(out.speak).toMatch(/name and zip/i);
    });

    test('derives its own context when none passed (fail-closed to L0 → new)', async () => {
        // No server context → identifyCaller re-derives via the gate → resolver (db mock returns nothing).
        routeDb({ contactsByPhone: () => [], contactsFromJobs: () => [] });
        leadsService.getLeadByPhone.mockResolvedValue(null);
        const out = await identifyCaller.run(CO, undefined, { phone: '+15550000000' });
        expect(out.ok).toBe(true);
        expect(out.matchType).toBe('new');
    });

    test('gate + identifyCaller integration: bridged existing customer greets by name at L1', async () => {
        // Real gate → real resolver → db mock: contact-with-a-job bridge yields L1.
        leadsService.getLeadByPhone.mockResolvedValue(null);
        routeDb({ contactsFromJobs: () => [CONTACT_ROW] });
        const ctx = await gate.deriveLevel(CO, { phone: '+16175551212' });
        expect(ctx.level).toBe('L1');
        const out = await identifyCaller.run(CO, ctx, { phone: '+16175551212' });
        expect(out.matchType).toBe('existing');
        expect(out.customerName).toBe('Jane Smith');
    });
});
