'use strict';

const db = require('../db/connection');
const roleQueries = require('../db/roleQueries');
const auditService = require('./auditService');
const authorizationService = require('./authorizationService');
const { toE164 } = require('../utils/phoneUtils');

const DEFAULT_MASKING_NUMBER = '+16174044425';
const CODE_DIGITS = 6;
const MAX_CODE = 999999;
const E164 = /^\+[1-9]\d{7,14}$/;

function serviceError(httpStatus, code, message) {
    const err = new Error(message);
    err.httpStatus = httpStatus;
    err.code = code;
    return err;
}

function requireCompanyId(companyId) {
    if (!companyId) {
        throw serviceError(403, 'TENANT_CONTEXT_REQUIRED', 'Company context is required');
    }
}

function queryFor(queryable) {
    return queryable && typeof queryable.query === 'function' ? queryable : db;
}

function formatCode(code) {
    return String(Number(code)).padStart(CODE_DIGITS, '0');
}

function normalizePhone(value) {
    const normalized = toE164(value);
    return normalized && E164.test(normalized) ? normalized : null;
}

function validateSettings(payload) {
    const input = payload || {};
    if (typeof input.call_masking_enabled !== 'boolean') {
        throw serviceError(422, 'INVALID_SETTINGS', 'call_masking_enabled must be a boolean');
    }
    if (typeof input.call_masking_number !== 'string' || !E164.test(input.call_masking_number.trim())) {
        throw serviceError(422, 'INVALID_SETTINGS', 'call_masking_number must be E.164');
    }
    return {
        call_masking_enabled: input.call_masking_enabled,
        call_masking_number: input.call_masking_number.trim(),
    };
}

function validateRequestedRoles(payload) {
    const input = payload || {};
    if (!Object.prototype.hasOwnProperty.call(input, 'roles')) return null;
    if (!Array.isArray(input.roles) || input.roles.some(role => typeof role !== 'string')) {
        throw serviceError(422, 'INVALID_SETTINGS', 'roles must be an array of role keys');
    }
    return input.roles;
}

async function getSettings(companyId, queryable = db) {
    requireCompanyId(companyId);
    const { rows } = await queryFor(queryable).query(
        `SELECT call_masking_enabled, call_masking_number
         FROM company_telephony
         WHERE company_id = $1`,
        [companyId]
    );
    const roleConfigs = await roleQueries.listRoleConfigs(companyId, queryable);
    const roles = [];
    for (const roleConfig of roleConfigs) {
        const allowedKeys = await roleQueries.getAllowedPermissionKeys(
            roleConfig.id,
            queryable,
            companyId
        );
        if (allowedKeys.includes('call_masking.use')) roles.push(roleConfig.role_key);
    }
    return {
        call_masking_enabled: rows[0]?.call_masking_enabled === true,
        call_masking_number: rows[0]?.call_masking_number || DEFAULT_MASKING_NUMBER,
        roles,
    };
}

async function getActiveSettings(companyId, maskingNumber = null, queryable = db) {
    requireCompanyId(companyId);
    const params = [companyId];
    let numberFilter = '';
    if (maskingNumber != null) {
        params.push(maskingNumber);
        numberFilter = `AND ct.call_masking_number = $${params.length}`;
    }
    const { rows } = await queryFor(queryable).query(
        `SELECT ct.call_masking_number
         FROM company_telephony ct
         JOIN phone_number_settings pns
           ON pns.company_id = ct.company_id
          AND pns.phone_number = ct.call_masking_number
         WHERE ct.company_id = $1
           AND ct.call_masking_enabled = true
           ${numberFilter}
         LIMIT 1`,
        params
    );
    return rows[0] && E164.test(String(rows[0].call_masking_number || ''))
        ? { call_masking_enabled: true, call_masking_number: rows[0].call_masking_number }
        : null;
}

