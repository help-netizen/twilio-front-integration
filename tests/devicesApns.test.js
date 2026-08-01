/**
 * MOBILE-TECH-APP-001 / MTECH-T2 — native APNs device registry + pushService.
 *
 * Two suites:
 *
 *  A) Route-level (POST/DELETE /api/devices): mounts the REAL router with an
 *     injected authz/user context (mirroring the PF007 canonical route tests) and
 *     a mocked db. Exercises the route's own validation, upsert SQL, 409
 *     NO_CRM_USER gate, own-token DELETE scoping, 401/403, and cross-tenant
 *     isolation (company_id comes from authz, never the body / :token owner).
 *
 *  B) scoped browser/native transports: verifies full tenant/user/device keys,
 *     fail-soft configuration handling, and the PII-safe APNs projection.
 *
 * (spec §3.7, §4.2, §8.T2, §10, C9/C13)
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const express = require('express');
const http = require('http');
const db = require('../backend/src/db/connection');

const COMPANY_A = '00000000-0000-0000-0000-0000000000aa';
const COMPANY_B = '00000000-0000-0000-0000-0000000000bb';
const USER_A = 'crm-user-aaaa';
const USER_B = 'crm-user-bbbb';
const TOKEN_A = 'apns-token-aaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'apns-token-bbbbbbbbbbbbbbbbbbbb';

// ── Test app: injects authz/user, emulates `authenticate` (no user → 401) and
//    `requireCompanyAccess` (authed but no company → 403), then mounts the REAL
//    devices router. `crmUser:null` simulates a user with no crm_user (→ 409). ──
function makeApp({ authed = true, company = COMPANY_A, crmUser = { id: USER_A } } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (authed) {
            req.user = { sub: 'kc-sub', email: 'tech@x.com', crmUser };
            req.authz = { scope: 'tenant', company: company ? { id: company } : null, permissions: [], scopes: {} };
            if (company) req.companyFilter = { company_id: company };
            // Poison the legacy field — the route must never read it.
            req.companyId = 'LEGACY-DO-NOT-USE';
        }
        next();
    });
    // Emulate `authenticate`: no auth context → 401.
    app.use((req, res, next) => {
        if (!req.user) return res.status(401).json({ ok: false, error: 'Auth required' });
        next();
    });
    // Emulate `requireCompanyAccess`: authed but no company → 403.
    app.use((req, res, next) => {
        if (!req.authz?.company?.id) return res.status(403).json({ ok: false, code: 'TENANT_CONTEXT_REQUIRED' });
        next();
    });
    app.use('/', require('../backend/src/routes/devices'));
    return app;
}

function request(app, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const { port } = server.address();
            const req = http.request(
                { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } },
                (res) => {
                    let data = '';
                    res.on('data', c => { data += c; });
                    res.on('end', () => {
                        server.close();
                        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                        catch { resolve({ status: res.statusCode, body: data }); }
                    });
                }
            );
            req.on('error', err => { server.close(); reject(err); });
            if (body != null) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

beforeEach(() => { db.query.mockReset(); });

// ════════════════════════════════════════════════════════════════════════════
// A) POST /api/devices
// ════════════════════════════════════════════════════════════════════════════

describe('POST /api/devices (MTECH-T2)', () => {
    it('registers a NEW token → 201 registered:true, upsert scoped to authz company + crm_user', async () => {
        db.query.mockResolvedValue({ rows: [{ inserted: true }] });
        const res = await request(makeApp(), 'POST', '/', {
            apns_token: TOKEN_A, platform: 'ios', app_version: '1.0.0', device_model: 'iPhone15,2',
        });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ ok: true, data: { registered: true } });

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO device_tokens/i);
        expect(sql).toMatch(/ON CONFLICT \(company_id, crm_user_id, apns_token\) DO UPDATE/i);
        expect(sql).not.toMatch(/company_id\s*=\s*EXCLUDED\.company_id/i);
        expect(sql).not.toMatch(/crm_user_id\s*=\s*EXCLUDED\.crm_user_id/i);
        // company_id from authz (param 1), crm_user_id (param 2) — NOT the body.
        expect(params[0]).toBe(COMPANY_A);
        expect(params[1]).toBe(USER_A);
        expect(params[2]).toBe(TOKEN_A);
        expect(params[3]).toBe('ios');
        expect(params[4]).toBe('1.0.0');
        expect(params[5]).toBe('iPhone15,2');
    });

    it('re-registering an EXISTING token → 200 (upsert idempotent, no duplicate)', async () => {
        db.query.mockResolvedValue({ rows: [{ inserted: false }] }); // xmax<>0 → updated
        const res = await request(makeApp(), 'POST', '/', { apns_token: TOKEN_A });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { registered: true } });
    });

    it('defaults platform to ios and passes null for optional fields', async () => {
        db.query.mockResolvedValue({ rows: [{ inserted: true }] });
        await request(makeApp(), 'POST', '/', { apns_token: TOKEN_A });
        const [, params] = db.query.mock.calls[0];
        expect(params[3]).toBe('ios');   // platform default
        expect(params[4]).toBeNull();    // app_version
        expect(params[5]).toBeNull();    // device_model
    });

    it('trims the token before persisting', async () => {
        db.query.mockResolvedValue({ rows: [{ inserted: true }] });
        await request(makeApp(), 'POST', '/', { apns_token: `  ${TOKEN_A}  ` });
        expect(db.query.mock.calls[0][1][2]).toBe(TOKEN_A);
    });

    it('missing token → 400 (db not touched)', async () => {
        const res = await request(makeApp(), 'POST', '/', { platform: 'ios' });
        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('blank / whitespace token → 400 (db not touched)', async () => {
        const res = await request(makeApp(), 'POST', '/', { apns_token: '   ' });
        expect(res.status).toBe(400);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('no crm_user → 409 NO_CRM_USER (db not touched)', async () => {
        const res = await request(makeApp({ crmUser: null }), 'POST', '/', { apns_token: TOKEN_A });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NO_CRM_USER');
        expect(db.query).not.toHaveBeenCalled();
    });

    it('401 when unauthenticated (db not touched)', async () => {
        const res = await request(makeApp({ authed: false }), 'POST', '/', { apns_token: TOKEN_A });
        expect(res.status).toBe(401);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('403 when authed but no company (db not touched)', async () => {
        const res = await request(makeApp({ company: null }), 'POST', '/', { apns_token: TOKEN_A });
        expect(res.status).toBe(403);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('cross-tenant: company_id is taken from authz, never from the body', async () => {
        db.query.mockResolvedValue({ rows: [{ inserted: true }] });
        await request(makeApp({ company: COMPANY_A }), 'POST', '/', { apns_token: TOKEN_A, company_id: COMPANY_B });
        expect(db.query.mock.calls[0][1][0]).toBe(COMPANY_A);
    });

    it('cross-tenant: a company-B token registers under company B (its own authz)', async () => {
        db.query.mockResolvedValue({ rows: [{ inserted: true }] });
        await request(makeApp({ company: COMPANY_B, crmUser: { id: USER_B } }), 'POST', '/', { apns_token: TOKEN_B });
        const [, params] = db.query.mock.calls[0];
        expect(params[0]).toBe(COMPANY_B);
        expect(params[1]).toBe(USER_B);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A) DELETE /api/devices/:token
// ════════════════════════════════════════════════════════════════════════════

describe('DELETE /api/devices/:token (MTECH-T2)', () => {
    it('deletes the caller OWN token → 200 removed:true, scoped to company + crm_user', async () => {
        db.query.mockResolvedValue({ rowCount: 1, rows: [] });
        const res = await request(makeApp(), 'DELETE', `/${TOKEN_A}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { removed: true } });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/DELETE FROM device_tokens/i);
        expect(sql).toMatch(/apns_token = \$1/);
        expect(sql).toMatch(/company_id = \$2/);
        expect(sql).toMatch(/crm_user_id = \$3/);
        expect(params).toEqual([TOKEN_A, COMPANY_A, USER_A]);
    });

    it('idempotent: deleting a missing/foreign row still → 200 removed:true', async () => {
        db.query.mockResolvedValue({ rowCount: 0, rows: [] });
        const res = await request(makeApp(), 'DELETE', `/${TOKEN_A}`);
        expect(res.status).toBe(200);
        expect(res.body.data.removed).toBe(true);
    });

    it('own-only: user B deleting token A only ever scopes the DELETE to user B (cannot hit A row)', async () => {
        db.query.mockResolvedValue({ rowCount: 0, rows: [] });
        // User B (company B) tries to delete a token that belongs to user A.
        await request(makeApp({ company: COMPANY_B, crmUser: { id: USER_B } }), 'DELETE', `/${TOKEN_A}`);
        const [, params] = db.query.mock.calls[0];
        // The WHERE is pinned to the caller's own (company_id, crm_user_id) — the
        // A-owned row can never match, so it is never removed by B.
        expect(params).toEqual([TOKEN_A, COMPANY_B, USER_B]);
    });

    it('no crm_user → 409 NO_CRM_USER (db not touched)', async () => {
        const res = await request(makeApp({ crmUser: null }), 'DELETE', `/${TOKEN_A}`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NO_CRM_USER');
        expect(db.query).not.toHaveBeenCalled();
    });

    it('401 when unauthenticated (db not touched)', async () => {
        const res = await request(makeApp({ authed: false }), 'DELETE', `/${TOKEN_A}`);
        expect(res.status).toBe(401);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('403 when authed but no company (db not touched)', async () => {
        const res = await request(makeApp({ company: null }), 'DELETE', `/${TOKEN_A}`);
        expect(res.status).toBe(403);
        expect(db.query).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B) scoped browser/native transports — fail-soft + complete-key resolve
// ════════════════════════════════════════════════════════════════════════════

describe('pushService scoped transports (NOTIF-REWORK-001 M1.T5)', () => {
    const ENV_KEYS = [
        'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID', 'APNS_PRIVATE_KEY', 'APNS_ENV',
        'VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
    ];
    let savedEnv;

    beforeEach(() => {
        savedEnv = {};
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
        jest.resetModules();
    });
    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    it('missing tenant or user fails closed before a destination query', async () => {
        jest.doMock('../backend/src/db/connection', () => ({ query: jest.fn() }));
        const freshDb = require('../backend/src/db/connection');
        const pushService = require('../backend/src/services/pushService');

        await expect(pushService.sendNativePushToUser(null, USER_A, { title: 'x' }, { destinationIds: ['1'] }))
            .resolves.toMatchObject({ targeted: 0, error_code: 'INVALID_DELIVERY_CONTEXT' });
        await expect(pushService.sendWebPushToUser(COMPANY_A, null, { title: 'x' }, { destinationIds: ['1'] }))
            .resolves.toMatchObject({ targeted: 0, error_code: 'INVALID_DELIVERY_CONTEXT' });
        expect(freshDb.query).not.toHaveBeenCalled();
    });

    it('native resolve uses (company_id, crm_user_id, destination ids) and missing APNs config is fail-soft', async () => {
        const connect = jest.fn();
        jest.doMock('http2', () => ({ connect }));
        jest.doMock('../backend/src/db/connection', () => ({
            query: jest.fn().mockResolvedValue({ rows: [{ id: 71, apns_token: TOKEN_A }] }),
        }));
        const freshDb = require('../backend/src/db/connection');
        const pushService = require('../backend/src/services/pushService');

        const result = await pushService.sendNativePushToUser(
            COMPANY_A,
            USER_A,
            { title: 'Job assigned', body: 'Open Albusto.', event_type: 'job.assigned' },
            { destinationIds: ['71'] }
        );

        expect(result).toEqual({ targeted: 1, sent: 0, failed: 1, error_code: 'APNS_NOT_CONFIGURED' });
        expect(freshDb.query).toHaveBeenCalledTimes(1);
        const [sql, params] = freshDb.query.mock.calls[0];
        expect(sql).toMatch(/FROM device_tokens/i);
        expect(sql).toMatch(/company_id = \$1/);
        expect(sql).toMatch(/crm_user_id = \$2/);
        expect(sql).toMatch(/id = ANY\(\$3::bigint\[\]\)/);
        expect(params).toEqual([COMPANY_A, USER_A, ['71']]);
        expect(connect).not.toHaveBeenCalled();
    });

    it('browser resolve uses (company_id, user_id, destination ids), never company fan-out', async () => {
        jest.doMock('../backend/src/db/connection', () => ({
            query: jest.fn().mockResolvedValue({
                rows: [{
                    id: '00000000-0000-4000-8000-00000000b001',
                    endpoint: 'https://push.example/shared-natural-key',
                    p256dh: 'p',
                    auth: 'a',
                }],
            }),
        }));
        const freshDb = require('../backend/src/db/connection');
        const pushService = require('../backend/src/services/pushService');
        const result = await pushService.sendWebPushToUser(
            COMPANY_A,
            USER_A,
            { title: 'New message', body: 'Open Albusto.' },
            { destinationIds: ['00000000-0000-4000-8000-00000000b001'] }
        );

        expect(result).toEqual({ targeted: 1, sent: 0, failed: 1, error_code: 'WEB_PUSH_NOT_CONFIGURED' });
        const [sql, params] = freshDb.query.mock.calls[0];
        expect(sql).toMatch(/FROM push_subscriptions/i);
        expect(sql).toMatch(/company_id = \$1/);
        expect(sql).toMatch(/user_id = \$2/);
        expect(sql).toMatch(/id = ANY\(\$3::uuid\[\]\)/);
        expect(params).toEqual([
            COMPANY_A,
            USER_A,
            ['00000000-0000-4000-8000-00000000b001'],
        ]);
    });

    it('APNs projection contains generic routing fields and no arbitrary event data', () => {
        const pushService = require('../backend/src/services/pushService');
        const payload = pushService.buildApnsPayload({
            title: 'Payment received',
            body: 'Open Albusto to view this update.',
            event_type: 'payment.succeeded',
            category_key: 'finance',
            deep_link_kind: 'job',
            record_ref: { type: 'job', id: '42' },
            amount: '999.99',
            phone: '+15555550123',
        });
        expect(payload).toEqual({
            aps: {
                alert: { title: 'Payment received', body: 'Open Albusto to view this update.' },
                sound: 'default',
                'content-available': 1,
            },
            data: {
                event_type: 'payment.succeeded',
                category_key: 'finance',
                deep_link_kind: 'job',
                record_ref: { type: 'job', id: '42' },
            },
        });
        expect(JSON.stringify(payload)).not.toContain('999.99');
        expect(JSON.stringify(payload)).not.toContain('+15555550123');
    });

    it('Web Push projection drops arbitrary producer fields', () => {
        const pushService = require('../backend/src/services/pushService');
        const payload = pushService.buildWebPushPayload({
            title: 'New text message',
            body: 'Open Albusto to view this update.',
            tag: 'notification-1',
            event_type: 'sms.inbound',
            category_key: 'calls_messages',
            category_label: 'Calls & messages',
            deep_link_kind: 'contact',
            record_ref: { type: 'contact', id: '42' },
            url: '/pulse/contact/42',
            message_body: 'PRIVATE-MESSAGE-BODY',
            phone: '+15555550123',
            amount: '999.99',
        });
        expect(payload).toEqual({
            title: 'New text message',
            body: 'Open Albusto to view this update.',
            tag: 'notification-1',
            event_type: 'sms.inbound',
            category_key: 'calls_messages',
            category_label: 'Calls & messages',
            deep_link_kind: 'contact',
            record_ref: { type: 'contact', id: '42' },
            url: '/pulse/contact/42',
        });
        expect(JSON.stringify(payload)).not.toContain('PRIVATE-MESSAGE-BODY');
        expect(JSON.stringify(payload)).not.toContain('+15555550123');
        expect(JSON.stringify(payload)).not.toContain('999.99');
    });

    it('keeps the native job deep-link compatibility fields on dispatcher payloads', () => {
        const pushService = require('../backend/src/services/pushService');
        expect(pushService.buildApnsPayload({
            title: 'Job rescheduled',
            body: 'Open Albusto to view this update.',
            event_type: 'job.rescheduled',
            category_key: 'job_schedule',
            deep_link_kind: 'job',
            record_ref: { type: 'job', id: '42' },
        }).data).toEqual({
            event_type: 'job.rescheduled',
            category_key: 'job_schedule',
            deep_link_kind: 'job',
            record_ref: { type: 'job', id: '42' },
            type: 'job_rescheduled',
            job_id: '42',
        });
    });

    it('retires company-broadcast and legacy inline-native exports', () => {
        const pushService = require('../backend/src/services/pushService');
        expect(typeof pushService.sendWebPushToUser).toBe('function');
        expect(typeof pushService.sendNativePushToUser).toBe('function');
        expect(pushService.sendPushToCompany).toBeUndefined();
        expect(pushService.sendToUser).toBeUndefined();
    });
});
