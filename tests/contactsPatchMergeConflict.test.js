/**
 * CONTACT-MERGE-001 — CM1-T3 unit suite (jest, route, db mocked) — TC-CM-U11..U17.
 *
 * Pins the ROUTE layer of the confirm-dialog merge/transfer feature
 * (`PATCH /api/contacts/:id`, Decision A conflict round-trip):
 *   • U11 — round 1: unresolved conflict → ROLLBACK (COMMIT never) + 409
 *     `CONTACT_ATTRIBUTE_CONFLICT` with the FULL payload (leads.js
 *     CONTACT_AMBIGUOUS envelope precedent); detection precedes ALL writes.
 *   • U12 — round 2 strict echo: same owner + same attribute set executes;
 *     mismatch → fresh 409; a resolution matching no conflict is ignored
 *     (idempotency contract, FR-10).
 *   • U13 — malformed resolutions[] → treated as non-matching → 409, never 500.
 *   • U14 — Decision-C execution order (detect → validate → contact UPDATE +
 *     email block → resolutions → step-5 resolveAddedEmail loop → COMMIT);
 *     FR-3 re-check at transfer execution (stale gate → sentinel → fresh 409);
 *     async legs + the contact_merged event fire ONLY after COMMIT (fix c).
 *   • U15 — middleware/tenancy: 401 / 403 / 404 foreign id / forged echo
 *     ignored / 400 INVALID_ID / 400 NO_FIELDS.
 *   • U16 — Decision E scalar `email`: detection + in-tx enrichEmail +
 *     resolveAddedEmail; `emails[]` precedence kept; already-owned scalar and
 *     empty scalar skip the branch (the 4175/4228 closure).
 *   • U17 — in-tx sentinel from the step-5 loop → ROLLBACK → fresh 409, not 500
 *     (+ the 40P01 deadlock belt-and-braces leg, review fix a).
 *
 * House style (cf. tests/contactsPatchEmails.test.js): mock db/connection with a
 * pool.connect returning a CAPTURING tx client, mock the merge + dedupe services,
 * drive the real router via supertest with an injected auth middleware. Mocked db
 * proves the 409 contract / ordering / dispatch — real row movement is the
 * CM1-T5 verify-script's job.
 *
 * Worktree run: jest --testPathIgnorePatterns "/node_modules/".
 */

const express = require('express');
const request = require('supertest');

// ─── Shared execution trace (SQL + service-call interleaving for U14) ─────────
const trace = [];

// ─── A capturing pooled tx client ─────────────────────────────────────────────
let clientRouter = null;
const mockClient = {
    calls: [],
    query: jest.fn((sql, params) => {
        mockClient.calls.push({ sql: String(sql), params });
        trace.push(`sql:${String(sql)}`);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
        const routed = clientRouter ? clientRouter(String(sql), params) : undefined;
        return Promise.resolve(routed || { rows: [], rowCount: 0 });
    }),
    release: jest.fn(),
};
const mockPoolQuery = jest.fn((sql) => {
    trace.push(`pool:${String(sql)}`);
    return Promise.resolve({ rows: [], rowCount: 0 });
});

jest.mock('../backend/src/db/connection', () => ({
    pool: { connect: jest.fn(() => Promise.resolve(mockClient)) },
    query: (...args) => mockPoolQuery(...args),
}));

