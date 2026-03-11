/**
 * Telephony Overview API
 *
 * GET /api/telephony/overview — Returns counts for the Route Manager Overview page
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');

router.get('/', async (req, res) => {
    try {
        const companyId = req.user?.company_id;
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        const [groups, numbers, flows] = await Promise.all([
            db.query(`SELECT COUNT(*)::int AS count FROM user_groups WHERE company_id = $1`, [companyId]),
            db.query(`SELECT COUNT(*)::int AS count FROM phone_number_settings`),
            db.query(`SELECT COUNT(*)::int AS count FROM call_flows WHERE company_id = $1`, [companyId]),
        ]);

        res.json({
            ok: true,
            data: {
                user_groups_count: groups.rows[0].count,
                phone_numbers_count: numbers.rows[0].count,
                call_flows_count: flows.rows[0].count,
            },
        });
    } catch (err) {
        console.error('[TelephonyOverview] GET error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch overview' });
    }
});

module.exports = router;
