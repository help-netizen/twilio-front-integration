#!/usr/bin/env node
/**
 * migrate-timelines.js — Data migration for timeline architecture
 *
 * Steps:
 * 1. Delete auto-created contacts (those without a linked lead)
 * 2. Create contacts from orphaned leads (leads that lost their contact)
 * 3. Create timeline records for all unique phone numbers
 * 4. Link timelines → contacts (by primary + secondary phone)
 * 5. Populate calls.timeline_id from phone matching
 *
 * Usage:
 *   node scripts/migrate-timelines.js          # Dry run
 *   node scripts/migrate-timelines.js --run     # Execute
 */
const db = require('../backend/src/db/connection');

const DRY_RUN = !process.argv.includes('--run');

async function main() {
    console.log(DRY_RUN ? '🔍 DRY RUN MODE — no changes will be made' : '🚀 LIVE RUN');
    console.log('='.repeat(60));

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // ─── Step 0: Stats before ───────────────────────────────────
        const beforeContacts = (await client.query('SELECT COUNT(*) FROM contacts')).rows[0].count;
        const beforeCalls = (await client.query('SELECT COUNT(*) FROM calls')).rows[0].count;
        console.log(`\n📊 Before: ${beforeContacts} contacts, ${beforeCalls} calls`);

        // ─── Step 1: Delete auto-created contacts ───────────────────
        // Keep contacts that have a linked lead
        const toDelete = await client.query(`
            SELECT c.id, c.phone_e164, c.full_name
            FROM contacts c
            WHERE c.id NOT IN (
                SELECT DISTINCT contact_id FROM leads WHERE contact_id IS NOT NULL
            )
        `);
        console.log(`\n🗑️  Step 1: ${toDelete.rows.length} auto-created contacts to delete`);
        if (toDelete.rows.length > 0) {
            console.log('   Sample:', toDelete.rows.slice(0, 5).map(r => `${r.id}: ${r.phone_e164} (${r.full_name})`).join(', '));
        }

        if (!DRY_RUN) {
            // Unlink calls from these contacts first
            await client.query(`
                UPDATE calls SET contact_id = NULL
                WHERE contact_id IN (
                    SELECT c.id FROM contacts c
                    WHERE c.id NOT IN (
                        SELECT DISTINCT contact_id FROM leads WHERE contact_id IS NOT NULL
                    )
                )
            `);
            await client.query(`
                DELETE FROM contacts
                WHERE id NOT IN (
                    SELECT DISTINCT contact_id FROM leads WHERE contact_id IS NOT NULL
                )
            `);
            console.log('   ✅ Deleted');
        }

        // ─── Step 2: Create contacts from orphaned leads ────────────
        const orphanedLeads = await client.query(`
            SELECT l.uuid, l.first_name, l.last_name, l.phone, l.email,
                   l.second_phone, l.second_phone_name, l.company, l.company_id
            FROM leads l
            WHERE l.contact_id IS NULL
              AND l.phone IS NOT NULL
              AND l.phone != ''
        `);
        console.log(`\n🔗 Step 2: ${orphanedLeads.rows.length} orphaned leads need contacts`);

        if (!DRY_RUN) {
            for (const lead of orphanedLeads.rows) {
                const phone = lead.phone.startsWith('+') ? lead.phone : '+' + lead.phone.replace(/\D/g, '');
                const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || phone;
                const digits = phone.replace(/\D/g, '');

                // Check if contact already exists for this phone
                const existing = await client.query(
                    `SELECT id FROM contacts WHERE regexp_replace(phone_e164, '\\D', '', 'g') = $1 LIMIT 1`,
                    [digits]
                );

                let contactId;
                if (existing.rows.length > 0) {
                    contactId = existing.rows[0].id;
                } else {
                    const newContact = await client.query(
                        `INSERT INTO contacts (phone_e164, full_name, email, secondary_phone, secondary_phone_name, company_name, company_id)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         RETURNING id`,
                        [phone, fullName, lead.email, lead.second_phone, lead.second_phone_name, lead.company, lead.company_id]
                    );
                    contactId = newContact.rows[0].id;
                }

                await client.query(
                    `UPDATE leads SET contact_id = $1 WHERE uuid = $2`,
                    [contactId, lead.uuid]
                );
            }
            console.log('   ✅ Created/linked');
        }

        // ─── Step 3: Create timeline records ────────────────────────
        // Collect all unique phone numbers from calls, SMS, and contacts
        const phoneCount = await client.query(`
            SELECT COUNT(DISTINCT phone) FROM (
                SELECT from_number as phone FROM calls WHERE from_number IS NOT NULL AND from_number NOT LIKE 'sip:%'
                UNION
                SELECT to_number as phone FROM calls WHERE to_number IS NOT NULL AND to_number NOT LIKE 'sip:%'
                UNION
                SELECT customer_e164 as phone FROM sms_conversations WHERE customer_e164 IS NOT NULL
                UNION
                SELECT phone_e164 as phone FROM contacts WHERE phone_e164 IS NOT NULL
                UNION
                SELECT secondary_phone as phone FROM contacts WHERE secondary_phone IS NOT NULL
            ) phones
        `);
        console.log(`\n📱 Step 3: ${phoneCount.rows[0].count} unique phone numbers → timelines`);

        if (!DRY_RUN) {
            await client.query(`
                INSERT INTO timelines (phone_e164, company_id)
                SELECT DISTINCT ON (regexp_replace(phone, '\\D', '', 'g'))
                       phone, company_id
                FROM (
                    SELECT from_number as phone, company_id FROM calls WHERE from_number IS NOT NULL AND from_number NOT LIKE 'sip:%'
                    UNION
                    SELECT to_number as phone, company_id FROM calls WHERE to_number IS NOT NULL AND to_number NOT LIKE 'sip:%'
                    UNION
                    SELECT customer_e164 as phone, company_id FROM sms_conversations WHERE customer_e164 IS NOT NULL
                    UNION
                    SELECT phone_e164 as phone, company_id FROM contacts WHERE phone_e164 IS NOT NULL
                    UNION
                    SELECT secondary_phone as phone, company_id FROM contacts WHERE secondary_phone IS NOT NULL
                ) phones
                ON CONFLICT (phone_e164) DO NOTHING
            `);
            const created = (await client.query('SELECT COUNT(*) FROM timelines')).rows[0].count;
            console.log(`   ✅ Created ${created} timelines`);
        }

        // ─── Step 4: Link timelines → contacts ─────────────────────
        if (!DRY_RUN) {
            // Primary phone match
            const primary = await client.query(`
                UPDATE timelines t SET contact_id = c.id, updated_at = now()
                FROM contacts c
                WHERE regexp_replace(t.phone_e164, '\\D', '', 'g') = regexp_replace(c.phone_e164, '\\D', '', 'g')
                  AND t.contact_id IS NULL
            `);
            console.log(`\n🔗 Step 4: Linked ${primary.rowCount} timelines via primary phone`);

            // Secondary phone match
            const secondary = await client.query(`
                UPDATE timelines t SET contact_id = c.id, updated_at = now()
                FROM contacts c
                WHERE regexp_replace(t.phone_e164, '\\D', '', 'g') = regexp_replace(c.secondary_phone, '\\D', '', 'g')
                  AND t.contact_id IS NULL
                  AND c.secondary_phone IS NOT NULL
            `);
            console.log(`   Linked ${secondary.rowCount} timelines via secondary phone`);
        } else {
            console.log('\n🔗 Step 4: Link timelines → contacts (skipped in dry run)');
        }

        // ─── Step 5: Populate calls.timeline_id ─────────────────────
        if (!DRY_RUN) {
            // Match calls by from_number
            const fromMatch = await client.query(`
                UPDATE calls SET timeline_id = t.id
                FROM timelines t
                WHERE regexp_replace(calls.from_number, '\\D', '', 'g') = regexp_replace(t.phone_e164, '\\D', '', 'g')
                  AND calls.timeline_id IS NULL
                  AND calls.from_number IS NOT NULL
                  AND calls.from_number NOT LIKE 'sip:%'
            `);
            // Match calls by to_number (for remaining)
            const toMatch = await client.query(`
                UPDATE calls SET timeline_id = t.id
                FROM timelines t
                WHERE regexp_replace(calls.to_number, '\\D', '', 'g') = regexp_replace(t.phone_e164, '\\D', '', 'g')
                  AND calls.timeline_id IS NULL
                  AND calls.to_number IS NOT NULL
                  AND calls.to_number NOT LIKE 'sip:%'
            `);
            const remaining = (await client.query('SELECT COUNT(*) FROM calls WHERE timeline_id IS NULL')).rows[0].count;
            console.log(`\n📞 Step 5: Linked ${fromMatch.rowCount} calls (from) + ${toMatch.rowCount} calls (to). Remaining unlinked: ${remaining}`);

            // Also update calls.contact_id from timeline.contact_id where possible
            const contactLink = await client.query(`
                UPDATE calls SET contact_id = t.contact_id
                FROM timelines t
                WHERE calls.timeline_id = t.id
                  AND t.contact_id IS NOT NULL
                  AND calls.contact_id IS NULL
            `);
            console.log(`   Re-linked ${contactLink.rowCount} calls to contacts via timelines`);
        } else {
            console.log('\n📞 Step 5: Populate calls.timeline_id (skipped in dry run)');
        }

        // ─── Final stats ────────────────────────────────────────────
        if (!DRY_RUN) {
            const afterContacts = (await client.query('SELECT COUNT(*) FROM contacts')).rows[0].count;
            const afterTimelines = (await client.query('SELECT COUNT(*) FROM timelines')).rows[0].count;
            const linkedTimelines = (await client.query('SELECT COUNT(*) FROM timelines WHERE contact_id IS NOT NULL')).rows[0].count;
            const linkedCalls = (await client.query('SELECT COUNT(*) FROM calls WHERE timeline_id IS NOT NULL')).rows[0].count;
            console.log(`\n📊 After: ${afterContacts} contacts, ${afterTimelines} timelines (${linkedTimelines} linked to contacts), ${linkedCalls}/${beforeCalls} calls linked`);

            await client.query('COMMIT');
            console.log('\n✅ Migration committed successfully!');
        } else {
            await client.query('ROLLBACK');
            console.log('\n🔍 Dry run complete. Run with --run to execute.');
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('\n❌ Migration failed:', err);
        throw err;
    } finally {
        client.release();
        process.exit(0);
    }
}

main();
