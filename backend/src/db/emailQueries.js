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

    try {
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
    } catch (err) {
        // Multi-tenant isolation (migration 130): the same email_address is already
        // connected by a DIFFERENT company. The ON CONFLICT (company_id, provider)
        // upsert above handles the SAME company reconnecting; only a cross-tenant
        // collision reaches the uniq_email_mailboxes_address index and raises 23505.
        // Translate it into a clean 409 the OAuth callback can redirect on (never a 500).
        if (err && err.code === '23505') {
            const conflict = new Error('This Google account is already connected to another workspace.');
            conflict.httpStatus = 409;
            conflict.code = 'EMAIL_ALREADY_CONNECTED_ELSEWHERE';
            throw conflict;
        }
        throw err;
    }
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
               OR (s.last_sync_finished_at IS NOT NULL
                   AND s.last_sync_finished_at >= s.last_sync_started_at)
               OR s.last_sync_started_at < now() - interval '10 minutes')
        ORDER BY s.last_sync_finished_at ASC NULLS FIRST
    `, [String(intervalMinutes)]);
    return result.rows;
}

/**
 * Pure mirror of the listDueMailboxes WHERE clause (row-level decision), so the
 * due/not-due logic is unit-testable without a live Postgres. Keep IN SYNC with
 * the SQL above. row: { last_sync_started_at, last_sync_finished_at }.
 */
function isMailboxDue(row, { intervalMinutes, now = new Date() } = {}) {
    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    const startedMs = row.last_sync_started_at ? new Date(row.last_sync_started_at).getTime() : null;
    const finishedMs = row.last_sync_finished_at ? new Date(row.last_sync_finished_at).getTime() : null;
    const intervalMs = Number(intervalMinutes) * 60000;
    const cadenceOk = finishedMs === null || finishedMs < nowMs - intervalMs;
    const overlapOk = startedMs === null
        || (finishedMs !== null && finishedMs >= startedMs)
        || startedMs < nowMs - 10 * 60000;
    return cadenceOk && overlapOk;
}

// ─── EMAIL-TIMELINE-001: email ↔ contact ↔ timeline link ─────────────────
// All functions below are additive (EMAIL-001 inbox behavior is unchanged) and
// company-scoped where the data is tenant-bound. They build against migration 129
// columns: email_messages.{contact_id,timeline_id,on_timeline},
// email_mailboxes.{watch_history_id,watch_expires_at}.

/**
 * Resolve a contact by email for an inbound message (§3b).
 * Matches `lower(trim(from_email))` against either `lower(contacts.email)` OR
 * `contact_emails.email_normalized` (already lower(trim)'d at write time),
 * company-scoped. Multi-match tie-break: most-recently-active contact wins
 * (`contacts.updated_at DESC NULLS LAST, c.id ASC`) — deterministic single link,
 * never fans onto several timelines. Returns the contact row (incl. `id` as
 * contact_id) or null when no contact matches (→ message stays inbox-only).
 */
async function findEmailContact(fromEmail, companyId, client = db) {
    const normalized = String(fromEmail || '').trim().toLowerCase();
    if (!normalized) return null;
    const result = await client.query(
        `SELECT c.*, c.id AS contact_id
         FROM contacts c
         LEFT JOIN contact_emails ce ON ce.contact_id = c.id
         WHERE c.company_id = $1
           AND (lower(c.email) = $2 OR ce.email_normalized = $2)
         ORDER BY c.updated_at DESC NULLS LAST, c.id ASC
         LIMIT 1`,
        [companyId, normalized]
    );
    return result.rows[0] || null;
}

/**
 * Link an email_messages row to a contact/timeline and flag it for the timeline.
 * Keyed on the unique `(company_id, provider_message_id)` (079). Re-link is a
 * no-op UPDATE — idempotent under push redelivery / poll overlap. Used by both
 * inbound matching (§3d) and the outbound send path (§5, on_timeline stamp).
 * Returns the updated row or null when no such message exists for the company.
 */
async function linkMessageToContact(providerMessageId, companyId, { contact_id, timeline_id, on_timeline = true } = {}, client = db) {
    const result = await client.query(
        `UPDATE email_messages SET
            contact_id  = $3,
            timeline_id = $4,
            on_timeline = $5,
            updated_at  = now()
         WHERE company_id = $1 AND provider_message_id = $2
         RETURNING *`,
        [companyId, providerMessageId, contact_id, timeline_id, on_timeline]
    );
    return result.rows[0] || null;
}

/**
 * CONTACT-EMAIL-MERGE-001: every message id (provider_message_id) whose sender
 * address matches `emailNormalized` within one company. The message-id source for
 * `resolveAddedEmail`'s inbox-only and D2b re-point loops, feeding
 * `linkMessageToContact` (which keys on (company_id, provider_message_id)).
 *
 * Matches on `lower(trim(from_email)) = emailNormalized` — served by the mig-143
 * functional index `idx_email_messages_from_normalized (company_id, (lower(trim(from_email))))`,
 * so NO new index. Company-scoped (never crosses tenants) and tx-aware (optional
 * trailing `client`, pool by default) so it reads within the PATCH transaction.
 *
 * @param {string} emailNormalized  already lower(trim)'d address
 * @param {string} companyId
 * @param {{query: Function}} [client=db]
 * @returns {Promise<string[]>} provider_message_id list (possibly empty)
 */
async function listMessageIdsForAddress(emailNormalized, companyId, client = db) {
    const normalized = String(emailNormalized || '').trim().toLowerCase();
    if (!normalized) return [];
    const result = await client.query(
        `SELECT provider_message_id
         FROM email_messages
         WHERE company_id = $1
           AND lower(trim(from_email)) = $2`,
        [companyId, normalized]
    );
    return result.rows.map(r => r.provider_message_id);
}

/**
 * Pre-link idempotency probe (TASK-ET-4): the current link state of a message,
 * keyed on the unique `(company_id, provider_message_id)`. Lets the inbound
 * pipeline detect an already-projected row BEFORE the (no-op) re-link UPDATE, so
 * a redelivered push / poll-overlap does not re-flag unread or re-emit SSE.
 * Returns `{ contact_id, timeline_id, on_timeline }` or null when no such row.
 */
async function getMessageLinkState(providerMessageId, companyId) {
    const result = await db.query(
        `SELECT contact_id, timeline_id, on_timeline
         FROM email_messages
         WHERE company_id = $1 AND provider_message_id = $2
         LIMIT 1`,
        [companyId, providerMessageId]
    );
    return result.rows[0] || null;
}

/**
 * YELP reply-threading: everything a Yelp reply must carry to be ACCEPTED —
 * the RFC headers (In-Reply-To/References = the inbound's Message-ID + the Gmail
 * thread to reply INSIDE) AND the inbound's body/sender/date, because Yelp's
 * reply-by-email parser locates the reply by the QUOTED-ORIGINAL delimiter
 * ("On <date> <sender> wrote:" + "> " lines) — a bare unquoted body bounces with
 * cant_parse ("email client we do not yet support"). Company-scoped; null if the
 * message is unknown.
 */
async function getThreadingByProviderMessageId(providerMessageId, companyId) {
    if (!providerMessageId) return null;
    const result = await db.query(
        `SELECT message_id_header, provider_thread_id, subject,
                body_text, body_html, from_email, from_name, gmail_internal_at, timeline_id
         FROM email_messages
         WHERE company_id = $1 AND provider_message_id = $2
         LIMIT 1`,
        [companyId, providerMessageId]
    );
    return result.rows[0] || null;
}

/**
 * YELP-CONVO-CONTEXT-002: prior messages for one Yelp conversation timeline.
 * Includes linked rows plus sent outbound siblings of every locally-anchored
 * Gmail thread, so pre-backfill sends and manual replies remain available.
 * Newest-first, bounded, and company-scoped.
 */
async function listYelpConversationHistory(companyId, timelineId, { excludeProviderMessageId = null, limit = 30 } = {}) {
    const result = await db.query(
        `WITH conv_threads AS (
             SELECT DISTINCT em.thread_id
             FROM email_messages em
             WHERE em.company_id = $1 AND em.timeline_id = $2 AND em.on_timeline = true
         )
         SELECT em.id, em.provider_message_id, em.direction, em.body_text, em.snippet,
                em.gmail_internal_at
         FROM email_messages em
         WHERE em.company_id = $1
           AND (
                 (em.timeline_id = $2 AND em.on_timeline = true)
              OR (em.direction = 'outbound'
                  AND em.message_id_header IS NOT NULL AND em.message_id_header <> ''
                  AND em.thread_id IN (SELECT thread_id FROM conv_threads))
               )
           AND ($3::text IS NULL OR em.provider_message_id <> $3)
         ORDER BY em.gmail_internal_at DESC NULLS LAST, em.id DESC
         LIMIT $4`,
        [companyId, timelineId, excludeProviderMessageId, limit]
    );
    return result.rows;
}

/**
 * Poll-path scan (TASK-ET-4): a company's recently-imported INBOUND email_messages
 * rows that are not yet linked onto a timeline. The `direction='inbound'` filter
 * IS the draft/sent exclusion for the poll path (SENT/DRAFT rows are 'outbound').
 * Newest-first so a backlog drains most-recent-first. Company-scoped.
 */
async function listUnlinkedInboundForTimeline(companyId, { limit = 100 } = {}) {
    const result = await db.query(
        `SELECT id, provider_message_id, from_email, from_name, subject,
                body_text, snippet, gmail_internal_at
         FROM email_messages
         WHERE company_id = $1
           AND direction = 'inbound'
           AND contact_id IS NULL
           AND on_timeline = false
         ORDER BY gmail_internal_at DESC NULLS LAST, id DESC
         LIMIT $2`,
        [companyId, limit]
    );
    return result.rows;
}

/**
 * Poll-path scan for OUTBOUND (EMAIL-TIMELINE-001 follow-up): a company's
 * recently-imported OUTBOUND email_messages rows not yet projected onto a
 * timeline — the stored-row sibling of `listUnlinkedInboundForTimeline`. These
 * are emails the agent sent (incl. directly from Gmail) whose `from` is the
 * mailbox, so `getDirection` stamped them `direction='outbound'`.
 *
 * DRAFT exclusion: `email_messages` carries no Gmail label / draft flag column
 * (079), so there is nothing to filter on here beyond `direction`. The real-time
 * PUSH path is the one that excludes drafts (its NormalizedInboundMessage carries
 * `labelIds`, and `linkOutboundMessage` drops `DRAFT`). For the stored row,
 * `direction='outbound'` is the only discriminator available — matching how the
 * inbound poll relies on `direction='inbound'`. Returns `to_recipients_json`
 * (the recipient source `extractRecipientEmails` reads). Newest-first, scoped.
 */
async function listUnlinkedOutboundForTimeline(companyId, { limit = 100 } = {}) {
    const result = await db.query(
        `SELECT id, provider_message_id, to_recipients_json, subject,
                body_text, snippet, gmail_internal_at
         FROM email_messages
         WHERE company_id = $1
           AND direction = 'outbound'
           AND contact_id IS NULL
           AND on_timeline = false
           -- draft-safe: genuinely-sent emails carry a Message-ID header; a draft
           -- being composed has none. email_messages stores no label, so this is the
           -- discriminator that keeps drafts off the timeline on the poll/backfill path
           -- (the push path excludes drafts via labelIds ∩ {DRAFT}).
           AND message_id_header IS NOT NULL
           AND message_id_header <> ''
         ORDER BY gmail_internal_at DESC NULLS LAST, id DESC
         LIMIT $2`,
        [companyId, limit]
    );
    return result.rows;
}

/**
 * All currently-connected mailboxes (TASK-ET-4): drives the timeline-link poll
 * sibling scheduler — one `ingestPolledForCompany` per connected company.
 */
async function listConnectedMailboxes() {
    const result = await db.query(
        `SELECT id, company_id, provider, email_address, status
         FROM email_mailboxes
         WHERE status = 'connected'
         ORDER BY company_id`
    );
    return result.rows;
}

/**
 * §6 projection: a contact's timeline email, oldest→newest. Tenant + contact
 * scoped, only rows already projected (`on_timeline = true`). Shaped for
 * buildTimeline (the FE fuses + sorts heterogeneous sources client-side).
 */
async function getTimelineEmailByContact(companyId, contactId, { limit } = {}) {
    const params = [companyId, contactId];
    let limitClause = '';
    if (limit != null) {
        params.push(limit);
        limitClause = ` LIMIT $${params.length}`;
    }
    const result = await db.query(
        `SELECT id, thread_id, provider_thread_id, direction, from_name, from_email,
                to_recipients_json, subject, body_text, body_html, snippet, gmail_internal_at,
                sent_by_user_email,
                (direction = 'outbound') AS is_outbound
         FROM email_messages
         WHERE company_id = $1 AND contact_id = $2 AND on_timeline = true
         ORDER BY gmail_internal_at ASC, id ASC${limitClause}`,
        params
    );
    return result.rows;
}

/**
 * YELP-TIMELINE-DEDUP-001: a CONTACTLESS timeline's email, oldest→newest. Mirror of
 * getTimelineEmailByContact but keyed on `timeline_id` (contact_id is NULL for a
 * Yelp conv-id timeline). Tenant + timeline scoped, only projected rows
 * (`on_timeline = true`), served by idx_email_messages_timeline (mig 165). Same row
 * shape as getTimelineEmailByContact so buildTimeline projects both identically.
 */
async function getTimelineEmailByTimeline(companyId, timelineId, { limit } = {}) {
    const params = [companyId, timelineId];
    let limitClause = '';
    if (limit != null) {
        params.push(limit);
        limitClause = ` LIMIT $${params.length}`;
    }
    const result = await db.query(
        `SELECT id, thread_id, provider_thread_id, direction, from_name, from_email,
                to_recipients_json, subject, body_text, body_html, snippet, gmail_internal_at,
                sent_by_user_email,
                (direction = 'outbound') AS is_outbound
         FROM email_messages
         WHERE company_id = $1 AND timeline_id = $2 AND on_timeline = true
         ORDER BY gmail_internal_at ASC, id ASC${limitClause}`,
        params
    );
    return result.rows;
}

/**
 * A contact's timeline email, newest-first and bounded for reverse pagination.
 * cursorPred is produced by timelinePage.predicateModeFor('email', cursor) and
 * has the shape `{ mode: 'lt'|'lte'|'tuple', ts, id }`.
 */
async function getTimelineEmailPageByContact(companyId, contactId, { limit, cursorPred } = {}) {
    const params = [companyId, contactId];
    let cursorClause = '';
    if (cursorPred?.mode === 'tuple') {
        params.push(cursorPred.ts, cursorPred.id);
        cursorClause = `AND (COALESCE(gmail_internal_at, created_at), id) < ($3::timestamptz, $4::bigint)`;
    } else if (cursorPred) {
        params.push(cursorPred.ts);
        const operator = cursorPred.mode === 'lte' ? '<=' : '<';
        cursorClause = `AND COALESCE(gmail_internal_at, created_at) ${operator} $3::timestamptz`;
    }
    params.push(limit);

    const result = await db.query(
        `SELECT id, thread_id, provider_thread_id, direction, from_name, from_email,
                to_recipients_json, subject, body_text, body_html, snippet, gmail_internal_at,
                sent_by_user_email,
                (direction = 'outbound') AS is_outbound,
                to_char(COALESCE(gmail_internal_at, created_at) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
         FROM email_messages
         WHERE company_id = $1 AND contact_id = $2 AND on_timeline = true
           ${cursorClause}
         ORDER BY COALESCE(gmail_internal_at, created_at) DESC, id DESC
         LIMIT $${params.length}`,
        params
    );
    return result.rows;
}

/**
 * A contactless timeline's email, newest-first and bounded for reverse
 * pagination. cursorPred has the same predicateModeFor('email', cursor)
 * contract as getTimelineEmailPageByContact.
 */
async function getTimelineEmailPageByTimeline(companyId, timelineId, { limit, cursorPred } = {}) {
    const params = [companyId, timelineId];
    let cursorClause = '';
    if (cursorPred?.mode === 'tuple') {
        params.push(cursorPred.ts, cursorPred.id);
        cursorClause = `AND (COALESCE(gmail_internal_at, created_at), id) < ($3::timestamptz, $4::bigint)`;
    } else if (cursorPred) {
        params.push(cursorPred.ts);
        const operator = cursorPred.mode === 'lte' ? '<=' : '<';
        cursorClause = `AND COALESCE(gmail_internal_at, created_at) ${operator} $3::timestamptz`;
    }
    params.push(limit);

    const result = await db.query(
        `SELECT id, thread_id, provider_thread_id, direction, from_name, from_email,
                to_recipients_json, subject, body_text, body_html, snippet, gmail_internal_at,
                sent_by_user_email,
                (direction = 'outbound') AS is_outbound,
                to_char(COALESCE(gmail_internal_at, created_at) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
         FROM email_messages
         WHERE company_id = $1 AND timeline_id = $2 AND on_timeline = true
           ${cursorClause}
         ORDER BY COALESCE(gmail_internal_at, created_at) DESC, id DESC
         LIMIT $${params.length}`,
        params
    );
    return result.rows;
}

/**
 * Newest email thread (local `email_messages.thread_id`) linked to the contact,
 * any direction, on or off timeline — drives the outbound reply-vs-initiate
 * decision (§5/TASK-ET-8). Returns the thread_id (BIGINT) or null when the
 * contact has no prior email thread (→ initiate a new thread).
 */
async function getNewestThreadIdForContact(companyId, contactId) {
    const result = await db.query(
        `SELECT thread_id
         FROM email_messages
         WHERE company_id = $1 AND contact_id = $2
         ORDER BY gmail_internal_at DESC NULLS LAST, id DESC
         LIMIT 1`,
        [companyId, contactId]
    );
    return result.rows[0] ? result.rows[0].thread_id : null;
}

/**
 * Resolve the mailbox (+ its company_id) by the mailbox's connected address — for
 * push-payload → company/tenant resolution (the Pub/Sub `emailAddress`). Returns
 * the mailbox row or null when no mailbox matches that address.
 */
async function getMailboxByEmail(emailAddress) {
    // Defense-in-depth: the uniq_email_mailboxes_address index (migration 130)
    // guarantees at most one row per lower(email_address), but a tenant-resolution
    // query must NEVER rely on arbitrary row order — pin it deterministically so a
    // (theoretical) duplicate resolves to the most-recently-updated mailbox, not a
    // random tenant.
    const result = await db.query(
        `SELECT * FROM email_mailboxes
         WHERE lower(email_address) = lower($1)
         ORDER BY updated_at DESC NULLS LAST, id ASC
         LIMIT 1`,
        [emailAddress]
    );
    return result.rows[0] || null;
}

/**
 * Persist the Gmail watch cursor + expiry on connect / renewal (§4). Company-scoped.
 * Returns the updated mailbox row or null.
 */
async function updateWatchState(companyId, { history_id, expires_at } = {}) {
    const result = await db.query(
        `UPDATE email_mailboxes SET
            watch_history_id = $2,
            watch_expires_at = $3,
            updated_at = now()
         WHERE company_id = $1
         RETURNING *`,
        [companyId, history_id, expires_at]
    );
    return result.rows[0] || null;
}

/**
 * Clear the Gmail watch columns on disconnect / stopWatch (§4). Company-scoped.
 */
async function clearWatchState(companyId) {
    const result = await db.query(
        `UPDATE email_mailboxes SET
            watch_history_id = NULL,
            watch_expires_at = NULL,
            updated_at = now()
         WHERE company_id = $1
         RETURNING *`,
        [companyId]
    );
    return result.rows[0] || null;
}

/**
 * Connected mailboxes whose Gmail watch needs re-arming: `watch_expires_at` is
 * NULL or within 48h of `beforeTs` (default: now + 48h). Drives the 12h renewal
 * scheduler (§4). Soonest-to-expire first.
 */
async function listMailboxesForWatchRenewal(beforeTs = null) {
    const params = [];
    let threshold = `now() + interval '48 hours'`;
    if (beforeTs != null) {
        params.push(beforeTs);
        threshold = `$1`;
    }
    const result = await db.query(
        `SELECT id, company_id, provider, email_address, status,
                watch_history_id, watch_expires_at
         FROM email_mailboxes
         WHERE status = 'connected'
           AND (watch_expires_at IS NULL OR watch_expires_at <= ${threshold})
         ORDER BY watch_expires_at ASC NULLS FIRST`,
        params
    );
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
    isMailboxDue,
    // EMAIL-TIMELINE-001: email ↔ contact ↔ timeline link
    findEmailContact,
    linkMessageToContact,
    listMessageIdsForAddress, // CONTACT-EMAIL-MERGE-001
    getMessageLinkState,
    getThreadingByProviderMessageId, // YELP reply-threading (In-Reply-To/References + Gmail thread)
    listYelpConversationHistory,
    listUnlinkedInboundForTimeline,
    listUnlinkedOutboundForTimeline,
    listConnectedMailboxes,
    getTimelineEmailByContact,
    getTimelineEmailByTimeline, // YELP-TIMELINE-DEDUP-001
    getTimelineEmailPageByContact,
    getTimelineEmailPageByTimeline,
    getNewestThreadIdForContact,
    getMailboxByEmail,
    updateWatchState,
    clearWatchState,
    listMailboxesForWatchRenewal,
};
