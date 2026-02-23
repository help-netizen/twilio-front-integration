/**
 * Zenbooker Payments Export API
 *
 * GET  /api/zenbooker/payments          — list transactions (filterable, searchable)
 * GET  /api/zenbooker/payments/:id      — single transaction detail w/ attachments
 *
 * Pipeline: transactions → invoices → jobs → assembled flat rows
 */

const express = require('express');
const router = express.Router();
const zenbookerClient = require('../../services/zenbookerClient');

// ─── Source field config ──────────────────────────────────────────────────────
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

// ─── Payment method helpers ───────────────────────────────────────────────────

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

/** Display method: prefer custom_payment_method_name, else payment_method */
function displayPaymentMethod(txn) {
    if (txn.custom_payment_method_name) return txn.custom_payment_method_name;
    return txn.payment_method || '';
}

function formatJobStatus(job) {
    if (!job) return '—';
    if (job.canceled === true) return 'Canceled';
    return job.status || '—';
}

// ─── Invoice helpers ──────────────────────────────────────────────────────────

function buildInvoiceSummary(invoice) {
    if (!invoice) return null;
    const status = invoice.status || 'unknown';
    const total = invoice.total || '0.00';
    const amountPaid = invoice.amount_paid || '0.00';
    const amountDue = invoice.amount_due || '0.00';
    const paidInFull = status === 'paid' || parseFloat(amountDue) === 0;
    return { status, total, amount_paid: amountPaid, amount_due: amountDue, paid_in_full: paidInFull };
}

// ─── Attachments extraction ───────────────────────────────────────────────────

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

    // customer notes
    if (job.customer && Array.isArray(job.customer.notes)) {
        processNotes(job.customer.notes, 'customer_note');
    }
    // recurring notes
    if (job.recurring_booking && Array.isArray(job.recurring_booking.recurring_notes)) {
        processNotes(job.recurring_booking.recurring_notes, 'recurring_note');
    }
    // job-level notes
    if (Array.isArray(job.job_notes)) {
        processNotes(job.job_notes, 'job_note');
    }
    // Also check notes at top level (some API responses put notes here)
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

// ─── Batch fetch helper ───────────────────────────────────────────────────────

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
                console.warn(`[Payments] Failed to fetch ${id}:`, results[idx].reason?.message);
            }
        });
    }

    return cache;
}

