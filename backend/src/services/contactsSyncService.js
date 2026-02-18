/**
 * Contacts Sync Service
 * 
 * Syncs Zenbooker customers → local contacts table.
 * Uses sync_state table to track last synced timestamp.
 * Initial sync covers everything from 2026-02-01.
 */

const db = require('../db/connection');
const zenbookerClient = require('./zenbookerClient');
const contactsService = require('./contactsService');

const JOB_NAME = 'zenbooker_contacts_sync';
const INITIAL_SYNC_DATE = '2026-02-01';

// =============================================================================
// Run Sync
// =============================================================================
async function runSync() {
    console.log(`[ContactsSync] Starting sync...`);
    const startTime = Date.now();

    try {
        // 1. Read last sync cursor
        const { rows: stateRows } = await db.query(
            `SELECT cursor FROM sync_state WHERE job_name = $1`,
            [JOB_NAME]
        );

        let lastSyncedAt = INITIAL_SYNC_DATE;
        if (stateRows.length > 0 && stateRows[0].cursor?.last_synced_at) {
            lastSyncedAt = stateRows[0].cursor.last_synced_at;
        }

        console.log(`[ContactsSync] Fetching customers created after ${lastSyncedAt}`);

        // 2. Fetch customers from Zenbooker
        const customers = await zenbookerClient.getCustomers({ created_after: lastSyncedAt });
        console.log(`[ContactsSync] Fetched ${customers.length} customers from Zenbooker`);

        // 3. Upsert each customer
        let upserted = 0;
        let errors = 0;
        for (const customer of customers) {
            try {
                await contactsService.upsertFromZenbooker(customer);
                upserted++;
            } catch (err) {
                errors++;
                console.error(`[ContactsSync] Error upserting customer ${customer.id}:`, err.message);
            }
        }

        // 4. Update sync_state
        const now = new Date().toISOString();
        await db.query(`
            INSERT INTO sync_state (job_name, cursor, last_success_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (job_name) DO UPDATE SET
                cursor = $2,
                last_success_at = $3
        `, [JOB_NAME, JSON.stringify({ last_synced_at: now }), now]);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[ContactsSync] Done in ${elapsed}s — upserted: ${upserted}, errors: ${errors}`);

        return { upserted, errors, elapsed };
    } catch (err) {
        // Record error in sync_state
        const now = new Date().toISOString();
        await db.query(`
            INSERT INTO sync_state (job_name, cursor, last_error_at, last_error)
            VALUES ($1, '{}'::jsonb, $2, $3)
            ON CONFLICT (job_name) DO UPDATE SET
                last_error_at = $2,
                last_error = $3
        `, [JOB_NAME, now, err.message]);

        console.error(`[ContactsSync] Sync failed:`, err);
        throw err;
    }
}

module.exports = { runSync };
