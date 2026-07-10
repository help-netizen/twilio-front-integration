/**
 * GmailProvider — the Gmail concrete `MailProvider` (EMAIL-TIMELINE-001).
 *
 * A THIN adapter. It does NOT re-implement OAuth/token/refresh, MIME building,
 * history walking, or message parsing — it delegates every one of those to the
 * existing EMAIL-001 services:
 *   - connection status / access token → `emailMailboxService`
 *   - normalized history pull           → `emailSyncService.pullChangesNormalized`
 *   - send / reply (MIME + hydrate)     → `emailService`
 *   - watch cursor/expiry persistence   → `emailQueries.{updateWatchState,clearWatchState}`
 *   - push tenant resolution            → `emailQueries.getMailboxByEmail`
 *
 * `googleapis` is imported here for the ONE thing EMAIL-001 doesn't already do:
 * the Gmail `users.watch` / `users.stop` push registration (architecture: the
 * provider layer is the only place allowed to import `googleapis`).
 *
 * Safe-fail: all methods except `sendMessage` catch provider errors, log with
 * `companyId`, and return empty/`null` so the push route and poll tick never crash.
 * `sendMessage` is the one method allowed to throw (it surfaces send failures to
 * an authed request — e.g. EMAIL-001's `reconnect_required` 409, unchanged).
 */
const { google } = require('googleapis');
const emailMailboxService = require('../emailMailboxService');
const emailSyncService = require('../emailSyncService');
const emailService = require('../emailService');
const emailQueries = require('../../db/emailQueries');
const MailProvider = require('./MailProvider');

const GMAIL_PUBSUB_TOPIC = process.env.GMAIL_PUBSUB_TOPIC;

class GmailProvider extends MailProvider {
    /**
     * Build an authed Gmail client from a valid (auto-refreshed) access token.
     * Reuses `emailMailboxService`'s OAuth client factory + token logic.
     */
    async _gmailClient(companyId) {
        const accessToken = await emailMailboxService.getValidAccessToken(companyId);
        const oauth2 = emailMailboxService.createOAuth2Client();
        oauth2.setCredentials({ access_token: accessToken });
        return google.gmail({ version: 'v1', auth: oauth2 });
    }

    /** @inheritdoc */
    async getConnectionStatus(companyId) {
        try {
            const mailbox = await emailMailboxService.getMailboxStatus(companyId);
            if (!mailbox) {
                return { connected: false, status: null, email_address: null };
            }
            return {
                connected: mailbox.status === 'connected',
                status: mailbox.status,
                email_address: mailbox.email_address || null,
            };
        } catch (err) {
            console.error(`[GmailProvider] getConnectionStatus failed for company ${companyId}:`, err.message);
            return { connected: false, status: null, email_address: null };
        }
    }

    /**
     * Register the Gmail push watch on INBOX and persist cursor + expiry.
     * Idempotent re-arm: calling twice overwrites the stored cursor/expiry.
     * @inheritdoc
     */
    async startWatch(companyId) {
        try {
            if (!GMAIL_PUBSUB_TOPIC) {
                console.error(`[GmailProvider] startWatch: GMAIL_PUBSUB_TOPIC not configured (company ${companyId})`);
                return null;
            }
            const gmail = await this._gmailClient(companyId);
            const res = await gmail.users.watch({
                userId: 'me',
                requestBody: {
                    topicName: GMAIL_PUBSUB_TOPIC,
                    labelIds: ['INBOX'],
                    labelFilterAction: 'include',
                },
            });

            const historyId = res.data.historyId != null ? String(res.data.historyId) : null;
            // Gmail returns `expiration` as ms-since-epoch (string).
            const expiresAt = res.data.expiration
                ? new Date(parseInt(res.data.expiration, 10))
                : null;

            await emailQueries.updateWatchState(companyId, {
                history_id: historyId,
                expires_at: expiresAt,
            });

            return {
                history_id: historyId,
                expires_at: expiresAt ? expiresAt.toISOString() : null,
            };
        } catch (err) {
            console.error(`[GmailProvider] startWatch failed for company ${companyId}:`, err.message);
            return null;
        }
    }

