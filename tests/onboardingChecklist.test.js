'use strict';

/**
 * ONBOARDING-UX-001 T1 — GET /api/onboarding/checklist and onboarding redirect.
 *
 * Covers TC-OBX-001…018 from Docs/test-cases/ONBOARDING-UX-001.md with the real
 * checklist service, real onboarding router, and real auth middleware for 401s.
 */

const ORIGINAL_ENV = {
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    FEATURE_SELF_SIGNUP: process.env.FEATURE_SELF_SIGNUP,
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
jest.mock('../backend/src/services/emailMailboxService', () => ({ getMailboxStatus: jest.fn() }));
jest.mock('../backend/src/services/stripePaymentsService', () => ({ getStatus: jest.fn() }));
jest.mock('../backend/src/services/billingService', () => ({ getSubscription: jest.fn() }));

// keycloakAuth dependencies. auditService.log fires on 403 paths and must not
// touch a real database.
jest.mock('../backend/src/services/userService', () => ({ findOrCreateUser: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(() => ({ scope: 'tenant', company: null, membership: null, permissions: [] })),
    resolveAuthzContext: jest.fn(),
}));
jest.mock('jwks-rsa', () => jest.fn().mockReturnValue({ getSigningKey: jest.fn() }));

// POST /onboarding collaborators and routes irrelevant to /checklist.
jest.mock('../backend/src/services/otpService', () => ({ validateOtpToken: jest.fn(), trustDevice: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ resolve: jest.fn() }));
jest.mock('../backend/src/services/platformCompanyService', () => ({ bootstrapCompany: jest.fn() }));
jest.mock('../backend/src/db/membershipQueries', () => ({ getActiveMembership: jest.fn() }));

const express = require('express');
const request = require('supertest');

const db = require('../backend/src/db/connection');
const emailMailboxService = require('../backend/src/services/emailMailboxService');
const stripePaymentsService = require('../backend/src/services/stripePaymentsService');
const billingService = require('../backend/src/services/billingService');
const otpService = require('../backend/src/services/otpService');
const googlePlacesService = require('../backend/src/services/googlePlacesService');
const platformCompanyService = require('../backend/src/services/platformCompanyService');
const membershipQueries = require('../backend/src/db/membershipQueries');
const { authenticate } = require('../backend/src/middleware/keycloakAuth');
const onboardingRouter = require('../backend/src/routes/onboarding');
const checklistService = require('../backend/src/services/onboardingChecklistService');

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';
const NOW_MS = Date.parse('2026-07-12T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const CATALOG = [
    {
        key: 'company_profile',
        title: 'Add your logo',
        description: 'Put your brand on every estimate, invoice, and email your customers see.',
        cta: { label: 'Set up', path: '/settings/company' },
        est_minutes: 1,
        done_note: 'Looking sharp — your brand is on your documents.',
    },
    {
        key: 'connect_telephony',
        title: 'Connect telephony',
        description: 'Get a business phone number to make and receive calls and texts in Albusto.',
        cta: { label: 'Set up', path: '/settings/integrations/telephony-twilio' },
        est_minutes: 2,
        done_note: 'Nice — your phone line is live!',
    },
    {
        key: 'connect_email',
        title: 'Connect your email',
        description: 'Bring your Gmail into Albusto so every customer email lands in one timeline.',
        cta: { label: 'Set up', path: '/settings/integrations/google-email' },
        est_minutes: 1,
        done_note: 'Great — your email flows into Albusto now.',
    },
    {
        key: 'stripe_payments',
        title: 'Get paid with Stripe',
        description: 'Take card payments on the job, by link, or over the phone.',
        cta: { label: 'Set up', path: '/settings/integrations/stripe-payments' },
        est_minutes: 5,
        done_note: "You're ready to get paid on the spot.",
    },
];

beforeEach(() => {
    process.env.FEATURE_SELF_SIGNUP = 'false';
    db.query.mockReset();
    emailMailboxService.getMailboxStatus.mockReset().mockResolvedValue(null);
    stripePaymentsService.getStatus.mockReset().mockResolvedValue({ readiness: 'not_connected' });
    billingService.getSubscription.mockReset().mockResolvedValue(null);
    otpService.validateOtpToken.mockReset();
    otpService.trustDevice.mockReset();
    googlePlacesService.resolve.mockReset();
    platformCompanyService.bootstrapCompany.mockReset();
    membershipQueries.getActiveMembership.mockReset();
});

function realAuthApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/onboarding', authenticate, onboardingRouter);
    return app;
}

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

