/**
 * Zenbooker Payments Data Service (legacy imports)
 *
 * Relocated from services/paymentsService.js during PF004 Sprint 5.
 * Local storage layer for Zenbooker payments/transactions.
 * Provides fast DB reads for the Payments page over frozen imported history.
 *
 * Functions:
 *   listPayments(companyId, opts)              — read from DB with filters
 *   getPaymentDetail(companyId, transactionId) — read single payment from DB
 */

const db = require('../db/connection');
const { logFinancialActivity } = require('./financialActivityService');
const {
    createCursorFingerprint,
    encodeCursor,
    decodeCursor,
    assertCursorOffsetExclusive,
    buildKeysetPredicate,
    timestampCursorExpression,
    bigintCursorExpression,
} = require('../utils/listCursor');

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

// =============================================================================
// Payments page ledger reads — payment_transactions is authoritative
// =============================================================================

// PAY-LEDGER-UNIFY-001: payment_transactions drives row identity, money,
// status, dates, and deposited state.  The unique, company-scoped zb_payments
// join is presentation-only for historical ZB attachments/invoice detail.
const PAYMENT_LEDGER_ROWS_SQL = `
    SELECT
        t.company_id,
        t.id,
        COALESCE(t.external_id, t.id::text) AS transaction_id,
        CASE
            WHEN t.external_source = 'zenbooker'
                THEN COALESCE(NULLIF(zp.invoice_id, ''), NULLIF(t.reference_number, ''), '')
            ELSE COALESCE(t.invoice_id::text, '')
        END AS invoice_id,
        CASE
            WHEN t.external_source = 'zenbooker'
                THEN COALESCE(NULLIF(t.metadata->>'zb_job_id', ''), NULLIF(zp.job_id, ''), '')
            ELSE COALESCE(COALESCE(t.job_id, i.job_id)::text, '')
        END AS job_id,
        COALESCE(local_job.id, zb_job.id) AS local_job_id,
        COALESCE(t.contact_id, i.contact_id, local_job.contact_id, zb_job.contact_id) AS contact_id,
        t.invoice_id AS canonical_invoice_id,
        COALESCE(t.job_id, i.job_id, local_job.id, zb_job.id) AS canonical_job_id,
        COALESCE(NULLIF(local_job.job_number, ''), NULLIF(zb_job.job_number, ''),
                 NULLIF(zp.job_number, ''), NULLIF(t.metadata->>'job_number', ''), '—') AS job_number,
        COALESCE(NULLIF(c.full_name, ''), NULLIF(local_job.customer_name, ''),
                 NULLIF(zb_job.customer_name, ''), NULLIF(zp.client, ''),
                 CASE WHEN t.external_source = 'zenbooker' THEN NULLIF(t.memo, '') END, '—') AS client,
        COALESCE(NULLIF(local_job.service_name, ''), NULLIF(zb_job.service_name, ''),
                 NULLIF(zp.job_type, ''), NULLIF(t.metadata->>'job_type', ''), '—') AS job_type,
        COALESCE(NULLIF(local_job.blanc_status, ''), NULLIF(zb_job.blanc_status, ''),
                 NULLIF(zp.status, ''), '—') AS status,
        t.transaction_type,
        t.payment_method,
        CASE
            WHEN t.external_source = 'zenbooker' AND NULLIF(zp.payment_methods, '') IS NOT NULL
                THEN zp.payment_methods
            WHEN t.payment_method IN ('credit_card', 'zb_card') THEN 'card'
            WHEN t.payment_method IN ('check', 'zb_check') THEN 'check'
            WHEN t.payment_method IN ('cash', 'zb_cash') THEN 'cash'
            WHEN t.payment_method IN ('ach', 'zb_ach') THEN 'ach'
            WHEN t.payment_method = 'zb_venmo' THEN 'venmo'
            WHEN t.payment_method = 'zb_zelle' THEN 'zelle'
            ELSE 'other'
        END AS payment_methods,
        CASE
            WHEN t.external_source = 'zenbooker' AND NULLIF(zp.display_payment_method, '') IS NOT NULL
                THEN zp.display_payment_method
            WHEN t.payment_method IN ('credit_card', 'zb_card') THEN 'Card'
            WHEN t.payment_method IN ('check', 'zb_check') THEN 'check'
            WHEN t.payment_method IN ('cash', 'zb_cash') THEN 'cash'
            WHEN t.payment_method IN ('ach', 'zb_ach') THEN 'ACH'
            WHEN t.payment_method = 'zb_venmo' THEN 'Venmo'
            WHEN t.payment_method = 'zb_zelle' THEN 'Zelle'
            ELSE 'Other'
        END AS display_payment_method,
        t.amount AS amount_paid,
        t.amount,
        t.currency,
        COALESCE(t.processed_at, t.created_at) AS payment_date,
        COALESCE(NULLIF(local_job.job_source, ''), NULLIF(zb_job.job_source, ''),
                 NULLIF(zp.source, ''), '') AS source,
        COALESCE(NULLIF(provider_data.tech, ''), '—') AS tech,
        COALESCE(provider_data.provider_names, ARRAY[]::text[]) AS provider_names,
        CASE WHEN t.status = 'completed' THEN 'succeeded' ELSE t.status END AS transaction_status,
        t.status AS payment_status,
        CASE
            WHEN COALESCE(local_job.id, zb_job.id) IS NOT NULL THEN false
            WHEN t.external_source = 'zenbooker' THEN COALESCE(zp.missing_job_link, true)
            ELSE false
        END AS missing_job_link,
        COALESCE(i.status, zp.invoice_status) AS invoice_status,
        COALESCE(i.total, zp.invoice_total) AS invoice_total,
        COALESCE(i.amount_paid, zp.invoice_amount_paid) AS invoice_amount_paid,
        COALESCE(i.balance_due, zp.invoice_amount_due) AS invoice_amount_due,
        CASE
            WHEN i.id IS NOT NULL THEN i.balance_due <= 0
            ELSE COALESCE(zp.invoice_paid_in_full, false)
        END AS invoice_paid_in_full,
        COALESCE((t.metadata->>'check_deposited') = 'true', false) AS check_deposited,
        CASE
            WHEN t.payment_method IN ('check', 'zb_check') THEN true
            WHEN LOWER(BTRIM(COALESCE(zp.display_payment_method, ''))) IN ('check', 'cheque') THEN true
            WHEN LOWER(COALESCE(zp.payment_methods, '')) LIKE '%check%' THEN true
            ELSE false
        END AS is_check,
        COALESCE(zp.tags, '') AS tags,
        COALESCE(custom_fields.value, '') AS custom_fields,
        t.reference_number,
        t.reference_number AS reference,
        t.memo,
        t.external_id,
        t.external_source,
        CASE
            WHEN i.id IS NOT NULL THEN jsonb_build_object(
                'status', i.status,
                'total', i.total::text,
                'amount_paid', i.amount_paid::text,
                'amount_due', i.balance_due::text,
                'paid_in_full', i.balance_due <= 0
            )
            ELSE zp.invoice_detail
        END AS invoice_detail,
        CASE
            WHEN COALESCE(local_job.id, zb_job.id) IS NOT NULL THEN jsonb_build_object(
                'job_number', COALESCE(local_job.job_number, zb_job.job_number),
                'service_name', COALESCE(local_job.service_name, zb_job.service_name),
                'service_address', COALESCE(local_job.address, zb_job.address),
                'providers', COALESCE(provider_data.providers, '[]'::jsonb)
            )
            ELSE zp.job_detail
        END AS job_detail,
        CASE WHEN t.external_source = 'zenbooker'
             THEN COALESCE(zp.attachments, '[]'::jsonb)
             ELSE '[]'::jsonb
        END AS attachments,
        (
            COALESCE(zp.metadata, '{}'::jsonb)
            || COALESCE(t.metadata, '{}'::jsonb)
        ) - 'pay_ledger_unify_001_check_deposited_backfill' AS metadata
    FROM payment_transactions t
    LEFT JOIN invoices i
      ON i.company_id = t.company_id
     AND i.id = t.invoice_id
    LEFT JOIN jobs local_job
      ON local_job.company_id = t.company_id
     AND local_job.id = COALESCE(t.job_id, i.job_id)
    LEFT JOIN jobs zb_job
      ON zb_job.company_id = t.company_id
     AND t.external_source = 'zenbooker'
     AND local_job.id IS NULL
     AND zb_job.zenbooker_job_id = NULLIF(t.metadata->>'zb_job_id', '')
    LEFT JOIN contacts c
      ON c.company_id = t.company_id
     AND c.id = COALESCE(t.contact_id, i.contact_id, local_job.contact_id, zb_job.contact_id)
    LEFT JOIN zb_payments zp
      ON zp.company_id = t.company_id
     AND t.external_source = 'zenbooker'
     AND zp.transaction_id = t.external_id
    LEFT JOIN LATERAL (
        SELECT
            COALESCE(jsonb_agg(provider.value ORDER BY provider.ordinality), '[]'::jsonb) AS providers,
            COALESCE(string_agg(BTRIM(provider.value->>'name'), ', ' ORDER BY provider.ordinality), '') AS tech,
            COALESCE(
                array_agg(BTRIM(provider.value->>'name') ORDER BY provider.ordinality),
                ARRAY[]::text[]
            ) AS provider_names
        FROM jsonb_array_elements(
            CASE
                WHEN jsonb_typeof(COALESCE(local_job.assigned_techs, zb_job.assigned_techs, '[]'::jsonb)) = 'array'
                    THEN COALESCE(local_job.assigned_techs, zb_job.assigned_techs, '[]'::jsonb)
                ELSE '[]'::jsonb
            END
        ) WITH ORDINALITY AS provider(value, ordinality)
        WHERE BTRIM(COALESCE(provider.value->>'name', '')) <> ''
    ) provider_data ON true
    LEFT JOIN LATERAL (
        SELECT COALESCE(string_agg(field.value, '; ' ORDER BY field.key), '') AS value
        FROM jsonb_each_text(
            CASE
                WHEN jsonb_typeof(COALESCE(local_job.metadata, zb_job.metadata, '{}'::jsonb)) = 'object'
                    THEN COALESCE(local_job.metadata, zb_job.metadata, '{}'::jsonb)
                ELSE '{}'::jsonb
            END
        ) AS field(key, value)
        WHERE field.value <> ''
    ) custom_fields ON true
    WHERE t.company_id = $1
`;