    /** Gmail `users.watch` is an idempotent re-arm — renew is identical to start. @inheritdoc */
    async renewWatch(companyId) {
        return this.startWatch(companyId);
    }

    /** Tear down the Gmail watch and clear the persisted cursor/expiry. Safe-fail. @inheritdoc */
    async stopWatch(companyId) {
        try {
            const gmail = await this._gmailClient(companyId);
            await gmail.users.stop({ userId: 'me' });
        } catch (err) {
            // Already stopped / disconnected is not an error worth surfacing.
            console.error(`[GmailProvider] stopWatch (users.stop) for company ${companyId}:`, err.message);
        }
        try {
            await emailQueries.clearWatchState(companyId);
        } catch (err) {
            console.error(`[GmailProvider] stopWatch (clearWatchState) for company ${companyId}:`, err.message);
        }
    }

    /**
     * Decode-only: base64-decode the Pub/Sub `message.data` → `{emailAddress, historyId}`,
     * resolve the company/mailbox by address. Verification (token/OIDC) is the route's job.
     * @inheritdoc
     */
    async handlePushNotification(payload) {
        try {
            const data = payload?.message?.data;
            if (!data) return null;

            const decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
            const { emailAddress, historyId } = decoded || {};
            if (!emailAddress) return null;

            const mailbox = await emailQueries.getMailboxByEmail(emailAddress);
            if (!mailbox) return null; // unknown / foreign mailbox → route still fast-acks 200

            // Do NOT seed the pull from the push's historyId. Gmail's push carries the
            // mailbox's CURRENT historyId, which already INCLUDES the triggering message;
            // gmail.users.history.list({startHistoryId: thatId}) returns only changes
            // strictly AFTER it → empty for a single new email. Returning cursor:null makes
            // the downstream emailSyncService.pullChangesNormalized(companyId, null) fall
            // back to the mailbox's STORED history_id (the poll-maintained past checkpoint)
            // and correctly pull the new message. (Google's guidance: always list from your
            // own stored last-synced historyId, never the notification's.)
            return {
                companyId: mailbox.company_id,
                cursor: null,
            };
        } catch (err) {
            console.error('[GmailProvider] handlePushNotification decode failed:', err.message);
            return null;
        }
    }

    /**
     * Normalized history pull — delegates to the additive
     * `emailSyncService.pullChangesNormalized` (which also runs `importGmailThread`
     * so the inbox stays populated, and self-heals a history gap via backfill).
     * Safe-fail: returns `{messages:[], cursor:sinceCursor}` on error so the caller
     * fast-acks and the poll reconciles.
     * @inheritdoc
     */
    async pullChanges(companyId, sinceCursor) {
        try {
            return await emailSyncService.pullChangesNormalized(companyId, sinceCursor);
        } catch (err) {
            console.error(`[GmailProvider] pullChanges failed for company ${companyId}:`, err.message);
            return { messages: [], cursor: sinceCursor };
        }
    }

    /**
     * Send via EMAIL-001: reply when a `providerThreadId` (or `inReplyTo`) is
     * present, else initiate a new thread. NOT safe-fail — lets EMAIL-001 errors
     * (e.g. `reconnect_required` with `error.statusCode = 409`) propagate to the
     * authed route. v1 sends no `files`.
     * @inheritdoc
     */
    async sendMessage(companyId, { to, subject, body, inReplyTo, references, providerThreadId, userId, userEmail } = {}) {
        if (providerThreadId || inReplyTo) {
            const res = await emailService.replyToThread(companyId, providerThreadId, {
                to,
                subject,
                body,
                userId,
                userEmail,
            });
            return {
                provider_message_id: res.provider_message_id,
                provider_thread_id: res.provider_thread_id,
            };
        }

        const res = await emailService.sendEmail(companyId, {
            to,
            subject,
            body,
            userId,
            userEmail,
        });
        return {
            provider_message_id: res.provider_message_id,
            provider_thread_id: res.provider_thread_id,
        };
    }
}

module.exports = GmailProvider;
