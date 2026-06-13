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
const { getTwilioClient } = require('../services/twilioClient');

function getCompanyId(req) {
    return req.companyFilter?.company_id;
}

function getBaseUrl() {
    return process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://api.albusto.com';
}

async function syncTwilioVoiceWebhook(phoneNumber) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
        console.warn('[PhoneNumbers] Twilio env missing, skipped webhook sync for', phoneNumber);
        return;
    }

    const twilioClient = getTwilioClient();
    const matches = await twilioClient.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
    const number = matches[0];
    if (!number?.sid) {
        console.warn('[PhoneNumbers] Twilio number not found for webhook sync:', phoneNumber);
        return;
    }

    await twilioClient.incomingPhoneNumbers(number.sid).update({
        voiceUrl: `${getBaseUrl()}/webhooks/twilio/voice-inbound`,
        voiceMethod: 'POST',
        statusCallback: `${getBaseUrl()}/webhooks/twilio/voice-status`,
        statusCallbackMethod: 'POST',
    });
}

router.get('/', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        // Fetch from phone_number_settings (synced with Twilio)
        // F017: phone_number_settings.group_id is the authoritative assignment.
        const result = await db.query(`
            SELECT
                pns.id::text,
                pns.phone_number AS number,
                pns.friendly_name,
                'Twilio' AS provider,
                CASE WHEN pns.routing_mode IS NOT NULL THEN 'active' ELSE 'inactive' END AS status,
                pns.group_id,
                ug.name AS "group",
                CASE WHEN pns.routing_mode IS NOT NULL THEN true ELSE false END AS webhook_configured,
                NULL AS last_call_at
            FROM phone_number_settings pns
            LEFT JOIN user_groups ug ON ug.id = pns.group_id AND ug.company_id = pns.company_id::text
            WHERE pns.company_id = $1
            ORDER BY pns.phone_number
        `, [companyId]);

        res.json({ ok: true, data: result.rows });
    } catch (err) {
        console.error('[PhoneNumbers] GET error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch phone numbers' });
    }
});

router.put('/:id/group', async (req, res) => {
    const client = await db.pool.connect();
    try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        const { id } = req.params;
        const { group_id = null, force = false } = req.body || {};

        await client.query('BEGIN');

        const numberRes = await client.query(
            `SELECT id, phone_number, friendly_name, group_id
             FROM phone_number_settings
             WHERE id = $1 AND company_id = $2
             FOR UPDATE`,
            [id, companyId]
        );
        const number = numberRes.rows[0];
        if (!number) {
            await client.query('ROLLBACK');
            return res.status(404).json({ ok: false, error: 'Phone number not found' });
        }

        if (group_id !== null) {
            const groupRes = await client.query(
                `SELECT id, name FROM user_groups WHERE id = $1 AND company_id = $2`,
                [group_id, companyId]
            );
            if (groupRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ ok: false, error: 'Group not found' });
            }

            if (number.group_id && number.group_id !== group_id && !force) {
                const current = await client.query(
                    `SELECT name FROM user_groups WHERE id = $1 AND company_id = $2`,
                    [number.group_id, companyId]
                );
                await client.query('ROLLBACK');
                return res.status(409).json({
                    ok: false,
                    error: 'PHONE_NUMBER_ALREADY_ASSIGNED',
                    current_group_id: number.group_id,
                    current_group_name: current.rows[0]?.name || 'another group',
                    message: `This number is already assigned to ${current.rows[0]?.name || 'another group'}. Move it?`,
                });
            }

            await client.query(
                `DELETE FROM user_group_numbers ugn
                 USING user_groups ug
                 WHERE ugn.group_id = ug.id
                   AND ug.company_id = $2
                   AND ugn.phone_number = $1`,
                [number.phone_number, companyId]
            );
            await client.query(
                `INSERT INTO user_group_numbers (group_id, phone_number, friendly_name)
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [group_id, number.phone_number, number.friendly_name || '']
            );
            await client.query(
                `UPDATE phone_number_settings
                 SET group_id = $1, routing_mode = 'client'
                 WHERE id = $2 AND company_id = $3`,
                [group_id, id, companyId]
            );

            await syncTwilioVoiceWebhook(number.phone_number);
        } else {
            await client.query(
                `DELETE FROM user_group_numbers ugn
                 USING user_groups ug
                 WHERE ugn.group_id = ug.id
                   AND ug.company_id = $2
                   AND ugn.phone_number = $1`,
                [number.phone_number, companyId]
            );
            await client.query(
                `UPDATE phone_number_settings
                 SET group_id = NULL,
                     routing_mode = CASE WHEN routing_mode = 'client' THEN 'sip' ELSE routing_mode END
                 WHERE id = $1 AND company_id = $2`,
                [id, companyId]
            );
        }

        await client.query('COMMIT');

        const updated = await db.query(
            `SELECT
                 pns.id::text,
                 pns.phone_number AS number,
                 pns.friendly_name,
                 'Twilio' AS provider,
                 CASE WHEN pns.routing_mode IS NOT NULL THEN 'active' ELSE 'inactive' END AS status,
                 pns.group_id,
                 ug.name AS "group",
                 CASE WHEN pns.routing_mode IS NOT NULL THEN true ELSE false END AS webhook_configured,
                 NULL AS last_call_at
             FROM phone_number_settings pns
             LEFT JOIN user_groups ug ON ug.id = pns.group_id AND ug.company_id = pns.company_id::text
             WHERE pns.id = $1 AND pns.company_id = $2`,
            [id, companyId]
        );

        res.json({ ok: true, data: updated.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[PhoneNumbers] PUT /:id/group error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to update phone number group' });
    } finally {
        client.release();
    }
});

module.exports = router;
