'use strict';

/**
 * ONBTEL-001 Part A (ONBTEL-T11) — GET /api/onboarding/checklist + onboardingChecklistService.
 *
 * Covers TC-A-01…TC-A-16 (Docs/test-cases/ONBTEL-001.md §1):
 *   - 401 matrix via the REAL authenticate middleware (precedent: tests/keycloakAuth.test.js);
 *   - 403 matrix: PLATFORM_SCOPE_ONLY / TENANT_CONTEXT_REQUIRED via the REAL
 *     requireCompanyAccess + TENANT_ADMIN_ONLY via the route's inline requireTenantAdmin
 *     (parametrized over manager/dispatcher/provider) — all with ZERO checklist db calls;
 *   - dev-mode (_devMode) bypass of the admin gate;
 *   - happy path (visible:true) with the exact normative payload;
 *   - write-once completed_at: first all-done GET runs EXACTLY ONE guarded UPDATE
 *     (jsonb_set + "IS NULL" guard + WHERE id=$1) and answers visible:false;
 *   - already-completed → NO UPDATE at all; released-number cases E-A3/E-A4;
 *   - concurrent guard-UPDATE rowCount:0 tolerated (re-read wins); UPDATE failure → still
 *     visible:false, not 500 (E-A8);
 *   - tenant isolation: payload/query company_id injection ignored — every SQL gets
 *     req.companyFilter.company_id;
 *   - normative catalog strings verbatim (title/description/cta; "Albusto", never "Blanc");
 *   - EXISTS-query error → 500 INTERNAL_ERROR shape.
 *
 * Strategy (test-cases §1 «Стратегия моков»): jest-mocked pg (`db.query`), REAL
 * onboardingChecklistService + REAL routes/onboarding.js router, mini-express + supertest.
 * The production mount is `app.use('/api/onboarding', authenticate, onboardingRouter)` —
 * mirrored here with either the real authenticate (401 cases) or a controllable auth stub.
 *
 * Run:
 *   npx jest --runTestsByPath tests/onboardingChecklist.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

// keycloakAuth reads FEATURE_AUTH_ENABLED at module load — set BEFORE any require.
const ORIGINAL_ENV = {
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
};
process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.KEYCLOAK_REALM_URL = 'http://localhost:8080/realms/crm-prod';

afterAll(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

// keycloakAuth deps (precedent: tests/keycloakAuth.test.js). auditService.log fires on the
// 403 paths and must not touch a real DB.
jest.mock('../backend/src/services/userService', () => ({ findOrCreateUser: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(() => ({ scope: 'tenant', company: null, membership: null, permissions: [] })),
    resolveAuthzContext: jest.fn(),
}));
jest.mock('jwks-rsa', () => jest.fn().mockReturnValue({ getSigningKey: jest.fn() }));

// routes/onboarding.js top-level requires irrelevant to /checklist — stubbed for isolation.
jest.mock('../backend/src/services/otpService', () => ({ validateOtpToken: jest.fn(), trustDevice: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ resolve: jest.fn() }));
jest.mock('../backend/src/services/platformCompanyService', () => ({ bootstrapCompany: jest.fn() }));
jest.mock('../backend/src/db/membershipQueries', () => ({ getActiveMembership: jest.fn() }));

const express = require('express');
const request = require('supertest');

const db = require('../backend/src/db/connection');
const { authenticate } = require('../backend/src/middleware/keycloakAuth');
const onboardingRouter = require('../backend/src/routes/onboarding');
const checklistService = require('../backend/src/services/onboardingChecklistService');

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
    db.query.mockReset();
});

// Mirrors the production mount: app.use('/api/onboarding', authenticate, onboardingRouter).
function realAuthApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/onboarding', authenticate, onboardingRouter);
    return app;
}

// Authenticated app with a fully controllable authz context (the token layer is stubbed;
// requireCompanyAccess + requireTenantAdmin inside the router stay REAL).
function appWith({ user, authz } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = user || { sub: 'kc-1', email: 'admin@a.com', crmUser: { id: 'u1' } };
        if (authz !== undefined) req.authz = authz;
        next();
    });
    app.use('/api/onboarding', onboardingRouter);
    return app;
}

const tenantAdminAuthz = (companyId = COMPANY_A) => ({
    scope: 'tenant',
    platform_role: 'none',
    company: { id: companyId },
    membership: { role_key: 'tenant_admin' },
    permissions: [],
});

// db.query sequences for the service: [0] readCompletedAt, [1] EXISTS, ([2] guarded UPDATE…).
const completedAtRow = (value) => ({ rows: [{ completed_at: value }] });
const existsRow = (done) => ({ rows: [{ done }] });

// ─── 401 — real authenticate (TC-A-01, TC-A-02) ───────────────────────────────

describe('GET /api/onboarding/checklist — 401 via real authenticate', () => {
    test('TC-A-01: no Authorization header → 401 AUTH_REQUIRED, handler/db never reached', async () => {
        const res = await request(realAuthApp()).get('/api/onboarding/checklist');

        expect(res.status).toBe(401);
        expect(res.body).toEqual({
            code: 'AUTH_REQUIRED',
            message: 'Bearer token required',
            trace_id: expect.any(String),
        });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('TC-A-02: invalid/expired token → 401 AUTH_INVALID', async () => {
        const res = await request(realAuthApp())
            .get('/api/onboarding/checklist')
            .set('Authorization', 'Bearer not-a-jwt');

        expect(res.status).toBe(401);
        expect(res.body).toEqual(expect.objectContaining({ code: 'AUTH_INVALID' }));
        expect(db.query).not.toHaveBeenCalled();
    });
});

// ─── 403 matrix — requireCompanyAccess + inline tenant_admin gate ─────────────

describe('GET /api/onboarding/checklist — 403 matrix (zero checklist db calls)', () => {
    test('TC-A-03: platform-only user (super_admin, no tenant scope) → 403 PLATFORM_SCOPE_ONLY before any read/write', async () => {
        const app = appWith({
            authz: { scope: 'platform', platform_role: 'super_admin', company: null, membership: null },
        });
        const res = await request(app).get('/api/onboarding/checklist');

        expect(res.status).toBe(403);
        expect(res.body).toEqual(expect.objectContaining({
            code: 'PLATFORM_SCOPE_ONLY',
            message: 'Platform admins cannot access tenant resources.',
        }));
        expect(db.query).not.toHaveBeenCalled();
    });

    test('TC-A-04: authenticated but no membership (authz.company=null) → 403 TENANT_CONTEXT_REQUIRED', async () => {
        const app = appWith({
            authz: { scope: null, platform_role: 'none', company: null, membership: null },
        });
        const res = await request(app).get('/api/onboarding/checklist');

        expect(res.status).toBe(403);
        expect(res.body).toEqual(expect.objectContaining({
            code: 'TENANT_CONTEXT_REQUIRED',
            message: 'No company association found',
        }));
        expect(db.query).not.toHaveBeenCalled();
    });

    test.each(['manager', 'dispatcher', 'provider'])(
        'TC-A-05 (%s): active non-admin membership → 403 TENANT_ADMIN_ONLY, no reads and no write-once UPDATE',
        async (roleKey) => {
            const app = appWith({
                authz: {
                    scope: 'tenant',
                    platform_role: 'none',
                    company: { id: COMPANY_A },
                    membership: { role_key: roleKey },
                },
            });
            const res = await request(app).get('/api/onboarding/checklist');

            expect(res.status).toBe(403);
            expect(res.body).toEqual(expect.objectContaining({
                code: 'TENANT_ADMIN_ONLY',
                message: 'Tenant admin role required',
            }));
            // The gate is the inline role_key === 'tenant_admin' check, NOT
            // requireRole('company_admin') (which would let `manager` through).
            expect(db.query).not.toHaveBeenCalled();
        }
    );

    test('TC-A-06: dev-mode (_devMode) bypasses the admin gate → 200', async () => {
        db.query
            .mockResolvedValueOnce(completedAtRow(null)) // readCompletedAt
            .mockResolvedValueOnce(existsRow(false));    // connect_telephony EXISTS
        const app = appWith({
            user: { sub: 'dev-user', email: 'dev@localhost', _devMode: true, company_id: COMPANY_A },
            authz: undefined,
        });
        const res = await request(app).get('/api/onboarding/checklist');

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.checklist.visible).toBe(true);
    });
});

// ─── Happy path + write-once semantics ────────────────────────────────────────

describe('GET /api/onboarding/checklist — derived items + write-once completed_at', () => {
    test('TC-A-07: tenant_admin, no numbers, no completed_at → 200 visible:true with the exact normative item', async () => {
        db.query
            .mockResolvedValueOnce(completedAtRow(null))
            .mockResolvedValueOnce(existsRow(false));

        const res = await request(appWith({ authz: tenantAdminAuthz() })).get('/api/onboarding/checklist');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            checklist: {
                visible: true,
                completed_at: null,
                items: [{
                    key: 'connect_telephony',
                    title: 'Connect telephony',
                    description: 'Get a business phone number to make and receive calls and texts in Albusto.',
                    done: false,
                    cta: { label: 'Set up', path: '/settings/integrations/telephony-twilio' },
                }],
            },
        });
        // Both reads are company-scoped to the caller.
        expect(db.query).toHaveBeenCalledTimes(2);
        expect(db.query.mock.calls[0][1]).toEqual([COMPANY_A]);
        expect(db.query.mock.calls[1][0]).toContain('EXISTS(SELECT 1 FROM phone_number_settings WHERE company_id = $1)');
        expect(db.query.mock.calls[1][1]).toEqual([COMPANY_A]);
    });

    test('TC-A-08: first GET after all-done → EXACTLY ONE guarded UPDATE (write-once) and visible:false', async () => {
        const FIXED = '2026-07-02T12:00:00+00';
        db.query
            .mockResolvedValueOnce(completedAtRow(null))                       // readCompletedAt → not fixed yet
            .mockResolvedValueOnce(existsRow(true))                            // number exists → item done
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ completed_at: FIXED }] }); // guarded UPDATE wins

        const res = await request(appWith({ authz: tenantAdminAuthz() })).get('/api/onboarding/checklist');

        expect(res.status).toBe(200);
        expect(res.body.checklist.visible).toBe(false);
        expect(res.body.checklist.completed_at).toBe(FIXED);
        expect(res.body.checklist.items[0]).toEqual(expect.objectContaining({ key: 'connect_telephony', done: true }));

        // Exactly one UPDATE, guarded ("only while NULL") and company-scoped.
        expect(db.query).toHaveBeenCalledTimes(3);
        const updates = db.query.mock.calls.filter(([sql]) => sql.includes('UPDATE companies'));
        expect(updates).toHaveLength(1);
        const [updateSql, updateParams] = updates[0];
        // Write-once must deep-MERGE (|| + jsonb_build_object), NOT jsonb_set: a 2-level
        // jsonb_set path no-ops when 'onboarding_checklist' doesn't exist yet (fresh
        // company settings '{}'), so completed_at would never persist. This is a real-DB
        // behavior mocked jest can't execute — verified live in QA — but we pin the SQL
        // SHAPE here so a regression back to jsonb_set is caught structurally.
        expect(updateSql).not.toContain('jsonb_set');
        expect(updateSql).toContain('jsonb_build_object');
        expect(updateSql).toContain("'onboarding_checklist'");
        expect(updateSql).toContain("'completed_at'");
        expect(updateSql).toContain("(settings#>>'{onboarding_checklist,completed_at}') IS NULL");
        expect(updateSql).toContain('WHERE id = $1');
        expect(updateParams).toEqual([COMPANY_A]);
    });

    test('TC-A-09: completed_at already set → visible:false, existing value kept, UPDATE never issued', async () => {
        const EXISTING = '2026-07-01T09:30:00+00';
        db.query
            .mockResolvedValueOnce(completedAtRow(EXISTING))
            .mockResolvedValueOnce(existsRow(true));

        const checklist = await checklistService.getChecklist(COMPANY_A);

        expect(checklist.visible).toBe(false);
        expect(checklist.completed_at).toBe(EXISTING); // write-once — never overwritten
        expect(db.query).toHaveBeenCalledTimes(2);
        for (const [sql] of db.query.mock.calls) {
            expect(sql).not.toContain('UPDATE');
        }
    });

    test('TC-A-10: company_id injected via query AND body is ignored — every SQL is scoped to req.companyFilter', async () => {
        db.query
            .mockResolvedValueOnce(completedAtRow(null))
            .mockResolvedValueOnce(existsRow(false)); // COMPANY_A has no numbers (B "has" them — irrelevant)

        const res = await request(appWith({ authz: tenantAdminAuthz(COMPANY_A) }))
            .get(`/api/onboarding/checklist?company_id=${COMPANY_B}`)
            .send({ company_id: COMPANY_B });

        expect(res.status).toBe(200);
        // COMPANY_B data (it has numbers) must not flip A's answer.
        expect(res.body.checklist.visible).toBe(true);
        expect(db.query.mock.calls.length).toBeGreaterThan(0);
        for (const [, params] of db.query.mock.calls) {
            expect(params).toEqual([COMPANY_A]);
        }
        const allParams = db.query.mock.calls.flatMap(([, params]) => params || []);
        expect(allParams).not.toContain(COMPANY_B);
    });

    test('TC-A-11 (E-A3/E-A11): completed_at set but item derives done:false (number released later) → stays hidden, no reset, no UPDATE', async () => {
        const EXISTING = '2026-07-01T09:30:00+00';
        db.query
            .mockResolvedValueOnce(completedAtRow(EXISTING))
            .mockResolvedValueOnce(existsRow(false)); // number released AFTER fixation

        const checklist = await checklistService.getChecklist(COMPANY_A);

        expect(checklist.visible).toBe(false); // gone forever
        expect(checklist.completed_at).toBe(EXISTING);
        expect(checklist.items[0].done).toBe(false);
        expect(db.query).toHaveBeenCalledTimes(2);
        for (const [sql] of db.query.mock.calls) {
            expect(sql).not.toContain('UPDATE');
        }
    });

    test('TC-A-12 (E-A4): number bought and released BEFORE any GET → visible:true, nothing was fixed', async () => {
        db.query
            .mockResolvedValueOnce(completedAtRow(null))
            .mockResolvedValueOnce(existsRow(false));

        const checklist = await checklistService.getChecklist(COMPANY_A);

        expect(checklist).toEqual({
            visible: true,
            completed_at: null,
            items: [expect.objectContaining({ key: 'connect_telephony', done: false })],
        });
        expect(db.query).toHaveBeenCalledTimes(2); // no UPDATE attempted
    });

    test('TC-A-13 (E-A2): concurrent GET — guard-UPDATE rowCount:0 → no error, winner value re-read, visible:false', async () => {
        const WINNER = '2026-07-02T10:00:00+00';
        db.query
            .mockResolvedValueOnce(completedAtRow(null))
            .mockResolvedValueOnce(existsRow(true))
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })       // another GET won the write
            .mockResolvedValueOnce(completedAtRow(WINNER));          // re-read the winner's value

        const checklist = await checklistService.getChecklist(COMPANY_A);

        expect(checklist.visible).toBe(false);
        expect(checklist.completed_at).toBe(WINNER);
        expect(db.query).toHaveBeenCalledTimes(4);
    });

    test('TC-A-14 (E-A8): guard-UPDATE throws → still 200 visible:false (derived from allDone), retried next GET', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // Service level: the write failure must not reject.
            db.query
                .mockResolvedValueOnce(completedAtRow(null))
                .mockResolvedValueOnce(existsRow(true))
                .mockRejectedValueOnce(new Error('deadlock detected'));

            const checklist = await checklistService.getChecklist(COMPANY_A);
            expect(checklist.visible).toBe(false);
            expect(checklist.completed_at).toBeNull();

            // Route level: the response is 200, NOT 500.
            db.query.mockReset();
            db.query
                .mockResolvedValueOnce(completedAtRow(null))
                .mockResolvedValueOnce(existsRow(true))
                .mockRejectedValueOnce(new Error('deadlock detected'));

            const res = await request(appWith({ authz: tenantAdminAuthz() })).get('/api/onboarding/checklist');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(expect.objectContaining({
                ok: true,
                checklist: expect.objectContaining({ visible: false, completed_at: null }),
            }));
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('TC-A-15: data-driven catalog — items come from the registry, normative strings verbatim (Albusto, never Blanc)', async () => {
        // The registry itself carries the normative §1.3 strings…
        expect(checklistService.CHECKLIST_ITEMS).toHaveLength(1);
        const item = checklistService.CHECKLIST_ITEMS[0];
        expect(item.key).toBe('connect_telephony');
        expect(item.title).toBe('Connect telephony');
        expect(item.description).toBe('Get a business phone number to make and receive calls and texts in Albusto.');
        expect(item.cta).toEqual({ label: 'Set up', path: '/settings/integrations/telephony-twilio' });
        expect(item.description).toContain('Albusto');
        expect(item.description).not.toContain('Blanc');

        // …and the response items[] are built exactly from that registry.
        db.query
            .mockResolvedValueOnce(completedAtRow(null))
            .mockResolvedValueOnce(existsRow(false));
        const checklist = await checklistService.getChecklist(COMPANY_A);
        expect(checklist.items).toEqual(checklistService.CHECKLIST_ITEMS.map(({ key, title, description, cta }) => ({
            key, title, description, cta, done: false,
        })));
    });

    test('TC-A-16: EXISTS query throws → 500 { ok:false, code:INTERNAL_ERROR, error:"Failed to load onboarding checklist" }', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            db.query
                .mockResolvedValueOnce(completedAtRow(null))
                .mockRejectedValueOnce(new Error('relation lost'));

            const res = await request(appWith({ authz: tenantAdminAuthz() })).get('/api/onboarding/checklist');

            expect(res.status).toBe(500);
            expect(res.body).toEqual({
                ok: false,
                code: 'INTERNAL_ERROR',
                error: 'Failed to load onboarding checklist',
            });
        } finally {
            errorSpy.mockRestore();
        }
    });
});
