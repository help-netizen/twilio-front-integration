/**
 * Migration: Add functional index on leads.phone for fast phone lookups.
 * 
 * The getLeadByPhone / getLeadsByPhones queries use:
 *   RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10)
 * 
 * Without this index, every query does a full table scan with REGEXP_REPLACE
 * on every row. With it, PostgreSQL can do an index lookup.
 * 
 * Run: node scripts/add-phone-index.js
 * Or via SSH: fly ssh console -a abc-metrics -C "node scripts/add-phone-index.js"
 */
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function run() {
    console.log('Creating functional index on leads.phone...');

    await pool.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_phone_last10
        ON leads (RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10))
        WHERE status NOT IN ('Lost', 'Converted')
    `);

    console.log('✅ Index idx_leads_phone_last10 created successfully');

    // Also add index on jobs.contact_id for the "has job?" check
    await pool.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_contact_id
        ON jobs (contact_id)
        WHERE contact_id IS NOT NULL
    `);

    console.log('✅ Index idx_jobs_contact_id created successfully');

    await pool.end();
    console.log('Done.');
}

run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
