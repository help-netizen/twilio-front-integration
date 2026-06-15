/**
 * stripePaymentsService.js — F018 / STRIPE-PAY-001 (Phases 1–2).
 *
 * Tenant customer payments via Stripe Connect (direct charges, no application fee).
 * Drives onboarding/status, invoice payment links, public Pay-now, and idempotent
 * webhook → canonical ledger sync. Kept separate from platform billing.
 *
 * Reuses: stripeConnectProvider (REST), stripePaymentsQueries (DB),
 * paymentsService.createTransaction (ledger), invoicesService/invoicesQueries
 * (invoice balance/status/events), marketplaceService (install/disconnect),
 * auditService (audit trail).
 */

const provider = require('./stripeConnectProvider');
const q = require('../db/stripePaymentsQueries');
const paymentsQueries = require('../db/paymentsQueries');
const paymentsService = require('./paymentsService');
const invoicesService = require('./invoicesService');
const invoicesQueries = require('../db/invoicesQueries');
const marketplaceService = require('./marketplaceService');
const marketplaceQueries = require('../db/marketplaceQueries');
const auditService = require('./auditService');

const APP_KEY = 'stripe-payments';

class StripePaymentsError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.name = 'StripePaymentsError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function baseUrl() {
    return (process.env.PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/+$/, '');
}

// ---- readiness state machine (pure, unit-tested) ----------------------------

/**
 * Compute the readiness state from a connected-account row (or null).
 * @returns {'not_connected'|'onboarding_incomplete'|'action_required'|
 *           'payments_disabled'|'payouts_disabled'|'connected_ready'|'disconnected'}
 */
function computeReadiness(account) {
    if (!account) return 'not_connected';
    if (account.status === 'disconnected') return 'disconnected';
    const pastDue = (account.requirements_past_due || []);
    const cardCap = account.capabilities?.card_payments;
    if (!account.details_submitted) return 'onboarding_incomplete';
    if (Array.isArray(pastDue) && pastDue.length > 0) return 'action_required';
    if (!account.charges_enabled || cardCap !== 'active') return 'payments_disabled';
    if (!account.payouts_enabled) return 'payouts_disabled';
    return 'connected_ready';
}

/** Whether online collection is allowed for this readiness state. */
function canCollect(readiness) {
    return readiness === 'connected_ready' || readiness === 'payouts_disabled';
}

function buildChecklist(account, readiness) {
    return [
        { key: 'connect', label: 'Connect Stripe account', done: Boolean(account) },
        { key: 'onboarding', label: 'Complete business onboarding', done: Boolean(account?.details_submitted) },
        { key: 'payment_methods', label: 'Enable card payments', done: account?.capabilities?.card_payments === 'active' },
        { key: 'field_payments', label: 'Configure field payments (Tap to Pay)', done: false, deferred: true },
        { key: 'test_payment', label: 'Run a test payment', done: false },
    ];
}

function publicStatus(account) {
    const readiness = computeReadiness(account);
    return {
        configured: provider.isConfigured(),
        connected: Boolean(account) && account.status !== 'disconnected',
        readiness,
        can_collect: canCollect(readiness),
        livemode: account?.livemode ?? false,
        account: account ? {
            charges_enabled: account.charges_enabled,
            payouts_enabled: account.payouts_enabled,
            details_submitted: account.details_submitted,
            requirements_currently_due: account.requirements_currently_due || [],
            requirements_past_due: account.requirements_past_due || [],
            capabilities: account.capabilities || {},
            status: account.status,
        } : null,
        checklist: buildChecklist(account, readiness),
    };
}

// ---- status / onboarding ----------------------------------------------------

async function getStatus(companyId) {
    if (!provider.isConfigured()) {
        return { configured: false, connected: false, readiness: 'not_connected', can_collect: false, account: null, checklist: buildChecklist(null, 'not_connected') };
    }
    const account = await q.getAccountByCompany(companyId);
    return publicStatus(account);
}

async function ensureAccountForCompany(companyId, company = {}) {
    let account = await q.getAccountByCompany(companyId);
    if (account && account.status !== 'disconnected') return account;

    const stripeAccount = await provider.createAccount({
        email: company.contact_email,
        companyName: company.name,
        companyId,
    });
    // Best-effort marketplace installation (provisioning_mode 'none').
    let installationId = null;
    try {
        const installation = await marketplaceService.installApp(companyId, null, APP_KEY);
        installationId = installation?.id || null;
    } catch (err) {
        console.warn('[StripePayments] marketplace install failed (continuing):', err.message);
    }
    account = await q.insertAccount(companyId, {
        stripeAccountId: stripeAccount.id,
        marketplaceInstallationId: installationId,
    });
    return account;
}

