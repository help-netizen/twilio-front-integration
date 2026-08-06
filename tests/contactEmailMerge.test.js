/**
 * CONTACT-EMAIL-MERGE-001 — T1 unit suite (jest, mocked db).
 *
 * Pins the DECISION TREE and the SQL CONTRACT of contactEmailMergeService:
 *   • resolveAddedEmail dispatch — TC-CEM-U01..U04. UPDATED for
 *     CONTACT-MERGE-001 (TC-R-1): the two separate-owner branches (old silent
 *     D2a auto-merge / D2b re-point) now THROW the ContactConflictError
 *     sentinel; the inbox-only and owner==target branches are byte-for-byte.
 *   • isContactEmailOnly — TRUE only with no phone AND zero rows in all 14
 *     identity tables; enumerates exactly those tables and NOT the footprint
 *     ones; FALSE on any phone / any table row — TC-CEM-U05..U07.
 *   • mergeContacts FK order — open-task re-home BEFORE any timeline delete,
 *     email_messages re-point before timeline delete, contact delete LAST,
 *     cross-tenant guard throws, M2M NOT-EXISTS guards — TC-CEM-U08..U09.
 *
 * House style (cf. orphanTaskRehome.test.js): mock the db connection and assert
 * on the emitted SQL + params + call ordering. Dependency modules are mocked so a
 * dispatch test can see WHICH branch fired without real SQL. Mocked db proves the
 * string/shape only — behavior ("a row moved", "a contact was deleted") is the
 * real-DB verify script's job (T4).
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

const db = require('../backend/src/db/connection');
const emailQueries = require('../backend/src/db/emailQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const svc = require('../backend/src/services/contactEmailMergeService');

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const P = (v) => Promise.resolve(v);

beforeEach(() => {
    jest.clearAllMocks();
    // A tx client whose query() is separately capturable from the pool.
    // Default: benign empty result; individual tests override.
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// A capturing fake tx client.
function mkClient(router) {
    const calls = [];
    const query = jest.fn((sql, params) => {
        calls.push({ sql, params, order: calls.length });
        return router ? router(sql, params) : P({ rows: [], rowCount: 0 });
    });
    return { query, calls };
}

// ─── resolveAddedEmail dispatch ───────────────────────────────────────────────

describe('resolveAddedEmail — 4-way dispatch', () => {
    // TC-CEM-U01 — inbox-only (no owner) → link-only, never mergeContacts.
    it('U01: no owner → linkInboxMessages (link each message), no merge/delete', async () => {
        emailQueries.findEmailContact.mockResolvedValue(null); // no owner
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 'TL' });
        emailQueries.listMessageIdsForAddress.mockResolvedValue(['m1', 'm2']);
        const client = mkClient();

        await svc.resolveAddedEmail(10, 'a@cem1.test', A, client);

        expect(timelinesQueries.findOrCreateTimelineByContact).toHaveBeenCalledWith(10, A, client);
        expect(emailQueries.linkMessageToContact).toHaveBeenCalledTimes(2);
        expect(emailQueries.linkMessageToContact).toHaveBeenNthCalledWith(
            1, 'm1', A, { contact_id: 10, timeline_id: 'TL', on_timeline: true }, client);
        expect(emailQueries.linkMessageToContact).toHaveBeenNthCalledWith(
            2, 'm2', A, { contact_id: 10, timeline_id: 'TL', on_timeline: true }, client);
        // No contact DELETE anywhere.
        expect(client.calls.some(c => /DELETE FROM contacts/i.test(c.sql))).toBe(false);
    });

    // TC-CEM-U02 (UPDATED — CONTACT-MERGE-001 / TC-R-1) — a separate EMPTY owner
    // is NO LONGER silently merged+deleted (old D2a): the branch throws the
    // ContactConflictError sentinel and acts on NOTHING.
    it('U02: empty separate owner → throws ContactConflictError (old silent D2a auto-merge replaced), nothing acted', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ id: 77 });
        const client = mkClient();

        await expect(svc.resolveAddedEmail(10, 'x@cem1.test', A, client))
            .rejects.toBeInstanceOf(svc.ContactConflictError);

        // No merge, no delete, no link — the sentinel replaced the silent action.
        expect(client.calls.some(c => /DELETE FROM contacts/i.test(c.sql))).toBe(false);
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(timelinesQueries.findOrCreateTimelineByContact).not.toHaveBeenCalled();
    });

    // TC-CEM-U03 (UPDATED — CONTACT-MERGE-001 / TC-R-1) — a separate NON-empty
    // owner is NO LONGER silently re-pointed (old D2b): same sentinel; it carries
    // the owner id + the conflicting attribute for the route's fresh 409.
    it('U03: non-empty separate owner → throws ContactConflictError carrying owner id + attribute (old silent D2b re-point replaced)', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ id: 88 });
        const client = mkClient();

        let thrown;
        try {
            await svc.resolveAddedEmail(10, 'bob@cem1.test', A, client);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(svc.ContactConflictError);
        expect(thrown.ownerContactId).toBe(88);
        expect(thrown.attributes).toEqual([
            { kind: 'email', value: 'bob@cem1.test', normalized: 'bob@cem1.test' },
        ]);

        // No re-point, no delete — nothing was acted silently.
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(client.calls.some(c => /DELETE FROM contacts/i.test(c.sql))).toBe(false);
    });

    // TC-CEM-U04 — owner IS the target → no-op.
    it('U04: owner === target → no-op (no link, no merge, no delete)', async () => {
        emailQueries.findEmailContact.mockResolvedValue({ id: 10 }); // == target
        const client = mkClient();

        await svc.resolveAddedEmail(10, 'self@cem1.test', A, client);

        expect(timelinesQueries.findOrCreateTimelineByContact).not.toHaveBeenCalled();
        expect(emailQueries.linkMessageToContact).not.toHaveBeenCalled();
        expect(client.calls.some(c => /DELETE FROM contacts/i.test(c.sql))).toBe(false);
    });
});

// ─── isContactEmailOnly ───────────────────────────────────────────────────────

const IDENTITY_TABLES = [
    'jobs', 'leads', 'estimates', 'invoices', 'payment_transactions',
    'stripe_payment_sessions', 'stripe_saved_payment_methods',
    'portal_access_tokens', 'portal_sessions',
    'portal_events', 'crm_account_contacts', 'crm_deal_contacts',
    'crm_activities', 'tasks', 'contact_addresses',
];

describe('isContactEmailOnly — emptiness gate', () => {
    // TC-CEM-U05 — TRUE only when no phone AND zero rows; enumerates all identity tables,
    // excludes contact_emails / email_messages / timelines.
    it('U05: TRUE when no phone and no identity rows; SQL enumerates every identity table and NOT the footprint tables', async () => {
        const client = mkClient((sql) => {
            if (/SELECT phone_e164, secondary_phone/i.test(sql)) {
                return P({ rows: [{ phone_e164: null, secondary_phone: null }] });
            }
            if (/has_identity/i.test(sql)) return P({ rows: [{ has_identity: false }] });
            return P({ rows: [] });
        });

        const result = await svc.isContactEmailOnly(10, A, client);
        expect(result).toBe(true);

        const existsSql = client.calls.find(c => /has_identity/i.test(c.sql)).sql;
        for (const t of IDENTITY_TABLES) {
            expect(existsSql).toMatch(new RegExp(`FROM ${t}\\b`));
        }
        // Footprint tables must NOT be counted.
        expect(existsSql).not.toMatch(/FROM contact_emails\b/);
        expect(existsSql).not.toMatch(/FROM email_messages\b/);
        expect(existsSql).not.toMatch(/FROM timelines\b/);
        // The safety probe is exhaustive: even a foreign-owned child pointing
        // at this globally unique contact id must block destructive handling.
        expect(existsSql).not.toMatch(/company_id/);
        expect(client.calls.find(c => /has_identity/i.test(c.sql)).params).toEqual([10]);
    });

    // The exported catalog is exact, split by company_id. Only
    // contact_addresses / portal_sessions / portal_events lack a company_id column;
    // leads DOES carry company_id (NOT NULL, mig 012) → company-scoped.
    it('U05b: only contact_addresses/portal_sessions/portal_events lack company_id (leads is company-scoped)', () => {
        expect(svc.IDENTITY_TABLES.map(t => t.table).sort()).toEqual([...IDENTITY_TABLES].sort());
        const noCompany = svc.IDENTITY_TABLES.filter(t => !t.hasCompanyId).map(t => t.table).sort();
        expect(noCompany).toEqual(['contact_addresses', 'portal_events', 'portal_sessions'].sort());
        // leads must be company-scoped (Reviewer-mandated correction).
        expect(svc.IDENTITY_TABLES.find(t => t.table === 'leads').hasCompanyId).toBe(true);
    });

    // TC-CEM-U06 — FALSE if a phone exists (primary or secondary); short-circuits
    // (never even runs the EXISTS probe).
    it.each([
        ['primary', { phone_e164: '+16175551111', secondary_phone: null }],
        ['secondary', { phone_e164: null, secondary_phone: '+16175552222' }],
    ])('U06: FALSE when %s phone present', async (_label, contactRow) => {
        const client = mkClient((sql) => {
            if (/SELECT phone_e164, secondary_phone/i.test(sql)) return P({ rows: [contactRow] });
            if (/has_identity/i.test(sql)) return P({ rows: [{ has_identity: false }] });
            return P({ rows: [] });
        });
        expect(await svc.isContactEmailOnly(10, A, client)).toBe(false);
        // Short-circuited on the phone → no EXISTS probe issued.
        expect(client.calls.some(c => /has_identity/i.test(c.sql))).toBe(false);
    });

    // TC-CEM-U07 — FALSE if ANY one identity table has a row (has_identity=true).
    it.each(['jobs', 'tasks'])('U07: FALSE when identity table %s has a row', async (_table) => {
        const client = mkClient((sql) => {
            if (/SELECT phone_e164, secondary_phone/i.test(sql)) {
                return P({ rows: [{ phone_e164: null, secondary_phone: null }] });
            }
            // Any non-empty table makes the OR-ed EXISTS true.
            if (/has_identity/i.test(sql)) return P({ rows: [{ has_identity: true }] });
            return P({ rows: [] });
        });
        expect(await svc.isContactEmailOnly(10, A, client)).toBe(false);
    });

    it('U07b: FALSE (bias) when the contact does not exist in the company', async () => {
        const client = mkClient(() => P({ rows: [] })); // contact lookup returns nothing
        expect(await svc.isContactEmailOnly(999, A, client)).toBe(false);
    });
});

// ─── mergeContacts FK order + guards ──────────────────────────────────────────

// Router modelling the S2 shape: survivor 10, dup 77 (company A), dup owns
// timeline dupTl=801; survivor timeline resolved via the mocked helper.
function mergeRouter({ survivorCo = A, dupCo = A } = {}) {
    return (sql) => {
        if (/SELECT id, company_id FROM contacts WHERE id IN/i.test(sql)) {
            return P({ rows: [{ id: 10, company_id: survivorCo }, { id: 77, company_id: dupCo }] });
        }
        if (/SELECT id, full_name, phone_e164, secondary_phone, secondary_phone_name/i.test(sql)) {
            return P({ rows: [
                { id: 10, company_id: survivorCo, full_name: 'Survivor', structured_notes: [] },
                { id: 77, company_id: dupCo, full_name: 'Donor', structured_notes: [] },
            ] });
        }
        if (/FROM timelines\s+WHERE contact_id = \$1 AND company_id = \$2/i.test(sql)) {
            return P({ rows: [{ id: 801 }] }); // dup timeline
        }
        if (/SELECT id, google_place_id, address_normalized_hash/i.test(sql)) {
            return P({ rows: [] }); // no dup addresses
        }
        return P({ rows: [], rowCount: 0 });
    };
}

describe('mergeContacts — FK order + tenant guard', () => {
    // TC-CEM-U08 — ALL task history is re-homed before the donor timeline is
    // deleted; the contact is archived, never hard-deleted.
    it('U08: re-homes all timeline tasks/messages before deleting dupTl, then soft-archives the contact', async () => {
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 720 }); // survivorTl
        const client = mkClient(mergeRouter());

        await svc.mergeContacts(10, 77, A, client);

        const idx = (re) => client.calls.findIndex(c => re.test(c.sql));
        const taskRehome = client.calls.find(c =>
            /UPDATE tasks SET thread_id = \$1/i.test(c.sql));
        expect(taskRehome).toBeTruthy();
        expect(taskRehome.sql).not.toMatch(/status = 'open'/i);
        expect(taskRehome.params).toEqual([720, [801], A]);

        const orderTask = taskRehome.order;
        const orderMsgRepoint = idx(/UPDATE email_messages[\s\S]+timeline_id = \$1, contact_id = \$2/i);
        const orderTlDelete = idx(/DELETE FROM timelines/i);
        const orderContactArchive = idx(/UPDATE contacts SET deleted_at = NOW\(\)/i);

        expect(orderTask).toBeLessThan(orderTlDelete);
        // email_messages re-point BEFORE the timeline delete too.
        expect(orderMsgRepoint).toBeGreaterThanOrEqual(0);
        expect(orderMsgRepoint).toBeLessThan(orderTlDelete);
        expect(orderTlDelete).toBeLessThan(orderContactArchive);
        expect(idx(/DELETE FROM contacts/i)).toBe(-1);

        // The email_messages re-point carries the survivor + survivor timeline + dup + company.
        const msg = client.calls.find(c => /UPDATE email_messages/i.test(c.sql));
        expect(msg.params).toEqual([720, 10, [801], A]);

        // tasks.contact_id and tasks.subject_id re-pointed too.
        expect(client.calls.some(c =>
            /UPDATE tasks SET contact_id = \$1/i.test(c.sql) && c.params[0] === 10 && c.params[1] === 77)).toBe(true);
        expect(client.calls.some(c =>
            /UPDATE tasks SET subject_id = \$1/i.test(c.sql) && /subject_type = 'contact'/i.test(c.sql))).toBe(true);
    });

    // TC-CEM-U08b — cross-tenant guard throws before any mutation.
    it('U08b: throws when survivor/dup company mismatch (no cross-tenant merge), no DELETE issued', async () => {
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 720 });
        const client = mkClient(mergeRouter({ dupCo: B })); // dup in company B

        await expect(svc.mergeContacts(10, 77, A, client)).rejects.toThrow(/cross-tenant/i);
        // Guard fires on the very first lookup — no timeline resolve, no deletes.
        expect(timelinesQueries.findOrCreateTimelineByContact).not.toHaveBeenCalled();
        expect(client.calls.some(c => /DELETE FROM/i.test(c.sql))).toBe(false);
    });

    it('U08c: no-op when survivorId === dupId (nothing to merge into self)', async () => {
        const client = mkClient();
        await svc.mergeContacts(10, 10, A, client);
        expect(client.query).not.toHaveBeenCalled();
    });

    it('two Stripe customer/card planes quarantine the donor before any child mutation', async () => {
        const client = mkClient(sql => {
            if (/SELECT id, company_id FROM contacts WHERE id IN/i.test(sql)) {
                return P({ rows: [{ id: 10, company_id: A }, { id: 77, company_id: A }] });
            }
            if (/SELECT id, full_name, phone_e164, secondary_phone, secondary_phone_name/i.test(sql)) {
                return P({ rows: [
                    { id: 10, company_id: A, full_name: 'Survivor', structured_notes: [] },
                    { id: 77, company_id: A, full_name: 'Donor', structured_notes: [] },
                ] });
            }
            if (/FROM stripe_contact_customers customer/i.test(sql)) {
                return P({ rows: [
                    { contact_id: 10, stripe_account_id: 'acct-a', stripe_customer_id: 'cus-a', saved_payment_method_count: 0 },
                    { contact_id: 77, stripe_account_id: 'acct-b', stripe_customer_id: 'cus-b', saved_payment_method_count: 1 },
                ] });
            }
            return P({ rows: [], rowCount: 0 });
        });

        await expect(svc.mergeContacts(10, 77, A, client)).resolves.toMatchObject({
            status: 'needs_review',
            survivor_contact_id: 10,
            merged_contact_id: 77,
        });
        expect(timelinesQueries.findOrCreateTimelineByContact).not.toHaveBeenCalled();
        expect(client.calls.some(call => /^\s*(UPDATE|DELETE)\b/i.test(call.sql))).toBe(false);
        expect(client.calls.some(call => /INSERT INTO contact_merge_redirects/i.test(call.sql))).toBe(true);
    });

    // TC-CEM-U09 — collidable M2M children have explicit identity-merge legs.
    it('U09: email/account/deal/address collisions are resolved before donor re-pointing', async () => {
        timelinesQueries.findOrCreateTimelineByContact.mockResolvedValue({ id: 720 });
        const client = mkClient(mergeRouter());

        await svc.mergeContacts(10, 77, A, client);

        expect(client.calls.some(c => /FROM contact_emails donor[\s\S]+JOIN contact_emails survivor/i.test(c.sql))).toBe(true);

        const acctMove = client.calls.find(c => /UPDATE crm_account_contacts/i.test(c.sql));
        expect(acctMove.sql).toMatch(/contact_id = \$1/i);

        const dealMove = client.calls.find(c => /UPDATE crm_deal_contacts/i.test(c.sql));
        expect(dealMove.sql).toMatch(/contact_id = \$1/i);

        const addrRead = client.calls.find(c => /FROM contact_addresses address[\s\S]+JOIN contacts donor/i.test(c.sql));
        expect(addrRead).toBeTruthy();
    });
});
