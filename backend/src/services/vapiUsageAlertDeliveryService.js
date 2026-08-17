'use strict';

const { createHash, randomUUID } = require('crypto');
const emailService = require('./emailService');
const feedbackService = require('./feedbackService');
const { withTransaction } = require('./transactionService');
const { addDecimalStrings, stableStringify } = require('./vapiUsageIngestService');

const DEFAULT_THRESHOLD = '10';
const DEFAULT_DIGEST_INTERVAL_MINUTES = 60;
const DEFAULT_MAX_ITEMS = 100;
const DELIVERY_LEASE_MS = 5 * 60 * 1000;

function normalizeUnsignedDecimal(value, fallback) {
    const candidate = value === undefined || value === null || value === ''
        ? fallback
        : String(value).trim();
    const match = candidate.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) throw new Error('VAPI_USAGE_ALERT_MONEY_INVALID');
    const whole = match[1].replace(/^0+(?=\d)/, '');
    const fraction = (match[2] || '').replace(/0+$/, '');
    if (fraction.length > 12) throw new Error('VAPI_USAGE_ALERT_MONEY_SCALE_EXCEEDED');
    return fraction ? `${whole}.${fraction}` : whole;
}

function decimalParts(value) {
    const normalized = normalizeUnsignedDecimal(value, '0');
    const [whole, fraction = ''] = normalized.split('.');
    return { normalized, whole, fraction };
}

function compareUnsignedDecimals(left, right) {
    const a = decimalParts(left);
    const b = decimalParts(right);
    if (a.whole.length !== b.whole.length) return a.whole.length > b.whole.length ? 1 : -1;
    if (a.whole !== b.whole) return a.whole > b.whole ? 1 : -1;
    const scale = Math.max(a.fraction.length, b.fraction.length);
    const af = a.fraction.padEnd(scale, '0');
    const bf = b.fraction.padEnd(scale, '0');
    if (af === bf) return 0;
    return af > bf ? 1 : -1;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, maximum);
}

function configuration(env = process.env) {
    const recipient = String(
        env.VAPI_USAGE_ALERT_RECIPIENT || feedbackService.FEEDBACK_INBOX_EMAIL,
    ).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        throw new Error('VAPI_USAGE_ALERT_RECIPIENT_INVALID');
    }
    const threshold = normalizeUnsignedDecimal(
        env.VAPI_USAGE_ALERT_THRESHOLD_USD,
        DEFAULT_THRESHOLD,
    );
    if (compareUnsignedDecimals(threshold, '0') <= 0) {
        throw new Error('VAPI_USAGE_ALERT_THRESHOLD_NOT_POSITIVE');
    }
    return {
        threshold,
        digestIntervalMinutes: positiveInteger(
            env.VAPI_USAGE_ALERT_DIGEST_INTERVAL_MINUTES,
            DEFAULT_DIGEST_INTERVAL_MINUTES,
            24 * 60,
        ),
        maxItems: positiveInteger(
            env.VAPI_USAGE_ALERT_MAX_ITEMS,
            DEFAULT_MAX_ITEMS,
            1000,
        ),
        recipient,
        senderCompanyId: String(
            env.VAPI_USAGE_ALERT_SENDER_COMPANY_ID || feedbackService.SENDER_COMPANY_ID,
        ).trim(),
    };
}

function alertFingerprint(row) {
    return createHash('sha256').update(stableStringify({
        id: row.id,
        kind: row.kind,
        providerCallId: row.provider_call_id,
        updatedAt: new Date(row.updated_at).toISOString(),
        cost: row.at_risk_cost,
        costBasis: row.effective_cost_basis,
        details: row.details,
    }), 'utf8').digest('hex');
}

function exposureKey(row) {
    if (row.provider_call_id) return `provider:${row.provider_call_id}`;
    if (row.vapi_call_session_id) return `session:${row.vapi_call_session_id}`;
    return `alert:${row.id}`;
}

