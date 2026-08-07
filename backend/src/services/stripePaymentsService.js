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
const savedCardsQueries = require('../db/stripeSavedCardsQueries');
const jobFinanceQueries = require('../db/jobFinanceQueries');
const paymentsQueries = require('../db/paymentsQueries');
const paymentsService = require('./paymentsService');
const invoicesService = require('./invoicesService');
const invoicesQueries = require('../db/invoicesQueries');
const estimatesQueries = require('../db/estimatesQueries');
const marketplaceService = require('./marketplaceService');
const marketplaceQueries = require('../db/marketplaceQueries');
const auditService = require('./auditService');
const companyQueries = require('../db/companyQueries');
const technicianProfilesService = require('./technicianProfilesService');
const {
    clientActor,
    logFinancialActivity,
    stripeActor,
    userActor,
} = require('./financialActivityService');
const { withTransaction } = require('./transactionService');
const eventBus = require('./eventBus');

function emitPaymentDomainEvent(companyId, eventType, payment, client, idempotencyKey) {
    return eventBus.emit(companyId, eventType, {
        payment_id: payment.id,
        record_refs: [{ type: 'payment', id: payment.id }],
    }, {
        actorType: 'webhook',
        aggregateType: 'payment',
        aggregateId: payment.id,
        idempotencyKey,
        client,
    });
}

const APP_KEY = 'stripe-payments';

// STRIPE-CHECKOUT-IDEMPOTENCY-FIX: a stable idempotency key REQUIRES byte-identical
// request params on every replay, else Stripe rejects with "same key, different
// parameters". The checkout-link builders used to pass a Date.now()-derived
// `expires_at` under a stable key — it varied per call and poisoned the key whenever
// the first attempt failed to persist (e.g. the created_by FK bug) and a retry hit
// Stripe again. We stopped sending expires_at (Stripe Checkout defaults to a 24h
// expiry, which is exactly the old intent) and version the key so requests minted
// under the old param shape don't collide with the new ones. Bump on any future
// change to the checkout-link request params.
const CHECKOUT_KEY_VERSION = 'v2';
const PAYMENT_LINK_RECIPIENT_MAX_LENGTH = 254;

class StripePaymentsError extends Error {
    constructor(code, message, httpStatus = 400, details = null) {
        super(message);
        this.name = 'StripePaymentsError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
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
        { key: 'connect', label: 'Link your Stripe account', done: Boolean(account) },
        { key: 'onboarding', label: 'Tell Stripe about your business', done: Boolean(account?.details_submitted) },
        { key: 'payment_methods', label: 'Card payments switched on', done: account?.capabilities?.card_payments === 'active' },
        { key: 'field_payments', label: 'Tap to Pay on your phone', done: false, deferred: true },
        { key: 'first_payment', label: 'Start getting paid — collect your first payment right from a job', done: false },
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

    // STRIPE-DISCONNECT-SWEEP-001: a disconnected row means we are about to
    // mint a fresh account — sweep the abandoned Stripe account first so it
    // leaves the platform's Connected list (best-effort: Standard live
    // accounts are not deletable and simply stay).
    if (account && account.status === 'disconnected' && account.stripe_account_id) {
        try {
            await provider.deleteAccount(account.stripe_account_id);
        } catch (err) {
            console.warn('[StripePayments] stale account delete failed (continuing):', err.message);
        }
    }

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
    let account;
    try {
        account = await ensureAccountForCompany(companyId, company);
    } catch (err) {
        err.message = `creating Stripe account: ${err.message}`;
        throw err;
    }
    let link;
    try {
        link = await getOnboardingLink(companyId, account);
    } catch (err) {
        // STRIPE-REVOKED-HEAL-001: the stored account may have been deleted on
        // Stripe's side — mark it disconnected and mint a fresh one in the same
        // click instead of stranding the tenant on a dead row.
        if (isRevokedAccountError(err)) {
            await markAccountRevoked(companyId, account);
            account = await ensureAccountForCompany(companyId, company);
            link = await getOnboardingLink(companyId, account);
            return { account_id: account.stripe_account_id, onboarding_url: link.url };
        }
        err.message = `creating onboarding link: ${err.message}`;
        throw err;
    }
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

/**
 * STRIPE-REVOKED-HEAL-001: the merchant can delete their connected account (or
 * revoke platform access) directly on Stripe — the platform key then gets
 * 403 account_invalid for every call. Treat that as a disconnect: flip the
 * local row, audit it, and let the UI offer a clean re-connect instead of
 * surfacing a raw Stripe error at login.
 */
function isRevokedAccountError(err) {
    if (!err) return false;
    if (err.stripeCode === 'account_invalid') return true;
    return err.httpStatus === 403
        && /does not have access to account|access may have been revoked/i.test(String(err.message || ''));
}

async function markAccountRevoked(companyId, account) {
    await q.setAccountStatus(companyId, 'disconnected');
    await auditService.log({
        actor_id: null,
        action: 'stripe_payments.account_revoked',
        target_type: 'stripe_account',
        target_id: account?.stripe_account_id || null,
        company_id: companyId,
        details: { reason: 'account deleted or platform access revoked on Stripe' },
    }).catch(() => {});
}

async function refreshStatus(companyId) {
    const account = await q.getAccountByCompany(companyId);
    if (!account) throw new StripePaymentsError('NOT_CONNECTED', 'Stripe account not connected', 400);
    let mapped;
    try {
        mapped = await provider.getAccount(account.stripe_account_id);
    } catch (err) {
        if (isRevokedAccountError(err)) {
            await markAccountRevoked(companyId, account);
            return publicStatus(await q.getAccountByCompany(companyId));
        }
        throw err;
    }
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
    // Best-effort: remove the connected account on Stripe too, so it leaves the
    // platform's Connected accounts list (Express deletes when balances are
    // zero; Standard live accounts are not deletable — local disconnect stands).
    let stripeDeleted = false;
    try {
        const del = await provider.deleteAccount(account.stripe_account_id);
        stripeDeleted = Boolean(del?.deleted);
    } catch (err) {
        console.warn('[StripePayments] Stripe account delete failed (continuing):', err.message);
    }
    // Disconnect marketplace installation (history preserved).
    try {
        const installations = await marketplaceQueries.listInstallations(companyId, true);
        const inst = installations.find(i => i.app_key === APP_KEY && i.status === 'connected');
        if (inst) await marketplaceService.disconnectInstallation(companyId, actor?.id || null, inst.id);
    } catch (err) {
        console.warn('[StripePayments] marketplace disconnect failed (continuing):', err.message);
    }
    await auditService.log({ actor_id: actor?.id || null, action: 'stripe_payments.disconnected', target_type: 'stripe_account', target_id: account.stripe_account_id, company_id: companyId, details: { stripe_account_deleted: stripeDeleted } });
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

/**
 * Validate an ad-hoc (invoice-less) collect amount. Applied on every job/adhoc
 * entry (link + keyed-card via the resolveSurfaceContext job branch).
 * @returns {number} the amount normalized to 2dp.
 */
function assertAdhocAmount(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0.5) {
        throw new StripePaymentsError('INVALID_AMOUNT', 'Amount must be at least $0.50', 400);
    }
    if (n > 100000) {
        throw new StripePaymentsError('INVALID_AMOUNT', 'Amount exceeds the $100,000 limit', 400);
    }
    return Number(n.toFixed(2));
}

function invoiceBalance(invoice) {
    if (invoice.total == null) return Number(invoice.balance_due || 0);
    return Number(invoice.total || 0) - Number(invoice.amount_paid || 0);
}

async function ensurePaymentLink(
    companyId,
    actor,
    invoiceId,
    { amount } = {},
    client = null,
    activityActor = null
) {
    const account = await assertCollectable(companyId);
    const invoice = await invoicesService.getInvoice(companyId, invoiceId, client); // 404 if foreign
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
    const existing = await q.findOpenSession(companyId, invoiceId, payAmount, client);
    if (existing) return { url: existing.url, expires_at: existing.expires_at, reused: true, session_id: existing.id };

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h expiry policy
    const session = await provider.createCheckoutSession(account.stripe_account_id, {
        amount: payAmount,
        currency: invoice.currency || 'usd',
        invoiceNumber: invoice.invoice_number,
        successUrl: `${baseUrl()}/i/${invoice.public_token || ''}?paid=1`,
        cancelUrl: `${baseUrl()}/i/${invoice.public_token || ''}`,
        // expires_at intentionally NOT sent to Stripe — the Date.now() value varied
        // per call and poisoned the stable idempotency key (see CHECKOUT_KEY_VERSION).
        // Stripe Checkout defaults to a 24h expiry, matching the old intent; the DB
        // row keeps its own expires_at below for the reuse window.
        metadata: {
            company_id: companyId,
            invoice_id: String(invoiceId),
            job_id: invoice.job_id != null ? String(invoice.job_id) : '',
            contact_id: invoice.contact_id != null ? String(invoice.contact_id) : '',
        },
    }, { idempotencyKey: `inv-${companyId}-${invoiceId}-${payAmount}-${CHECKOUT_KEY_VERSION}` });

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
    }, client);
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.link_created',
            entity: invoice,
            actor: activityActor,
            summary: { amount: payAmount, currency: row.currency },
        }, { client });
    }
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

