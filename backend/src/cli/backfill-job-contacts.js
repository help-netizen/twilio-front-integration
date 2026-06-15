/**
 * Backfill contact_id on jobs table.
 * Works from both project dir (local) and /tmp (prod via fly ssh).
 */
try { require('dotenv').config(); } catch { }

// Try loading db connection from different paths
let db;
try { db = require('/app/backend/src/db/connection'); } catch {
    try { db = require('./src/db/connection'); } catch {
        db = require('../db/connection');
    }
}

(async () => {
    const { rows: [ref] } = await db.query('SELECT company_id FROM contacts WHERE company_id IS NOT NULL LIMIT 1');
    const companyId = ref.company_id;
    console.log('company_id:', companyId);

    // Step 1: Link by zenbooker_customer_id
    const { rows: zbLinked } = await db.query(`
        UPDATE jobs j
        SET contact_id = c.id
        FROM contacts c
        WHERE j.contact_id IS NULL
          AND j.zb_raw IS NOT NULL
          AND c.zenbooker_customer_id = j.zb_raw->'customer'->>'id'
        RETURNING j.id
    `);
    console.log('Step 1 - Linked by zb_customer_id:', zbLinked.length);

    // Step 2: Get remaining unlinked jobs
    const { rows: unlinked } = await db.query(`
        SELECT DISTINCT 
            j.zb_raw->'customer'->>'id' as zb_cust_id,
            j.zb_raw->'customer'->>'name' as cust_name,
            j.zb_raw->'customer'->>'phone' as cust_phone,
            j.zb_raw->'customer'->>'email' as cust_email
        FROM jobs j
        WHERE j.contact_id IS NULL
          AND j.zb_raw->'customer'->>'id' IS NOT NULL
    `);
    console.log('Remaining unlinked distinct customers:', unlinked.length);

    let byPhone = 0, byEmail = 0, created = 0, failed = 0;

    for (const u of unlinked) {
        const rawPhone = u.cust_phone || '';
        const digits = rawPhone.replace(/\D/g, '');
        const last10 = digits.length >= 10 ? digits.slice(-10) : null;
        const e164 = last10 ? '+1' + last10 : null;

        let contactId = null;

        // Try match by phone
        if (e164) {
            const { rows } = await db.query('SELECT id FROM contacts WHERE phone_e164 = $1', [e164]);
            if (rows.length > 0) {
                contactId = rows[0].id;
                byPhone++;
            }
        }

        // Try match by email
        if (!contactId && u.cust_email) {
            const { rows } = await db.query('SELECT id FROM contacts WHERE email = $1', [u.cust_email.toLowerCase()]);
            if (rows.length > 0) {
                contactId = rows[0].id;
                byEmail++;
            }
        }

        // Create new contact if no match
        if (!contactId) {
            const parts = (u.cust_name || '').trim().split(/\s+/);
            const first = parts[0] || null;
            const last = parts.slice(1).join(' ') || null;
            try {
                const { rows: [newC] } = await db.query(`
                    INSERT INTO contacts (first_name, last_name, full_name, phone_e164, email, zenbooker_customer_id, zenbooker_sync_status, company_id)
                    VALUES ($1, $2, $3, $4, $5, $6, 'linked', $7)
                    RETURNING id
                `, [first, last, u.cust_name, e164, u.cust_email, u.zb_cust_id, companyId]);
                contactId = newC.id;
                created++;
            } catch (e) {
                console.log('  Skip:', u.cust_name, '-', e.message.slice(0, 80));
                failed++;
                continue;
            }
        }

        // Update zenbooker_customer_id on the contact
        await db.query(
            'UPDATE contacts SET zenbooker_customer_id = $1 WHERE id = $2 AND zenbooker_customer_id IS NULL',
            [u.zb_cust_id, contactId]
        );

        // Link all jobs for this customer
        await db.query(
            `UPDATE jobs SET contact_id = $1 WHERE contact_id IS NULL AND zb_raw->'customer'->>'id' = $2`,
            [contactId, u.zb_cust_id]
        );
    }

    console.log('\nResults:');
    console.log('  By phone:', byPhone);
    console.log('  By email:', byEmail);
    console.log('  Created:', created);
    console.log('  Failed:', failed);

    const { rows: [stats] } = await db.query('SELECT COUNT(*) as total, COUNT(contact_id) as with_contact FROM jobs');
    console.log('\nJobs stats:', stats);
    process.exit(0);
})();
