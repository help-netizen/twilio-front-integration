/**
 * Canonical business-action logger.
 *
 * Unlike auditService.log(), transaction-backed callers receive insert errors so
 * the mutation and its activity row can roll back together.
 */

const db = require('../db/connection');

const ACTOR_TYPES = new Set(['user', 'ai', 'integration', 'system', 'client']);
const PARENT_TYPES = new Set(['job', 'lead', 'contact']);
const SOURCES = new Set(['crm', 'portal', 'webhook', 'agent', 'mcp', 'sync']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_RE = /(^|_)(message|body|text|content|token|url|email|phone|signature|payload|request|response|metadata|raw)(_|$)/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;

function isPlainObject(value) {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function isAllowedKey(key) {
    if (SENSITIVE_KEY_RE.test(key)) return false;
    return key === 'id'
        || key === 'ids'
        || key.endsWith('_id')
        || key.endsWith('_ids')
        || key === 'status'
        || key.endsWith('_status')
        || key === 'field'
        || key === 'fields'
        || key.startsWith('field_')
        || key === 'section'
        || key === 'sections'
        || key.startsWith('section_')
        || key === 'amount'
        || key.endsWith('_amount')
        || key === 'total'
        || key === 'currency'
        || key === 'count'
        || key === 'counts'
        || key.endsWith('_count')
        || key === 'channel'
        || key === 'actor_type'
        || key === 'actor_label'
        || key === 'parent_type'
        || key === 'parent_id'
        || key === 'source';
}

function isIdKey(key) {
    return key === 'id'
        || key === 'ids'
        || key.endsWith('_id')
        || key.endsWith('_ids');
}

function sanitizeScalar(key, value) {
    if (value === null || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;

    const trimmed = value.trim();
    if (!trimmed || EMAIL_RE.test(trimmed) || URL_RE.test(trimmed)) return undefined;
    if (!isIdKey(key) && PHONE_RE.test(trimmed)) return undefined;
    return trimmed.slice(0, 255);
}

function sanitizeAllowedValue(key, value, { summary = false } = {}) {
    if (key === 'actor_type') {
        return ACTOR_TYPES.has(value) ? value : undefined;
    }
    if (key === 'parent_type') {
        return value === null || PARENT_TYPES.has(value) ? value : undefined;
    }
    if (key === 'source') {
        return SOURCES.has(value) ? value : undefined;
    }
    if (key === 'counts' && isPlainObject(value) && !summary) {
        const counts = {};
        for (const [countKey, countValue] of Object.entries(value)) {
            if (/^[a-z][a-z0-9_]{0,63}$/i.test(countKey)
                && !SENSITIVE_KEY_RE.test(countKey)
                && typeof countValue === 'number'
                && Number.isFinite(countValue)) {
                counts[countKey] = countValue;
            }
        }
        return Object.keys(counts).length > 0 ? counts : undefined;
    }
    if (Array.isArray(value) && !summary) {
        const values = value
            .map(item => sanitizeScalar(key, item))
            .filter(item => item !== undefined);
        return values.length > 0 ? values : undefined;
    }
    return sanitizeScalar(key, value);
}

/**
 * Keep only explicitly safe activity metadata.
 *
 * @param {object} details
 * @returns {object}
 */
function sanitizeDetails(details) {
    if (!isPlainObject(details)) return {};

    const sanitized = {};
    for (const [key, value] of Object.entries(details)) {
        if (key === 'summary') {
            if (!isPlainObject(value)) continue;
            const summary = {};
            for (const [summaryKey, summaryValue] of Object.entries(value)) {
                if (!isAllowedKey(summaryKey)) continue;
                const safeValue = sanitizeAllowedValue(summaryKey, summaryValue, { summary: true });
                if (safeValue !== undefined) summary[summaryKey] = safeValue;
            }
            if (Object.keys(summary).length > 0) sanitized.summary = summary;
            continue;
        }
        if (!isAllowedKey(key)) continue;
        const safeValue = sanitizeAllowedValue(key, value);
        if (safeValue !== undefined) sanitized[key] = safeValue;
    }
    return sanitized;
}

function requiredString(value, field) {
    if (value === null || value === undefined || String(value).trim() === '') {
        throw new Error(`[ActivityLog] ${field} is required`);
    }
    return String(value).trim();
}

async function validateActor(runner, companyId, event, actorType) {
    if (actorType !== 'user') {
        if (event.actor_id !== null && event.actor_id !== undefined) {
            throw new Error('[ActivityLog] actor_id must be null for non-user actors');
        }
        return null;
    }

    const actorId = requiredString(event.actor_id, 'actor_id for user actors');
    if (!UUID_RE.test(actorId) || (event.sub && String(event.sub) === actorId)) {
        throw new Error('[ActivityLog] actor_id must be a crm_users.id, never a Keycloak sub');
    }

    const { rows } = await runner.query(
        `SELECT u.id
         FROM crm_users u
         JOIN company_memberships m
           ON m.user_id = u.id
          AND m.company_id = $2
          AND m.status = 'active'
         WHERE u.id = $1
         LIMIT 1`,
        [actorId, companyId]
    );
    if (rows.length === 0) {
        throw new Error('[ActivityLog] actor_id is not an active crm user for this company');
    }
    return actorId;
}

async function validateParent(runner, companyId, parentType, parentId) {
    const hasType = parentType !== null && parentType !== undefined;
    const hasId = parentId !== null && parentId !== undefined && String(parentId).trim() !== '';
    if (!hasType && !hasId) return { parentType: null, parentId: null };
    if (!hasType || !hasId || !PARENT_TYPES.has(parentType)) {
        throw new Error('[ActivityLog] parent_type/parent_id must be a valid pair');
    }

    let sql;
    if (parentType === 'lead') {
        sql = `SELECT id::text AS id
               FROM leads
               WHERE company_id = $1
                 AND (id::text = $2 OR serial_id::text = $2)
               LIMIT 1`;
    } else {
        const table = parentType === 'job' ? 'jobs' : 'contacts';
        sql = `SELECT id::text AS id
               FROM ${table}
               WHERE company_id = $1 AND id::text = $2
               LIMIT 1`;
    }

    const { rows } = await runner.query(sql, [companyId, String(parentId).trim()]);
    if (rows.length === 0) {
        throw new Error(`[ActivityLog] ${parentType} parent does not belong to this company`);
    }
    return { parentType, parentId: rows[0].id };
}

/**
 * @param {{
 *   action: string,
 *   target_type: string,
 *   target_id: string|number,
 *   company_id: string,
 *   actor_id?: string|null,
 *   details?: object
 * }} event
 * @param {{ client?: { query: Function } }} options
 * @returns {Promise<{ok: true, id: string|number|null}|{ok: false, error: Error}>}
 */
async function logActivity(event, { client } = {}) {
    if (!event?.company_id) {
        throw new Error('[ActivityLog] company_id is required');
    }

    const runner = client || db;
    const execute = async () => {
        const action = requiredString(event.action, 'action');
        const targetType = requiredString(event.target_type, 'target_type');
        const targetId = requiredString(event.target_id, 'target_id');
        const rawDetails = isPlainObject(event.details) ? event.details : {};
        const actorType = rawDetails.actor_type || (event.actor_id ? 'user' : 'system');
        if (!ACTOR_TYPES.has(actorType)) {
            throw new Error('[ActivityLog] invalid details.actor_type');
        }

        const actorId = await validateActor(runner, event.company_id, event, actorType);
        const parent = await validateParent(
            runner,
            event.company_id,
            rawDetails.parent_type,
            rawDetails.parent_id
        );
        const details = sanitizeDetails(rawDetails);
        details.actor_type = actorType;
        if (actorType === 'user') {
            details.actor_label = null;
        } else {
            if (typeof details.actor_label !== 'string') {
                throw new Error('[ActivityLog] details.actor_label for non-user actors is required');
            }
            details.actor_label = requiredString(
                details.actor_label,
                'details.actor_label for non-user actors'
            );
        }
        details.parent_type = parent.parentType;
        details.parent_id = parent.parentId;

        const { rows } = await runner.query(
            `INSERT INTO audit_log (
                actor_id, actor_email, actor_ip, action, target_type,
                target_id, company_id, details, trace_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [
                actorId,
                null,
                null,
                action,
                targetType,
                targetId,
                event.company_id,
                JSON.stringify(details),
                null,
            ]
        );
        return { ok: true, id: rows[0]?.id ?? null };
    };

    if (client) return execute();

    try {
        return await execute();
    } catch (error) {
        console.error('[ActivityLog] Failed to log event:', event.action, error.message);
        return { ok: false, error };
    }
}

module.exports = { logActivity, sanitizeDetails };
