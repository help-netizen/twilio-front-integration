/**
 * Payments-page ledger backed exclusively by canonical Albusto tables.
 * Imported presentation data is a frozen snapshot in payment_transactions.metadata.legacy.
 */

const db = require('../db/connection');
const { logFinancialActivity } = require('./financialActivityService');
const { applyInvoiceAllocations } = require('../db/documentPaymentQueries');
const {
    createCursorFingerprint,
    encodeCursor,
    decodeCursor,
    assertCursorOffsetExclusive,
    buildKeysetPredicate,
    timestampCursorExpression,
    bigintCursorExpression,
} = require('../utils/listCursor');

const PAYMENT_LEDGER_ROWS_SQL = `
    SELECT
        t.company_id,
        t.id,
        COALESCE(t.external_id, t.id::text) AS transaction_id,
        CASE
            WHEN t.external_source = 'zenbooker'
                THEN COALESCE(NULLIF(t.metadata->'legacy'->>'invoice_id', ''), NULLIF(t.reference_number, ''), '')
            ELSE COALESCE(t.invoice_id::text, '')
        END AS invoice_id,
        CASE
            WHEN t.external_source = 'zenbooker'
                THEN COALESCE(NULLIF(t.metadata->>'zb_job_id', ''), NULLIF(t.metadata->'legacy'->>'job_id', ''), '')
            ELSE COALESCE(COALESCE(t.job_id, i.job_id)::text, '')
        END AS job_id,
        COALESCE(local_job.id, NULLIF(t.metadata->'legacy'->>'local_job_id', '')::bigint) AS local_job_id,
        COALESCE(t.contact_id, i.contact_id, local_job.contact_id,
                 NULLIF(t.metadata->'legacy'->>'contact_id', '')::bigint) AS contact_id,
        t.invoice_id AS canonical_invoice_id,
        COALESCE(t.job_id, i.job_id, local_job.id,
                 NULLIF(t.metadata->'legacy'->>'canonical_job_id', '')::bigint) AS canonical_job_id,
        COALESCE(NULLIF(local_job.job_number, ''),
                 NULLIF(t.metadata->'legacy'->>'job_number', ''),
                 NULLIF(t.metadata->>'job_number', ''), '—') AS job_number,
        COALESCE(NULLIF(c.full_name, ''), NULLIF(local_job.customer_name, ''),
                 NULLIF(t.metadata->'legacy'->>'client', ''),
                 CASE WHEN t.external_source = 'zenbooker' THEN NULLIF(t.memo, '') END, '—') AS client,
        COALESCE(NULLIF(local_job.service_name, ''),
                 NULLIF(t.metadata->'legacy'->>'job_type', ''),
                 NULLIF(t.metadata->>'job_type', ''), '—') AS job_type,
        COALESCE(NULLIF(local_job.blanc_status, ''),
                 NULLIF(t.metadata->'legacy'->>'status', ''), '—') AS status,
        t.transaction_type,
        t.payment_method,
        CASE
            WHEN t.external_source = 'zenbooker'
                 AND NULLIF(t.metadata->'legacy'->>'payment_methods', '') IS NOT NULL
                THEN t.metadata->'legacy'->>'payment_methods'
            WHEN t.payment_method IN ('credit_card', 'zb_card') THEN 'card'
            WHEN t.payment_method IN ('check', 'zb_check') THEN 'check'
            WHEN t.payment_method IN ('cash', 'zb_cash') THEN 'cash'
            WHEN t.payment_method IN ('ach', 'zb_ach') THEN 'ach'
            WHEN t.payment_method = 'zb_venmo' THEN 'venmo'
            WHEN t.payment_method = 'zb_zelle' THEN 'zelle'
            ELSE 'other'
        END AS payment_methods,
        CASE
            WHEN t.external_source = 'zenbooker'
                 AND NULLIF(t.metadata->'legacy'->>'display_payment_method', '') IS NOT NULL
                THEN t.metadata->'legacy'->>'display_payment_method'
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
        COALESCE(NULLIF(local_job.job_source, ''),
                 NULLIF(t.metadata->'legacy'->>'source', ''), '') AS source,
        COALESCE(NULLIF(provider_data.tech, ''), '—') AS tech,
        COALESCE(provider_data.provider_names, ARRAY[]::text[]) AS provider_names,
        CASE WHEN t.status = 'completed' THEN 'succeeded' ELSE t.status END AS transaction_status,
        t.status AS payment_status,
        CASE
            WHEN COALESCE(local_job.id, NULLIF(t.metadata->'legacy'->>'local_job_id', '')::bigint) IS NOT NULL THEN false
            WHEN t.external_source = 'zenbooker'
                THEN COALESCE((t.metadata->'legacy'->>'missing_job_link')::boolean, true)
            ELSE false
        END AS missing_job_link,
        COALESCE(i.status, t.metadata->'legacy'->>'invoice_status') AS invoice_status,
        COALESCE(i.total, NULLIF(t.metadata->'legacy'->>'invoice_total', '')::numeric) AS invoice_total,
        COALESCE(i.amount_paid, NULLIF(t.metadata->'legacy'->>'invoice_amount_paid', '')::numeric) AS invoice_amount_paid,
        COALESCE(i.balance_due, NULLIF(t.metadata->'legacy'->>'invoice_amount_due', '')::numeric) AS invoice_amount_due,
        CASE
            WHEN i.id IS NOT NULL THEN i.balance_due <= 0
            ELSE COALESCE((t.metadata->'legacy'->>'invoice_paid_in_full')::boolean, false)
        END AS invoice_paid_in_full,
        COALESCE((t.metadata->>'check_deposited') = 'true', false) AS check_deposited,
        CASE
            WHEN t.payment_method IN ('check', 'zb_check') THEN true
            WHEN LOWER(BTRIM(COALESCE(t.metadata->'legacy'->>'display_payment_method', ''))) IN ('check', 'cheque') THEN true
            WHEN LOWER(COALESCE(t.metadata->'legacy'->>'payment_methods', '')) LIKE '%check%' THEN true
            ELSE false
        END AS is_check,
        COALESCE(t.metadata->'legacy'->>'tags', '') AS tags,
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
            ELSE t.metadata->'legacy'->'invoice_detail'
        END AS invoice_detail,
        CASE
            WHEN local_job.id IS NOT NULL THEN jsonb_build_object(
                'job_number', local_job.job_number,
                'service_name', local_job.service_name,
                'service_address', local_job.address,
                'providers', COALESCE(provider_data.providers, '[]'::jsonb)
            )
            ELSE t.metadata->'legacy'->'job_detail'
        END AS job_detail,
        '[]'::jsonb AS attachments,
        (
            COALESCE(t.metadata->'legacy'->'metadata', '{}'::jsonb)
            || (COALESCE(t.metadata, '{}'::jsonb) - 'legacy' - 'pay_dezb_001_snapshot')
        ) - 'pay_ledger_unify_001_check_deposited_backfill' AS metadata
    FROM payment_transactions t
    LEFT JOIN invoices i
      ON i.company_id = t.company_id
     AND i.id = t.invoice_id
    LEFT JOIN jobs local_job
      ON local_job.company_id = t.company_id
     AND local_job.id = COALESCE(t.job_id, i.job_id)
    LEFT JOIN contacts c
      ON c.company_id = t.company_id
     AND c.id = COALESCE(t.contact_id, i.contact_id, local_job.contact_id,
                         NULLIF(t.metadata->'legacy'->>'contact_id', '')::bigint)
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
                WHEN jsonb_typeof(COALESCE(
                    local_job.assigned_techs,
                    t.metadata->'legacy'->'assigned_techs',
                    '[]'::jsonb
                )) = 'array' THEN COALESCE(
                    local_job.assigned_techs,
                    t.metadata->'legacy'->'assigned_techs',
                    '[]'::jsonb
                )
                ELSE '[]'::jsonb
            END
        ) WITH ORDINALITY AS provider(value, ordinality)
        WHERE BTRIM(COALESCE(provider.value->>'name', '')) <> ''
    ) provider_data ON true
    LEFT JOIN LATERAL (
        SELECT COALESCE(string_agg(field.value, '; ' ORDER BY field.key), '') AS value
        FROM jsonb_each_text(
            CASE
                WHEN jsonb_typeof(COALESCE(
                    local_job.metadata,
                    t.metadata->'legacy'->'job_metadata',
                    '{}'::jsonb
                )) = 'object' THEN COALESCE(
                    local_job.metadata,
                    t.metadata->'legacy'->'job_metadata',
                    '{}'::jsonb
                )
                ELSE '{}'::jsonb
            END
        ) AS field(key, value)
        WHERE field.value <> ''
    ) custom_fields ON true
    WHERE t.company_id = $1
`;


