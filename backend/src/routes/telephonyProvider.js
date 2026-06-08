/**
 * Telephony Provider API
 *
 * GET /api/telephony/provider — Returns configured voice provider metadata.
 *
 * F017 keeps the local phone_number_settings table as the source of truth for
 * managed numbers and group routing. This endpoint intentionally does not pull
 * or upsert Twilio numbers on read.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');

function getCompanyId(req) {
    return req.companyFilter?.company_id || req.user?.company_id;
}

function maskAccountSid(accountSid) {
    if (!accountSid) return null;
    if (accountSid.length <= 8) return 'configured';
    return `${accountSid.slice(0, 2)}${'*'.repeat(Math.max(4, accountSid.length - 6))}${accountSid.slice(-4)}`;
}

router.get('/', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
        const authToken = process.env.TWILIO_AUTH_TOKEN || '';
        const numbers = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM phone_number_settings
             WHERE company_id = $1`,
            [companyId]
        );

        res.json({
            ok: true,
            data: {
                name: 'Twilio',
                status: accountSid && authToken ? 'connected' : 'error',
                account_sid: maskAccountSid(accountSid),
                numbers_count: numbers.rows[0]?.count || 0,
                inventory_source: 'phone_number_settings',
                error_log: accountSid && authToken ? [] : ['Twilio credentials are not configured'],
            },
        });
    } catch (err) {
        console.error('[TelephonyProvider] GET error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch telephony provider status' });
    }
});

module.exports = router;