// ─── Service mocks ────────────────────────────────────────────────────────────
jest.mock('../backend/src/services/contactsService', () => ({
    getById: jest.fn(),
    getContactById: jest.fn(),
    getContactLeads: jest.fn(async () => []),
    getContactEmails: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/contactDedupeService', () => ({
    enrichEmail: jest.fn(async () => true),
    getAdditionalEmails: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/contactEmailMergeService', () => {
    class ContactConflictError extends Error {
        constructor(ownerContactId, attributes = [], message) {
            super(message || 'conflict');
            this.name = 'ContactConflictError';
            this.ownerContactId = ownerContactId;
            this.attributes = attributes;
        }
    }
    return {
        detectAttributeConflicts: jest.fn(async () => []),
        resolveAddedEmail: jest.fn(async () => {}),
        linkInboxMessages: jest.fn(async () => 0), // step-5 D3 supplement (CM1-T5)
        mergeContacts: jest.fn(async () => null),
        transferPhone: jest.fn(async () => {}),
        transferEmail: jest.fn(async () => {}),
        assertTransferAllowed: jest.fn(async () => {}),
        ContactConflictError,
    };
});
jest.mock('../backend/src/services/timelineMergeService', () => ({
    mergeOrphanTimelines: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/zenbookerSyncService', () => ({
    FEATURE_ENABLED: false,
    syncContactToZenbooker: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn() }));
// Unused-by-PATCH collaborators the router requires at module load.
jest.mock('../backend/src/services/noteAttachmentsService', () => ({ MAX_FILE_SIZE: 1, MAX_FILES_PER_NOTE: 1 }));
jest.mock('../backend/src/services/notesMutationService', () => ({}));

const contactsService = require('../backend/src/services/contactsService');
const dedupe = require('../backend/src/services/contactDedupeService');
const mergeSvc = require('../backend/src/services/contactEmailMergeService');
const timelineMerge = require('../backend/src/services/timelineMergeService');
const eventService = require('../backend/src/services/eventService');
const contactsRouter = require('../backend/src/routes/contacts');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const P22 = '+16175550022';
const D22 = '16175550022';

function makeApp({ permissions = ['contacts.edit'], companyId = COMPANY_A, authenticated = true } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (!authenticated) {
            // Mirrors the `authenticate` middleware contract: no/invalid token →
            // 401 BEFORE the router is ever reached (the chain is unchanged).
            return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing token' } });
        }
        req.user = { sub: 'kc-sub', email: 'u@x.com', crmUser: { id: 'crm-1' } };
        req.authz = { permissions, scopes: {} };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/api/contacts', contactsRouter);
    return app;
}

// ── conflict fixtures (server payload shape, spec §API contract) ──────────────
function phoneConflict(over = {}) {
    return {
        owner: {
            id: 77, full_name: 'Owner 77', company_name: 'Acme',
            phones: [{ value: P22, label: null, slot: 'primary' }],
            emails: [{ email: 'owner@cm1.test', is_primary: true }],
        },
        editing: { id: 5, full_name: 'Jane Doe', company_name: null, phones: [], emails: [] },
        attributes: [{ kind: 'phone', value: P22, normalized: D22 }],
        transfer_allowed: true,
        ...over,
    };
}
function emailConflict(ownerId = 88, addr = 'x@cm1.test', over = {}) {
    return {
        owner: {
            id: ownerId, full_name: `Owner ${ownerId}`, company_name: null,
            phones: [{ value: '+16175550099', label: null, slot: 'primary' }],
            emails: [{ email: addr, is_primary: true }],
        },
        editing: { id: 5, full_name: 'Jane Doe', company_name: null, phones: [], emails: [] },
        attributes: [{ kind: 'email', value: addr, normalized: addr }],
        transfer_allowed: true,
        ...over,
    };
}

// SQL helpers over the captured tx-client calls.
const clientSql = () => mockClient.calls.map(c => c.sql);
const findCall = (re) => mockClient.calls.find(c => re.test(c.sql));
const countWrites = () => mockClient.calls.filter(c => /^\s*(UPDATE|INSERT|DELETE)/i.test(c.sql)).length;
const traceIdx = (pred) => trace.findIndex(t => (pred instanceof RegExp ? pred.test(t) : t === pred));

beforeEach(() => {
    jest.clearAllMocks();
    mockClient.calls = [];
    trace.length = 0;
    clientRouter = (sql) => {
        if (/SELECT first_name, last_name FROM contacts/i.test(sql)) {
            return { rows: [{ first_name: 'Jane', last_name: 'Doe' }] };
        }
        return { rows: [], rowCount: 0 };
    };
    // Re-establish default IMPLEMENTATIONS every test (jest.clearAllMocks wipes
    // history but not implementations set via mockResolvedValue on prior tests).
    dedupe.enrichEmail.mockResolvedValue(true);
    dedupe.getAdditionalEmails.mockResolvedValue([]);
    mergeSvc.detectAttributeConflicts.mockResolvedValue([]);
    mergeSvc.resolveAddedEmail.mockResolvedValue(undefined);
    mergeSvc.mergeContacts.mockResolvedValue(null);
    mergeSvc.transferPhone.mockResolvedValue(undefined);
    mergeSvc.transferEmail.mockResolvedValue(undefined);
    mergeSvc.assertTransferAllowed.mockResolvedValue(undefined);
    mockPoolQuery.mockImplementation((sql) => {
        trace.push(`pool:${String(sql)}`);
        return Promise.resolve({ rows: [], rowCount: 0 });
    });
    contactsService.getById.mockResolvedValue({ id: 5, company_id: COMPANY_A, email: null });
    contactsService.getContactById.mockResolvedValue({
        id: 5, first_name: 'Jane', last_name: 'Doe', email: null,
        phone_e164: null, secondary_phone: null, secondary_phone_name: null,
        company_name: null, zenbooker_customer_id: null,
    });
});

// ─── TC-CM-U11 — round 1: 409 payload + ROLLBACK + detection-before-writes ────
describe('TC-CM-U11: unresolved conflict → 409 full payload, ROLLBACK, detection precedes ALL writes', () => {
    it('answers 409 CONTACT_ATTRIBUTE_CONFLICT with the leads.js-style envelope and commits NOTHING', async () => {
        const conflict = phoneConflict();
        let writesBeforeDetection = -1;
        mergeSvc.detectAttributeConflicts.mockImplementation(async () => {
            writesBeforeDetection = countWrites();
            return [conflict];
        });

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            // A NON-conflicting field edit rides along — it must NOT be written
            // before detection (and must roll back with the 409).
            .send({ first_name: 'Renamed', phone_e164: P22 });

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
            ok: false,
            error: { code: 'CONTACT_ATTRIBUTE_CONFLICT' },
            conflict: {
                conflicts: [{
                    owner: {
                        id: 77, full_name: 'Owner 77', company_name: 'Acme',
                        phones: [{ value: P22, label: null, slot: 'primary' }],
                        emails: [{ email: 'owner@cm1.test', is_primary: true }],
                    },
                    editing: { id: 5, full_name: 'Jane Doe' },
                    attributes: [{ kind: 'phone', value: P22, normalized: D22 }],
                    transfer_allowed: true,
                }],
            },
        });
        expect(typeof res.body.error.message).toBe('string');
        expect(typeof res.body.error.correlation_id).toBe('string');

        // Detection ran FIRST inside the tx, on the tx client, company-scoped,
        // with the added-phone set.
        expect(mergeSvc.detectAttributeConflicts).toHaveBeenCalledWith(
            5, { phones: [P22], emails: [] }, COMPANY_A, mockClient);
        expect(writesBeforeDetection).toBe(0); // no UPDATE/INSERT/DELETE preceded it

        // ROLLBACK issued, COMMIT never; NOTHING was ever written at all.
        expect(clientSql()).toContain('ROLLBACK');
        expect(clientSql()).not.toContain('COMMIT');
        expect(countWrites()).toBe(0);

        // Async post-commit legs NEVER fire on the 409 leg.
        expect(mockPoolQuery).not.toHaveBeenCalled();
        expect(timelineMerge.mergeOrphanTimelines).not.toHaveBeenCalled();
        expect(eventService.logEvent).not.toHaveBeenCalled();
    });
});

