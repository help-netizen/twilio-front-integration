/**
 * yelpConversationQueries — YELP-CONVO-BOOKING-001 (Phase A, T-YCB-A4).
 *
 * Company-scoped access to `yelp_conversations` (migration 164). EVERY query filters
 * company_id (tenant isolation: another company's conv-id resolves to no row). No
 * HTTP routes — these back the ingest intercept (yelpLeadService) and the shared
 * agentWorker `yelp_convo` handler only.
 *
 *   upsertConversation(companyId, convId, fields)  ON CONFLICT(company_id,
 *                        conversation_id) — the threading invariant: every turn of a
 *                        dialog collapses to ONE row. Only provided fields are written
 *                        (COALESCE keeps existing values on a partial upsert).
 *   getByConvId / getByConversationId              read one row (or null).
 *   getActiveByConversationId                      read only an OPEN row (or null).
 *   updateState(companyId, convId, patch)          partial UPDATE (COALESCE per column).
 *   setPhaseStatus(companyId, convId, phase, status)  thin phase/status transition.
 *
 * jsonb columns (collected / offered_slots / chosen_slot) are passed as JSON strings
 * and cast ::jsonb. Uses the shared db.query seam.
 */
'use strict';

const db = require('./connection');

function jsonOrNull(v) {
    return v === undefined || v === null ? null : JSON.stringify(v);
}

/**
 * Upsert (create or merge) a conversation row keyed on (company_id, conversation_id).
 * On conflict, only the fields present in `fields` overwrite (COALESCE keeps existing
 * values for absent fields), so a re-ingest of the first message never clobbers state.
 * @param {string} companyId
 * @param {string} conversationId  the stable Yelp conv-id (body-parsed)
 * @param {object} [fields]  any of lead_id, lead_uuid, phase, status, collected,
 *   offered_slots, chosen_slot, last_reply_to, last_thread_token, turn_count,
 *   last_inbound_message_id
 * @returns {Promise<object>} the upserted row
 */
async function upsertConversation(companyId, conversationId, fields = {}) {
    const f = fields || {};
    const params = [
        companyId,                              // $1
        conversationId,                         // $2
        f.lead_id ?? null,                      // $3
        f.lead_uuid ?? null,                    // $4
        f.phase ?? null,                        // $5
        f.status ?? null,                       // $6
        jsonOrNull(f.collected),                // $7
        jsonOrNull(f.offered_slots),            // $8
        jsonOrNull(f.chosen_slot),              // $9
        f.last_reply_to ?? null,                // $10
        f.last_thread_token ?? null,            // $11
        f.turn_count ?? null,                   // $12
        f.last_inbound_message_id ?? null,      // $13
    ];
    const { rows } = await db.query(
        `INSERT INTO yelp_conversations
             (company_id, conversation_id, lead_id, lead_uuid, phase, status,
              collected, offered_slots, chosen_slot, last_reply_to, last_thread_token,
              turn_count, last_inbound_message_id, updated_at)
         VALUES ($1, $2, $3, $4, COALESCE($5,'greet'), COALESCE($6,'open'),
                 COALESCE($7::jsonb,'{}'::jsonb), $8::jsonb, $9::jsonb, $10, $11,
                 COALESCE($12,0), $13, now())
         ON CONFLICT (company_id, conversation_id) DO UPDATE SET
             lead_id                 = COALESCE(EXCLUDED.lead_id, yelp_conversations.lead_id),
             lead_uuid               = COALESCE(EXCLUDED.lead_uuid, yelp_conversations.lead_uuid),
             phase                   = COALESCE($5, yelp_conversations.phase),
             status                  = COALESCE($6, yelp_conversations.status),
             collected               = COALESCE($7::jsonb, yelp_conversations.collected),
             offered_slots           = COALESCE($8::jsonb, yelp_conversations.offered_slots),
             chosen_slot             = COALESCE($9::jsonb, yelp_conversations.chosen_slot),
             last_reply_to           = COALESCE(EXCLUDED.last_reply_to, yelp_conversations.last_reply_to),
             last_thread_token       = COALESCE(EXCLUDED.last_thread_token, yelp_conversations.last_thread_token),
             turn_count              = COALESCE($12, yelp_conversations.turn_count),
             last_inbound_message_id = COALESCE(EXCLUDED.last_inbound_message_id, yelp_conversations.last_inbound_message_id),
             updated_at              = now()
         RETURNING *`,
        params
    );
    return (rows && rows[0]) || null;
}

