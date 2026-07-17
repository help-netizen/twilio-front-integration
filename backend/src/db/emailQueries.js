/**
 * Email Queries
 * PostgreSQL CRUD for email tables (EMAIL-001).
 */
const db = require('./connection');

// ─── email_mailboxes ─────────────────────────────────────────────────────

async function getMailboxByCompany(companyId) {
    const result = await db.query(
        `SELECT id, company_id, provider, email_address, display_name, provider_account_id,
                status, token_expires_at, history_id, last_synced_at, last_sync_status,
                last_sync_error, created_by, updated_by, created_at, updated_at
         FROM email_mailboxes WHERE company_id = $1 LIMIT 1`,
        [companyId]
    );
    return result.rows[0] || null;
}

async function getMailboxById(mailboxId) {
    const result = await db.query(
        `SELECT * FROM email_mailboxes WHERE id = $1`,
        [mailboxId]
    );
    return result.rows[0] || null;
}

async function getMailboxWithTokens(companyId) {
    const result = await db.query(
        `SELECT * FROM email_mailboxes WHERE company_id = $1 LIMIT 1`,
        [companyId]
    );
    return result.rows[0] || null;
}

async function upsertMailbox(data) {
    const {
        company_id, provider = 'gmail', email_address, display_name,
        provider_account_id, status = 'connected',
        access_token_encrypted, refresh_token_encrypted, token_expires_at,
        created_by, updated_by,
    } = data;

    const result = await db.query(`
        INSERT INTO email_mailboxes
            (company_id, provider, email_address, display_name, provider_account_id,
             status, access_token_encrypted, refresh_token_encrypted, token_expires_at,
             created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (company_id, provider) DO UPDATE SET
            email_address = EXCLUDED.email_address,
            display_name = COALESCE(EXCLUDED.display_name, email_mailboxes.display_name),
            provider_account_id = COALESCE(EXCLUDED.provider_account_id, email_mailboxes.provider_account_id),
            status = EXCLUDED.status,
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
            token_expires_at = EXCLUDED.token_expires_at,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
        RETURNING *
    `, [company_id, provider, email_address, display_name, provider_account_id,
        status, access_token_encrypted, refresh_token_encrypted, token_expires_at,
        created_by, updated_by]);
    return result.rows[0];
}