async function persistSettings(companyId, settings, requestedRoles, queryable) {
    const query = queryFor(queryable);
    let roleConfigs = null;
    let roles = null;

    if (requestedRoles !== null) {
        roleConfigs = await roleQueries.listRoleConfigs(companyId, queryable);
        const validRoleKeys = new Set(roleConfigs.map(role => role.role_key));
        const unknownRoles = [...new Set(requestedRoles)]
            .filter(roleKey => !validRoleKeys.has(roleKey));
        if (unknownRoles.length > 0) {
            throw serviceError(422, 'INVALID_ROLES', 'One or more roles do not belong to this company');
        }
        const requestedRoleKeys = new Set(requestedRoles);
        roles = roleConfigs
            .filter(role => requestedRoleKeys.has(role.role_key))
            .map(role => role.role_key);
    }

    if (settings.call_masking_enabled) {
        const owned = await query.query(
            `SELECT 1
             FROM phone_number_settings
             WHERE company_id = $1 AND phone_number = $2
             LIMIT 1`,
            [companyId, settings.call_masking_number]
        );
        if (owned.rows.length === 0) {
            throw serviceError(422, 'MASKING_NUMBER_NOT_OWNED', 'Select a Twilio number owned by this company');
        }
    }

    const { rows } = await query.query(
        `INSERT INTO company_telephony
            (company_id, call_masking_enabled, call_masking_number)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id) DO UPDATE SET
            call_masking_enabled = EXCLUDED.call_masking_enabled,
            call_masking_number = EXCLUDED.call_masking_number,
            updated_at = now()
         RETURNING call_masking_enabled, call_masking_number`,
        [companyId, settings.call_masking_enabled, settings.call_masking_number]
    );

    if (roleConfigs) {
        const requestedRoleKeys = new Set(requestedRoles);
        for (const roleConfig of roleConfigs) {
            await roleQueries.setRolePermission(
                roleConfig.id,
                'call_masking.use',
                requestedRoleKeys.has(roleConfig.role_key),
                companyId,
                queryable
            );
        }
    }

    return roles === null ? rows[0] : { ...rows[0], roles };
}

async function saveSettings(companyId, payload, actorId, queryable = db) {
    requireCompanyId(companyId);
    const settings = validateSettings(payload);
    const requestedRoles = validateRequestedRoles(payload);
    let saved;

    if (queryable === db && requestedRoles !== null) {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            saved = await persistSettings(companyId, settings, requestedRoles, client);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    } else {
        saved = await persistSettings(companyId, settings, requestedRoles, queryable);
    }

    if (queryable === db) {
        auditService.log({
            actor_id: actorId || null,
            action: 'telephony.call_masking_settings_changed',
            target_type: 'company',
            target_id: companyId,
            company_id: companyId,
            details: saved,
        }).catch(() => {});
    }

    return saved;
}

function providerVisibility(providerScope, params, alias) {
    if (!providerScope?.assignedOnly) return '';
    if (!providerScope.userId) return 'AND FALSE';
    params.push(JSON.stringify([String(providerScope.userId)]));
    return `AND EXISTS (
        SELECT 1
        FROM jobs visible_job
        WHERE visible_job.company_id = ${alias}.company_id
          AND visible_job.contact_id = ${alias}.id
          AND visible_job.assigned_provider_user_ids @> $${params.length}::jsonb
    )`;
}

async function getVisibleContact(companyId, contactId, providerScope, queryable = db) {
    requireCompanyId(companyId);
    const params = [companyId, contactId];
    const visibility = providerVisibility(providerScope, params, 'c');
    const { rows } = await queryFor(queryable).query(
        `SELECT c.id,
                COALESCE(NULLIF(c.phone_e164, ''), NULLIF(c.secondary_phone, '')) AS customer_phone
         FROM contacts c
         WHERE c.company_id = $1
           AND c.id = $2
           ${visibility}`,
        params
    );
    return rows[0] || null;
}

async function allocateContactCode(companyId, contactId, queryable = db) {
    const { rows } = await queryFor(queryable).query(
        `WITH existing AS (
             SELECT code
             FROM contact_call_masking_codes
             WHERE company_id = $1 AND contact_id = $2
         ),
         next_code AS (
             INSERT INTO company_telephony
                (company_id, next_call_masking_code)
             SELECT $1, 2
             WHERE NOT EXISTS (SELECT 1 FROM existing)
             ON CONFLICT (company_id) DO UPDATE SET
                next_call_masking_code = company_telephony.next_call_masking_code + 1,
                updated_at = now()
             WHERE company_telephony.next_call_masking_code <= $3
             RETURNING next_call_masking_code - 1 AS code
         ),
         allocated AS (
             INSERT INTO contact_call_masking_codes (company_id, contact_id, code)
             SELECT $1, $2, code
             FROM next_code
             ON CONFLICT (company_id, contact_id) DO UPDATE SET
                contact_id = EXCLUDED.contact_id
             RETURNING code
         )
         SELECT code FROM existing
         UNION ALL
         SELECT code FROM allocated
         LIMIT 1`,
        [companyId, contactId, MAX_CODE]
    );
    if (!rows[0]) {
        throw serviceError(409, 'MASKING_CODE_EXHAUSTED', 'No call masking codes are available');
    }
    return formatCode(rows[0].code);
}