/**
 * Read one conversation row (company-scoped). Null when absent (a foreign company's
 * conv-id, or an unseen conversation).
 * @param {string} companyId
 * @param {string} conversationId
 * @returns {Promise<object|null>}
 */
async function getByConvId(companyId, conversationId) {
    if (!conversationId) return null;
    const { rows } = await db.query(
        `SELECT * FROM yelp_conversations
          WHERE company_id = $1 AND conversation_id = $2
          LIMIT 1`,
        [companyId, conversationId]
    );
    return (rows && rows[0]) || null;
}

// Alias (task-prompt name); same behavior as getByConvId.
async function getByConversationId(companyId, conversationId) {
    return getByConvId(companyId, conversationId);
}

/**
 * Read one conversation row ONLY when it is still open (status='open'). Null when
 * absent or terminal — the reply intercept treats "no active row" as fall-through.
 * @param {string} companyId
 * @param {string} conversationId
 * @returns {Promise<object|null>}
 */
async function getActiveByConversationId(companyId, conversationId) {
    if (!conversationId) return null;
    const { rows } = await db.query(
        `SELECT * FROM yelp_conversations
          WHERE company_id = $1 AND conversation_id = $2 AND status = 'open'
          LIMIT 1`,
        [companyId, conversationId]
    );
    return (rows && rows[0]) || null;
}

/**
 * Partial update of a conversation (company-scoped). Only keys present in `patch`
 * change; every other column is preserved via COALESCE. updated_at is refreshed.
 * @param {string} companyId
 * @param {string} conversationId
 * @param {object} [patch]  any of lead_id, lead_uuid, phase, status, collected,
 *   offered_slots, chosen_slot, last_reply_to, last_thread_token, turn_count,
 *   last_inbound_message_id, reply_sent_at, slot_held_at
 * @returns {Promise<object|null>} the updated row (or null if no such row)
 */
async function updateState(companyId, conversationId, patch = {}) {
    const p = patch || {};
    const params = [
        companyId,                              // $1
        conversationId,                         // $2
        p.lead_id ?? null,                      // $3
        p.lead_uuid ?? null,                    // $4
        p.phase ?? null,                        // $5
        p.status ?? null,                       // $6
        jsonOrNull(p.collected),                // $7
        jsonOrNull(p.offered_slots),            // $8
        jsonOrNull(p.chosen_slot),              // $9
        p.last_reply_to ?? null,                // $10
        p.last_thread_token ?? null,            // $11
        p.turn_count ?? null,                   // $12
        p.last_inbound_message_id ?? null,      // $13
        p.reply_sent_at ?? null,                // $14
        p.slot_held_at ?? null,                 // $15
    ];
    const { rows } = await db.query(
        `UPDATE yelp_conversations SET
             lead_id                 = COALESCE($3, lead_id),
             lead_uuid               = COALESCE($4, lead_uuid),
             phase                   = COALESCE($5, phase),
             status                  = COALESCE($6, status),
             collected               = COALESCE($7::jsonb, collected),
             offered_slots           = COALESCE($8::jsonb, offered_slots),
             chosen_slot             = COALESCE($9::jsonb, chosen_slot),
             last_reply_to           = COALESCE($10, last_reply_to),
             last_thread_token       = COALESCE($11, last_thread_token),
             turn_count              = COALESCE($12, turn_count),
             last_inbound_message_id = COALESCE($13, last_inbound_message_id),
             reply_sent_at           = COALESCE($14, reply_sent_at),
             slot_held_at            = COALESCE($15, slot_held_at),
             updated_at              = now()
          WHERE company_id = $1 AND conversation_id = $2
          RETURNING *`,
        params
    );
    return (rows && rows[0]) || null;
}

/**
 * Thin phase/status transition (a terminal book/call, or a coarse phase advance).
 * @param {string} companyId
 * @param {string} conversationId
 * @param {string|null} phase
 * @param {string|null} status
 * @returns {Promise<object|null>}
 */
async function setPhaseStatus(companyId, conversationId, phase, status) {
    return updateState(companyId, conversationId, { phase: phase ?? null, status: status ?? null });
}

module.exports = {
    upsertConversation,
    getByConvId,
    getByConversationId,
    getActiveByConversationId,
    updateState,
    setPhaseStatus,
};
