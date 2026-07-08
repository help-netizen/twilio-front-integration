'use strict';

/**
 * taskActions/registry.js — OUTBOUND-PARTS-CALL-001, OPC1-T14 (spec Part A / arch §3).
 *
 * The CLOSED backend action registry — the single source of truth for "what a
 * typed task button does." There is NO arbitrary/user code: `POST
 * /api/tasks/:id/actions/:type` will only ever run a handler that lives in this
 * map, and an unknown `:type` is rejected (400) by the route BEFORE any handler
 * is reached (`isKnownAction` gate).
 *
 * Two actions in v1 (FR-TA1…4):
 *   - `robot_call`  — SERVER-side: launches the outbound-call lifecycle via
 *                     `partsCallService.startRobotCall(jobId, companyId, taskId)`.
 *                     Returns the lifecycle result (ok / reason / already-in-flight)
 *                     so the UI can reflect `state`. It is NOT a softphone directive.
 *   - `manual_call` — PURE CLIENT affordance: the server does NOT dial. It returns
 *                     a client directive `{ client: { action:'open_softphone',
 *                     phone, contactName } }` so the frontend can `openDialer(...)`
 *                     (desktop softphone / mobile tel:). No mutation.
 *
 * Everything is company-scoped: the route resolves companyId from
 * req.companyFilter.company_id and passes it (+ the already-loaded, company-scoped
 * task & job) in. Handlers never re-derive scope from anything client-controlled.
 */

const partsCallService = require('../partsCallService');

/**
 * robot_call — start (or re-join) the outbound-call lifecycle for the task's job.
 *
 * `startRobotCall` is idempotent: the partial-unique index on
 * outbound_call_attempts (job_id) WHERE status IN ('pending','dialing') collapses a
 * double-press into `{ ok:true, already:true }` (S14) — no second call is placed.
 * We surface a UI-facing `state` derived from the lifecycle result:
 *   - ok & already      → 'in_flight_existing' (a lifecycle was already active)
 *   - ok                → 'queued'             (a fresh attempt was enqueued)
 *   - !ok               → 'failed'             (+reason: no_slots / engine_error /
 *                                               no_phone / disabled / not_dialable)
 *
 * @param {{ task: object, job: object|null, companyId: string }} ctx
 * @returns {Promise<{ ok: boolean, state: string, reason?: string }>}
 */
async function robotCall({ task, jobId, companyId }) {
    // startRobotCall(jobId, companyId, taskId) — jobId first (verified signature).
    // The route resolves jobId from the task's parent projection (getTaskById exposes
    // `parent_type`/`parent_id`, not a raw `job_id`); fall back defensively to any
    // job_id present on the task object.
    const resolvedJobId = jobId != null ? jobId : task.job_id;
    const result = await partsCallService.startRobotCall(resolvedJobId, companyId, task.id);

    if (result && result.ok) {
        return {
            ok: true,
            state: result.already ? 'in_flight_existing' : 'queued',
            attemptId: result.attemptId ?? null,
        };
    }
    return {
        ok: false,
        state: 'failed',
        reason: (result && result.reason) || 'unknown',
    };
}

/**
 * manual_call — pure client affordance. No server mutation, no dial. Resolve the
 * customer phone + name from the already-loaded (company-scoped) job and hand the
 * frontend an open-softphone directive. If the job/phone is missing we still return
 * a well-formed directive (phone:null) so the route stays 200 and the client can
 * decide (it simply won't dial).
 *
 * @param {{ task: object, job: object|null, companyId: string }} ctx
 * @returns {Promise<{ ok: boolean, state: string, client: object }>}
 */
async function manualCall({ job }) {
    const phone = (job && job.customer_phone && String(job.customer_phone).trim()) || null;
    const contactName = (job && job.customer_name && String(job.customer_name).trim()) || null;
    return {
        ok: true,
        state: 'idle',
        client: { action: 'open_softphone', phone, contactName },
    };
}

// The closed map — the ONLY actions the route will ever execute.
const REGISTRY = {
    robot_call: robotCall,
    manual_call: manualCall,
};

/** Is `type` a known, executable action? (route → 400 when false). */
function isKnownAction(type) {
    return Object.prototype.hasOwnProperty.call(REGISTRY, type);
}

/**
 * runAction(type, ctx) — execute a registered action. The caller (route) MUST have
 * already validated `isKnownAction(type)`; we re-guard defensively and throw a
 * tagged error the route maps to 400 if an unknown type slips through.
 *
 * @param {string} type   The action type (must be in REGISTRY).
 * @param {{ task: object, job: object|null, companyId: string, client?: object }} ctx
 * @returns {Promise<object>} The handler result (shape depends on the action).
 */
async function runAction(type, ctx) {
    if (!isKnownAction(type)) {
        const err = new Error(`Unknown task action: ${type}`);
        err.code = 'UNKNOWN_ACTION';
        throw err;
    }
    return REGISTRY[type](ctx);
}

module.exports = {
    runAction,
    isKnownAction,
    // Exported for tests / introspection.
    REGISTRY,
};
