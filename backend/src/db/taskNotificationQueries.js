'use strict';

const db = require('./connection');
const { requireCompanyId, queryFor } = require('./crmUtils');

const DEFAULT_TIMEZONE = 'America/New_York';

async function listActiveCompanyTimezones(client = null) {
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT id AS company_id,
                COALESCE(NULLIF(timezone, ''), $1) AS timezone
         FROM companies
         WHERE status = 'active'
         ORDER BY id`,
        [DEFAULT_TIMEZONE]
    );
    return rows;
}

async function listTaskBoundaryCandidates(companyId, timezone, tickNow, limit = 250, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 250));
    const { rows } = await query(
        `SELECT t.id, t.company_id, t.owner_user_id, t.author_user_id,
                CASE WHEN t.due_at <= $3::timestamptz THEN 'overdue' ELSE 'due' END AS boundary,
                to_char(t.due_at AT TIME ZONE $2, 'YYYY-MM-DD') AS local_due_date
         FROM tasks t
         WHERE t.company_id = $1
           AND t.status = 'open'
           AND t.due_at IS NOT NULL
           AND (
                t.due_at <= $3::timestamptz
                OR (t.due_at AT TIME ZONE $2)::date =
                   ($3::timestamptz AT TIME ZONE $2)::date
           )
           AND NOT EXISTS (
                SELECT 1
                FROM domain_events de
                WHERE de.company_id = t.company_id
                  AND de.idempotency_key =
                      'task.' || CASE WHEN t.due_at <= $3::timestamptz THEN 'overdue' ELSE 'due' END
                      || ':' || t.company_id::text
                      || ':' || t.id::text
                      || ':' || $2
                      || ':' || to_char(t.due_at AT TIME ZONE $2, 'YYYY-MM-DD')
           )
         ORDER BY t.due_at, t.id
         LIMIT $4`,
        [companyId, timezone || DEFAULT_TIMEZONE, tickNow, safeLimit]
    );
    return rows;
}

module.exports = {
    DEFAULT_TIMEZONE,
    listActiveCompanyTimezones,
    listTaskBoundaryCandidates,
};