async function connect(companyId, actor, company = {}) {
    if (!provider.isConfigured()) throw new StripePaymentsError('NOT_CONFIGURED', 'Stripe is not configured', 503);
    const account = await ensureAccountForCompany(companyId, company);
    const link = await getOnboardingLink(companyId, account);
    await auditService.log({ actor_id: actor?.id || null, action: 'stripe_payments.connected', target_type: 'stripe_account', target_id: account.stripe_account_id, company_id: companyId, details: {} });
    return { account_id: account.stripe_account_id, onboarding_url: link.url };
}

async function getOnboardingLink(companyId, account = null) {
    const acct = account || await q.getAccountByCompany(companyId);
    if (!acct) throw new StripePaymentsError('NOT_CONNECTED', 'Stripe account not connected', 400);
    const link = await provider.createAccountLink(acct.stripe_account_id, {
        refreshUrl: `${baseUrl()}/settings/integrations/stripe-payments?onboarding=refresh`,
        returnUrl: `${baseUrl()}/settings/integrations/stripe-payments?onboarding=return`,
    });
    return { url: link.url };
}

async function refreshStatus(companyId) {
    const account = await q.getAccountByCompany(companyId);
    if (!account) throw new StripePaymentsError('NOT_CONNECTED', 'Stripe account not connected', 400);
    const mapped = await provider.getAccount(account.stripe_account_id);
    const prevReadiness = computeReadiness(account);
    const updated = await q.updateAccountStatus(companyId, {
        livemode: mapped.livemode,
        charges_enabled: mapped.charges_enabled,
        payouts_enabled: mapped.payouts_enabled,
        details_submitted: mapped.details_submitted,
        requirements_currently_due: mapped.requirements_currently_due,
        requirements_past_due: mapped.requirements_past_due,
        capabilities: mapped.capabilities,
        status: computeReadiness({ ...account, ...mapped }),
    });
    const newReadiness = computeReadiness(updated);
    if (newReadiness !== prevReadiness) {
        await auditService.log({ action: 'stripe_payments.requirements_changed', target_type: 'stripe_account', target_id: account.stripe_account_id, company_id: companyId, details: { from: prevReadiness, to: newReadiness } });
    }
    return publicStatus(updated);
}

async function disconnect(companyId, actor) {
    const account = await q.getAccountByCompany(companyId);
    if (!account) throw new StripePaymentsError('NOT_CONNECTED', 'Stripe account not connected', 400);
    await q.setAccountStatus(companyId, 'disconnected');
    // Disconnect marketplace installation (history preserved; Stripe account NOT deleted).
    try {
        const installations = await marketplaceQueries.listInstallations(companyId, true);
        const inst = installations.find(i => i.app_key === APP_KEY && i.status === 'connected');
        if (inst) await marketplaceService.disconnectInstallation(companyId, actor?.id || null, inst.id);
    } catch (err) {
        console.warn('[StripePayments] marketplace disconnect failed (continuing):', err.message);
    }
    await auditService.log({ actor_id: actor?.id || null, action: 'stripe_payments.disconnected', target_type: 'stripe_account', target_id: account.stripe_account_id, company_id: companyId, details: {} });
    return { disconnected: true };
}

// ---- invoice payment links --------------------------------------------------

async function assertCollectable(companyId) {
    const account = await q.getAccountByCompany(companyId);
    const readiness = computeReadiness(account);
    if (!canCollect(readiness)) {
        throw new StripePaymentsError('NOT_READY', 'Stripe payment collection is not ready', 409);
    }
    return account;
}

function invoiceBalance(invoice) {
    const balance = invoice.balance_due != null ? Number(invoice.balance_due) : (Number(invoice.total || 0) - Number(invoice.amount_paid || 0));
    return balance;
}