async function sendPaymentLink(
    companyId,
    actor,
    invoiceId,
    { channel = 'email', message } = {},
    client = null,
    activityActor = null
) {
    const link = await ensurePaymentLink(
        companyId,
        actor,
        invoiceId,
        {},
        client,
        activityActor
    );
    // Delivery follows the existing invoice send pattern (event-logged). Actual
    // email/SMS dispatch is handled by the shared messaging path / invoice send.
    await invoicesQueries.createEvent(companyId, invoiceId, 'payment_link_sent', 'user', actor?.id || null, {
        channel, message: message || null, url: link.url,
    }, client);
    if (activityActor) {
        const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.link_sent',
            entity: invoice,
            actor: activityActor,
            summary: { channel },
        }, { client });
    }
    return { sent: true, url: link.url, channel };
}

// ---- job payment links (invoice-independent, ad-hoc) — STRIPE-ADHOC-PAY-001 -

/**
 * Create (or reuse) a Stripe-hosted Checkout link for an arbitrary amount on a job,
 * with NO invoice. Mirrors ensurePaymentLink but keyed on the job; the settled
 * charge lands as one payment_transactions row (job_id set, invoice_id NULL) via
 * the unchanged webhook.
 */
async function ensureJobPaymentLink(companyId, actor, jobId, { amount } = {}) {
    const account = await assertCollectable(companyId);
    const ctx = await resolveSurfaceContext(companyId, { jobId, amount }); // loads job (404 foreign) + assertAdhocAmount
    const payAmount = ctx.amount;

    // Reuse a valid open job session for same job + amount (idempotent).
    const existing = await q.findOpenJobSession(companyId, ctx.jobId, payAmount);
    if (existing) return { url: existing.url, expires_at: existing.expires_at, reused: true, session_id: existing.id };

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h expiry policy
    const session = await provider.createCheckoutSession(account.stripe_account_id, {
        amount: payAmount,
        currency: 'usd',
        successUrl: `${baseUrl()}/pay/thanks`,
        cancelUrl: `${baseUrl()}/pay/thanks`,
        // expires_at intentionally NOT sent to Stripe — see the invoice path above
        // and the CHECKOUT_KEY_VERSION note. Stripe defaults to 24h; the DB row keeps
        // its own expires_at below for the reuse window.
        metadata: {
            company_id: companyId,
            invoice_id: '',
            job_id: String(ctx.jobId),
            contact_id: ctx.contactId != null ? String(ctx.contactId) : '',
        },
    }, { idempotencyKey: `job-${companyId}-${jobId}-${payAmount}-${CHECKOUT_KEY_VERSION}` });

    const row = await q.insertSession(companyId, {
        invoice_id: null,
        job_id: ctx.jobId,
        contact_id: ctx.contactId || null,
        created_by: actor?.id || null,
        surface: 'checkout_link',
        amount: payAmount,
        currency: 'USD',
        status: 'open',
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent || null,
        stripe_account_id: account.stripe_account_id,
        url: session.url,
        expires_at: expiresAt,
        metadata: {},
    });
    await auditService.log({ actor_id: actor?.id || null, action: 'stripe_payments.payment_link_created', target_type: 'job', target_id: String(jobId), company_id: companyId, details: { amount: payAmount } });
    return { url: row.url, expires_at: row.expires_at, reused: false, session_id: row.id };
}

async function getJobPaymentLink(companyId, jobId) {
    const sessions = await q.listSessionsForJob(companyId, jobId);
    const active = sessions.find(s => s.status === 'open' && (!s.expires_at || new Date(s.expires_at) > new Date()));
    return {
        active: active ? { url: active.url, expires_at: active.expires_at, amount: active.amount } : null,
        history: sessions.map(s => ({ id: s.id, status: s.status, amount: s.amount, surface: s.surface, failure_reason: s.failure_reason, created_at: s.created_at })),
    };
}

/**
 * Send a job payment link by email or SMS. Real dispatch wired to the SEND-DOC-001
 * dispatcher (emailService / conversationsService) — this actually delivers, unlike
 * the invoice sendPaymentLink (which only event-logs). Jobs have no invoice event
 * stream, so the audit row is the record.
 */
async function sendJobPaymentLink(companyId, actor, jobId, { channel, amount, message, recipient } = {}) {
    // Resolve the recipient contact directly (company-scoped → foreign 404) BEFORE
    // any amount validation, so NO_CONTACT surfaces regardless of the amount.
    const jobsService = require('./jobsService');
    const job = await jobsService.getJobById(jobId, companyId);
    if (!job) throw new StripePaymentsError('NOT_FOUND', `Job ${jobId} not found`, 404);
    const email = job.customer_email || null;
    const phone = job.customer_phone || null;
    if (recipient != null && typeof recipient !== 'string') {
        throw new StripePaymentsError('INVALID_RECIPIENT', 'Recipient must be a string.', 422);
    }
    const recipientOverride = typeof recipient === 'string' ? recipient.trim() : '';
    if (recipientOverride && channel !== 'email' && channel !== 'sms') {
        throw new StripePaymentsError('INVALID_CHANNEL', 'Choose email or sms when providing a recipient.', 422);
    }
    if (recipientOverride && recipientOverride.length > PAYMENT_LINK_RECIPIENT_MAX_LENGTH) {
        const code = channel === 'email' ? 'INVALID_EMAIL' : 'NO_PHONE';
        const message = channel === 'email' ? 'Enter a valid customer email' : 'A valid phone number is required.';
        throw new StripePaymentsError(code, message, 422);
    }
    if (!recipientOverride && !email && !phone) {
        throw new StripePaymentsError('NO_CONTACT', 'Job has no email or phone to send to', 422);
    }

    // Channel select: forced channel honored (422 if that channel's contact missing);
    // no forced channel → default email if present, else SMS.
    let chosen = channel;
    let sendTo;
    if (chosen === 'email') {
        sendTo = recipientOverride || email;
        if (!sendTo) throw new StripePaymentsError('NO_CONTACT', 'No email on file', 422);
        if (recipientOverride && !RECEIPT_EMAIL_SHAPE.test(sendTo)) {
            throw new StripePaymentsError('INVALID_EMAIL', 'Enter a valid customer email', 422);
        }
    } else if (chosen === 'sms') {
        sendTo = recipientOverride || phone;
        if (!sendTo) throw new StripePaymentsError('NO_CONTACT', 'No phone on file', 422);
    } else {
        chosen = email ? 'email' : 'sms';
        sendTo = chosen === 'email' ? email : phone;
    }

    const link = await ensureJobPaymentLink(companyId, actor, jobId, { amount });
    const body = message ? `${message}\n\n${link.url}` : link.url;
    let sentRecipient;

    if (chosen === 'email') {
        const emailMailboxService = require('./emailMailboxService');
        const mailbox = await emailMailboxService.getMailboxStatus(companyId);
        if (!mailbox || mailbox.status !== 'connected') {
            throw new StripePaymentsError('MAILBOX_NOT_CONNECTED', 'Connect Google Email to send.', 409);
        }
        let companyName = '';
        try {
            const company = await companyQueries.getCompanyById(companyId);
            companyName = company?.name || '';
        } catch { /* subject falls back to no company suffix */ }
        const subject = companyName ? `Payment request from ${companyName}` : 'Payment request';
        const emailService = require('./emailService');
        await emailService.sendEmail(companyId, {
            to: sendTo,
            subject,
            body,
            files: [],
            userId: actor?.id || null,
            userEmail: actor?.email || null,
        });
        sentRecipient = sendTo;
    } else {
        const { resolveCompanyProxyE164 } = require('./messagingHelper');
        const { toE164 } = require('../utils/phoneUtils');
        const proxy = await resolveCompanyProxyE164(companyId);
        if (!proxy) throw new StripePaymentsError('NO_PROXY', 'No company sending number is configured.', 422);
        const customerE164 = toE164(sendTo);
        if (!customerE164) throw new StripePaymentsError('NO_PHONE', 'A valid phone number is required.', 422);
        const conversationsService = require('./conversationsService');
        const conv = await conversationsService.getOrCreateConversation(customerE164, proxy, companyId);
        // Wallet gate lives INSIDE sendMessage → propagates as { httpStatus:402, code:'WALLET_BLOCKED' }.
        await conversationsService.sendMessage(conv.id, { companyId, body });
        sentRecipient = customerE164;
    }

    await auditService.log({ actor_id: actor?.id || null, action: 'stripe_payments.payment_link_sent', target_type: 'job', target_id: String(jobId), company_id: companyId, details: { channel: chosen, recipient: sentRecipient } });
    return { sent: true, url: link.url, channel: chosen };
}

