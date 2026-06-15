/**
 * billingService.js — platform billing orchestration (ADR-001 §2.4).
 *
 * Tenant companies subscribe to Albusto. Usage is metered from domain events
 * (billing-meter subscriber) and reported to the provider. Provider webhooks
 * keep subscription/invoice state in sync and emit domain events that rules
 * can react to (e.g. suspend on non-payment).
 */

const db = require('../db/connection');
const { getProvider } = require('./billing/billingProvider');

function periodStart(d = new Date()) {
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

// ── Subscription lifecycle ───────────────────────────────────────────────────

async function getSubscription(companyId) {
    const { rows } = await db.query(
        `SELECT bs.*, bp.name AS plan_name, bp.monthly_base_usd, bp.included_seats, bp.per_seat_usd, bp.metered
         FROM billing_subscriptions bs
         LEFT JOIN billing_plans bp ON bp.id = bs.plan_id
         WHERE bs.company_id = $1`,
        [companyId]
    );
    return rows[0] || null;
}

/** Start a trial subscription for a freshly bootstrapped company. */
async function startTrial(companyId, planId = 'trial') {
    const existing = await getSubscription(companyId);
    if (existing) return existing;
    const trialEnds = new Date(Date.now() + 14 * 24 * 3600 * 1000);
    await db.query(
        `INSERT INTO billing_subscriptions (company_id, plan_id, status, trial_ends_at, current_period_end, seats)
         VALUES ($1, $2, 'trialing', $3, $3, 1)
         ON CONFLICT (company_id) DO NOTHING`,
        [companyId, planId, trialEnds]
    );
    return getSubscription(companyId);
}

/** True when the active billing provider has real credentials configured. */
function providerConfigured() {
    return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Create a Stripe Checkout session to move a company onto a paid plan. */
async function createCheckout(companyId, planId, { successUrl, cancelUrl }) {
    if (!providerConfigured()) {
        const e = new Error('Billing is not enabled yet');
        e.httpStatus = 422; e.code = 'PROVIDER_NOT_CONFIGURED';
        throw e;
    }
    const provider = getProvider();
    const { rows: companyRows } = await db.query(
        'SELECT id, name, contact_email FROM companies WHERE id = $1', [companyId]
    );
    const company = companyRows[0];
    if (!company) { const e = new Error('Company not found'); e.httpStatus = 404; throw e; }

    const { rows: planRows } = await db.query('SELECT * FROM billing_plans WHERE id = $1 AND is_active', [planId]);
    const plan = planRows[0];
    if (!plan?.provider_price_id) { const e = new Error('Plan not available for checkout'); e.httpStatus = 422; throw e; }

    let sub = await getSubscription(companyId);
    let customerId = sub?.provider_customer_id;
    if (!customerId) {
        ({ customerId } = await provider.ensureCustomer(company));
        await db.query(
            `INSERT INTO billing_subscriptions (company_id, plan_id, provider_customer_id, status)
             VALUES ($1, $2, $3, 'incomplete')
             ON CONFLICT (company_id) DO UPDATE SET provider_customer_id = $3, updated_at = now()`,
            [companyId, planId, customerId]
        );
    }
    return provider.createCheckoutSession(customerId, plan.provider_price_id, { successUrl, cancelUrl });
}

// ── Usage metering (called by the billing-meter event subscriber) ────────────

const EVENT_TO_METRIC = {
    'sms.outbound': { metric: 'sms', qty: () => 1 },
    'call.completed': { metric: 'call_minutes', qty: (p) => Math.ceil((p.duration_sec || 0) / 60) },
    'agent_task.succeeded': { metric: 'agent_runs', qty: () => 1 },
};

async function recordUsageEvent(event) {
    const map = EVENT_TO_METRIC[event.event_type];
    if (!map) return;
    const qty = map.qty(event.payload || {});
    if (!qty) return;
    await recordUsage(event.company_id, map.metric, qty);
}

async function recordUsage(companyId, metric, quantity) {
    await db.query(
        `INSERT INTO billing_usage_records (company_id, metric, period_start, quantity)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, metric, period_start)
         DO UPDATE SET quantity = billing_usage_records.quantity + $4, updated_at = now()`,
        [companyId, metric, periodStart(), quantity]
    );
}

/** Recent invoices for the company cabinet (most recent first). */
async function getInvoices(companyId, limit = 24) {
    const { rows } = await db.query(
        `SELECT amount_due_usd, amount_paid_usd, status, hosted_url, issued_at, created_at
         FROM billing_invoices
         WHERE company_id = $1
         ORDER BY COALESCE(issued_at, created_at) DESC
         LIMIT $2`,
        [companyId, limit]
    );
    return rows.map(r => ({
        date: r.issued_at || r.created_at,
        amount: Number(r.amount_due_usd || r.amount_paid_usd || 0),
        status: r.status,
        hosted_url: r.hosted_url,
    }));
}

async function getUsage(companyId, period = periodStart()) {
    const { rows } = await db.query(
        `SELECT metric, quantity FROM billing_usage_records WHERE company_id = $1 AND period_start = $2`,
        [companyId, period]
    );
    return Object.fromEntries(rows.map(r => [r.metric, Number(r.quantity)]));
}

// ── Provider webhook → local state + domain events ───────────────────────────

async function handleProviderWebhook(rawBody, signature) {
    const provider = getProvider();
    const evt = provider.parseWebhook(rawBody, signature);
    if (!evt) { const e = new Error('Invalid webhook signature'); e.httpStatus = 400; throw e; }

    const eventBus = require('./eventBus');
    const obj = evt.data;

    if (evt.type.startsWith('customer.subscription')) {
        const companyId = obj.metadata?.albusto_company_id
            || (await companyByCustomer(obj.customer));
        if (companyId) {
            await db.query(
                `UPDATE billing_subscriptions SET status = $2,
                    provider_subscription_id = $3,
                    current_period_start = to_timestamp($4),
                    current_period_end = to_timestamp($5),
                    updated_at = now()
                 WHERE company_id = $1`,
                [companyId, obj.status, obj.id, obj.current_period_start || null, obj.current_period_end || null]
            );
            await eventBus.emit(companyId, `subscription.${obj.status}`, { subscription_id: obj.id, status: obj.status },
                { actorType: 'system', aggregateType: 'billing', aggregateId: obj.id });
        }
    } else if (evt.type === 'invoice.paid' || evt.type === 'invoice.payment_failed') {
        const companyId = await companyByCustomer(obj.customer);
        if (companyId) {
            await db.query(
                `INSERT INTO billing_invoices (company_id, provider_invoice_id, amount_due_usd, amount_paid_usd,
                                               status, hosted_url, issued_at, raw)
                 VALUES ($1,$2,$3,$4,$5,$6,now(),$7::jsonb)
                 ON CONFLICT (provider_invoice_id) DO UPDATE SET status = $5, amount_paid_usd = $4, raw = $7::jsonb`,
                [companyId, obj.id, (obj.amount_due || 0) / 100, (obj.amount_paid || 0) / 100,
                 obj.status, obj.hosted_invoice_url || null, JSON.stringify(obj)]
            );
            const type = evt.type === 'invoice.paid' ? 'invoice.paid' : 'invoice.payment_failed';
            await eventBus.emit(companyId, type, { invoice_id: obj.id, amount: (obj.amount_due || 0) / 100 },
                { actorType: 'system', aggregateType: 'billing', aggregateId: obj.id });
        }
    }
    return { ok: true, type: evt.type };
}

async function companyByCustomer(customerId) {
    if (!customerId) return null;
    const { rows } = await db.query(
        'SELECT company_id FROM billing_subscriptions WHERE provider_customer_id = $1', [customerId]
    );
    return rows[0]?.company_id || null;
}

module.exports = {
    getSubscription, startTrial, createCheckout, providerConfigured,
    recordUsageEvent, recordUsage, getUsage, getInvoices,
    handleProviderWebhook,
};