async function ensurePaymentLink(companyId, actor, invoiceId, { amount } = {}) {
    const account = await assertCollectable(companyId);
    const invoice = await invoicesService.getInvoice(companyId, invoiceId); // 404 if foreign
    if (!invoice) throw new StripePaymentsError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    if (['void', 'refunded', 'paid'].includes(invoice.status)) {
        throw new StripePaymentsError('INVALID_STATUS', `Cannot collect on invoice with status '${invoice.status}'`, 400);
    }
    const balance = invoiceBalance(invoice);
    const payAmount = amount != null ? Number(amount) : balance;
    if (!(payAmount > 0) || payAmount > balance) {
        throw new StripePaymentsError('INVALID_AMOUNT', 'Amount must be > 0 and <= invoice balance', 400);
    }

    // Reuse a valid open session for same invoice + amount (FR-004).
    const existing = await q.findOpenSession(companyId, invoiceId, payAmount);
    if (existing) return { url: existing.url, expires_at: existing.expires_at, reused: true, session_id: existing.id };

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h expiry policy
    const session = await provider.createCheckoutSession(account.stripe_account_id, {
        amount: payAmount,
        currency: invoice.currency || 'usd',
        invoiceNumber: invoice.invoice_number,
        successUrl: `${baseUrl()}/i/${invoice.public_token || ''}?paid=1`,
        cancelUrl: `${baseUrl()}/i/${invoice.public_token || ''}`,
        expiresAt,
        metadata: {
            company_id: companyId,
            invoice_id: String(invoiceId),
            job_id: invoice.job_id != null ? String(invoice.job_id) : '',
            contact_id: invoice.contact_id != null ? String(invoice.contact_id) : '',
        },
    }, { idempotencyKey: `inv-${companyId}-${invoiceId}-${payAmount}` });

    const row = await q.insertSession(companyId, {
        invoice_id: invoiceId,
        job_id: invoice.job_id || null,
        contact_id: invoice.contact_id || null,
        created_by: actor?.id || null,
        surface: 'checkout_link',
        amount: payAmount,
        currency: (invoice.currency || 'USD').toUpperCase(),
        status: 'open',
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent || null,
        stripe_account_id: account.stripe_account_id,
        url: session.url,
        expires_at: expiresAt,
        metadata: {},
    });
    await auditService.log({ actor_id: actor?.id || null, action: 'stripe_payments.payment_link_created', target_type: 'invoice', target_id: String(invoiceId), company_id: companyId, details: { amount: payAmount } });
    return { url: row.url, expires_at: row.expires_at, reused: false, session_id: row.id };
}

async function getPaymentLink(companyId, invoiceId) {
    const sessions = await q.listSessionsForInvoice(companyId, invoiceId);
    const active = sessions.find(s => s.status === 'open' && (!s.expires_at || new Date(s.expires_at) > new Date()));
    return {
        active: active ? { url: active.url, expires_at: active.expires_at, amount: active.amount } : null,
        history: sessions.map(s => ({ id: s.id, status: s.status, amount: s.amount, surface: s.surface, failure_reason: s.failure_reason, created_at: s.created_at })),
    };
}

async function sendPaymentLink(companyId, actor, invoiceId, { channel = 'email', message } = {}) {
    const link = await ensurePaymentLink(companyId, actor, invoiceId);
    // Delivery follows the existing invoice send pattern (event-logged). Actual
    // email/SMS dispatch is handled by the shared messaging path / invoice send.
    await invoicesQueries.createEvent(invoiceId, 'payment_link_sent', 'user', actor?.id || null, {
        channel, message: message || null, url: link.url,
    });
    await auditService.log({ actor_id: actor?.id || null, action: 'stripe_payments.payment_link_sent', target_type: 'invoice', target_id: String(invoiceId), company_id: companyId, details: { channel } });
    return { sent: true, url: link.url, channel };
}

// ---- manual card entry (Payment Element) — Phase 3 --------------------------

/**
 * Resolve amount + linkage from invoice or job context for a card-present / keyed
 * surface. Invoice context defaults to the current balance; job context needs an
 * explicit amount.
 */
