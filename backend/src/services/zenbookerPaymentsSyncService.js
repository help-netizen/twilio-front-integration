/**
 * Zenbooker payment import maintenance (legacy archive)
 *
 * Relocated from services/paymentsService.js during PF004 Sprint 5.
 * Retains projection and reconciliation helpers for the archived import tables.
 *
 * Functions:
 * Payments-page reads live in paymentLedgerService.js.
 */

const db = require('../db/connection');

// ─── Source / Tag / Method helpers (moved from route) ────────────────────────

const SOURCE_MATCH_KEYS = [
    'lead source', 'blanc source', 'source', 'campaign', 'channel', 'utm_source',
    'referral source', 'how did you hear',
];

function extractSource(job) {
    if (!job) return '';
    if (Array.isArray(job.service_fields)) {
        for (const field of job.service_fields) {
            const name = (field.field_name || '').toLowerCase();
            if (SOURCE_MATCH_KEYS.some(k => name.includes(k))) {
                if (field.text_value) return field.text_value;
                if (Array.isArray(field.selected_options) && field.selected_options.length > 0) {
                    return field.selected_options.map(o => o.text || o.display_label).filter(Boolean).join(', ');
                }
            }
        }
    }
    return '';
}

function extractTags(job) {
    if (!job) return '';
    if (Array.isArray(job.tags)) {
        return job.tags.map(t => typeof t === 'string' ? t : t.name || '').filter(Boolean).join(', ');
    }
    if (Array.isArray(job.custom_tags)) {
        return job.custom_tags.map(t => typeof t === 'string' ? t : t.name || '').filter(Boolean).join(', ');
    }
    if (Array.isArray(job.skill_tags_required)) {
        return job.skill_tags_required.map(t => t.name || '').filter(Boolean).join(', ');
    }
    return '';
}

function extractCustomFields(job) {
    if (!job || !Array.isArray(job.service_fields)) return '';
    const parts = [];
    for (const field of job.service_fields) {
        const name = (field.field_name || '').trim();
        if (!name) continue;
        // Skip fields already extracted as source
        const lowerName = name.toLowerCase();
        if (SOURCE_MATCH_KEYS.some(k => lowerName.includes(k))) continue;
        // Get the value
        let val = '';
        if (field.text_value) {
            val = field.text_value;
        } else if (Array.isArray(field.selected_options) && field.selected_options.length > 0) {
            val = field.selected_options.map(o => o.text || o.display_label).filter(Boolean).join(', ');
        }
        if (val) parts.push(`${name}: ${val}`);
    }
    return parts.join('; ');
}

function formatPaymentMethod(txn) {
    const method = txn.payment_method || '';
    if (method === 'stripe' && txn.stripe_card_brand) {
        return `stripe (${txn.stripe_card_brand})`;
    }
    if (method === 'custom' && txn.custom_payment_method_name) {
        return `custom (${txn.custom_payment_method_name})`;
    }
    return method;
}

function displayPaymentMethod(txn) {
    if (txn.custom_payment_method_name) return txn.custom_payment_method_name;
    return txn.payment_method || '';
}

function normalizeZenbookerPaymentMethod(value) {
    const method = String(value || '').trim().toLowerCase();
    if (['stripe', 'card', 'credit_card'].includes(method) || method.startsWith('stripe (')) return 'zb_card';
    if (method === 'check' || method === 'cheque') return 'zb_check';
    if (method === 'cash') return 'zb_cash';
    if (method === 'ach') return 'zb_ach';
    if (method === 'venmo') return 'zb_venmo';
    if (method === 'zelle') return 'zb_zelle';
    return 'zb_other';
}

