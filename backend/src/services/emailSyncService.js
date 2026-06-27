/**
 * Email Sync Service (EMAIL-001)
 *
 * Initial backfill, incremental history sync via Gmail API,
 * and interval-based scheduler.
 */
const { google } = require('googleapis');
const emailQueries = require('../db/emailQueries');
const emailMailboxService = require('./emailMailboxService');

const SYNC_INTERVAL_MS = parseInt(process.env.EMAIL_SYNC_INTERVAL_MS || '300000', 10); // 5 min
const SYNC_LOOKBACK_DAYS = parseInt(process.env.EMAIL_SYNC_LOOKBACK_DAYS || '30', 10);
const MAX_THREADS_PER_SYNC = 100;

let schedulerTimer = null;

// ─── Gmail client factory ────────────────────────────────────────────────

function createGmailClient(accessToken) {
    const oauth2 = emailMailboxService.createOAuth2Client();
    oauth2.setCredentials({ access_token: accessToken });
    return google.gmail({ version: 'v1', auth: oauth2 });
}

// ─── Message parsing ─────────────────────────────────────────────────────

function parseGmailHeaders(headers) {
    const get = (name) => {
        const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
        return h ? h.value : null;
    };
    return {
        subject: get('Subject'),
        from: get('From'),
        to: get('To'),
        cc: get('Cc'),
        message_id: get('Message-ID') || get('Message-Id'),
        in_reply_to: get('In-Reply-To'),
        references: get('References'),
        date: get('Date'),
    };
}

function parseEmailAddress(raw) {
    if (!raw) return { name: null, email: null };
    const match = raw.match(/^(?:"?([^"]*)"?\s)?<?([^\s>]+@[^\s>]+)>?$/);
    if (match) return { name: match[1]?.trim() || null, email: match[2] };
    return { name: null, email: raw.trim() };
}

function parseRecipientList(raw) {
    if (!raw) return [];
    return raw.split(',').map(r => parseEmailAddress(r.trim())).filter(r => r.email);
}

function extractBody(payload) {
    let text = null;
    let html = null;

    function walk(part) {
        if (!part) return;
        const mime = part.mimeType || '';
        if (mime === 'text/plain' && part.body?.data && !text) {
            text = Buffer.from(part.body.data, 'base64url').toString('utf8');
        } else if (mime === 'text/html' && part.body?.data && !html) {
            html = Buffer.from(part.body.data, 'base64url').toString('utf8');
        }
        if (part.parts) part.parts.forEach(walk);
    }

    walk(payload);
    return { text, html };
}

function extractAttachments(payload, messageId) {
    const attachments = [];
    let order = 0;

    function walk(part) {
        if (!part) return;
        if (part.filename && part.body) {
            attachments.push({
                provider_attachment_id: part.body.attachmentId || null,
                part_id: part.partId || null,
                file_name: part.filename,
                content_type: part.mimeType,
                file_size: part.body.size || 0,
                is_inline: !!(part.headers || []).find(h =>
                    h.name.toLowerCase() === 'content-disposition' && h.value.includes('inline')),
                content_id: (part.headers || []).find(h =>
                    h.name.toLowerCase() === 'content-id')?.value?.replace(/[<>]/g, '') || null,
                sort_order: order++,
            });
        }
        if (part.parts) part.parts.forEach(walk);
    }

    walk(payload);
    return attachments;
}

// ─── Thread sync logic ───────────────────────────────────────────────────