const completedAtRow = value => ({ rows: [{ completed_at: value }] });
const doneRow = done => ({ rows: [{ done }] });

function mockChecklistDb({ completedAt = null, profileDone = false, telephonyDone = false } = {}) {
    db.query
        .mockResolvedValueOnce(completedAtRow(completedAt))
        .mockResolvedValueOnce(doneRow(profileDone))
        .mockResolvedValueOnce(doneRow(telephonyDone));
}

function expectedItems(done) {
    return CATALOG.map((item, index) => ({ ...item, done: done[index] }));
}

function expectNoChecklistWork() {
    expect(db.query).not.toHaveBeenCalled();
    expect(emailMailboxService.getMailboxStatus).not.toHaveBeenCalled();
    expect(stripePaymentsService.getStatus).not.toHaveBeenCalled();
    expect(billingService.getSubscription).not.toHaveBeenCalled();
}

describe('GET /api/onboarding/checklist — catalog, progress, and write-once state', () => {
    test('TC-OBX-001: new company returns exact 0-of-4 payload and active trial without UPDATE', async () => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
        try {
            mockChecklistDb();
            const trialEnd = new Date(NOW_MS + 14 * DAY_MS).toISOString();
            billingService.getSubscription.mockResolvedValue({ status: 'trialing', trial_ends_at: trialEnd });

            const res = await request(appWith({ authz: tenantAdminAuthz() })).get('/api/onboarding/checklist');

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                ok: true,
                checklist: {
                    visible: true,
                    completed_at: null,
                    progress: { done: 0, total: 4 },
                    trial: { active: true, days_left: 14, trial_ends_at: trialEnd },
                    items: expectedItems([false, false, false, false]),
                },
            });
            expect(JSON.stringify(res.body)).not.toContain('Blanc');
            expect(checklistService.CHECKLIST_ITEMS).toHaveLength(4);
            expect(db.query.mock.calls.some(([sql]) => sql.includes('UPDATE companies'))).toBe(false);
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('TC-OBX-002: partial completion returns 2-of-4 and remains visible', async () => {
        mockChecklistDb({ profileDone: true, telephonyDone: true });
        stripePaymentsService.getStatus.mockResolvedValue({ readiness: 'onboarding_incomplete' });

        const res = await request(appWith({ authz: tenantAdminAuthz() })).get('/api/onboarding/checklist');

        expect(res.status).toBe(200);
        expect(res.body.checklist).toEqual(expect.objectContaining({
            visible: true,
            completed_at: null,
            progress: { done: 2, total: 4 },
            items: expectedItems([true, true, false, false]),
        }));
        expect(db.query.mock.calls.some(([sql]) => sql.includes('UPDATE companies'))).toBe(false);
    });

    test('TC-OBX-003: all four done performs exactly one guarded write-once UPDATE', async () => {
        const fixed = '2026-07-12T12:30:00+00';
        mockChecklistDb({ profileDone: true, telephonyDone: true });
        emailMailboxService.getMailboxStatus.mockResolvedValue({ provider: 'gmail', status: 'connected' });
        stripePaymentsService.getStatus.mockResolvedValue({ readiness: 'connected_ready' });
        db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ completed_at: fixed }] });

        const res = await request(appWith({ authz: tenantAdminAuthz() })).get('/api/onboarding/checklist');

        expect(res.status).toBe(200);
        expect(res.body.checklist).toEqual(expect.objectContaining({
            visible: false,
            completed_at: fixed,
            progress: { done: 4, total: 4 },
            items: expectedItems([true, true, true, true]),
        }));
        const updates = db.query.mock.calls.filter(([sql]) => sql.includes('UPDATE companies'));
        expect(updates).toHaveLength(1);
        const [updateSql, updateParams] = updates[0];
        expect(updateSql).not.toContain('jsonb_set');
        expect(updateSql).toContain('jsonb_build_object');
        expect(updateSql).toContain("'onboarding_checklist'");
        expect(updateSql).toContain("'completed_at'");
        expect(updateSql).toContain("(settings#>>'{onboarding_checklist,completed_at}') IS NULL");
        expect(updateSql).toContain('WHERE id = $1');
        expect(updateParams).toEqual([COMPANY_A]);
    });

    test('TC-OBX-004: existing completed_at never resurfaces despite incomplete new catalog items', async () => {
        const existing = '2026-07-01T09:30:00+00';
        mockChecklistDb({ completedAt: existing, profileDone: false, telephonyDone: true });

        const checklist = await checklistService.getChecklist(COMPANY_A);

        expect(checklist).toEqual(expect.objectContaining({
            visible: false,
            completed_at: existing,
            progress: { done: 1, total: 4 },
            items: expectedItems([false, true, false, false]),
        }));
        expect(db.query.mock.calls.some(([sql]) => sql.includes('UPDATE companies'))).toBe(false);
    });
});

