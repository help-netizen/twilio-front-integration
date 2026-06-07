'use strict';

const db = require('../db/connection');

async function getMetadata(companyId) {
    const [stages, categories, owners, taskStatuses] = await Promise.all([
        db.query(
            `SELECT stage_key, name, display_order, default_probability, is_open, is_won, is_lost
             FROM crm_pipeline_stages
             WHERE company_id = $1
             ORDER BY display_order ASC, name ASC`,
            [companyId]
        ),
        db.query(
            `SELECT category_key, name, display_order
             FROM crm_forecast_categories
             WHERE company_id = $1
             ORDER BY display_order ASC, name ASC`,
            [companyId]
        ),
        db.query(
            `SELECT id, email, full_name
         FROM crm_users
         WHERE company_id = $1 OR id IN (
                SELECT user_id FROM company_memberships WHERE company_id = $1 AND status = 'active'
             )
             ORDER BY full_name ASC NULLS LAST, email ASC`,
            [companyId]
        ),
        db.query(
            `SELECT status_key, name, display_order, is_closed
             FROM crm_task_statuses
             WHERE company_id = $1
             ORDER BY display_order ASC, name ASC`,
            [companyId]
        ),
    ]);
    const transitionRules = await db.query(
        `SELECT from_stage, to_stage, allowed
         FROM crm_stage_transition_rules
         WHERE company_id = $1
         ORDER BY from_stage ASC, to_stage ASC`,
        [companyId]
    );
    return {
        pipeline_stages: stages.rows,
        forecast_categories: categories.rows,
        owners: owners.rows,
        activity_types: ['email', 'call', 'meeting', 'note', 'task', 'stage_change'],
        task_statuses: taskStatuses.rows.length > 0 ? taskStatuses.rows : [
            { status_key: 'open', name: 'Open', display_order: 10, is_closed: false },
            { status_key: 'done', name: 'Done', display_order: 20, is_closed: true },
        ],
        stage_transition_rules: transitionRules.rows,
    };
}

module.exports = {
    getMetadata,
};