function classifyZenbookerTransaction(txn = {}) {
    const rawKind = String(
        txn.transaction_type || txn.type || txn.kind || txn.action || ''
    ).trim().toLowerCase();
    const rawStatus = String(txn.status || '').trim().toLowerCase();
    const amount = Number(txn.amount_collected ?? txn.amount ?? 0);
    const refundLike = /refund|reversal|reversed/.test(rawKind)
        || ['refund', 'refunded', 'reversal', 'reversed'].includes(rawStatus)
        || (Number.isFinite(amount) && amount < 0);

    // The retained fixtures and published list endpoint do not establish a
    // reliable refund amount/sign contract. Keep anything refund-like in the
    // ledger for audit/display, but non-financial until that contract is proven.
    if (refundLike) return { transaction_type: 'adjustment', status: 'pending' };
    if (rawStatus === 'succeeded') return { transaction_type: 'payment', status: 'completed' };
    if (rawStatus === 'failed') return { transaction_type: 'payment', status: 'failed' };
    if (rawStatus === 'voided') return { transaction_type: 'payment', status: 'voided' };
    return { transaction_type: 'payment', status: 'pending' };
}

function formatJobStatus(job) {
    if (!job) return '—';
    if (job.canceled === true) return 'Canceled';
    return job.status || '—';
}

function buildInvoiceSummary(invoice) {
    if (!invoice) return null;
    const status = invoice.status || 'unknown';
    const total = invoice.total || '0.00';
    const amountPaid = invoice.amount_paid || '0.00';
    const amountDue = invoice.amount_due || '0.00';
    const paidInFull = status === 'paid' || parseFloat(amountDue) === 0;
    return { status, total, amount_paid: amountPaid, amount_due: amountDue, paid_in_full: paidInFull };
}

// ─── Attachments extraction ──────────────────────────────────────────────────

const IMAGE_EXTS = /\.(jpe?g|png|webp|gif)$/i;

function extractAttachments(job) {
    if (!job) return [];
    const attachments = [];

    const processNotes = (notes, source) => {
        if (!Array.isArray(notes)) return;
        for (const note of notes) {
            const noteId = note.id || null;
            if (Array.isArray(note.images)) {
                for (const url of note.images) {
                    if (!url) continue;
                    attachments.push({
                        url,
                        kind: 'image',
                        source,
                        note_id: noteId,
                        filename: extractFilename(url),
                    });
                }
            }
            if (Array.isArray(note.files)) {
                for (const url of note.files) {
                    if (!url) continue;
                    const kind = IMAGE_EXTS.test(url) ? 'image' : 'file';
                    attachments.push({
                        url,
                        kind,
                        source,
                        note_id: noteId,
                        filename: extractFilename(url),
                    });
                }
            }
        }
    };

    if (job.customer && Array.isArray(job.customer.notes)) {
        processNotes(job.customer.notes, 'customer_note');
    }
    if (job.recurring_booking && Array.isArray(job.recurring_booking.recurring_notes)) {
        processNotes(job.recurring_booking.recurring_notes, 'recurring_note');
    }
    if (Array.isArray(job.job_notes)) {
        processNotes(job.job_notes, 'job_note');
    }
    if (Array.isArray(job.notes)) {
        processNotes(job.notes, 'job_note');
    }

    return attachments;
}

function extractFilename(url) {
    try {
        const pathname = new URL(url).pathname;
        const segments = pathname.split('/').filter(Boolean);
        return segments[segments.length - 1] || 'attachment';
    } catch {
        return 'attachment';
    }
}

// ─── Job / invoice id resolution ────────────────────────────────────────────
//
// A Zenbooker payment is linked to its job through the invoice
// (job → invoice → transaction). The job id, however, can surface on more than
// one place in the API payload depending on the transaction type, so resolving
// it from a SINGLE hop (`invoice.job_id`) silently drops the link whenever that
// one field is absent. We accept the id from the invoice OR the transaction,
// and from either the flat `*_id` form or a nested object — whichever is
// present. This is the core fix for payments that synced with no provider and
// no linked job. See resolveZbInvoiceId/resolveZbJobId tests.

function firstId(...candidates) {
    for (const c of candidates) {
        if (c === 0) continue;
        if (c != null && c !== '') return String(c);
    }
    return '';
}

