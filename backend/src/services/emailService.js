/**
 * Email Service (EMAIL-001)
 *
 * Gmail API client factory, raw MIME send/reply,
 * sent-message hydration, attachment streaming/download.
 */
const { google } = require('googleapis');
const db = require('../db/connection');
const emailQueries = require('../db/emailQueries');
const emailMailboxService = require('./emailMailboxService');
const { importGmailThread } = require('./emailSyncService');

// ─── Gmail client factory ────────────────────────────────────────────────

function createGmailClient(accessToken) {
    const oauth2 = emailMailboxService.createOAuth2Client();
    oauth2.setCredentials({ access_token: accessToken });
    return google.gmail({ version: 'v1', auth: oauth2 });
}

// ─── MIME helpers ────────────────────────────────────────────────────────

function buildMimeMessage({ from, to, cc, subject, body, inReplyTo, references, files }) {
    const boundary = `blanc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const hasAttachments = files && files.length > 0;
    const contentType = hasAttachments
        ? `multipart/mixed; boundary="${boundary}"`
        : 'text/html; charset=utf-8';

    const headers = [
        `From: ${from}`,
        `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    ];
    if (cc && cc.length > 0) headers.push(`Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}`);
    headers.push(`Subject: ${subject}`);
    headers.push(`MIME-Version: 1.0`);
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references}`);
    headers.push(`Content-Type: ${contentType}`);

    let message = headers.join('\r\n') + '\r\n\r\n';

    if (hasAttachments) {
        // Body part
        message += `--${boundary}\r\n`;
        message += `Content-Type: text/html; charset=utf-8\r\n\r\n`;
        message += body + '\r\n\r\n';

        // Attachment parts
        for (const file of files) {
            message += `--${boundary}\r\n`;
            message += `Content-Type: ${file.mimetype}; name="${file.originalname}"\r\n`;
            message += `Content-Disposition: attachment; filename="${file.originalname}"\r\n`;
            message += `Content-Transfer-Encoding: base64\r\n\r\n`;
            message += file.buffer.toString('base64') + '\r\n';
        }

        message += `--${boundary}--\r\n`;
    } else {
        message += body;
    }

    return Buffer.from(message).toString('base64url');
}

// ─── Send new email ──────────────────────────────────────────────────────

async function sendEmail(companyId, { to, cc, subject, body, files, userId, userEmail }) {
    const accessToken = await emailMailboxService.getValidAccessToken(companyId);
    const mailboxData = await emailQueries.getMailboxWithTokens(companyId);

    if (!mailboxData || mailboxData.status === 'disconnected') {
        throw new Error('Mailbox is not connected');
    }
    if (mailboxData.status === 'reconnect_required') {
        const error = new Error('Mailbox requires reconnection');
        error.statusCode = 409;
        throw error;
    }

    const gmail = createGmailClient(accessToken);
    const raw = buildMimeMessage({
        from: mailboxData.email_address,
        to,
        cc,
        subject,
        body,
        files,
    });

    const sendRes = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
    });

    const sentMessageId = sendRes.data.id;
    const sentThreadId = sendRes.data.threadId;

    // Hydrate the sent message locally and tag with sender identity
    try {
        await importGmailThread(gmail, sentThreadId, companyId, mailboxData.id, mailboxData.email_address);
        // Update sent_by fields on the hydrated message
        if (userId || userEmail) {
            await db.query(
                `UPDATE email_messages SET sent_by_user_id = $1, sent_by_user_email = $2, updated_at = now()
                 WHERE provider_message_id = $3 AND company_id = $4`,
                [userId || null, userEmail || null, sentMessageId, companyId]
            );
        }
    } catch (err) {
        console.error('[EmailService] Failed to hydrate sent thread:', err.message);
    }

    return {
        provider_message_id: sentMessageId,
        provider_thread_id: sentThreadId,
    };
}

// ─── Reply in existing thread ────────────────────────────────────────────

async function replyToThread(companyId, threadId, { to, cc, subject, body, files, userId, userEmail }) {
    const thread = await emailQueries.getThreadById(threadId, companyId);
    if (!thread) throw new Error('Thread not found');

    const accessToken = await emailMailboxService.getValidAccessToken(companyId);
    const mailboxData = await emailQueries.getMailboxWithTokens(companyId);

    if (!mailboxData || mailboxData.status === 'disconnected') {
        throw new Error('Mailbox is not connected');
    }
    if (mailboxData.status === 'reconnect_required') {
        const error = new Error('Mailbox requires reconnection');
        error.statusCode = 409;
        throw error;
    }

    // Get the last message in thread for reply headers
    const messages = await emailQueries.getMessagesByThread(threadId, companyId);
    const lastMessage = messages[messages.length - 1];

    const gmail = createGmailClient(accessToken);
    const raw = buildMimeMessage({
        from: mailboxData.email_address,
        to,
        cc,
        subject: subject || `Re: ${thread.subject || ''}`,
        body,
        files,
        inReplyTo: lastMessage?.message_id_header || null,
        references: lastMessage?.references_header
            ? `${lastMessage.references_header} ${lastMessage.message_id_header || ''}`
            : lastMessage?.message_id_header || null,
    });

    const sendRes = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId: thread.provider_thread_id },
    });

    const sentMessageId = sendRes.data.id;

    // Hydrate and tag with sender identity
    try {
        await importGmailThread(gmail, thread.provider_thread_id, companyId, mailboxData.id, mailboxData.email_address);
        if (userId || userEmail) {
            await db.query(
                `UPDATE email_messages SET sent_by_user_id = $1, sent_by_user_email = $2, updated_at = now()
                 WHERE provider_message_id = $3 AND company_id = $4`,
                [userId || null, userEmail || null, sentMessageId, companyId]
            );
        }
    } catch (err) {
        console.error('[EmailService] Failed to hydrate reply thread:', err.message);
    }

    return {
        provider_message_id: sentMessageId,
        provider_thread_id: thread.provider_thread_id,
        thread_id: threadId,
    };
}

// ─── Attachment download ─────────────────────────────────────────────────

async function getAttachmentStream(companyId, attachmentId) {
    const attachment = await emailQueries.getAttachmentById(attachmentId, companyId);
    if (!attachment) return null;

    const accessToken = await emailMailboxService.getValidAccessToken(companyId);
    const gmail = createGmailClient(accessToken);

    const res = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: attachment.provider_message_id,
        id: attachment.provider_attachment_id,
    });

    const data = Buffer.from(res.data.data, 'base64url');
    return {
        buffer: data,
        contentType: attachment.content_type,
        fileName: attachment.file_name,
        fileSize: attachment.file_size,
    };
}

module.exports = {
    sendEmail,
    replyToThread,
    getAttachmentStream,
    buildMimeMessage,
};