// ---- manual card entry (Card Element) — Phase 3 -----------------------------

/**
 * Resolve amount + linkage from invoice or job context for a card-present / keyed
 * surface. Invoice context defaults to the current balance; job context needs an
 * explicit amount.
 */
async function resolveSurfaceContext(
    companyId,
    { invoiceId, jobId, contactId, amount },
    client = null,
    access = null
) {
    let ctx = {
        invoiceId: invoiceId || null,
        jobId: jobId || null,
        contactId: contactId || null,
        amount: amount != null ? Number(amount) : null,
        invoiceNumber: null,
    };
    if (contactId) {
        const contact = await estimatesQueries.getContactContext(
            companyId,
            contactId,
            client
        );
        if (!contact) {
            throw new StripePaymentsError('NOT_FOUND', `Contact ${contactId} not found`, 404);
        }
    }
    if (invoiceId) {
        const invoice = await invoicesService.getInvoice(companyId, invoiceId, client);
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
    } else if (jobId) {
        // Ad-hoc job collect (no invoice). Load the job company-scoped so a foreign
        // id 404s (no cross-tenant leak); pull recipient contact for the send path.
        const jobsService = require('./jobsService');
        const job = access?.providerScope
            ? await jobsService.getJobById(jobId, companyId, access.providerScope)
            : await jobsService.getJobById(jobId, companyId);
        if (!job) throw new StripePaymentsError('NOT_FOUND', `Job ${jobId} not found`, 404);
        ctx.jobId = job.id;
        ctx.contactId = job.contact_id || null;
        ctx.email = job.customer_email || null;
        ctx.phone = job.customer_phone || null;
        ctx.customerName = job.customer_name || null;
        ctx.amount = assertAdhocAmount(amount);
    } else {
        ctx.amount = assertAdhocAmount(amount);
    }
    if (access?.providerLimited) {
        if (!ctx.jobId) {
            throw new StripePaymentsError('NOT_FOUND', 'Job not found', 404);
        }
        const jobsService = require('./jobsService');
        const scopedJob = await jobsService.getJobById(
            ctx.jobId,
            companyId,
            access.providerScope
        );
        if (!scopedJob) throw new StripePaymentsError('NOT_FOUND', 'Job not found', 404);
    }
    return ctx;
}

async function getOrCreateContactCustomer(companyId, contactId, accountId, ctx, client) {
    if (client) await savedCardsQueries.lockContact(companyId, contactId, client);
    let mapping = await savedCardsQueries.getContactCustomer(companyId, contactId, client);
    if (mapping?.stripe_account_id === accountId) return mapping;

    const customer = await provider.createCustomer(accountId, {
        name: ctx.customerName || undefined,
        email: ctx.email || undefined,
        phone: ctx.phone || undefined,
        metadata: {
            albusto_company_id: companyId,
            albusto_contact_id: String(contactId),
        },
    }, {
        idempotencyKey: `contact-customer-${companyId}-${contactId}-${accountId}`,
    });
    mapping = await savedCardsQueries.upsertContactCustomer(
        companyId,
        contactId,
        accountId,
        customer.id,
        client
    );
    return mapping;
}

async function createCardSession(
    companyId,
    actor,
    surface,
    params,
    client = null,
    activityActor = null,
    access = null
) {
    const account = await assertCollectable(companyId);
    const ctx = await resolveSurfaceContext(companyId, params, client, access);
    const customerMapping = surface === 'manual_card' && ctx.contactId
        ? await getOrCreateContactCustomer(
            companyId,
            ctx.contactId,
            account.stripe_account_id,
            ctx,
            client
        )
        : null;
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
        : await provider.createCardPaymentIntent(account.stripe_account_id, {
            amount: ctx.amount,
            metadata,
            customerId: customerMapping?.stripe_customer_id || null,
            saveForFuture: Boolean(customerMapping),
        }, { idempotencyKey });

    const row = await q.insertSession(companyId, {
        invoice_id: ctx.invoiceId, job_id: ctx.jobId, contact_id: ctx.contactId,
        created_by: actor?.id || null, surface, amount: ctx.amount, status: 'open',
        stripe_payment_intent_id: pi.id,
        stripe_account_id: account.stripe_account_id,
        metadata: customerMapping
            ? { save_for_future: true, contact_customer_id: customerMapping.id }
            : {},
    }, client);
    if (activityActor) {
        const paymentTarget = {
            ...row,
            estimate_id: null,
        };
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.session_started',
            entity: paymentTarget,
            actor: activityActor,
            summary: { amount: ctx.amount, currency: row.currency },
        }, { client });
        if (ctx.invoiceId) {
            const invoice = await invoicesQueries.getInvoiceById(
                companyId,
                ctx.invoiceId,
                client
            );
            await logFinancialActivity({
                companyId,
                entityType: 'invoice',
                action: 'invoice.card_session_started',
                entity: invoice,
                actor: activityActor,
                summary: { amount: ctx.amount, currency: row.currency },
            }, { client });
        }
    }
    return {
        // BIGSERIAL → pg serializes the id as a STRING. The client contract is a number, and the
        // same-window card-entry hand-off validates sessionId with isPositiveInteger (typeof
        // 'number'); a string there fails as "bad-payload" (installed-PWA card entry, CARDFRAME).
        session_id: Number(row.id),
        client_secret: pi.client_secret,
        payment_intent_id: pi.id,
        account_id: account.stripe_account_id,
        amount: ctx.amount,
        save_for_future: Boolean(customerMapping),
    };
}

const createManualCardSession = (
    companyId,
    actor,
    params,
    client = null,
    activityActor = null,
    access = null
) => createCardSession(
    companyId,
    actor,
    'manual_card',
    params,
    client,
    activityActor,
    access
);

function parseSessionMetadata(value) {
    if (!value || typeof value === 'object') return value || {};
    try { return JSON.parse(value); } catch { return {}; }
}

async function getMerchantManualCardSession(companyId, sessionId, client = null) {
    if (!/^\d+$/.test(String(sessionId || ''))) {
        throw new StripePaymentsError('NOT_FOUND', 'Manual card session not found', 404);
    }

    const session = await q.getSessionById(companyId, sessionId, client);
    const metadata = parseSessionMetadata(session?.metadata);
    const isMerchantManual = session?.surface === 'manual_card'
        && metadata.public !== true
        && metadata.public !== 'true';
    if (!isMerchantManual || !session.stripe_payment_intent_id || !session.stripe_account_id) {
        throw new StripePaymentsError('NOT_FOUND', 'Manual card session not found', 404);
    }
    return session;
}

async function assertManualCardSessionAccess(companyId, session, access = null) {
    if (!access?.providerLimited) return;
    if (!access.actorId || String(session.created_by || '') !== String(access.actorId)) {
        throw new StripePaymentsError('NOT_FOUND', 'Manual card session not found', 404);
    }
    if (!session.job_id) {
        throw new StripePaymentsError('NOT_FOUND', 'Manual card session not found', 404);
    }
    const jobsService = require('./jobsService');
    const job = await jobsService.getJobById(
        session.job_id,
        companyId,
        access.providerScope
    );
    if (!job) throw new StripePaymentsError('NOT_FOUND', 'Manual card session not found', 404);
}

async function cacheSuccessfulManualCard(companyId, session, pi) {
    const metadata = parseSessionMetadata(session.metadata);
    if (!session.contact_id || metadata.save_for_future !== true) return null;
    const mapping = await savedCardsQueries.getContactCustomer(companyId, session.contact_id);
    if (!mapping || mapping.stripe_account_id !== session.stripe_account_id) return null;

    let paymentMethod = pi.payment_method && typeof pi.payment_method === 'object'
        ? pi.payment_method
        : null;
    const paymentMethodId = typeof pi.payment_method === 'string'
        ? pi.payment_method
        : pi.payment_method?.id;
    if (!paymentMethod && paymentMethodId) {
        paymentMethod = await provider.retrievePaymentMethod(
            session.stripe_account_id,
            paymentMethodId
        );
    }
    const card = paymentMethod?.card;
    const attachedCustomer = typeof paymentMethod?.customer === 'string'
        ? paymentMethod.customer
        : paymentMethod?.customer?.id;
    if (!paymentMethod?.id || !card || attachedCustomer !== mapping.stripe_customer_id) {
        return null;
    }
    return savedCardsQueries.upsertSavedCard(companyId, {
        contactId: session.contact_id,
        contactCustomerId: mapping.id,
        stripeAccountId: session.stripe_account_id,
        stripeCustomerId: mapping.stripe_customer_id,
        stripePaymentMethodId: paymentMethod.id,
        brand: String(card.brand || 'card').toLowerCase(),
        last4: String(card.last4 || ''),
        expMonth: Number(card.exp_month),
        expYear: Number(card.exp_year),
    });
}

