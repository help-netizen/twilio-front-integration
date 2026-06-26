/**
 * ONWAY-001 — pure SCXML transform for the "On the way" job status.
 *
 * Extracted as a DB-free, unit-testable pure function (TASK-ONWAY-1 / consumed by
 * TASK-ONWAY-3). It mirrors EXACTLY the two `replace()` passes performed by the
 * SQL migration `backend/db/migrations/127_job_fsm_on_the_way.sql`.
 *
 * IMPORTANT — why this is a parallel implementation, not a shared module:
 *   The migration runner (`apply_migrations.js`) executes plain `.sql` files via
 *   `db.query(sql)` — it does NOT run JS, so a migration cannot `require()` this
 *   helper. The migration therefore keeps the same logic inline as SQL `replace()`
 *   calls, and this helper holds the byte-identical transform so tests can assert
 *   the injected state/transitions and idempotency without a database.
 *   Keep the two in lockstep: any edit here must be mirrored in migration 127
 *   (and the `073` seed / `fsm/job.scxml` canonical source), and vice-versa.
 *
 * Transitions added (ONWAY-001 §5.5):
 *   Into On the way:  TO_ON_THE_WAY     Submitted   → On_the_way
 *   Into On the way:  TO_ON_THE_WAY     Rescheduled → On_the_way
 *   Out of On the way: TO_VISIT_COMPLETED On_the_way → Visit_completed
 *   Out of On the way: TO_CANCELED        On_the_way → Canceled
 *
 * State id is `On_the_way` (SCXML id rules); status name / label is `On the way`.
 * Additive only — no existing state or transition is removed or altered.
 */

'use strict';

// Idempotency marker — identical to the migration's
//   WHERE v.scxml_source NOT LIKE '%id="On_the_way"%'  guard.
const ON_THE_WAY_MARKER = 'id="On_the_way"';

// (A) The new state block, injected immediately BEFORE the `<final id="Canceled" …/>`
//     marker. Indentation matches the neighboring states in `fsm/job.scxml`.
const ON_THE_WAY_STATE_BLOCK =
`  <state id="On_the_way" blanc:label="On the way" blanc:statusName="On the way">
    <transition event="TO_VISIT_COMPLETED" target="Visit_completed" blanc:action="true" blanc:label="Visit completed" blanc:order="1" />
    <transition event="TO_CANCELED" target="Canceled" blanc:action="true" blanc:label="Cancel" blanc:order="2" blanc:confirm="true" blanc:confirmText="Are you sure you want to cancel this job?" />
  </state>

`;

// The `<final id="Canceled" …/>` marker we anchor the new state in front of.
const CANCELED_FINAL_MARKER = '  <final id="Canceled" blanc:label="Canceled" />';

// (B) Inbound transition injected as the FIRST child of the Submitted/Rescheduled
//     opening tags.
const SUBMITTED_OPEN = '  <state id="Submitted" blanc:label="Submitted">';
const RESCHEDULED_OPEN = '  <state id="Rescheduled" blanc:label="Rescheduled">';
const INBOUND_TRANSITION =
'\n    <transition event="TO_ON_THE_WAY" target="On_the_way" blanc:action="true" blanc:label="On the way" blanc:order="0" />';

/**
 * Inject the "On the way" state + inbound transitions into a job SCXML source.
 *
 * Idempotent: if the SCXML already contains the On_the_way state (the same
 * `id="On_the_way"` marker the migration guards on), returns the input unchanged
 * with `changed:false`. Also returns `changed:false` if the expected markers are
 * absent (mirrors the migration's `IF new_scxml = scxml_source → CONTINUE`).
 *
 * @param {string} scxml — the job machine SCXML source
 * @returns {{ changed: boolean, scxml: string }}
 */
function injectOnTheWay(scxml) {
    if (typeof scxml !== 'string') {
        return { changed: false, scxml };
    }
    // Already present → no-op (same guard as the migration's NOT LIKE filter).
    if (scxml.includes(ON_THE_WAY_MARKER)) {
        return { changed: false, scxml };
    }

    let out = scxml;

    // (A) Insert the new state immediately BEFORE the Canceled <final> marker.
    out = out.replace(
        CANCELED_FINAL_MARKER,
        ON_THE_WAY_STATE_BLOCK + CANCELED_FINAL_MARKER
    );

    // (B) Inject the inbound transition as first child of Submitted and Rescheduled.
    out = out.replace(
        SUBMITTED_OPEN,
        SUBMITTED_OPEN + INBOUND_TRANSITION
    );
    out = out.replace(
        RESCHEDULED_OPEN,
        RESCHEDULED_OPEN + INBOUND_TRANSITION
    );

    // Markers not found / nothing replaced → treat as unchanged (migration parity).
    if (out === scxml) {
        return { changed: false, scxml };
    }
    return { changed: true, scxml: out };
}

module.exports = {
    injectOnTheWay,
    ON_THE_WAY_MARKER,
};
