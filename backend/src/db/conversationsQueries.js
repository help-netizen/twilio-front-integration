/**
 * Conversations Queries
 * PostgreSQL CRUD for SMS Conversations tables.
 */
const db = require('./connection');
const { buildActiveAssignedContactPredicate } = require('./providerContactAccessQueries');

function requireCompanyId(companyId) {
    if (!companyId) throw new Error('companyId is required');
    return companyId;
}

// ─── sms_conversations ───
async function upsertConversation(data) {
    const {
        twilio_conversation_sid, service_sid, channel_type = 'sms', state = 'active',
        customer_e164, proxy_e164, friendly_name, attributes = {}, source = 'twilio',
        company_id,
    } = data;
    requireCompanyId(company_id);

    const customer_digits = customer_e164 ? customer_e164.replace(/\D/g, '') : null;

    const result = await db.query(`
        INSERT INTO sms_conversations
            (twilio_conversation_sid, service_sid, channel_type, state,
             customer_e164, proxy_e164, friendly_name, attributes, source, company_id, customer_digits)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (twilio_conversation_sid) DO UPDATE SET
            state = EXCLUDED.state,
            friendly_name = COALESCE(EXCLUDED.friendly_name, sms_conversations.friendly_name),
            attributes = sms_conversations.attributes || EXCLUDED.attributes,
            customer_digits = COALESCE(EXCLUDED.customer_digits, sms_conversations.customer_digits),
            updated_at = now()
        WHERE sms_conversations.company_id = EXCLUDED.company_id
        RETURNING *
    `, [twilio_conversation_sid, service_sid, channel_type, state,
        customer_e164, proxy_e164, friendly_name, JSON.stringify(attributes), source, company_id, customer_digits]);
    return result.rows[0];
}