function manualCardFailure(pi, fallbackMessage = 'The card could not be charged') {
    const message = pi?.last_payment_error?.message || fallbackMessage;
    if (pi?.status === 'requires_payment_method') {
        return new StripePaymentsError('CARD_DECLINED', message, 402);
    }
    if (pi?.status === 'canceled') {
        return new StripePaymentsError('PAYMENT_CANCELED', message, 409);
    }
    return new StripePaymentsError('PAYMENT_NOT_FINAL', message, 409);
}

/**
 * Project a synchronously confirmed keyed-card PaymentIntent through the same
 * idempotent ledger path used by payment_intent.succeeded webhooks. A later
 * webhook dedupes on the PaymentIntent id.
 */
async function reconcileSuccessfulManualCardPayment(companyId, session, pi) {
    await withTransaction(async (client) => {
        const ownedSession = await getMerchantManualCardSession(companyId, session.id, client);
        const charge = pi.latest_charge;
        await q.updateSession(companyId, ownedSession.id, {
            status: 'complete',
            stripe_charge_id: typeof charge === 'string' ? charge : charge?.id || null,
        }, client);
        await applyStripePayment(companyId, {
            externalId: pi.id,
            invoiceId: ownedSession.invoice_id || null,
            contactId: ownedSession.contact_id || null,
            jobId: ownedSession.job_id || null,
            amount: (pi.amount_received ?? pi.amount) / 100,
            currency: pi.currency,
            metadata: {
                surface: pi.metadata?.surface || 'manual_card',
                payment_intent_id: pi.id,
                tip: pi.metadata?.tip || 0,
            },
        }, client, stripeActor());
    });
    try {
        await cacheSuccessfulManualCard(companyId, session, pi);
    } catch (error) {
        console.error('[StripePayments] saved-card cache failed:', error.message);
    }
}

async function resolveManualCardConfirmation(companyId, session, pi) {
    if (pi.status === 'succeeded') {
        await reconcileSuccessfulManualCardPayment(companyId, session, pi);
        return { status: 'succeeded' };
    }
    if (pi.status === 'requires_action') {
        if (!pi.client_secret) {
            throw new StripePaymentsError(
                'CLIENT_SECRET_UNAVAILABLE',
                'Card authentication could not be started',
                409
            );
        }
        return { status: 'requires_action', clientSecret: pi.client_secret };
    }
    throw manualCardFailure(pi);
}

/**
 * Confirm the existing company-owned manual-card PaymentIntent with the
 * PaymentMethod created in the popup. The stable key makes a transport retry of
 * the same session + PaymentMethod safe.
 */
async function confirmManualCardSession(companyId, sessionId, paymentMethodId, access = null) {
    const session = await getMerchantManualCardSession(companyId, sessionId);
    await assertManualCardSessionAccess(companyId, session, access);
    if (!/^pm_[A-Za-z0-9_]+$/.test(String(paymentMethodId || ''))) {
        throw new StripePaymentsError('INVALID_PAYMENT_METHOD', 'Choose a valid card', 400);
    }

    let pi;
    try {
        pi = await provider.confirmPaymentIntent(
            session.stripe_account_id,
            session.stripe_payment_intent_id,
            { paymentMethodId },
            {
                idempotencyKey:
                    `manual-card-confirm-${companyId}-${session.id}-${paymentMethodId}`,
            }
        );
    } catch (err) {
        if (err.stripePaymentIntent?.status === 'requires_payment_method'
            || err.stripeCode === 'card_declined') {
            throw new StripePaymentsError(
                'CARD_DECLINED',
                err.message || 'The card was declined',
                402
            );
        }
        throw err;
    }
    return resolveManualCardConfirmation(companyId, session, pi);
}

/**
 * After Stripe.js handles a next action in the popup, retrieve the same owned
 * PaymentIntent and synchronously project a success into the canonical ledger.
 */
async function finalizeManualCardSession(companyId, sessionId, access = null) {
    const session = await getMerchantManualCardSession(companyId, sessionId);
    await assertManualCardSessionAccess(companyId, session, access);
    const pi = await provider.retrievePaymentIntent(
        session.stripe_account_id,
        session.stripe_payment_intent_id
    );
    return resolveManualCardConfirmation(companyId, session, pi);
}

/**
 * Reconcile one merchant manual-card session without exposing Stripe/session ids.
 * Ownership and merchant/public classification are resolved before any Stripe call.
 */
async function getManualCardSessionResult(companyId, sessionId, access = null) {
    const session = await getMerchantManualCardSession(companyId, sessionId);
    await assertManualCardSessionAccess(companyId, session, access);

    const pi = await provider.retrievePaymentIntent(
        session.stripe_account_id,
        session.stripe_payment_intent_id
    );
    let paymentMethod = pi.payment_method && typeof pi.payment_method === 'object'
        ? pi.payment_method
        : null;
    if (!paymentMethod && typeof pi.payment_method === 'string') {
        try {
            paymentMethod = await provider.retrievePaymentMethod(session.stripe_account_id, pi.payment_method);
        } catch {
            // Brand/last4 are enrichment; a retrieved PI status remains authoritative.
        }
    }
    const card = paymentMethod?.card || null;

    return {
        status: pi.status,
        amount: Number(pi.amount || 0) / 100,
        brand: card?.brand || null,
        last4: card?.last4 || null,
    };
}

function publicSavedCard(card) {
    return {
        id: Number(card.id),
        brand: card.brand,
        last4: card.last4,
        exp_month: Number(card.exp_month),
        exp_year: Number(card.exp_year),
    };
}

async function getScopedJob(companyId, jobId, access = null) {
    const jobsService = require('./jobsService');
    const job = access?.providerScope
        ? await jobsService.getJobById(jobId, companyId, access.providerScope)
        : await jobsService.getJobById(jobId, companyId);
    if (!job) throw new StripePaymentsError('NOT_FOUND', 'Job not found', 404);
    return job;
}

async function getJobDue(companyId, jobId, client = null) {
    const rollups = await jobFinanceQueries.listJobPaymentRollups(
        companyId,
        [Number(jobId)],
        client
    );
    return Number(Number(rollups[0]?.total_due || 0).toFixed(2));
}

async function listJobSavedCards(companyId, jobId, access = null) {
    const job = await getScopedJob(companyId, jobId, access);
    const due = await getJobDue(companyId, job.id);
    if (!job.contact_id) return { due, cards: [] };
    const account = await assertCollectable(companyId);
    const cards = await savedCardsQueries.listUsableContactCards(
        companyId,
        job.contact_id,
        account.stripe_account_id
    );
    return { due, cards: cards.map(publicSavedCard) };
}

async function listContactSavedCards(companyId, contactId) {
    const contact = await estimatesQueries.getContactContext(companyId, contactId);
    if (!contact) throw new StripePaymentsError('NOT_FOUND', 'Contact not found', 404);
    const account = await q.getAccountByCompany(companyId);
    if (!account) return [];
    const cards = await savedCardsQueries.listUsableContactCards(
        companyId,
        contactId,
        account.stripe_account_id
    );
    return cards.map(publicSavedCard);
}

async function removeContactSavedCard(companyId, actor, contactId, cardId) {
    const contact = await estimatesQueries.getContactContext(companyId, contactId);
    if (!contact) throw new StripePaymentsError('NOT_FOUND', 'Contact not found', 404);
    const card = await savedCardsQueries.getOwnedCard(companyId, contactId, cardId);
    if (!card) throw new StripePaymentsError('NOT_FOUND', 'Saved card not found', 404);
    try {
        await provider.detachPaymentMethod(
            card.stripe_account_id,
            card.stripe_payment_method_id
        );
    } catch (error) {
        if (error.stripeCode !== 'resource_missing') throw error;
    }
    await savedCardsQueries.deleteOwnedCard(companyId, contactId, cardId);
    await auditService.log({
        actor_id: actor?.id || null,
        action: 'contact.saved_card_removed',
        target_type: 'contact',
        target_id: String(contactId),
        company_id: companyId,
        details: { saved_card_id: Number(cardId) },
    });
    return { removed: true };
}

function validateSavedCardChargeInput({ amount, expectedDue, requestKey }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(requestKey || ''))) {
        throw new StripePaymentsError('INVALID_REQUEST_KEY', 'A valid request key is required', 400);
    }
    const chargeAmount = assertAdhocAmount(amount);
    const displayedDue = Number(expectedDue);
    if (!Number.isFinite(displayedDue)) {
        throw new StripePaymentsError('INVALID_AMOUNT', 'Expected due is required', 400);
    }
    return {
        amount: chargeAmount,
        expectedDue: Number(displayedDue.toFixed(2)),
        requestKey: String(requestKey),
    };
}

