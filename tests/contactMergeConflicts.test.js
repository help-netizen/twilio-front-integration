/**
 * CONTACT-MERGE-001 — CM1-T1 unit suite (jest, mocked db) — TC-CM-U01..U10.
 *
 * Pins the SERVICE layer of the confirm-dialog merge/transfer feature
 * (contactEmailMergeService additions):
 *   • detectAttributeConflicts — mig-149 full-digit legs + last-10 fallback,
 *     company scope, id <> target, FOR UPDATE locks, take-latest, added-set
 *     exclusion (S12), Decision-E scalar in the email set, grouping by owner,
 *     FR-3 transfer_allowed — U01..U05.
 *   • resolveAddedEmail — separate-owner branches THROW ContactConflictError
 *     (no silent D2a/D2b left); inbox-only + owner==target byte-for-byte — U06.
 *   • mergeContacts 3b/3c — calls re-point BEFORE the dup-timeline delete
 *     (the calls.timeline_id FK trap), slot fill / label carry / survivor
 *     scalars never touched / overflow → contact_merged event — U07/U08.
 *   • transferPhone — OQ-3 promotion + this-number-only call filter, no SMS
 *     write, owner never deleted — U09.
 *   • transferEmail — row DELETE + scalar sync + linkInboxMessages — U10.
 *
 * House style (cf. contactEmailMerge.test.js): mock db/connection +
 * emailQueries + timelinesQueries (+ eventService), capture the tx client's
 * emitted SQL/params/ordering. Mocked db proves string/shape/dispatch only —
 * row-level behavior is the real-DB verify script's job (CM1-T5).
 *
 * Worktree run: jest --testPathIgnorePatterns "/node_modules/".
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/emailQueries', () => ({
    findEmailContact: jest.fn(),
    linkMessageToContact: jest.fn(),
    listMessageIdsForAddress: jest.fn(),
}));
jest.mock('../backend/src/db/timelinesQueries', () => ({
    findOrCreateTimelineByContact: jest.fn(),
}));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn() }));

const db = require('../backend/src/db/connection');
const emailQueries = require('../backend/src/db/emailQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const eventService = require('../backend/src/services/eventService');
const svc = require('../backend/src/services/contactEmailMergeService');

const A = '00000000-0000-0000-0000-00000000000a';
const P = (v) => Promise.resolve(v);

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// A capturing fake tx client (house pattern).
function mkClient(router) {
    const calls = [];
    const query = jest.fn((sql, params) => {
        calls.push({ sql, params, order: calls.length });
        return router ? router(sql, params) : P({ rows: [], rowCount: 0 });
    });
    return { query, calls };
}

// ── shared SQL routing predicates ─────────────────────────────────────────────
const isPhoneOwnerLookup = (sql) => /id <> \$2/.test(sql);
// Detection reads contact rows twice (review fix a): an UNLOCKED discovery probe
// and the FOR UPDATE lock read (ascending id order) — both share the same shape.
const isContactRead = (sql) =>
    /FROM contacts\s+WHERE id = \$1 AND company_id = \$2/i.test(sql);
const isContactLock = (sql) =>
    /FROM contacts\s+WHERE id = \$1 AND company_id = \$2\s+FOR UPDATE/i.test(sql);
const isContactEmailsList = (sql) => /FROM contact_emails\s+WHERE contact_id = \$1/i.test(sql);

// Row factory for locked contact rows.
function contactRow(over = {}) {
    return {
        id: 10, full_name: 'CM1 Target', company_name: null, email: null,
        phone_e164: null, secondary_phone: null, secondary_phone_name: null,
        ...over,
    };
}

// Router for detectAttributeConflicts tests: contact-row reads (unlocked probe
// AND the FOR UPDATE locks) keyed by contact id, phone-owner lookup returns
// `phoneOwner` (both split-lookup queries), contact_emails keyed by contact id.
// The split lookup (CM1-T5 finding #5) can be routed per-tier: `phoneOwnerFull`
// answers ONLY the indexed full-digit query, `phoneOwnerLast10` ONLY the
// RIGHT(…,10) fallback (undefined tiers fall back to `phoneOwner`).
function detectRouter({ rowsById = {}, phoneOwner = null, phoneOwnerFull, phoneOwnerLast10, emailsById = {} } = {}) {
    return (sql, params) => {
        if (isPhoneOwnerLookup(sql)) {
            const isFallback = /RIGHT\(/.test(sql);
            const owner = isFallback
                ? (phoneOwnerLast10 !== undefined ? phoneOwnerLast10 : phoneOwner)
                : (phoneOwnerFull !== undefined ? phoneOwnerFull : phoneOwner);
            return P({ rows: owner ? [owner] : [] });
        }
        if (isContactRead(sql)) {
            const row = rowsById[String(params[0])];
            return P({ rows: row ? [row] : [] });
        }
        if (isContactEmailsList(sql)) {
            return P({ rows: emailsById[String(params[0])] || [] });
        }
        return P({ rows: [], rowCount: 0 });
    };
}

// ─── TC-CM-U01 — phone owner: mig-149 legs, company scope, lock, take-latest ─

describe('detectAttributeConflicts — phone owner lookup contract', () => {
    it('U01: full-digit legs use the exact mig-149 expression; company-scoped (SQL text, not just param); id <> target; FOR UPDATE on owner AND target; take-latest', async () => {
        const owner = contactRow({ id: 77, full_name: 'CM1 Owner', phone_e164: '+16175550022' });
        const client = mkClient(detectRouter({
            rowsById: { 10: contactRow(), 77: owner },
            phoneOwner: owner,
        }));

        const conflicts = await svc.detectAttributeConflicts(
            10, { phones: ['+16175550022'], emails: [] }, A, client);

        // The owner lookup leg (query 1 of the split lookup — CM1-T5 finding #5:
        // the full-digit legs live in their OWN query so the mig-149 expression
        // indexes serve them; the RIGHT(…,10) fallback runs ONLY on a miss).
        const lookup = client.calls.find(c => isPhoneOwnerLookup(c.sql));
        expect(lookup).toBeTruthy();
        // U01-hardening (review fix d): the company scope must be IN THE SQL
        // TEXT (`company_id = $1`), not merely a bound param — a sabotaged
        // unscoped lookup with a dangling param must FAIL here.
        expect(lookup.sql).toMatch(/company_id = \$1/);
        expect(lookup.params[0]).toBe(A);   // company-scoped
        expect(lookup.params[1]).toBe(10);  // id <> target
        expect(lookup.params[2]).toBe('16175550022'); // full digits
        // EXACT mig-149 expression on BOTH slots (index served verbatim) — and
        // NO un-indexed RIGHT(…,10) leg in THIS query (it would force the
        // planner off the expression indexes onto a whole-tenant scan).
        expect(lookup.sql).toContain("NULLIF(regexp_replace(phone_e164, '\\D', '', 'g'), '') = $3");
        expect(lookup.sql).toContain("NULLIF(regexp_replace(secondary_phone, '\\D', '', 'g'), '') = $3");
        expect(lookup.sql).not.toMatch(/RIGHT\(/);
        // Take-latest on legacy multi-owner dirt. The lookup itself takes NO
        // lock (review fix a) — locks are acquired separately, in id order.
        expect(lookup.sql).toMatch(/ORDER BY updated_at DESC/i);
        expect(lookup.sql).toMatch(/LIMIT 1/i);
        expect(lookup.sql).not.toMatch(/FOR UPDATE/i);
        // The full-digit query HIT → the last-10 fallback query is NOT issued
        // (the perf property of the split: the indexed path skips the scan).
        const fallbackCall = client.calls.find(c => isPhoneOwnerLookup(c.sql) && /RIGHT\(/.test(c.sql));
        expect(fallbackCall).toBeUndefined();

        // BOTH the target AND the owner rows are locked FOR UPDATE (company-scoped).
        const targetLock = client.calls.find(c => isContactLock(c.sql) && c.params[0] === 10);
        expect(targetLock).toBeTruthy();
        expect(targetLock.params).toEqual([10, A]);
        const ownerLock = client.calls.find(c => isContactLock(c.sql) && c.params[0] === 77);
        expect(ownerLock).toBeTruthy();
        expect(ownerLock.params).toEqual([77, A]);

        // Grouped result: one conflict for owner 77 with the phone attribute.
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].owner.id).toBe(77);
        expect(conflicts[0].attributes).toEqual([
            { kind: 'phone', value: '+16175550022', normalized: '16175550022' },
        ]);
    });

    it('U01b (review fix a): FOR UPDATE locks are acquired in ASCENDING contact-id order (owner id < target id → owner locked FIRST)', async () => {
        // Owner id 3 < target id 10 — a naive target-first lock order would
        // deadlock against a concurrent PATCH editing contact 3 adding 10's number.
        const owner = contactRow({ id: 3, full_name: 'CM1 LowId', phone_e164: '+16175550022' });
        const client = mkClient(detectRouter({
            rowsById: { 10: contactRow(), 3: owner },
            phoneOwner: owner,
        }));

        const conflicts = await svc.detectAttributeConflicts(
            10, { phones: ['+16175550022'], emails: [] }, A, client);

        const lockCalls = client.calls.filter(c => isContactLock(c.sql));
        expect(lockCalls.map(c => c.params[0])).toEqual([3, 10]); // ascending
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].owner.id).toBe(3);
    });

    it('U01c (review fix a): a candidate whose locked row NO LONGER holds the number is dropped (re-validation under lock)', async () => {
        // Discovery finds owner 77, but by lock time the number moved away.
        const staleOwner = contactRow({ id: 77, full_name: 'CM1 Stale', phone_e164: '+16175559999' });
        const client = mkClient(detectRouter({
            rowsById: { 10: contactRow(), 77: staleOwner },
            phoneOwner: contactRow({ id: 77, phone_e164: '+16175550022' }),
        }));

        const conflicts = await svc.detectAttributeConflicts(
            10, { phones: ['+16175550022'], emails: [] }, A, client);

        expect(conflicts).toEqual([]); // no stale conflict against changed reality
    });

    // TC-CM-U02 — last-10 fallback legs for legacy non-E.164 owner rows.
    // Split-lookup shape (CM1-T5 finding #5): the fallback is a SECOND query
    // issued ONLY when the indexed full-digit query missed.
    it('U02: RIGHT(digits,10) fallback query runs on full-digit miss, legs on both slots; last10 param passed; legacy owner detected via LIMIT 1 take-latest', async () => {
        // Owner stored non-E.164 — only the last-10 fallback can match it; the
        // mock returns the single latest-updated row (what LIMIT 1 yields on dirt).
        const owner = contactRow({ id: 77, full_name: 'CM1 Legacy', phone_e164: '(617) 555-0022' });
        const client = mkClient(detectRouter({
            rowsById: { 10: contactRow(), 77: owner },
            phoneOwnerFull: null,     // the indexed query misses (non-E.164 row)
            phoneOwnerLast10: owner,  // the fallback finds the legacy owner
        }));

        const conflicts = await svc.detectAttributeConflicts(
            10, { phones: ['+16175550022'], emails: [] }, A, client);

        // BOTH queries were issued, full-digit FIRST (indexed fast path), then
        // the fallback on its miss.
        const lookups = client.calls.filter(c => isPhoneOwnerLookup(c.sql));
        expect(lookups).toHaveLength(2);
        expect(lookups[0].sql).not.toMatch(/RIGHT\(/);
        const lookup = lookups[1];
        expect(lookup.sql).toContain("RIGHT(NULLIF(regexp_replace(phone_e164, '\\D', '', 'g'), ''), 10) = $3");
        expect(lookup.sql).toContain("RIGHT(NULLIF(regexp_replace(secondary_phone, '\\D', '', 'g'), ''), 10) = $3");
        expect(lookup.sql).toMatch(/company_id = \$1/);
        expect(lookup.params[0]).toBe(A);
        expect(lookup.params[1]).toBe(10);
        expect(lookup.params[2]).toBe('6175550022'); // last-10
        // Multi-owner dirt is resolved by the DB (ORDER BY updated_at DESC LIMIT 1);
        // the returned latest owner is the one detected.
        expect(lookup.sql).toMatch(/ORDER BY updated_at DESC[\s\S]*LIMIT 1/i);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].owner.id).toBe(77);
    });
});

// ─── TC-CM-U03 — added-set exclusion (S12) + Decision-E scalar email ─────────

describe('detectAttributeConflicts — added-set exclusion + email legs', () => {
    it('U03a: values already on the target (digits / normalized) never enter the added-set → zero owner lookups, zero conflicts', async () => {
        const target = contactRow({
            phone_e164: '+16175550022',
            email: null,
        });
        const client = mkClient(detectRouter({
            rowsById: { 10: target },
            emailsById: { 10: [{ email: 'a@cm1.test', email_normalized: 'a@cm1.test', is_primary: true }] },
        }));

        const conflicts = await svc.detectAttributeConflicts(
            10,
            // Re-save of own values: number in a different format (last-10 match)
            // + the address already in contact_emails.
            { phones: ['(617) 555-0022'], emails: ['a@cm1.test'] },
            A, client);

        expect(conflicts).toEqual([]);
        // NO phone owner lookup and NO email owner lookup were even issued.
        expect(client.calls.some(c => isPhoneOwnerLookup(c.sql))).toBe(false);
        expect(emailQueries.findEmailContact).not.toHaveBeenCalled();
    });

    it('U03b: a genuinely-new address (incl. the Decision-E scalar) IS resolved via the reused findEmailContact(…, A, client)', async () => {
        emailQueries.findEmailContact.mockResolvedValue(null); // unowned → no conflict
        const client = mkClient(detectRouter({ rowsById: { 10: contactRow() } }));

        const conflicts = await svc.detectAttributeConflicts(
            10, { phones: [], emails: ['new@cm1.test'] }, A, client);

        expect(emailQueries.findEmailContact).toHaveBeenCalledWith('new@cm1.test', A, client);
        expect(conflicts).toEqual([]);
    });
});

// ─── TC-CM-U04 — grouping by owner ────────────────────────────────────────────

describe('detectAttributeConflicts — grouping', () => {
    it('U04: 2 attributes of ONE owner = 1 entry; a second owner = a 2nd entry; entries carry owner/editing compositions + transfer_allowed', async () => {
        const owner77 = contactRow({
            id: 77, full_name: 'CM1 Owner77', company_name: 'Acme',
            phone_e164: '+16175550022', email: 'e1@cm1.test',
        });
        const owner88 = contactRow({ id: 88, full_name: 'CM1 Owner88', email: 'e2@cm1.test' });
        emailQueries.findEmailContact
            .mockResolvedValueOnce({ id: 77 })   // e1@cm1.test → owner 77
            .mockResolvedValueOnce({ id: 88 });  // e2@cm1.test → owner 88
        const client = mkClient(detectRouter({
            rowsById: { 10: contactRow(), 77: owner77, 88: owner88 },
            phoneOwner: owner77,
            emailsById: {
                77: [{ email: 'e1@cm1.test', email_normalized: 'e1@cm1.test', is_primary: true }],
                88: [{ email: 'e2@cm1.test', email_normalized: 'e2@cm1.test', is_primary: true }],
            },
        }));

        const conflicts = await svc.detectAttributeConflicts(
            10,
            { phones: ['+16175550022'], emails: ['e1@cm1.test', 'e2@cm1.test'] },
            A, client);

        expect(conflicts).toHaveLength(2);
        const c77 = conflicts.find(c => c.owner.id === 77);
        const c88 = conflicts.find(c => c.owner.id === 88);
        // Owner 77 groups BOTH attributes into one entry (one dialog).
        expect(c77.attributes.map(a => a.kind).sort()).toEqual(['email', 'phone']);
        expect(c88.attributes).toEqual([{ kind: 'email', value: 'e2@cm1.test', normalized: 'e2@cm1.test' }]);
        // Compositions: name + ALL phones {value,label,slot} + ALL emails {email,is_primary}.
        expect(c77.owner).toMatchObject({ id: 77, full_name: 'CM1 Owner77', company_name: 'Acme' });
        expect(c77.owner.phones).toEqual([{ value: '+16175550022', label: null, slot: 'primary' }]);
        expect(c77.owner.emails).toEqual([{ email: 'e1@cm1.test', is_primary: true }]);
        expect(c77.editing).toMatchObject({ id: 10, full_name: 'CM1 Target' });
        expect(typeof c77.transfer_allowed).toBe('boolean');
        expect(typeof c88.transfer_allowed).toBe('boolean');
    });
});

// ─── TC-CM-U05 — FR-3 gate (parametrized, incl. the U05c trap) ────────────────

describe('detectAttributeConflicts — FR-3 transfer_allowed simulation', () => {
    const emailRow = (e, p = true) => ({ email: e, email_normalized: e, is_primary: p });

    it('U05a: email-only owner, conflict takes its ONLY email → transfer_allowed:false', async () => {
        const owner = contactRow({ id: 77, full_name: 'CM1 AutoContact', email: 'only@cm1.test' });
        emailQueries.findEmailContact.mockResolvedValue({ id: 77 });
        const client = mkClient(detectRouter({
            rowsById: { 10: contactRow(), 77: owner },
            emailsById: { 77: [emailRow('only@cm1.test')] },
        }));
        const conflicts = await svc.detectAttributeConflicts(
            10, { phones: [], emails: ['only@cm1.test'] }, A, client);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].transfer_allowed).toBe(false);
    });

    it('U05b: owner has 1 phone + 1 email, conflict takes the email → true', async () => {
        const owner = contactRow({ id: 77, phone_e164: '+16175550099', email: 'x@cm1.test' });
        emailQueries.findEmailContact.mockResolvedValue({ id: 77 });
        const client = mkClient(detectRouter({
            rowsById: { 10: contactRow(), 77: owner },
            emailsById: { 77: [emailRow('x@cm1.test')] },
        }));
        const conflicts = await svc.detectAttributeConflicts(
            10, { phones: [], emails: ['x@cm1.test'] }, A, client);
        expect(conflicts[0].transfer_allowed).toBe(true);
    });

    it('U05c (the trap): owner has phone+email and ONE grouped dialog takes BOTH → false (whole-set simulation, not per-attribute)', async () => {
        const owner = contactRow({ id: 77, phone_e164: '+16175550099', email: 'x@cm1.test' });
        emailQueries.findEmailContact.mockResolvedValue({ id: 77 });
        const client = mkClient(detectRouter({
            rowsById: { 10: contactRow(), 77: owner },
            phoneOwner: owner,
            emailsById: { 77: [emailRow('x@cm1.test')] },
        }));
        const conflicts = await svc.detectAttributeConflicts(
            10, { phones: ['+16175550099'], emails: ['x@cm1.test'] }, A, client);
        expect(conflicts).toHaveLength(1); // grouped: ONE entry, BOTH attributes
        expect(conflicts[0].attributes).toHaveLength(2);
        expect(conflicts[0].transfer_allowed).toBe(false);
    });

    it('U05d: owner has 2 phones, conflict takes 1 → true', async () => {
        const owner = contactRow({
            id: 77, phone_e164: '+16175550022', secondary_phone: '+16175550033',
        });
        const client = mkClient(detectRouter({
            rowsById: { 10: contactRow(), 77: owner },
            phoneOwner: owner,
        }));
        const conflicts = await svc.detectAttributeConflicts(
            10, { phones: ['+16175550022'], emails: [] }, A, client);
        expect(conflicts[0].transfer_allowed).toBe(true);
    });

    // FR-3 execution-time re-check helper (used by the route on `transfer`).
    it('U05e: assertTransferAllowed — stale-allowed transfer throws the sentinel; a vanished owner does NOT throw (S13)', async () => {
        const attrs = [{ kind: 'email', value: 'only@cm1.test', normalized: 'only@cm1.test' }];
        // Owner would be left with nothing → sentinel.
        const clientBare = mkClient(detectRouter({
            rowsById: { 77: contactRow({ id: 77, email: 'only@cm1.test' }) },
            emailsById: { 77: [emailRow('only@cm1.test')] },
        }));
        await expect(svc.assertTransferAllowed(77, attrs, A, clientBare))
            .rejects.toBeInstanceOf(svc.ContactConflictError);

        // Owner gone between rounds → no throw (the transfer legs 0-row no-op).
        const clientGone = mkClient(detectRouter({ rowsById: {} }));
        await expect(svc.assertTransferAllowed(77, attrs, A, clientGone)).resolves.toBeUndefined();
    });
});

// ─── TC-CM-U06 — resolveAddedEmail: sentinel in separate-owner branches ──────

describe('resolveAddedEmail — no silent path left (Decision B)', () => {
    it('U06a: no owner (inbox-only D3) → link loop byte-for-byte, no throw, no dialog machinery', async () => {
        emailQueries.findEmailContact.mockResolvedValue(null);
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 'TL' });
        emailQueries.listMessageIdsForAddress.mockResolvedValue(['m1', 'm2']);
        const client = mkClient();

        await svc.resolveAddedEmail(10, 'a@cm1.test', A, client);

        expect(emailQueries.linkMessageToContact).toHaveBeenCalledTimes(2);
        expect(emailQueries.linkMessageToContact).toHaveBeenNthCalledWith(
            1, 'm1', A, { contact_id: 10, timeline_id: 'TL', on_timeline: true }, client);
        expect(client.calls.some(c => /DELETE FROM contacts/i.test(c.sql))).toBe(false);
    });

    it('U06b: owner === target → no-op byte-for-byte', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ id: 10 });
        const client = mkClient();

        await svc.resolveAddedEmail(10, 'self@cm1.test', A, client);

        expect(timelinesQueries.findOrCreateTimelineByContact).not.toHaveBeenCalled();
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(client.query).not.toHaveBeenCalled();
    });

    it.each([
        ['email-only owner (old D2a)', 77],
        ['identity-bearing owner (old D2b)', 88],
    ])('U06c/d: separate %s → throws ContactConflictError; mergeContacts / re-point NEVER invoked; no DELETE', async (_label, ownerId) => {
        emailQueries.findEmailContact.mockResolvedValue({ id: ownerId });
        const client = mkClient();

        let thrown;
        try {
            await svc.resolveAddedEmail(10, 'x@cm1.test', A, client);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(svc.ContactConflictError);
        // The sentinel carries enough for a fresh 409: owner id + attribute.
        expect(thrown.ownerContactId).toBe(ownerId);
        expect(thrown.attributes).toEqual([
            { kind: 'email', value: 'x@cm1.test', normalized: 'x@cm1.test' },
        ]);
        // Nothing was acted: no merge (no contact DELETE), no message re-point.
        expect(client.calls.some(c => /DELETE FROM contacts/i.test(c.sql))).toBe(false);
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(timelinesQueries.findOrCreateTimelineByContact).not.toHaveBeenCalled();
    });
});

// ─── mergeContacts routers for U07/U08 ────────────────────────────────────────

// Extends the CEM mergeRouter shape with the 3c phone-pair read.
function mergeRouter({ survivorRow, dupRow } = {}) {
    return (sql) => {
        if (/SELECT id, company_id FROM contacts WHERE id IN/i.test(sql)) {
            return P({ rows: [{ id: 10, company_id: A }, { id: 77, company_id: A }] });
        }
        if (/SELECT id, full_name, phone_e164, secondary_phone, secondary_phone_name/i.test(sql)) {
            return P({ rows: [survivorRow, dupRow].filter(Boolean) }); // 3c pair read
        }
        if (/FROM timelines WHERE contact_id = \$1 AND company_id = \$2/i.test(sql)) {
            return P({ rows: [{ id: 801 }] }); // dup timeline
        }
        if (/SELECT id, google_place_id, address_normalized_hash/i.test(sql)) {
            return P({ rows: [] });
        }
        return P({ rows: [], rowCount: 0 });
    };
}

const survRow = (over = {}) => ({
    id: 10, full_name: 'CM1 Survivor', phone_e164: null,
    secondary_phone: null, secondary_phone_name: null, ...over,
});
const dupRow = (over = {}) => ({
    id: 77, full_name: 'CM1 Dup', phone_e164: null,
    secondary_phone: null, secondary_phone_name: null, ...over,
});

// ─── TC-CM-U07 — mergeContacts extended call order (3b before timeline delete) ─

describe('mergeContacts — 3b calls re-point + extended FK order', () => {
    it('U07: task re-home → email re-point → 3b calls re-point → timeline DELETE → contact DELETE LAST; B3 guards intact', async () => {
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 720 });
        const client = mkClient(mergeRouter({
            survivorRow: survRow(),
            dupRow: dupRow({ phone_e164: '+19997770001' }),
        }));

        await svc.mergeContacts(10, 77, A, client);

        const idx = (re) => client.calls.findIndex(c => re.test(c.sql));
        const orderOpenTask = client.calls.find(c =>
            /UPDATE tasks SET thread_id = \$1/i.test(c.sql) && /status = 'open'/i.test(c.sql)).order;
        const orderMsgRepoint = idx(/UPDATE email_messages/i);
        const orderCallsTl = idx(/UPDATE calls\s+SET timeline_id = \$1, contact_id = \$2\s+WHERE timeline_id = ANY\(\$3\)/i);
        const orderCallsSweep = idx(/UPDATE calls SET contact_id = \$1 WHERE contact_id = \$2 AND company_id = \$3/i);
        const orderTlDelete = idx(/DELETE FROM timelines/i);
        const orderContactDelete = idx(/DELETE FROM contacts/i);

        // 3b exists and carries the survivor timeline + survivor + dup timelines + company.
        const callsTl = client.calls[orderCallsTl];
        expect(callsTl).toBeTruthy();
        expect(callsTl.params).toEqual([720, 10, [801], A]);
        const callsSweep = client.calls[orderCallsSweep];
        expect(callsSweep.params).toEqual([10, 77, A]);

        // THE FK-trap order: task re-home → email re-point → calls re-point →
        // timeline delete → contact delete LAST.
        expect(orderOpenTask).toBeLessThan(orderMsgRepoint);
        expect(orderMsgRepoint).toBeLessThan(orderCallsTl);
        expect(orderCallsTl).toBeLessThan(orderTlDelete);
        expect(orderCallsSweep).toBeLessThan(orderTlDelete);
        expect(orderTlDelete).toBeLessThan(orderContactDelete);
        expect(orderContactDelete).toBe(client.calls.length - 1);

        // B3 regression: tenant guard ran first; NOT-EXISTS M2M guards intact.
        expect(client.calls[0].sql).toMatch(/SELECT id, company_id FROM contacts WHERE id IN/i);
        const emailsMove = client.calls.find(c => /UPDATE contact_emails/i.test(c.sql));
        expect(emailsMove.sql).toMatch(/NOT EXISTS/i);
    });

    it('U07b: cross-tenant guard still throws BEFORE any mutation (B3 not weakened)', async () => {
        const client = mkClient((sql) => {
            if (/SELECT id, company_id FROM contacts WHERE id IN/i.test(sql)) {
                return P({ rows: [{ id: 10, company_id: A }, { id: 77, company_id: 'other-co' }] });
            }
            return P({ rows: [], rowCount: 0 });
        });
        await expect(svc.mergeContacts(10, 77, A, client)).rejects.toThrow(/cross-tenant/i);
        expect(client.calls.some(c => /UPDATE|DELETE/i.test(c.sql))).toBe(false);
    });
});

// ─── TC-CM-U08 — mergeContacts 3c slot fill / scalars / overflow event ────────

describe('mergeContacts — 3c phone-slot fill (OQ-2)', () => {
    const FORBIDDEN_SCALARS = /(full_name|company_name|notes|zenbooker_customer_id|\bemail\b)\s*=/i;

    async function runMerge(survivor, dup) {
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 720 });
        const client = mkClient(mergeRouter({ survivorRow: survivor, dupRow: dup }));
        const mergedEvent = await svc.mergeContacts(10, 77, A, client);
        const slotFill = client.calls.find(c =>
            /UPDATE contacts SET/i.test(c.sql) && /phone/i.test(c.sql) && !/DELETE/i.test(c.sql));
        return { client, slotFill, mergedEvent };
    }

    it('U08a: survivor 0 phones, dup 2 → both fill (phone_e164 first; secondary carries the label); dropped_phones=[]', async () => {
        const { client, slotFill, mergedEvent } = await runMerge(
            survRow(),
            dupRow({ phone_e164: '+19997770001', secondary_phone: '+19997770002', secondary_phone_name: 'Wife' })
        );
        expect(slotFill).toBeTruthy();
        expect(slotFill.sql).toMatch(/phone_e164 = \$1/);
        expect(slotFill.sql).toMatch(/secondary_phone = \$2/);
        expect(slotFill.sql).toMatch(/secondary_phone_name = \$3/);
        expect(slotFill.params).toEqual(['+19997770001', '+19997770002', 'Wife', 10, A]);
        // Survivor scalars NEVER touched by the slot-fill UPDATE.
        expect(FORBIDDEN_SCALARS.test(slotFill.sql)).toBe(false);
        // Review fix c: the contact_merged event is NOT emitted inside the tx
        // (it would survive a ROLLBACK — logEvent writes on the pool). The
        // payload is RETURNED; the route emits it strictly after COMMIT.
        expect(eventService.logEvent).not.toHaveBeenCalled();
        expect(mergedEvent).toEqual(
            { merged_contact_id: 77, merged_name: 'CM1 Dup', dropped_phones: [] });
        // No ZB API leg anywhere in the merge.
        expect(client.calls.some(c => /zenbooker/i.test(c.sql))).toBe(false);
    });

    it('U08b: survivor 1 phone, dup 2 → one fills the secondary slot, one dropped (event payload + warn)', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { slotFill, mergedEvent } = await runMerge(
                survRow({ phone_e164: '+19997770009' }),
                dupRow({ phone_e164: '+19997770001', secondary_phone: '+19997770002', secondary_phone_name: 'Wife' })
            );
            // Only the secondary slot fills — with the dup's PRIMARY (fill order),
            // which has no label → no secondary_phone_name clause.
            expect(slotFill.sql).toMatch(/secondary_phone = \$1/);
            expect(slotFill.sql).not.toMatch(/phone_e164 =/);
            expect(slotFill.sql).not.toMatch(/secondary_phone_name =/);
            expect(slotFill.params).toEqual(['+19997770001', 10, A]);
            expect(eventService.logEvent).not.toHaveBeenCalled(); // review fix c
            expect(mergedEvent).toEqual(
                { merged_contact_id: 77, merged_name: 'CM1 Dup', dropped_phones: ['+19997770002'] });
            expect(warnSpy).toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('U08c: survivor 2 phones, dup 2 → nothing fills (no slot overwritten), both dropped into the event payload', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { client, slotFill, mergedEvent } = await runMerge(
                survRow({ phone_e164: '+19997770008', secondary_phone: '+19997770009' }),
                dupRow({ phone_e164: '+19997770001', secondary_phone: '+19997770002' })
            );
            expect(slotFill).toBeUndefined(); // overflow is NOT persisted
            expect(eventService.logEvent).not.toHaveBeenCalled(); // review fix c
            expect(mergedEvent).toEqual(
                { merged_contact_id: 77, merged_name: 'CM1 Dup', dropped_phones: ['+19997770001', '+19997770002'] });
            // Survivor scalar UPDATE never appeared at all.
            expect(client.calls.some(c =>
                /UPDATE contacts SET/i.test(c.sql) && FORBIDDEN_SCALARS.test(c.sql))).toBe(false);
        } finally {
            warnSpy.mockRestore();
        }
    });
});

// ─── TC-CM-U09 — transferPhone ────────────────────────────────────────────────

describe('transferPhone — OQ-3 promotion + this-number-only call filter', () => {
    function transferRouter(ownerRow) {
        return (sql, params) => {
            if (/FROM contacts\s+WHERE id = \$1 AND company_id = \$2\s+FOR UPDATE/i.test(sql)) {
                return P({ rows: ownerRow ? [ownerRow] : [] });
            }
            if (/FROM timelines WHERE contact_id = \$1 AND company_id = \$2/i.test(sql)) {
                return P({ rows: [{ id: 801 }] }); // owner timeline
            }
            return P({ rows: [], rowCount: 0 });
        };
    }

    it('U09a: primary transferred + secondary present → promotion (phone_e164=secondary_phone; secondary + label NULLed); calls filter scoped to the owner timeline + last-10 legs', async () => {
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 'TLtarget' });
        const client = mkClient(transferRouter({
            id: 77, phone_e164: '+16175550022',
            secondary_phone: '+16175550033', secondary_phone_name: 'Wife',
        }));

        await svc.transferPhone(10, 77, '+16175550022', A, client);

        // OQ-3 promotion.
        const promo = client.calls.find(c => /SET phone_e164 = secondary_phone/i.test(c.sql));
        expect(promo).toBeTruthy();
        expect(promo.sql).toMatch(/secondary_phone = NULL/i);
        expect(promo.sql).toMatch(/secondary_phone_name = NULL/i);
        expect(promo.params).toEqual([77, A]);

        // Target timeline resolved via the reused helper (adopts orphans, re-homes tasks).
        expect(timelinesQueries.findOrCreateTimelineByContact).toHaveBeenCalledWith(10, A, client);

        // Calls UPDATE: bounded by the OWNER's timeline id(s) + BOTH last-10 legs —
        // never an unscoped digit sweep.
        const callsUpd = client.calls.find(c => /UPDATE calls/i.test(c.sql));
        expect(callsUpd).toBeTruthy();
        expect(callsUpd.sql).toMatch(/WHERE timeline_id = ANY\(\$3\) AND company_id = \$4/i);
        expect(callsUpd.sql).toContain("RIGHT(NULLIF(regexp_replace(from_number, '\\D', '', 'g'), ''), 10) = $5");
        expect(callsUpd.sql).toContain("RIGHT(NULLIF(regexp_replace(to_number, '\\D', '', 'g'), ''), 10) = $5");
        expect(callsUpd.params).toEqual(['TLtarget', 10, [801], A, '6175550022']);

        // No SMS write anywhere; owner is NEVER deleted.
        expect(client.calls.some(c => /sms/i.test(c.sql))).toBe(false);
        expect(client.calls.some(c => /DELETE FROM contacts/i.test(c.sql))).toBe(false);
    });

    it('U09b: secondary transferred → only that slot (+ its label) NULLed, NO promotion, phone_e164 untouched', async () => {
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 'TLtarget' });
        const client = mkClient(transferRouter({
            id: 77, phone_e164: '+16175550022',
            secondary_phone: '+16175550033', secondary_phone_name: 'Wife',
        }));

        await svc.transferPhone(10, 77, '+16175550033', A, client);

        const slotClear = client.calls.find(c => /UPDATE contacts/i.test(c.sql));
        expect(slotClear.sql).toMatch(/SET secondary_phone = NULL/i);
        expect(slotClear.sql).toMatch(/secondary_phone_name = NULL/i);
        expect(slotClear.sql).not.toMatch(/phone_e164/i);
        expect(client.calls.some(c => /DELETE FROM contacts/i.test(c.sql))).toBe(false);
    });

    it('U09c: idempotent re-run / foreign owner — slot no longer matches → no contacts UPDATE; absent owner → zero writes', async () => {
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 'TLtarget' });
        // Slot already cleared by the first run.
        const clientCleared = mkClient(transferRouter({
            id: 77, phone_e164: null, secondary_phone: null, secondary_phone_name: null,
        }));
        await svc.transferPhone(10, 77, '+16175550022', A, clientCleared);
        expect(clientCleared.calls.some(c => /UPDATE contacts/i.test(c.sql))).toBe(false);
        // The calls UPDATE still runs (0 rows on a real DB) — bounded + scoped.
        expect(clientCleared.calls.some(c => /UPDATE calls/i.test(c.sql))).toBe(true);

        // Foreign/absent owner (company-scoped lock finds nothing) → NOTHING issued
        // (the only emitted statement is the lock SELECT itself).
        const clientForeign = mkClient(transferRouter(null));
        await svc.transferPhone(10, 999, '+16175550022', A, clientForeign);
        expect(clientForeign.calls.some(c => /^\s*(UPDATE|DELETE)/i.test(c.sql))).toBe(false);
    });

    it('U09d (review fix b): the SAME number occupies BOTH slots → both cleared in one UPDATE, NO promotion (the number never returns)', async () => {
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 'TLtarget' });
        // Same number stored twice: E.164 in the primary slot, legacy format in
        // the secondary (last-10 match). A promotion here would copy the
        // transferred number straight back into phone_e164.
        const client = mkClient(transferRouter({
            id: 77, phone_e164: '+16175550022',
            secondary_phone: '(617) 555-0022', secondary_phone_name: 'Dup slot',
        }));

        await svc.transferPhone(10, 77, '+16175550022', A, client);

        const slotClear = client.calls.filter(c => /UPDATE contacts/i.test(c.sql));
        expect(slotClear).toHaveLength(1); // ONE update, both slots
        expect(slotClear[0].sql).toMatch(/phone_e164 = NULL/i);
        expect(slotClear[0].sql).toMatch(/secondary_phone = NULL/i);
        expect(slotClear[0].sql).toMatch(/secondary_phone_name = NULL/i);
        expect(slotClear[0].sql).not.toMatch(/phone_e164 = secondary_phone/i); // no promotion
        expect(slotClear[0].params).toEqual([77, A]);
        expect(client.calls.some(c => /DELETE FROM contacts/i.test(c.sql))).toBe(false);
    });
});

// ─── TC-CM-U10 — transferEmail ────────────────────────────────────────────────

describe('transferEmail — row DELETE + scalar sync + linkInboxMessages', () => {
    function emailRouter({ ownerRow, remaining = [] } = {}) {
        return (sql) => {
            if (/FROM contacts\s+WHERE id = \$1 AND company_id = \$2\s+FOR UPDATE/i.test(sql)) {
                return P({ rows: ownerRow ? [ownerRow] : [] });
            }
            if (/SELECT email FROM contact_emails/i.test(sql)) {
                return P({ rows: remaining });
            }
            return P({ rows: [], rowCount: 0 });
        };
    }

    beforeEach(() => {
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 'TLtarget' });
        emailQueries.listMessageIdsForAddress.mockResolvedValue(['pm1']);
    });

    it('U10a: transferred address == owner scalar, another row remains → scalar synced to remaining primary-or-first', async () => {
        const client = mkClient(emailRouter({
            ownerRow: { id: 77, email: 'bob@cm1.test' },
            remaining: [{ email: 'second@cm1.test' }],
        }));

        await svc.transferEmail(10, 77, 'bob@cm1.test', A, client);

        const del = client.calls.find(c => /DELETE FROM contact_emails/i.test(c.sql));
        expect(del).toBeTruthy();
        expect(del.sql).toMatch(/WHERE contact_id = \$1 AND email_normalized = \$2/i);
        expect(del.params).toEqual([77, 'bob@cm1.test']);

        // Remaining is fetched primary-or-first and written into the scalar.
        const remainingSel = client.calls.find(c => /SELECT email FROM contact_emails/i.test(c.sql));
        expect(remainingSel.sql).toMatch(/ORDER BY is_primary DESC, id ASC/i);
        const scalarSync = client.calls.find(c => /UPDATE contacts SET email = \$1/i.test(c.sql));
        expect(scalarSync.params).toEqual(['second@cm1.test', 77, A]);

        // Messages re-linked onto the TARGET via the reused loop.
        expect(timelinesQueries.findOrCreateTimelineByContact).toHaveBeenCalledWith(10, A, client);
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledWith(
            'pm1', A, { contact_id: 10, timeline_id: 'TLtarget', on_timeline: true }, client);

        // Owner is NEVER deleted; no merge.
        expect(client.calls.some(c => /DELETE FROM contacts\b/i.test(c.sql))).toBe(false);
    });

    it('U10b: it was the owner\'s ONLY row → scalar → NULL', async () => {
        const client = mkClient(emailRouter({
            ownerRow: { id: 77, email: 'bob@cm1.test' },
            remaining: [],
        }));
        await svc.transferEmail(10, 77, 'bob@cm1.test', A, client);
        const scalarSync = client.calls.find(c => /UPDATE contacts SET email = \$1/i.test(c.sql));
        expect(scalarSync.params).toEqual([null, 77, A]);
    });

    it('U10c: transferred address ≠ owner scalar → scalar untouched (no contacts UPDATE)', async () => {
        const client = mkClient(emailRouter({
            ownerRow: { id: 77, email: 'other@cm1.test' },
        }));
        await svc.transferEmail(10, 77, 'bob@cm1.test', A, client);
        expect(client.calls.some(c => /UPDATE contacts/i.test(c.sql))).toBe(false);
        // The row DELETE + re-link still ran (idempotent single-ownership move).
        expect(client.calls.some(c => /DELETE FROM contact_emails/i.test(c.sql))).toBe(true);
        expect(emailQueries.linkMessageToContact).toHaveBeenCalled();
    });

    it('U10d: foreign/absent owner → zero writes (company-scoped lock finds nothing)', async () => {
        const client = mkClient(emailRouter({ ownerRow: null }));
        await svc.transferEmail(10, 999, 'bob@cm1.test', A, client);
        // Only the lock SELECT was emitted — no write statement of any kind.
        expect(client.calls.some(c => /^\s*(UPDATE|DELETE)/i.test(c.sql))).toBe(false);
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
    });
});