// ─── TC-CM-U12 — round 2 strict echo (parametrized) ───────────────────────────
describe('TC-CM-U12: strict echo — mismatch → fresh 409; non-matching resolution → ignored', () => {
    it('(a) matching owner + attribute set → the merge executes in-tx and the save commits', async () => {
        mergeSvc.detectAttributeConflicts.mockResolvedValue([phoneConflict()]);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({
                phone_e164: P22,
                resolutions: [{ owner_contact_id: 77, action: 'merge', attributes: [{ kind: 'phone', value: P22 }] }],
            });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(mergeSvc.mergeContacts).toHaveBeenCalledWith(5, 77, COMPANY_A, mockClient);
        expect(clientSql()).toContain('COMMIT');
        expect(clientSql()).not.toContain('ROLLBACK');
    });

    it('(b) echoed attribute set DIFFERS (extra email) → fresh 409, nothing executed', async () => {
        mergeSvc.detectAttributeConflicts.mockResolvedValue([phoneConflict()]);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({
                phone_e164: P22,
                resolutions: [{
                    owner_contact_id: 77, action: 'merge',
                    attributes: [{ kind: 'phone', value: P22 }, { kind: 'email', value: 'q@cm1.test' }],
                }],
            });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONTACT_ATTRIBUTE_CONFLICT');
        expect(res.body.conflict.conflicts).toHaveLength(1);
        expect(mergeSvc.mergeContacts).not.toHaveBeenCalled();
        expect(mergeSvc.transferPhone).not.toHaveBeenCalled();
        expect(mergeSvc.transferEmail).not.toHaveBeenCalled();
        expect(clientSql()).toContain('ROLLBACK');
        expect(clientSql()).not.toContain('COMMIT');
        expect(countWrites()).toBe(0);
    });

    it('(a2) echoed phone value formatted differently but same digits → normalizes → matches → executes', async () => {
        mergeSvc.detectAttributeConflicts.mockResolvedValue([phoneConflict()]);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({
                phone_e164: P22,
                // Same digits, cosmetic formatting: matching is on normalized
                // digits (spec Decision A), not on the raw string. NOTE the digit
                // string must be IDENTICAL (incl. country code) — '6175550022'
                // vs '16175550022' is a strict-echo MISMATCH by design (the hook
                // echoes the payload's own `value`, useContactConflictFlow:107).
                resolutions: [{ owner_contact_id: 77, action: 'merge', attributes: [{ kind: 'phone', value: '+1 (617) 555-0022' }] }],
            });

        expect(res.status).toBe(200);
        expect(mergeSvc.mergeContacts).toHaveBeenCalledWith(5, 77, COMPANY_A, mockClient);
        expect(clientSql()).toContain('COMMIT');
    });

    it('(b2) echoed set SAME SIZE but different value (stale attribute) → fresh 409, nothing executed', async () => {
        // Pins the membership loop (not just the size guard): detected = phone P22,
        // echo = ANOTHER phone — got.size === want.size, content differs (S9 staleness).
        mergeSvc.detectAttributeConflicts.mockResolvedValue([phoneConflict()]);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({
                phone_e164: P22,
                resolutions: [{ owner_contact_id: 77, action: 'merge', attributes: [{ kind: 'phone', value: '+16175550099' }] }],
            });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONTACT_ATTRIBUTE_CONFLICT');
        expect(mergeSvc.mergeContacts).not.toHaveBeenCalled();
        expect(clientSql()).toContain('ROLLBACK');
        expect(clientSql()).not.toContain('COMMIT');
        expect(countWrites()).toBe(0);
    });

    it('(c) resolution names a DIFFERENT owner only → the detected conflict is unresolved → fresh 409', async () => {
        mergeSvc.detectAttributeConflicts.mockResolvedValue([phoneConflict()]);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({
                phone_e164: P22,
                resolutions: [{ owner_contact_id: 99, action: 'merge', attributes: [{ kind: 'phone', value: P22 }] }],
            });

        expect(res.status).toBe(409);
        expect(mergeSvc.mergeContacts).not.toHaveBeenCalled();
        expect(clientSql()).toContain('ROLLBACK');
        expect(clientSql()).not.toContain('COMMIT');
    });

    it('(d) NO conflicts detected + a leftover resolution → ignored, plain save proceeds (idempotent retry)', async () => {
        mergeSvc.detectAttributeConflicts.mockResolvedValue([]); // post-success re-send

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({
                phone_e164: P22,
                resolutions: [{ owner_contact_id: 77, action: 'merge', attributes: [{ kind: 'phone', value: P22 }] }],
            });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(mergeSvc.mergeContacts).not.toHaveBeenCalled();
        expect(mergeSvc.transferPhone).not.toHaveBeenCalled();
        expect(mergeSvc.transferEmail).not.toHaveBeenCalled();
        expect(clientSql()).toContain('COMMIT');
    });
});

