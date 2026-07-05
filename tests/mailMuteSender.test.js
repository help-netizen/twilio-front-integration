/**
 * MAIL-MUTE-001 T1 — unit tests for the mute-verdict helpers on mailAgentService.
 *
 * Covers the TC-MM-U* helper cases: from-only filtering (DECISION-B), negation
 * rescue, domain-vs-exact projection, subject/body/any/mixed rules excluded,
 * regex from: → matches isSenderMuted but NOT projected into getMutedSenderSet,
 * inactive/empty settings → not muted / empty set, fail-open on malformed rules,
 * and the module-surface (exports not regressed).
 *
 * db is mocked; mailAgentRules.matchEmail is NOT mocked — the real matcher is
 * reused (C-2). getActiveState is armed by controlling db.query (installation row)
 * + mailAgentQueries.ensureSettingsRow (the pinned settings row), exactly as the
 * sibling suite tests/mailAgentService.test.js does.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/mailAgentQueries', () => ({
    getSettings: jest.fn(),
    ensureSettingsRow: jest.fn(),
    getEmailMessage: jest.fn(),
    hasReview: jest.fn(),
    insertReview: jest.fn().mockResolvedValue({ id: 1 }),
    createEmailContact: jest.fn(),
    listRecentInbound: jest.fn(),
}));
jest.mock('../backend/src/db/timelinesQueries', () => ({
    createTask: jest.fn(),
    setActionRequired: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/db/emailQueries', () => ({ findEmailContact: jest.fn() }));
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: jest.fn() }));
jest.mock('../backend/src/services/mailAgentClassifier', () => ({ classifyEmail: jest.fn() }));
jest.mock('../backend/src/services/email/emailTimelineService', () => ({
    linkInboundMessage: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const q = require('../backend/src/db/mailAgentQueries');
const mailAgentService = require('../backend/src/services/mailAgentService');

const COMPANY = '00000000-0000-0000-0000-000000000001';

const BASE_SETTINGS = {
    enabled: true,
    confidence_threshold: 0.6,
    create_contact_for_unknown: true,
    assign_owner_user_id: null,
    exclusion_rules: '',
    activated_at: '2026-07-01T00:00:00.000Z',
};

/** Arm getActiveState → active with the given exclusion_rules text (busts the 60s cache). */
function armActive(exclusionRules = '') {
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] }); // installation present
    q.ensureSettingsRow.mockResolvedValue({ ...BASE_SETTINGS, exclusion_rules: exclusionRules });
    mailAgentService.invalidateCache(COMPANY);
}

/** Arm getActiveState → inactive (no installation row). */
function armInactive() {
    db.query.mockResolvedValue({ rows: [] });
    mailAgentService.invalidateCache(COMPANY);
}