async function updateMailboxStatus(mailboxId, { status, last_sync_status, last_sync_error, last_synced_at, history_id, updated_by }) {
    const sets = ['updated_at = now()'];
    const params = [mailboxId];
    let idx = 2;

    if (status !== undefined)           { sets.push(`status = $${idx++}`);           params.push(status); }
    if (last_sync_status !== undefined)  { sets.push(`last_sync_status = $${idx++}`); params.push(last_sync_status); }
    if (last_sync_error !== undefined)   { sets.push(`last_sync_error = $${idx++}`);  params.push(last_sync_error); }
    if (last_synced_at !== undefined)    { sets.push(`last_synced_at = $${idx++}`);   params.push(last_synced_at); }
    if (history_id !== undefined)        { sets.push(`history_id = $${idx++}`);       params.push(history_id); }
    if (updated_by !== undefined)        { sets.push(`updated_by = $${idx++}`);       params.push(updated_by); }

    const result = await db.query(
        `UPDATE email_mailboxes SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params
    );
    return result.rows[0] || null;
}

async function updateMailboxTokens(mailboxId, { access_token_encrypted, refresh_token_encrypted, token_expires_at }) {
    const result = await db.query(`
        UPDATE email_mailboxes SET
            access_token_encrypted = $2,
            refresh_token_encrypted = COALESCE($3, refresh_token_encrypted),
            token_expires_at = $4,
            updated_at = now()
        WHERE id = $1
        RETURNING id
    `, [mailboxId, access_token_encrypted, refresh_token_encrypted, token_expires_at]);
    return result.rows[0] || null;
}

async function disconnectMailbox(mailboxId, updatedBy) {
    const result = await db.query(`
        UPDATE email_mailboxes SET
            status = 'disconnected',
            access_token_encrypted = NULL,
            refresh_token_encrypted = NULL,
            token_expires_at = NULL,
            updated_by = $2,
            updated_at = now()
        WHERE id = $1
        RETURNING *
    `, [mailboxId, updatedBy]);
    return result.rows[0] || null;
}

// ─── email_threads ───────────────────────────────────────────────────────

async function getThreads({ company_id, view = 'all', q, cursor, limit = 30 }) {
    const params = [company_id];
    const conditions = ['t.company_id = $1'];
    let idx = 2;

    // View filters
    if (view === 'inbox') {
        // Inbox = threads that have at least one inbound message (excludes sent-only threads)
        conditions.push(`EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound')`);
    } else if (view === 'unread') {
        conditions.push(`t.unread_count > 0`);
    } else if (view === 'sent') {
        conditions.push(`t.last_message_direction = 'outbound'`);
    } else if (view === 'attachments') {
        conditions.push(`t.has_attachments = true`);
    }

    // Free-text search across thread fields + messages body/recipients + attachment filenames
    if (q) {
        const qParam = `%${q}%`;
        conditions.push(`(
            t.subject ILIKE $${idx}
            OR t.last_message_preview ILIKE $${idx}
            OR t.last_message_from ILIKE $${idx}
            OR EXISTS (
                SELECT 1 FROM email_messages m
                WHERE m.thread_id = t.id
                  AND (m.body_text ILIKE $${idx} OR m.from_email ILIKE $${idx} OR m.from_name ILIKE $${idx}
                       OR m.to_recipients_json::text ILIKE $${idx}
                       OR m.cc_recipients_json::text ILIKE $${idx})
            )
            OR EXISTS (
                SELECT 1 FROM email_attachments a
                JOIN email_messages m2 ON m2.id = a.message_id
                WHERE m2.thread_id = t.id AND a.file_name ILIKE $${idx}
            )
        )`);
        params.push(qParam);
        idx++;
    }

    // Cursor-based pagination (last_message_at + id)
    if (cursor) {
        const [cursorTs, cursorId] = cursor.split('|');
        conditions.push(`(t.last_message_at, t.id) < ($${idx}, $${idx + 1})`);
        params.push(cursorTs, cursorId);
        idx += 2;
    }

    params.push(limit + 1); // fetch one extra to detect hasMore

    const where = conditions.join(' AND ');
    const result = await db.query(`
        SELECT t.* FROM email_threads t
        WHERE ${where}
        ORDER BY t.last_message_at DESC NULLS LAST, t.id DESC
        LIMIT $${idx}
    `, params);

    const rows = result.rows;
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    let nextCursor = null;
    if (hasMore && rows.length > 0) {
        const last = rows[rows.length - 1];
        nextCursor = `${last.last_message_at.toISOString()}|${last.id}`;
    }

    return { threads: rows, nextCursor, hasMore };
}

async function getThreadById(threadId, companyId) {
    const result = await db.query(
        `SELECT * FROM email_threads WHERE id = $1 AND company_id = $2`,
        [threadId, companyId]
    );
    return result.rows[0] || null;
}

async function getThreadByProviderId(providerThreadId, companyId) {
    const result = await db.query(
        `SELECT * FROM email_threads WHERE provider_thread_id = $1 AND company_id = $2`,
        [providerThreadId, companyId]
    );
    return result.rows[0] || null;
}