// ─── TC-CM-U13 — malformed resolutions → 409, never 500 ───────────────────────
describe('TC-CM-U13: malformed resolutions[] → treated as non-matching → 409, never 500', () => {
    it.each([
        ['unknown action', [{ owner_contact_id: 77, action: 'delete', attributes: [{ kind: 'phone', value: P22 }] }]],
        ['missing owner_contact_id', [{ action: 'merge', attributes: [{ kind: 'phone', value: P22 }] }]],
        ['attributes not an array', [{ owner_contact_id: 77, action: 'merge', attributes: 'x' }]],
        ['unknown attribute kind', [{ owner_contact_id: 77, action: 'merge', attributes: [{ kind: 'fax', value: 'z' }] }]],
        ['resolutions not an array', 'garbage'],
        ['null entry', [null]],
    ])('%s → 409 with the current conflict payload, no stack leak', async (_label, resolutions) => {
        mergeSvc.detectAttributeConflicts.mockResolvedValue([phoneConflict()]);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ phone_e164: P22, resolutions });

        expect(res.status).toBe(409); // never a 500 for a client-shape problem
        expect(res.body.error.code).toBe('CONTACT_ATTRIBUTE_CONFLICT');
        expect(res.body.conflict.conflicts).toHaveLength(1);
        expect(JSON.stringify(res.body)).not.toMatch(/at Object|\.js:\d/); // no stack leak
        expect(mergeSvc.mergeContacts).not.toHaveBeenCalled();
        expect(mergeSvc.transferPhone).not.toHaveBeenCalled();
        expect(mergeSvc.transferEmail).not.toHaveBeenCalled();
        expect(clientSql()).toContain('ROLLBACK');
        expect(clientSql()).not.toContain('COMMIT');
    });

    it('with NO conflict present, garbage resolutions are ignored (as U12-d) → 200', async () => {
        mergeSvc.detectAttributeConflicts.mockResolvedValue([]);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ first_name: 'Ok', resolutions: [{ action: 'delete' }] });

        expect(res.status).toBe(200);
        expect(clientSql()).toContain('COMMIT');
    });
});

