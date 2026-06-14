/**
 * BILLING-UI — billingService + webhook signature + route isolation/degraded mode.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn().mockResolvedValue({ id: 1 }) }));

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const db = require('../backend/src/db/connection');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';

beforeEach(() => { db.query.mockReset(); });

// ── billingService ───────────────────────────────────────────────────────────

describe('billingService.startTrial', () => {
    const billing = require('../backend/src/services/billingService');

    it('inserts a trialing subscription when none exists, idempotent via ON CONFLICT', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })                       // getSubscription (pre-check)
            .mockResolvedValueOnce({ rows: [] })                       // INSERT ... ON CONFLICT DO NOTHING
            .mockResolvedValueOnce({ rows: [{ company_id: COMPANY, status: 'trialing', plan_id: 'trial' }] }); // getSubscription (return)
        const sub = await billing.startTrial(COMPANY);
        expect(sub.status).toBe('trialing');
        const insert = db.query.mock.calls[1][0];
        expect(insert).toContain('ON CONFLICT (company_id) DO NOTHING');
        expect(db.query.mock.calls[1][1][0]).toBe(COMPANY);
    });

    it('returns the existing subscription without inserting', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ company_id: COMPANY, status: 'active' }] });
        const sub = await billing.startTrial(COMPANY);
        expect(sub.status).toBe('active');
        expect(db.query).toHaveBeenCalledTimes(1); // no insert
    });
});

describe('billingService.getUsage / getInvoices', () => {
    const billing = require('../backend/src/services/billingService');

    it('getUsage maps metric→quantity numbers', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ metric: 'sms', quantity: '140' }, { metric: 'agent_runs', quantity: '26' }] });
        const usage = await billing.getUsage(COMPANY);
        expect(usage).toEqual({ sms: 140, agent_runs: 26 });
    });

    it('getInvoices is company-scoped and shapes rows for the UI', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ amount_due_usd: '49.00', amount_paid_usd: '49.00', status: 'paid', hosted_url: 'https://pay/x', issued_at: '2026-06-01' }] });
        const inv = await billing.getInvoices(COMPANY);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('WHERE company_id = $1');
        expect(params[0]).toBe(COMPANY);
        expect(inv[0]).toEqual({ date: '2026-06-01', amount: 49, status: 'paid', hosted_url: 'https://pay/x' });
    });
});

describe('billingService.createCheckout degraded mode', () => {
    const billing = require('../backend/src/services/billingService');
    const KEY = process.env.STRIPE_SECRET_KEY;
    afterEach(() => { if (KEY === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = KEY; });

    it('throws 422 PROVIDER_NOT_CONFIGURED when no STRIPE_SECRET_KEY', async () => {
        delete process.env.STRIPE_SECRET_KEY;
        await expect(billing.createCheckout(COMPANY, 'pro', {})).rejects.toMatchObject({
            httpStatus: 422, code: 'PROVIDER_NOT_CONFIGURED',
        });
        expect(db.query).not.toHaveBeenCalled();
    });
});

// ── Webhook signature ─────────────────────────────────────────────────────────

describe('billingService.handleProviderWebhook', () => {
    const billing = require('../backend/src/services/billingService');
    const SECRET = 'whsec_test';
    beforeAll(() => { process.env.STRIPE_WEBHOOK_SECRET = SECRET; });
    afterAll(() => { delete process.env.STRIPE_WEBHOOK_SECRET; });

    function sign(rawBody) {
        const t = 1700000000;
        const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex');
        return `t=${t},v1=${v1}`;
    }

    it('rejects a bad signature with httpStatus 400', async () => {
        const raw = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
        await expect(billing.handleProviderWebhook(raw, 't=1,v1=deadbeef')).rejects.toMatchObject({ httpStatus: 400 });
    });

    it('accepts a valid signature and syncs subscription state', async () => {
        const raw = JSON.stringify({
            id: 'evt_1', type: 'customer.subscription.updated',
            data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { albusto_company_id: COMPANY } } },
        });
        db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE billing_subscriptions
        const out = await billing.handleProviderWebhook(raw, sign(raw));
        expect(out).toMatchObject({ ok: true, type: 'customer.subscription.updated' });
        const upd = db.query.mock.calls[0][0];
        expect(upd).toContain('UPDATE billing_subscriptions');
        expect(db.query.mock.calls[0][1][0]).toBe(COMPANY);
    });
});

// ── Route: tenant isolation on /invoices ──────────────────────────────────────

function request(app, method, path) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method }, (res) => {
                let data = ''; res.on('data', c => (data += c));
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
            });
            req.on('error', e => { server.close(); reject(e); });
            req.end();
        });
    });
}

function app({ company = COMPANY } = {}) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
        req.user = { crmUser: { id: 'u1' } };
        req.companyFilter = { company_id: company };
        req.authz = { permissions: ['tenant.company.manage'] };
        next();
    });
    a.use('/', require('../backend/src/routes/billing'));
    return a;
}

describe('billing routes', () => {
    it('GET /invoices scopes the query to the caller company', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const res = await request(app({ company: COMPANY_B }), 'GET', '/invoices');
        expect(res.status).toBe(200);
        expect(db.query.mock.calls[0][1][0]).toBe(COMPANY_B);
    });
});

describe('billingService.computeOverage', () => {
    const billing = require('../backend/src/services/billingService');

    it('charges only metrics over the bundle, at the plan rate, skipping rate=0', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ plan_id: 'pro', status: 'active' }] })             // getSubscription
            .mockResolvedValueOnce({ rows: [{                                                      // billing_plans
                id: 'pro',
                included_units: { sms: 3000, call_minutes: 3000, agent_runs: 10000 },
                metered: { sms: 0.01, call_minutes: 0.02, agent_runs: 0 },
            }] })
            .mockResolvedValueOnce({ rows: [                                                       // getUsage
                { metric: 'sms', quantity: 3500 },
                { metric: 'call_minutes', quantity: 3200 },
                { metric: 'agent_runs', quantity: 50000 },
            ] });

        const out = await billing.computeOverage(COMPANY, '2026-05-01');
        expect(out).toEqual([
            { metric: 'sms', overUnits: 500, amountUsd: 5 },
            { metric: 'call_minutes', overUnits: 200, amountUsd: 4 },
        ]);
        // agent_runs over by 40k but rate 0 → never billed
        expect(out.find(o => o.metric === 'agent_runs')).toBeUndefined();
    });

    it('returns nothing when usage is within the bundle', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ plan_id: 'pro', status: 'active' }] })
            .mockResolvedValueOnce({ rows: [{ id: 'pro', included_units: { sms: 3000 }, metered: { sms: 0.01 } }] })
            .mockResolvedValueOnce({ rows: [{ metric: 'sms', quantity: 1200 }] });
        const out = await billing.computeOverage(COMPANY, '2026-05-01');
        expect(out).toEqual([]);
    });
});