// ─── Assemble a row from transaction + invoice + job ──────────────────────────

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

    return {
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
        // Audit / detail fields
        transaction_id: txn.id,
        invoice_id: txn.invoice_id || '',
        job_id: invoice?.job_id || '',
        transaction_status: txn.status || '',
        missing_job_link: missingJobLink,
        // Invoice summary for list
        invoice_status: invoiceSummary?.status || null,
        invoice_total: invoiceSummary?.total || null,
        invoice_amount_paid: invoiceSummary?.amount_paid || null,
        invoice_amount_due: invoiceSummary?.amount_due || null,
        invoice_paid_in_full: invoiceSummary?.paid_in_full || false,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/zenbooker/payments  — List payments (enriched)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
    try {
        const { date_from, date_to, status, payment_method, search } = req.query;

        if (!date_from || !date_to) {
            return res.status(400).json({ ok: false, error: 'date_from and date_to are required' });
        }

        console.log(`[Payments] Fetching transactions ${date_from} → ${date_to}, status=${status || 'succeeded'}, search=${search || ''}`);

        // 1. Fetch all transactions
        const transactions = await zenbookerClient.getTransactions({
            date_from,
            date_to,
            status: status || 'succeeded',
            payment_method: payment_method || undefined,
        });

        console.log(`[Payments] Got ${transactions.length} transactions`);

        // 2. Batch-fetch invoices
        const invoiceIds = transactions.map(t => t.invoice_id).filter(Boolean);
        const invoiceCache = await batchFetch(invoiceIds, id => zenbookerClient.getInvoice(id));
        console.log(`[Payments] Fetched ${invoiceCache.size} invoices`);

        // 3. Batch-fetch jobs (from invoice.job_id)
        const jobIds = [];
        for (const inv of invoiceCache.values()) {
            if (inv.job_id) jobIds.push(inv.job_id);
        }
        const jobCache = await batchFetch(jobIds, id => zenbookerClient.getJob(id));
        console.log(`[Payments] Fetched ${jobCache.size} jobs`);

        // 4. Assemble rows
        let rows = transactions.map(txn => {
            const invoice = txn.invoice_id ? invoiceCache.get(txn.invoice_id) : null;
            const job = invoice?.job_id ? jobCache.get(invoice.job_id) : null;
            return assembleRow(txn, invoice, job);
        });

        // 5. Server-side search filter
        if (search && search.trim()) {
            const q = search.trim().toLowerCase();
            rows = rows.filter(r =>
                r.client.toLowerCase().includes(q) ||
                r.job_number.toLowerCase().includes(q) ||
                (r.tags && r.tags.toLowerCase().includes(q)) ||
                (r.source && r.source.toLowerCase().includes(q)) ||
                r.transaction_id.toLowerCase().includes(q)
            );
        }

        res.json({ ok: true, data: { rows, total: rows.length } });
    } catch (err) {
        console.error('[Payments] Error:', err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/zenbooker/payments/:id  — Payment detail with attachments
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/:id', async (req, res) => {
    try {
        const txnId = req.params.id;
        console.log(`[Payments] Detail for transaction ${txnId}`);

        // Fetch the transaction list for a wide date window (or use a direct API if available)
        // Zenbooker doesn't have a GET /transactions/:id endpoint, so we search recent transactions
        // Strategy: fetch from the query params if provided, else last 90 days
        const dateTo = req.query.date_to || new Date().toISOString().slice(0, 10);
        const dateFrom = req.query.date_from || (() => {
            const d = new Date();
            d.setDate(d.getDate() - 90);
            return d.toISOString().slice(0, 10);
        })();

        const transactions = await zenbookerClient.getTransactions({
            date_from: dateFrom,
            date_to: dateTo,
        });

        const txn = transactions.find(t => t.id === txnId);
        if (!txn) {
            return res.status(404).json({ ok: false, error: 'Transaction not found' });
        }

        // Fetch invoice
        let invoice = null;
        if (txn.invoice_id) {
            try {
                invoice = await zenbookerClient.getInvoice(txn.invoice_id);
            } catch (e) {
                console.warn(`[Payments] Failed to fetch invoice ${txn.invoice_id}:`, e.message);
            }
        }

        // Fetch job
        let job = null;
        if (invoice?.job_id) {
            try {
                job = await zenbookerClient.getJob(invoice.job_id);
            } catch (e) {
                console.warn(`[Payments] Failed to fetch job ${invoice.job_id}:`, e.message);
            }
        }

        // Build response
        const row = assembleRow(txn, invoice, job);
        const attachments = extractAttachments(job);
        const invoiceSummary = buildInvoiceSummary(invoice);

        // Provider details
        const providers = job?.assigned_providers || [];

        // Service address
        const serviceAddress = job?.service_address?.formatted
            || job?.customer?.addresses?.[0]?.formatted
            || null;

        const detail = {
            ...row,
            invoice: invoiceSummary,
            job: job ? {
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
            attachments,
            metadata: {
                transaction_id: txn.id,
                invoice_id: txn.invoice_id || null,
                customer_id: txn.customer_id || null,
                territory_id: txn.territory_id || null,
                initiated_by: txn.initiated_by || null,
                team_member_id: txn.team_member_id || null,
                memo: txn.memo || null,
            },
            _warning: !job ? 'Some job details are unavailable right now.' : null,
        };

        res.json({ ok: true, data: detail });
    } catch (err) {
        console.error('[Payments] Detail error:', err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

module.exports = router;
