#!/usr/bin/env node
/**
 * Recreate all contacts from leads (any status).
 * Deletes all existing contacts first, then creates new ones from leads.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const db = require('../db/connection');

async function run() {
    // Get default company_id
    const { rows: co } = await db.query(
        'SELECT DISTINCT company_id FROM leads WHERE company_id IS NOT NULL LIMIT 1'
    );
    const companyId = co.length > 0 ? co[0].company_id : null;
    console.log('Using company_id:', companyId);

    // 1. Clear contact_id from leads
    const { rowCount: unlinked } = await db.query('UPDATE leads SET contact_id = NULL WHERE contact_id IS NOT NULL');
    console.log('Unlinked', unlinked, 'leads');

    // 2. Clear contact_id from calls (FK constraint)
    const { rowCount: unlinkedCalls } = await db.query('UPDATE calls SET contact_id = NULL WHERE contact_id IS NOT NULL');
    console.log('Unlinked', unlinkedCalls, 'calls');

    // 3. Clear contact_id from sms_conversations if exists
    try {
        const { rowCount: unlinkedSms } = await db.query('UPDATE sms_conversations SET contact_id = NULL WHERE contact_id IS NOT NULL');
        console.log('Unlinked', unlinkedSms, 'sms_conversations');
    } catch { /* table may not have contact_id */ }

    // 4. Delete all contacts
    const { rowCount: deleted } = await db.query('DELETE FROM contacts');
    console.log('Deleted', deleted, 'contacts');

    // 5. Create contacts from leads (one per unique phone, taking newest lead's data)
    const { rows: leads } = await db.query(`
        SELECT DISTINCT ON (l.phone) l.phone, l.first_name, l.last_name, l.email, l.company_id
        FROM leads l
        WHERE l.phone IS NOT NULL AND l.phone != ''
        ORDER BY l.phone, l.created_at DESC
    `);
    console.log('Unique lead phones:', leads.length);

    let created = 0;
    for (const l of leads) {
        const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || null;
        const cid = l.company_id || companyId;
        try {
            await db.query(
                `INSERT INTO contacts (full_name, phone_e164, email, company_id)
                 VALUES ($1, $2, $3, $4)`,
                [name, l.phone, l.email, cid]
            );
            created++;
        } catch (e) {
            console.log('Skip', l.phone, '-', e.message.substring(0, 80));
        }
    }
    console.log('Created', created, 'contacts');

    // 6. Link all leads to their contacts by phone
    const { rowCount: linked } = await db.query(`
        UPDATE leads l SET contact_id = c.id
        FROM contacts c
        WHERE l.phone IS NOT NULL AND c.phone_e164 IS NOT NULL
          AND l.phone = c.phone_e164
    `);
    console.log('Linked', linked, 'leads to contacts');

    // 7. Re-link calls to contacts by phone
    const { rowCount: linkedCalls } = await db.query(`
        UPDATE calls cl SET contact_id = c.id
        FROM contacts c
        WHERE cl.contact_id IS NULL
          AND c.phone_e164 IS NOT NULL
          AND (cl.from_number = c.phone_e164 OR cl.to_number = c.phone_e164)
    `);
    console.log('Re-linked', linkedCalls, 'calls to contacts');

    // Stats
    const { rows: stats } = await db.query('SELECT count(*) as total FROM contacts');
    const { rows: lStats } = await db.query('SELECT count(*) as total FROM leads');
    const { rows: lLinked } = await db.query('SELECT count(*) as n FROM leads WHERE contact_id IS NOT NULL');
    console.log(`Contacts: ${stats[0].total} | Leads: ${lStats[0].total} | Linked: ${lLinked[0].n}`);

    await db.pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
