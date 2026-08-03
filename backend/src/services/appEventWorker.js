'use strict';

const db = require('../db/connection');
const appExecutionService = require('./appExecutionService');

const BATCH_SIZE = 10;
const SINGLE_FLIGHT_DELAY_MS = 30 * 1000;
const RETRY_DELAYS_MS = Object.freeze([60 * 1000, 5 * 60 * 1000]);

function safeLastError(error) {
    const value = String(error?.message || error || 'Application event run failed.')
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (value || 'Application event run failed.').slice(0, 500);
}

function createAppEventWorker({
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
            // tenant-safety-allow T-global-maintenance: the scheduler discovers
            // all due companies, but the paired join and every mutation retain
            // both company_id and installation_id.
            const { rows: due } = await client.query(
                `SELECT delivery.id, delivery.company_id,
                        delivery.installation_id, delivery.event_type,
                        delivery.payload, delivery.attempts,
                        delivery.coalesced_count,
                        installation.installed_by AS actor_id
                 FROM app_event_deliveries delivery
                 JOIN marketplace_installations installation
                   ON installation.company_id = delivery.company_id
                  AND installation.id = delivery.installation_id
                  AND installation.status = 'connected'
                 JOIN companies company
                   ON company.id = delivery.company_id
                  AND company.status = 'active'
                 WHERE delivery.status = 'pending'
                   AND delivery.next_attempt_at <= $1
                 ORDER BY delivery.next_attempt_at, delivery.id
                 LIMIT $2
                 FOR UPDATE OF delivery SKIP LOCKED`,
                [tickNow, BATCH_SIZE]
            );
            const claims = [];
            for (const row of due) {
                const { rows } = await client.query(
                    `UPDATE app_event_deliveries delivery
                     SET status = 'running',
                         updated_at = NOW()
                     WHERE delivery.id = $1
                       AND delivery.company_id = $2
                       AND delivery.installation_id = $3
                       AND delivery.status = 'pending'
                       AND delivery.next_attempt_at <= $4
                     RETURNING delivery.updated_at AS claimed_at`,
                    [row.id, row.company_id, row.installation_id, tickNow]
                );
                if (rows[0]) claims.push({ ...row, claimed_at: rows[0].claimed_at });
            }
            return claims;
        });
    }

    async function markDelivered(claim) {
        await database.query(
            `UPDATE app_event_deliveries delivery
             SET status = 'delivered',
                 last_error = NULL,
                 updated_at = NOW()
             WHERE delivery.id = $1
               AND delivery.company_id = $2
               AND delivery.installation_id = $3
               AND delivery.status = 'running'`,
            [claim.id, claim.company_id, claim.installation_id]
        );
    }

    async function deferSingleFlight(claim, tickNow) {
        const nextAttemptAt = new Date(tickNow.getTime() + SINGLE_FLIGHT_DELAY_MS);
        await database.query(
            `UPDATE app_event_deliveries delivery
             SET status = 'pending',
                 next_attempt_at = $4,
                 last_error = NULL,
                 updated_at = NOW()
             WHERE delivery.id = $1
               AND delivery.company_id = $2
               AND delivery.installation_id = $3
               AND delivery.status = 'running'`,
            [claim.id, claim.company_id, claim.installation_id, nextAttemptAt]
        );
    }

    async function recordFailure(claim, error, tickNow) {
        const nextAttempts = Number(claim.attempts) + 1;
        const failed = nextAttempts >= 3;
        const retryDelay = RETRY_DELAYS_MS[nextAttempts - 1] || 0;
        const nextAttemptAt = failed
            ? tickNow
            : new Date(tickNow.getTime() + retryDelay);
        const { rows } = await database.query(
            `UPDATE app_event_deliveries delivery
             SET attempts = delivery.attempts + 1,
                 status = CASE
                     WHEN delivery.attempts + 1 >= 3 THEN 'failed'
                     ELSE 'pending'
                 END,
                 next_attempt_at = $4,
                 last_error = $5,
                 updated_at = NOW()
             WHERE delivery.id = $1
               AND delivery.company_id = $2
               AND delivery.installation_id = $3
               AND delivery.status = 'running'
             RETURNING delivery.status, delivery.attempts,
                       delivery.next_attempt_at, delivery.last_error`,
            [
                claim.id,
                claim.company_id,
                claim.installation_id,
                nextAttemptAt,
                safeLastError(error),
            ]
        );
        return rows[0] || null;
    }

    async function executeClaim(claim, tickNow) {
        try {
            const run = await execution.run({
                companyId: claim.company_id,
                installationId: String(claim.installation_id),
                trigger: 'event',
                actorId: claim.actor_id,
                event: {
                    type: claim.event_type,
                    payload: claim.payload,
                },
            });
            if (run.status === 'running') {
                await deferSingleFlight(claim, tickNow);
                return 'deferred';
            }
            await markDelivered(claim);
            return 'delivered';
        } catch (error) {
            const failure = await recordFailure(claim, error, tickNow);
            return failure?.status || 'failed';
        }
    }

    async function tick(tickNow = new Date()) {
        const claims = await claimDue(tickNow);
        const outcomes = [];
        for (const claim of claims) outcomes.push(await executeClaim(claim, tickNow));
        return { claimed: claims.length, outcomes };
    }

    return {
        tick,
        claimDue,
        executeClaim,
        recordFailure,
    };
}

const singleton = createAppEventWorker();

function registerScheduler(registry) {
    registry.register('app-events', tickNow => singleton.tick(tickNow));
}

module.exports = {
    BATCH_SIZE,
    RETRY_DELAYS_MS,
    SINGLE_FLIGHT_DELAY_MS,
    createAppEventWorker,
    registerScheduler,
    tick: singleton.tick,
};