async function resolveSurfaceContext(companyId, { invoiceId, jobId, amount }) {
    let ctx = { invoiceId: invoiceId || null, jobId: jobId || null, contactId: null, amount: amount != null ? Number(amount) : null, invoiceNumber: null };
    if (invoiceId) {
        const invoice = await invoicesService.getInvoice(companyId, invoiceId);
        if (!invoice) throw new StripePaymentsError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
        if (['void', 'refunded', 'paid'].includes(invoice.status)) {
            throw new StripePaymentsError('INVALID_STATUS', `Cannot collect on invoice with status '${invoice.status}'`, 400);
        }
        const balance = invoiceBalance(invoice);
        ctx.amount = amount != null ? Number(amount) : balance;
        ctx.contactId = invoice.contact_id || null;
        ctx.jobId = ctx.jobId || invoice.job_id || null;
        ctx.invoiceNumber = invoice.invoice_number;
        if (!(ctx.amount > 0) || ctx.amount > balance) {
            throw new StripePaymentsError('INVALID_AMOUNT', 'Amount must be > 0 and <= invoice balance', 400);
        }
    } else {
        if (!(ctx.amount > 0)) throw new StripePaymentsError('INVALID_AMOUNT', 'amount is required', 400);
    }
    return ctx;
}

async function createCardSession(companyId, actor, surface, params) {
    const account = await assertCollectable(companyId);
    const ctx = await resolveSurfaceContext(companyId, params);
    const metadata = {
        company_id: companyId,
        invoice_id: ctx.invoiceId != null ? String(ctx.invoiceId) : '',
        job_id: ctx.jobId != null ? String(ctx.jobId) : '',
        contact_id: ctx.contactId != null ? String(ctx.contactId) : '',
        surface,
    };
    const idempotencyKey = `${surface}-${companyId}-${ctx.invoiceId || ctx.jobId || 'adhoc'}-${ctx.amount}-${Date.now()}`;
    const pi = surface === 'tap_to_pay'
        ? await provider.createTerminalPaymentIntent(account.stripe_account_id, { amount: ctx.amount, metadata }, { idempotencyKey })
        : await provider.createPaymentIntent(account.stripe_account_id, { amount: ctx.amount, metadata }, { idempotencyKey });

    const row = await q.insertSession(companyId, {
        invoice_id: ctx.invoiceId, job_id: ctx.jobId, contact_id: ctx.contactId,
        created_by: actor?.id || null, surface, amount: ctx.amount, status: 'open',
        stripe_payment_intent_id: pi.id, stripe_account_id: account.stripe_account_id, metadata: {},
    });
    await auditService.log({ actor_id: actor?.id || null, action: `stripe_payments.${surface === 'tap_to_pay' ? 'tap_to_pay' : 'manual_card'}_started`, target_type: 'invoice', target_id: ctx.invoiceId ? String(ctx.invoiceId) : null, company_id: companyId, details: { amount: ctx.amount } });
    return {
        session_id: row.id,
        client_secret: pi.client_secret,
        payment_intent_id: pi.id,
        account_id: account.stripe_account_id,
        amount: ctx.amount,
    };
}

const createManualCardSession = (companyId, actor, params) => createCardSession(companyId, actor, 'manual_card', params);

// ---- Terminal / Tap to Pay (backend) — Phase 4 -----------------------------

async function getConnectionToken(companyId) {
    const account = await assertCollectable(companyId);
    const locations = await q.listTerminalLocations(companyId);
    const token = await provider.createConnectionToken(account.stripe_account_id, { locationId: locations[0]?.stripe_location_id });
    return { secret: token.secret, location_id: locations[0]?.stripe_location_id || null };
}

const createTapToPayIntent = (companyId, actor, params) => createCardSession(companyId, actor, 'tap_to_pay', params);

async function cancelTerminalIntent(companyId, actor, paymentIntentId) {
    const account = await q.getAccountByCompany(companyId);
    if (!account) throw new StripePaymentsError('NOT_CONNECTED', 'Stripe account not connected', 400);
    await provider.cancelPaymentIntent(account.stripe_account_id, paymentIntentId);
    const session = await q.getSessionByPaymentIntent(paymentIntentId);
    if (session && session.company_id === companyId) await q.updateSession(session.id, { status: 'canceled' });
    return { canceled: true };
}

// ---- refunds — Phase 5 ------------------------------------------------------