function disabledDialResult() {
    return {
        enabled: false,
        masking_number: null,
        code: null,
        display_number: null,
        tel_uri: null,
    };
}

/**
 * Inbound recognition works by caller-ID against the member's profile phone.
 * A viewer without one gets a mask that dials but can never route — surface
 * that as `caller_phone_missing` so the UI can warn instead of failing silently.
 */
async function callerPhoneMissing(companyId, requestingUserId, queryable) {
    if (!requestingUserId) return false;
    try {
        const { rows } = await queryFor(queryable).query(
            `SELECT p.phone
             FROM company_user_profiles p
             JOIN company_memberships m ON m.id = p.membership_id
             WHERE m.company_id = $1
               AND m.status = 'active'
               AND m.user_id = $2`,
            [companyId, requestingUserId]
        );
        return !rows.some(row => normalizePhone(row.phone));
    } catch {
        return false;
    }
}

async function getMaskedDialForContact(companyId, contactId, providerScope, queryable = db, requestingUserId = null) {
    const contact = await getVisibleContact(companyId, contactId, providerScope, queryable);
    if (!contact) return null;

    const settings = await getActiveSettings(companyId, null, queryable);
    if (!settings) return disabledDialResult();

    if (!normalizePhone(contact.customer_phone)) {
        throw serviceError(422, 'CONTACT_PHONE_REQUIRED', 'Contact has no callable phone number');
    }
    const code = await allocateContactCode(companyId, contact.id, queryable);
    const maskingNumber = settings.call_masking_number;
    return {
        enabled: true,
        masking_number: maskingNumber,
        code,
        display_number: maskingNumber,
        tel_uri: `tel:${maskingNumber},,${code}`,
        caller_phone_missing: await callerPhoneMissing(companyId, requestingUserId, queryable),
    };
}

async function getMaskedDialForJob(companyId, jobId, providerScope, queryable = db, requestingUserId = null) {
    requireCompanyId(companyId);
    const params = [companyId, jobId];
    let visibility = '';
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) visibility = 'AND FALSE';
        else {
            params.push(JSON.stringify([String(providerScope.userId)]));
            visibility = `AND j.assigned_provider_user_ids @> $${params.length}::jsonb`;
        }
    }
    const { rows } = await queryFor(queryable).query(
        `SELECT j.contact_id
         FROM jobs j
         WHERE j.company_id = $1
           AND j.id = $2
           AND j.contact_id IS NOT NULL
           ${visibility}`,
        params
    );
    if (!rows[0]) return null;
    return getMaskedDialForContact(companyId, rows[0].contact_id, providerScope, queryable, requestingUserId);
}

/**
 * Effective `call_masking.use` for one membership row — the SAME computation
 * `requirePermission` runs for the API routes (role matrix + per-user
 * overrides), so a member the settings page authorizes to place masked calls
 * is also recognized on the inbound leg. Errors fail closed.
 */
async function membershipMayUseMasking(companyId, row, queryable) {
    const roleKey = row.role_key || authorizationService.LEGACY_ROLE_MAPPING[row.role];
    if (!roleKey) return false;
    try {
        const { permissions } = await authorizationService.resolveEffectivePermissionsAndScopes(
            companyId,
            roleKey,
            row.membership_id,
            queryable && queryable !== db ? { client: queryable } : {}
        );
        return permissions.includes('call_masking.use');
    } catch {
        return false;
    }
}

async function resolveProviderByPhone(companyId, providerPhone, queryable = db) {
    requireCompanyId(companyId);
    const normalizedProviderPhone = normalizePhone(providerPhone);
    if (!normalizedProviderPhone) return null;
    // Any ACTIVE member is a candidate — not only is_provider profiles. The
    // masking settings page grants `call_masking.use` per role (admins and
    // dispatchers included), and recognition must honor the same grant or an
    // authorized caller silently falls through to the office route.
    const { rows } = await queryFor(queryable).query(
        `SELECT m.user_id, m.id AS membership_id, m.role, m.role_key, p.phone
         FROM company_user_profiles p
         JOIN company_memberships m ON m.id = p.membership_id
         WHERE m.company_id = $1
           AND m.status = 'active'
           AND p.phone IS NOT NULL`,
        [companyId]
    );
    const matches = rows.filter(row => normalizePhone(row.phone) === normalizedProviderPhone);
    const allowed = [];
    for (const row of matches) {
        if (await membershipMayUseMasking(companyId, row, queryable)) allowed.push(row);
    }
    return allowed.length === 1 && allowed[0].user_id
        ? { user_id: allowed[0].user_id }
        : null;
}

