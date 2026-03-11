/**
 * Phone Numbers API (Telephony Admin)
 *
 * GET /api/phone-numbers — List all phone numbers with group assignment and status
 *
 * This is separate from /api/phone-settings (which manages routing_mode).
 * This route returns the shape expected by the Telephony Admin Phone Numbers page.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');

router.get('/', async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        // Fetch from phone_number_settings (synced with Twilio)
        // LEFT JOIN user_group_numbers to find group assignment
        const result = await db.query(`
            SELECT
                pns.id::text,
                pns.phone_number AS number,
                pns.friendly_name,
                'Twilio' AS provider,
                CASE WHEN pns.routing_mode IS NOT NULL THEN 'active' ELSE 'inactive' END AS status,
                ug.name AS "group",
                CASE WHEN pns.routing_mode IS NOT NULL THEN true ELSE false END AS webhook_configured,
                NULL AS last_call_at
            FROM phone_number_settings pns
            LEFT JOIN user_group_numbers ugn ON ugn.phone_number = pns.phone_number
            LEFT JOIN user_groups ug ON ug.id = ugn.group_id
            ORDER BY pns.phone_number
        `);

        res.json({ ok: true, data: result.rows });
    } catch (err) {
        console.error('[PhoneNumbers] GET error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch phone numbers' });
    }
});

module.exports = router;
