/**
 * Mail Secretary Gmail Fetch Service
 *
 * First pipeline stage for Mail Secretary. It reads Gmail messages on demand
 * using the connected tenant mailbox and returns transient Gmail payloads.
 * Persistent state should store Gmail ids, not raw message bodies.
 */
const { google } = require('googleapis');
const emailQueries = require('../db/emailQueries');
const emailMailboxService = require('./emailMailboxService');

const ALLOWED_FORMATS = new Set(['full', 'raw', 'metadata']);

class MailSecretaryGmailFetchError extends Error {
    constructor(message, code, httpStatus = 400) {
        super(message);
        this.name = 'MailSecretaryGmailFetchError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function createGmailClient(accessToken) {
    const oauth2 = emailMailboxService.createOAuth2Client();
    oauth2.setCredentials({ access_token: accessToken });
    return google.gmail({ version: 'v1', auth: oauth2 });
}

function validateFormat(format) {
    const normalized = String(format || 'full').toLowerCase();
    if (!ALLOWED_FORMATS.has(normalized)) {
        throw new MailSecretaryGmailFetchError(
            'Unsupported Gmail message format. Use full, raw, or metadata.',
            'INVALID_GMAIL_FORMAT',
            400
        );
    }
    return normalized;
}

async function getConnectedGmailMailbox(companyId) {
    const mailbox = await emailQueries.getMailboxByCompany(companyId);
    if (!mailbox || mailbox.provider !== 'gmail' || mailbox.status !== 'connected') {
        throw new MailSecretaryGmailFetchError(
            'Mail Secretary requires a connected Gmail mailbox.',
            'GMAIL_REQUIRED',
            409
        );
    }
    return mailbox;
}

function mapStorageRef({ mailbox, message }) {
    return {
        provider: 'gmail',
        mailbox_id: mailbox.id,
        gmail_message_id: message.id,
        gmail_thread_id: message.threadId || null,
        history_id: message.historyId || null,
        internal_date: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    };
}

function mapFetchedMessage({ mailbox, message, format }) {
    const base = {
        storage_ref: mapStorageRef({ mailbox, message }),
        gmail: {
            id: message.id,
            thread_id: message.threadId || null,
            label_ids: message.labelIds || [],
            snippet: message.snippet || '',
            history_id: message.historyId || null,
            internal_date: message.internalDate || null,
            size_estimate: message.sizeEstimate || null,
            format,
        },
    };

    if (format === 'raw') {
        return {
            ...base,
            raw_base64url: message.raw || null,
        };
    }

    return {
        ...base,
        payload: message.payload || null,
    };
}

async function fetchGmailMessage({ companyId, gmailMessageId, format = 'full', metadataHeaders = null }) {
    if (!companyId) {
        throw new MailSecretaryGmailFetchError('companyId is required.', 'COMPANY_REQUIRED', 400);
    }
    if (!gmailMessageId) {
        throw new MailSecretaryGmailFetchError('gmailMessageId is required.', 'GMAIL_MESSAGE_ID_REQUIRED', 400);
    }

    const normalizedFormat = validateFormat(format);
    const mailbox = await getConnectedGmailMailbox(companyId);
    const accessToken = await emailMailboxService.getValidAccessToken(companyId);
    const gmail = createGmailClient(accessToken);

    const params = {
        userId: 'me',
        id: gmailMessageId,
        format: normalizedFormat,
    };

    if (normalizedFormat === 'metadata' && Array.isArray(metadataHeaders) && metadataHeaders.length > 0) {
        params.metadataHeaders = metadataHeaders.map(String);
    }

    const res = await gmail.users.messages.get(params);
    return mapFetchedMessage({ mailbox, message: res.data || {}, format: normalizedFormat });
}

module.exports = {
    MailSecretaryGmailFetchError,
    fetchGmailMessage,
    getConnectedGmailMailbox,
    _validateFormat: validateFormat,
    _mapFetchedMessage: mapFetchedMessage,
};
