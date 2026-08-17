/**
 * AI-GEN-LOG-001 — append-only log of AI estimate/invoice draft generations.
 *
 * Purpose: the owner analyzes accumulated generations to tune Price Book
 * matching (observed: a range-hood repair report drafted as a dryer drain-pump
 * catalog item). Every generation by any user of a company is recorded; the
 * "Markdown file" the owner asked for is rendered on demand from these rows,
 * because the app container has no host mounts — an in-container file would
 * vanish on every image rebuild.
 *
 * record() is fire-and-forget: a logging failure must never break or delay
 * the draft response.
 */

const db = require('../db/connection');

const MAX_REPORT_LOG_CHARS = 8000;

function clip(text, max) {
    const value = typeof text === 'string' ? text : '';
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function record({
    companyId,
    crmUserId = null,
    jobId = null,
    reportText,
    result,
    model = null,
    durationMs = null,
}) {
    try {
        if (!companyId) return null; // never guess a tenant
        const { rows } = await db.query(
            `INSERT INTO ai_generation_log
                (company_id, crm_user_id, job_id, report_text, summary,
                 line_items, order_list, model, duration_ms)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
             RETURNING id`,
            [
                companyId,
                crmUserId,
                Number.isFinite(Number(jobId)) ? Number(jobId) : null,
                clip(reportText, MAX_REPORT_LOG_CHARS),
                typeof result?.summary === 'string' ? result.summary : null,
                JSON.stringify(Array.isArray(result?.line_items) ? result.line_items : []),
                JSON.stringify(Array.isArray(result?.order_list) ? result.order_list : []),
                model,
                Number.isFinite(Number(durationMs)) ? Math.round(Number(durationMs)) : null,
            ]
        );
        return rows[0]?.id ?? null;
    } catch (err) {
        console.warn('[AiGenLog] record failed (non-blocking):', err.message);
        return null;
    }
}

/**
 * AI-GEN-LOG-002 — attach what the user actually SAVED to the generation row.
 * First save wins (finalized_at guard); tenant-scoped so a forged id from
 * another company matches nothing. Fire-and-forget like record().
 */
async function linkFinal({
    companyId,
    generationId,
    estimateId = null,
    invoiceId = null,
    finalLineItems = [],
}) {
    try {
        const id = Number(generationId);
        if (!companyId || !Number.isFinite(id)) return;
        await db.query(
            `UPDATE ai_generation_log
                SET estimate_id = COALESCE($3, estimate_id),
                    invoice_id = COALESCE($4, invoice_id),
                    final_line_items = $5::jsonb,
                    finalized_at = NOW()
              WHERE id = $1 AND company_id = $2 AND finalized_at IS NULL`,
            [
                id,
                companyId,
                estimateId != null ? Number(estimateId) : null,
                invoiceId != null ? Number(invoiceId) : null,
                JSON.stringify(Array.isArray(finalLineItems) ? finalLineItems : []),
            ]
        );
    } catch (err) {
        console.warn('[AiGenLog] linkFinal failed (non-blocking):', err.message);
    }
}

function mdEscape(text) {
    return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderEntry(row) {
    const when = new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 16);
    const who = row.user_name || row.user_email || row.crm_user_id || 'unknown user';
    const jobNumber = row.job_seq ?? row.job_id;
    const job = jobNumber ? ` · job #${jobNumber}` : '';
    const lines = Array.isArray(row.line_items) ? row.line_items : [];
    const orderList = Array.isArray(row.order_list) ? row.order_list : [];

    const out = [];
    out.push(`## ${when} UTC · ${who}${job}`);
    out.push('');
    out.push('**Report:**');
    out.push('');
    for (const l of String(row.report_text || '').split(/\r?\n/)) out.push(`> ${l}`);
    out.push('');
    if (row.summary) {
        out.push(`**Summary:** ${row.summary}`);
        out.push('');
    }
    if (lines.length) {
        out.push('| # | Source | Item | Category | Qty | Price |');
        out.push('|---|---|---|---|---|---|');
        lines.forEach((line, i) => {
            const source = line.source === 'item' && line.item_id
                ? `item #${line.item_id}`
                : (line.source || 'new');
            out.push(`| ${i + 1} | ${mdEscape(source)} | ${mdEscape(line.title || line.name || '')} | ${mdEscape(line.path || line.category || '—')} | ${mdEscape(line.qty ?? line.quantity ?? 1)} | ${mdEscape(line.price ?? line.unit_price ?? '')} |`);
        });
        out.push('');
    } else {
        out.push('_No line items generated._');
        out.push('');
    }
    if (orderList.length) {
        const parts = orderList
            .map((p) => `${p.part_number || ''} ${p.part_name || ''} ×${p.quantity || 1}`.trim())
            .join('; ');
        out.push(`**Order list:** ${mdEscape(parts)}`);
        out.push('');
    }
    // AI-GEN-LOG-002: what the user actually saved (the correction signal).
    const finalLines = Array.isArray(row.final_line_items) ? row.final_line_items : null;
    if (row.finalized_at && finalLines) {
        const doc = row.estimate_id
            ? `estimate #${row.estimate_id}`
            : (row.invoice_id ? `invoice #${row.invoice_id}` : 'document');
        out.push(`**Saved as ${doc}:**`);
        out.push('');
        if (finalLines.length) {
            out.push('| # | Item | Qty | Price |');
            out.push('|---|---|---|---|');
            finalLines.forEach((line, i) => {
                out.push(`| ${i + 1} | ${mdEscape(line.name || '')} | ${mdEscape(line.quantity ?? 1)} | ${mdEscape(line.unit_price ?? '')} |`);
            });
        } else {
            out.push('_Saved with no line items._');
        }
        out.push('');
    } else {
        out.push('_No saved document linked (draft discarded or still open)._');
        out.push('');
    }
    const meta = [];
    if (row.model) meta.push(row.model);
    if (row.duration_ms != null) meta.push(`${(row.duration_ms / 1000).toFixed(1)}s`);
    if (meta.length) {
        out.push(`_${meta.join(' · ')}_`);
        out.push('');
    }
    out.push('---');
    out.push('');
    return out.join('\n');
}

async function renderMarkdown(companyId) {
    const { rows } = await db.query(
        `SELECT g.*, u.full_name AS user_name, u.email AS user_email,
                j.job_seq
           FROM ai_generation_log g
           LEFT JOIN crm_users u ON u.id = g.crm_user_id
           LEFT JOIN jobs j ON j.id = g.job_id AND j.company_id = g.company_id
          WHERE g.company_id = $1
          ORDER BY g.created_at ASC, g.id ASC`,
        [companyId]
    );
    const header = [
        '# AI generation log',
        '',
        `Entries: ${rows.length}. Every AI estimate/invoice draft generated by this company's users, oldest first.`,
        '',
        '---',
        '',
    ].join('\n');
    return header + rows.map(renderEntry).join('\n');
}

module.exports = { record, linkFinal, renderMarkdown, MAX_REPORT_LOG_CHARS };