async function importGmailThread(gmail, threadId, companyId, mailboxId, mailboxEmail) {
    const threadRes = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
    });

    const gmailThread = threadRes.data;
    const messages = gmailThread.messages || [];
    if (messages.length === 0) return null;

    // Collect all participants
    const participantSet = new Map();
    let lastMsg = null;
    let hasAttachments = false;
    let unreadCount = 0;

    for (const msg of messages) {
        const headers = parseGmailHeaders(msg.payload?.headers || []);
        const from = parseEmailAddress(headers.from);
        const toList = parseRecipientList(headers.to);
        const ccList = parseRecipientList(headers.cc);

        if (from.email) participantSet.set(from.email, from);
        toList.forEach(r => { if (r.email) participantSet.set(r.email, r); });
        ccList.forEach(r => { if (r.email) participantSet.set(r.email, r); });

        const isUnread = (msg.labelIds || []).includes('UNREAD');
        if (isUnread) unreadCount++;

        const msgAttachments = extractAttachments(msg.payload, msg.id);
        if (msgAttachments.length > 0) hasAttachments = true;

        lastMsg = { msg, headers, from, toList, ccList, msgAttachments };
    }

    // Determine direction based on mailbox email
    function getDirection(fromEmail) {
        return fromEmail?.toLowerCase() === mailboxEmail?.toLowerCase() ? 'outbound' : 'inbound';
    }

    const lastHeaders = lastMsg.headers;
    const lastFrom = lastMsg.from;
    const lastDirection = getDirection(lastFrom.email);

    // Upsert thread
    const thread = await emailQueries.upsertThread({
        company_id: companyId,
        mailbox_id: mailboxId,
        provider_thread_id: threadId,
        subject: lastHeaders.subject,
        participants_json: Array.from(participantSet.values()),
        last_message_at: lastMsg.msg.internalDate ? new Date(parseInt(lastMsg.msg.internalDate)) : new Date(),
        last_message_preview: messages[messages.length - 1].snippet || '',
        last_message_direction: lastDirection,
        last_message_from: lastFrom.name || lastFrom.email,
        unread_count: unreadCount,
        has_attachments: hasAttachments,
        message_count: messages.length,
    });

    // Upsert messages
    for (const msg of messages) {
        const headers = parseGmailHeaders(msg.payload?.headers || []);
        const from = parseEmailAddress(headers.from);
        const toList = parseRecipientList(headers.to);
        const ccList = parseRecipientList(headers.cc);
        const { text, html } = extractBody(msg.payload);
        const msgAttachments = extractAttachments(msg.payload, msg.id);

        const dbMsg = await emailQueries.upsertMessage({
            company_id: companyId,
            mailbox_id: mailboxId,
            thread_id: thread.id,
            provider_message_id: msg.id,
            provider_thread_id: threadId,
            message_id_header: headers.message_id,
            in_reply_to_header: headers.in_reply_to,
            references_header: headers.references,
            direction: getDirection(from.email),
            from_name: from.name,
            from_email: from.email,
            to_recipients_json: toList,
            cc_recipients_json: ccList,
            subject: headers.subject,
            snippet: msg.snippet,
            body_text: text,
            body_html: html,
            has_attachments: msgAttachments.length > 0,
            gmail_internal_at: msg.internalDate ? new Date(parseInt(msg.internalDate)) : null,
        });

        // Upsert attachments
        if (msgAttachments.length > 0) {
            await emailQueries.upsertAttachments(dbMsg.id, companyId, msgAttachments);
        }
    }

    return thread;
}

// ─── Backfill ────────────────────────────────────────────────────────────

async function runInitialBackfill(companyId) {
    console.log(`[EmailSync] Starting initial backfill for company ${companyId}`);

    const accessToken = await emailMailboxService.getValidAccessToken(companyId);
    const mailboxData = await emailQueries.getMailboxWithTokens(companyId);
    const gmail = createGmailClient(accessToken);

    const after = new Date();
    after.setDate(after.getDate() - SYNC_LOOKBACK_DAYS);
    const afterEpoch = Math.floor(after.getTime() / 1000);

    let pageToken = null;
    let imported = 0;

    do {
        const listRes = await gmail.users.threads.list({
            userId: 'me',
            maxResults: MAX_THREADS_PER_SYNC,
            q: `after:${afterEpoch}`,
            pageToken,
        });

        const threadIds = (listRes.data.threads || []).map(t => t.id);

        for (const tid of threadIds) {
            try {
                await importGmailThread(gmail, tid, companyId, mailboxData.id, mailboxData.email_address);
                imported++;
            } catch (err) {
                console.error(`[EmailSync] Failed to import thread ${tid}:`, err.message);
            }
        }

        pageToken = listRes.data.nextPageToken;
    } while (pageToken && imported < MAX_THREADS_PER_SYNC * 5);

    // Update sync state
    await emailQueries.upsertSyncState({
        mailbox_id: mailboxData.id,
        company_id: companyId,
        initial_backfill_completed_at: new Date().toISOString(),
        last_sync_finished_at: new Date().toISOString(),
    });

    // Update mailbox
    const profile = await emailMailboxService.getGmailProfile(accessToken);
    await emailQueries.updateMailboxStatus(mailboxData.id, {
        last_synced_at: new Date().toISOString(),
        last_sync_status: 'ok',
        last_sync_error: null,
        history_id: profile.history_id,
    });

    console.log(`[EmailSync] Backfill complete for company ${companyId}: ${imported} threads`);
    return imported;
}