function summarizeRows(rows) {
    const exposures = new Map();
    for (const row of rows) {
        const key = exposureKey(row);
        const candidate = row.at_risk_cost === null
            ? null
            : normalizeUnsignedDecimal(row.at_risk_cost, '0');
        const previous = exposures.get(key);
        if (!previous) {
            exposures.set(key, {
                cost: candidate,
                basis: row.effective_cost_basis,
            });
            continue;
        }
        if (candidate === null) continue;
        if (previous.cost === null
            || (previous.basis === 'fallback_estimate'
                && row.effective_cost_basis === 'supplier')
            || (previous.basis === row.effective_cost_basis
                && compareUnsignedDecimals(candidate, previous.cost) > 0)) {
            exposures.set(key, {
                cost: candidate,
                basis: row.effective_cost_basis,
            });
        }
    }
    const known = [...exposures.values()].filter((row) => row.cost !== null);
    const estimated = known.filter((row) => row.basis === 'fallback_estimate');
    return {
        total: addDecimalStrings(known.map((row) => row.cost).concat('0')),
        estimatedTotal: addDecimalStrings(estimated.map((row) => row.cost).concat('0')),
        unknownCount: [...exposures.values()].filter((row) => row.cost === null).length,
    };
}

async function loadUnresolvedAlerts(client) {
    const result = await client.query(
        `SELECT alert.id, alert.company_id, alert.vapi_call_session_id,
                alert.provider_call_id, alert.kind, alert.details,
                alert.created_at, alert.updated_at,
                COALESCE(
                    alert.supplier_cost_at_risk,
                    usage.supplier_cost,
                    estimate.effective_supplier_cost
                )::text AS at_risk_cost,
                CASE
                    WHEN alert.supplier_cost_at_risk IS NOT NULL THEN alert.cost_basis
                    WHEN usage.supplier_cost IS NOT NULL THEN 'supplier'
                    WHEN estimate.effective_supplier_cost IS NOT NULL
                        THEN 'fallback_estimate'
                    ELSE 'unknown'
                END AS effective_cost_basis
         FROM vapi_usage_alerts alert
         LEFT JOIN vapi_call_usage usage
           ON usage.vapi_call_session_id = alert.vapi_call_session_id
          AND usage.company_id = alert.company_id
         LEFT JOIN LATERAL (
             SELECT event.effective_supplier_cost
             FROM vapi_call_cost_input_events event
             WHERE event.vapi_call_session_id = alert.vapi_call_session_id
               AND event.company_id = alert.company_id
               AND event.event_kind = 'fallback_estimate'
             ORDER BY event.input_version DESC
             LIMIT 1
         ) estimate ON true
         WHERE alert.resolved_at IS NULL
         ORDER BY alert.created_at, alert.id`,
    );
    return result.rows;
}

async function lastSentDelivery(client) {
    const result = await client.query(
        `SELECT content_fingerprint, supplier_cost_at_risk::text, sent_at
         FROM vapi_usage_alert_delivery_runs
         WHERE status = 'sent'
         ORDER BY sent_at DESC, created_at DESC
         LIMIT 1`,
    );
    return result.rows[0] || null;
}

function digestFingerprint(rows) {
    return createHash('sha256').update(
        rows.map((row) => alertFingerprint(row)).sort().join(':'),
        'utf8',
    ).digest('hex');
}

