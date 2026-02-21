const axios = require('axios');
const { Pool } = require('pg');

const ZENBOOKER_API_KEY = process.env.ZENBOOKER_API_KEY;
const ZENBOOKER_API_BASE_URL = process.env.ZENBOOKER_API_BASE_URL || 'https://api.zenbooker.com/v1';
const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

if (!ZENBOOKER_API_KEY) { console.error('ZENBOOKER_API_KEY not set'); process.exit(1); }
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL });
const client = axios.create({
    baseURL: ZENBOOKER_API_BASE_URL,
    headers: { 'Authorization': `Bearer ${ZENBOOKER_API_KEY}` },
    timeout: 30000,
});

(async () => {
    let cursor = 0;
    const limit = 100;
    let totalFetched = 0;
    let linked = 0, created = 0, skipped = 0, errors = 0;

    while (true) {
        console.log(`Fetching page at cursor=${cursor}...`);
        let res;
        try {
            res = await client.get('/customers', { params: { limit, cursor } });
        } catch (err) {
            console.error('API error:', err.response?.status, err.response?.data || err.message);
            break;
        }

        const results = res.data.results || [];
        const hasMore = res.data.has_more;
        totalFetched += results.length;
        console.log(`  Got ${results.length} customers (total: ${totalFetched}), has_more: ${hasMore}`);

        if (results.length === 0) break;

        for (const cust of results) {
            try {
                const zbId = cust.id;
                const name = cust.name || '';
                const phone = cust.phone || '';
                const email = cust.email || '';

                const { rows: existing } = await pool.query(
                    'SELECT id FROM contacts WHERE zenbooker_customer_id = $1', [zbId]
                );
                if (existing.length > 0) {
                    await pool.query(
                        `UPDATE contacts SET zenbooker_data = COALESCE(zenbooker_data, '{}'::jsonb) || jsonb_build_object('id', $1::text) WHERE id = $2`,
                        [zbId, existing[0].id]
                    );
                    skipped++;
                    continue;
                }

                let contactId = null;
                if (phone) {
                    const digits = phone.replace(/\D/g, '');
                    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
                    if (last10) {
                        const { rows: m } = await pool.query(
                            `SELECT id FROM contacts WHERE RIGHT(REGEXP_REPLACE(phone_e164, '[^0-9]', '', 'g'), 10) = $1 AND company_id = $2 LIMIT 1`,
                            [last10, DEFAULT_COMPANY_ID]
                        );
                        if (m.length > 0) contactId = m[0].id;
                    }
                }
                if (!contactId && email) {
                    const { rows: m } = await pool.query(
                        'SELECT id FROM contacts WHERE LOWER(email) = LOWER($1) AND company_id = $2 LIMIT 1',
                        [email, DEFAULT_COMPANY_ID]
                    );
                    if (m.length > 0) contactId = m[0].id;
                }

                if (contactId) {
                    await pool.query(
                        `UPDATE contacts SET zenbooker_customer_id = $1, zenbooker_data = COALESCE(zenbooker_data, '{}'::jsonb) || jsonb_build_object('id', $1::text), zenbooker_sync_status = 'linked', zenbooker_synced_at = NOW() WHERE id = $2`,
                        [zbId, contactId]
                    );
                    linked++;
                    console.log('  Linked:', name, '->', contactId);
                } else {
                    const parts = name.trim().split(/\s+/);
                    const firstName = parts[0] || '';
                    const lastName = parts.slice(1).join(' ') || '';
                    let phoneE164 = null;
                    if (phone) {
                        const d = phone.replace(/\D/g, '');
                        if (phone.startsWith('+')) phoneE164 = phone;
                        else if (d.length === 10) phoneE164 = '+1' + d;
                        else if (d.length > 0) phoneE164 = '+' + d;
                    }
                    const { rows: nc } = await pool.query(
                        `INSERT INTO contacts (first_name, last_name, full_name, phone_e164, email, company_id, zenbooker_customer_id, zenbooker_data, zenbooker_sync_status, zenbooker_synced_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, jsonb_build_object('id', $7::text), 'linked', NOW()) RETURNING id`,
                        [firstName, lastName, name, phoneE164, email || null, DEFAULT_COMPANY_ID, zbId]
                    );
                    created++;
                    console.log('  Created:', name, '->', nc[0].id);
                }
            } catch (err) {
                errors++;
                console.error('  Error:', cust.name, ':', err.message);
            }
        }

        if (!hasMore) break;
        cursor += results.length;
    }

    console.log('\n=== IMPORT COMPLETE ===');
    console.log('Total:', totalFetched, '| Linked:', linked, '| Created:', created, '| Skipped:', skipped, '| Errors:', errors);
    await pool.end();
    process.exit(0);
})();