async function upsertThread(data) {
    const {
        company_id, mailbox_id, provider_thread_id, subject,
        participants_json, last_message_at, last_message_preview,
        last_message_direction, last_message_from, unread_count,
        has_attachments, message_count,
    } = data;

    const result = await db.query(`
        INSERT INTO email_threads
            (company_id, mailbox_id, provider_thread_id, subject,
             participants_json, last_message_at, last_message_preview,
             last_message_direction, last_message_from, unread_count,
             has_attachments, message_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (company_id, provider_thread_id) DO UPDATE SET
            subject = COALESCE(EXCLUDED.subject, email_threads.subject),
            participants_json = EXCLUDED.participants_json,
            last_message_at = GREATEST(EXCLUDED.last_message_at, email_threads.last_message_at),
            last_message_preview = CASE
                WHEN EXCLUDED.last_message_at >= COALESCE(email_threads.last_message_at, '1970-01-01'::timestamptz)
                THEN EXCLUDED.last_message_preview
                ELSE email_threads.last_message_preview END,
            last_message_direction = CASE
                WHEN EXCLUDED.last_message_at >= COALESCE(email_threads.last_message_at, '1970-01-01'::timestamptz)
                THEN EXCLUDED.last_message_direction
                ELSE email_threads.last_message_direction END,
            last_message_from = CASE
                WHEN EXCLUDED.last_message_at >= COALESCE(email_threads.last_message_at, '1970-01-01'::timestamptz)
                THEN EXCLUDED.last_message_from
                ELSE email_threads.last_message_from END,
            unread_count = EXCLUDED.unread_count,
            has_attachments = EXCLUDED.has_attachments OR email_threads.has_attachments,
            message_count = GREATEST(EXCLUDED.message_count, email_threads.message_count),
            updated_at = now()
        RETURNING *
    `, [company_id, mailbox_id, provider_thread_id, subject,
        JSON.stringify(participants_json || []), last_message_at, last_message_preview,
        last_message_direction, last_message_from, unread_count || 0,
        has_attachments || false, message_count || 0]);
    return result.rows[0];
}

async function markThreadRead(threadId, companyId) {
    const result = await db.query(`
        UPDATE email_threads SET
            unread_count = 0,
            updated_at = now()
        WHERE id = $1 AND company_id = $2
        RETURNING *
    `, [threadId, companyId]);
    return result.rows[0] || null;
}

// ─── email_messages ──────────────────────────────────────────────────────

async function getMessagesByThread(threadId, companyId) {
    const result = await db.query(`
        SELECT m.*,
               COALESCE(
                   (SELECT json_agg(a.* ORDER BY a.sort_order)
                    FROM email_attachments a WHERE a.message_id = m.id),
                   '[]'::json
               ) AS attachments
        FROM email_messages m
        WHERE m.thread_id = $1 AND m.company_id = $2
        ORDER BY m.gmail_internal_at ASC, m.id ASC
    `, [threadId, companyId]);
    return result.rows;
}

async function upsertMessage(data) {
    const {
        company_id, mailbox_id, thread_id, provider_message_id, provider_thread_id,
        message_id_header, in_reply_to_header, references_header,
        direction, from_name, from_email, to_recipients_json, cc_recipients_json,
        subject, snippet, body_text, body_html, has_attachments,
        gmail_internal_at, sent_by_user_id, sent_by_user_email,
    } = data;

    const result = await db.query(`
        INSERT INTO email_messages
            (company_id, mailbox_id, thread_id, provider_message_id, provider_thread_id,
             message_id_header, in_reply_to_header, references_header,
             direction, from_name, from_email, to_recipients_json, cc_recipients_json,
             subject, snippet, body_text, body_html, has_attachments,
             gmail_internal_at, sent_by_user_id, sent_by_user_email)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT (company_id, provider_message_id) DO UPDATE SET
            body_text = COALESCE(EXCLUDED.body_text, email_messages.body_text),
            body_html = COALESCE(EXCLUDED.body_html, email_messages.body_html),
            snippet = COALESCE(EXCLUDED.snippet, email_messages.snippet),
            has_attachments = EXCLUDED.has_attachments,
            updated_at = now()
        RETURNING *
    `, [company_id, mailbox_id, thread_id, provider_message_id, provider_thread_id,
        message_id_header, in_reply_to_header, references_header,
        direction, from_name, from_email,
        JSON.stringify(to_recipients_json || []), JSON.stringify(cc_recipients_json || []),
        subject, snippet, body_text, body_html, has_attachments || false,
        gmail_internal_at, sent_by_user_id, sent_by_user_email]);
    return result.rows[0];
}