// Read a flat id field off a ZB payload that may arrive in any of THREE shapes:
//  - a parsed object (the normal case),
//  - a JSON-encoded string (axios leaves res.data unparsed when the response
//    content-type isn't application/json — the invoice then lands double-encoded),
//  - or even MALFORMED JSON (ZB has shipped invoices like `..."price":}...` that
//    JSON.parse rejects).
// Reading across all three is what stops a job link from being silently dropped
// when `invoice.job_id` is present in the body but unreachable as a property —
// the root cause of payment 10754 ("payment without linked work").
function readField(source, key) {
    if (source == null) return undefined;
    if (typeof source === 'object') return source[key];
    if (typeof source === 'string') {
        try {
            const parsed = JSON.parse(source);
            if (parsed && typeof parsed === 'object') return parsed[key];
        } catch { /* malformed — fall through to a regex scan */ }
        const m = source.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
        return m ? m[1] : undefined;
    }
    return undefined;
}

/** Resolve the Zenbooker invoice id for a transaction (flat id or nested object). */
function resolveZbInvoiceId(txn) {
    return firstId(readField(txn, 'invoice_id'), txn?.invoice?.id);
}

/**
 * Resolve the Zenbooker job id for a transaction, preferring the invoice's job
 * reference and falling back to a job id carried directly on the transaction.
 * Tolerates string/double-encoded/malformed payloads via readField (see 10754).
 */
function resolveZbJobId(txn, invoice) {
    return firstId(
        readField(invoice, 'job_id'),
        (invoice && typeof invoice === 'object') ? invoice.job?.id : undefined,
        readField(txn, 'job_id'),
        (txn && typeof txn === 'object') ? txn.job?.id : undefined,
    );
}

// ─── Assemble row from raw ZB data ──────────────────────────────────────────

function assembleRow(txn, invoice, job) {
    const resolvedJobId = resolveZbJobId(txn, invoice);
    const canonicalTransaction = classifyZenbookerTransaction(txn);
    // missing_job_link drives the "details unavailable" warning + hides the job
    // tile. It means the full job BODY wasn't attached at sync time. Even when
    // it's true we now persist resolvedJobId below, so the row can still be
    // linked to a local job by its stable zenbooker_job_id on read.
    const missingJobLink = !job;

    const rawAmount = txn.amount_collected || txn.amount || '0.00';
    const amountPaid = parseFloat(rawAmount).toFixed(2);

    const tech = job?.assigned_providers
        ? job.assigned_providers.map(p => p.name).filter(Boolean).join(', ')
        : '—';

    let clientName = '—';
    if (job?.customer?.name) {
        clientName = job.customer.name;
    } else if (invoice?.primary_recipient?.name) {
        clientName = invoice.primary_recipient.name;
    }

    const invoiceSummary = buildInvoiceSummary(invoice);

    // Service address
    const serviceAddress = job?.service_address?.formatted
        || job?.customer?.addresses?.[0]?.formatted
        || null;

    // Provider details
    const providers = job?.assigned_providers || [];

    return {
        // List fields
        job_number: job?.job_number || '—',
        client: clientName,
        job_type: job?.service_name || '—',
        status: formatJobStatus(job),
        payment_methods: formatPaymentMethod(txn),
        display_payment_method: displayPaymentMethod(txn),
        amount_paid: amountPaid,
        tags: extractTags(job),
        payment_date: txn.payment_date || txn.created || '',
        source: extractSource(job),
        tech,
        custom_fields: extractCustomFields(job),
        transaction_id: txn.id,
        invoice_id: resolveZbInvoiceId(txn),
        job_id: resolvedJobId,
        transaction_status: txn.status || '',
        missing_job_link: missingJobLink,
        // Invoice summary
        invoice_status: invoiceSummary?.status || null,
        invoice_total: invoiceSummary?.total || null,
        invoice_amount_paid: invoiceSummary?.amount_paid || null,
        invoice_amount_due: invoiceSummary?.amount_due || null,
        invoice_paid_in_full: invoiceSummary?.paid_in_full || false,
        // Detail data
        job_detail: job ? {
            job_number: job.job_number || null,
            service_name: job.service_name || null,
            service_address: serviceAddress,
            providers: providers.map(p => ({
                id: p.id || null,
                name: p.name || null,
                email: p.email || null,
                phone: p.phone || null,
            })),
        } : null,
        invoice_detail: invoiceSummary,
        attachments: extractAttachments(job),
        metadata: {
            transaction_id: txn.id,
            invoice_id: txn.invoice_id || null,
            customer_id: txn.customer_id || null,
            territory_id: txn.territory_id || null,
            initiated_by: txn.initiated_by || null,
            team_member_id: txn.team_member_id || null,
            memo: txn.memo || null,
            canonical_payment_method: normalizeZenbookerPaymentMethod(txn.payment_method),
            canonical_transaction_type: canonicalTransaction.transaction_type,
            canonical_transaction_status: canonicalTransaction.status,
            zb_payment_method: txn.payment_method || null,
            zb_custom_payment_method_name: txn.custom_payment_method_name || null,
            zb_card_brand: txn.stripe_card_brand || null,
            zb_transaction_kind: txn.transaction_type || txn.type || txn.kind || txn.action || null,
            zb_transaction_status: txn.status || null,
        },
    };
}


