/**
 * agentWorker.js — AUTO-001. Background executor for kind=agent tasks.
 *
 * Atomic claim (UPDATE … FOR UPDATE SKIP LOCKED) prevents double-execution
 * across processes. Each task: running → handler → succeeded/failed, emits an
 * agent_task.* event so rules (and billing) can react. Errors never crash the
 * loop.
 */

const db = require('../db/connection');
const agentHandlers = require('./agentHandlers');

const BATCH = 5;

// YELP-LEAD-AUTORESPONDER-002: retry backoff bounds (seconds). Opt-in per task via
// max_attempts>1; default max_attempts=1 never reaches the retry branch.
const RETRY_BASE_SEC = parseInt(process.env.AGENT_TASK_RETRY_BASE_SEC || '60', 10);
const RETRY_CAP_SEC = parseInt(process.env.AGENT_TASK_RETRY_CAP_SEC || '300', 10);

/**
 * Backoff seconds before the next attempt, computed in JS (the DB applies the
 * interval → clock-skew-safe). `attemptCount` is the pre-increment value on the
 * claimed row: min(BASE·2^attemptCount, CAP) with ±20% jitter.
 */
function backoffSeconds(attemptCount) {
    const base = Math.min(RETRY_BASE_SEC * 2 ** (attemptCount || 0), RETRY_CAP_SEC);
    const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20%
    return Math.max(1, Math.round(base + jitter));
}

/** Claim and run one batch of queued agent tasks. Returns count processed. */
async function processBatch() {
    const { rows: claimed } = await db.query(
        `UPDATE tasks SET agent_status = 'running', updated_at = now()
         WHERE id IN (
            SELECT id FROM tasks
            WHERE kind = 'agent' AND agent_status = 'queued' AND company_id IS NOT NULL
              AND (next_attempt_at IS NULL OR next_attempt_at <= now())
            ORDER BY created_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [BATCH]
    );

    for (const task of claimed) {
        const t0 = Date.now();
        try {
            const output = await agentHandlers.run(task);
            await db.query(
                `UPDATE tasks SET agent_status = 'succeeded', agent_output = $2::jsonb,
                        status = 'done', completed_at = now(), updated_at = now()
                 WHERE id = $1`,
                [task.id, JSON.stringify(output ?? {})]
            );
            await emit(task, 'agent_task.succeeded', { task_id: task.id, agent_type: task.agent_type, duration_ms: Date.now() - t0 });
        } catch (err) {
            // ADDITIVE + OPT-IN retry. Terminal ⇔ attempt_count+1 >= max_attempts.
            // Default max_attempts=1 → 0+1 >= 1 → terminal on the first failure +
            // one agent_task.failed emit = byte-for-byte the pre-retry behaviour, so
            // job_geocode / route_calc / zb_job_sync / mcp_tool are unaffected. The
            // whole branch is wrapped so a retry-write hiccup never breaks the loop.
            try {
                const errPayload = JSON.stringify({ error: err.message?.slice(0, 500) || String(err) });
                const attemptCount = task.attempt_count ?? 0;
                const maxAttempts = task.max_attempts ?? 1;
                const next = attemptCount + 1;
                if (next >= maxAttempts) {
                    // Terminal: leave status='open' (stuck signal) but stop claiming it.
                    await db.query(
                        `UPDATE tasks SET agent_status = 'failed', attempt_count = $3,
                                next_attempt_at = NULL, agent_output = $2::jsonb, updated_at = now()
                         WHERE id = $1`,
                        [task.id, errPayload, next]
                    );
                    await emit(task, 'agent_task.failed', { task_id: task.id, agent_type: task.agent_type, error: err.message?.slice(0, 300) });
                } else {
                    // Re-queue with backoff. Emit NOTHING (no billing/rule double-count).
                    const backoff = backoffSeconds(attemptCount);
                    await db.query(
                        `UPDATE tasks SET agent_status = 'queued', attempt_count = $3,
                                next_attempt_at = now() + make_interval(secs => $4),
                                agent_output = $2::jsonb, updated_at = now()
                         WHERE id = $1`,
                        [task.id, errPayload, next, backoff]
                    );
                }
            } catch (writeErr) {
                console.error('[agentWorker] failure-branch write error:', writeErr.message);
            }
        }
    }
    return claimed.length;
}

async function emit(task, eventType, payload) {
    try {
        const eventBus = require('./eventBus');
        await eventBus.emit(task.company_id, eventType, payload,
            { actorType: 'system', aggregateType: 'agent_task', aggregateId: task.id });
    } catch (e) {
        console.error('[agentWorker] emit failed:', e.message);
    }
}

let timer = null;

function startWorker() {
    if (process.env.FEATURE_AGENT_WORKER === 'false') {
        console.log('🤖 Agent worker disabled (FEATURE_AGENT_WORKER=false)');
        return;
    }
    const interval = parseInt(process.env.AGENT_WORKER_INTERVAL_MS || '5000', 10);
    timer = setInterval(() => {
        processBatch().catch(err => console.error('[agentWorker] batch error:', err.message));
    }, interval);
    console.log(`🤖 Agent worker started (${interval}ms tick)`);
}

function stopWorker() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { startWorker, stopWorker, processBatch };
