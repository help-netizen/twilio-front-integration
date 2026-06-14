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

/** Create a customer-portal session so the company can manage its card / plan / invoices. */
async function createPortal(companyId, { returnUrl }) {
    if (!providerConfigured()) {
        const e = new Error('Billing is not enabled yet');
        e.httpStatus = 422; e.code = 'PROVIDER_NOT_CONFIGURED';
        throw e;
    }
    const sub = await getSubscription(companyId);
    const customerId = sub?.provider_customer_id;
    if (!customerId) {
        const e = new Error('No billing account yet — choose a plan first');
        e.httpStatus = 422; e.code = 'NO_CUSTOMER';
        throw e;
    }
    return getProvider().createPortalSession(customerId, { returnUrl });
}

/** The company's current plan row (limits, bundles). Falls back to 'trial'. */
async function getPlanForCompany(companyId) {
    const sub = await getSubscription(companyId);
    const planId = sub?.plan_id || 'trial';
    const { rows } = await db.query('SELECT * FROM billing_plans WHERE id = $1', [planId]);
    return rows[0] || null;
}

/** Ensure a Stripe customer exists for the company; store and return its id. */
async function ensureCustomerId(companyId, planId = null) {
    const sub = await getSubscription(companyId);
    if (sub?.provider_customer_id) return sub.provider_customer_id;
    const { rows: [company] } = await db.query('SELECT id, name, contact_email FROM companies WHERE id = $1', [companyId]);
    if (!company) { const e = new Error('Company not found'); e.httpStatus = 404; throw e; }
    const { customerId } = await getProvider().ensureCustomer(company);
    await db.query(
        `INSERT INTO billing_subscriptions (company_id, plan_id, provider_customer_id, status)
         VALUES ($1, $2, $3, 'incomplete')
         ON CONFLICT (company_id) DO UPDATE SET provider_customer_id = $3, updated_at = now()`,
        [companyId, planId || 'trial', customerId]
    );
    return customerId;
}

/** Top up the wallet via hosted Checkout (min $10). Saves the card for auto-recharge. */
async function createWalletTopup(companyId, amountUsd, { successUrl, cancelUrl } = {}) {
    if (!providerConfigured()) { const e = new Error('Billing is not enabled yet'); e.httpStatus = 422; e.code = 'PROVIDER_NOT_CONFIGURED'; throw e; }
    const amount = Math.max(10, Number(amountUsd) || 0);
    const customerId = await ensureCustomerId(companyId);
    return getProvider().createTopupCheckout(customerId, amount, {
        successUrl: successUrl || 'https://app.albusto.com/settings/billing?status=topup',
        cancelUrl: cancelUrl || 'https://app.albusto.com/settings/billing',
        metadata: { albusto_company_id: companyId },
    });
}

