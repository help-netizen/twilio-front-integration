/**
 * In-app product feedback — CLIENT-FEEDBACK-WIDGET-001.
 * Persistence is authoritative; developer email is strictly best-effort.
 */

const feedbackQueries = require('../db/feedbackQueries');
const emailService = require('./emailService');

const DEFAULT_SENDER_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const FEEDBACK_INBOX_EMAIL = process.env.FEEDBACK_INBOX_EMAIL || 'support@albusto.com';
const SENDER_COMPANY_ID = process.env.FEEDBACK_SENDER_COMPANY_ID || DEFAULT_SENDER_COMPANY_ID;

function positiveNumberFromEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MAX_FILES = Math.floor(positiveNumberFromEnv('FEEDBACK_MAX_FILES', 5));
const MAX_FILE_MB = positiveNumberFromEnv('FEEDBACK_MAX_FILE_MB', 10);
const MAX_FILE_SIZE = MAX_FILE_MB * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'text/plain',
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validationError(message) {
    return Object.assign(new Error(message), { status: 422 });
}

function validateFiles(files) {
    if (!Array.isArray(files)) throw validationError('Files must be an array');
    if (files.length > MAX_FILES) {
        throw validationError(`You can attach up to ${MAX_FILES} files`);
    }

    for (const file of files) {
        if (!ALLOWED_MIME_TYPES.has(file?.mimetype)) {
            throw validationError('Files must be PDF, PNG, JPG, GIF, WEBP, or TXT');
        }
        if (!Number.isFinite(file?.size) || file.size > MAX_FILE_SIZE) {
            throw validationError(`Each file must be ${MAX_FILE_MB} MB or smaller`);
        }
    }
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function buildEmail({ userEmail, message, attachments }) {
    const attachmentSummary = attachments.length > 0
        ? attachments.map(file => `${file.name} (${file.mime}, ${file.size} bytes)`).join('\n')
        : 'None';
    const textBody = [
        'New Albusto product feedback',
        '',
        `From: ${userEmail}`,
        '',
        message,
        '',
        'Attachments:',
        attachmentSummary,
    ].join('\n');
    const attachmentItems = attachments.length > 0
        ? `<ul>${attachments.map(file => (
            `<li>${escapeHtml(file.name)} (${escapeHtml(file.mime)}, ${file.size} bytes)</li>`
        )).join('')}</ul>`
        : '<p>None</p>';

    return {
        subject: `Albusto product feedback from ${userEmail}`,
        textBody,
        body: [
            '<h2>New Albusto product feedback</h2>',
            `<p><strong>From:</strong> ${escapeHtml(userEmail)}</p>`,
            `<p>${escapeHtml(message).replaceAll('\n', '<br>')}</p>`,
            '<p><strong>Attachments:</strong></p>',
            attachmentItems,
        ].join(''),
    };
}

async function submitFeedback({ companyId, userId, userEmail, message, files = [] }) {
    const normalizedEmail = typeof userEmail === 'string' ? userEmail.trim() : '';
    const normalizedMessage = typeof message === 'string' ? message.trim() : '';

    if (!EMAIL_RE.test(normalizedEmail)) throw validationError('Enter a valid email address');
    if (!normalizedMessage) throw validationError('Message is required');
    validateFiles(files);

    const meta = {
        attachments: files.map(file => ({
            name: file.originalname,
            size: file.size,
            mime: file.mimetype,
        })),
        // A durable pre-send state ensures a crash after INSERT never claims that
        // an email was sent. The best-effort status write below advances it.
        email_status: 'skipped',
    };
    const submission = await feedbackQueries.insertFeedback({
        companyId,
        userId: userId ?? null,
        userEmail: normalizedEmail,
        message: normalizedMessage,
        meta,
    });

    let emailStatus;
    try {
        const email = buildEmail({
            userEmail: normalizedEmail,
            message: normalizedMessage,
            attachments: meta.attachments,
        });
        await emailService.sendEmail(SENDER_COMPANY_ID, {
            to: FEEDBACK_INBOX_EMAIL,
            subject: email.subject,
            body: email.body,
            textBody: email.textBody,
            files,
        });
        emailStatus = 'sent';
    } catch (err) {
        emailStatus = 'failed';
        console.warn('[FeedbackService] Best-effort email failed:', err.message);
    }

    meta.email_status = emailStatus;
    try {
        await feedbackQueries.updateFeedbackEmailStatus({
            companyId,
            id: submission.id,
            emailStatus,
        });
    } catch (err) {
        console.warn('[FeedbackService] Failed to persist email status:', err.message);
    }

    return { ...submission, meta };
}

module.exports = {
    ALLOWED_MIME_TYPES,
    FEEDBACK_INBOX_EMAIL,
    MAX_FILES,
    MAX_FILE_MB,
    MAX_FILE_SIZE,
    SENDER_COMPANY_ID,
    submitFeedback,
};
