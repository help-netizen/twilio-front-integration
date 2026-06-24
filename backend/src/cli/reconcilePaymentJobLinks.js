#!/usr/bin/env node
/**
 * Reconcile Payment → Job Links CLI
 *
 * Heals Zenbooker payments that synced with no provider and no linked job by
 * (1) backfilling a missing zb_payments.job_id from the raw payloads we already
 * stored, and (2) repopulating the denormalised job fields from the already-
 * synced local jobs table. SQL-only and idempotent — NO Zenbooker API calls.
 * Also re-projects the canonical payment_transactions ledger.
 *
 * Usage:
 *   node backend/src/cli/reconcilePaymentJobLinks.js                 # all companies
 *   node backend/src/cli/reconcilePaymentJobLinks.js --company <uuid>
 *   node backend/src/cli/reconcilePaymentJobLinks.js --dry-run       # preview only
 *
 * Rows reported as "still_no_job_id" / "still_missing_job_body" are payments
 * whose ZB job isn't in the local jobs table yet — run the full job sync
 * (scripts/zb-jobs-sync-full.js) first, then re-run this.
 */

require('dotenv').config();

const db = require('../db/connection');
const { reconcileJobLinks } = require('../services/zenbookerPaymentsSyncService');

function parseArgs(argv) {
    const args = { dryRun: false, company: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run' || a === '-n') args.dryRun = true;
        else if (a === '--company' || a === '-c') args.company = argv[++i];
        else if (a.startsWith('--company=')) args.company = a.slice('--company='.length);
    }
    return args;
}

async function companyIds(explicit) {
    if (explicit) return [explicit];
    const { rows } = await db.query(
        'SELECT DISTINCT company_id FROM zb_payments ORDER BY company_id'
    );
    return rows.map(r => r.company_id);
}

async function main() {
    const { dryRun, company } = parseArgs(process.argv);
    console.log(`[reconcilePaymentJobLinks] start ${dryRun ? '(dry-run) ' : ''}at ${new Date().toISOString()}`);

    const ids = await companyIds(company);
    if (ids.length === 0) {
        console.log('[reconcilePaymentJobLinks] no companies with zb_payments — nothing to do');
        return;
    }

    const totals = { backfilled_job_id: 0, healed_from_local_jobs: 0, still_no_job_id: 0, still_missing_job_body: 0 };
    for (const id of ids) {
        const r = await reconcileJobLinks(id, { dryRun });
        totals.backfilled_job_id += r.backfilled_job_id;
        totals.healed_from_local_jobs += r.healed_from_local_jobs;
        totals.still_no_job_id += r.still_no_job_id;
        totals.still_missing_job_body += r.still_missing_job_body;
    }

    console.log(`[reconcilePaymentJobLinks] done — companies=${ids.length}`, totals);
    if (totals.still_no_job_id > 0 || totals.still_missing_job_body > 0) {
        console.log('[reconcilePaymentJobLinks] some payments still lack a local job — sync jobs (scripts/zb-jobs-sync-full.js) then re-run.');
    }
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('[reconcilePaymentJobLinks] fatal:', err);
        process.exit(1);
    });