/**
 * Debt #6 — upsert all of a company's zb_payments into payment_transactions.
 * Mirrors migration 104's mapping. Zenbooker-priority via ON CONFLICT DO UPDATE.
 * Idempotent and self-healing (re-projects the whole company each call).
 */
async function projectCompanyLedger(companyId, exec = db) {
    return exec.query(`
        INSERT INTO payment_transactions (
            company_id, job_id, transaction_type, payment_method, status,
            amount, currency, reference_number, external_id, external_source,
            memo, metadata, processed_at, created_at, updated_at
        )
        SELECT zp.company_id,
               j.id,
               CASE
                   WHEN lower(trim(COALESCE(
                       NULLIF(zp.zb_raw_transaction->>'transaction_type', ''),
                       NULLIF(zp.zb_raw_transaction->>'type', ''),
                       NULLIF(zp.zb_raw_transaction->>'kind', ''),
                       NULLIF(zp.zb_raw_transaction->>'action', ''),
                       ''
                   ))) ~ '(refund|reversal|reversed)'
                     OR lower(trim(COALESCE(zp.transaction_status, ''))) IN ('refund', 'refunded', 'reversal', 'reversed')
                     OR COALESCE(zp.amount_paid, 0) < 0
                   THEN 'adjustment'
                   ELSE 'payment'
               END,
               CASE
                   WHEN lower(trim(COALESCE(
                       NULLIF(zp.zb_raw_transaction->>'payment_method', ''),
                       NULLIF(split_part(zp.payment_methods, ' ', 1), ''),
                       NULLIF(zp.display_payment_method, ''),
                       ''
                   ))) IN ('stripe', 'card', 'credit_card')
                     OR lower(trim(COALESCE(
                       NULLIF(zp.zb_raw_transaction->>'payment_method', ''),
                       NULLIF(zp.payment_methods, ''),
                       NULLIF(zp.display_payment_method, ''),
                       ''
                     ))) LIKE 'stripe (%'
                   THEN 'zb_card'
                   WHEN lower(trim(COALESCE(
                       NULLIF(zp.zb_raw_transaction->>'payment_method', ''),
                       NULLIF(zp.payment_methods, ''), NULLIF(zp.display_payment_method, ''), ''
                   ))) IN ('check', 'cheque') THEN 'zb_check'
                   WHEN lower(trim(COALESCE(NULLIF(zp.zb_raw_transaction->>'payment_method', ''), NULLIF(zp.payment_methods, ''), NULLIF(zp.display_payment_method, ''), ''))) = 'cash' THEN 'zb_cash'
                   WHEN lower(trim(COALESCE(NULLIF(zp.zb_raw_transaction->>'payment_method', ''), NULLIF(zp.payment_methods, ''), NULLIF(zp.display_payment_method, ''), ''))) = 'ach' THEN 'zb_ach'
                   WHEN lower(trim(COALESCE(NULLIF(zp.zb_raw_transaction->>'payment_method', ''), NULLIF(zp.payment_methods, ''), NULLIF(zp.display_payment_method, ''), ''))) = 'venmo' THEN 'zb_venmo'
                   WHEN lower(trim(COALESCE(NULLIF(zp.zb_raw_transaction->>'payment_method', ''), NULLIF(zp.payment_methods, ''), NULLIF(zp.display_payment_method, ''), ''))) = 'zelle' THEN 'zb_zelle'
                   ELSE 'zb_other'
               END,
               CASE
                   WHEN lower(trim(COALESCE(
                       NULLIF(zp.zb_raw_transaction->>'transaction_type', ''),
                       NULLIF(zp.zb_raw_transaction->>'type', ''),
                       NULLIF(zp.zb_raw_transaction->>'kind', ''),
                       NULLIF(zp.zb_raw_transaction->>'action', ''),
                       ''
                   ))) ~ '(refund|reversal|reversed)'
                     OR lower(trim(COALESCE(zp.transaction_status, ''))) IN ('refund', 'refunded', 'reversal', 'reversed')
                     OR COALESCE(zp.amount_paid, 0) < 0
                   THEN 'pending'
                   WHEN lower(trim(COALESCE(zp.transaction_status, ''))) = 'succeeded' THEN 'completed'
                   WHEN lower(trim(COALESCE(zp.transaction_status, ''))) = 'failed'    THEN 'failed'
                   WHEN lower(trim(COALESCE(zp.transaction_status, ''))) = 'voided'    THEN 'voided'
                   ELSE 'pending'
               END,
               COALESCE(zp.amount_paid, 0), 'USD',
               NULLIF(zp.invoice_id, ''), zp.transaction_id, 'zenbooker',
               NULLIF(zp.client, '—'),
               jsonb_build_object('zb_job_id', zp.job_id, 'job_number', zp.job_number,
                   'job_type', zp.job_type, 'display_payment_method', zp.display_payment_method,
                   'invoice_status', zp.invoice_status, 'source', 'zb_sync_writethrough',
                   'zb_payment_method', NULLIF(zp.zb_raw_transaction->>'payment_method', ''),
                   'zb_custom_payment_method_name', NULLIF(zp.zb_raw_transaction->>'custom_payment_method_name', ''),
                   'zb_card_brand', NULLIF(zp.zb_raw_transaction->>'stripe_card_brand', ''),
                   'zb_transaction_kind', COALESCE(
                       NULLIF(zp.zb_raw_transaction->>'transaction_type', ''),
                       NULLIF(zp.zb_raw_transaction->>'type', ''),
                       NULLIF(zp.zb_raw_transaction->>'kind', ''),
                       NULLIF(zp.zb_raw_transaction->>'action', '')
                   ),
                   'zb_transaction_status', NULLIF(zp.transaction_status, '')),
               zp.payment_date, zp.created_at, now()
        FROM zb_payments zp
        LEFT JOIN jobs j ON j.zenbooker_job_id = zp.job_id AND j.company_id = zp.company_id
        WHERE zp.company_id = $1
        ON CONFLICT (company_id, external_id) WHERE external_source = 'zenbooker'
        DO UPDATE SET job_id = EXCLUDED.job_id,
            transaction_type = EXCLUDED.transaction_type,
            status = EXCLUDED.status,
            amount = EXCLUDED.amount, payment_method = EXCLUDED.payment_method,
            memo = EXCLUDED.memo,
            metadata = COALESCE(payment_transactions.metadata, '{}'::jsonb) || EXCLUDED.metadata,
            processed_at = EXCLUDED.processed_at, updated_at = now()
    `, [companyId]);
}