async function claimDeliveryWithClient({ now = new Date(), config }, client) {
    const rows = await loadUnresolvedAlerts(client);
    if (rows.length === 0) return { skipped: true, reason: 'no_alerts' };
    const fingerprint = digestFingerprint(rows);
    const lastSent = await lastSentDelivery(client);
    if (lastSent?.content_fingerprint === fingerprint) {
        return { skipped: true, reason: 'unchanged' };
    }

    const summary = summarizeRows(rows);
    const aboveThreshold = compareUnsignedDecimals(summary.total, config.threshold) > 0;
    const anchor = lastSent?.sent_at || rows[0].created_at;
    const digestDue = now.getTime() - new Date(anchor).getTime()
        >= config.digestIntervalMinutes * 60 * 1000;
    if (!aboveThreshold && !digestDue) {
        return { skipped: true, reason: 'digest_not_due' };
    }

    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const inserted = await client.query(
        `INSERT INTO vapi_usage_alert_delivery_runs (
             content_fingerprint, reason, window_start, window_end,
             supplier_cost_at_risk, estimated_cost_at_risk,
             alert_count, unknown_cost_count, threshold_amount,
             recipient, status, claim_token, lease_expires_at, started_at
         ) VALUES (
             $1, $2, $3, $4, $5::numeric, $6::numeric,
             $7, $8, $9::numeric, $10, 'sending', $11, $12, $4
         )
         ON CONFLICT (content_fingerprint) DO UPDATE
         SET status = 'sending', claim_token = EXCLUDED.claim_token,
             lease_expires_at = EXCLUDED.lease_expires_at,
             attempt_count = vapi_usage_alert_delivery_runs.attempt_count + 1,
             last_error = NULL, started_at = EXCLUDED.started_at
         WHERE vapi_usage_alert_delivery_runs.status = 'failed'
            OR (
                vapi_usage_alert_delivery_runs.status = 'sending'
                AND vapi_usage_alert_delivery_runs.lease_expires_at <= $4
            )
         RETURNING *`,
        [
            fingerprint,
            aboveThreshold ? 'threshold' : 'digest',
            rows[0].created_at,
            now,
            summary.total,
            summary.estimatedTotal,
            rows.length,
            summary.unknownCount,
            config.threshold,
            config.recipient,
            claimToken,
            leaseExpiresAt,
        ],
    );
    if (!inserted.rows[0]) return { skipped: true, reason: 'already_claimed' };

    for (const row of rows) {
        await client.query(
            `INSERT INTO vapi_usage_alert_delivery_items (
                 delivery_run_id, alert_id, alert_fingerprint,
                 supplier_cost_at_risk, cost_basis
             ) VALUES ($1, $2, $3, $4::numeric, $5)
             ON CONFLICT (delivery_run_id, alert_id) DO NOTHING`,
            [
                inserted.rows[0].id,
                row.id,
                alertFingerprint(row),
                row.at_risk_cost,
                row.effective_cost_basis,
            ],
        );
    }
    return {
        skipped: false,
        run: inserted.rows[0],
        rows,
        summary,
        claimToken,
    };
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function displayMoney(value) {
    const normalized = normalizeUnsignedDecimal(value, '0');
    const [whole, fraction = ''] = normalized.split('.');
    if (fraction.length === 0) return `${whole}.00`;
    if (fraction.length === 1) return `${whole}.${fraction}0`;
    return normalized;
}

function buildDigestEmail({ run, rows, summary, config }) {
    const typeCounts = new Map();
    for (const row of rows) typeCounts.set(row.kind, (typeCounts.get(row.kind) || 0) + 1);
    const firstLine = `At-risk supplier cost: $${displayMoney(summary.total)}; `
        + `$${displayMoney(summary.estimatedTotal)} is fallback-estimated; `
        + `${summary.unknownCount} call(s) still have unknown cost.`;
    const types = [...typeCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([kind, count]) => `${kind}: ${count}`);
    const visibleRows = rows.slice(0, config.maxItems);
    const calls = visibleRows.map((row) => {
        const identity = row.provider_call_id
            ? `provider_call_id=${row.provider_call_id}`
            : row.vapi_call_session_id
                ? `session_id=${row.vapi_call_session_id}`
                : `alert_id=${row.id}`;
        const cost = row.at_risk_cost === null
            ? 'cost=unknown'
            : `cost=$${displayMoney(row.at_risk_cost)} (${row.effective_cost_basis})`;
        return `${row.kind} | ${identity} | ${cost}`;
    });
    if (rows.length > visibleRows.length) {
        calls.push(`... ${rows.length - visibleRows.length} more alert(s) omitted`);
    }
    const textBody = [
        firstLine,
        `Unresolved alerts: ${rows.length}; calls with unknown cost: ${summary.unknownCount}.`,
        `Delivery reason: ${run.reason}; threshold: $${displayMoney(config.threshold)}.`,
        '',
        'By type:',
        ...types,
        '',
        'Calls:',
        ...calls,
    ].join('\n');
    const body = [
        `<p><strong>${escapeHtml(firstLine)}</strong></p>`,
        `<p>Unresolved alerts: ${rows.length}; calls with unknown cost: ${summary.unknownCount}.<br>`,
        `Delivery reason: ${escapeHtml(run.reason)}; threshold: $${escapeHtml(displayMoney(config.threshold))}.</p>`,
        '<p><strong>By type</strong></p>',
        `<ul>${types.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
        '<p><strong>Calls</strong></p>',
        `<ul>${calls.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
    ].join('');
    return {
        subject: `Albusto Vapi cost risk: $${displayMoney(summary.total)}`,
        textBody,
        body,
    };
}

function createVapiUsageAlertDeliveryService(dependencies = {}) {
    const transact = dependencies.withTransaction || withTransaction;
    const mailer = dependencies.emailService || emailService;

    async function dispatchAlerts(options = {}) {
        const now = options.now || new Date();
        const config = options.config || configuration(options.env);
        const claimed = await transact(
            (client) => claimDeliveryWithClient({ now, config }, client),
        );
        if (claimed.skipped) return claimed;
        const email = buildDigestEmail({ ...claimed, config });
        try {
            await mailer.sendEmail(config.senderCompanyId, {
                to: config.recipient,
                subject: email.subject,
                body: email.body,
                textBody: email.textBody,
                files: [],
            });
            await transact(async (client) => {
                const completed = await client.query(
                    // tenant-safety-allow R-natural-key: delivery runs are platform-global; id plus the one-time claim token scopes this completion.
                    `UPDATE vapi_usage_alert_delivery_runs
                     SET status = 'sent', sent_at = $3,
                         claim_token = NULL, lease_expires_at = NULL,
                         last_error = NULL
                     WHERE id = $1 AND claim_token = $2 AND status = 'sending'
                     RETURNING id`,
                    [claimed.run.id, claimed.claimToken, now],
                );
                if (completed.rows.length !== 1) {
                    throw new Error('VAPI_USAGE_ALERT_DELIVERY_CLAIM_LOST');
                }
                await client.query(
                    `UPDATE vapi_usage_alerts alert
                     SET last_delivered_at = $2,
                         last_delivered_fingerprint = item.alert_fingerprint,
                         last_delivery_run_id = $1
                     FROM vapi_usage_alert_delivery_items item
                     WHERE item.delivery_run_id = $1
                       AND item.alert_id = alert.id`,
                    [claimed.run.id, now],
                );
            });
            return {
                skipped: false,
                sent: true,
                reason: claimed.run.reason,
                alertCount: claimed.rows.length,
                supplierCostAtRisk: claimed.summary.total,
            };
        } catch (error) {
            await transact((client) => client.query(
                // tenant-safety-allow R-natural-key: delivery runs are platform-global; id plus the one-time claim token scopes this failure transition.
                `UPDATE vapi_usage_alert_delivery_runs
                 SET status = 'failed', last_error = $3,
                     claim_token = NULL, lease_expires_at = NULL
                 WHERE id = $1 AND claim_token = $2 AND status = 'sending'`,
                [claimed.run.id, claimed.claimToken, String(error.message).slice(0, 255)],
            ));
            console.error('[vapiUsageAlerts] digest delivery failed', {
                deliveryRunId: claimed.run.id,
                error: String(error.message).slice(0, 255),
            });
            return { skipped: false, sent: false, failed: true };
        }
    }

    return { dispatchAlerts };
}

const singleton = createVapiUsageAlertDeliveryService();

module.exports = {
    DEFAULT_THRESHOLD,
    DEFAULT_DIGEST_INTERVAL_MINUTES,
    DEFAULT_MAX_ITEMS,
    normalizeUnsignedDecimal,
    compareUnsignedDecimals,
    configuration,
    summarizeRows,
    claimDeliveryWithClient,
    buildDigestEmail,
    createVapiUsageAlertDeliveryService,
    dispatchAlerts: (options) => singleton.dispatchAlerts(options),
};
