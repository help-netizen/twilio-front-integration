/**
 * Conversations Queries
 * PostgreSQL CRUD for SMS Conversations tables.
 */
const db = require('./connection');
const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// ─── sms_conversations ───
async function upsertConversation(data) {
    const {
        twilio_conversation_sid, service_sid, channel_type = 'sms', state = 'active',
        customer_e164, proxy_e164, friendly_name, attributes = {}, source = 'twilio',
        company_id = DEFAULT_COMPANY_ID,
    } = data;

    const result = await db.query(`
        INSERT INTO sms_conversations
            (twilio_conversation_sid, service_sid, channel_type, state,
             customer_e164, proxy_e164, friendly_name, attributes, source, company_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (twilio_conversation_sid) DO UPDATE SET
            state = EXCLUDED.state,
            friendly_name = COALESCE(EXCLUDED.friendly_name, sms_conversations.friendly_name),
            attributes = sms_conversations.attributes || EXCLUDED.attributes,
            updated_at = now()
        RETURNING *
    `, [twilio_conversation_sid, service_sid, channel_type, state,
        customer_e164, proxy_e164, friendly_name, JSON.stringify(attributes), source, company_id]);
    return result.rows[0];
}

async function getConversations({ limit = 30, cursor, state, company_id } = {}) {
    const params = [];
    const conditions = [];
    let idx = 1;

    if (company_id) { conditions.push(`company_id = $${idx++}`); params.push(company_id); }
    if (state) { conditions.push(`state = $${idx++}`); params.push(state); }
    if (cursor) { conditions.push(`last_message_at < $${idx++}`); params.push(cursor); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const result = await db.query(`
        SELECT * FROM sms_conversations ${where}
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT $${idx}
    `, params);
    return result.rows;
}

async function getConversationById(id) {
    const result = await db.query('SELECT * FROM sms_conversations WHERE id = $1', [id]);
    return result.rows[0] || null;
}

async function getConversationBySid(sid) {
    const result = await db.query('SELECT * FROM sms_conversations WHERE twilio_conversation_sid = $1', [sid]);
    return result.rows[0] || null;
}

async function findActiveConversation(customer_e164, proxy_e164) {
    const result = await db.query(`
        SELECT * FROM sms_conversations
        WHERE customer_e164 = $1 AND proxy_e164 = $2 AND state = 'active'
        LIMIT 1
    `, [customer_e164, proxy_e164]);
    return result.rows[0] || null;
}

async function updateConversationPreview(conversationId, { body, direction, timestamp }) {
    await db.query(`
        UPDATE sms_conversations SET
            last_message_preview = $2,
            last_message_direction = $3,
            last_message_at = $4,
            first_message_at = COALESCE(first_message_at, $4),
            updated_at = now()
        WHERE id = $1
    `, [conversationId, body, direction, timestamp]);
}

async function updateConversationState(conversationId, state) {
    const closedAt = state === 'closed' ? new Date().toISOString() : null;
    await db.query(`
        UPDATE sms_conversations SET state = $2, closed_at = COALESCE($3::timestamptz, closed_at), updated_at = now()
        WHERE id = $1
    `, [conversationId, state, closedAt]);
}

// ─── sms_messages ───
async function upsertMessage(data) {
    const {
        twilio_message_sid, conversation_id, conversation_sid, author, author_type = 'external',
        direction, transport = 'sms', body, attributes = {}, delivery_status,
        error_code, error_message, index_in_conversation,
        date_created_remote, date_updated_remote, date_sent_remote,
        company_id = DEFAULT_COMPANY_ID,
    } = data;

    const result = await db.query(`
        INSERT INTO sms_messages
            (twilio_message_sid, conversation_id, conversation_sid, author, author_type,
             direction, transport, body, attributes, delivery_status,
             error_code, error_message, index_in_conversation,
             date_created_remote, date_updated_remote, date_sent_remote, company_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (twilio_message_sid) DO UPDATE SET
            delivery_status = COALESCE(EXCLUDED.delivery_status, sms_messages.delivery_status),
            error_code = COALESCE(EXCLUDED.error_code, sms_messages.error_code),
            error_message = COALESCE(EXCLUDED.error_message, sms_messages.error_message),
            date_updated_remote = COALESCE(EXCLUDED.date_updated_remote, sms_messages.date_updated_remote),
            updated_at = now()
        RETURNING *
    `, [twilio_message_sid, conversation_id, conversation_sid, author, author_type,
        direction, transport, body, JSON.stringify(attributes), delivery_status,
        error_code, error_message, index_in_conversation,
        date_created_remote, date_updated_remote, date_sent_remote, company_id]);
    return result.rows[0];
}

async function getMessages(conversationId, { limit = 50, cursor } = {}) {
    const params = [conversationId];
    let cursorClause = '';
    if (cursor) { cursorClause = `AND created_at < $3`; params.push(limit, cursor); }
    else { params.push(limit); }

    const result = await db.query(`
        SELECT m.*, COALESCE(
            (SELECT json_agg(json_build_object(
                'id', md.id, 'twilio_media_sid', md.twilio_media_sid,
                'filename', md.filename, 'content_type', md.content_type,
                'size_bytes', md.size_bytes, 'preview_kind', md.preview_kind
            )) FROM sms_media md WHERE md.message_id = m.id), '[]'
        ) AS media
        FROM sms_messages m
        WHERE m.conversation_id = $1 ${cursorClause}
        ORDER BY m.created_at ASC
        LIMIT $2
    `, params);
    return result.rows;
}

async function updateDeliveryStatus(messageSid, status, errorCode, errorMessage) {
    await db.query(`
        UPDATE sms_messages SET delivery_status = $2, error_code = $3, error_message = $4, updated_at = now()
        WHERE twilio_message_sid = $1
    `, [messageSid, status, errorCode, errorMessage]);
}

// ─── sms_media ───
async function insertMedia(data) {
    const {
        message_id, twilio_media_sid, category = 'media', filename,
        content_type, size_bytes, preview_kind, storage_provider = 'twilio', metadata = {},
    } = data;
    const result = await db.query(`
        INSERT INTO sms_media (message_id, twilio_media_sid, category, filename, content_type, size_bytes, preview_kind, storage_provider, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (twilio_media_sid) DO NOTHING
        RETURNING *
    `, [message_id, twilio_media_sid, category, filename, content_type, size_bytes, preview_kind, storage_provider, JSON.stringify(metadata)]);
    return result.rows[0];
}

async function getMediaById(id) {
    const result = await db.query('SELECT * FROM sms_media WHERE id = $1', [id]);
    return result.rows[0] || null;
}

// ─── sms_events ───
async function insertEvent(data) {
    const {
        event_type, idempotency_key, twilio_request_sid, conversation_sid,
        message_sid, participant_sid, webhook_url, headers = {}, payload = {},
    } = data;

    const result = await db.query(`
        INSERT INTO sms_events (event_type, idempotency_key, twilio_request_sid, conversation_sid, message_sid, participant_sid, webhook_url, headers, payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
    `, [event_type, idempotency_key, twilio_request_sid, conversation_sid, message_sid, participant_sid, webhook_url, JSON.stringify(headers), JSON.stringify(payload)]);
    return result.rows[0] || null;
}

async function markEventProcessed(eventId, error = null) {
    const status = error ? 'failed' : 'processed';
    await db.query(`
        UPDATE sms_events SET processing_status = $2, processing_error = $3, processed_at = now() WHERE id = $1
    `, [eventId, status, error]);
}

module.exports = {
    upsertConversation, getConversations, getConversationById, getConversationBySid,
    findActiveConversation, updateConversationPreview, updateConversationState,
    upsertMessage, getMessages, updateDeliveryStatus,
    insertMedia, getMediaById,
    insertEvent, markEventProcessed,
};