async function getInboundMaskingContext(companyId, maskingNumber, providerPhone, queryable = db) {
    const settings = await getActiveSettings(companyId, maskingNumber, queryable);
    if (!settings) return null;
    const provider = await resolveProviderByPhone(companyId, providerPhone, queryable);
    if (!provider) return null;
    return {
        company_id: companyId,
        masking_number: settings.call_masking_number,
        provider_user_id: provider.user_id,
    };
}

async function resolveCustomerForProviderCode(
    companyId,
    { maskingNumber, providerPhone, code },
    queryable = db
) {
    const context = await getInboundMaskingContext(
        companyId,
        maskingNumber,
        providerPhone,
        queryable
    );
    if (!context) return null;
    if (!new RegExp(`^\\d{${CODE_DIGITS}}$`).test(String(code || ''))) return null;

    const numericCode = Number(code);
    const { rows } = await queryFor(queryable).query(
        `SELECT c.id AS contact_id,
                COALESCE(NULLIF(c.phone_e164, ''), NULLIF(c.secondary_phone, '')) AS customer_phone
         FROM contact_call_masking_codes cmc
         JOIN contacts c
           ON c.company_id = cmc.company_id
          AND c.id = cmc.contact_id
         WHERE cmc.company_id = $1
           AND cmc.code = $2
         LIMIT 1`,
        [companyId, numericCode]
    );
    const customerPhone = normalizePhone(rows[0]?.customer_phone);
    if (!rows[0] || !customerPhone) return null;
    return {
        ...context,
        contact_id: rows[0].contact_id,
        customer_phone: customerPhone,
    };
}

async function createSession(companyId, callSid, resolved, queryable = db) {
    requireCompanyId(companyId);
    if (!callSid || !resolved?.contact_id || !resolved?.provider_user_id) {
        throw serviceError(422, 'INVALID_MASKING_SESSION', 'Call masking session is incomplete');
    }
    const query = queryFor(queryable);
    await query.query(
        `INSERT INTO call_masking_sessions
            (company_id, call_sid, contact_id, provider_user_id, masking_number)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, call_sid) DO NOTHING`,
        [
            companyId,
            callSid,
            resolved.contact_id,
            resolved.provider_user_id,
            resolved.masking_number,
        ]
    );
    const { rows } = await query.query(
        `SELECT company_id, call_sid, contact_id, provider_user_id, masking_number
         FROM call_masking_sessions
         WHERE company_id = $1 AND call_sid = $2`,
        [companyId, callSid]
    );
    const session = rows[0];
    if (!session
        || String(session.contact_id) !== String(resolved.contact_id)
        || String(session.provider_user_id) !== String(resolved.provider_user_id)) {
        throw serviceError(409, 'MASKING_SESSION_CONFLICT', 'Call masking session already exists');
    }
    return session;
}

async function getSessionForCallEvent(
    companyId,
    callSid,
    parentCallSid = null,
    queryable = db
) {
    requireCompanyId(companyId);
    if (!callSid && !parentCallSid) return null;
    const { rows } = await queryFor(queryable).query(
        `SELECT s.call_sid, s.contact_id, s.provider_user_id, s.masking_number,
                COALESCE(NULLIF(c.phone_e164, ''), NULLIF(c.secondary_phone, '')) AS customer_phone
         FROM call_masking_sessions s
         JOIN contacts c
           ON c.company_id = s.company_id
          AND c.id = s.contact_id
         WHERE s.company_id = $1
           AND (s.call_sid = $2 OR ($3::text IS NOT NULL AND s.call_sid = $3))
         ORDER BY (s.call_sid = $2) DESC
         LIMIT 1`,
        [companyId, callSid || null, parentCallSid || null]
    );
    if (!rows[0]) return null;
    const customerPhone = normalizePhone(rows[0].customer_phone);
    return customerPhone ? { ...rows[0], customer_phone: customerPhone } : null;
}

module.exports = {
    DEFAULT_MASKING_NUMBER,
    CODE_DIGITS,
    validateSettings,
    formatCode,
    getSettings,
    getActiveSettings,
    saveSettings,
    getMaskedDialForContact,
    getMaskedDialForJob,
    resolveProviderByPhone,
    getInboundMaskingContext,
    resolveCustomerForProviderCode,
    createSession,
    getSessionForCallEvent,
    _getActiveSettings: getActiveSettings,
    _allocateContactCode: allocateContactCode,
};
