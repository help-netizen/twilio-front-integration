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

/** Claim and run one batch of queued agent tasks. Returns count processed. */
async function processBatch() {
    const { rows: claimed } = await db.query(
        `UPDATE tasks SET agent_status = 'running', updated_at = now()
         WHERE id IN (
            SELECT id FROM tasks
            WHERE kind = 'agent' AND agent_status = 'queued' AND company_id IS NOT NULL
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
            await db.query(
                `UPDATE tasks SET agent_status = 'failed', agent_output = $2::jsonb, updated_at = now()
                 WHERE id = $1`,
                [task.id, JSON.stringify({ error: err.message?.slice(0, 500) || String(err) })]
            );
            await emit(task, 'agent_task.failed', { task_id: task.id, agent_type: task.agent_type, error: err.message?.slice(0, 300) });
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
