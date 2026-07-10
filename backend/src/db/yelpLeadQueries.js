/**
 * yelpLeadQueries — YELP-LEAD-AUTORESPONDER-001 (Phase 1a, TASK-YLA-002).
 *
 * The `yelp_lead_events` ledger (migration 162) is a **releasable claim lock**:
 * the UNIQUE(company_id, provider_message_id) constraint — not app logic —
 * guarantees a re-ingested Yelp new-lead email is handled at most once.
 *
 *   claimYelpLead        atomic INSERT … ON CONFLICT DO NOTHING RETURNING id.
 *                        First caller of a (company, pmid) wins ({claimed:true});
 *                        a re-ingest no-ops ({claimed:false}).
 *   releaseClaim         DELETE by id — called ONLY when createLead throws, so the
 *                        next poll re-scan re-attempts the lead (lead at-least-once).
 *   markGreeted          stamp greeted_at + lead_id + thread_token after the
 *                        best-effort greeting (claim held, never released).
 *   threadAlreadyGreeted EXISTS a greeted row for (company, thread_token) —
 *                        defense-in-depth one-reply-per-thread guard.
 *
 * Every query is company-scoped. Uses the shared `db.query` seam.
 */
'use strict';

const db = require('./connection');

/**
 * Atomically claim a Yelp message for this company. The claim runs BEFORE parse
 * (see yelpLeadService.maybeHandleYelpLead), so `threadToken` is normally null at
 * claim time and is written later by markGreeted.
 * @param {string} companyId
 * @param {string} providerMessageId
 * @param {string|null} [threadToken=null]
 * @returns {Promise<{claimed:true,id:number}|{claimed:false}>}
 */
async function claimYelpLead(companyId, providerMessageId, threadToken = null) {
    const { rows } = await db.query(
        `INSERT INTO yelp_lead_events (company_id, provider_message_id, thread_token, status)
         VALUES ($1, $2, $3, 'claimed')
         ON CONFLICT (company_id, provider_message_id) DO NOTHING
         RETURNING id`,
        [companyId, providerMessageId, threadToken]
    );
    if (rows && rows.length > 0) {
        return { claimed: true, id: rows[0].id };
    }
    return { claimed: false };
}

/**
 * Release a previously-won claim (DELETE by id). Called only when the downstream
 * createLead fails, so the message is re-scannable on the next poll.
 * @param {number} id
 */
async function releaseClaim(id) {
    await db.query(`DELETE FROM yelp_lead_events WHERE id = $1`, [id]);
}

/**
 * Finalize a claim after the greeting attempt: record the lead linkage, the
 * thread token (for one-reply-per-thread lookups) and the greeting message id.
 * greeted_at is stamped here regardless of send success — the claim is "done".
 * @param {number} id
 * @param {{leadId?:(number|null), threadToken?:(string|null), greetingProviderMessageId?:(string|null), status?:string}} [opts]
 */
async function markGreeted(id, opts = {}) {
    const {
        leadId = null,
        threadToken = null,
        greetingProviderMessageId = null,
        status = 'greeted',
    } = opts;
    await db.query(
        `UPDATE yelp_lead_events
            SET greeted_at = now(),
                lead_id = $2,
                thread_token = COALESCE($3, thread_token),
                greeting_provider_message_id = $4,
                status = $5
          WHERE id = $1`,
        [id, leadId, threadToken, greetingProviderMessageId, status]
    );
}

/**
 * Has THIS company already greeted a message on this Yelp thread? Defense-in-depth
 * for the one-reply-per-thread rule across distinct provider_message_ids that share
 * a thread token. Null/empty token → false (nothing to match).
 * @param {string} companyId
 * @param {string|null} threadToken
 * @returns {Promise<boolean>}
 */
async function threadAlreadyGreeted(companyId, threadToken) {
    if (!threadToken) return false;
    const { rows } = await db.query(
        `SELECT 1
           FROM yelp_lead_events
          WHERE company_id = $1
            AND thread_token = $2
            AND greeted_at IS NOT NULL
          LIMIT 1`,
        [companyId, threadToken]
    );
    return !!(rows && rows.length > 0);
}

module.exports = {
    claimYelpLead,
    releaseClaim,
    markGreeted,
    threadAlreadyGreeted,
};
