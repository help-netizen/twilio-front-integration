/**
 * providerRegistry — resolves the `MailProvider` for a company's mailbox
 * (EMAIL-TIMELINE-001). This is the seam the timeline/exchange layer (ET-4/ET-8)
 * imports; that layer NEVER imports `googleapis` or the EMAIL-001 services directly.
 *
 * v1: every company maps to the single `GmailProvider` instance (the mailbox
 * `provider` column is already `'gmail'`-checked in migration 079). When a second
 * provider (e.g. IMAP) lands, branch here on `email_mailboxes.provider` — no caller
 * changes. `companyId` is accepted now so that future lookup is non-breaking.
 */
const GmailProvider = require('./GmailProvider');

// Stateless singleton — the provider holds no per-company state; everything is
// passed as `companyId` per call and delegated to the company-scoped EMAIL-001 services.
const gmailProvider = new GmailProvider();

/**
 * @param {string} [companyId] - reserved for future per-mailbox provider selection.
 * @returns {import('./MailProvider')} the provider bound to the company's mailbox (v1: Gmail).
 */
function get(companyId) {
    return gmailProvider;
}

module.exports = {
    get,
    // Alias — some call sites refer to it as getProvider.
    getProvider: get,
};
