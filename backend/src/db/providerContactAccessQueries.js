'use strict';

/**
 * Canonical provider-to-contact visibility for Pulse-style surfaces.
 *
 * A contact is active for a provider when at least one company-owned job is
 * assigned to that CRM user and is not in the canonical inactive-status set.
 * Unknown/custom statuses intentionally remain active.
 */

const db = require('./connection');
const { PULSE_INACTIVE_JOB_STATUSES } = require('../middleware/providerScope');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

function sqlTextArray(values) {
    return `ARRAY[${values.map(value => `'${String(value).replace(/'/g, "''")}'`).join(', ')}]::text[]`;
}

/**
 * Build the shared EXISTS predicate. All expressions are server-owned SQL
 * fragments; callers supply parameter placeholders, never request input.
 */
function buildActiveAssignedContactPredicate({
    jobsAlias,
    contactIdExpression,
    companyPlaceholder,
    userPlaceholder,
}) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(jobsAlias || '')) {
        throw new Error('jobsAlias must be a SQL identifier');
    }
    if (!contactIdExpression || !companyPlaceholder || !userPlaceholder) {
        throw new Error('contact, company, and user SQL expressions are required');
    }
    const inactiveStatuses = sqlTextArray(PULSE_INACTIVE_JOB_STATUSES);
    return `EXISTS (
                SELECT 1 FROM jobs ${jobsAlias}
                WHERE ${jobsAlias}.contact_id = ${contactIdExpression}
                  AND ${jobsAlias}.company_id = ${companyPlaceholder}
                  AND ${jobsAlias}.assigned_provider_user_ids @> ${userPlaceholder}::jsonb
                  AND (${jobsAlias}.blanc_status IS NULL OR ${jobsAlias}.blanc_status <> ALL(${inactiveStatuses}))
            )`;
}

async function providerHasActiveJobForContact(companyId, userId, contactId, { client = null } = {}) {
    if (!companyId || !userId || !contactId) return false;
    const predicate = buildActiveAssignedContactPredicate({
        jobsAlias: 'pj',
        contactIdExpression: 'c.id',
        companyPlaceholder: '$1',
        userPlaceholder: '$2',
    });
    const { rows } = await queryFor(client)(
        `SELECT 1
         FROM contacts c
         WHERE c.company_id = $1
           AND c.id = $3
           AND ${predicate}
         LIMIT 1`,
        [companyId, JSON.stringify([String(userId)]), contactId]
    );
    return rows.length > 0;
}

async function listProvidersWithActiveJobForContact(companyId, contactId, { client = null } = {}) {
    if (!companyId || !contactId) return [];
    const predicate = buildActiveAssignedContactPredicate({
        jobsAlias: 'pj',
        contactIdExpression: 'c.id',
        companyPlaceholder: 'c.company_id',
        userPlaceholder: 'jsonb_build_array(m.user_id::text)',
    });
    const { rows } = await queryFor(client)(
        `SELECT DISTINCT m.user_id
         FROM contacts c
         JOIN company_memberships m
           ON m.company_id = c.company_id
          AND m.status = 'active'
          AND m.role_key = 'provider'
         JOIN crm_users u
           ON u.id = m.user_id
          AND u.status = 'active'
          AND u.onboarding_status = 'active'
          AND COALESCE(u.kind, 'user') = 'user'
         WHERE c.company_id = $1
           AND c.id = $2
           AND ${predicate}
         ORDER BY m.user_id`,
        [companyId, contactId]
    );
    return rows.map(row => String(row.user_id));
}

module.exports = {
    buildActiveAssignedContactPredicate,
    providerHasActiveJobForContact,
    listProvidersWithActiveJobForContact,
};