/** Idempotent refund recording keyed on the Stripe refund id. */
async function applyStripeRefund(companyId, { refundId, paymentIntentId, amount, reason }) {
    const existing = await paymentsQueries.findByExternalSourceId(companyId, 'stripe', refundId);
    if (existing) return { tx: existing, deduped: true };
    const original = paymentIntentId ? await paymentsQueries.findByExternalSourceId(companyId, 'stripe', paymentIntentId) : null;

    let tx;
    try {
        tx = await paymentsQueries.createTransaction(companyId, {
            transaction_type: 'refund',
            payment_method: 'credit_card',
            status: 'completed',
            amount: -Math.abs(Number(amount)),
            currency: original?.currency || 'USD',
            invoice_id: original?.invoice_id || null,
            contact_id: original?.contact_id || null,
            job_id: original?.job_id || null,
            external_id: refundId,
            external_source: 'stripe',
            memo: reason ? `Stripe refund: ${reason}` : 'Stripe refund',
            metadata: { original_external_id: paymentIntentId || null },
            processed_at: new Date().toISOString(),
        });
    } catch (err) {
        if (err.code === '23505') {
            const row = await paymentsQueries.findByExternalSourceId(companyId, 'stripe', refundId);
            return { tx: row, deduped: true };
        }
        throw err;
    }

    if (original) {
        await paymentsQueries.updateTransactionStatus(original.id, companyId, 'refunded').catch(() => {});
        if (original.invoice_id) {
            try {
                await invoicesQueries.recordPayment(original.invoice_id, companyId, -Math.abs(Number(amount)));
                const inv = await invoicesService.getInvoice(companyId, original.invoice_id);
                if (inv && Number(inv.balance_due) > 0) {
                    await invoicesQueries.updateInvoiceStatus(original.invoice_id, companyId, Number(inv.amount_paid) > 0 ? 'partial' : 'sent', null);
                }
                await invoicesQueries.createEvent(original.invoice_id, 'payment_recorded', 'system', null, { amount: -Math.abs(Number(amount)), payment_method: 'credit_card', source: 'stripe', refund: true, external_id: refundId });
            } catch (e) { console.warn('[StripePayments] refund invoice adjust failed:', e.message); }
        }
    }
    return { tx, deduped: false };
}

async function refundStripePayment(companyId, actor, transactionId, { amount, reason } = {}) {
    const original = await paymentsQueries.getTransactionById(companyId, transactionId);
    if (!original) throw new StripePaymentsError('NOT_FOUND', `Transaction ${transactionId} not found`, 404);
    if (original.external_source !== 'stripe') throw new StripePaymentsError('INVALID', 'Not a Stripe payment', 400);
    if (original.status !== 'completed') throw new StripePaymentsError('INVALID_STATUS', `Cannot refund a '${original.status}' transaction`, 400);
    const refundAmount = amount != null ? Number(amount) : Number(original.amount);
    if (!(refundAmount > 0) || refundAmount > Number(original.amount)) {
        throw new StripePaymentsError('INVALID_AMOUNT', 'Refund amount must be > 0 and <= original amount', 400);
    }
    const account = await q.getAccountByCompany(companyId);
    if (!account) throw new StripePaymentsError('NOT_CONNECTED', 'Stripe account not connected', 400);

    await auditService.log({ actor_id: actor?.id || null, action: 'stripe_payments.refund_requested', target_type: 'payment', target_id: String(transactionId), company_id: companyId, details: { amount: refundAmount } });
    const refund = await provider.createRefund(account.stripe_account_id, {
        paymentIntent: original.external_id, amount: refundAmount, reason: reason ? 'requested_by_customer' : undefined,
    }, { idempotencyKey: `refund-${companyId}-${transactionId}-${refundAmount}` });
    const res = await applyStripeRefund(companyId, { refundId: refund.id, paymentIntentId: original.external_id, amount: refundAmount, reason });
    await auditService.log({ action: 'stripe_payments.refund_succeeded', target_type: 'payment', target_id: String(transactionId), company_id: companyId, details: { refund_id: refund.id, amount: refundAmount } });
    return { refund_id: refund.id, transaction: res.tx };
}

// ---- public Pay now ---------------------------------------------------------

async function getPublicPayInfo(token) {
    const invoice = await invoicesQueries.getInvoiceByPublicToken(token);
    if (!invoice) throw new StripePaymentsError('NOT_FOUND', 'Invoice not found', 404);
    const account = await q.getAccountByCompany(invoice.company_id);
    const readiness = computeReadiness(account);
    const balance = invoiceBalance(invoice);
    const payable = canCollect(readiness) && balance > 0 && !['void', 'refunded'].includes(invoice.status);
    // Opaque: never expose internal ids.
    return {
        invoice_number: invoice.invoice_number,
        status: invoice.status,
        balance_due: balance,
        currency: (invoice.currency || 'USD'),
        paid: balance <= 0 || invoice.status === 'paid',
        payable,
    };
}