function savedCardFailure(error) {
    const requiresAuthentication = error.stripeCode === 'authentication_required'
        || error.stripePaymentIntent?.status === 'requires_action';
    if (requiresAuthentication) {
        return new StripePaymentsError(
            'AUTHENTICATION_REQUIRED',
            'This saved card needs verification. Enter the card again to continue.',
            402,
            { can_enter_card: true }
        );
    }
    if (error.stripeCode === 'card_declined' || error.stripeDeclineCode) {
        return new StripePaymentsError(
            'CARD_DECLINED',
            error.message || 'The saved card was declined.',
            402,
            { can_enter_card: true }
        );
    }
    return error;
}

async function chargeJobSavedCard(companyId, actor, jobId, input, access = null) {
    const { amount, expectedDue, requestKey } = validateSavedCardChargeInput(input);
    const job = await getScopedJob(companyId, jobId, access);
    if (!job.contact_id) {
        throw new StripePaymentsError('NO_CONTACT', 'This job has no contact with a saved card', 409);
    }
    const account = await assertCollectable(companyId);
    const prior = await q.getSessionByRequestKey(companyId, requestKey);
    if (prior) {
        if (String(prior.job_id) !== String(job.id)
            || String(prior.created_by || '') !== String(actor?.id || '')) {
            throw new StripePaymentsError('IDEMPOTENCY_CONFLICT', 'Request key was already used', 409);
        }
        if (prior.status === 'complete') {
            const payment = await paymentsQueries.findByExternalSourceId(
                companyId,
                'stripe',
                prior.stripe_payment_intent_id
            );
            return { status: 'succeeded', amount: Number(prior.amount), payment };
        }
        if (prior.status !== 'open') {
            throw new StripePaymentsError(
                'PAYMENT_ATTEMPT_FAILED',
                prior.failure_reason || 'This payment attempt failed. Try again.',
                409,
                { can_enter_card: true }
            );
        }
    }

    const due = await getJobDue(companyId, job.id);
    if (due < 0.5) {
        throw new StripePaymentsError('NOTHING_DUE', 'This job has no chargeable balance', 409);
    }
    if (Math.round(expectedDue * 100) !== Math.round(due * 100)) {
        throw new StripePaymentsError(
            'DUE_CHANGED',
            'The job balance changed. Confirm the new amount.',
            409,
            { current_due: due }
        );
    }
    if (Math.round(amount * 100) > Math.round(due * 100)) {
        throw new StripePaymentsError(
            'AMOUNT_EXCEEDS_DUE',
            'Saved-card charge amount cannot exceed the current job balance. Enter the card manually to charge more.',
            400,
            { current_due: due, can_enter_card: true }
        );
    }

    const cardId = Number(input.savedCardId);
    if (!Number.isInteger(cardId) || cardId <= 0) {
        throw new StripePaymentsError('CARD_UNAVAILABLE', 'Saved card is unavailable', 409);
    }
    if (prior) {
        const priorMetadata = parseSessionMetadata(prior.metadata);
        if (Number(priorMetadata.saved_card_id) !== cardId) {
            throw new StripePaymentsError('IDEMPOTENCY_CONFLICT', 'Request key was already used', 409);
        }
        if (Math.round(Number(prior.amount) * 100) !== Math.round(amount * 100)) {
            throw new StripePaymentsError(
                'IDEMPOTENCY_CONFLICT',
                'Request key was already used',
                409
            );
        }
    }
    // CARD-ON-FILE-001 fail-closed control: this lookup contains the independent
    // saved_at > NOW() - 14 days predicate. Cleanup timing cannot widen access.
    const card = await savedCardsQueries.getUsableCard(
        companyId,
        job.contact_id,
        account.stripe_account_id,
        cardId
    );
    if (!card) {
        throw new StripePaymentsError(
            'CARD_EXPIRED',
            'This saved card has expired. Enter the card again.',
            409,
            { can_enter_card: true }
        );
    }
    const mapping = await savedCardsQueries.getContactCustomer(companyId, job.contact_id);
    if (!mapping
        || mapping.stripe_account_id !== account.stripe_account_id
        || mapping.stripe_customer_id !== card.stripe_customer_id) {
        throw new StripePaymentsError('CARD_UNAVAILABLE', 'Saved card is unavailable', 409);
    }

    let paymentMethod;
    try {
        paymentMethod = await provider.retrievePaymentMethod(
            account.stripe_account_id,
            card.stripe_payment_method_id
        );
    } catch (error) {
        if (error.stripeCode === 'resource_missing') {
            await savedCardsQueries.deleteOwnedCard(companyId, job.contact_id, card.id);
            throw new StripePaymentsError(
                'CARD_UNAVAILABLE',
                'This saved card is no longer available. Enter the card again.',
                409,
                { can_enter_card: true }
            );
        }
        throw error;
    }
    const attachedCustomer = typeof paymentMethod.customer === 'string'
        ? paymentMethod.customer
        : paymentMethod.customer?.id;
    if (attachedCustomer !== mapping.stripe_customer_id || !paymentMethod.card) {
        throw new StripePaymentsError('CARD_UNAVAILABLE', 'Saved card is unavailable', 409);
    }

    let session = prior;
    if (!session) {
        try {
            session = await withTransaction(client => q.insertSession(companyId, {
                job_id: job.id,
                contact_id: job.contact_id,
                created_by: actor?.id || null,
                surface: 'saved_card',
                amount,
                currency: 'USD',
                status: 'open',
                stripe_account_id: account.stripe_account_id,
                metadata: { saved_card_id: card.id },
                request_key: requestKey,
            }, client));
        } catch (error) {
            if (error.code === '23505') {
                throw new StripePaymentsError(
                    'PAYMENT_IN_PROGRESS',
                    'Another saved-card payment is already in progress for this job.',
                    409
                );
            }
            throw error;
        }
    }

    let pi;
    try {
        pi = await provider.createOffSessionPaymentIntent(account.stripe_account_id, {
            amount: Number(session.amount),
            currency: session.currency || 'USD',
            customerId: mapping.stripe_customer_id,
            paymentMethodId: card.stripe_payment_method_id,
            metadata: {
                company_id: companyId,
                invoice_id: '',
                job_id: String(job.id),
                contact_id: String(job.contact_id),
                surface: 'saved_card',
            },
        }, { idempotencyKey: `saved-card-session-${session.id}` });
    } catch (error) {
        const knownFailure = error.stripeCode === 'authentication_required'
            || error.stripeCode === 'card_declined'
            || Boolean(error.stripeDeclineCode)
            || error.stripePaymentIntent?.status === 'requires_action'
            || error.stripePaymentIntent?.status === 'requires_payment_method';
        if (knownFailure) {
            await q.updateSession(companyId, session.id, {
                status: 'failed',
                stripe_payment_intent_id: error.stripePaymentIntent?.id || null,
                failure_reason: error.message || 'Saved-card payment failed',
            });
        }
        throw savedCardFailure(error);
    }
    if (pi.status !== 'succeeded') {
        await q.updateSession(companyId, session.id, {
            status: 'failed',
            stripe_payment_intent_id: pi.id,
            failure_reason: 'Saved-card payment was not completed',
        });
        throw new StripePaymentsError(
            'PAYMENT_NOT_FINAL',
            'The saved-card payment was not completed. Enter the card again.',
            409,
            { can_enter_card: true }
        );
    }

    let paymentResult;
    await withTransaction(async client => {
        await q.updateSession(companyId, session.id, {
            status: 'complete',
            stripe_payment_intent_id: pi.id,
            stripe_charge_id: typeof pi.latest_charge === 'string'
                ? pi.latest_charge
                : pi.latest_charge?.id || null,
        }, client);
        paymentResult = await applyStripePayment(companyId, {
            externalId: pi.id,
            invoiceId: null,
            contactId: job.contact_id,
            jobId: job.id,
            amount: (pi.amount_received ?? pi.amount) / 100,
            currency: pi.currency,
            metadata: { surface: 'saved_card', payment_intent_id: pi.id, tip: 0 },
        }, client, userActor(actor?.id || null));
        await savedCardsQueries.markCardUsed(companyId, card.id, client);
    });
    return {
        status: 'succeeded',
        amount: Number(session.amount),
        payment: paymentResult?.tx || null,
    };
}

const RECEIPT_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolve a keyed-card session to its canonical tenant-owned payment and
 * delegate to the Albusto receipt sender. Stripe-native receipts are disabled.
 */
async function sendManualCardReceipt(
    companyId,
    sessionId,
    rawEmail,
    noteActor = null,
    client = null,
    activityActor = null,
    idempotencyKey = null,
    access = null
) {
    // Resolve tenant ownership before the ledger lookup so foreign/public
    // session ids retain a uniform 404 with no provider or email side effects.
    const session = await getMerchantManualCardSession(companyId, sessionId, client);
    await assertManualCardSessionAccess(companyId, session, access);
    const payment = await paymentsQueries.findByExternalSourceId(
        companyId,
        'stripe',
        session.stripe_payment_intent_id,
        client
    );
    if (!payment) {
        throw new StripePaymentsError(
            'PAYMENT_NOT_SYNCED',
            'Payment is still being recorded. Try sending the receipt again.',
            409
        );
    }
    return paymentsService.emailTransactionReceipt(
        companyId,
        payment.id,
        rawEmail,
        noteActor,
        client,
        activityActor,
        idempotencyKey
    );
}