describe('individual checklist derivations', () => {
    test.each([
        ['logo exists', true, true],
        ['logo is null', false, false],
    ])('TC-OBX-005: company_profile — %s', async (_label, queryDone, expected) => {
        db.query.mockResolvedValueOnce(doneRow(queryDone));
        const item = checklistService.CHECKLIST_ITEMS.find(candidate => candidate.key === 'company_profile');

        await expect(item.isComplete(COMPANY_A)).resolves.toBe(expected);

        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('SELECT logo_storage_key IS NOT NULL AS done FROM companies WHERE id = $1'),
            [COMPANY_A]
        );
    });

    test.each([
        ['no mailbox', null, false],
        ['connected Gmail', { provider: 'gmail', status: 'connected' }, true],
        ['Gmail reconnect required', { provider: 'gmail', status: 'reconnect_required' }, false],
        ['connected non-Gmail', { provider: 'imap', status: 'connected' }, false],
    ])('TC-OBX-006: connect_email — %s', async (_label, mailbox, expected) => {
        emailMailboxService.getMailboxStatus.mockResolvedValueOnce(mailbox);
        const item = checklistService.CHECKLIST_ITEMS.find(candidate => candidate.key === 'connect_email');

        await expect(item.isComplete(COMPANY_A)).resolves.toBe(expected);
        expect(emailMailboxService.getMailboxStatus).toHaveBeenCalledWith(COMPANY_A);
    });

    test.each([
        ['not_connected', false],
        ['onboarding_incomplete', false],
        ['payouts_disabled', false],
        ['connected_ready', true],
        ['disconnected', false],
    ])('TC-OBX-007: stripe_payments readiness %s → %s', async (readiness, expected) => {
        stripePaymentsService.getStatus.mockResolvedValueOnce({ readiness });
        const item = checklistService.CHECKLIST_ITEMS.find(candidate => candidate.key === 'stripe_payments');

        await expect(item.isComplete(COMPANY_A)).resolves.toBe(expected);
        expect(stripePaymentsService.getStatus).toHaveBeenCalledWith(COMPANY_A);
    });

    test.each([
        ['active number exists', true, true],
        ['released number has no row', false, false],
    ])('TC-OBX-008: connect_telephony regression — %s', async (_label, queryDone, expected) => {
        db.query.mockResolvedValueOnce(doneRow(queryDone));
        const item = checklistService.CHECKLIST_ITEMS.find(candidate => candidate.key === 'connect_telephony');

        await expect(item.isComplete(COMPANY_A)).resolves.toBe(expected);

        expect(db.query).toHaveBeenCalledWith(
            'SELECT EXISTS(SELECT 1 FROM phone_number_settings WHERE company_id = $1) AS done',
            [COMPANY_A]
        );
    });
});

