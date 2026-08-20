#!/usr/bin/env node
'use strict';

const db = require('../backend/src/db/connection');

const AUDIT_SQL = `
    WITH owned_invoices AS (
        SELECT id, status
        FROM invoices
        WHERE company_id = $1
    )
    SELECT
        COALESCE((
            SELECT jsonb_agg(pt.id ORDER BY pt.id)
            FROM payment_transactions pt
            JOIN invoices i ON i.id = pt.invoice_id AND i.company_id = pt.company_id
            WHERE pt.company_id = $1 AND pt.origin_invoice_id IS NULL
        ), '[]'::jsonb) AS linked_without_origin,
        COALESCE((
            SELECT jsonb_agg(pt.id ORDER BY pt.id)
            FROM payment_transactions pt
            JOIN invoices i ON i.id = pt.invoice_id AND i.company_id = pt.company_id
            WHERE pt.company_id = $1 AND pt.job_id IS NULL AND i.job_id IS NOT NULL
        ), '[]'::jsonb) AS linked_without_job,
        COALESCE((
            SELECT jsonb_agg(pt.id ORDER BY pt.id)
            FROM payment_transactions pt
            JOIN invoices i ON i.id = pt.invoice_id AND i.company_id = pt.company_id
            WHERE pt.company_id = $1 AND i.status IN ('void', 'voided', 'refunded')
        ), '[]'::jsonb) AS payments_linked_to_terminal_invoice,
        COALESCE((
            SELECT jsonb_agg(s.id ORDER BY s.id)
            FROM stripe_payment_sessions s
            JOIN invoices i ON i.id = s.invoice_id AND i.company_id = s.company_id
            WHERE s.company_id = $1 AND i.status IN ('void', 'voided', 'refunded')
        ), '[]'::jsonb) AS sessions_linked_to_terminal_invoice,
        COALESCE((
            SELECT jsonb_agg(pt.id ORDER BY pt.id)
            FROM payment_transactions pt
            JOIN invoices i ON i.id = pt.invoice_id AND i.company_id <> pt.company_id
            WHERE pt.company_id = $1
        ), '[]'::jsonb) AS own_payments_linked_cross_tenant,
        COALESCE((
            SELECT jsonb_agg(pt.id ORDER BY pt.id)
            FROM owned_invoices i
            JOIN payment_transactions pt ON pt.invoice_id = i.id AND pt.company_id <> $1
        ), '[]'::jsonb) AS foreign_payments_linked_to_owned_invoice,
        COALESCE((
            SELECT jsonb_agg(pt.id ORDER BY pt.id)
            FROM payment_transactions pt
            WHERE pt.company_id = $1
              AND pt.invoice_id IS NULL
              AND pt.job_id IS NULL
              AND pt.transaction_type IN ('payment', 'refund')
        ), '[]'::jsonb) AS ledger_rows_without_job_or_invoice,
        COALESCE((
            SELECT jsonb_agg(s.id ORDER BY s.id)
            FROM stripe_payment_sessions s
            WHERE s.company_id = $1
              AND s.invoice_id IS NULL
              AND s.job_id IS NULL
              AND s.status = 'open'
        ), '[]'::jsonb) AS open_sessions_without_job_or_invoice
`;

function parseArgs(argv) {
    const parsed = { apply: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--company-id') parsed.companyId = argv[++index];
        else if (argument === '--apply') parsed.apply = true;
        else if (argument === '--help') parsed.help = true;
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!parsed.help && !parsed.companyId) throw new Error('--company-id is required');
    return parsed;
}

async function collectAudit(client, companyId) {
    const { rows } = await client.query(AUDIT_SQL, [companyId]);
    return rows[0];
}

async function applySafeRepairs(client, companyId) {
    const linked = await client.query(
        `UPDATE payment_transactions pt
         SET origin_invoice_id = COALESCE(pt.origin_invoice_id, pt.invoice_id),
             job_id = COALESCE(pt.job_id, i.job_id),
             updated_at = NOW()
         FROM invoices i
         WHERE pt.company_id = $1
           AND i.company_id = $1
           AND pt.invoice_id = i.id
           AND (pt.origin_invoice_id IS NULL OR pt.job_id IS NULL)
         RETURNING pt.id`,
        [companyId]
    );
    const terminalPayments = await client.query(
        `UPDATE payment_transactions pt
         SET invoice_id = NULL,
             origin_invoice_id = COALESCE(pt.origin_invoice_id, pt.invoice_id),
             job_id = COALESCE(pt.job_id, i.job_id),
             updated_at = NOW()
         FROM invoices i
         WHERE pt.company_id = $1
           AND i.company_id = $1
           AND pt.invoice_id = i.id
           AND i.status IN ('void', 'voided', 'refunded')
         RETURNING pt.id`,
        [companyId]
    );
    const terminalSessions = await client.query(
        `UPDATE stripe_payment_sessions s
         SET invoice_id = NULL,
             job_id = COALESCE(s.job_id, i.job_id),
             metadata = COALESCE(s.metadata, '{}'::jsonb) || jsonb_build_object(
                 'removed_invoice_id', i.id::TEXT,
                 'removed_invoice_number', i.invoice_number
             ),
             updated_at = NOW()
         FROM invoices i
         WHERE s.company_id = $1
           AND i.company_id = $1
           AND s.invoice_id = i.id
           AND i.status IN ('void', 'voided', 'refunded')
         RETURNING s.id`,
        [companyId]
    );
    return {
        linked_rows_normalized: linked.rowCount,
        terminal_payments_detached: terminalPayments.rowCount,
        terminal_sessions_detached: terminalSessions.rowCount,
    };
}

async function runAudit({ companyId, apply = false }, database = db) {
    const client = await database.getClient();
    try {
        await client.query('BEGIN');
        const before = await collectAudit(client, companyId);
        let repairs = null;
        let after = before;
        if (apply) {
            repairs = await applySafeRepairs(client, companyId);
            after = await collectAudit(client, companyId);
            await client.query('COMMIT');
        } else {
            await client.query('ROLLBACK');
        }
        return { mode: apply ? 'apply' : 'dry-run', company_id: companyId, before, repairs, after };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
        throw error;
    } finally {
        client.release();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node scripts/audit-invoice-removal-data.js --company-id <uuid> [--apply]');
        console.log('Default mode is dry-run; --apply performs only deterministic tenant-scoped repairs.');
        return;
    }
    console.log(JSON.stringify(await runAudit(args), null, 2));
}

if (require.main === module) {
    main()
        .catch(error => {
            console.error(`[invoice-removal-audit] ${error.message}`);
            process.exitCode = 1;
        })
        .finally(() => db.pool.end());
}

module.exports = {
    AUDIT_SQL,
    applySafeRepairs,
    collectAudit,
    parseArgs,
    runAudit,
};