// ─── TC-CM-U14 — Decision-C order + FR-3 re-check + async legs after COMMIT ───
describe('TC-CM-U14: execution order (Decision C) + FR-3 re-check at transfer execution', () => {
    it('(i) ordered: detect → contact UPDATE + email block → gate + transfer → step-5 resolve loop → COMMIT → async legs', async () => {
        const conflict = emailConflict(88, 'x@cm1.test');
        mergeSvc.detectAttributeConflicts.mockImplementation(async () => { trace.push('svc:detect'); return [conflict]; });
        mergeSvc.assertTransferAllowed.mockImplementation(async () => { trace.push('svc:gate'); });
        mergeSvc.transferEmail.mockImplementation(async () => { trace.push('svc:transferEmail'); });
        mergeSvc.resolveAddedEmail.mockImplementation(async () => { trace.push('svc:resolve'); });

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({
                first_name: 'Jane',
                emails: [{ email: 'x@cm1.test', is_primary: true }, { email: 'free@cm1.test' }],
                resolutions: [{ owner_contact_id: 88, action: 'transfer', attributes: [{ kind: 'email', value: 'x@cm1.test' }] }],
            });

        expect(res.status).toBe(200);

        const iDetect = traceIdx('svc:detect');
        const iUpdate = traceIdx(/^sql:UPDATE contacts SET/);
        const iGate = traceIdx('svc:gate');
        const iTransfer = traceIdx('svc:transferEmail');
        const iResolve = traceIdx('svc:resolve');
        const iCommit = traceIdx('sql:COMMIT');
        const iLeadsCascade = traceIdx(/^pool:\s*UPDATE leads/);

        for (const i of [iDetect, iUpdate, iGate, iTransfer, iResolve, iCommit, iLeadsCascade]) {
            expect(i).toBeGreaterThan(-1);
        }
        // Decision C: detect → (validate) → contact UPDATE/email block →
        // resolution execution → step-5 loop → COMMIT → post-commit async legs.
        expect(iDetect).toBeLessThan(iUpdate);
        expect(iUpdate).toBeLessThan(iGate);
        expect(iGate).toBeLessThan(iTransfer);
        expect(iTransfer).toBeLessThan(iResolve);
        expect(iResolve).toBeLessThan(iCommit);
        expect(iCommit).toBeLessThan(iLeadsCascade);

        // FR-3 re-check + transfer carried the DETECTED attribute (normalized).
        expect(mergeSvc.assertTransferAllowed).toHaveBeenCalledWith(88, conflict.attributes, COMPANY_A, mockClient);
        expect(mergeSvc.transferEmail).toHaveBeenCalledWith(5, 88, 'x@cm1.test', COMPANY_A, mockClient);
        expect(mergeSvc.transferPhone).not.toHaveBeenCalled();

        // Step 5 runs ONLY for the non-conflicted new address.
        expect(mergeSvc.resolveAddedEmail).toHaveBeenCalledTimes(1);
        expect(mergeSvc.resolveAddedEmail).toHaveBeenCalledWith(5, 'free@cm1.test', COMPANY_A, mockClient);

        // Async orphan-merge leg fired (post-commit).
        expect(timelineMerge.mergeOrphanTimelines).toHaveBeenCalled();
    });

    it('(ii) stale FR-3 gate at execution → sentinel → ROLLBACK → fresh 409; transfer never half-run; async legs silent', async () => {
        const stale = emailConflict(88, 'x@cm1.test');
        const fresh = [emailConflict(88, 'x@cm1.test', { transfer_allowed: false })];
        mergeSvc.detectAttributeConflicts
            .mockResolvedValueOnce([stale]) // in-tx detection (round 2)
            .mockResolvedValueOnce(fresh);  // post-rollback re-detection for the fresh payload
        mergeSvc.assertTransferAllowed.mockRejectedValue(
            new mergeSvc.ContactConflictError(88, stale.attributes, 'transfer would strip the contact'));

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({
                emails: [{ email: 'x@cm1.test', is_primary: true }],
                resolutions: [{ owner_contact_id: 88, action: 'transfer', attributes: [{ kind: 'email', value: 'x@cm1.test' }] }],
            });

        expect(res.status).toBe(409); // fresh 409, NOT a 500
        expect(res.body.error.code).toBe('CONTACT_ATTRIBUTE_CONFLICT');
        expect(res.body.conflict.conflicts).toEqual(JSON.parse(JSON.stringify(fresh))); // the CURRENT payload
        expect(mergeSvc.transferEmail).not.toHaveBeenCalled(); // never half-executed
        expect(clientSql()).toContain('ROLLBACK');
        expect(clientSql()).not.toContain('COMMIT');

        // Re-detection happened OUTSIDE the tx (no client arg → pool fallback).
        expect(mergeSvc.detectAttributeConflicts).toHaveBeenCalledTimes(2);
        expect(mergeSvc.detectAttributeConflicts.mock.calls[1][3]).toBeUndefined();

        // Async legs (leads cascade, orphan merge, ZB, event) never fired.
        expect(trace.some(t => /^pool:\s*UPDATE leads/.test(t))).toBe(false);
        expect(timelineMerge.mergeOrphanTimelines).not.toHaveBeenCalled();
        expect(eventService.logEvent).not.toHaveBeenCalled();
    });

    it('(iii, review fix c) contact_merged is emitted ONLY after COMMIT, with the payload returned by mergeContacts', async () => {
        const payload = { merged_contact_id: 77, merged_name: 'Owner 77', dropped_phones: ['+19995550001'] };
        mergeSvc.detectAttributeConflicts.mockResolvedValue([phoneConflict()]);
        mergeSvc.mergeContacts.mockImplementation(async () => { trace.push('svc:merge'); return payload; });
        eventService.logEvent.mockImplementation(() => { trace.push('svc:event'); });

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({
                phone_e164: P22,
                resolutions: [{ owner_contact_id: 77, action: 'merge', attributes: [{ kind: 'phone', value: P22 }] }],
            });

        expect(res.status).toBe(200);
        expect(eventService.logEvent).toHaveBeenCalledWith(COMPANY_A, 'contact', 5, 'contact_merged', payload);
        const iCommit = traceIdx('sql:COMMIT');
        const iEvent = traceIdx('svc:event');
        expect(iCommit).toBeGreaterThan(-1);
        expect(iEvent).toBeGreaterThan(iCommit); // strictly post-commit — never survives a ROLLBACK
    });
});