describe('trial projection', () => {
    test.each([
        ['14 days', 14 * DAY_MS, 14],
        ['25 hours', 25 * 60 * 60 * 1000, 2],
        ['1 hour', 60 * 60 * 1000, 1],
        ['exactly now', 0, null],
        ['one second ago', -1000, null],
    ])('TC-OBX-009: %s', async (_label, offsetMs, expectedDays) => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
        try {
            mockChecklistDb();
            const trialEnd = new Date(NOW_MS + offsetMs).toISOString();
            billingService.getSubscription.mockResolvedValue({ status: 'trialing', trial_ends_at: trialEnd });

            const checklist = await checklistService.getChecklist(COMPANY_A);

            if (expectedDays === null) {
                expect(checklist.trial).toBeNull();
            } else {
                expect(checklist.trial).toEqual({ active: true, days_left: expectedDays, trial_ends_at: trialEnd });
            }
        } finally {
            nowSpy.mockRestore();
        }
    });

    test.each([
        ['missing subscription', null],
        ['active subscription', { status: 'active', trial_ends_at: null }],
        ['past-due subscription', { status: 'past_due', trial_ends_at: null }],
    ])('TC-OBX-010: %s produces trial:null', async (_label, subscription) => {
        mockChecklistDb();
        billingService.getSubscription.mockResolvedValue(subscription);

        const checklist = await checklistService.getChecklist(COMPANY_A);

        expect(checklist.trial).toBeNull();
        expect(checklist.visible).toBe(true);
        expect(checklist.items).toHaveLength(4);
    });

    test('TC-OBX-011: billing read failure warns and returns a complete 200 response with trial:null', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            mockChecklistDb();
            billingService.getSubscription.mockRejectedValue(new Error('db down'));

            const res = await request(appWith({ authz: tenantAdminAuthz() })).get('/api/onboarding/checklist');

            expect(res.status).toBe(200);
            expect(res.body.checklist).toEqual(expect.objectContaining({
                visible: true,
                progress: { done: 0, total: 4 },
                trial: null,
                items: expectedItems([false, false, false, false]),
            }));
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining(`failed to read trial for company ${COMPANY_A}`),
                'db down'
            );
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('errors, authentication, authorization, and tenant isolation', () => {
    test('TC-OBX-012: item derivation error bubbles to 500 INTERNAL_ERROR', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            db.query
                .mockResolvedValueOnce(completedAtRow(null))
                .mockResolvedValueOnce(doneRow(false))
                .mockRejectedValueOnce(new Error('relation lost'));

            const res = await request(appWith({ authz: tenantAdminAuthz() })).get('/api/onboarding/checklist');

            expect(res.status).toBe(500);
            expect(res.body).toEqual({
                ok: false,
                code: 'INTERNAL_ERROR',
                error: 'Failed to load onboarding checklist',
            });
            expect(billingService.getSubscription).not.toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('TC-OBX-013a: no Authorization header returns 401 before checklist work', async () => {
        const res = await request(realAuthApp()).get('/api/onboarding/checklist');

        expect(res.status).toBe(401);
        expect(res.body).toEqual({
            code: 'AUTH_REQUIRED',
            message: 'Bearer token required',
            trace_id: expect.any(String),
        });
        expectNoChecklistWork();
    });

    test('TC-OBX-013b: malformed bearer token returns 401 before checklist work', async () => {
        const res = await request(realAuthApp())
            .get('/api/onboarding/checklist')
            .set('Authorization', 'Bearer not-a-jwt');

        expect(res.status).toBe(401);
        expect(res.body).toEqual(expect.objectContaining({ code: 'AUTH_INVALID' }));
        expectNoChecklistWork();
    });

    test('TC-OBX-014a: platform-only user is rejected before checklist work', async () => {
        const res = await request(appWith({
            authz: { scope: 'platform', platform_role: 'super_admin', company: null, membership: null },
        })).get('/api/onboarding/checklist');

        expect(res.status).toBe(403);
        expect(res.body).toEqual(expect.objectContaining({ code: 'PLATFORM_SCOPE_ONLY' }));
        expectNoChecklistWork();
    });

    test('TC-OBX-014b: missing company membership returns TENANT_CONTEXT_REQUIRED', async () => {
        const res = await request(appWith({
            authz: { scope: null, platform_role: 'none', company: null, membership: null },
        })).get('/api/onboarding/checklist');

        expect(res.status).toBe(403);
        expect(res.body).toEqual(expect.objectContaining({ code: 'TENANT_CONTEXT_REQUIRED' }));
        expectNoChecklistWork();
    });

    test.each(['manager', 'dispatcher', 'provider'])(
        'TC-OBX-014c: %s receives TENANT_ADMIN_ONLY before checklist work',
        async roleKey => {
            const res = await request(appWith({
                authz: {
                    scope: 'tenant',
                    platform_role: 'none',
                    company: { id: COMPANY_A },
                    membership: { role_key: roleKey },
                },
            })).get('/api/onboarding/checklist');

            expect(res.status).toBe(403);
            expect(res.body).toEqual(expect.objectContaining({ code: 'TENANT_ADMIN_ONLY' }));
            expectNoChecklistWork();
        }
    );

    test('TC-OBX-014d: dev mode bypasses admin gate', async () => {
        mockChecklistDb();
        const res = await request(appWith({
            user: { sub: 'dev-user', email: 'dev@localhost', _devMode: true, company_id: COMPANY_A },
            authz: undefined,
        })).get('/api/onboarding/checklist');

        expect(res.status).toBe(200);
        expect(res.body.checklist.progress).toEqual({ done: 0, total: 4 });
        expect(emailMailboxService.getMailboxStatus).toHaveBeenCalledWith(COMPANY_A);
        expect(stripePaymentsService.getStatus).toHaveBeenCalledWith(COMPANY_A);
        expect(billingService.getSubscription).toHaveBeenCalledWith(COMPANY_A);
    });

    test('TC-OBX-015: query/body company injection is ignored by every derivation and trial read', async () => {
        mockChecklistDb();

        const res = await request(appWith({ authz: tenantAdminAuthz(COMPANY_A) }))
            .get(`/api/onboarding/checklist?company_id=${COMPANY_B}`)
            .send({ company_id: COMPANY_B });

        expect(res.status).toBe(200);
        for (const [, params] of db.query.mock.calls) {
            expect(params).toEqual([COMPANY_A]);
        }
        expect(emailMailboxService.getMailboxStatus).toHaveBeenCalledWith(COMPANY_A);
        expect(stripePaymentsService.getStatus).toHaveBeenCalledWith(COMPANY_A);
        expect(billingService.getSubscription).toHaveBeenCalledWith(COMPANY_A);
        expect(JSON.stringify(res.body)).not.toContain(COMPANY_B);
    });
});

describe('write-once edge cases and onboarding redirect', () => {
    test('TC-OBX-016: concurrent guarded UPDATE loser re-reads winner value', async () => {
        const winner = '2026-07-12T13:00:00+00';
        mockChecklistDb({ profileDone: true, telephonyDone: true });
        emailMailboxService.getMailboxStatus.mockResolvedValue({ provider: 'gmail', status: 'connected' });
        stripePaymentsService.getStatus.mockResolvedValue({ readiness: 'connected_ready' });
        db.query
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })
            .mockResolvedValueOnce(completedAtRow(winner));

        const checklist = await checklistService.getChecklist(COMPANY_A);

        expect(checklist.visible).toBe(false);
        expect(checklist.completed_at).toBe(winner);
        expect(checklist.progress).toEqual({ done: 4, total: 4 });
        expect(db.query).toHaveBeenCalledTimes(5);
    });

    test('TC-OBX-017: completed_at write failure still returns 200 visible:false', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            mockChecklistDb({ profileDone: true, telephonyDone: true });
            emailMailboxService.getMailboxStatus.mockResolvedValue({ provider: 'gmail', status: 'connected' });
            stripePaymentsService.getStatus.mockResolvedValue({ readiness: 'connected_ready' });
            db.query.mockRejectedValueOnce(new Error('deadlock detected'));

            const res = await request(appWith({ authz: tenantAdminAuthz() })).get('/api/onboarding/checklist');

            expect(res.status).toBe(200);
            expect(res.body).toEqual(expect.objectContaining({
                ok: true,
                checklist: expect.objectContaining({
                    visible: false,
                    completed_at: null,
                    progress: { done: 4, total: 4 },
                }),
            }));
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining(`failed to persist completed_at for company ${COMPANY_A}`),
                'deadlock detected'
            );
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('TC-OBX-018: successful onboarding redirects to /welcome and preserves payload/cookie', async () => {
        process.env.FEATURE_SELF_SIGNUP = 'true';
        membershipQueries.getActiveMembership.mockResolvedValue(null);
        otpService.validateOtpToken.mockReturnValue({ phone: '+12125550123', purpose: 'signup' });
        platformCompanyService.bootstrapCompany.mockResolvedValue({
            company: {
                id: COMPANY_A,
                name: 'Acme Field Services',
                timezone: 'America/New_York',
            },
        });
        otpService.trustDevice.mockResolvedValue({ deviceId: 'trusted-device-123', maxAgeSec: 3600 });

        const res = await request(appWith())
            .post('/api/onboarding')
            .set('User-Agent', 'onboarding-test')
            .send({
                company_name: ' Acme Field Services ',
                manual: { city: 'New York', state: 'NY', zip: '10001', timezone: 'America/New_York' },
                otp_token: 'valid-otp-token',
            });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({
            ok: true,
            company: {
                id: COMPANY_A,
                name: 'Acme Field Services',
                timezone: 'America/New_York',
            },
            redirect: '/welcome',
        });
        expect(platformCompanyService.bootstrapCompany).toHaveBeenCalledWith({
            userId: 'u1',
            name: 'Acme Field Services',
            geo: { city: 'New York', state: 'NY', zip: '10001', timezone: 'America/New_York' },
            phone: '+12125550123',
            email: 'admin@a.com',
        });
        expect(otpService.trustDevice).toHaveBeenCalledWith('u1', expect.objectContaining({ label: 'onboarding-test' }));
        const cookie = res.headers['set-cookie']?.[0] || '';
        expect(cookie).toContain('albusto_td=trusted-device-123');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Path=/');
    });
});
