#!/usr/bin/env node
/**
 * zb-jobs-sync-full.js
 *
 * Full sync: fetches all jobs from Zenbooker API (with full details per job)
 * and upserts into local jobs table via jobsService.syncFromZenbooker().
 *
 * Mirrors the logic of POST /api/jobs/sync route handler.
 *
 * Usage: node scripts/zb-jobs-sync-full.js
 */

require('dotenv').config();
const db = require('../backend/src/db/connection');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
const jobsService = require('../backend/src/services/jobsService');

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

async function main() {
    console.log('=== Full Zenbooker → Local Jobs Sync ===');
    console.log(`Company: ${COMPANY_ID}`);

    const zbClient = await zenbookerClient.getClientForCompany(COMPANY_ID);
    const makeRequest = (url, params) => zbClient.get(url, { params });

    let totalSynced = 0;
    let totalCreated = 0;
    let totalErrors = 0;
    let cursor = 0;
    const limit = 100;

    while (true) {
        console.log(`\n  Fetching batch: cursor=${cursor}, limit=${limit}...`);
        const zbRes = await makeRequest('/jobs', { limit, cursor, sort_by: 'creation_date', sort_order: 'ascending' });
        const zbData = zbRes.data;
        const zbJobs = zbData.results || [];
        if (zbJobs.length === 0) break;

        for (const zbJob of zbJobs) {
            try {
                // Fetch full job details (webhook/list data can be partial)
                let fullJob = zbJob;
                try {
                    const fullRes = await makeRequest(`/jobs/${zbJob.id}`);
                    fullJob = fullRes.data;
                } catch (fetchErr) {
                    console.warn(`  ⚠ Could not fetch full job ${zbJob.id}, using list data: ${fetchErr.message}`);
                }

                const result = await jobsService.syncFromZenbooker(
                    zbJob.id, fullJob, COMPANY_ID, 'sync_bulk'
                );
                totalSynced++;
                if (result.created) totalCreated++;
            } catch (err) {
                totalErrors++;
                console.warn(`  ✗ Failed to sync job ${zbJob.id} (${zbJob.job_number}): ${err.message}`);
            }
        }

        console.log(`  Batch done: ${zbJobs.length} processed (total: ${totalSynced} synced, ${totalCreated} new, ${totalErrors} errors)`);

        if (!zbData.has_more) break;
        cursor += zbJobs.length;
    }

    console.log(`\n=== Sync Complete ===`);
    console.log(`  Total synced:  ${totalSynced}`);
    console.log(`  New created:   ${totalCreated}`);
    console.log(`  Errors:        ${totalErrors}`);

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