// ─── Incremental sync ────────────────────────────────────────────────────

async function syncIncrementalHistory(companyId) {
    const accessToken = await emailMailboxService.getValidAccessToken(companyId);
    const mailboxData = await emailQueries.getMailboxWithTokens(companyId);
    const syncState = await emailQueries.getSyncState(mailboxData.id);

    if (!syncState?.initial_backfill_completed_at) {
        return runInitialBackfill(companyId);
    }

    const startHistoryId = syncState.last_history_id || mailboxData.history_id;
    if (!startHistoryId) {
        console.log(`[EmailSync] No history checkpoint, falling back to backfill for company ${companyId}`);
        return runInitialBackfill(companyId);
    }

    const gmail = createGmailClient(accessToken);

    // Mark sync started
    await emailQueries.upsertSyncState({
        mailbox_id: mailboxData.id,
        company_id: companyId,
        last_sync_started_at: new Date().toISOString(),
    });

    try {
        let pageToken = null;
        const affectedThreadIds = new Set();

        do {
            const historyRes = await gmail.users.history.list({
                userId: 'me',
                startHistoryId: startHistoryId,
                historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
                pageToken,
            });

            const histories = historyRes.data.history || [];
            for (const h of histories) {
                const msgs = [
                    ...(h.messagesAdded || []).map(m => m.message),
                    ...(h.messagesDeleted || []).map(m => m.message),
                    ...(h.labelsAdded || []).map(m => m.message),
                    ...(h.labelsRemoved || []).map(m => m.message),
                ];
                for (const m of msgs) {
                    if (m.threadId) affectedThreadIds.add(m.threadId);
                }
            }

            pageToken = historyRes.data.nextPageToken;
        } while (pageToken);

        // Re-import affected threads
        let synced = 0;
        for (const tid of affectedThreadIds) {
            try {
                await importGmailThread(gmail, tid, companyId, mailboxData.id, mailboxData.email_address);
                synced++;
            } catch (err) {
                console.error(`[EmailSync] Failed to sync thread ${tid}:`, err.message);
            }
        }

        // Update checkpoint
        const profile = await emailMailboxService.getGmailProfile(accessToken);
        await emailQueries.upsertSyncState({
            mailbox_id: mailboxData.id,
            company_id: companyId,
            last_history_id: profile.history_id,
            last_sync_finished_at: new Date().toISOString(),
            last_sync_error: null,
        });
        await emailQueries.updateMailboxStatus(mailboxData.id, {
            last_synced_at: new Date().toISOString(),
            last_sync_status: 'ok',
            last_sync_error: null,
            history_id: profile.history_id,
        });

        console.log(`[EmailSync] Incremental sync: ${synced} threads updated for company ${companyId}`);
        return synced;
    } catch (err) {
        // History ID invalid — fall back to backfill
        if (err.code === 404 || err.message?.includes('historyId')) {
            console.warn(`[EmailSync] History gap detected, running backfill for company ${companyId}`);
            return runInitialBackfill(companyId);
        }

        await emailQueries.upsertSyncState({
            mailbox_id: mailboxData.id,
            company_id: companyId,
            last_sync_finished_at: new Date().toISOString(),
            last_sync_error: err.message,
        });
        await emailQueries.updateMailboxStatus(mailboxData.id, {
            last_sync_status: 'error',
            last_sync_error: err.message,
        });
        throw err;
    }
}

// ─── Normalized pull (EMAIL-TIMELINE-001, additive) ──────────────────────
//
// `pullChangesNormalized` is the timeline-path sibling of `syncIncrementalHistory`.
// It walks the SAME history.list and runs the SAME `importGmailThread` hydration
// (so the standalone inbox stays populated), but additionally yields a per-message
// provider-neutral `NormalizedInboundMessage[]` for the timeline layer + the new
// cursor to persist. It deliberately does NOT touch `email_sync_state` / the
// inbox-facing checkpoint — that remains owned by `syncIncrementalHistory`.
// See `mail/MailProvider.js` for the `NormalizedInboundMessage` typedef.

/**
 * Map a single Gmail message resource (format:'full') to a NormalizedInboundMessage,
 * reusing the existing EMAIL-001 header/body parsers. `mailboxEmail` drives the
 * outbound determination (from === mailbox address → outbound).
 */