// ---- Terminal / Tap to Pay (backend) — Phase 4 -----------------------------

async function getConnectionToken(companyId) {
    const account = await assertCollectable(companyId);
    let locations = await q.listTerminalLocations(companyId);
    // TAP2PAY-001: connecting the on-device reader REQUIRES a Terminal Location.
    // First use auto-provisions one on the connected account so the mobile
    // client never has to orchestrate location setup itself.
    if (locations.length === 0) {
        // TAP2PAY-001 (owner report 2026-08-03): Stripe rejects a US Terminal
        // Location without address[line1]. Our companies table only carries
        // city/state/zip, so take the merchant's VERIFIED business address from
        // their own connected account (company → individual → support address),
        // and say plainly what to fix when it isn't there.
        const raw = await provider.getAccountRaw(account.stripe_account_id);
        const addr = raw?.company?.address
            || raw?.individual?.address
            || raw?.business_profile?.support_address
            || null;
        if (!addr?.line1) {
            throw new StripePaymentsError(
                'TERMINAL_LOCATION_ADDRESS_MISSING',
                'Add your business street address in Stripe before using Tap to Pay.',
                409
            );
        }
        const created = await provider.createTerminalLocation(account.stripe_account_id, {
            displayName: raw?.business_profile?.name || raw?.settings?.dashboard?.display_name || 'Primary location',
            address: {
                line1: addr.line1,
                line2: addr.line2 || undefined,
                city: addr.city || undefined,
                state: addr.state || undefined,
                postal_code: addr.postal_code || undefined,
                country: addr.country || 'US',
            },
        });
        await q.insertTerminalLocation(companyId, {
            stripeAccountId: account.stripe_account_id,
            stripeLocationId: created.id,
            displayName: created.display_name || 'Primary location',
            address: created.address || {},
        });
        locations = await q.listTerminalLocations(companyId);
    }
    const token = await provider.createConnectionToken(account.stripe_account_id, { locationId: locations[0]?.stripe_location_id });
    return { secret: token.secret, location_id: locations[0]?.stripe_location_id || null };
}

const createTapToPayIntent = (
    companyId,
    actor,
    params,
    client = null,
    activityActor = null
) => createCardSession(
    companyId,
    actor,
    'tap_to_pay',
    params,
    client,
    activityActor
);

async function cancelTerminalIntent(
    companyId,
    actor,
    paymentIntentId,
    client = null,
    activityActor = null
) {
    const session = await q.getSessionByPaymentIntent(companyId, paymentIntentId, client);
    if (!session || session.surface !== 'tap_to_pay') {
        throw new StripePaymentsError('NOT_FOUND', 'Terminal payment session not found', 404);
    }
    const account = await q.getAccountByCompany(companyId);
    if (!account) throw new StripePaymentsError('NOT_CONNECTED', 'Stripe account not connected', 400);
    await provider.cancelPaymentIntent(account.stripe_account_id, paymentIntentId);
    const updated = await q.updateSession(
        companyId,
        session.id,
        { status: 'canceled' },
        client
    );
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.session_canceled',
            entity: updated || session,
            actor: activityActor,
            summary: { status: 'canceled' },
        }, { client });
    }
    return { canceled: true };
}

// ---- refunds — Phase 5 ------------------------------------------------------

/** Idempotent refund recording keyed on the Stripe refund id. */
async function applyStripeRefund(
    companyId,
    { refundId, paymentIntentId, amount, reason },
    client = null,
    activityActor = null
) {
    const existing = await paymentsQueries.findByExternalSourceId(
        companyId,
        'stripe',
        refundId,
        client
    );
    if (existing) return { tx: existing, deduped: true };
    const original = paymentIntentId
        ? await paymentsQueries.findByExternalSourceId(
            companyId,
            'stripe',
            paymentIntentId,
            client
        )
        : null;

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
        }, client);
    } catch (err) {
        if (err.code === '23505') {
            const row = await paymentsQueries.findByExternalSourceId(
                companyId,
                'stripe',
                refundId,
                client
            );
            return { tx: row, deduped: true };
        }
        throw err;
    }

    if (original) {
        await paymentsQueries.updateTransactionStatus(
            original.id,
            companyId,
            'refunded',
            {},
            client
        );
        if (original.invoice_id) {
            // Keep the invoice event/receipt reference, but never mutate invoice
            // aggregates. The canonical read allocator applies this refund live.
            const refundAmt = Math.abs(Number(amount));
            const origTotal = Math.abs(Number(original.amount)) || refundAmt;
            const origTip = Math.max(0, Number(original.metadata?.tip || 0) || 0);
            const origBalancePortion = Math.max(0, origTotal - origTip);
            const invoiceReversal = origTip > 0 && origTotal > 0
                ? Number((refundAmt * (origBalancePortion / origTotal)).toFixed(2))
                : refundAmt;
            await invoicesQueries.createEvent(
                companyId,
                original.invoice_id,
                'payment_recorded',
                'system',
                null,
                {
                    amount: -invoiceReversal,
                    tip_refunded: Number((refundAmt - invoiceReversal).toFixed(2)),
                    payment_method: 'credit_card',
                    source: 'stripe',
                    refund: true,
                    external_id: refundId,
                },
                client
            );
        }
    }
    if (activityActor) {
        const paymentTarget = original || tx;
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.refunded',
            entity: paymentTarget,
            actor: activityActor,
            summary: {
                amount: Math.abs(Number(amount)),
                currency: tx.currency,
                payment_id: tx.id,
            },
        }, { client });
        if (original?.invoice_id) {
            const invoice = await invoicesQueries.getInvoiceById(
                companyId,
                original.invoice_id,
                client
            );
            await logFinancialActivity({
                companyId,
                entityType: 'invoice',
                action: 'invoice.refunded',
                entity: invoice,
                actor: activityActor,
                summary: {
                    amount: Math.abs(Number(amount)),
                    currency: tx.currency,
                    payment_id: original.id,
                },
            }, { client });
        }
    }
    await emitPaymentDomainEvent(
        companyId,
        'payment.refunded',
        original || tx,
        client,
        `payment.refunded:stripe:${refundId}`
    );
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

    const activityActor = userActor(actor?.id || null);
    let refund;
    try {
        refund = await provider.createRefund(account.stripe_account_id, {
            paymentIntent: original.external_id,
            amount: refundAmount,
            reason: reason ? 'requested_by_customer' : undefined,
        }, { idempotencyKey: `refund-${companyId}-${transactionId}-${refundAmount}` });
    } catch (err) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'refund.failed',
            entity: original,
            actor: activityActor,
            summary: { amount: refundAmount, currency: original.currency },
        });
        throw err;
    }
    const res = await withTransaction(client => applyStripeRefund(
        companyId,
        {
            refundId: refund.id,
            paymentIntentId: original.external_id,
            amount: refundAmount,
            reason,
        },
        client,
        activityActor
    ));
    return { refund_id: refund.id, transaction: res.tx };
}

// ---- public Pay now ---------------------------------------------------------

async function getPublicPayInfo(token, { recordView = false } = {}) {
    const invoice = await invoicesQueries.getInvoiceByPublicToken(token);
    if (!invoice) throw new StripePaymentsError('NOT_FOUND', 'Invoice not found', 404);
    if (recordView) {
        await logFinancialActivity({
            companyId: invoice.company_id,
            entityType: 'invoice',
            action: 'invoice.viewed',
            entity: invoice,
            actor: clientActor(),
        });
    }
    const account = await q.getAccountByCompany(invoice.company_id);
    const readiness = computeReadiness(account);
    const balance = invoiceBalance(invoice);
    const payable = canCollect(readiness) && balance > 0 && !['void', 'refunded'].includes(invoice.status);
    const company = await companyQueries.getCompanyById(invoice.company_id).catch(() => null);
    let technician = null;
    try { technician = await technicianProfilesService.getTechnicianForInvoice(invoice.company_id, invoice); } catch (e) { /* optional */ }
    const companyName = company?.name || 'Our team';
    // Opaque: never expose internal ids.
    return {
        invoice_number: invoice.invoice_number,
        status: invoice.status,
        balance_due: balance,
        currency: (invoice.currency || 'USD'),
        paid: balance <= 0 || invoice.status === 'paid',
        payable,
        company_name: companyName,
        thank_you: technician?.name
            ? `Thank you for choosing ${companyName}! ${technician.name} took care of your service.`
            : `Thank you for choosing ${companyName}!`,
        technician: technician ? { name: technician.name, photo_url: technician.photo_url } : null,
    };
}