async function createPublicPaySession(token) {
    const invoice = await invoicesQueries.getInvoiceByPublicToken(token);
    if (!invoice) throw new StripePaymentsError('NOT_FOUND', 'Invoice not found', 404);
    const link = await ensurePaymentLink(invoice.company_id, null, invoice.id);
    return { url: link.url };
}

// ---- webhook → ledger sync --------------------------------------------------

async function applyStripePayment(companyId, { externalId, invoiceId, contactId, jobId, amount, currency, metadata }) {
    // Idempotency: a ledger row already exists for this external id?
    const existing = await paymentsQueries.findByExternalSourceId(companyId, 'stripe', externalId);
    if (existing) return { tx: existing, deduped: true };

    let tx;
    try {
        tx = await paymentsService.createTransaction(companyId, null, {
            transaction_type: 'payment',
            payment_method: 'credit_card',
            amount,
            currency: (currency || 'USD').toUpperCase(),
            invoice_id: invoiceId || null,
            contact_id: contactId || null,
            job_id: jobId || null,
            external_id: externalId,
            external_source: 'stripe',
            metadata: metadata || {},
        });
    } catch (err) {
        // Unique-violation race → another delivery won; treat as deduped.
        if (err.code === '23505') {
            const row = await paymentsQueries.findByExternalSourceId(companyId, 'stripe', externalId);
            return { tx: row, deduped: true };
        }
        throw err;
    }

    // Invoice status transition (createTransaction already updated balance_due).
    if (invoiceId) {
        try {
            const inv = await invoicesService.getInvoice(companyId, invoiceId);
            if (inv) {
                if (Number(inv.balance_due) <= 0) {
                    await invoicesQueries.updateInvoiceStatus(invoiceId, companyId, 'paid', 'paid_at');
                } else if (Number(inv.amount_paid) > 0) {
                    await invoicesQueries.updateInvoiceStatus(invoiceId, companyId, 'partial', null);
                }
                await invoicesQueries.createEvent(invoiceId, 'payment_recorded', 'system', null, {
                    amount, payment_method: 'credit_card', source: 'stripe', external_id: externalId,
                });
            }
        } catch (err) {
            console.warn('[StripePayments] invoice status update failed:', err.message);
        }
    }
    return { tx, deduped: false };
}

/**
 * Process a raw Connect webhook. Returns { ok } or throws StripePaymentsError(400)
 * on bad signature. Idempotent per event id and per payment external id.
 */