// ─── TC-CM-U15 — middleware / tenancy contract ────────────────────────────────
describe('TC-CM-U15: 401 / 403 / 404 foreign id / forged echo ignored / 400s', () => {
    it('(a) no token → 401 before the router; nothing touched', async () => {
        const res = await request(makeApp({ authenticated: false }))
            .patch('/api/contacts/5')
            .send({ first_name: 'X' });
        expect(res.status).toBe(401);
        expect(mockClient.query).not.toHaveBeenCalled();
        expect(mergeSvc.detectAttributeConflicts).not.toHaveBeenCalled();
    });

    it('(b) token without contacts.edit → 403; tx never opened', async () => {
        const res = await request(makeApp({ permissions: [] }))
            .patch('/api/contacts/5')
            .send({ first_name: 'X' });
        expect(res.status).toBe(403);
        expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('(c) foreign/absent :id (company-scoped getById → null) → 404 NOT_FOUND, no existence leak, no detection', async () => {
        contactsService.getById.mockResolvedValue(null);
        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ phone_e164: P22 });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
        expect(mockClient.query).not.toHaveBeenCalled();
        expect(mergeSvc.detectAttributeConflicts).not.toHaveBeenCalled();
    });

    it('(d) forged resolutions[].owner_contact_id pointing at a company-B contact matches no detected conflict → ignored', async () => {
        // Detection is company-scoped: the B-owner is INVISIBLE → no conflict.
        mergeSvc.detectAttributeConflicts.mockResolvedValue([]);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({
                phone_e164: P22,
                resolutions: [{ owner_contact_id: 666, action: 'merge', attributes: [{ kind: 'phone', value: P22 }] }],
            });

        expect(res.status).toBe(200); // plain save — the forged echo is dead weight
        expect(mergeSvc.mergeContacts).not.toHaveBeenCalled(); // NEVER with the B id
        expect(mergeSvc.transferPhone).not.toHaveBeenCalled();
        expect(clientSql()).toContain('COMMIT');
    });

    it('(e) non-numeric :id → 400 INVALID_ID', async () => {
        const res = await request(makeApp())
            .patch('/api/contacts/abc')
            .send({ first_name: 'X' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_ID');
    });

    it('(f) no fields and no emails → 400 NO_FIELDS; emails:[] stays a VALID removal-only update', async () => {
        const res400 = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ unknown_field: 'x' });
        expect(res400.status).toBe(400);
        expect(res400.body.error.code).toBe('NO_FIELDS');
        expect(mockClient.query).not.toHaveBeenCalled();

        const resOk = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ emails: [] });
        expect(resOk.status).toBe(200);
    });
});

