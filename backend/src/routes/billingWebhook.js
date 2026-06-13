/**
 * Billing webhook — ADR-001 §2.4. Provider → local subscription/invoice sync.
 *
 * Mounted in src/server.js BEFORE express.json with express.raw, so the exact
 * bytes survive for HMAC signature verification. NO auth: the Stripe-Signature
 * header is the authentication. Always answers 2xx for handled events so the
 * provider stops retrying; 400 only on a bad/absent signature.
 */

const express = require('express');
const router = express.Router();
const billingService = require('../services/billingService');

router.post('/', async (req, res) => {
    const signature = req.headers['stripe-signature'];
    // req.body is a Buffer here (express.raw). Pass the raw string to the verifier.
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    try {
        const result = await billingService.handleProviderWebhook(rawBody, signature);
        res.json(result);
    } catch (err) {
        // Bad signature → 400 (provider will not retry a malformed event).
        res.status(err.httpStatus || 400).json({ ok: false, error: err.message });
    }
});

module.exports = router;