/** Subscribe to a plan, paying the plan price from the card (charged immediately). */
async function subscribe(companyId, planId) {
    if (!providerConfigured()) { const e = new Error('Billing is not enabled yet'); e.httpStatus = 422; e.code = 'PROVIDER_NOT_CONFIGURED'; throw e; }
    const { rows: [plan] } = await db.query('SELECT * FROM billing_plans WHERE id = $1 AND is_active', [planId]);
    if (!plan) { const e = new Error('Plan not available'); e.httpStatus = 404; throw e; }
    const price = Number(plan.monthly_base_usd);
    const customerId = await ensureCustomerId(companyId, planId);
    const walletService = require('./walletService');
    const wallet = await walletService.getWallet(companyId);

    if (wallet.default_payment_method_id) {
        // Card on file → charge the plan price now, then activate + debit the fee.
        const r = await getProvider().chargeOffSession(customerId, wallet.default_payment_method_id, price, `${plan.name} plan`);
        await walletService.credit(companyId, price, { type: 'topup', description: `Charge for ${plan.name} plan`, ref: r.paymentIntentId });
        await db.query(`UPDATE billing_subscriptions SET plan_id = $2, status = 'active', updated_at = now() WHERE company_id = $1`, [companyId, planId]);
        await billPlanFee(companyId);
        return { activated: true };
    }
    // No card yet → hosted Checkout for the plan price (saves the card); webhook activates.
    const out = await getProvider().createTopupCheckout(customerId, price, {
        successUrl: 'https://app.albusto.com/settings/billing?status=success',
        cancelUrl: 'https://app.albusto.com/settings/billing?status=cancel',
        metadata: { albusto_company_id: companyId, plan_id: planId },
    });
    return { url: out.url };
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

// ── Overage billing (in arrears, as Stripe invoice items) ────────────────────

const OVERAGE_LABEL = { sms: 'text messages', call_minutes: 'call minutes', agent_runs: 'automations' };
const OVERAGE_METRICS = ['sms', 'call_minutes', 'agent_runs'];

function previousPeriodStart(d = new Date()) {
    return new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().slice(0, 10);
}

/** Per-metric overage = max(0, used − included) × the plan's metered rate. */
async function computeOverage(companyId, period = periodStart()) {
    const plan = await getPlanForCompany(companyId);
    if (!plan) return [];
    const usage = await getUsage(companyId, period);
    const included = plan.included_units || {};
    const rates = plan.metered || {};
    const out = [];
    for (const metric of OVERAGE_METRICS) {
        const used = Number(usage[metric] || 0);
        const cap = Number(included[metric] || 0);
        const rate = Number(rates[metric] || 0);
        const over = Math.max(0, used - cap);
        if (over > 0 && rate > 0) out.push({ metric, overUnits: over, amountUsd: Math.round(over * rate * 100) / 100 });
    }
    return out;
}

/** Debit one company's overage for a closed period from its wallet. Idempotent via ledger ref. */
async function billOverage(companyId, period) {
    const walletService = require('./walletService');
    const items = await computeOverage(companyId, period);
    let billed = 0, amount = 0;
    for (const it of items) {
        if (it.amountUsd <= 0) continue;
        const res = await walletService.debit(companyId, it.amountUsd, {
            type: 'overage',
            description: `Overage: ${it.overUnits} extra ${OVERAGE_LABEL[it.metric]} (${period})`,
            ref: `overage:${it.metric}:${period}`,
        });
        if (res.applied) { billed++; amount += it.amountUsd; }
    }
    return { billed, amount };
}

/** Debit a company's monthly plan fee from its wallet (auto-recharges to cover). Idempotent per period. */
async function billPlanFee(companyId, period = periodStart()) {
    const walletService = require('./walletService');
    const plan = await getPlanForCompany(companyId);
    const fee = Number(plan?.monthly_base_usd || 0);
    if (fee <= 0) return { billed: false, amount: 0 };
    await walletService.ensureBalance(companyId, fee);
    const res = await walletService.debit(companyId, fee, {
        type: 'plan',
        description: `${plan.name} plan — ${period}`,
        ref: `plan:${period}`,
    });
    return { billed: res.applied, amount: res.applied ? fee : 0 };
}

/** Debit last month's overage for every paid company. Idempotent — safe to run daily. */
async function billPreviousPeriodOverages() {
    const period = previousPeriodStart();
    const { rows } = await db.query(
        `SELECT company_id FROM billing_subscriptions WHERE status IN ('active','past_due')`
    );
    let companies = 0;
    for (const r of rows) {
        const res = await billOverage(r.company_id, period)
            .catch(e => { console.error('[billing] overage run error:', e.message); return null; });
        if (res && res.billed > 0) companies++;
    }
    return { period, companies };
}

/** Debit this month's plan fee for every paid company. Idempotent — safe to run daily. */
async function billCurrentPeriodPlanFees() {
    const period = periodStart();
    const { rows } = await db.query(
        `SELECT company_id FROM billing_subscriptions WHERE status IN ('active','past_due')`
    );
    let companies = 0;
    for (const r of rows) {
        const res = await billPlanFee(r.company_id, period)
            .catch(e => { console.error('[billing] plan fee run error:', e.message); return null; });
        if (res && res.billed) companies++;
    }
    return { period, companies };
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
    } else if (evt.type === 'checkout.session.completed' && obj.mode === 'payment') {
        // Wallet top-up (and, when metadata.plan_id is set, a plan subscribe).
        const walletService = require('./walletService');
        const companyId = obj.metadata?.albusto_company_id || obj.metadata?.company_id || (await companyByCustomer(obj.customer));
        if (companyId) {
            const amountUsd = (obj.amount_total || 0) / 100;
            const ref = obj.payment_intent || obj.id;
            if (amountUsd > 0) {
                await walletService.credit(companyId, amountUsd, { type: 'topup', description: `Wallet top-up $${amountUsd.toFixed(2)}`, ref });
            }
            // Save the card for future off-session auto-recharge.
            try {
                if (obj.payment_intent) {
                    const pi = await getProvider().getPaymentIntent(obj.payment_intent);
                    if (pi.payment_method) await walletService.setDefaultPaymentMethod(companyId, pi.payment_method);
                }
            } catch (e) { console.error('[billing] save card after top-up failed:', e.message); }
            // Activate the plan if this top-up was a subscribe.
            if (obj.metadata?.plan_id) {
                await db.query(`UPDATE billing_subscriptions SET plan_id = $2, status = 'active', updated_at = now() WHERE company_id = $1`, [companyId, obj.metadata.plan_id]);
                await billPlanFee(companyId).catch(e => console.error('[billing] plan fee on activate failed:', e.message));
            }
            await eventBus.emit(companyId, 'wallet.topup', { amount: amountUsd }, { actorType: 'system', aggregateType: 'billing', aggregateId: ref });
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
    getSubscription, startTrial, createCheckout, subscribe, createWalletTopup, createPortal, getPlanForCompany, providerConfigured,
    recordUsageEvent, recordUsage, getUsage, getInvoices,
    computeOverage, billOverage, billPlanFee, billPreviousPeriodOverages, billCurrentPeriodPlanFees,
    handleProviderWebhook,
};
