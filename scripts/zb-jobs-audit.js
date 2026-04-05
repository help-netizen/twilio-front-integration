#!/usr/bin/env node
/**
 * zb-jobs-audit.js
 *
 * Diagnostic script: compares Zenbooker jobs (created after Feb 1, 2026)
 * with local jobs table and reports missing ones.
 *
 * Usage: node scripts/zb-jobs-audit.js
 */

require('dotenv').config();
const db = require('../backend/src/db/connection');
const zenbookerClient = require('../backend/src/services/zenbookerClient');

const CREATED_AFTER = '2026-02-01T00:00:00Z';

async function main() {
    console.log('=== Zenbooker Jobs Audit ===');
    console.log(`Fetching all ZB jobs created after ${CREATED_AFTER}...\n`);

    // 1. Fetch all jobs from Zenbooker API
    const zbJobs = [];
    let cursor = 0;
    const LIMIT = 100;

    while (true) {
        const data = await zenbookerClient.getJobs({
            limit: LIMIT,
            cursor,
            created_after: CREATED_AFTER,
            sort_by: 'creation_date',
            sort_order: 'ascending',
        });

        const jobs = data.results || [];
        if (jobs.length === 0) break;

        zbJobs.push(...jobs);
        cursor += jobs.length;
        console.log(`  Fetched ${zbJobs.length} jobs so far (next cursor=${cursor})...`);

        if (!data.has_more) break;
    }

    console.log(`\nTotal Zenbooker jobs: ${zbJobs.length}`);

    // 2. Get all zenbooker_job_id from local DB
    const { rows: localJobs } = await db.query(
        `SELECT zenbooker_job_id, job_number, blanc_status FROM jobs WHERE zenbooker_job_id IS NOT NULL`
    );
    const localZbIds = new Set(localJobs.map(j => j.zenbooker_job_id));
    console.log(`Total local jobs (with zb_id): ${localJobs.length}`);

    // 3. Find missing
    const missing = zbJobs.filter(zb => !localZbIds.has(String(zb.id)));

    console.log(`\n=== MISSING JOBS: ${missing.length} ===\n`);

    if (missing.length === 0) {
        console.log('All Zenbooker jobs are present in local DB.');
    } else {
        console.log('ZB ID | Job # | Service | Start Date | Customer | Status | Canceled');
        console.log('-'.repeat(100));
        for (const job of missing) {
            const startDate = job.start_date
                ? new Date(job.start_date).toISOString().slice(0, 16).replace('T', ' ')
                : 'N/A';
            const customer = job.customer?.name || job.customer_name || 'N/A';
            const service = (job.services?.[0]?.name || job.service_name || 'N/A').slice(0, 25);
            const status = job.status || 'N/A';
            const canceled = job.canceled ? 'YES' : 'no';
            const jobNum = job.job_number || 'N/A';

            console.log(`${job.id} | ${jobNum} | ${service} | ${startDate} | ${customer} | ${status} | ${canceled}`);
        }
    }

    // 4. Also check: local jobs that are NOT in ZB (orphans)
    const zbIds = new Set(zbJobs.map(zb => String(zb.id)));
    const orphans = localJobs.filter(j => !zbIds.has(j.zenbooker_job_id));
    if (orphans.length > 0) {
        console.log(`\n=== ORPHAN LOCAL JOBS (in DB but not in ZB after ${CREATED_AFTER}): ${orphans.length} ===`);
        console.log('(These may be older jobs or deleted in ZB)');
    }

    console.log('\n=== Audit complete ===');
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