async function getConversations({ limit = 30, cursor, state, company_id } = {}) {
    requireCompanyId(company_id);
    const params = [company_id];
    const conditions = ['company_id = $1'];
    let idx = 2;

    if (state) { conditions.push(`state = $${idx++}`); params.push(state); }
    if (cursor) { conditions.push(`last_message_at < $${idx++}`); params.push(cursor); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const result = await db.query(`
        SELECT * FROM sms_conversations ${where}
        ORDER BY has_unread DESC, last_message_at DESC NULLS LAST
        LIMIT $${idx}
    `, params);
    return result.rows;
}

async function getConversationById(id, companyId) {
    requireCompanyId(companyId);
    const result = await db.query(
        'SELECT * FROM sms_conversations WHERE id = $1 AND company_id = $2',
        [id, companyId]
    );
    return result.rows[0] || null;
}

/**
 * Is this conversation visible to an assigned_only provider?
 * Only when its customer phone maps to a contact reachable from the provider's
 * visible assigned jobs.
 */
async function isConversationVisibleToProvider(conversationId, companyId, userId) {
    if (!companyId || !userId) return false;
    const activeContactPredicate = buildActiveAssignedContactPredicate({
        jobsAlias: 'pj',
        contactIdExpression: 'c.id',
        companyPlaceholder: 'sc.company_id',
        userPlaceholder: '$3',
    });
    const r = await db.query(
        `SELECT 1
         FROM sms_conversations sc
         JOIN contacts c
           ON c.company_id = sc.company_id
          AND regexp_replace(c.phone_e164, '\\D', '', 'g') = regexp_replace(sc.customer_e164, '\\D', '', 'g')
         WHERE sc.id = $1 AND sc.company_id = $2
           AND ${activeContactPredicate}
         LIMIT 1`,
        [conversationId, companyId, JSON.stringify([String(userId)])]
    );
    return r.rows.length > 0;
}

async function resolveCompanyByConversationSid(sid) {
    const result = await db.query(
        'SELECT company_id FROM sms_conversations WHERE twilio_conversation_sid = $1',
        [sid]
    );
    return result.rows[0]?.company_id || null;
}

async function getConversationBySid(sid, companyId) {
    requireCompanyId(companyId);
    const result = await db.query(
        'SELECT * FROM sms_conversations WHERE twilio_conversation_sid = $1 AND company_id = $2',
        [sid, companyId]
    );
    return result.rows[0] || null;
}

async function findActiveConversation(customer_e164, proxy_e164, companyId) {
    requireCompanyId(companyId);
    const result = await db.query(`
        SELECT * FROM sms_conversations
        WHERE customer_e164 = $1 AND proxy_e164 = $2 AND company_id = $3 AND state = 'active'
        LIMIT 1
    `, [customer_e164, proxy_e164, companyId]);
    return result.rows[0] || null;
}

async function updateConversationPreview(conversationId, companyId, { body, direction, timestamp, isInbound = false }) {
    requireCompanyId(companyId);
    const extraSets = isInbound
        ? ', has_unread = true, last_incoming_at = $4'
        : '';
    await db.query(`
        UPDATE sms_conversations SET
            last_message_preview = $2,
            last_message_direction = $3,
            last_message_at = $4,
            first_message_at = COALESCE(first_message_at, $4)
            ${extraSets},
            updated_at = now()
        WHERE id = $1 AND company_id = $5
    `, [conversationId, body, direction, timestamp, companyId]);
}

async function markConversationRead(conversationId, companyId) {
    requireCompanyId(companyId);
    const result = await db.query(`
        UPDATE sms_conversations SET
            has_unread = false,
            last_read_at = now(),
            updated_at = now()
        WHERE id = $1 AND company_id = $2
        RETURNING *
    `, [conversationId, companyId]);
    return result.rows[0] || null;
}

async function markConversationUnread(conversationId, companyId) {
    requireCompanyId(companyId);
    const result = await db.query(`
        UPDATE sms_conversations SET
            has_unread = true,
            updated_at = now()
        WHERE id = $1 AND company_id = $2
        RETURNING *
    `, [conversationId, companyId]);
    return result.rows[0] || null;
}

async function updateConversationState(conversationId, companyId, state) {
    requireCompanyId(companyId);
    const closedAt = state === 'closed' ? new Date().toISOString() : null;
    const result = await db.query(`
        UPDATE sms_conversations SET state = $3, closed_at = COALESCE($4::timestamptz, closed_at), updated_at = now()
        WHERE id = $1 AND company_id = $2
        RETURNING *
    `, [conversationId, companyId, state, closedAt]);
    return result.rows[0] || null;
}

// ─── sms_messages ───
async function upsertMessage(data) {
    const {
        twilio_message_sid, conversation_id, conversation_sid, author, author_type = 'external',
        direction, transport = 'sms', body, attributes = {}, delivery_status,
        error_code, error_message, index_in_conversation,
        date_created_remote, date_updated_remote, date_sent_remote,
        company_id,
    } = data;
    requireCompanyId(company_id);

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
        WHERE sms_messages.company_id = EXCLUDED.company_id
        RETURNING *
    `, [twilio_message_sid, conversation_id, conversation_sid, author, author_type,
        direction, transport, body, JSON.stringify(attributes), delivery_status,
        error_code, error_message, index_in_conversation,
        date_created_remote, date_updated_remote, date_sent_remote, company_id]);
    return result.rows[0];
}

async function getMessages(conversationId, { limit = 50, cursor, companyId = null } = {}) {
    if (!companyId) throw new Error('companyId is required');
    const params = [conversationId, limit];
    let cursorClause = '';
    if (cursor) { cursorClause = `AND m.created_at < $3`; params.push(cursor); }
    params.push(companyId);
    const companyClause = `AND m.company_id = $${params.length}`;

    const result = await db.query(`
        SELECT m.*, COALESCE(
            (SELECT json_agg(json_build_object(
                'id', md.id, 'twilio_media_sid', md.twilio_media_sid,
                'filename', md.filename, 'content_type', md.content_type,
                'size_bytes', md.size_bytes, 'preview_kind', md.preview_kind
            )) FROM sms_media md WHERE md.message_id = m.id), '[]'
        ) AS media
        FROM sms_messages m
        WHERE m.conversation_id = $1 ${cursorClause} ${companyClause}
        ORDER BY m.created_at ASC
        LIMIT $2
    `, params);
    return result.rows;
}

/**
 * Newest-first timeline page across the supplied conversations. cursorPred is
 * produced by timelinePage.predicateModeFor('sms', cursor) and has the shape
 * `{ mode: 'lt'|'lte'|'tuple', ts, id }`.
 */
async function getMessagesPageDesc(conversationIds, companyId, { limit, cursorPred } = {}) {
    const params = [conversationIds, companyId, limit];
    let cursorClause = '';
    if (cursorPred?.mode === 'tuple') {
        params.push(cursorPred.ts, cursorPred.id);
        cursorClause = `AND (m.created_at, m.id) < ($4::timestamptz, $5::uuid)`;
    } else if (cursorPred) {
        params.push(cursorPred.ts);
        const operator = cursorPred.mode === 'lte' ? '<=' : '<';
        cursorClause = `AND m.created_at ${operator} $4::timestamptz`;
    }

    const result = await db.query(`
        SELECT sub.*
        FROM unnest($1::uuid[]) AS conv(cid)
        JOIN LATERAL (
            SELECT m.*,
                   to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
                   COALESCE(
                       (SELECT json_agg(json_build_object(
                           'id', md.id, 'twilio_media_sid', md.twilio_media_sid,
                           'filename', md.filename, 'content_type', md.content_type,
                           'size_bytes', md.size_bytes, 'preview_kind', md.preview_kind
                       )) FROM sms_media md WHERE md.message_id = m.id), '[]'
                   ) AS media
            FROM sms_messages m
            WHERE m.conversation_id = conv.cid
              AND m.company_id = $2
              ${cursorClause}
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $3
        ) sub ON true
    `, params);
    return result.rows;
}

async function resolveCompanyByMessageSid(messageSid) {
    const result = await db.query(
        'SELECT company_id FROM sms_messages WHERE twilio_message_sid = $1',
        [messageSid]
    );
    return result.rows[0]?.company_id || null;
}

async function updateDeliveryStatus(messageSid, companyId, status, errorCode, errorMessage) {
    requireCompanyId(companyId);
    const result = await db.query(`
        UPDATE sms_messages SET delivery_status = $3, error_code = $4, error_message = $5, updated_at = now()
        WHERE twilio_message_sid = $1 AND company_id = $2
        RETURNING id, conversation_id, company_id, direction
    `, [messageSid, companyId, status, errorCode, errorMessage]);
    return result.rows[0] || null;
}

// ─── sms_media ───
async function insertMedia(data) {
    const {
        message_id, twilio_media_sid, category = 'media', filename,
        content_type, size_bytes, preview_kind, storage_provider = 'twilio', metadata = {}, company_id,
    } = data;
    requireCompanyId(company_id);
    const result = await db.query(`
        INSERT INTO sms_media (message_id, twilio_media_sid, category, filename, content_type, size_bytes, preview_kind, storage_provider, metadata)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
        FROM sms_messages message
        JOIN sms_conversations conversation
          ON conversation.id = message.conversation_id
         AND conversation.company_id = message.company_id
        WHERE message.id = $1
          AND message.company_id = $10
          AND conversation.company_id = $10
        ON CONFLICT (twilio_media_sid) DO NOTHING
        RETURNING *
    `, [message_id, twilio_media_sid, category, filename, content_type, size_bytes, preview_kind, storage_provider, JSON.stringify(metadata), company_id]);
    return result.rows[0] || null;
}

async function getMediaById(id, companyId) {
    requireCompanyId(companyId);
    const result = await db.query(
        `SELECT media.*, message.company_id, message.conversation_sid, message.twilio_message_sid
         FROM sms_media media
         JOIN sms_messages message ON message.id = media.message_id
         JOIN sms_conversations conversation
           ON conversation.id = message.conversation_id
          AND conversation.company_id = message.company_id
         WHERE media.id = $1
           AND message.company_id = $2
           AND conversation.company_id = $2`,
        [id, companyId]
    );
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
    upsertConversation, getConversations, getConversationById, isConversationVisibleToProvider,
    resolveCompanyByConversationSid, getConversationBySid,
    findActiveConversation, updateConversationPreview, updateConversationState, markConversationRead, markConversationUnread,
    upsertMessage, getMessages, resolveCompanyByMessageSid, updateDeliveryStatus,
    getMessagesPageDesc,
    insertMedia, getMediaById,
    insertEvent, markEventProcessed,
};
