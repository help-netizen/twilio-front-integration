/**
 * Zenbooker Payments Sync Service (legacy)
 *
 * Relocated from services/paymentsService.js during PF004 Sprint 5.
 * Local storage layer for Zenbooker payments/transactions.
 * Syncs from Zenbooker API and provides fast DB reads for the Payments page.
 *
 * Functions:
 *   syncPayments(companyId, dateFrom, dateTo) — fetch from ZB API, upsert into DB
 *   listPayments(companyId, opts)              — read from DB with filters
 *   getPaymentDetail(companyId, transactionId) — read single payment from DB
 */

const db = require('../db/connection');
const zenbookerClient = require('./zenbookerClient');
const {
    createCursorFingerprint,
    encodeCursor,
    decodeCursor,
    assertCursorOffsetExclusive,
    buildKeysetPredicate,
    timestampCursorExpression,
    bigintCursorExpression,
} = require('../utils/listCursor');

const FULL_HISTORY_TIME_BUDGET_MS = Number(process.env.ZENBOOKER_PAYMENTS_FULL_HISTORY_BUDGET_MS) || 210000;
const FULL_HISTORY_PAGE_SIZE = Number(process.env.ZENBOOKER_PAYMENTS_FULL_HISTORY_PAGE_SIZE) || 25;

class ZenbookerPaymentsSyncError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.name = 'ZenbookerPaymentsSyncError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function isDefaultSyncCompany(companyId) {
    const defaultCompanyId = zenbookerClient.ZENBOOKER_DEFAULT_COMPANY_ID
        || process.env.ZENBOOKER_DEFAULT_COMPANY_ID
        || '00000000-0000-0000-0000-000000000001';
    return !!companyId && companyId === defaultCompanyId;
}

function assertDefaultSyncCompany(companyId) {
    if (!isDefaultSyncCompany(companyId)) {
        throw new ZenbookerPaymentsSyncError(
            'ZENBOOKER_SYNC_FORBIDDEN',
            'Zenbooker payment sync is available only for the default company',
            403,
        );
    }
}

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

// ─── Batch fetch helper ──────────────────────────────────────────────────────

async function batchFetch(ids, fetchFn, concurrency = 5) {
    const cache = new Map();
    const uniqueIds = [...new Set(ids.filter(Boolean))];

    for (let i = 0; i < uniqueIds.length; i += concurrency) {
        const batch = uniqueIds.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map(id => fetchFn(id)));
        batch.forEach((id, idx) => {
            if (results[idx].status === 'fulfilled') {
                cache.set(id, results[idx].value);
            } else {
                console.warn(`[PaymentsService] Failed to fetch ${id}:`, results[idx].reason?.message);
            }
        });
    }

    return cache;
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

// =============================================================================
// syncPayments — Fetch from Zenbooker API and upsert into local DB
// =============================================================================

function continuationCursor(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && value.length <= 255) return value;
    throw new ZenbookerPaymentsSyncError('VALIDATION', 'cursor must be a non-negative number or short string', 400);
}

function transactionRange(transactions) {
    const timestamps = transactions
        .map(txn => txn.payment_date || txn.created || null)
        .filter(Boolean)
        .map(value => new Date(value))
        .filter(value => !Number.isNaN(value.getTime()))
        .sort((a, b) => a.getTime() - b.getTime());
    if (timestamps.length === 0) return null;
    return {
        from: timestamps[0].toISOString(),
        to: timestamps[timestamps.length - 1].toISOString(),
    };
}

function mergeRange(current, next) {
    if (!next) return current;
    if (!current) return next;
    return {
        from: new Date(current.from) < new Date(next.from) ? current.from : next.from,
        to: new Date(current.to) > new Date(next.to) ? current.to : next.to,
    };
}

