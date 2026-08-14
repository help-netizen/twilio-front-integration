'use strict';

const db = require('./connection');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

async function getActiveReviewer(companyId, userId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT
             u.id,
             NULLIF(split_part(BTRIM(COALESCE(u.full_name, '')), ' ', 1), '') AS first_name
         FROM crm_users u
         JOIN company_memberships membership
           ON membership.user_id = u.id
          AND membership.company_id = $1
          AND membership.status = 'active'
         JOIN companies company
           ON company.id = membership.company_id
          AND company.status = 'active'
         WHERE u.id = $2
           AND u.status = 'active'
         LIMIT 1`,
        [companyId, userId]
    );
    return rows[0] || null;
}

async function getPublishedApp(appKey, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT app_key, name
         FROM marketplace_apps
         WHERE app_key = $1
           AND status = 'published'
         LIMIT 1`,
        [appKey]
    );
    return rows[0] || null;
}

async function upsertReview(input, client = null) {
    const { rows } = await queryFor(client)(
        `INSERT INTO app_ratings (
             company_id,
             app_key,
             user_id,
             stars,
             comment,
             status,
             moderation_reason,
             moderation_source,
             moderated_by
         )
         SELECT
             $1,
             app.app_key,
             reviewer.id,
             $4,
             $5,
             $6,
             $7,
             $8,
             NULL
         FROM marketplace_apps app
         JOIN crm_users reviewer ON reviewer.id = $3
                                AND reviewer.status = 'active'
         JOIN company_memberships membership
           ON membership.user_id = reviewer.id
          AND membership.company_id = $1
          AND membership.status = 'active'
         JOIN companies company ON company.id = membership.company_id
                               AND company.status = 'active'
         WHERE app.app_key = $2
           AND app.status = 'published'
         ON CONFLICT (app_key, user_id) DO UPDATE SET
             company_id = EXCLUDED.company_id,
             stars = EXCLUDED.stars,
             comment = EXCLUDED.comment,
             status = EXCLUDED.status,
             moderation_reason = EXCLUDED.moderation_reason,
             moderation_source = EXCLUDED.moderation_source,
             moderated_by = NULL,
             updated_at = NOW()
         RETURNING
             id,
             app_key,
             stars,
             comment,
             status,
             moderation_reason,
             moderation_source,
             created_at,
             updated_at`,
        [
            input.companyId,
            input.appKey,
            input.userId,
            input.stars,
            input.comment,
            input.status,
            input.moderationReason,
            input.moderationSource,
        ]
    );
    return rows[0] || null;
}

async function deleteReview(companyId, userId, appKey, client = null) {
    const result = await queryFor(client)(
        `DELETE FROM app_ratings
         WHERE company_id = $1
           AND user_id = $2
           AND app_key = $3`,
        [companyId, userId, appKey]
    );
    return result.rowCount > 0;
}

async function listPublicReviews(appKey, viewerUserId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT
             rating.id,
             rating.app_key,
             rating.stars,
             rating.comment,
             rating.status,
             COALESCE(
                 NULLIF(split_part(BTRIM(COALESCE(reviewer.full_name, '')), ' ', 1), ''),
                 'Albusto user'
             ) AS reviewer_first_name,
             (rating.user_id = $2) AS is_mine,
             rating.created_at,
             rating.updated_at
         FROM app_ratings rating
         JOIN crm_users reviewer ON reviewer.id = rating.user_id
         WHERE rating.app_key = $1
           AND (rating.status = 'posted' OR rating.user_id = $2)
         ORDER BY rating.updated_at DESC, rating.id DESC`,
        [appKey, viewerUserId]
    );
    return rows;
}

async function getAggregate(appKey, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT
             ROUND(AVG(stars)::NUMERIC, 2) AS avg_rating,
             COUNT(*)::INTEGER AS rating_count
         FROM app_ratings
         WHERE app_key = $1
           AND status = 'posted'`,
        [appKey]
    );
    return rows[0] || { avg_rating: null, rating_count: 0 };
}

const MODERATION_SELECT = `
    SELECT
        rating.id,
        rating.app_key,
        app.name AS app_name,
        rating.stars,
        rating.comment,
        rating.status,
        rating.moderation_reason,
        rating.moderation_source,
        COALESCE(
            NULLIF(split_part(BTRIM(COALESCE(reviewer.full_name, '')), ' ', 1), ''),
            'Albusto user'
        ) AS reviewer_first_name,
        company.id AS company_id,
        company.name AS company_name,
        company.timezone AS company_timezone,
        rating.moderated_by,
        NULLIF(split_part(BTRIM(COALESCE(moderator.full_name, '')), ' ', 1), '')
            AS moderator_first_name,
        rating.created_at,
        rating.updated_at
    FROM app_ratings rating
    LEFT JOIN marketplace_apps app ON app.app_key = rating.app_key
    JOIN crm_users reviewer ON reviewer.id = rating.user_id
    JOIN companies company ON company.id = rating.company_id
    LEFT JOIN crm_users moderator ON moderator.id = rating.moderated_by`;

async function listReviewsForModeration({ status, page, limit }, client = null) {
    const query = queryFor(client);
    const offset = (page - 1) * limit;
    const [listResult, countResult] = await Promise.all([
        query(
            `${MODERATION_SELECT}
             WHERE rating.status = $1
             ORDER BY rating.created_at ASC, rating.id ASC
             LIMIT $2 OFFSET $3`,
            [status, limit, offset]
        ),
        query(
            `SELECT COUNT(*)::INTEGER AS total
             FROM app_ratings
             WHERE status = $1`,
            [status]
        ),
    ]);
    return {
        rows: listResult.rows,
        total: Number(countResult.rows[0]?.total || 0),
    };
}

async function getActiveSuperAdmin(userId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT id
         FROM crm_users
         WHERE id = $1
           AND status = 'active'
           AND platform_role = 'super_admin'
         LIMIT 1`,
        [userId]
    );
    return rows[0] || null;
}

async function moderateReview(reviewId, input, client = null) {
    const query = queryFor(client);
    const result = await query(
        `UPDATE app_ratings
         SET status = $2,
             moderation_reason = $3,
             moderation_source = 'manual',
             moderated_by = $4,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [reviewId, input.status, input.reason, input.moderatorUserId]
    );
    if (result.rowCount === 0) return null;

    const { rows } = await query(
        `${MODERATION_SELECT}
         WHERE rating.id = $1
         LIMIT 1`,
        [reviewId]
    );
    return rows[0] || null;
}

module.exports = {
    getActiveReviewer,
    getPublishedApp,
    upsertReview,
    deleteReview,
    listPublicReviews,
    getAggregate,
    listReviewsForModeration,
    getActiveSuperAdmin,
    moderateReview,
};
