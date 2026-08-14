/**
 * EMAIL-DRAFT-INGEST-001 — dry-run-first classifier for historical Gmail draft
 * autosaves that polling persisted as outbound email_messages rows.
 */
const { google } = require('googleapis');
const emailQueries = require('../db/emailQueries');
const emailMailboxService = require('./emailMailboxService');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100000;
const REQUEST_DELAY_MS = 100;
const MAX_GMAIL_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 250;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function gmailStatus(error) {
    const value = error?.code ?? error?.response?.status;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
}

function gmailReasons(error) {
    const errors = error?.response?.data?.error?.errors;
    return Array.isArray(errors) ? errors.map(item => item?.reason).filter(Boolean) : [];
}

function isRetryableGmailError(error) {
    const status = gmailStatus(error);
    if ([429, 500, 502, 503, 504].includes(status)) return true;
    if (status !== 403) return false;
    return gmailReasons(error).some(reason =>
        ['rateLimitExceeded', 'userRateLimitExceeded', 'backendError'].includes(reason));
}

/**
 * Gmail 404 is the only positive classification. Every other provider failure is
 * fail-closed and returns status=error, never a draft candidate.
 */
async function classifyGmailMessage(gmail, providerMessageId, options = {}) {
    const maxAttempts = options.maxAttempts ?? MAX_GMAIL_ATTEMPTS;
    const baseBackoffMs = options.baseBackoffMs ?? BASE_BACKOFF_MS;
    const wait = options.sleep || sleep;
    const onRetry = options.onRetry || (() => {});

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await gmail.users.messages.get({
                userId: 'me',
                id: providerMessageId,
                format: 'minimal',
            });
            return { isDraftArtifact: false, status: 'exists', attempts: attempt };
        } catch (error) {
            if (gmailStatus(error) === 404) {
                return { isDraftArtifact: true, status: 'missing', attempts: attempt };
            }
            if (isRetryableGmailError(error) && attempt < maxAttempts) {
                const delayMs = baseBackoffMs * (2 ** (attempt - 1));
                onRetry({ attempt, delayMs, error });
                await wait(delayMs);
                continue;
            }
            return {
                isDraftArtifact: false,
                status: 'error',
                attempts: attempt,
                error: error?.message || String(error),
            };
        }
    }

    return { isDraftArtifact: false, status: 'error', attempts: maxAttempts, error: 'retry budget exhausted' };
}

function normalizeLimit(value) {
    const limit = Number(value ?? DEFAULT_LIMIT);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    }
    return limit;
}

function createGmailClient(accessToken) {
    const oauth2 = emailMailboxService.createOAuth2Client();
    oauth2.setCredentials({ access_token: accessToken });
    return google.gmail({ version: 'v1', auth: oauth2 });
}

async function pruneIngestedEmailDrafts(options, dependencies = {}) {
    const companyId = options?.companyId;
    if (!companyId) throw new Error('companyId is required');

    const dryRun = options.dryRun !== false;
    const limit = normalizeLimit(options.limit);
    const logger = dependencies.logger || console;
    const queries = dependencies.emailQueries || emailQueries;
    const mailboxService = dependencies.emailMailboxService || emailMailboxService;
    const wait = dependencies.sleep || sleep;

    const mailbox = await queries.getMailboxByCompany(companyId);
    if (!mailbox) throw new Error(`No Gmail mailbox found for company ${companyId}`);
    if (mailbox.status !== 'connected') {
        throw new Error(`Mailbox ${mailbox.id} is not connected (status: ${mailbox.status})`);
    }

    const accessToken = await mailboxService.getValidAccessToken(companyId);
    const gmail = dependencies.gmail || createGmailClient(accessToken);
    const rows = await queries.listOutboundDraftArtifactCandidates(
        companyId,
        mailbox.id,
        { limit }
    );

    const summary = {
        company_id: companyId,
        mailbox_id: mailbox.id,
        dry_run: dryRun,
        limit,
        scanned: 0,
        candidates: 0,
        marked: 0,
        exists: 0,
        errors: 0,
    };

    logger.log(`[EmailDraftPrune] company=${companyId} mailbox=${mailbox.id} mode=${dryRun ? 'dry-run' : 'apply'} rows=${rows.length}`);

    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const classification = await classifyGmailMessage(gmail, row.provider_message_id, {
            sleep: wait,
            onRetry: ({ attempt, delayMs }) => {
                logger.warn(`[EmailDraftPrune] retry row=${index + 1}/${rows.length} attempt=${attempt} delay_ms=${delayMs}`);
            },
        });
        summary.scanned += 1;

        if (classification.isDraftArtifact) {
            summary.candidates += 1;
            const gmailInternalAt = row.gmail_internal_at instanceof Date
                ? row.gmail_internal_at.toISOString()
                : (row.gmail_internal_at ?? 'null');
            logger.log(
                `[EmailDraftPrune] candidate row_id=${row.id} provider_message_id=${row.provider_message_id} gmail_internal_at=${gmailInternalAt} length(body_text)=${row.body_text_length ?? 'null'}`
            );
            if (!dryRun) {
                const marked = await queries.markDraftArtifact(
                    companyId,
                    mailbox.id,
                    row.provider_message_id
                );
                if (marked) summary.marked += 1;
            }
        } else if (classification.status === 'exists') {
            summary.exists += 1;
        } else {
            summary.errors += 1;
        }

        logger.log(
            `[EmailDraftPrune] progress=${index + 1}/${rows.length} status=${classification.status}`
        );
        if (index + 1 < rows.length && REQUEST_DELAY_MS > 0) {
            await wait(REQUEST_DELAY_MS);
        }
    }

    logger.log(`[EmailDraftPrune] complete scanned=${summary.scanned} candidates=${summary.candidates} marked=${summary.marked} exists=${summary.exists} errors=${summary.errors}`);
    return summary;
}

module.exports = {
    classifyGmailMessage,
    isRetryableGmailError,
    normalizeLimit,
    pruneIngestedEmailDrafts,
};