async function existingTransactionIds(companyId, transactions) {
    const ids = [...new Set(transactions.map(txn => String(txn.id || '')).filter(Boolean))];
    if (ids.length === 0) return new Set();
    const { rows } = await db.query(
        `SELECT transaction_id
         FROM zb_payments
         WHERE company_id = $1
           AND transaction_id = ANY($2::text[])`,
        [companyId, ids],
    );
    return new Set(rows.map(row => String(row.transaction_id)));
}

async function ingestTransactionChunk(companyId, transactions, reader) {
    const existingIds = await existingTransactionIds(companyId, transactions);
    const uniqueIds = new Set(transactions.map(txn => String(txn.id || '')).filter(Boolean));

    const invoiceIds = transactions.map(t => resolveZbInvoiceId(t)).filter(Boolean);
    const invoiceCache = await batchFetch(invoiceIds, id => reader.getInvoice(id));
    console.log(`[PaymentsService] Fetched ${invoiceCache.size}/${new Set(invoiceIds).size} invoices`);

    const jobIds = [];
    for (const txn of transactions) {
        const invoice = invoiceCache.get(resolveZbInvoiceId(txn));
        const jobId = resolveZbJobId(txn, invoice);
        if (jobId) jobIds.push(jobId);
    }
    const jobCache = await batchFetch(jobIds, id => reader.getJob(id));
    console.log(`[PaymentsService] Fetched ${jobCache.size}/${new Set(jobIds).size} jobs`);

    let unresolvedJobIdCount = 0;
    let unfetchedJobCount = 0;
    const unlinkedTxnSamples = [];

    for (const txn of transactions) {
        const invoice = invoiceCache.get(resolveZbInvoiceId(txn)) || null;
        const jobId = resolveZbJobId(txn, invoice);
        const job = jobId ? jobCache.get(jobId) || null : null;

        if (!jobId) {
            unresolvedJobIdCount++;
            if (unlinkedTxnSamples.length < 10) unlinkedTxnSamples.push({ txn: txn.id, reason: 'no_job_id' });
        } else if (!job) {
            unfetchedJobCount++;
            if (unlinkedTxnSamples.length < 10) unlinkedTxnSamples.push({ txn: txn.id, job: jobId, reason: 'job_fetch_failed' });
        }

        const row = assembleRow(txn, invoice, job);

        await db.query(`
            INSERT INTO zb_payments (
                company_id, transaction_id, invoice_id, job_id,
                job_number, client, job_type, status,
                payment_methods, display_payment_method, amount_paid,
                tags, payment_date, source, tech,
                transaction_status, missing_job_link,
                invoice_status, invoice_total, invoice_amount_paid,
                invoice_amount_due, invoice_paid_in_full,
                job_detail, invoice_detail, attachments, metadata,
                zb_raw_transaction, zb_raw_invoice, zb_raw_job,
                custom_fields
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8,
                $9, $10, $11,
                $12, $13, $14, $15,
                $16, $17,
                $18, $19, $20,
                $21, $22,
                $23, $24, $25, $26,
                $27, $28, $29,
                $30
            )
            -- Job-BODY-derived columns are guarded: if this chunk could not
            -- fetch the job body, keep previously complete display/detail data.
            ON CONFLICT (company_id, transaction_id) DO UPDATE SET
                invoice_id = EXCLUDED.invoice_id,
                job_id = COALESCE(NULLIF(EXCLUDED.job_id, ''), zb_payments.job_id),
                job_number = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.job_number ELSE EXCLUDED.job_number END,
                client = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.client ELSE EXCLUDED.client END,
                job_type = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.job_type ELSE EXCLUDED.job_type END,
                status = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.status ELSE EXCLUDED.status END,
                payment_methods = EXCLUDED.payment_methods,
                display_payment_method = EXCLUDED.display_payment_method,
                amount_paid = EXCLUDED.amount_paid,
                tags = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.tags ELSE EXCLUDED.tags END,
                payment_date = EXCLUDED.payment_date,
                source = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.source ELSE EXCLUDED.source END,
                tech = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.tech ELSE EXCLUDED.tech END,
                transaction_status = EXCLUDED.transaction_status,
                -- Never regress a previously linked row on a transient fetch miss.
                missing_job_link = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.missing_job_link ELSE false END,
                invoice_status = EXCLUDED.invoice_status,
                invoice_total = EXCLUDED.invoice_total,
                invoice_amount_paid = EXCLUDED.invoice_amount_paid,
                invoice_amount_due = EXCLUDED.invoice_amount_due,
                invoice_paid_in_full = EXCLUDED.invoice_paid_in_full,
                job_detail = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.job_detail ELSE EXCLUDED.job_detail END,
                invoice_detail = EXCLUDED.invoice_detail,
                attachments = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.attachments ELSE EXCLUDED.attachments END,
                metadata = EXCLUDED.metadata,
                zb_raw_transaction = EXCLUDED.zb_raw_transaction,
                zb_raw_invoice = EXCLUDED.zb_raw_invoice,
                zb_raw_job = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.zb_raw_job ELSE EXCLUDED.zb_raw_job END,
                custom_fields = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.custom_fields ELSE EXCLUDED.custom_fields END,
                updated_at = now()
        `, [
            companyId, row.transaction_id, row.invoice_id || null, row.job_id || null,
            row.job_number, row.client, row.job_type, row.status,
            row.payment_methods, row.display_payment_method, parseFloat(row.amount_paid) || 0,
            row.tags, row.payment_date || null, row.source, row.tech,
            row.transaction_status, row.missing_job_link,
            row.invoice_status, parseFloat(row.invoice_total) || null, parseFloat(row.invoice_amount_paid) || null,
            parseFloat(row.invoice_amount_due) || null, row.invoice_paid_in_full,
            JSON.stringify(row.job_detail), JSON.stringify(row.invoice_detail),
            JSON.stringify(row.attachments), JSON.stringify(row.metadata),
            JSON.stringify(txn), invoice ? JSON.stringify(invoice) : null,
            job ? JSON.stringify(job) : null,
            row.custom_fields || '',
        ]);
    }

    const unlinked = unresolvedJobIdCount + unfetchedJobCount;
    if (unlinked > 0) {
        console.warn(
            `[PaymentsService] ${unlinked}/${transactions.length} payments synced WITHOUT a linked job ` +
            `(${unresolvedJobIdCount} had no resolvable job id, ${unfetchedJobCount} had a job id but the fetch failed). ` +
            `Run reconcilePaymentJobLinks to heal these. Samples: ${JSON.stringify(unlinkedTxnSamples)}`
        );
    }

    return {
        synced: transactions.length,
        imported: Math.max(0, uniqueIds.size - existingIds.size),
        skipped_existing: existingIds.size,
        unlinked,
        unresolved_job_id: unresolvedJobIdCount,
        job_fetch_failed: unfetchedJobCount,
        last_range: transactionRange(transactions),
    };
}