async function handleWebhook(rawBody, signature) {
    const event = provider.parseConnectWebhook(rawBody, signature);
    if (!event) throw new StripePaymentsError('BAD_SIGNATURE', 'Invalid Stripe signature', 400);

    // Tenant-scope: resolve company from the connected account id (never trust
    // metadata alone for mutation).
    let companyId = null;
    let account = null;
    if (event.account) {
        account = await q.getAccountByStripeId(event.account);
        companyId = account?.company_id || null;
    }

    const { inserted } = await q.insertWebhookEvent({
        stripeEventId: event.id,
        livemode: event.livemode,
        eventType: event.type,
        stripeAccountId: event.account,
        companyId,
        payload: { type: event.type },
    });
    if (!inserted) return { ok: true, deduped: true }; // already processed

    // Connect event with an account we don't recognize → refuse to mutate ledger.
    if (event.account && !account) {
        await q.markWebhookEvent(event.id, 'failed', { error: 'unknown_connected_account' });
        return { ok: true, ignored: true };
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const obj = event.data;
                const session = await q.getSessionByCheckoutId(obj.id);
                const meta = obj.metadata || {};
                const invId = session?.invoice_id || (meta.invoice_id ? Number(meta.invoice_id) : null);
                const externalId = obj.payment_intent || obj.id;
                const amount = (obj.amount_total != null ? obj.amount_total / 100 : session?.amount);
                if (session) await q.updateSession(session.id, { status: 'complete', stripe_payment_intent_id: obj.payment_intent || null });
                await applyStripePayment(companyId, {
                    externalId, invoiceId: invId,
                    contactId: session?.contact_id || (meta.contact_id ? Number(meta.contact_id) : null),
                    jobId: session?.job_id || (meta.job_id ? Number(meta.job_id) : null),
                    amount, currency: obj.currency, metadata: { surface: 'checkout_link', checkout_session_id: obj.id },
                });
                await auditService.log({ action: 'stripe_payments.payment_succeeded', target_type: 'invoice', target_id: invId ? String(invId) : null, company_id: companyId, details: { external_id: externalId } });
                break;
            }
            case 'payment_intent.succeeded': {
                const obj = event.data;
                const session = await q.getSessionByPaymentIntent(obj.id) || (obj.metadata?.checkout_session_id ? await q.getSessionByCheckoutId(obj.metadata.checkout_session_id) : null);
                const meta = obj.metadata || {};
                const invId = session?.invoice_id || (meta.invoice_id ? Number(meta.invoice_id) : null);
                const charge = obj.latest_charge || obj.id;
                if (session) await q.updateSession(session.id, { status: 'complete', stripe_charge_id: typeof charge === 'string' ? charge : null });
                await applyStripePayment(companyId, {
                    externalId: obj.id, invoiceId: invId,
                    contactId: session?.contact_id || null, jobId: session?.job_id || null,
                    amount: obj.amount_received != null ? obj.amount_received / 100 : (obj.amount / 100),
                    currency: obj.currency, metadata: { surface: 'checkout_link', payment_intent_id: obj.id },
                });
                await auditService.log({ action: 'stripe_payments.payment_succeeded', target_type: 'invoice', target_id: invId ? String(invId) : null, company_id: companyId, details: { external_id: obj.id } });
                break;
            }
            case 'payment_intent.payment_failed': {
                const obj = event.data;
                const session = await q.getSessionByPaymentIntent(obj.id);
                const reason = obj.last_payment_error?.message || 'Payment failed';
                if (session) await q.updateSession(session.id, { status: 'failed', failure_reason: reason });
                await auditService.log({ action: 'stripe_payments.payment_failed', target_type: 'invoice', target_id: session?.invoice_id ? String(session.invoice_id) : null, company_id: companyId, details: { reason } });
                break;
            }
            case 'account.updated': {
                if (companyId) {
                    try { await refreshStatus(companyId); } catch (e) { /* best-effort */ }
                }
                break;
            }
            case 'charge.refunded': {
                const obj = event.data;
                const refunds = obj.refunds?.data || [];
                const latest = refunds[refunds.length - 1];
                const refundId = latest?.id || `${obj.id}_refund`;
                const refundAmount = (latest?.amount != null ? latest.amount / 100 : (obj.amount_refunded || 0) / 100);
                if (refundAmount > 0) {
                    await applyStripeRefund(companyId, { refundId, paymentIntentId: obj.payment_intent || null, amount: refundAmount, reason: latest?.reason });
                    await auditService.log({ action: 'stripe_payments.refund_succeeded', target_type: 'charge', target_id: obj.id, company_id: companyId, details: { refund_id: refundId, amount: refundAmount, source: 'webhook' } });
                }
                break;
            }
            case 'charge.dispute.created': {
                const obj = event.data;
                const original = obj.payment_intent ? await paymentsQueries.findByExternalSourceId(companyId, 'stripe', obj.payment_intent) : null;
                if (original) await paymentsQueries.updateTransactionStatus(original.id, companyId, 'processing', {}).catch(() => {});
                await auditService.log({ action: 'stripe_payments.dispute_opened', target_type: 'charge', target_id: obj.charge || obj.id, company_id: companyId, details: { amount: (obj.amount || 0) / 100 } });
                break;
            }
            default:
                await q.markWebhookEvent(event.id, 'ignored');
                return { ok: true, ignored: true };
        }
        await q.markWebhookEvent(event.id, 'processed', { companyId });
        return { ok: true };
    } catch (err) {
        await q.markWebhookEvent(event.id, 'failed', { error: err.message, companyId });
        // Ack with ok:false detail but HTTP 200 so Stripe doesn't hammer retries on
        // a deterministic bug; surfaced via the event row + logs/alerts.
        console.error('[StripePayments] webhook processing error:', err.message);
        return { ok: false, error: err.message };
    }
}

module.exports = {
    StripePaymentsError,
    computeReadiness,
    canCollect,
    getStatus,
    connect,
    getOnboardingLink,
    refreshStatus,
    disconnect,
    ensurePaymentLink,
    getPaymentLink,
    sendPaymentLink,
    getPublicPayInfo,
    createPublicPaySession,
    applyStripePayment,
    createManualCardSession,
    getConnectionToken,
    createTapToPayIntent,
    cancelTerminalIntent,
    applyStripeRefund,
    refundStripePayment,
    handleWebhook,
};