// ─── TC-CM-U16 — Decision E: scalar email branch ──────────────────────────────
describe('TC-CM-U16: Decision E — scalar email: detection + in-tx enrich/resolve; emails[] precedence', () => {
    it('(a) scalar-only body, address NOT on the contact → included in detection; enrichEmail + resolveAddedEmail run in-tx; scalar column written as today', async () => {
        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ email: 'new@cm1.test' });

        expect(res.status).toBe(200);

        // Included in detection (added-email set).
        expect(mergeSvc.detectAttributeConflicts).toHaveBeenCalledWith(
            5, { phones: [], emails: ['new@cm1.test'] }, COMPANY_A, mockClient);

        // The scalar path now ALSO persists contact_emails (4175/4228 closure) …
        expect(dedupe.enrichEmail).toHaveBeenCalledTimes(1);
        expect(dedupe.enrichEmail).toHaveBeenCalledWith(5, 'new@cm1.test', mockClient);
        // … and resolves its correspondence, all INSIDE the tx.
        expect(mergeSvc.resolveAddedEmail).toHaveBeenCalledWith(5, 'new@cm1.test', COMPANY_A, mockClient);

        // The scalar column write is unchanged.
        const upd = findCall(/UPDATE contacts SET/i);
        expect(upd.sql).toMatch(/email = \$/);
        expect(upd.params).toContain('new@cm1.test');
        expect(clientSql()).toContain('COMMIT');
    });

    it('(a-conflict) a conflicted scalar → same 409 round-trip as emails[] (the Pulse panel hole is closed server-side)', async () => {
        mergeSvc.detectAttributeConflicts.mockResolvedValue([emailConflict(88, 'new@cm1.test')]);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ email: 'new@cm1.test' });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONTACT_ATTRIBUTE_CONFLICT');
        expect(countWrites()).toBe(0); // nothing committed, scalar included
        expect(dedupe.enrichEmail).not.toHaveBeenCalled();
    });

    it('(b) body carries BOTH scalar email and emails[] → emails[] wins, the scalar branch is skipped byte-for-byte', async () => {
        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ email: 'scalar@cm1.test', emails: [{ email: 'a@cm1.test', is_primary: true }] });

        expect(res.status).toBe(200);
        // Detection sees the emails[] set only — the scalar never enters.
        expect(mergeSvc.detectAttributeConflicts).toHaveBeenCalledWith(
            5, { phones: [], emails: ['a@cm1.test'] }, COMPANY_A, mockClient);
        // enrichEmail for the list entry only, never the scalar.
        expect(dedupe.enrichEmail).toHaveBeenCalledTimes(1);
        expect(dedupe.enrichEmail).toHaveBeenCalledWith(5, 'a@cm1.test', mockClient);
        // The scalar column is driven by the list's primary (existing behavior).
        const upd = findCall(/UPDATE contacts SET/i);
        expect(upd.params).toContain('a@cm1.test');
        expect(upd.params).not.toContain('scalar@cm1.test');
    });

    it('(c) scalar equals an address ALREADY on the contact → not newly-added: no detection entry, no enrich duplicate, no resolve', async () => {
        contactsService.getById.mockResolvedValue({ id: 5, company_id: COMPANY_A, email: 'have@cm1.test' });

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ email: 'have@cm1.test' });

        expect(res.status).toBe(200);
        expect(mergeSvc.detectAttributeConflicts).toHaveBeenCalledWith(
            5, { phones: [], emails: [] }, COMPANY_A, mockClient);
        expect(dedupe.enrichEmail).not.toHaveBeenCalled();
        expect(mergeSvc.resolveAddedEmail).not.toHaveBeenCalled();
    });

    it('(c2) scalar already recorded in contact_emails (not the scalar column) → same skip', async () => {
        dedupe.getAdditionalEmails.mockResolvedValue(['extra@cm1.test']);

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ email: 'extra@cm1.test' });

        expect(res.status).toBe(200);
        expect(mergeSvc.detectAttributeConflicts).toHaveBeenCalledWith(
            5, { phones: [], emails: [] }, COMPANY_A, mockClient);
        expect(dedupe.enrichEmail).not.toHaveBeenCalled();
        expect(mergeSvc.resolveAddedEmail).not.toHaveBeenCalled();
    });

    it('(d) empty scalar → untouched path (column cleared as today; no Decision-E machinery)', async () => {
        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ email: '' });

        expect(res.status).toBe(200);
        expect(dedupe.getAdditionalEmails).not.toHaveBeenCalled(); // branch never probed
        expect(mergeSvc.detectAttributeConflicts).toHaveBeenCalledWith(
            5, { phones: [], emails: [] }, COMPANY_A, mockClient);
        expect(dedupe.enrichEmail).not.toHaveBeenCalled();
        expect(mergeSvc.resolveAddedEmail).not.toHaveBeenCalled();
        const upd = findCall(/UPDATE contacts SET/i);
        expect(upd.sql).toMatch(/email = \$/);
        expect(upd.params).toContain(null); // '' → null, unchanged scalar semantics
    });
});