function addChunkTotals(totals, chunk) {
    totals.synced += chunk.synced;
    totals.imported += chunk.imported;
    totals.skipped_existing += chunk.skipped_existing;
    totals.unlinked += chunk.unlinked;
    totals.unresolved_job_id += chunk.unresolved_job_id;
    totals.job_fetch_failed += chunk.job_fetch_failed;
    totals.last_range = mergeRange(totals.last_range, chunk.last_range);
}

async function syncPayments(companyId, dateFrom, dateTo, options = {}) {
    // Defense in depth: reject before client resolution, network, or SQL.
    assertDefaultSyncCompany(companyId);

    const fullHistory = options.fullHistory === true || (!dateFrom && !dateTo);
    if ((fullHistory && (dateFrom || dateTo)) || (!fullHistory && (!dateFrom || !dateTo))) {
        throw new ZenbookerPaymentsSyncError(
            'VALIDATION',
            fullHistory
                ? 'full_history cannot be combined with date_from/date_to'
                : 'date_from and date_to are both required for range sync',
            400,
        );
    }
    const requestedCursor = fullHistory ? continuationCursor(options.cursor) : null;

    const reader = await zenbookerClient.getPaymentReaderForCompany(companyId);
    if (!reader) {
        throw new ZenbookerPaymentsSyncError('ZENBOOKER_NOT_CONFIGURED', 'Zenbooker is not configured', 403);
    }

    const totals = {
        synced: 0,
        imported: 0,
        skipped_existing: 0,
        unlinked: 0,
        unresolved_job_id: 0,
        job_fetch_failed: 0,
        last_range: null,
    };
    let remaining = false;
    let nextCursor = null;

    if (fullHistory) {
        const now = typeof options.now === 'function' ? options.now : Date.now;
        const budgetMs = Number.isFinite(options.timeBudgetMs)
            ? Math.max(0, options.timeBudgetMs)
            : FULL_HISTORY_TIME_BUDGET_MS;
        const startedAt = now();
        let cursor = requestedCursor ?? 0;

        console.log(`[PaymentsService] Full-history sync for company ${companyId}, cursor=${cursor}`);
        while (true) {
            const page = await reader.getTransactionsPage({
                cursor,
                limit: FULL_HISTORY_PAGE_SIZE,
            });
            const transactions = page.results || [];
            console.log(`[PaymentsService] Got full-history chunk of ${transactions.length} transactions`);
            addChunkTotals(totals, await ingestTransactionChunk(companyId, transactions, reader));

            if (!page.has_more) break;
            if (page.next_cursor == null || page.next_cursor === cursor) {
                throw new Error('Zenbooker returned has_more without a usable next_cursor');
            }

            cursor = page.next_cursor;
            if (now() - startedAt >= budgetMs) {
                remaining = true;
                nextCursor = cursor;
                break;
            }
        }
    } else {
        console.log(`[PaymentsService] Syncing ${dateFrom} → ${dateTo} for company ${companyId}`);
        const transactions = await reader.getTransactions({
            date_from: dateFrom,
            date_to: dateTo,
        });
        console.log(`[PaymentsService] Got ${transactions.length} transactions`);
        addChunkTotals(totals, await ingestTransactionChunk(companyId, transactions, reader));
    }

    // Re-link historical rows and reproject the whole company after every bounded
    // request. This retypes legacy zenbooker_sync rows without duplicating them.
    try {
        const recon = await reconcileJobLinks(companyId, { dryRun: false });
        console.log('[PaymentsService] Post-sync reconcile + ledger projection:', recon);
    } catch (e) {
        console.error('[PaymentsService] Post-sync reconcile/projection failed (non-fatal):', e.message);
    }

    return {
        mode: fullHistory ? 'full_history' : 'range',
        synced: totals.synced,
        total_transactions: totals.synced,
        imported: totals.imported,
        skipped_existing: totals.skipped_existing,
        remaining,
        cursor: remaining ? nextCursor : null,
        last_range: totals.last_range,
        unlinked: totals.unlinked,
        unresolved_job_id: totals.unresolved_job_id,
        job_fetch_failed: totals.job_fetch_failed,
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
 * after a sync that reported `unlinked > 0`, or to heal historically broken
 * rows. Pass { dryRun: true } to preview counts without writing.
 *
 * Rows that remain unlinked are payments whose ZB job isn't in the local jobs
 * table yet — sync those jobs first (scripts/zb-jobs-sync-full.js), then re-run.
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
// listPayments — Read from local DB with filters
// =============================================================================

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
        baseConditions.push(`p.payment_methods ILIKE $${params.length}`);
    }
    if (quickFilter === 'new_checks') {
        params.push('%check%');
        baseConditions.push(`(
            p.payment_methods ILIKE $${params.length}
            OR p.display_payment_method ILIKE $${params.length}
        )`);
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
        )`);
    }

    const finalConditions = baseConditions.slice();
    if (normalizedProvider) {
        params.push(normalizedProvider);
        finalConditions.push(`EXISTS (
            SELECT 1
            FROM unnest(string_to_array(COALESCE(p.tech, ''), ',')) AS provider_name(value)
            WHERE BTRIM(provider_name.value) = $${params.length}
        )`);
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
            `WITH base_rows AS (
                SELECT p.display_payment_method, p.tech, p.check_deposited
                FROM zb_payments p
                WHERE ${baseWhere}
             ), aggregate AS (
                SELECT COUNT(*)::int AS transaction_count,
                       COALESCE(SUM(COALESCE(p.amount_paid, 0)), 0)::text AS total_amount
                FROM zb_payments p
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
                            SELECT DISTINCT BTRIM(provider_name.value) AS provider
                            FROM base_rows
                            CROSS JOIN LATERAL unnest(string_to_array(COALESCE(base_rows.tech, ''), ',')) AS provider_name(value)
                            WHERE BTRIM(provider_name.value) <> ''
                        ) provider_rows
                    ), '[]'::json) AS providers,
                    (
                        SELECT COUNT(*)::int
                        FROM base_rows
                        WHERE LOWER(BTRIM(COALESCE(base_rows.display_payment_method, ''))) = 'check'
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
        `SELECT
            p.id, p.transaction_id, p.invoice_id, p.job_id,
            p.job_number, p.client, p.job_type, p.status,
            p.payment_methods, p.display_payment_method,
            p.amount_paid::text AS amount_paid,
            p.tags, p.payment_date, p.source, p.tech,
            p.transaction_status, p.missing_job_link,
            p.invoice_status,
            p.invoice_total::text AS invoice_total,
            p.invoice_amount_paid::text AS invoice_amount_paid,
            p.invoice_amount_due::text AS invoice_amount_due,
            p.invoice_paid_in_full,
            p.check_deposited,
            p.custom_fields,
            ${cursorProjections.join(', ')}
         FROM zb_payments p
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
        conditions.push(`p.payment_methods ILIKE $${paramIdx}`);
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
        )`);
        params.push(q);
        paramIdx++;
    }

    const where = conditions.join(' AND ');

    const result = await db.query(
        `SELECT
            p.job_number,
            p.payment_methods,
            p.amount_paid::text as amount_paid,
            p.payment_date,
            j.id as blanc_job_id,
            j.customer_name as blanc_client,
            j.service_name as blanc_job_type,
            j.blanc_status,
            j.job_source as blanc_source,
            j.assigned_techs as blanc_techs,
            j.metadata as blanc_metadata,
            (
                SELECT string_agg(t.name, ', ' ORDER BY t.sort_order, t.id)
                FROM job_tag_assignments jta
                JOIN job_tags t ON t.id = jta.tag_id
                WHERE jta.job_id = j.id
            ) as blanc_tags
        FROM zb_payments p
        LEFT JOIN jobs j
          ON j.company_id = p.company_id
         AND (CASE
                WHEN NULLIF(p.job_id, '') IS NOT NULL THEN j.zenbooker_job_id = p.job_id
                ELSE j.job_number = NULLIF(p.job_number, '—')
              END)
        WHERE ${where}
        ORDER BY p.payment_date DESC`,
        params
    );

    const NOT_FOUND = 'ERROR: JOB DOES NOT EXIST IN BLANC';

    return result.rows.map(r => {
        const inBlanc = r.blanc_job_id != null;

        // Tech (providers) from Albusto assigned_techs JSONB array
        let tech = '';
        if (inBlanc && Array.isArray(r.blanc_techs)) {
            tech = r.blanc_techs.map(t => t.name).filter(Boolean).join(', ');
        } else if (!inBlanc) {
            tech = NOT_FOUND;
        }

        // Custom fields from Albusto metadata (e.g. claim_id)
        let customFields = '';
        if (!inBlanc) {
            customFields = NOT_FOUND;
        } else if (r.blanc_metadata && typeof r.blanc_metadata === 'object') {
            const parts = [];
            for (const [key, val] of Object.entries(r.blanc_metadata)) {
                if (val != null && val !== '') {
                    parts.push(String(val));
                }
            }
            customFields = parts.join('; ');
        }

        return {
            job_number: r.job_number || '—',
            client: inBlanc ? (r.blanc_client || '—') : NOT_FOUND,
            job_type: inBlanc ? (r.blanc_job_type || '—') : NOT_FOUND,
            status: inBlanc ? (r.blanc_status || '—') : NOT_FOUND,
            payment_methods: r.payment_methods,
            amount_paid: r.amount_paid || '0.00',
            tags: inBlanc ? (r.blanc_tags || '') : NOT_FOUND,
            payment_date: r.payment_date,
            source: inBlanc ? (r.blanc_source || '') : NOT_FOUND,
            tech,
            custom_fields: customFields,
        };
    });
}