// =============================================================================
// reconcileJobLinks — heal payments that synced with no provider / no job link
// =============================================================================

// 1) Backfill a missing zb_payments.job_id from the raw payloads we already
//    stored (no Zenbooker API calls). Covers rows synced before the resolver
//    fix, where the job id lives in the raw invoice/transaction JSON.
const RECONCILE_BACKFILL_JOB_ID_SQL = `
    UPDATE zb_payments zp
    SET job_id = COALESCE(
            NULLIF(zp.zb_raw_invoice->>'job_id', ''),
            NULLIF(zp.zb_raw_invoice->'job'->>'id', ''),
            NULLIF(zp.zb_raw_transaction->>'job_id', ''),
            NULLIF(zp.zb_raw_transaction->'job'->>'id', '')
        ),
        updated_at = now()
    WHERE zp.company_id = $1
      AND NULLIF(zp.job_id, '') IS NULL
      AND COALESCE(
            NULLIF(zp.zb_raw_invoice->>'job_id', ''),
            NULLIF(zp.zb_raw_invoice->'job'->>'id', ''),
            NULLIF(zp.zb_raw_transaction->>'job_id', ''),
            NULLIF(zp.zb_raw_transaction->'job'->>'id', '')
          ) IS NOT NULL`;

// 2) For payments whose ZB job is already synced into the local jobs table,
//    repopulate the denormalised display fields (provider/tech, job number,
//    job tile) straight from that local job — again, no Zenbooker API calls.
//    This is what makes the "no provider / no linked job" rows whole again.
const RECONCILE_HEAL_FROM_LOCAL_JOBS_SQL = `
    UPDATE zb_payments zp
    SET missing_job_link = false,
        job_number = COALESCE(NULLIF(j.job_number, ''), zp.job_number),
        job_type   = COALESCE(NULLIF(j.service_name, ''), zp.job_type),
        status     = CASE WHEN j.zb_canceled THEN 'Canceled'
                          ELSE COALESCE(NULLIF(j.zb_status, ''), zp.status) END,
        tech       = COALESCE((
                        SELECT string_agg(elem->>'name', ', ')
                        FROM jsonb_array_elements(COALESCE(j.assigned_techs, '[]'::jsonb)) elem
                        WHERE COALESCE(elem->>'name', '') <> ''
                     ), '—'),
        job_detail = jsonb_build_object(
                        'job_number',      j.job_number,
                        'service_name',    j.service_name,
                        'service_address', j.address,
                        'providers',       COALESCE(j.assigned_techs, '[]'::jsonb)
                     ),
        updated_at = now()
    FROM jobs j
    WHERE zp.company_id = $1
      AND j.company_id = zp.company_id
      AND NULLIF(zp.job_id, '') IS NOT NULL
      AND j.zenbooker_job_id = zp.job_id
      AND (zp.missing_job_link = true OR zp.job_detail IS NULL OR zp.job_number = '—')`;

