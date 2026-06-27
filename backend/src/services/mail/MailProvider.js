/**
 * MailProvider — provider abstraction (the seam) for EMAIL-TIMELINE-001.
 *
 * This is the ONLY mail surface that the timeline/exchange layer
 * (`emailTimelineService`, `buildTimeline`) is allowed to depend on. That layer
 * imports the provider via `providerRegistry` and MUST NOT import `googleapis`,
 * `emailService`, `emailSyncService`, or `emailMailboxService` directly (AC-12).
 * All Gmail specifics live in `GmailProvider` + the EMAIL-001 services it delegates to.
 *
 * This base class is a documented "interface": every method throws
 * `not implemented` so a concrete provider must override it. `GmailProvider`
 * (and any future IMAP provider) `extends MailProvider`.
 *
 * ── Tenancy & safety contract ──────────────────────────────────────────────
 *  - Every method is tenant-scoped by `companyId`.
 *  - All methods EXCEPT `sendMessage` are **safe-fail**: they catch provider
 *    errors, log with `companyId`, and return empty/`null` so the push route and
 *    poll tick never crash (the poll reconciles later). `sendMessage` is the one
 *    method allowed to throw — it runs inside an authed request that must surface
 *    failures (e.g. `reconnect_required` → HTTP 409).
 *
 * ── `NormalizedInboundMessage` (provider-neutral) ──────────────────────────
 * The only message shape `emailTimelineService` consumes — no Gmail types leak up.
 *
 * @typedef {Object} NormalizedInboundMessage
 * @property {string}      provider_message_id  Provider message id (Gmail message id;
 *                                               unique with company_id per migration 079).
 * @property {string}      provider_thread_id   Provider thread id (Gmail thread id).
 * @property {string|null} message_id_header    RFC 5322 `Message-ID` header.
 * @property {string|null} in_reply_to_header   RFC `In-Reply-To` header (or null).
 * @property {string|null} references_header    RFC `References` header (or null).
 * @property {string}      from_email           Sender address (raw kept here; matching
 *                                               lower-cases it downstream).
 * @property {string|null} from_name            Sender display name (or null).
 * @property {Array<{name:(string|null),email:string}>} to  Recipient list.
 * @property {string|null} subject              Subject (or null).
 * @property {string}      body_text            Plain-text body as stored; quote-stripping
 *                                               is a projection step, NOT applied here.
 * @property {string|null} snippet              Provider snippet (or null).
 * @property {string}      internal_at          ISO-8601 (Gmail internalDate →
 *                                               email_messages.gmail_internal_at).
 * @property {string[]}    labelIds             e.g. ['INBOX'] / ['SENT'] / ['DRAFT'].
 * @property {boolean}     is_outbound          true when from === mailbox address
 *                                               (or direction computed outbound).
 */

/* eslint-disable no-unused-vars */
class MailProvider {
    /**
     * Connection status for the composer CTA (FR-UI-3) and the outbound send guard.
     * @param {string} companyId
     * @returns {Promise<{connected: boolean, status: (string|null), email_address: (string|null)}>}
     *   `status ∈ { 'connected','reconnect_required','disconnected','sync_error', null }`.
     *   Never throws for "no mailbox" — returns `{connected:false, status:null, email_address:null}`.
     */
    async getConnectionStatus(companyId) {
        throw new Error('MailProvider.getConnectionStatus not implemented');
    }

    /**
     * Register provider push for INBOX and persist the cursor + expiry to the mailbox.
     * Idempotent re-arm. Safe-fail.
     * @param {string} companyId
     * @returns {Promise<{history_id: string, expires_at: string}|null>}
     */
    async startWatch(companyId) {
        throw new Error('MailProvider.startWatch not implemented');
    }

    /**
     * Re-arm the watch before expiry (used by the renewal scheduler). Same as
     * `startWatch` for providers whose watch is an idempotent re-arm. Safe-fail.
     * @param {string} companyId
     * @returns {Promise<{history_id: string, expires_at: string}|null>}
     */
    async renewWatch(companyId) {
        throw new Error('MailProvider.renewWatch not implemented');
    }

    /**
     * Tear down the watch on disconnect; clears the persisted cursor/expiry. Safe-fail.
     * @param {string} companyId
     * @returns {Promise<void>}
     */
    async stopWatch(companyId) {
        throw new Error('MailProvider.stopWatch not implemented');
    }

    /**
     * **Decode only** — provider-specific verification (token/OIDC) is the route's
     * job (`email-push.js`), NOT here. Decodes a provider push envelope into a
     * tenant + cursor. Returns `null` (no throw) when the payload resolves to no
     * connected mailbox (the route still fast-acks 200).
     * @param {Object} payload  Provider push envelope (e.g. the Pub/Sub message).
     * @returns {Promise<{companyId: string, cursor: string}|null>}
     */
    async handlePushNotification(payload) {
        throw new Error('MailProvider.handlePushNotification not implemented');
    }

    /**
     * Run the provider's change walk since `sinceCursor` (and the existing thread
     * hydration so the inbox stays populated), returning a provider-neutral array
     * of the messages touched plus the new cursor to persist. Safe-fail.
     * @param {string} companyId
     * @param {string} sinceCursor
     * @returns {Promise<{messages: NormalizedInboundMessage[], cursor: string}>}
     */
    async pullChanges(companyId, sinceCursor) {
        throw new Error('MailProvider.pullChanges not implemented');
    }

    /**
     * Send a message. **Reply** when `providerThreadId` (the contact's most-recent
     * thread) is present; else **initiate** a new thread. This is the one method
     * allowed to throw (it surfaces send failures to an authed caller).
     * @param {string} companyId
     * @param {Object} opts
     * @param {string|string[]} opts.to
     * @param {string} [opts.subject]
     * @param {string} opts.body
     * @param {string} [opts.inReplyTo]
     * @param {string} [opts.references]
     * @param {string} [opts.providerThreadId]  Local thread id of the contact's most-recent thread.
     * @param {string} [opts.userId]
     * @param {string} [opts.userEmail]
     * @returns {Promise<{provider_message_id: string, provider_thread_id: string}>}
     */
    async sendMessage(companyId, opts) {
        throw new Error('MailProvider.sendMessage not implemented');
    }
}

module.exports = MailProvider;