// ─── TC-CM-U17 — in-tx sentinel from step 5 → ROLLBACK → fresh 409 ────────────
describe('TC-CM-U17: sentinel born INSIDE the tx (step-5 resolveAddedEmail) → ROLLBACK → 409, not 500', () => {
    it('rolls the contact UPDATE + email upserts back and answers a freshly-built 409', async () => {
        const fresh = [emailConflict(88, 'x@cm1.test')];
        mergeSvc.detectAttributeConflicts
            .mockResolvedValueOnce([])     // detection saw nothing (owner born later)
            .mockResolvedValueOnce(fresh); // post-rollback re-detection
        mergeSvc.resolveAddedEmail.mockRejectedValue(
            new mergeSvc.ContactConflictError(88, [{ kind: 'email', value: 'x@cm1.test', normalized: 'x@cm1.test' }]));

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ first_name: 'Jane', emails: [{ email: 'x@cm1.test', is_primary: true }] });

        expect(res.status).toBe(409); // NOT a 500
        expect(res.body.error.code).toBe('CONTACT_ATTRIBUTE_CONFLICT');
        expect(res.body.conflict.conflicts).toEqual(JSON.parse(JSON.stringify(fresh)));

        // The writes DID run before the sentinel … and were rolled back with it.
        expect(dedupe.enrichEmail).toHaveBeenCalledWith(5, 'x@cm1.test', mockClient);
        expect(clientSql()).toContain('ROLLBACK');
        expect(clientSql()).not.toContain('COMMIT');

        // Async legs never fired.
        expect(trace.some(t => /^pool:\s*UPDATE leads/.test(t))).toBe(false);
        expect(timelineMerge.mergeOrphanTimelines).not.toHaveBeenCalled();
        expect(eventService.logEvent).not.toHaveBeenCalled();
    });

    it('(review fix a) a 40P01 lock-order deadlock inside the tx → ROLLBACK → 409 (retryable), not 500', async () => {
        mergeSvc.detectAttributeConflicts
            .mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
            .mockResolvedValueOnce([phoneConflict()]); // post-rollback re-detection

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ phone_e164: P22 });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONTACT_ATTRIBUTE_CONFLICT');
        expect(res.body.conflict.conflicts).toHaveLength(1);
        expect(clientSql()).toContain('ROLLBACK');
        expect(clientSql()).not.toContain('COMMIT');
    });

    it('a NON-sentinel tx error still surfaces as 500 INTERNAL_ERROR (no behavior widening)', async () => {
        mergeSvc.resolveAddedEmail.mockRejectedValue(new Error('boom'));

        const res = await request(makeApp())
            .patch('/api/contacts/5')
            .send({ emails: [{ email: 'x@cm1.test', is_primary: true }] });

        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
        expect(clientSql()).toContain('ROLLBACK');
    });
});
