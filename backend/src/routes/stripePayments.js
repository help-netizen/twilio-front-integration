/**
 * stripePayments.js — F018 settings & onboarding API (tenant customer payments).
 *
 * Mounted in src/server.js with:
 *   app.use('/api/stripe-payments', authenticate,
 *           requirePermission('tenant.integrations.manage'), requireCompanyAccess, router)
 * company_id ← req.companyFilter.company_id; all data scoped per company.
 */
const express = require('express');
const router = express.Router();
const stripePaymentsService = require('../services/stripePaymentsService');
const companyQueries = require('../db/companyQueries');

function companyId(req) {
    return req.companyFilter?.company_id;
}

function actor(req) {
    // created_by / audit FKs reference crm_users(id). The Keycloak `sub` is ALSO a
    // UUID but is NOT a crm_users.id, so falling back to it poisoned the value and
    // tripped stripe_payment_sessions_created_by_fkey. Use crmUser.id or NULL (the
    // column is nullable) — never `sub`.
    const id = req.user?.crmUser?.id || null;
    return { id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || '') ? id : null };
}

function humanize(err) {
    if (err.stripeCode || err.httpStatus) return `Stripe: ${err.message}`;
    return err.message;
}

function handleError(err, req, res) {
    if (err instanceof stripePaymentsService.StripePaymentsError) {
        return res.status(err.httpStatus || 400).json({ success: false, code: err.code, message: err.message, request_id: req.requestId });
    }
    console.error(`[StripePayments] ${req.path} error:`, {
        message: err.message,
        stripeCode: err.stripeCode,
        httpStatus: err.httpStatus,
        stack: err.stack,
    });
    return res.status(err.httpStatus || 500).json({
        success: false,
        code: err.stripeCode || err.code || 'STRIPE_CONNECT_FAILED',
        message: humanize(err),
        request_id: req.requestId,
    });
}

router.get('/status', async (req, res) => {
    try {
        res.json({ success: true, status: await stripePaymentsService.getStatus(companyId(req)), request_id: req.requestId });
    } catch (err) { handleError(err, req, res); }
});

router.post('/connect', async (req, res) => {
    try {
        const company = await companyQueries.getCompanyById(companyId(req));
        const result = await stripePaymentsService.connect(companyId(req), actor(req), company || {});
        res.json({ success: true, ...result, request_id: req.requestId });
    } catch (err) { handleError(err, req, res); }
});

router.post('/onboarding-link', async (req, res) => {
    try {
        res.json({ success: true, ...(await stripePaymentsService.getOnboardingLink(companyId(req))), request_id: req.requestId });
    } catch (err) { handleError(err, req, res); }
});

router.post('/refresh-status', async (req, res) => {
    try {
        res.json({ success: true, status: await stripePaymentsService.refreshStatus(companyId(req)), request_id: req.requestId });
    } catch (err) { handleError(err, req, res); }
});

router.post('/disconnect', async (req, res) => {
    try {
        res.json({ success: true, ...(await stripePaymentsService.disconnect(companyId(req), actor(req))), request_id: req.requestId });
    } catch (err) { handleError(err, req, res); }
});

module.exports = router;