// ─── email_attachments ───────────────────────────────────────────────────

async function getAttachmentById(attachmentId, companyId) {
    const result = await db.query(
        `SELECT a.*, m.mailbox_id, m.provider_message_id
         FROM email_attachments a
         JOIN email_messages m ON m.id = a.message_id
         WHERE a.id = $1 AND a.company_id = $2`,
        [attachmentId, companyId]
    );
    return result.rows[0] || null;
}

async function upsertAttachments(messageId, companyId, attachments) {
    if (!attachments || attachments.length === 0) return [];

    const results = [];
    for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        const result = await db.query(`
            INSERT INTO email_attachments
                (company_id, message_id, provider_attachment_id, part_id,
                 file_name, content_type, file_size, is_inline, content_id, sort_order)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT ON CONSTRAINT email_attachments_pkey DO NOTHING
            RETURNING *
        `, [companyId, messageId, a.provider_attachment_id, a.part_id,
            a.file_name, a.content_type, a.file_size, a.is_inline || false,
            a.content_id, a.sort_order || i]);
        if (result.rows[0]) results.push(result.rows[0]);
    }
    return results;
}

// ─── email_sync_state ────────────────────────────────────────────────────

async function getSyncState(mailboxId) {
    const result = await db.query(
        `SELECT * FROM email_sync_state WHERE mailbox_id = $1`,
        [mailboxId]
    );
    return result.rows[0] || null;
}

async function upsertSyncState(data) {
    const {
        mailbox_id, company_id, last_history_id,
        initial_backfill_completed_at, last_sync_started_at,
        last_sync_finished_at, last_sync_error,
    } = data;

    const result = await db.query(`
        INSERT INTO email_sync_state
            (mailbox_id, company_id, last_history_id,
             initial_backfill_completed_at, last_sync_started_at,
             last_sync_finished_at, last_sync_error)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (mailbox_id) DO UPDATE SET
            last_history_id = COALESCE(EXCLUDED.last_history_id, email_sync_state.last_history_id),
            initial_backfill_completed_at = COALESCE(EXCLUDED.initial_backfill_completed_at, email_sync_state.initial_backfill_completed_at),
            last_sync_started_at = COALESCE(EXCLUDED.last_sync_started_at, email_sync_state.last_sync_started_at),
            last_sync_finished_at = COALESCE(EXCLUDED.last_sync_finished_at, email_sync_state.last_sync_finished_at),
            last_sync_error = EXCLUDED.last_sync_error,
            updated_at = now()
        RETURNING *
    `, [mailbox_id, company_id, last_history_id,
        initial_backfill_completed_at, last_sync_started_at,
        last_sync_finished_at, last_sync_error]);
    return result.rows[0];
}

async function listDueMailboxes(intervalMinutes = 5) {
    const result = await db.query(`
        SELECT m.id AS mailbox_id, m.company_id, m.provider, m.status
        FROM email_mailboxes m
        LEFT JOIN email_sync_state s ON s.mailbox_id = m.id
        WHERE m.status = 'connected'
          AND (s.last_sync_finished_at IS NULL
               OR s.last_sync_finished_at < now() - ($1 || ' minutes')::interval)
          AND (s.last_sync_started_at IS NULL
               OR s.last_sync_started_at < now() - interval '10 minutes')
        ORDER BY s.last_sync_finished_at ASC NULLS FIRST
    `, [String(intervalMinutes)]);
    return result.rows;
}

module.exports = {
    // mailbox
    getMailboxByCompany,
    getMailboxById,
    getMailboxWithTokens,
    upsertMailbox,
    updateMailboxStatus,
    updateMailboxTokens,
    disconnectMailbox,
    // threads
    getThreads,
    getThreadById,
    getThreadByProviderId,
    upsertThread,
    markThreadRead,
    // messages
    getMessagesByThread,
    upsertMessage,
    // attachments
    getAttachmentById,
    upsertAttachments,
    // sync
    getSyncState,
    upsertSyncState,
    listDueMailboxes,
};