function msgFrom(fromEmail, fromName = '', extra = {}) {
    return { from_name: fromName, from_email: fromEmail, subject: 's', body_text: 'b', ...extra };
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// isSenderMuted
// ────────────────────────────────────────────────────────────────────────────
describe('isSenderMuted', () => {
    // TC-MM-U01 — from-only exact-address rule matches → true. The service imports
    // matchEmail via destructuring (captured at module load), so it cannot be spied
    // on the exports object; instead we prove the from-only line + byte-identical
    // from surface through the real matcher's observable behavior:
    //  - exact-address from: rule matches → true (from surface carries the address);
    //  - a rule that matches ONLY the display-NAME portion still fires, which is
    //    only possible if the composed surface "Name <email>" (buildRuleInput) was
    //    passed — an address-only surface would never contain the name.
    test('U01: from-only exact-address rule → true, matches via byte-identical name<email> surface', async () => {
        armActive('from:customerservice@relyhome.com');
        expect(await mailAgentService.isSenderMuted(
            COMPANY,
            msgFrom('customerservice@relyhome.com', 'Rely Support', { subject: 'x', body_text: 'y' })
        )).toBe(true);

        // The from surface must be "Rely Support <customerservice@relyhome.com>":
        // a from: token on the display name alone matches only because the name is
        // present in the composed surface (proves buildRuleInput was used verbatim).
        armActive('from:"Rely Support"');
        expect(await mailAgentService.isSenderMuted(
            COMPANY,
            msgFrom('customerservice@relyhome.com', 'Rely Support')
        )).toBe(true);

        // subject/body text must NOT bleed into the from surface — a from: token on
        // the subject value does not match (surface is name<email> only).
        armActive('from:invoicetoken');
        expect(await mailAgentService.isSenderMuted(
            COMPANY,
            msgFrom('customerservice@relyhome.com', 'Rely Support', { subject: 'invoicetoken here' })
        )).toBe(false);
    });

    // TC-MM-U02 — from-only domain rule matches any *@relyhome.com; other domain → false.
    test('U02: from-only domain rule (from:relyhome.com / from:@relyhome.com) → true for any @relyhome.com', async () => {
        for (const rule of ['from:relyhome.com', 'from:@relyhome.com']) {
            armActive(rule);
            expect(await mailAgentService.isSenderMuted(COMPANY, msgFrom('anyone@relyhome.com'))).toBe(true);
            armActive(rule);
            expect(await mailAgentService.isSenderMuted(COMPANY, msgFrom('foo@other.com'))).toBe(false);
        }
    });

    // TC-MM-U03 — subject/body/any/MIXED rules are NOT muted (from-only filter drops them). DECISION-B core.
    test('U03: subject/body/any/mixed rules → false (fromOnlyRules yields empty subset)', async () => {
        // (a) subject-only, (b) body-only, (c) any, (d) mixed from:+subject:
        armActive('subject:invoice');
        expect(await mailAgentService.isSenderMuted(COMPANY, msgFrom('x@relyhome.com', '', { subject: 'invoice' }))).toBe(false);

        armActive('body:unsubscribe');
        expect(await mailAgentService.isSenderMuted(COMPANY, msgFrom('x@relyhome.com', '', { body_text: 'please unsubscribe' }))).toBe(false);

        armActive('any:promo');
        expect(await mailAgentService.isSenderMuted(COMPANY, msgFrom('promo@relyhome.com', '', { subject: 'promo' }))).toBe(false);

        armActive('from:relyhome.com subject:invoice');
        expect(await mailAgentService.isSenderMuted(COMPANY, msgFrom('x@relyhome.com', '', { subject: 'invoice' }))).toBe(false);
    });

    // TC-MM-U04 — same-line -from: negation rescue honored verbatim.
    test('U04: same-line -from: negation → true when unmatched by negation, false when rescued', async () => {
        armActive('from:notifications@github.com -from:security');
        // (a) normal github notification (no "security" in from) → line matches → true
        expect(await mailAgentService.isSenderMuted(COMPANY, msgFrom('notifications@github.com', 'GitHub'))).toBe(true);
        // (b) from contains "security" → -from:security rescues → false
        armActive('from:notifications@github.com -from:security');
        expect(await mailAgentService.isSenderMuted(COMPANY, msgFrom('security@github.com', 'GitHub'))).toBe(false);
    });

    // TC-MM-U05 — inactive / not connected → false immediately (short-circuit before
    // any rule parse: settings are never even loaded from the installation path).
    test('U05: inactive → false immediately, no settings read', async () => {
        armInactive();
        const res = await mailAgentService.isSenderMuted(COMPANY, msgFrom('customerservice@relyhome.com'));
        expect(res).toBe(false);
        // ensureSettingsRow is only reached when an installation row exists; inactive
        // means the gate returns before parsing → the rules are never consulted.
        expect(q.ensureSettingsRow).not.toHaveBeenCalled();
    });

    // TC-MM-U06 — regex from: token participates at link time → true.
    test('U06: regex from: token (from:/rely.*/i) → true (delegates to matchEmail)', async () => {
        armActive('from:/rely.*/i');
        expect(await mailAgentService.isSenderMuted(COMPANY, msgFrom('billing@relyhome.com'))).toBe(true);
    });

    // TC-MM-U20 — fail-open: a thrown error inside the helper → false (no throw escapes).
    test('U20: fail-open → false when getActiveState rejects', async () => {
        db.query.mockRejectedValue(new Error('db down'));
        mailAgentService.invalidateCache(COMPANY);
        // getActiveState swallows the db error and returns {active:false}; even so,
        // verify no rejection propagates out of isSenderMuted.
        await expect(mailAgentService.isSenderMuted(COMPANY, msgFrom('x@relyhome.com'))).resolves.toBe(false);
    });

    // TC-MM-U20 (throw-past-the-gate variant) — a throw AFTER the active gate (while
    // reading/parsing the rules) is caught → still false. Poison exclusion_rules so
    // accessing it inside isSenderMuted throws.
    test('U20b: fail-open → false when rule access throws past the active gate', async () => {
        db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
        q.ensureSettingsRow.mockResolvedValue({
            ...BASE_SETTINGS,
            get exclusion_rules() { throw new Error('boom'); },
        });
        mailAgentService.invalidateCache(COMPANY);
        await expect(mailAgentService.isSenderMuted(COMPANY, msgFrom('x@relyhome.com'))).resolves.toBe(false);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// getMutedSenderSet
// ────────────────────────────────────────────────────────────────────────────
describe('getMutedSenderSet', () => {
    // TC-MM-U07 — projects literal from-only contains tokens into emails vs domains; excludes subject/body/mixed.
    test('U07: projects literals into emails/domains; excludes mixed + subject-only lines', async () => {
        armActive([
            'from:customerservice@relyhome.com',
            'from:@vendor.com',
            'from:acme.io',
            'from:foo@bar.com subject:invoice', // mixed → excluded
            'subject:promo',                    // not from-only → excluded
        ].join('\n'));
        const set = await mailAgentService.getMutedSenderSet(COMPANY);
        expect(set.emails.sort()).toEqual(['customerservice@relyhome.com']);
        expect(set.domains.sort()).toEqual(['acme.io', 'vendor.com']);
    });

    // TC-MM-U08 — inactive → { emails:[], domains:[] }.
    test('U08: inactive → empty set', async () => {
        armInactive();
        expect(await mailAgentService.getMutedSenderSet(COMPANY)).toEqual({ emails: [], domains: [] });
    });

    // TC-MM-U09 — negated from-only token NOT projected; positive literal on same line IS.
    test('U09: negated token not projected; positive domain literal is', async () => {
        armActive('from:relyhome.com -from:billing');
        const set = await mailAgentService.getMutedSenderSet(COMPANY);
        expect(set.domains).toContain('relyhome.com');
        // "billing" (the negated token) must not leak into either set.
        expect(set.emails).not.toContain('billing');
        expect(set.domains).not.toContain('billing');
    });

    // TC-MM-U10 — regex from: token NOT projected into the SQL set (link-time only).
    test('U10: regex from: token → empty set (literal extractor skips regex)', async () => {
        armActive('from:/rely.*/i');
        expect(await mailAgentService.getMutedSenderSet(COMPANY)).toEqual({ emails: [], domains: [] });
    });

    // TC-MM-U11 — domain vs exact discrimination on token shape (a/b/c/d).
    test('U11: domain-vs-exact discrimination', async () => {
        // (a) full address
        armActive('from:customerservice@relyhome.com');
        expect(await mailAgentService.getMutedSenderSet(COMPANY)).toEqual({ emails: ['customerservice@relyhome.com'], domains: [] });
        // (b) @domain
        armActive('from:@relyhome.com');
        expect(await mailAgentService.getMutedSenderSet(COMPANY)).toEqual({ emails: [], domains: ['relyhome.com'] });
        // (c) bare host.tld
        armActive('from:relyhome.com');
        expect(await mailAgentService.getMutedSenderSet(COMPANY)).toEqual({ emails: [], domains: ['relyhome.com'] });
        // (d) bare word, no @ and no . → projected nowhere
        armActive('from:justaword');
        expect(await mailAgentService.getMutedSenderSet(COMPANY)).toEqual({ emails: [], domains: [] });
    });

    // TC-MM-U21 — fail-open: a thrown error → { emails:[], domains:[] }.
    test('U21: fail-open → empty set when matchEmail path / parse throws', async () => {
        // Force a throw past the active gate via a poisoned settings object whose
        // exclusion_rules getter throws when read by safeParseRules.
        db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
        q.ensureSettingsRow.mockResolvedValue({
            ...BASE_SETTINGS,
            get exclusion_rules() { throw new Error('poison'); },
        });
        mailAgentService.invalidateCache(COMPANY);
        await expect(mailAgentService.getMutedSenderSet(COMPANY)).resolves.toEqual({ emails: [], domains: [] });
    });

    // Dedupe: repeated literals collapse.
    test('U07b: dedupes repeated literals across lines', async () => {
        armActive(['from:relyhome.com', 'from:@relyhome.com', 'from:a@x.com', 'from:a@x.com'].join('\n'));
        const set = await mailAgentService.getMutedSenderSet(COMPANY);
        expect(set.domains).toEqual(['relyhome.com']);
        expect(set.emails).toEqual(['a@x.com']);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Module surface
// ────────────────────────────────────────────────────────────────────────────
describe('module surface', () => {
    // TC-MM-U22 — both new fns exported; pre-existing exports not regressed.
    test('U22: isSenderMuted + getMutedSenderSet exported; existing exports intact', () => {
        expect(typeof mailAgentService.isSenderMuted).toBe('function');
        expect(typeof mailAgentService.getMutedSenderSet).toBe('function');
        for (const name of ['isActive', 'reviewInboundEmail', 'dryRun', 'invalidateCache']) {
            expect(typeof mailAgentService[name]).toBe('function');
        }
    });
});