async function createPublicPaySession(
    token,
    client = null,
    { recordActivity = false } = {}
) {
    const invoice = await invoicesQueries.getInvoiceByPublicToken(token, client);
    if (!invoice) throw new StripePaymentsError('NOT_FOUND', 'Invoice not found', 404);
    const actor = clientActor();
    const link = await ensurePaymentLink(
        invoice.company_id,
        null,
        invoice.id,
        {},
        client,
        recordActivity ? actor : null
    );
    if (recordActivity) {
        await logFinancialActivity({
            companyId: invoice.company_id,
            entityType: 'payment',
            action: 'payment.session_started',
            entity: {
                id: link.session_id,
                invoice_id: invoice.id,
                job_id: invoice.job_id,
                contact_id: invoice.contact_id,
            },
            actor,
        }, { client });
    }
    return { url: link.url };
}

/**
 * Public embedded-pay flow: create a PaymentIntent on the connected account for the
 * invoice balance + optional tip, returning the client_secret for the Payment Element.
 */
async function createPublicPayIntent(
    token,
    { tip = 0 } = {},
    client = null,
    { recordActivity = false } = {}
) {
    const invoice = await invoicesQueries.getInvoiceByPublicToken(token, client);
    if (!invoice) throw new StripePaymentsError('NOT_FOUND', 'Invoice not found', 404);
    if (invoice.job_id == null) {
        throw new StripePaymentsError(
            'JOB_REQUIRED',
            'This invoice must be linked to a job before it can accept payment',
            400
        );
    }
    const companyId = invoice.company_id;
    const account = await assertCollectable(companyId);
    if (['void', 'refunded', 'paid'].includes(invoice.status)) {
        throw new StripePaymentsError('INVALID_STATUS', `Cannot pay an invoice with status '${invoice.status}'`, 400);
    }
    const balance = invoiceBalance(invoice);
    const tipAmount = Math.max(0, Number(tip) || 0);
    const total = Number((balance + tipAmount).toFixed(2));
    if (!(balance > 0)) throw new StripePaymentsError('INVALID_AMOUNT', 'Nothing to pay', 400);

    const metadata = {
        company_id: companyId,
        invoice_id: String(invoice.id),
        job_id: invoice.job_id != null ? String(invoice.job_id) : '',
        contact_id: invoice.contact_id != null ? String(invoice.contact_id) : '',
        tip: String(tipAmount),
        surface: 'public_pay',
    };
    const pi = await provider.createPaymentIntent(account.stripe_account_id,
        { amount: total, currency: invoice.currency || 'usd', metadata },
        { idempotencyKey: `public-${companyId}-${invoice.id}-${total}` });

    const session = await q.insertSession(companyId, {
        invoice_id: invoice.id, job_id: invoice.job_id || null, contact_id: invoice.contact_id || null,
        surface: 'manual_card', amount: total, status: 'open',
        stripe_payment_intent_id: pi.id, stripe_account_id: account.stripe_account_id,
        metadata: { tip: tipAmount, public: true },
    }, client);
    if (recordActivity) {
        const actor = clientActor();
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.session_started',
            entity: session,
            actor,
            summary: { amount: total, currency: invoice.currency || 'USD' },
        }, { client });
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.card_session_started',
            entity: invoice,
            actor,
            summary: { amount: total, currency: invoice.currency || 'USD' },
        }, { client });
    }
    return { client_secret: pi.client_secret, account_id: account.stripe_account_id, amount: total, tip: tipAmount, balance_due: balance, currency: (invoice.currency || 'USD') };
}

// ---- webhook → ledger sync --------------------------------------------------

async function applyStripePayment(
    companyId,
    { externalId, invoiceId, contactId, jobId, amount, currency, metadata },
    client = null,
    activityActor = null
) {
    // Idempotency: a ledger row already exists for this external id?
    const existing = await paymentsQueries.findByExternalSourceId(
        companyId,
        'stripe',
        externalId,
        client
    );
    if (existing) return { tx: existing, deduped: true };
    let invoice = null;
    if (invoiceId) {
        invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
        if (!invoice) throw new StripePaymentsError('NOT_FOUND', 'Invoice not found', 404);
    }
    const resolvedContactId = invoice?.contact_id || contactId || null;
    const resolvedJobId = invoice?.job_id || jobId || null;
    if (resolvedJobId == null) {
        throw new StripePaymentsError(
            'JOB_REQUIRED',
            'A native payment must belong to a job',
            400
        );
    }
    if (resolvedContactId) {
        const contact = await estimatesQueries.getContactContext(
            companyId,
            resolvedContactId,
            client
        );
        if (!contact) throw new StripePaymentsError('NOT_FOUND', 'Contact not found', 404);
    }
    if (resolvedJobId) {
        const job = await estimatesQueries.getJobContext(companyId, resolvedJobId, client);
        if (!job) throw new StripePaymentsError('NOT_FOUND', 'Job not found', 404);
    }

    // Tip (from PaymentIntent/Checkout metadata) is part of the charge but is NOT
    // applied to the invoice balance — only the (amount - tip) portion settles the
    // invoice; the tip is recorded on the ledger row's metadata for reporting.
    const tip = Math.max(0, Number(metadata?.tip || 0) || 0);
    const balancePortion = Math.max(0, Number((amount - tip).toFixed(2)));

    let tx;
    try {
        // Low-level insert (does NOT auto-apply to the invoice) so we control the
        // balance vs tip split below.
        tx = await paymentsQueries.createTransaction(companyId, {
            transaction_type: 'payment',
            payment_method: 'credit_card',
            status: 'completed',
            amount,
            currency: (currency || 'USD').toUpperCase(),
            invoice_id: invoiceId || null,
            contact_id: resolvedContactId,
            job_id: resolvedJobId,
            external_id: externalId,
            external_source: 'stripe',
            metadata: { ...(metadata || {}), tip },
            processed_at: new Date().toISOString(),
        }, client);
    } catch (err) {
        // Unique-violation race → another delivery won; treat as deduped.
        if (err.code === '23505') {
            const row = await paymentsQueries.findByExternalSourceId(
                companyId,
                'stripe',
                externalId,
                client
            );
            return { tx: row, deduped: true };
        }
        throw err;
    }

    if (invoiceId) {
        invoice = await invoicesService.getInvoice(companyId, invoiceId, client);
        await invoicesQueries.createEvent(
            companyId,
            invoiceId,
            'payment_recorded',
            'system',
            null,
            {
                amount: balancePortion,
                tip,
                payment_method: 'credit_card',
                source: 'stripe',
                external_id: externalId,
            },
            client
        );
    }
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.succeeded',
            entity: tx,
            actor: activityActor,
            summary: {
                amount: Number(amount),
                currency: tx.currency,
                status: 'completed',
            },
        }, { client });
        if (invoiceId) {
            invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
            await logFinancialActivity({
                companyId,
                entityType: 'invoice',
                action: 'invoice.payment_succeeded',
                entity: invoice,
                actor: activityActor,
                summary: {
                    amount: balancePortion,
                    currency: tx.currency,
                    payment_id: tx.id,
                },
            }, { client });
        }
    }
    await emitPaymentDomainEvent(
        companyId,
        'payment.succeeded',
        tx,
        client,
        `payment.succeeded:stripe:${externalId}`
    );
    return { tx, deduped: false };
}