function normalizeGmailMessage(msg, mailboxEmail) {
    const headers = parseGmailHeaders(msg.payload?.headers || []);
    const from = parseEmailAddress(headers.from);
    const toList = parseRecipientList(headers.to);
    const { text, html } = extractBody(msg.payload);
    const internalMs = msg.internalDate ? parseInt(msg.internalDate, 10) : null;
    const isOutbound = !!from.email && !!mailboxEmail
        && from.email.toLowerCase() === mailboxEmail.toLowerCase();

    return {
        provider_message_id: msg.id,
        provider_thread_id: msg.threadId,
        message_id_header: headers.message_id,
        in_reply_to_header: headers.in_reply_to,
        references_header: headers.references,
        from_email: from.email,
        from_name: from.name,
        to: toList,
        subject: headers.subject,
        // plain text as stored; quote-stripping is a projection step applied later,
        // never here. Fall back to an empty string so the shape is always a string.
        body_text: text || '',
        snippet: msg.snippet || null,
        internal_at: internalMs != null ? new Date(internalMs).toISOString() : null,
        labelIds: msg.labelIds || [],
        is_outbound: isOutbound,
        // body_html is retained for the inbox via importGmailThread; surfaced here
        // only so the projection's HTML-only fallback can read it if body_text is empty.
        body_html: html || null,
    };
}

/**
 * Walk `users.history.list` from `sinceCursor`, hydrate affected threads via the
 * existing `importGmailThread` (inbox stays populated), and return a per-message
 * `NormalizedInboundMessage[]` for the timeline layer plus the new cursor.
 *
 * On a Gmail history-gap (404 / invalid historyId) it self-heals by running the
 * existing bounded backfill (`runInitialBackfill`) and returns the messages from
 * the backfill lookback window, normalized — so a gap lands on the timeline too.
 *
 * Additive: does NOT mutate `email_sync_state` or the inbox checkpoint.
 *
 * @param {string} companyId
 * @param {string} sinceCursor
 * @returns {Promise<{messages: import('./mail/MailProvider').NormalizedInboundMessage[], cursor: string}>}
 */
async function pullChangesNormalized(companyId, sinceCursor) {
    const accessToken = await emailMailboxService.getValidAccessToken(companyId);
    const mailboxData = await emailQueries.getMailboxWithTokens(companyId);
    const mailboxEmail = mailboxData?.email_address || null;
    const gmail = createGmailClient(accessToken);

    const startHistoryId = sinceCursor || mailboxData?.history_id;

    // No checkpoint to walk from → backfill window, normalized.
    if (!startHistoryId) {
        return backfillNormalized(companyId, gmail, mailboxData, mailboxEmail);
    }

    try {
        let pageToken = null;
        const affectedThreadIds = new Set();
        const affectedMessageIds = new Set();

        do {
            const historyRes = await gmail.users.history.list({
                userId: 'me',
                startHistoryId,
                historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
                pageToken,
            });

            const histories = historyRes.data.history || [];
            for (const h of histories) {
                const msgs = [
                    ...(h.messagesAdded || []).map(m => m.message),
                    ...(h.messagesDeleted || []).map(m => m.message),
                    ...(h.labelsAdded || []).map(m => m.message),
                    ...(h.labelsRemoved || []).map(m => m.message),
                ];
                for (const m of msgs) {
                    if (m.threadId) affectedThreadIds.add(m.threadId);
                    if (m.id) affectedMessageIds.add(m.id);
                }
            }

            pageToken = historyRes.data.nextPageToken;
        } while (pageToken);

        // Hydrate affected threads exactly as the inbox sync does (keeps inbox populated).
        for (const tid of affectedThreadIds) {
            try {
                await importGmailThread(gmail, tid, companyId, mailboxData.id, mailboxEmail);
            } catch (err) {
                console.error(`[EmailSync] pullChangesNormalized: thread ${tid} hydrate failed:`, err.message);
            }
        }

        // Fetch each affected message at full fidelity and normalize.
        const messages = [];
        for (const mid of affectedMessageIds) {
            try {
                const msgRes = await gmail.users.messages.get({ userId: 'me', id: mid, format: 'full' });
                messages.push(normalizeGmailMessage(msgRes.data, mailboxEmail));
            } catch (err) {
                // A message deleted between history + fetch is expected; skip it.
                console.error(`[EmailSync] pullChangesNormalized: message ${mid} fetch failed:`, err.message);
            }
        }

        const profile = await emailMailboxService.getGmailProfile(accessToken);
        return { messages, cursor: profile.history_id };
    } catch (err) {
        // History gap → self-heal via bounded backfill, returned normalized.
        if (err.code === 404 || err.message?.includes('historyId')) {
            console.warn(`[EmailSync] pullChangesNormalized: history gap for company ${companyId}, backfilling`);
            return backfillNormalized(companyId, gmail, mailboxData, mailboxEmail);
        }
        throw err;
    }
}