/**
 * The ledger's invoice figures, derived like every other invoice surface.
 *
 * `PAYMENT_LEDGER_ROWS_SQL` reads `i.amount_paid` / `i.balance_due` straight off
 * the table. Those columns are LEGACY: money belongs to the job and an invoice
 * derives its paid amount from that job's payment pool (documentPaymentQueries),
 * which `invoicesQueries` applies on every read. The ledger was the one surface
 * that skipped it, so a fully-settled invoice still reported its original
 * balance — payment 46348 paid invoice 49 in full and the card read
 * "Paid $0.00 · Due $1,665.81"; the list painted the same debt in red.
 *
 * Rather than duplicate the allocator in SQL, run the rows through the very
 * same function. One definition, so the surfaces cannot disagree again.
 */
async function withDerivedInvoiceFigures(companyId, rows, client = null) {
    const list = Array.isArray(rows) ? rows : [];
    const invoices = [];
    const seen = new Set();
    for (const row of list) {
        const invoiceId = row?.canonical_invoice_id;
        const jobId = row?.canonical_job_id;
        if (invoiceId == null || jobId == null || seen.has(String(invoiceId))) continue;
        seen.add(String(invoiceId));
        invoices.push({
            id: invoiceId,
            job_id: jobId,
            total: row.invoice_total,
            amount_paid: row.invoice_amount_paid,
            balance_due: row.invoice_amount_due,
            status: row.invoice_status,
        });
    }
    if (invoices.length === 0) return list;

    const allocated = await applyInvoiceAllocations(companyId, invoices, client);
    const byId = new Map(allocated.map(invoice => [String(invoice.id), invoice]));

    return list.map(row => {
        const derived = row?.canonical_invoice_id != null
            ? byId.get(String(row.canonical_invoice_id))
            : null;
        if (!derived) return row;
        const amountPaid = String(derived.amount_paid);
        const amountDue = String(derived.balance_due);
        return {
            ...row,
            invoice_status: derived.status,
            invoice_amount_paid: amountPaid,
            invoice_amount_due: amountDue,
            invoice_paid_in_full: Number(derived.balance_due) <= 0,
            invoice_detail: row.invoice_detail
                ? {
                    ...row.invoice_detail,
                    status: derived.status,
                    amount_paid: amountPaid,
                    amount_due: amountDue,
                    paid_in_full: Number(derived.balance_due) <= 0,
                }
                : row.invoice_detail,
        };
    });
}

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
        generation: 'payment-transactions-v3-dezb',
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
        baseConditions.push(`p.payment_date >= ${dayStartInCompanyTz(params.length)}`);
    }
    if (dateTo) {
        params.push(dateTo);
        baseConditions.push(`p.payment_date < ${dayAfterInCompanyTz(params.length)}`);
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
    const derivedRows = await withDerivedInvoiceFigures(companyId, rows);
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
        rows: derivedRows,
        total,
        aggregates,
        facets,
        pagination: {
            mode,
            limit: pageLimit,
            returned: derivedRows.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            total,
        },
    };
}