/** Idempotently project a failed Stripe intent into the tenant-owned ledger. */
async function applyStripePaymentFailure(
    companyId,
    { externalId, invoiceId, contactId, jobId, amount, currency },
    client = null,
    activityActor = null
) {
    const existing = await paymentsQueries.findByExternalSourceId(
        companyId,
        'stripe',
        externalId,
        client
    );
    if (existing) return { tx: existing, deduped: true };

    let invoice = null;
    if (invoiceId) {
        invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
        if (!invoice) throw new StripePaymentsError('NOT_FOUND', 'Invoice not found', 404);
    }
    if (contactId && !await estimatesQueries.getContactContext(companyId, contactId, client)) {
        throw new StripePaymentsError('NOT_FOUND', 'Contact not found', 404);
    }
    if (jobId && !await estimatesQueries.getJobContext(companyId, jobId, client)) {
        throw new StripePaymentsError('NOT_FOUND', 'Job not found', 404);
    }

    let tx;
    try {
        tx = await paymentsQueries.createTransaction(companyId, {
            transaction_type: 'payment',
            payment_method: 'credit_card',
            status: 'failed',
            amount: Number.isFinite(Number(amount)) ? Number(amount) : 0,
            currency: (currency || 'USD').toUpperCase(),
            invoice_id: invoiceId || null,
            contact_id: contactId || invoice?.contact_id || null,
            job_id: jobId || invoice?.job_id || null,
            external_id: externalId,
            external_source: 'stripe',
            metadata: { outcome: 'failed' },
            processed_at: new Date().toISOString(),
        }, client);
    } catch (error) {
        if (error.code === '23505') {
            const row = await paymentsQueries.findByExternalSourceId(
                companyId,
                'stripe',
                externalId,
                client
            );
            return { tx: row, deduped: true };
        }
        throw error;
    }

    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.failed',
            entity: tx,
            actor: activityActor,
            summary: { status: 'failed' },
        }, { client });
    }
    await emitPaymentDomainEvent(
        companyId,
        'payment.failed',
        tx,
        client,
        `payment.failed:stripe:${externalId}`
    );
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
                await withTransaction(async (client) => {
                    const session = await q.getSessionByCheckoutId(
                        companyId,
                        obj.id,
                        client
                    );
                    const meta = obj.metadata || {};
                    const invId = session?.invoice_id
                        || (meta.invoice_id ? Number(meta.invoice_id) : null);
                    const externalId = obj.payment_intent || obj.id;
                    const amount = obj.amount_total != null
                        ? obj.amount_total / 100
                        : session?.amount;
                    if (session) {
                        await q.updateSession(companyId, session.id, {
                            status: 'complete',
                            stripe_payment_intent_id: obj.payment_intent || null,
                        }, client);
                    }
                    await applyStripePayment(companyId, {
                        externalId,
                        invoiceId: invId,
                        contactId: session?.contact_id
                            || (meta.contact_id ? Number(meta.contact_id) : null),
                        jobId: session?.job_id
                            || (meta.job_id ? Number(meta.job_id) : null),
                        amount,
                        currency: obj.currency,
                        metadata: {
                            surface: meta.surface || 'checkout_link',
                            checkout_session_id: obj.id,
                            tip: meta.tip || 0,
                        },
                    }, client, stripeActor());
                });
                break;
            }
            case 'payment_intent.succeeded': {
                const obj = event.data;
                let successfulSession = null;
                await withTransaction(async (client) => {
                    const byIntent = await q.getSessionByPaymentIntent(
                        companyId,
                        obj.id,
                        client
                    );
                    const session = byIntent || (
                        obj.metadata?.checkout_session_id
                            ? await q.getSessionByCheckoutId(
                                companyId,
                                obj.metadata.checkout_session_id,
                                client
                            )
                            : null
                    );
                    successfulSession = session;
                    const meta = obj.metadata || {};
                    const invId = session?.invoice_id
                        || (meta.invoice_id ? Number(meta.invoice_id) : null);
                    const charge = obj.latest_charge || obj.id;
                    if (session) {
                        await q.updateSession(companyId, session.id, {
                            status: 'complete',
                            stripe_charge_id: typeof charge === 'string' ? charge : null,
                        }, client);
                    }
                    await applyStripePayment(companyId, {
                        externalId: obj.id,
                        invoiceId: invId,
                        contactId: session?.contact_id || null,
                        jobId: session?.job_id || null,
                        amount: obj.amount_received != null
                            ? obj.amount_received / 100
                            : obj.amount / 100,
                        currency: obj.currency,
                        metadata: {
                            surface: meta.surface || 'checkout_link',
                            payment_intent_id: obj.id,
                            tip: meta.tip || 0,
                        },
                    }, client, stripeActor());
                });
                if (successfulSession?.surface === 'manual_card') {
                    try {
                        await cacheSuccessfulManualCard(companyId, successfulSession, obj);
                    } catch (error) {
                        console.error('[StripePayments] webhook saved-card cache failed:', error.message);
                    }
                }
                break;
            }
            case 'payment_intent.payment_failed': {
                const obj = event.data;
                await withTransaction(async (client) => {
                    const session = await q.getSessionByPaymentIntent(
                        companyId,
                        obj.id,
                        client
                    );
                    const meta = obj.metadata || {};
                    const invoiceId = session?.invoice_id
                        || (meta.invoice_id ? Number(meta.invoice_id) : null);
                    const reason = obj.last_payment_error?.message || 'Payment failed';
                    if (session) {
                        await q.updateSession(companyId, session.id, {
                            status: 'failed',
                            failure_reason: reason,
                        }, client);
                    }
                    await applyStripePaymentFailure(companyId, {
                        externalId: obj.id,
                        invoiceId,
                        contactId: session?.contact_id
                            || (meta.contact_id ? Number(meta.contact_id) : null),
                        jobId: session?.job_id
                            || (meta.job_id ? Number(meta.job_id) : null),
                        amount: obj.amount != null ? obj.amount / 100 : session?.amount,
                        currency: obj.currency || session?.currency,
                    }, client, stripeActor());
                    if (invoiceId) {
                        const invoice = await invoicesQueries.getInvoiceById(
                            companyId,
                            invoiceId,
                            client
                        );
                        if (!invoice) {
                            throw new StripePaymentsError(
                                'NOT_FOUND',
                                'Invoice not found',
                                404
                            );
                        }
                        await logFinancialActivity({
                            companyId,
                            entityType: 'invoice',
                            action: 'invoice.payment_failed',
                            entity: invoice,
                            actor: stripeActor(),
                            summary: { status: 'failed' },
                        }, { client });
                    }
                });
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
                    await withTransaction(client => applyStripeRefund(
                        companyId,
                        {
                            refundId,
                            paymentIntentId: obj.payment_intent || null,
                            amount: refundAmount,
                            reason: latest?.reason,
                        },
                        client,
                        stripeActor()
                    ));
                }
                break;
            }
            case 'charge.dispute.created': {
                const obj = event.data;
                await withTransaction(async (client) => {
                    const meta = obj.metadata || {};
                    const original = obj.payment_intent
                        ? await paymentsQueries.findByExternalSourceId(
                            companyId,
                            'stripe',
                            obj.payment_intent,
                            client
                        )
                        : null;
                    if (original) {
                        await paymentsQueries.updateTransactionStatus(
                            original.id,
                            companyId,
                            'processing',
                            {},
                            client
                        );
                    }
                    await logFinancialActivity({
                        companyId,
                        entityType: 'payment',
                        action: 'payment.disputed',
                        entity: original || {
                            id: obj.id,
                            invoice_id: meta.invoice_id ? Number(meta.invoice_id) : null,
                            job_id: meta.job_id ? Number(meta.job_id) : null,
                            contact_id: meta.contact_id ? Number(meta.contact_id) : null,
                        },
                        actor: stripeActor(),
                        summary: {
                            amount: (obj.amount || 0) / 100,
                            status: 'disputed',
                        },
                    }, { client });
                    if (original) {
                        await emitPaymentDomainEvent(
                            companyId,
                            'payment.disputed',
                            original,
                            client,
                            `payment.disputed:stripe:${obj.id}`
                        );
                    } else if (meta.invoice_id) {
                        const invoice = await invoicesQueries.getInvoiceById(
                            companyId,
                            Number(meta.invoice_id),
                            client
                        );
                        if (invoice) {
                            await eventBus.emit(companyId, 'payment.disputed', {
                                invoice_id: invoice.id,
                                record_refs: [{ type: 'invoice', id: invoice.id }],
                            }, {
                                actorType: 'webhook',
                                aggregateType: 'invoice',
                                aggregateId: invoice.id,
                                idempotencyKey: `payment.disputed:stripe:${obj.id}`,
                                client,
                            });
                        }
                    }
                });
                break;
            }
            default:
                await q.markWebhookEvent(event.id, 'ignored');
                return { ok: true, ignored: true };
        }
        await q.markWebhookEvent(event.id, 'processed', { companyId });
        return { ok: true };
    } catch (err) {
        if (event.type === 'charge.refunded') {
            const paymentIntentId = event.data?.payment_intent || null;
            const original = paymentIntentId
                ? await paymentsQueries.findByExternalSourceId(
                    companyId,
                    'stripe',
                    paymentIntentId
                )
                : null;
            const metadata = event.data?.metadata || {};
            await logFinancialActivity({
                companyId,
                entityType: 'payment',
                action: 'refund.failed',
                entity: original || {
                    id: paymentIntentId || event.data?.id,
                    invoice_id: metadata.invoice_id
                        ? Number(metadata.invoice_id)
                        : null,
                    job_id: metadata.job_id ? Number(metadata.job_id) : null,
                    contact_id: metadata.contact_id
                        ? Number(metadata.contact_id)
                        : null,
                },
                actor: stripeActor(),
                summary: {
                    ...(original?.currency ? { currency: original.currency } : {}),
                },
            });
        }
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
    assertAdhocAmount,
    ensurePaymentLink,
    getPaymentLink,
    sendPaymentLink,
    ensureJobPaymentLink,
    getJobPaymentLink,
    sendJobPaymentLink,
    getPublicPayInfo,
    createPublicPaySession,
    createPublicPayIntent,
    applyStripePayment,
    createManualCardSession,
    confirmManualCardSession,
    finalizeManualCardSession,
    getManualCardSessionResult,
    listJobSavedCards,
    listContactSavedCards,
    removeContactSavedCard,
    chargeJobSavedCard,
    sendManualCardReceipt,
    getConnectionToken,
    createTapToPayIntent,
    cancelTerminalIntent,
    applyStripeRefund,
    refundStripePayment,
    handleWebhook,
};
