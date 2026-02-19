#!/usr/bin/env node
/**
 * Recreate all contacts from leads (any status).
 * Deletes all existing contacts first, then creates new ones from leads.
 * Also backfills contact_addresses from lead addresses and links them.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const db = require('../db/connection');
const crypto = require('crypto');

function addressHash(street, city, state, zip) {
    const raw = [street, city, state, zip]
        .map(s => (s || '').trim().toLowerCase())
        .join('|');
    return crypto.createHash('md5').update(raw).digest('hex');
}

async function run() {
    const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

    // Get default company_id
    const { rows: co } = await db.query(
        'SELECT DISTINCT company_id FROM leads WHERE company_id IS NOT NULL LIMIT 1'
    );
    const companyId = co.length > 0 ? co[0].company_id : DEFAULT_COMPANY_ID;
    console.log('Using company_id:', companyId);

    // 1. Clear contact_address_id from leads
    await db.query('UPDATE leads SET contact_address_id = NULL WHERE contact_address_id IS NOT NULL');

    // 2. Clear contact_id from leads
    const { rowCount: unlinked } = await db.query('UPDATE leads SET contact_id = NULL WHERE contact_id IS NOT NULL');
    console.log('Unlinked', unlinked, 'leads');

    // 3. Clear contact_id from calls (FK constraint)
    const { rowCount: unlinkedCalls } = await db.query('UPDATE calls SET contact_id = NULL WHERE contact_id IS NOT NULL');
    console.log('Unlinked', unlinkedCalls, 'calls');

    // 4. Clear contact_id from sms_conversations if exists
    try {
        const { rowCount: unlinkedSms } = await db.query('UPDATE sms_conversations SET contact_id = NULL WHERE contact_id IS NOT NULL');
        console.log('Unlinked', unlinkedSms, 'sms_conversations');
    } catch { /* table may not have contact_id */ }

    // 5. Delete all contact_addresses (cascade from contacts anyway, but be explicit)
    const { rowCount: deletedAddr } = await db.query('DELETE FROM contact_addresses');
    console.log('Deleted', deletedAddr, 'contact_addresses');

    // 6. Delete all contacts
    const { rowCount: deleted } = await db.query('DELETE FROM contacts');
    console.log('Deleted', deleted, 'contacts');

    // 7. Create contacts from leads (one per unique phone, taking newest lead's data)
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
                `INSERT INTO contacts (full_name, first_name, last_name, phone_e164, email, company_id)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [name, l.first_name || null, l.last_name || null, l.phone, l.email, cid]
            );
            created++;
        } catch (e) {
            console.log('Skip', l.phone, '-', e.message.substring(0, 80));
        }
    }
    console.log('Created', created, 'contacts');

    // 8. Link all leads to their contacts by phone
    const { rowCount: linked } = await db.query(`
        UPDATE leads l SET contact_id = c.id
        FROM contacts c
        WHERE l.phone IS NOT NULL AND c.phone_e164 IS NOT NULL
          AND l.phone = c.phone_e164
    `);
    console.log('Linked', linked, 'leads to contacts');

    // 9. Backfill contact_addresses from leads
    const { rows: addrLeads } = await db.query(`
        SELECT l.contact_id, l.address, l.unit, l.city, l.state, l.postal_code,
               l.latitude, l.longitude
        FROM leads l
        WHERE l.contact_id IS NOT NULL
          AND l.address IS NOT NULL
          AND TRIM(l.address) != ''
    `);
    console.log('Leads with addresses:', addrLeads.length);

    let addrCreated = 0;
    const seenHashes = new Set(); // track contact_id + hash to avoid duplicates
    for (const l of addrLeads) {
        const hash = addressHash(l.address, l.city, l.state, l.postal_code);
        const key = `${l.contact_id}:${hash}`;
        if (seenHashes.has(key)) continue;
        seenHashes.add(key);

        try {
            // Auto-set is_primary only if contact has no existing addresses
            const { rows: existingAddr } = await db.query(
                'SELECT COUNT(*)::int as cnt FROM contact_addresses WHERE contact_id = $1',
                [l.contact_id]
            );
            const isPrimary = existingAddr[0].cnt === 0;

            await db.query(
                `INSERT INTO contact_addresses
                    (contact_id, street_line1, street_line2, city, state, postal_code, lat, lng, is_primary, address_normalized_hash)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT DO NOTHING`,
                [
                    l.contact_id,
                    l.address || '',
                    l.unit || null,
                    l.city || '',
                    l.state || '',
                    l.postal_code || '',
                    l.latitude || null,
                    l.longitude || null,
                    isPrimary,
                    hash,
                ]
            );
            addrCreated++;
        } catch (e) {
            console.log('Skip address for contact', l.contact_id, '-', e.message.substring(0, 80));
        }
    }
    console.log('Created', addrCreated, 'contact_addresses');

    // 10. Link leads to their contact_addresses
    const { rowCount: addrLinked } = await db.query(`
        UPDATE leads l SET contact_address_id = ca.id
        FROM contact_addresses ca
        WHERE l.contact_id = ca.contact_id
          AND l.contact_address_id IS NULL
          AND l.address IS NOT NULL
          AND TRIM(l.address) != ''
          AND ca.address_normalized_hash = MD5(
              LOWER(TRIM(COALESCE(l.address, ''))) || '|' ||
              LOWER(TRIM(COALESCE(l.city, ''))) || '|' ||
              LOWER(TRIM(COALESCE(l.state, ''))) || '|' ||
              TRIM(COALESCE(l.postal_code, ''))
          )
    `);
    console.log('Linked', addrLinked, 'leads to contact_addresses');

    // 11. Re-link calls to contacts by phone
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
    const { rows: aStats } = await db.query('SELECT count(*) as total FROM contact_addresses');
    const { rows: laLinked } = await db.query('SELECT count(*) as n FROM leads WHERE contact_address_id IS NOT NULL');
    console.log(`Contacts: ${stats[0].total} | Leads: ${lStats[0].total} | Linked: ${lLinked[0].n}`);
    console.log(`Addresses: ${aStats[0].total} | Leads with address link: ${laLinked[0].n}`);

    await db.pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
