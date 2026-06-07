/**
 * Phone Number Settings API
 *
 * GET  /api/phone-settings        — List all registered phone numbers with routing config
 * PUT  /api/phone-settings/:id    — Update routing mode for a phone number
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const { getTwilioClient } = require('../services/twilioClient');

// ─── Ensure table exists (auto-migration) ────────────────────────────────────
const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS phone_number_settings (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID REFERENCES companies(id),
    phone_number    TEXT NOT NULL UNIQUE,
    friendly_name   TEXT,
    routing_mode    VARCHAR(20) NOT NULL DEFAULT 'sip',   -- 'sip' = Bria, 'client' = Blanc SoftPhone
    client_identity TEXT,                                  -- Twilio Client identity when routing_mode='client'
    group_id        TEXT REFERENCES user_groups(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER IF NOT EXISTS trg_phone_settings_updated_at
    BEFORE UPDATE ON phone_number_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

let tableEnsured = false;
async function ensureTable() {
    if (tableEnsured) return;
    try {
        // Split into two statements since CREATE TRIGGER IF NOT EXISTS may not be supported
        await db.query(`
            CREATE TABLE IF NOT EXISTS phone_number_settings (
                id              BIGSERIAL PRIMARY KEY,
                company_id      UUID REFERENCES companies(id),
                phone_number    TEXT NOT NULL UNIQUE,
                friendly_name   TEXT,
                routing_mode    VARCHAR(20) NOT NULL DEFAULT 'sip',
                client_identity TEXT,
                group_id        TEXT REFERENCES user_groups(id) ON DELETE SET NULL,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await db.query(`ALTER TABLE phone_number_settings ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id)`);
        await db.query(`ALTER TABLE phone_number_settings ADD COLUMN IF NOT EXISTS group_id TEXT REFERENCES user_groups(id) ON DELETE SET NULL`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_phone_number_settings_company ON phone_number_settings(company_id)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_phone_number_settings_group ON phone_number_settings(group_id)`);
        // Try to create trigger, ignore if already exists
        await db.query(`
            DO $$ BEGIN
                CREATE TRIGGER trg_phone_settings_updated_at
                    BEFORE UPDATE ON phone_number_settings
                    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        `);
        tableEnsured = true;
    } catch (err) {
        console.error('[PhoneSettings] Failed to ensure table:', err.message);
    }
}

function getCompanyId(req) {
    return req.companyFilter?.company_id;
}

/**
 * GET /api/phone-settings
 * Returns all phone numbers with their routing config.
 * Also syncs with Twilio account's phone numbers.
 */
router.get('/', async (req, res) => {
    try {
        await ensureTable();
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        // Fetch from Twilio API to get current phone numbers
        const twilioClient = getTwilioClient();

        let twilioNumbers = [];
        try {
            const numbers = await twilioClient.incomingPhoneNumbers.list({ limit: 50 });
            twilioNumbers = numbers.map(n => ({
                phone_number: n.phoneNumber,
                friendly_name: n.friendlyName,
                sid: n.sid,
            }));
        } catch (twilioErr) {
            console.error('[PhoneSettings] Twilio API error:', twilioErr.message);
        }

        // Upsert all Twilio numbers into our settings table
        for (const num of twilioNumbers) {
            await db.query(`
                INSERT INTO phone_number_settings (company_id, phone_number, friendly_name)
                VALUES ($1, $2, $3)
                ON CONFLICT (phone_number) DO UPDATE
                SET friendly_name = EXCLUDED.friendly_name,
                    company_id = COALESCE(phone_number_settings.company_id, EXCLUDED.company_id)
            `, [companyId, num.phone_number, num.friendly_name]);
        }

        // Fetch all settings
        const result = await db.query(`
            SELECT id, company_id, phone_number, friendly_name, routing_mode, client_identity, group_id,
                   created_at, updated_at
            FROM phone_number_settings
            WHERE company_id = $1
            ORDER BY phone_number
        `, [companyId]);

        res.json({
            ok: true,
            data: result.rows,
        });
    } catch (err) {
        console.error('[PhoneSettings] GET error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch phone settings' });
    }
});

/**
 * PUT /api/phone-settings/:id
 * Update routing_mode and client_identity for a phone number.
 */
router.put('/:id', async (req, res) => {
    try {
        await ensureTable();
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(401).json({ ok: false, error: 'No company context' });

        const { id } = req.params;
        const { routing_mode, client_identity } = req.body;

        if (!routing_mode || !['sip', 'client'].includes(routing_mode)) {
            return res.status(400).json({ ok: false, error: 'routing_mode must be "sip" or "client"' });
        }

        const result = await db.query(`
            UPDATE phone_number_settings
            SET routing_mode = $1, client_identity = $2
            WHERE id = $3 AND company_id = $4
            RETURNING *
        `, [routing_mode, client_identity || null, id, companyId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Phone number not found' });
        }

        console.log('[PhoneSettings] Updated:', {
            phone: result.rows[0].phone_number,
            routing_mode,
            client_identity,
        });

        res.json({
            ok: true,
            data: result.rows[0],
        });
    } catch (err) {
        console.error('[PhoneSettings] PUT error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to update phone settings' });
    }
});

module.exports = router;
