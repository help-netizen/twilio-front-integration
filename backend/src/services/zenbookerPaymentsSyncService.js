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
        },
    };
}

// =============================================================================
// syncPayments — Fetch from Zenbooker API and upsert into local DB
// =============================================================================

async function syncPayments(companyId, dateFrom, dateTo) {
    console.log(`[PaymentsService] Syncing ${dateFrom} → ${dateTo} for company ${companyId}`);

    // 1. Fetch all transactions
    const transactions = await zenbookerClient.getTransactions({
        date_from: dateFrom,
        date_to: dateTo,
    });
    console.log(`[PaymentsService] Got ${transactions.length} transactions`);

    // 2. Batch-fetch invoices
    const invoiceIds = transactions.map(t => resolveZbInvoiceId(t)).filter(Boolean);
    const invoiceCache = await batchFetch(invoiceIds, id => zenbookerClient.getInvoice(id));
    console.log(`[PaymentsService] Fetched ${invoiceCache.size}/${new Set(invoiceIds).size} invoices`);

    // 3. Batch-fetch jobs. Resolve each job id from the invoice OR the
    //    transaction (not invoice.job_id alone) so a payment still links when
    //    the invoice hop is thin/absent. Fetching is keyed by the resolved id.
    const jobIds = [];
    for (const txn of transactions) {
        const invoice = invoiceCache.get(resolveZbInvoiceId(txn));
        const jobId = resolveZbJobId(txn, invoice);
        if (jobId) jobIds.push(jobId);
    }
    const jobCache = await batchFetch(jobIds, id => zenbookerClient.getJob(id));
    console.log(`[PaymentsService] Fetched ${jobCache.size}/${new Set(jobIds).size} jobs`);

    // 4. Assemble and upsert rows
    let upsertedCount = 0;
    let unresolvedJobIdCount = 0;   // couldn't even determine which ZB job
    let unfetchedJobCount = 0;      // knew the job id but the fetch failed
    const unlinkedTxnSamples = [];

    for (const txn of transactions) {
        const invoice = invoiceCache.get(resolveZbInvoiceId(txn)) || null;
        const jobId = resolveZbJobId(txn, invoice);
        const job = jobId ? jobCache.get(jobId) || null : null;

        // Observability: a once-silent job-fetch miss is the reason payments
        // landed with no provider/no linked job. Count + sample them so a bad
        // sync is visible in the result and logs instead of failing quietly.
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
            -- Job-BODY-derived columns (job_number, job_type, status, tags,
            -- source, tech, custom_fields, job_detail, attachments, zb_raw_job,
            -- client) are guarded: when THIS sync didn't fetch the job body
            -- (EXCLUDED.missing_job_link = true, i.e. getJob failed/was skipped),
            -- a plain "= EXCLUDED.x" would WIPE good data with empties — that's
            -- how work-note images vanished from already-synced payments after a
            -- re-sync where the job fetch timed out (reconcileJobLinks heals the
            -- link but never repopulates attachments). So keep the existing value
            -- on a body-less run; take the fresh value only when we actually have
            -- the job (legit note/image removals in ZB still propagate then).
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
                -- never regress a previously-linked row to "missing" on a body-less run
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

        upsertedCount++;
    }

    console.log(`[PaymentsService] Upserted ${upsertedCount} payments`);

    const unlinkedCount = unresolvedJobIdCount + unfetchedJobCount;
    if (unlinkedCount > 0) {
        console.warn(
            `[PaymentsService] ${unlinkedCount}/${transactions.length} payments synced WITHOUT a linked job ` +
            `(${unresolvedJobIdCount} had no resolvable job id, ${unfetchedJobCount} had a job id but the fetch failed). ` +
            `Run reconcilePaymentJobLinks to heal these. Samples: ${JSON.stringify(unlinkedTxnSamples)}`
        );
    }

    // Re-link any still-broken payments to their jobs (heals rows synced before
    // the resolver fix, and any job-fetch miss from THIS run, from already-synced
    // local jobs) and project into the canonical payment_transactions ledger
    // (Zenbooker = master, so its rows win on conflict). Idempotent and SQL-only;
    // only touches rows still missing a link, so it never regresses fresh data.
    // Best-effort — a reconcile/projection hiccup must not fail the sync itself.
    try {
        const recon = await reconcileJobLinks(companyId, { dryRun: false });
        console.log('[PaymentsService] Post-sync reconcile + ledger projection:', recon);
    } catch (e) {
        console.error('[PaymentsService] Post-sync reconcile/projection failed (non-fatal):', e.message);
    }

    return {
        synced: upsertedCount,
        total_transactions: transactions.length,
        unlinked: unlinkedCount,
        unresolved_job_id: unresolvedJobIdCount,
        job_fetch_failed: unfetchedJobCount,
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
               'payment', 'zenbooker_sync',
               CASE zp.transaction_status
                   WHEN 'succeeded' THEN 'completed'
                   WHEN 'failed'    THEN 'failed'
                   WHEN 'voided'    THEN 'voided'
                   ELSE 'pending' END,
               COALESCE(zp.amount_paid, 0), 'USD',
               NULLIF(zp.invoice_id, ''), zp.transaction_id, 'zenbooker',
               NULLIF(zp.client, '—'),
               jsonb_build_object('zb_job_id', zp.job_id, 'job_number', zp.job_number,
                   'job_type', zp.job_type, 'display_payment_method', zp.display_payment_method,
                   'invoice_status', zp.invoice_status, 'source', 'zb_sync_writethrough'),
               zp.payment_date, zp.created_at, now()
        FROM zb_payments zp
        LEFT JOIN jobs j ON j.zenbooker_job_id = zp.job_id AND j.company_id = zp.company_id
        WHERE zp.company_id = $1
        ON CONFLICT (company_id, external_id) WHERE external_source = 'zenbooker'
        DO UPDATE SET job_id = EXCLUDED.job_id, status = EXCLUDED.status,
            amount = EXCLUDED.amount, payment_method = EXCLUDED.payment_method,
            memo = EXCLUDED.memo, metadata = EXCLUDED.metadata,
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

async function listPayments(companyId, {
    dateFrom, dateTo, paymentMethod, search,
    sortField = 'payment_date', sortDir = 'desc',
    offset = 0, limit = 200,
} = {}) {
    const conditions = ['company_id = $1'];
    const params = [companyId];
    let paramIdx = 2;

    if (dateFrom) {
        conditions.push(`payment_date >= $${paramIdx}`);
        params.push(dateFrom);
        paramIdx++;
    }
    if (dateTo) {
        // Add 1 day to include the entire "to" date
        conditions.push(`payment_date < ($${paramIdx}::date + interval '1 day')`);
        params.push(dateTo);
        paramIdx++;
    }
    if (paymentMethod) {
        conditions.push(`payment_methods ILIKE $${paramIdx}`);
        params.push(`%${paymentMethod}%`);
        paramIdx++;
    }
    if (search && search.trim()) {
        const q = `%${search.trim()}%`;
        conditions.push(`(
            client ILIKE $${paramIdx}
            OR job_number ILIKE $${paramIdx}
            OR tags ILIKE $${paramIdx}
            OR source ILIKE $${paramIdx}
            OR transaction_id ILIKE $${paramIdx}
        )`);
        params.push(q);
        paramIdx++;
    }

    const where = conditions.join(' AND ');

    // Validate sort field to prevent injection
    const ALLOWED_SORT_FIELDS = ['payment_date', 'amount_paid', 'job_number', 'client', 'payment_methods'];
    const safeSortField = ALLOWED_SORT_FIELDS.includes(sortField) ? sortField : 'payment_date';
    const safeSortDir = sortDir === 'asc' ? 'ASC' : 'DESC';

    // Count total
    const countResult = await db.query(
        `SELECT COUNT(*) as total FROM zb_payments WHERE ${where}`,
        params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Fetch rows
    const rowsResult = await db.query(
        `SELECT
            id, transaction_id, invoice_id, job_id,
            job_number, client, job_type, status,
            payment_methods, display_payment_method,
            amount_paid::text as amount_paid,
            tags, payment_date, source, tech,
            transaction_status, missing_job_link,
            invoice_status,
            invoice_total::text as invoice_total,
            invoice_amount_paid::text as invoice_amount_paid,
            invoice_amount_due::text as invoice_amount_due,
            invoice_paid_in_full,
            check_deposited,
            custom_fields
        FROM zb_payments
        WHERE ${where}
        ORDER BY ${safeSortField} ${safeSortDir}
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
    );

    return {
        rows: rowsResult.rows.map(r => ({
            ...r,
            amount_paid: r.amount_paid || '0.00',
            invoice_total: r.invoice_total || null,
            invoice_amount_paid: r.invoice_amount_paid || null,
            invoice_amount_due: r.invoice_amount_due || null,
        })),
        total,
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
    buildInvoiceSummary,
    extractAttachments,
    extractCustomFields,
};
