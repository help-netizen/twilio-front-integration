#!/usr/bin/env node
/**
 * sync-jobs-from-zenbooker.js
 *
 * One-time script: fetch all jobs from Zenbooker API and upsert into local jobs table.
 * Links jobs to leads by matching zenbooker_job_id.
 *
 * Usage: node scripts/sync-jobs-from-zenbooker.js
 */

require('dotenv').config();
const db = require('../backend/src/db/connection');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
const jobsService = require('../backend/src/services/jobsService');

async function main() {
    console.log('🔄 Starting Zenbooker → Local jobs sync...');

    let cursor = 0;
    let totalFetched = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    const LIMIT = 50;

    while (true) {
        console.log(`  Fetching jobs: cursor=${cursor}, limit=${LIMIT}...`);

        let data;
        try {
            data = await zenbookerClient.getJobs({ limit: LIMIT, cursor });
        } catch (err) {
            console.error('  ❌ API error:', err.response?.data || err.message);
            break;
        }

        const jobs = data.results || data.data?.results || [];
        if (jobs.length === 0) {
            console.log('  No more jobs to fetch.');
            break;
        }

        totalFetched += jobs.length;

        for (const zbJob of jobs) {
            const zbJobId = zbJob.id;
            if (!zbJobId) continue;

            try {
                // Check if we have a lead linked to this job
                const { rows: leadRows } = await db.query(
                    `SELECT id, contact_id, company_id FROM leads WHERE zenbooker_job_id = $1 LIMIT 1`,
                    [zbJobId]
                );
                const lead = leadRows[0] || null;

                const existing = await jobsService.getJobByZbId(zbJobId);
                if (existing) {
                    // Update
                    const result = await jobsService.syncFromZenbooker(zbJobId, zbJob);
                    // Also link lead if not linked
                    if (lead && !existing.lead_id) {
                        await db.query(
                            `UPDATE jobs SET lead_id = $1, contact_id = COALESCE($2, contact_id), company_id = COALESCE($3, company_id) WHERE zenbooker_job_id = $4`,
                            [lead.id, lead.contact_id, lead.company_id, zbJobId]
                        );
                    }
                    totalUpdated++;
                } else {
                    // Create
                    await jobsService.createJob({
                        leadId: lead?.id || null,
                        contactId: lead?.contact_id || null,
                        zenbookerJobId: zbJobId,
                        zbData: zbJob,
                        companyId: lead?.company_id || null,
                    });
                    totalCreated++;
                }
            } catch (err) {
                console.error(`  ⚠️ Error syncing job ${zbJobId}:`, err.message);
            }
        }

        // Check if there are more
        const hasMore = data.has_more || (jobs.length === LIMIT);
        if (!hasMore) break;
        cursor += LIMIT;
    }

    console.log(`\n✅ Sync complete!`);
    console.log(`   Fetched:  ${totalFetched} jobs from Zenbooker`);
    console.log(`   Created:  ${totalCreated} new local jobs`);
    console.log(`   Updated:  ${totalUpdated} existing jobs`);

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