// =============================================================================
// getPaymentDetail — Read single payment from DB
// =============================================================================

async function getPaymentDetail(companyId, paymentId) {
    const result = await db.query(
        `SELECT
            p.id, p.transaction_id, p.invoice_id, p.job_id,
            p.job_number, p.client, p.job_type, p.status,
            p.payment_methods, p.display_payment_method,
            p.amount_paid::text as amount_paid,
            p.tags, p.payment_date, p.source, p.tech,
            p.transaction_status, p.missing_job_link,
            p.invoice_status,
            p.invoice_total::text as invoice_total,
            p.invoice_amount_paid::text as invoice_amount_paid,
            p.invoice_amount_due::text as invoice_amount_due,
            p.invoice_paid_in_full,
            p.check_deposited,
            p.job_detail, p.invoice_detail, p.attachments, p.metadata,
            j.id as local_job_id
        FROM zb_payments p
        -- Link the local Albusto job by the STABLE zenbooker_job_id (same key the
        -- ledger uses), falling back to job_number only when the id is unknown.
        -- The old job_number-only join broke whenever the job body wasn't
        -- fetched at sync time (job_number stayed '—').
        LEFT JOIN jobs j
          ON j.company_id = p.company_id
         AND (CASE
                WHEN NULLIF(p.job_id, '') IS NOT NULL THEN j.zenbooker_job_id = p.job_id
                ELSE j.job_number = NULLIF(p.job_number, '—')
              END)
        WHERE p.company_id = $1 AND p.id = $2`,
        [companyId, paymentId]
    );

    if (result.rows.length === 0) return null;

    const r = result.rows[0];

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
        amount_paid: r.amount_paid || '0.00',
        tags: r.tags,
        payment_date: r.payment_date,
        source: r.source,
        tech: r.tech,
        transaction_id: r.transaction_id,
        invoice_id: r.invoice_id || '',
        job_id: r.job_id || '',
        local_job_id: r.local_job_id || null,
        transaction_status: r.transaction_status,
        missing_job_link: r.missing_job_link,
        invoice_status: r.invoice_status,
        invoice_total: r.invoice_total,
        invoice_amount_paid: r.invoice_amount_paid,
        invoice_amount_due: r.invoice_amount_due,
        invoice_paid_in_full: r.invoice_paid_in_full,
        check_deposited: r.check_deposited || false,
        // Detail data (JSONB)
        invoice: r.invoice_detail || null,
        job: r.job_detail || null,
        attachments: r.attachments || [],
        metadata: r.metadata || {},
        _warning: r.missing_job_link ? 'Some job details are unavailable right now.' : null,
    };
}

// =============================================================================
// updateCheckDeposited — Toggle check_deposited flag
// =============================================================================

async function updateCheckDeposited(companyId, paymentId, deposited) {
    const result = await db.query(
        `UPDATE zb_payments
         SET check_deposited = $3, updated_at = now()
         WHERE company_id = $1 AND id = $2
         RETURNING check_deposited`,
        [companyId, paymentId, !!deposited]
    );
    if (result.rows.length === 0) return null;
    return { check_deposited: result.rows[0].check_deposited };
}

module.exports = {
    syncPayments,
    isDefaultSyncCompany,
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
