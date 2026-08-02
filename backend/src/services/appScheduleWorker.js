'use strict';

const db = require('../db/connection');
const appExecutionService = require('./appExecutionService');
const { nextRunAt } = require('./appScheduleCadence');

const BATCH_SIZE = 10;
const INSTALLER_AUTHORITY_CODES = new Set(['ACCESS_DENIED']);
const RUNTIME_SUSPENSION_CODES = new Set([
    'APP_RUNTIME_SUSPENDED',
    'APP_RUNTIME_DAILY_RUN_LIMIT',
    'APP_RUNTIME_DAILY_WALL_LIMIT',
    'APP_RUNTIME_DAILY_CALL_LIMIT',
]);

function safeFailureCode(error) {
    const value = typeof error?.code === 'string' ? error.code : 'APP_SCHEDULE_RUN_FAILED';
    return /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : 'APP_SCHEDULE_RUN_FAILED';
}

function createAppScheduleWorker({
    database = db,
    execution = appExecutionService,
} = {}) {
    async function withTransaction(work) {
        const client = await database.getClient();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async function claimDue(tickNow) {
        return withTransaction(async client => {
            const { rows: due } = await client.query(
                `SELECT schedule.installation_id, schedule.company_id,
                        schedule.cadence, schedule.next_run_at,
                        installation.installed_by AS actor_id,
                        company.timezone, app.name AS app_name
                 FROM app_installation_schedules schedule
                 JOIN marketplace_installations installation
                   ON installation.company_id = schedule.company_id
                  AND installation.id = schedule.installation_id
                  AND installation.status = 'connected'
                 JOIN companies company
                   ON company.id = schedule.company_id
                  AND company.status = 'active'
                 JOIN marketplace_apps app
                   ON app.id = installation.app_id
                  AND app.status = 'published'
                 WHERE schedule.enabled = true
                   AND schedule.next_run_at <= $1
                 ORDER BY schedule.next_run_at, schedule.installation_id
                 LIMIT $2
                 FOR UPDATE OF schedule SKIP LOCKED`,
                [tickNow, BATCH_SIZE]
            );
            const claimed = [];
            for (const row of due) {
                const next = nextRunAt(row.cadence, row.timezone, tickNow);
                const { rows } = await client.query(
                    `UPDATE app_installation_schedules schedule
                     SET next_run_at = $4,
                         last_run_at = $3,
                         last_status = 'running',
                         updated_at = NOW()
                     WHERE schedule.company_id = $1
                       AND schedule.installation_id = $2
                       AND schedule.enabled = true
                     RETURNING schedule.next_run_at, schedule.last_run_at`,
                    [row.company_id, row.installation_id, tickNow, next]
                );
                if (rows[0]) {
                    claimed.push({
                        ...row,
                        claimed_at: rows[0].last_run_at,
                        claimed_next_run_at: rows[0].next_run_at,
                    });
                }
            }
            return claimed;
        });
    }

    async function recordStatus(claim, status, { resetFailures = false } = {}) {
        await database.query(
            `UPDATE app_installation_schedules schedule
             SET last_status = $5,
                 failure_count = CASE WHEN $6 THEN 0 ELSE failure_count END,
                 updated_at = NOW()
             WHERE schedule.company_id = $1
               AND schedule.installation_id = $2
               AND schedule.last_status = 'running'
               AND schedule.last_run_at = $3
               AND schedule.next_run_at = $4`,
            [
                claim.company_id,
                claim.installation_id,
                claim.claimed_at,
                claim.claimed_next_run_at,
                status,
                resetFailures,
            ]
        );
    }

    async function suspend(claim, reason) {
        await database.query(
            `UPDATE app_installation_schedules schedule
             SET enabled = false,
                 next_run_at = NULL,
                 last_status = 'suspended',
                 suspended_reason = $5,
                 updated_at = NOW()
             WHERE schedule.company_id = $1
               AND schedule.installation_id = $2
               AND schedule.last_status = 'running'
               AND schedule.last_run_at = $3
               AND schedule.next_run_at = $4`,
            [
                claim.company_id,
                claim.installation_id,
                claim.claimed_at,
                claim.claimed_next_run_at,
                reason,
            ]
        );
    }

    async function recordFailure(claim, error) {
        return withTransaction(async client => {
            const failureCode = safeFailureCode(error);
            const { rows } = await client.query(
                `UPDATE app_installation_schedules schedule
                 SET failure_count = schedule.failure_count + 1,
                     enabled = schedule.failure_count + 1 < 3,
                     next_run_at = CASE
                         WHEN schedule.failure_count + 1 >= 3 THEN NULL
                         ELSE schedule.next_run_at
                     END,
                     last_status = CASE
                         WHEN schedule.failure_count + 1 >= 3 THEN 'suspended'
                         ELSE 'failed'
                     END,
                     suspended_reason = CASE
                         WHEN schedule.failure_count + 1 >= 3
                             THEN 'THREE_CONSECUTIVE_FAILURES'
                         ELSE NULL
                     END,
                     updated_at = NOW()
                 WHERE schedule.company_id = $1
                   AND schedule.installation_id = $2
                   AND schedule.enabled = true
                   AND schedule.last_status = 'running'
                   AND schedule.last_run_at = $3
                   AND schedule.next_run_at = $4
                 RETURNING schedule.failure_count, schedule.enabled`,
                [
                    claim.company_id,
                    claim.installation_id,
                    claim.claimed_at,
                    claim.claimed_next_run_at,
                ]
            );
            if (Number(rows[0]?.failure_count) === 3 && rows[0]?.enabled === false) {
                await client.query(
                    `INSERT INTO tasks
                        (company_id, kind, subject_type, title, description,
                         status, priority, due_at, owner_user_id, created_by)
                     VALUES ($1, 'user', 'crm', $2, $3,
                             'open', 'p1', NOW(), $4, 'system')`,
                    [
                        claim.company_id,
                        `App schedule disabled: ${claim.app_name}`,
                        `The app schedule was disabled after three consecutive failures. Latest error: ${failureCode}. Review the app run history and re-enable the schedule after resolving the problem.`,
                        claim.actor_id || null,
                    ]
                );
            }
            return rows[0] || null;
        });
    }

    async function executeClaim(claim) {
        if (!claim.actor_id) {
            await suspend(claim, 'INSTALLER_AUTHORITY_LOST');
            return 'suspended';
        }
        try {
            const run = await execution.run({
                companyId: claim.company_id,
                installationId: String(claim.installation_id),
                trigger: 'schedule',
                actorId: claim.actor_id,
            });
            if (run.status === 'running') {
                await recordStatus(claim, 'skipped', { resetFailures: true });
                return 'skipped';
            }
            await recordStatus(claim, 'succeeded', { resetFailures: true });
            return 'succeeded';
        } catch (error) {
            if (INSTALLER_AUTHORITY_CODES.has(error?.code)) {
                await suspend(claim, 'INSTALLER_AUTHORITY_LOST');
                return 'suspended';
            }
            if (RUNTIME_SUSPENSION_CODES.has(error?.code)) {
                await suspend(claim, safeFailureCode(error));
                return 'suspended';
            }
            await recordFailure(claim, error);
            return 'failed';
        }
    }

    async function tick(tickNow = new Date()) {
        const claims = await claimDue(tickNow);
        const outcomes = [];
        for (const claim of claims) {
            outcomes.push(await executeClaim(claim));
        }
        return { claimed: claims.length, outcomes };
    }

    return { tick, claimDue, executeClaim, recordFailure };
}

const singleton = createAppScheduleWorker();

function registerScheduler(registry) {
    registry.register('app-schedules', tickNow => singleton.tick(tickNow));
}

module.exports = {
    BATCH_SIZE,
    createAppScheduleWorker,
    registerScheduler,
    tick: singleton.tick,
};
