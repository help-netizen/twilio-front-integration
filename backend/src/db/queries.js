const db = require('./connection');

/**
 * Contact operations
 */

// Find contact by phone number
async function findContactByPhone(phoneNumber) {
    const result = await db.query(
        'SELECT * FROM contacts WHERE phone_number = $1',
        [phoneNumber]
    );
    return result.rows[0];
}

// Create new contact
async function createContact(phoneNumber, formattedNumber, displayName = null) {
    const result = await db.query(
        `INSERT INTO contacts (phone_number, formatted_number, display_name)
     VALUES ($1, $2, $3)
     RETURNING *`,
        [phoneNumber, formattedNumber, displayName || formattedNumber]
    );
    return result.rows[0];
}

// Find or create contact
async function findOrCreateContact(phoneNumber, formattedNumber) {
    let contact = await findContactByPhone(phoneNumber);
    if (!contact) {
        contact = await createContact(phoneNumber, formattedNumber);
    }
    return contact;
}

/**
 * Conversation operations
 */

// Get all conversations with pagination
async function getConversations(limit = 20, offset = 0) {
    const result = await db.query(
        `SELECT c.*, 
            to_json(co) as contact
     FROM conversations c
     JOIN contacts co ON c.contact_id = co.id
     ORDER BY c.last_message_at DESC NULLS LAST
     LIMIT $1 OFFSET $2`,
        [limit, offset]
    );
    return result.rows;
}

// Get total conversation count
async function getConversationsCount() {
    const result = await db.query('SELECT COUNT(*) FROM conversations');
    return parseInt(result.rows[0].count, 10);
}

// Get conversation by ID
async function getConversationById(id) {
    const result = await db.query(
        `SELECT c.*, 
            to_json(co) as contact
     FROM conversations c
     JOIN contacts co ON c.contact_id = co.id
     WHERE c.id = $1`,
        [id]
    );
    return result.rows[0];
}

// Find conversation by external ID (phone number)
async function findConversationByExternalId(externalId) {
    const result = await db.query(
        'SELECT * FROM conversations WHERE external_id = $1',
        [externalId]
    );
    return result.rows[0];
}

// Create new conversation
async function createConversation(contactId, externalId, subject) {
    const result = await db.query(
        `INSERT INTO conversations (contact_id, external_id, subject)
     VALUES ($1, $2, $3)
     RETURNING *`,
        [contactId, externalId, subject]
    );
    return result.rows[0];
}

// Find or create conversation for contact
async function findOrCreateConversation(contactId, externalId, subject) {
    let conversation = await findConversationByExternalId(externalId);
    if (!conversation) {
        conversation = await createConversation(contactId, externalId, subject);
    }
    return conversation;
}

// Update conversation last_message_at
async function updateConversationLastMessage(conversationId, timestamp) {
    const result = await db.query(
        `UPDATE conversations 
     SET last_message_at = $2,
         metadata = jsonb_set(
           COALESCE(metadata, '{}'),
           '{total_calls}',
           to_jsonb(COALESCE((metadata->>'total_calls')::int, 0) + 1)
         )
     WHERE id = $1
     RETURNING *`,
        [conversationId, timestamp]
    );
    return result.rows[0];
}

/**
 * Message operations
 */

// Get messages for conversation
async function getMessagesByConversation(conversationId) {
    const result = await db.query(
        `SELECT * FROM messages
     WHERE conversation_id = $1
     ORDER BY start_time DESC`,
        [conversationId]
    );
    return result.rows;
}

// Get message count for conversation
async function getMessageCountByConversation(conversationId) {
    const result = await db.query(
        'SELECT COUNT(*) FROM messages WHERE conversation_id = $1',
        [conversationId]
    );
    return parseInt(result.rows[0].count, 10);
}

// Find message by Twilio SID
async function findMessageByTwilioSid(twilioSid) {
    const result = await db.query(
        'SELECT * FROM messages WHERE twilio_sid = $1',
        [twilioSid]
    );
    return result.rows[0];
}

// Update existing message (for status changes from ringing -> completed)
async function updateMessage(messageId, updates) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    // Build dynamic UPDATE query
    if (updates.status !== undefined) {
        fields.push(`status = $${paramIndex++}`);
        values.push(updates.status);
    }
    if (updates.duration !== undefined) {
        fields.push(`duration = $${paramIndex++}`);
        values.push(updates.duration);
    }
    if (updates.endTime !== undefined) {
        fields.push(`end_time = $${paramIndex++}`);
        values.push(updates.endTime);
    }
    if (updates.metadata !== undefined) {
        fields.push(`metadata = $${paramIndex++}`);
        values.push(updates.metadata);
    }

    if (fields.length === 0) {
        return null; // Nothing to update
    }

    values.push(messageId);
    const result = await db.query(
        `UPDATE messages 
         SET ${fields.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING *`,
        values
    );
    return result.rows[0];
}

// Create new message
async function createMessage(messageData) {
    const {
        conversationId,
        twilioSid,
        direction,
        status,
        fromNumber,
        toNumber,
        duration,
        price,
        priceUnit,
        startTime,
        endTime,
        recordingUrl,
        parentCallSid,
        metadata,
    } = messageData;

    const result = await db.query(
        `INSERT INTO messages (
      conversation_id, twilio_sid, direction, status,
      from_number, to_number, duration, price, price_unit,
      start_time, end_time, recording_url, parent_call_sid, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *`,
        [
            conversationId,
            twilioSid,
            direction,
            status,
            fromNumber,
            toNumber,
            duration,
            price,
            priceUnit,
            startTime,
            endTime,
            recordingUrl,
            parentCallSid,
            JSON.stringify(metadata || {}),
        ]
    );
    return result.rows[0];
}

// Get last message for conversation
async function getLastMessageByConversation(conversationId) {
    const result = await db.query(
        `SELECT * FROM messages
     WHERE conversation_id = $1
     ORDER BY start_time DESC
     LIMIT 1`,
        [conversationId]
    );
    return result.rows[0];
}

// Get active calls (calls that are currently in progress)
async function getActiveCalls() {
    const result = await db.query(
        `SELECT m.*, c.id as conversation_id, c.external_id as conversation_external_id
     FROM messages m
     JOIN conversations c ON m.conversation_id = c.id
     WHERE m.status IN ('queued', 'initiated', 'ringing', 'in-progress')
     ORDER BY m.start_time DESC`
    );
    return result.rows;
}

module.exports = {
    // Contact operations
    findContactByPhone,
    createContact,
    findOrCreateContact,

    // Conversation operations
    getConversations,
    getConversationsCount,
    getConversationById,
    findConversationByExternalId,
    createConversation,
    findOrCreateConversation,
    updateConversationLastMessage,

    // Message operations
    getMessagesByConversation,
    getMessageCountByConversation,
    findMessageByTwilioSid,
    updateMessage,  // Added for updating call status
    createMessage,
    getLastMessageByConversation,
    getActiveCalls,
};
