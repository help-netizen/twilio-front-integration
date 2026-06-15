/**
 * Public (un-authenticated) invoice routes. The URL's opaque token is the
 * credential — anyone holding it can fetch the PDF. Used for invoice "send"
 * flows where the customer receives a tokenized link via email or SMS.
 */
const express = require('express');
const router = express.Router();
const invoicesService = require('../services/invoicesService');

// GET /api/public/invoices/:token/pdf — Render the PDF resolved by its public token.
router.get('/invoices/:token/pdf', async (req, res) => {
    try {
        const { token } = req.params;
        const { invoice, buffer } = await invoicesService.generatePdfByPublicToken(token);
        const safeNumber = String(invoice.invoice_number || `invoice-${invoice.id}`).replace(/[^a-z0-9_-]+/gi, '_');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', buffer.length);
        // Cache-control: public token is opaque, but content can change as the invoice does.
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        res.setHeader('Content-Disposition', `inline; filename="${safeNumber}.pdf"`);
        res.send(buffer);
    } catch (err) {
        console.error('[Public/Invoices] GET /:token/pdf error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;
const stripePaymentsService = require('../services/stripePaymentsService');

// GET /api/public/invoices/:token/pay-info — opaque summary + balance for Pay now.
router.get('/invoices/:token/pay-info', async (req, res) => {
    try {
        const { token } = req.params;
        if (!TOKEN_RE.test(token)) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Invalid link' } });
        const info = await stripePaymentsService.getPublicPayInfo(token);
        res.json({ ok: true, data: info });
    } catch (err) {
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/public/invoices/:token/pay — create/reuse Checkout session, return url.
router.post('/invoices/:token/pay', async (req, res) => {
    try {
        const { token } = req.params;
        if (!TOKEN_RE.test(token)) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Invalid link' } });
        const { url } = await stripePaymentsService.createPublicPaySession(token);
        res.json({ ok: true, data: { url } });
    } catch (err) {
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

/**
 * Short alias router (mounted at root): GET /i/:token → 302 to the full PDF URL.
 * Keeps customer-facing links short for SMS / pasted messages.
 */
const shortRouter = express.Router();
shortRouter.get('/i/:token', (req, res) => {
    const { token } = req.params;
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(token)) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Invalid link' } });
    }
    res.redirect(302, `/api/public/invoices/${token}/pdf`);
});

router.shortRouter = shortRouter;
module.exports = router;
