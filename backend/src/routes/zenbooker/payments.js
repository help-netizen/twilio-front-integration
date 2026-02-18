/**
 * Zenbooker Payments Export API
 * GET /api/zenbooker/payments?date_from=...&date_to=...&status=...&payment_method=...
 *
 * Pipeline: transactions → invoices → jobs → assembled flat rows
 */

const express = require('express');
const router = express.Router();
const zenbookerClient = require('../../services/zenbookerClient');

// ─── Source field config (for Blanc lead source discovery) ─────────────────────
const SOURCE_MATCH_KEYS = [
    'lead source', 'blanc source', 'source', 'campaign', 'channel', 'utm_source',
    'referral source', 'how did you hear',
];

/**
 * Try to extract a "source" value from job service_fields or other fields.
 */
function extractSource(job) {
    if (!job) return '';

    // Check service_fields (most likely location for Blanc lead source)
    if (Array.isArray(job.service_fields)) {
        for (const field of job.service_fields) {
            const name = (field.field_name || '').toLowerCase();
            if (SOURCE_MATCH_KEYS.some(k => name.includes(k))) {
                // Text answer
                if (field.text_value) return field.text_value;
                // Selected option
                if (Array.isArray(field.selected_options) && field.selected_options.length > 0) {
                    return field.selected_options.map(o => o.text || o.display_label).filter(Boolean).join(', ');
                }
            }
        }
    }

    return '';
}

/**
 * Try to extract custom tags from job.
 */
function extractTags(job) {
    if (!job) return '';

    // Check common tag field names
    if (Array.isArray(job.tags)) {
        return job.tags.map(t => typeof t === 'string' ? t : t.name || '').filter(Boolean).join(', ');
    }
    if (Array.isArray(job.custom_tags)) {
        return job.custom_tags.map(t => typeof t === 'string' ? t : t.name || '').filter(Boolean).join(', ');
    }

    // Check skill_tags_required as fallback
    if (Array.isArray(job.skill_tags_required)) {
        return job.skill_tags_required.map(t => t.name || '').filter(Boolean).join(', ');
    }

    return '';
}

/**
 * Format payment method display string.
 */
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

/**
 * Derive job status display.
 */
function formatJobStatus(job) {
    if (!job) return '—';
    if (job.canceled === true) return 'Canceled';
    return job.status || '—';
}

/**
 * Batch-fetch with concurrency limit.
 */
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

// ─── GET /api/zenbooker/payments ──────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const { date_from, date_to, status, payment_method } = req.query;

        if (!date_from || !date_to) {
            return res.status(400).json({ ok: false, error: 'date_from and date_to are required' });
        }

        console.log(`[Payments] Fetching transactions ${date_from} → ${date_to}, status=${status || 'succeeded'}`);

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
        const rows = transactions.map(txn => {
            const invoice = txn.invoice_id ? invoiceCache.get(txn.invoice_id) : null;
            const job = invoice?.job_id ? jobCache.get(invoice.job_id) : null;
            const missingJobLink = !job;

            // Amount: prefer amount_collected, fallback to amount
            const rawAmount = txn.amount_collected || txn.amount || '0.00';
            const amountPaid = parseFloat(rawAmount).toFixed(2);

            // Tech: join assigned provider names
            const tech = job?.assigned_providers
                ? job.assigned_providers.map(p => p.name).filter(Boolean).join(', ')
                : '—';

            // Client name: from job.customer or invoice.primary_recipient
            let clientName = '—';
            if (job?.customer?.name) {
                clientName = job.customer.name;
            } else if (invoice?.primary_recipient?.name) {
                clientName = invoice.primary_recipient.name;
            }

            return {
                job_number: job?.job_number || '—',
                client: clientName,
                job_type: job?.service_name || '—',
                status: formatJobStatus(job),
                payment_methods: formatPaymentMethod(txn),
                amount_paid: amountPaid,
                tags: extractTags(job),
                payment_date: txn.payment_date || txn.created || '',
                source: extractSource(job),
                tech,
                // Audit fields
                transaction_id: txn.id,
                invoice_id: txn.invoice_id || '',
                job_id: invoice?.job_id || '',
                transaction_status: txn.status || '',
                missing_job_link: missingJobLink,
            };
        });

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

module.exports = router;