/**
 * Re-link a company's payments to their jobs and refresh the ledger.
 *
 * SQL-only and idempotent — it never calls the Zenbooker API; it reuses the
 * raw payloads on zb_payments and the already-synced local jobs table. Run it
 * to heal historically broken rows. Pass { dryRun: true } to preview counts
 * without writing.
 *
 * Rows that remain unlinked are payments whose ZB job isn't in the local jobs
 * table yet and require manual review.
 */
async function reconcileJobLinks(companyId, { dryRun = false } = {}) {
    if (!companyId) throw new Error('reconcileJobLinks requires a companyId');

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const backfilled = await client.query(RECONCILE_BACKFILL_JOB_ID_SQL, [companyId]);
        const healed = await client.query(RECONCILE_HEAL_FROM_LOCAL_JOBS_SQL, [companyId]);
        const projected = await projectCompanyLedger(companyId, client);

        const { rows } = await client.query(
            `SELECT
                count(*) FILTER (WHERE missing_job_link = true)        AS still_missing_body,
                count(*) FILTER (WHERE NULLIF(job_id, '') IS NULL)     AS still_no_job_id
             FROM zb_payments WHERE company_id = $1`,
            [companyId]
        );

        if (dryRun) await client.query('ROLLBACK');
        else await client.query('COMMIT');

        const summary = {
            company_id: companyId,
            dry_run: dryRun,
            backfilled_job_id: backfilled.rowCount,
            healed_from_local_jobs: healed.rowCount,
            ledger_rows_projected: projected.rowCount,
            still_missing_job_body: parseInt(rows[0].still_missing_body, 10),
            still_no_job_id: parseInt(rows[0].still_no_job_id, 10),
        };
        console.log(`[PaymentsService] reconcileJobLinks ${dryRun ? '(dry-run) ' : ''}`, summary);
        return summary;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

module.exports = {
    projectCompanyLedger,
    reconcileJobLinks,
    // Exported for testing
    assembleRow,
    resolveZbJobId,
    resolveZbInvoiceId,
    extractSource,
    extractTags,
    formatPaymentMethod,
    displayPaymentMethod,
    normalizeZenbookerPaymentMethod,
    classifyZenbookerTransaction,
    buildInvoiceSummary,
    extractAttachments,
    extractCustomFields,
};