const PAYMENT_LIST_SORTS = Object.freeze({
    payment_date: { expression: 'p.payment_date', type: 'timestamp', nullable: true },
    amount_paid: { expression: 'COALESCE(p.amount_paid, 0)', type: 'numeric' },
    invoice_amount_due: { expression: 'COALESCE(p.invoice_amount_due, 0)', type: 'numeric' },
    job_number: { expression: `LOWER(COALESCE(p.job_number, '')) COLLATE "C"`, type: 'text' },
    client: { expression: `LOWER(COALESCE(p.client, '')) COLLATE "C"`, type: 'text' },
    payment_methods: { expression: `LOWER(COALESCE(p.payment_methods, '')) COLLATE "C"`, type: 'text' },
    tech: { expression: `LOWER(COALESCE(p.tech, '')) COLLATE "C"`, type: 'text' },
});

function paymentsListError(code, message, statusCode) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

async function listPayments(companyId, {
    dateFrom, dateTo, paymentMethod, quickFilter, search, provider, paidStatus,
    sortField = 'payment_date', sortDir = 'desc',
    offset, limit = 50, cursor,
} = {}) {
    if (!companyId) {
        throw paymentsListError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 1000) {
        throw paymentsListError('INVALID_QUERY', 'limit must be an integer from 1 to 1000', 400);
    }
    const pageLimit = Number(limit);
    if (offset !== undefined && (!Number.isInteger(Number(offset)) || Number(offset) < 0)) {
        throw paymentsListError('INVALID_QUERY', 'offset must be a non-negative integer', 400);
    }
    assertCursorOffsetExclusive(cursor, offset);
    if (!PAYMENT_LIST_SORTS[sortField]) {
        throw paymentsListError('INVALID_QUERY', 'Invalid payment sort field', 400);
    }
    if (sortDir !== 'asc' && sortDir !== 'desc') {
        throw paymentsListError('INVALID_QUERY', 'Invalid payment sort direction', 400);
    }
    if (quickFilter !== undefined && quickFilter !== '' && quickFilter !== 'all' && quickFilter !== 'new_checks') {
        throw paymentsListError('INVALID_QUERY', 'Invalid payment quick filter', 400);
    }
    if (paidStatus !== undefined && paidStatus !== '' && paidStatus !== 'paid' && paidStatus !== 'due') {
        throw paymentsListError('INVALID_QUERY', 'Invalid payment paid status', 400);
    }

    const mode = offset === undefined ? 'cursor' : 'offset';
    const normalizedPaymentMethod = typeof paymentMethod === 'string' ? paymentMethod.trim() : '';
    const normalizedSearch = typeof search === 'string' ? search.trim() : '';
    const normalizedProvider = typeof provider === 'string' ? provider.trim() : '';
    if ((paymentMethod != null && typeof paymentMethod !== 'string')
        || (search != null && typeof search !== 'string')
        || (provider != null && typeof provider !== 'string')) {
        throw paymentsListError('INVALID_QUERY', 'Payment filters must be strings', 400);
    }

    const sort = PAYMENT_LIST_SORTS[sortField];
    const fingerprint = createCursorFingerprint({
        endpoint: 'payments',
        generation: 'payment-transactions-v2',
        company: String(companyId),
        filters: {
            date_from: dateFrom || null,
            date_to: dateTo || null,
            payment_method: normalizedPaymentMethod.toLocaleLowerCase('en-US'),
            quick_filter: quickFilter || 'all',
            search: normalizedSearch.toLocaleLowerCase('en-US'),
            provider: normalizedProvider,
            paid_status: paidStatus || null,
        },
        sort: sortField,
        direction: sortDir,
        limit: pageLimit,
    });
    const cursorValueTypes = sort.nullable
        ? ['boolean', { type: sort.type, nullable: true }, 'bigint']
        : [sort.type, 'bigint'];
    const cursorExpectation = {
        endpoint: 'payments',
        sort: sortField,
        direction: sortDir,
        fingerprint,
        valueTypes: cursorValueTypes,
    };
    const decodedCursor = cursor ? decodeCursor(cursor, cursorExpectation) : null;

    const baseConditions = ['p.company_id = $1'];
    const params = [companyId];

    if (dateFrom) {
        params.push(dateFrom);
        baseConditions.push(`p.payment_date >= $${params.length}::date`);
    }
    if (dateTo) {
        // Add 1 day to include the entire "to" date.
        params.push(dateTo);
        baseConditions.push(`p.payment_date < ($${params.length}::date + interval '1 day')`);
    }
    if (normalizedPaymentMethod) {
        params.push(`%${normalizedPaymentMethod}%`);
        baseConditions.push(`(
            p.payment_methods ILIKE $${params.length}
            OR p.display_payment_method ILIKE $${params.length}
            OR p.payment_method ILIKE $${params.length}
        )`);
    }
    if (quickFilter === 'new_checks') {
        baseConditions.push('p.is_check IS TRUE');
        baseConditions.push('p.check_deposited IS NOT TRUE');
    }
    if (normalizedSearch) {
        params.push(`%${normalizedSearch}%`);
        baseConditions.push(`(
            p.client ILIKE $${params.length}
            OR p.job_number ILIKE $${params.length}
            OR p.tags ILIKE $${params.length}
            OR p.source ILIKE $${params.length}
            OR p.transaction_id ILIKE $${params.length}
            OR COALESCE(p.reference_number, '') ILIKE $${params.length}
            OR COALESCE(p.memo, '') ILIKE $${params.length}
            OR COALESCE(p.external_source, '') ILIKE $${params.length}
        )`);
    }

    const finalConditions = baseConditions.slice();
    if (normalizedProvider) {
        params.push(normalizedProvider);
        finalConditions.push(`$${params.length} = ANY(p.provider_names)`);
    }
    if (paidStatus === 'paid') {
        finalConditions.push('p.invoice_paid_in_full IS TRUE');
    } else if (paidStatus === 'due') {
        finalConditions.push('p.invoice_paid_in_full IS NOT TRUE');
    }

    const baseWhere = baseConditions.join(' AND ');
    const finalWhere = finalConditions.join(' AND ');
    const isFirstPage = !decodedCursor && (mode === 'cursor' || Number(offset) === 0);
    let total = null;
    let aggregates = null;
    let facets = null;

    if (isFirstPage) {
        const metadataResult = await db.query(
            `WITH ledger_rows AS (
                ${PAYMENT_LEDGER_ROWS_SQL}
             ), base_rows AS (
                SELECT p.display_payment_method, p.provider_names, p.check_deposited, p.is_check
                FROM ledger_rows p
                WHERE ${baseWhere}
             ), aggregate AS (
                SELECT COUNT(*)::int AS transaction_count,
                       COALESCE(SUM(COALESCE(p.amount_paid, 0)), 0)::text AS total_amount
                FROM ledger_rows p
                WHERE ${finalWhere}
             )
             SELECT aggregate.transaction_count,
                    aggregate.total_amount,
                    COALESCE((
                        SELECT json_agg(method_rows.method ORDER BY method_rows.method)
                        FROM (
                            SELECT DISTINCT BTRIM(base_rows.display_payment_method) AS method
                            FROM base_rows
                            WHERE BTRIM(COALESCE(base_rows.display_payment_method, '')) <> ''
                        ) method_rows
                    ), '[]'::json) AS payment_methods,
                    COALESCE((
                        SELECT json_agg(provider_rows.provider ORDER BY provider_rows.provider)
                        FROM (
                            SELECT DISTINCT provider_name.value AS provider
                            FROM base_rows
                            CROSS JOIN LATERAL unnest(base_rows.provider_names) AS provider_name(value)
                            WHERE BTRIM(provider_name.value) <> ''
                        ) provider_rows
                    ), '[]'::json) AS providers,
                    (
                        SELECT COUNT(*)::int
                        FROM base_rows
                        WHERE base_rows.is_check IS TRUE
                          AND base_rows.check_deposited IS NOT TRUE
                    ) AS undeposited_check_count
             FROM aggregate`,
            params,
        );
        const metadata = metadataResult.rows[0] || {};
        total = Number(metadata.transaction_count || 0);
        aggregates = {
            transaction_count: total,
            total_amount: metadata.total_amount || '0',
        };
        facets = {
            payment_methods: metadata.payment_methods || [],
            providers: metadata.providers || [],
            undeposited_check_count: Number(metadata.undeposited_check_count || 0),
        };
    }

    const pageParams = params.slice();
    const cursorKeys = [];
    const cursorProjections = [];
    const orderParts = [];
    if (sort.nullable) {
        cursorKeys.push({ expression: `(${sort.expression} IS NULL)`, direction: 'asc', type: 'boolean' });
        cursorProjections.push(`(${sort.expression} IS NULL) AS __cursor_null`);
        orderParts.push(`(${sort.expression} IS NULL) ASC`);
    }
    cursorKeys.push({
        expression: sort.expression,
        direction: sortDir,
        type: sort.type,
        nullable: sort.nullable === true,
    });
    cursorKeys.push({ expression: 'p.id', direction: sortDir, type: 'bigint' });
    if (sort.type === 'timestamp') {
        cursorProjections.push(`${timestampCursorExpression(sort.expression)} AS __cursor_value`);
    } else if (sort.type === 'numeric') {
        cursorProjections.push(`(${sort.expression})::text AS __cursor_value`);
    } else {
        cursorProjections.push(`${sort.expression} AS __cursor_value`);
    }
    cursorProjections.push(`${bigintCursorExpression('p.id')} AS __cursor_id`);
    orderParts.push(`${sort.expression} ${sortDir.toUpperCase()}`, `p.id ${sortDir.toUpperCase()}`);

    let cursorPredicate = '';
    if (decodedCursor) {
        const keyset = buildKeysetPredicate(cursorKeys, decodedCursor.values, pageParams.length + 1);
        cursorPredicate = ` AND ${keyset.sql}`;
        pageParams.push(...keyset.params);
    }
    const limitParam = pageParams.length + 1;
    pageParams.push(pageLimit + 1);
    let offsetSql = '';
    if (mode === 'offset') {
        const offsetParam = pageParams.length + 1;
        pageParams.push(Number(offset));
        offsetSql = ` OFFSET $${offsetParam}`;
    }

    const rowsResult = await db.query(
        `WITH ledger_rows AS (
            ${PAYMENT_LEDGER_ROWS_SQL}
         )
         SELECT
            p.id, p.transaction_id, p.invoice_id, p.job_id, p.local_job_id,
            p.job_number, p.client, p.job_type, p.status,
            p.payment_methods, p.display_payment_method, p.payment_method,
            p.amount_paid::text AS amount_paid,
            p.amount::text AS amount, p.currency,
            p.tags, p.payment_date, p.source, p.tech,
            p.transaction_status, p.payment_status, p.transaction_type,
            p.missing_job_link,
            p.invoice_status,
            p.invoice_total::text AS invoice_total,
            p.invoice_amount_paid::text AS invoice_amount_paid,
            p.invoice_amount_due::text AS invoice_amount_due,
            p.invoice_paid_in_full,
            p.check_deposited,
            p.custom_fields,
            p.contact_id, p.canonical_invoice_id, p.canonical_job_id,
            p.reference_number, p.reference, p.memo,
            p.external_id, p.external_source,
            ${cursorProjections.join(', ')}
         FROM ledger_rows p
         WHERE ${finalWhere}${cursorPredicate}
         ORDER BY ${orderParts.join(', ')}
         LIMIT $${limitParam}${offsetSql}`,
        pageParams,
    );
    const probedRows = rowsResult.rows;
    const pageRows = probedRows.slice(0, pageLimit);
    const hasMore = probedRows.length > pageLimit;
    const rows = pageRows.map(({
        __cursor_null,
        __cursor_value,
        __cursor_id,
        ...row
    }) => {
        void __cursor_null;
        void __cursor_value;
        void __cursor_id;
        return {
            ...row,
            amount_paid: row.amount_paid || '0.00',
            invoice_total: row.invoice_total || null,
            invoice_amount_paid: row.invoice_amount_paid || null,
            invoice_amount_due: row.invoice_amount_due || null,
        };
    });
    const lastPageRow = pageRows.at(-1);
    const cursorValues = lastPageRow
        ? [
            ...(sort.nullable ? [Boolean(lastPageRow.__cursor_null)] : []),
            lastPageRow.__cursor_value == null ? null : String(lastPageRow.__cursor_value),
            String(lastPageRow.__cursor_id),
        ]
        : [];
    const nextCursor = mode === 'cursor' && hasMore && lastPageRow
        ? encodeCursor({
            endpoint: 'payments',
            sort: sortField,
            direction: sortDir,
            fingerprint,
            values: cursorValues,
        }, cursorExpectation)
        : null;

    return {
        rows,
        total,
        aggregates,
        facets,
        pagination: {
            mode,
            limit: pageLimit,
            returned: rows.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            total,
        },
    };
}

