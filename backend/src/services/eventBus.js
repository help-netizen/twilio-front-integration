/**
 * eventBus.js — platform event bus (ADR-001).
 *
 * The single place domain producers call to publish a business event:
 *   - writes domain_events (append-only source of truth) SYNCHRONOUSLY
 *   - dispatches to registered subscribers ASYNCHRONOUSLY (at-least-once;
 *     a failing subscriber never breaks the emit), logging each outcome to
 *     event_dispatch_log for observability.
 *
 * Subscribers are in-process for now (setImmediate). The contract is queue-
 * ready: swapping the dispatcher for Redis/BullMQ later needs no producer
 * changes.
 */

const db = require('../db/connection');

/** @type {Array<{ name: string, match: (eventType: string) => boolean, handle: Function }>} */
const subscribers = [];

/**
 * Register a subscriber.
 * @param {string} name - stable id (shown in dispatch log)
 * @param {string|string[]|RegExp|((t:string)=>boolean)} pattern - event filter
 * @param {(event: object) => Promise<void>} handle
 */
function subscribe(name, pattern, handle) {
    let match;
    if (pattern === '*' || pattern == null) match = () => true;
    else if (typeof pattern === 'function') match = pattern;
    else if (pattern instanceof RegExp) match = (t) => pattern.test(t);
    else if (Array.isArray(pattern)) match = (t) => pattern.includes(t);
    else match = (t) => t === pattern;
    subscribers.push({ name, match, handle });
}

/**
 * Publish an event. Returns the persisted event row (with id) or null.
 *
 * @param {string} companyId
 * @param {string} eventType - canonical type, e.g. 'job.status_changed'
 * @param {object} payload
 * @param {object} [opts] - { actorType, actorId, aggregateType, aggregateId, idempotencyKey, dispatch }
 */
async function emit(companyId, eventType, payload = {}, opts = {}) {
    if (!companyId || !eventType) return null;
    const {
        actorType = 'system', actorId = null,
        aggregateType = payload.aggregate_type || eventType.split('.')[0] || 'platform',
        aggregateId = payload.aggregate_id || payload.id || '0',
        idempotencyKey = null,
        dispatch = true,
    } = opts;

    let event = null;
    try {
        const { rows } = await db.query(
            `INSERT INTO domain_events
                (company_id, aggregate_type, aggregate_id, event_type, event_data, actor_type, actor_id, idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ${idempotencyKey ? 'ON CONFLICT DO NOTHING' : ''}
             RETURNING *`,
            [companyId, aggregateType, String(aggregateId), eventType,
             JSON.stringify(payload), actorType, actorId, idempotencyKey]
        );
        event = rows[0] || null;
    } catch (err) {
        console.error(`[eventBus] persist failed for ${eventType}:`, err.message);
        return null;
    }

    if (event && dispatch) {
        const enriched = {
            id: event.id, company_id: companyId, event_type: eventType,
            payload, actor_type: actorType, actor_id: actorId,
            aggregate_type: aggregateType, aggregate_id: String(aggregateId),
            created_at: event.created_at,
        };
        // Async, never block / never throw into the producer.
        setImmediate(() => dispatchToSubscribers(enriched));
    }
    return event;
}

async function dispatchToSubscribers(event) {
    for (const sub of subscribers) {
        let matched = false;
        try { matched = sub.match(event.event_type); } catch { matched = false; }
        if (!matched) continue;

        const t0 = Date.now();
        let status = 'ok';
        let errorText = null;
        try {
            await sub.handle(event);
        } catch (err) {
            status = 'error';
            errorText = err.message?.slice(0, 500) || String(err);
            console.error(`[eventBus] subscriber "${sub.name}" failed on ${event.event_type}:`, errorText);
        }
        db.query(
            `INSERT INTO event_dispatch_log (event_id, company_id, event_type, subscriber, status, error_text, duration_ms)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [event.id, event.company_id, event.event_type, sub.name, status, errorText, Date.now() - t0]
        ).catch(() => {});
    }
}

/** Re-dispatch a stored event by id (manual retry / backfill). */
async function redispatch(eventId) {
    const { rows } = await db.query('SELECT * FROM domain_events WHERE id = $1', [eventId]);
    if (!rows[0]) return false;
    const e = rows[0];
    await dispatchToSubscribers({
        id: e.id, company_id: e.company_id, event_type: e.event_type,
        payload: e.event_data, actor_type: e.actor_type, actor_id: e.actor_id,
        aggregate_type: e.aggregate_type, aggregate_id: e.aggregate_id, created_at: e.created_at,
    });
    return true;
}

module.exports = { emit, subscribe, redispatch, _subscribers: subscribers };
