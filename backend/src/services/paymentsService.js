/**
 * Payments Service
 *
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

// ─── Assemble row from raw ZB data ──────────────────────────────────────────

function assembleRow(txn, invoice, job) {
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
        invoice_id: txn.invoice_id || '',
        job_id: invoice?.job_id || '',
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
    const invoiceIds = transactions.map(t => t.invoice_id).filter(Boolean);
    const invoiceCache = await batchFetch(invoiceIds, id => zenbookerClient.getInvoice(id));
    console.log(`[PaymentsService] Fetched ${invoiceCache.size} invoices`);

    // 3. Batch-fetch jobs (from invoice.job_id)
    const jobIds = [];
    for (const inv of invoiceCache.values()) {
        if (inv.job_id) jobIds.push(inv.job_id);
    }
    const jobCache = await batchFetch(jobIds, id => zenbookerClient.getJob(id));
    console.log(`[PaymentsService] Fetched ${jobCache.size} jobs`);

    // 4. Assemble and upsert rows
    let upsertedCount = 0;

    for (const txn of transactions) {
        const invoice = txn.invoice_id ? invoiceCache.get(txn.invoice_id) : null;
        const job = invoice?.job_id ? jobCache.get(invoice.job_id) : null;
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
            ON CONFLICT (company_id, transaction_id) DO UPDATE SET
                invoice_id = EXCLUDED.invoice_id,
                job_id = EXCLUDED.job_id,
                job_number = EXCLUDED.job_number,
                client = EXCLUDED.client,
                job_type = EXCLUDED.job_type,
                status = EXCLUDED.status,
                payment_methods = EXCLUDED.payment_methods,
                display_payment_method = EXCLUDED.display_payment_method,
                amount_paid = EXCLUDED.amount_paid,
                tags = EXCLUDED.tags,
                payment_date = EXCLUDED.payment_date,
                source = EXCLUDED.source,
                tech = EXCLUDED.tech,
                transaction_status = EXCLUDED.transaction_status,
                missing_job_link = EXCLUDED.missing_job_link,
                invoice_status = EXCLUDED.invoice_status,
                invoice_total = EXCLUDED.invoice_total,
                invoice_amount_paid = EXCLUDED.invoice_amount_paid,
                invoice_amount_due = EXCLUDED.invoice_amount_due,
                invoice_paid_in_full = EXCLUDED.invoice_paid_in_full,
                job_detail = EXCLUDED.job_detail,
                invoice_detail = EXCLUDED.invoice_detail,
                attachments = EXCLUDED.attachments,
                metadata = EXCLUDED.metadata,
                zb_raw_transaction = EXCLUDED.zb_raw_transaction,
                zb_raw_invoice = EXCLUDED.zb_raw_invoice,
                zb_raw_job = EXCLUDED.zb_raw_job,
                custom_fields = EXCLUDED.custom_fields,
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
    return { synced: upsertedCount, total_transactions: transactions.length };
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
// listPaymentsForExport — Enriched with Blanc job data (source, custom fields)
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
        LEFT JOIN jobs j ON j.job_number = p.job_number AND j.company_id = p.company_id
        WHERE ${where}
        ORDER BY p.payment_date DESC`,
        params
    );

    const NOT_FOUND = 'ERROR: JOB DOES NOT EXIST IN BLANC';

    return result.rows.map(r => {
        const inBlanc = r.blanc_job_id != null;

        // Tech (providers) from Blanc assigned_techs JSONB array
        let tech = '';
        if (inBlanc && Array.isArray(r.blanc_techs)) {
            tech = r.blanc_techs.map(t => t.name).filter(Boolean).join(', ');
        } else if (!inBlanc) {
            tech = NOT_FOUND;
        }

        // Custom fields from Blanc metadata (e.g. claim_id)
        let customFields = '';
        if (!inBlanc) {
            customFields = NOT_FOUND;
        } else if (r.blanc_metadata && typeof r.blanc_metadata === 'object') {
            const parts = [];
            for (const [key, val] of Object.entries(r.blanc_metadata)) {
                if (val != null && val !== '') {
                    parts.push(`${key}: ${val}`);
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
            job_detail, invoice_detail, attachments, metadata
        FROM zb_payments
        WHERE company_id = $1 AND id = $2`,
        [companyId, paymentId]
    );

    if (result.rows.length === 0) return null;

    const r = result.rows[0];

    return {
        // Internal Blanc ID
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
    listPayments,
    listPaymentsForExport,
    getPaymentDetail,
    updateCheckDeposited,
    // Exported for testing
    assembleRow,
    extractSource,
    extractTags,
    formatPaymentMethod,
    displayPaymentMethod,
    buildInvoiceSummary,
    extractAttachments,
    extractCustomFields,
};