/**
 * A calendar day boundary, in the COMPANY's timezone (owner, 2026-08-16).
 *
 * `payment_date` is a timestamptz and the session runs in UTC, so comparing it
 * to a bare `$n::date` asked Postgres for midnight UTC. A payment taken at
 * 8pm on the 14th in New York is stored as the 15th at 00:00Z, so a filter for
 * "Aug 15–16" dragged in a payment the list itself printed as Aug 14 — the
 * boundary and the display disagreed about what a day is.
 *
 * The company's own timezone decides. `companies.timezone` is the source of
 * truth (America/New_York is the established fallback elsewhere in the
 * backend), read inline so the bound can never drift from the setting.
 */
const COMPANY_TZ = "COALESCE((SELECT c.timezone FROM companies c WHERE c.id = $1), 'America/New_York')";
const dayStartInCompanyTz = (dateParam) => `((($${dateParam})::date)::timestamp AT TIME ZONE ${COMPANY_TZ})`;
const dayAfterInCompanyTz = (dateParam) => `((($${dateParam})::date + interval '1 day')::timestamp AT TIME ZONE ${COMPANY_TZ})`;

async function listPaymentsForExport(companyId, { dateFrom, dateTo, paymentMethod, search } = {}) {
    if (!companyId) {
        throw paymentsListError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    const conditions = ['p.company_id = $1'];
    const params = [companyId];
    let paramIdx = 2;

    if (dateFrom) {
        conditions.push(`p.payment_date >= ${dayStartInCompanyTz(paramIdx)}`);
        params.push(dateFrom);
        paramIdx++;
    }
    if (dateTo) {
        conditions.push(`p.payment_date < ${dayAfterInCompanyTz(paramIdx)}`);
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
    }

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
            p.amount_paid::text AS amount_paid,
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
         WHERE ${conditions.join(' AND ')}
         ORDER BY p.payment_date DESC`,
        params
    );
    return result.rows;
}

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
    // Same derivation as the list: the card must not read the legacy columns.
    const [derived] = await withDerivedInvoiceFigures(companyId, result.rows);
    result.rows[0] = derived || result.rows[0];

    const r = result.rows[0];
    const detailMetadata = Object.fromEntries(Object.entries(r.metadata || {}).map(([key, value]) => [
        key,
        value == null ? null : (typeof value === 'object' ? JSON.stringify(value) : String(value)),
    ]));

    return {
        id: r.id,
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
        invoice: r.invoice_detail || null,
        job: r.job_detail || null,
        attachments: [],
        metadata: detailMetadata,
        _warning: r.missing_job_link ? 'Some job details are unavailable right now.' : null,
    };
}

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
    PAYMENT_LEDGER_ROWS_SQL,
    listPayments,
    listPaymentsForExport,
    getPaymentDetail,
    updateCheckDeposited,
};
