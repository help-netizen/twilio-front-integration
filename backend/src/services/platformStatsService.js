/** Platform-level growth statistics for the super-admin dashboard. */

const db = require('../db/connection');

async function getStats() {
    // Platform growth has no tenant timezone. UTC gives one stable boundary for
    // every company and matches the API's YYYY-MM-DD growth labels.
    const { rows } = await db.query(
        `WITH bounds AS (
             SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date AS today
         ),
         company_summary AS (
             SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (
                        WHERE c.created_at >= (b.today::timestamp AT TIME ZONE 'UTC')
                          AND c.created_at < ((b.today + 1)::timestamp AT TIME ZONE 'UTC')
                    )::int AS today,
                    COUNT(*) FILTER (
                        WHERE c.created_at >= ((b.today - 6)::timestamp AT TIME ZONE 'UTC')
                          AND c.created_at < ((b.today + 1)::timestamp AT TIME ZONE 'UTC')
                    )::int AS last7,
                    COUNT(*) FILTER (
                        WHERE c.created_at >= ((b.today - 29)::timestamp AT TIME ZONE 'UTC')
                          AND c.created_at < ((b.today + 1)::timestamp AT TIME ZONE 'UTC')
                    )::int AS last30
             FROM companies c
             CROSS JOIN bounds b
             GROUP BY b.today
         ),
         user_summary AS (
             SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (
                        WHERE u.created_at >= (b.today::timestamp AT TIME ZONE 'UTC')
                          AND u.created_at < ((b.today + 1)::timestamp AT TIME ZONE 'UTC')
                    )::int AS today,
                    COUNT(*) FILTER (
                        WHERE u.created_at >= ((b.today - 6)::timestamp AT TIME ZONE 'UTC')
                          AND u.created_at < ((b.today + 1)::timestamp AT TIME ZONE 'UTC')
                    )::int AS last7,
                    COUNT(*) FILTER (
                        WHERE u.created_at >= ((b.today - 29)::timestamp AT TIME ZONE 'UTC')
                          AND u.created_at < ((b.today + 1)::timestamp AT TIME ZONE 'UTC')
                    )::int AS last30
             FROM crm_users u
             CROSS JOIN bounds b
             GROUP BY b.today
         ),
         days AS (
             SELECT generate_series(b.today - 29, b.today, interval '1 day')::date AS day
             FROM bounds b
         ),
         company_daily AS (
             SELECT (c.created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS count
             FROM companies c
             CROSS JOIN bounds b
             WHERE c.created_at >= ((b.today - 29)::timestamp AT TIME ZONE 'UTC')
               AND c.created_at < ((b.today + 1)::timestamp AT TIME ZONE 'UTC')
             GROUP BY (c.created_at AT TIME ZONE 'UTC')::date
         ),
         user_daily AS (
             SELECT (u.created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS count
             FROM crm_users u
             CROSS JOIN bounds b
             WHERE u.created_at >= ((b.today - 29)::timestamp AT TIME ZONE 'UTC')
               AND u.created_at < ((b.today + 1)::timestamp AT TIME ZONE 'UTC')
             GROUP BY (u.created_at AT TIME ZONE 'UTC')::date
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
                COALESCE(cd.count, 0)::int AS companies,
                COALESCE(ud.count, 0)::int AS users,
                cs.total AS companies_total,
                cs.today AS companies_today,
                cs.last7 AS companies_last7,
                cs.last30 AS companies_last30,
                us.total AS users_total,
                us.today AS users_today,
                us.last7 AS users_last7,
                us.last30 AS users_last30
         FROM days d
         CROSS JOIN company_summary cs
         CROSS JOIN user_summary us
         LEFT JOIN company_daily cd ON cd.day = d.day
         LEFT JOIN user_daily ud ON ud.day = d.day
         ORDER BY d.day`
    );

    const summary = rows[0];
    return {
        companies: {
            total: summary.companies_total,
            today: summary.companies_today,
            last7: summary.companies_last7,
            last30: summary.companies_last30,
        },
        users: {
            total: summary.users_total,
            today: summary.users_today,
            last7: summary.users_last7,
            last30: summary.users_last30,
        },
        growth: rows.map(row => ({
            date: row.date,
            companies: row.companies,
            users: row.users,
        })),
    };
}

module.exports = { getStats };