// =============================================================================
// listPaymentsForExport — Enriched with Albusto job data (source, custom fields)
// =============================================================================

async function listPaymentsForExport(companyId, { dateFrom, dateTo, paymentMethod, search } = {}) {
    if (!companyId) {
        throw paymentsListError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    const conditions = ['p.company_id = $1'];
    const params = [companyId];
    let paramIdx = 2;

    if (dateFrom) {
        conditions.push(`p.payment_date >= $${paramIdx}`);
        params.push(dateFrom);
        paramIdx++;
    }
    if (dateTo) {
        conditions.push(`p.payment_date < ($${paramIdx}::date + interval '1 day')`);
        params.push(dateTo);
        paramIdx++;
    }
    if (paymentMethod) {
        conditions.push(`(
            p.payment_methods ILIKE $${paramIdx}
            OR p.display_payment_method ILIKE $${paramIdx}
            OR p.payment_method ILIKE $${paramIdx}
        )`);
        params.push(`%${paymentMethod}%`);
        paramIdx++;
    }
    if (search && search.trim()) {
        const q = `%${search.trim()}%`;
        conditions.push(`(
            p.client ILIKE $${paramIdx}
            OR p.job_number ILIKE $${paramIdx}
            OR p.tags ILIKE $${paramIdx}
            OR p.source ILIKE $${paramIdx}
            OR p.transaction_id ILIKE $${paramIdx}
            OR COALESCE(p.reference_number, '') ILIKE $${paramIdx}
            OR COALESCE(p.memo, '') ILIKE $${paramIdx}
            OR COALESCE(p.external_source, '') ILIKE $${paramIdx}
        )`);
        params.push(q);
        paramIdx++;
    }

    const where = conditions.join(' AND ');

    const result = await db.query(
        `WITH ledger_rows AS (
            ${PAYMENT_LEDGER_ROWS_SQL}
         )
         SELECT
            p.job_number,
            p.client,
            p.job_type,
            p.status,
            p.payment_methods,
            p.amount_paid::text as amount_paid,
            p.payment_date,
            p.tags,
            p.source,
            p.tech,
            p.custom_fields,
            p.payment_method,
            p.payment_status,
            p.reference_number,
            p.memo,
            p.external_source
        FROM ledger_rows p
        WHERE ${where}
        ORDER BY p.payment_date DESC`,
        params
    );
    return result.rows;
}

// =============================================================================
// getPaymentDetail — Read single payment from DB
// =============================================================================

async function getPaymentDetail(companyId, paymentId) {
    if (!companyId) return null;
    const result = await db.query(
        `WITH ledger_rows AS (
            ${PAYMENT_LEDGER_ROWS_SQL}
         )
         SELECT p.*
        FROM ledger_rows p
        WHERE p.company_id = $1 AND p.id = $2`,
        [companyId, paymentId]
    );

    if (result.rows.length === 0) return null;

    const r = result.rows[0];

    const detailMetadata = Object.fromEntries(Object.entries(r.metadata || {}).map(([key, value]) => [
        key,
        value == null ? null : (typeof value === 'object' ? JSON.stringify(value) : String(value)),
    ]));

    return {
        // Internal Albusto ID
        id: r.id,
        // Flat row fields
        job_number: r.job_number,
        client: r.client,
        job_type: r.job_type,
        status: r.status,
        payment_methods: r.payment_methods,
        display_payment_method: r.display_payment_method,
        payment_method: r.payment_method,
        amount_paid: r.amount_paid || '0.00',
        amount: r.amount || r.amount_paid || '0.00',
        currency: r.currency,
        tags: r.tags,
        payment_date: r.payment_date,
        source: r.source,
        tech: r.tech,
        transaction_id: r.transaction_id,
        invoice_id: r.invoice_id || '',
        job_id: r.job_id || '',
        local_job_id: r.local_job_id || null,
        transaction_status: r.transaction_status,
        payment_status: r.payment_status,
        transaction_type: r.transaction_type,
        missing_job_link: r.missing_job_link,
        invoice_status: r.invoice_status,
        invoice_total: r.invoice_total,
        invoice_amount_paid: r.invoice_amount_paid,
        invoice_amount_due: r.invoice_amount_due,
        invoice_paid_in_full: r.invoice_paid_in_full,
        check_deposited: r.check_deposited || false,
        contact_id: r.contact_id || null,
        canonical_invoice_id: r.canonical_invoice_id || null,
        canonical_job_id: r.canonical_job_id || null,
        reference_number: r.reference_number || null,
        reference: r.reference || null,
        memo: r.memo || null,
        external_id: r.external_id || null,
        external_source: r.external_source || null,
        // Detail data (JSONB)
        invoice: r.invoice_detail || null,
        job: r.job_detail || null,
        attachments: r.attachments || [],
        metadata: detailMetadata,
        _warning: r.missing_job_link ? 'Some job details are unavailable right now.' : null,
    };
}

// =============================================================================
// updateCheckDeposited — Toggle check_deposited flag
// =============================================================================

async function updateCheckDeposited(
    companyId,
    paymentId,
    deposited,
    client = null,
    activityActor = null
) {
    const runner = client || db;
    const result = await runner.query(
        `UPDATE payment_transactions
            SET metadata = jsonb_set(
                    COALESCE(metadata, '{}'::jsonb),
                    '{check_deposited}',
                    to_jsonb($3::boolean),
                    true
                ) - 'pay_ledger_unify_001_check_deposited_backfill',
                updated_at = now()
            WHERE company_id = $1 AND id = $2
            RETURNING id, job_id, contact_id, invoice_id, estimate_id,
                      COALESCE((metadata->>'check_deposited') = 'true', false) AS check_deposited`,
        [companyId, paymentId, !!deposited]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: row.check_deposited
                ? 'payment.check_deposited'
                : 'payment.check_deposit_reopened',
            entity: {
                id: row.id,
                job_id: row.job_id,
                contact_id: row.contact_id,
                invoice_id: row.invoice_id,
                estimate_id: row.estimate_id,
            },
            actor: activityActor,
            summary: {
                status: row.check_deposited ? 'deposited' : 'not_deposited',
            },
        }, { client });
    }
    return { check_deposited: row.check_deposited };
}

module.exports = {
    projectCompanyLedger,
    reconcileJobLinks,
    listPayments,
    listPaymentsForExport,
    getPaymentDetail,
    updateCheckDeposited,
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