/**
 * Self-heal helper for pullChangesNormalized: re-import the lookback window
 * (reusing `runInitialBackfill` so the inbox stays populated), then list the
 * threads in that window and normalize their messages. Returns the fresh cursor.
 */
async function backfillNormalized(companyId, gmail, mailboxData, mailboxEmail) {
    await runInitialBackfill(companyId);

    const after = new Date();
    after.setDate(after.getDate() - SYNC_LOOKBACK_DAYS);
    const afterEpoch = Math.floor(after.getTime() / 1000);

    const messages = [];
    let pageToken = null;
    let pages = 0;

    do {
        const listRes = await gmail.users.threads.list({
            userId: 'me',
            maxResults: MAX_THREADS_PER_SYNC,
            q: `after:${afterEpoch}`,
            pageToken,
        });
        const threadIds = (listRes.data.threads || []).map(t => t.id);
        for (const tid of threadIds) {
            try {
                const threadRes = await gmail.users.threads.get({ userId: 'me', id: tid, format: 'full' });
                for (const msg of threadRes.data.messages || []) {
                    messages.push(normalizeGmailMessage(msg, mailboxEmail));
                }
            } catch (err) {
                console.error(`[EmailSync] backfillNormalized: thread ${tid} fetch failed:`, err.message);
            }
        }
        pageToken = listRes.data.nextPageToken;
        pages++;
    } while (pageToken && pages < 5);

    // Fresh cursor after backfill.
    let cursor = null;
    try {
        const accessToken = await emailMailboxService.getValidAccessToken(companyId);
        const profile = await emailMailboxService.getGmailProfile(accessToken);
        cursor = profile.history_id;
    } catch (err) {
        console.error(`[EmailSync] backfillNormalized: cursor refresh failed for company ${companyId}:`, err.message);
    }

    return { messages, cursor };
}

// ─── Public sync entry point ─────────────────────────────────────────────

async function syncMailbox(companyId) {
    try {
        return await syncIncrementalHistory(companyId);
    } catch (err) {
        console.error(`[EmailSync] syncMailbox error for company ${companyId}:`, err.message);
        return 0;
    }
}

// ─── Scheduler ───────────────────────────────────────────────────────────

async function runSchedulerTick() {
    try {
        const dueMailboxes = await emailQueries.listDueMailboxes(
            Math.floor(SYNC_INTERVAL_MS / 60000)
        );

        for (const mb of dueMailboxes) {
            try {
                await syncMailbox(mb.company_id);
            } catch (err) {
                console.error(`[EmailSync] Scheduler error for mailbox ${mb.mailbox_id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[EmailSync] Scheduler tick error:', err.message);
    }
}

function startScheduler() {
    if (schedulerTimer) return;
    console.log(`[EmailSync] Scheduler started, interval: ${SYNC_INTERVAL_MS}ms`);
    schedulerTimer = setInterval(runSchedulerTick, SYNC_INTERVAL_MS);
    // Don't block boot — first tick runs after interval
}

function stopScheduler() {
    if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
        console.log('[EmailSync] Scheduler stopped');
    }
}

module.exports = {
    // Poll cadence (default 5 min) — single source of truth; the EMAIL-TIMELINE-001
    // link poll in server.js reuses this so the two stay in lockstep.
    SYNC_INTERVAL_MS,
    syncMailbox,
    runInitialBackfill,
    syncIncrementalHistory,
    startScheduler,
    stopScheduler,
    // EMAIL-TIMELINE-001 (additive): normalized pull for the provider/timeline path
    pullChangesNormalized,
    // Exported for testing
    normalizeGmailMessage,
    importGmailThread,
    parseGmailHeaders,
    parseEmailAddress,
    parseRecipientList,
    extractBody,
    extractAttachments,
};
