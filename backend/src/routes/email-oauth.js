/**
 * Email OAuth Routes (EMAIL-001)
 *
 * /api/email/oauth — public Google OAuth callback
 *
 * This route is mounted WITHOUT auth middleware since Google redirects
 * the browser here after consent. Security relies on signed state param.
 */

const express = require('express');
const emailMailboxService = require('../services/emailMailboxService');
const providerRegistry = require('../services/mail/providerRegistry');

const router = express.Router();

const SETTINGS_URL = '/settings/integrations/google-email';

// ─── GET /api/email/oauth/google/callback ────────────────────────────────
router.get('/google/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    // Google returned an error
    if (oauthError) {
        console.error('[EmailOAuth] Google error:', oauthError);
        return res.redirect(`${SETTINGS_URL}?error=${encodeURIComponent(oauthError)}`);
    }

    if (!code || !state) {
        return res.redirect(`${SETTINGS_URL}?error=${encodeURIComponent('Missing OAuth parameters')}`);
    }

    // Validate signed state
    const statePayload = emailMailboxService.validateOAuthState(state);
    if (!statePayload) {
        console.error('[EmailOAuth] Invalid or expired state parameter');
        return res.redirect(`${SETTINGS_URL}?error=${encodeURIComponent('Invalid or expired OAuth state')}`);
    }

    const { company_id, user_id } = statePayload;

    try {
        // Exchange authorization code for tokens
        const tokens = await emailMailboxService.exchangeCode(code);

        // Fetch Gmail profile
        const profile = await emailMailboxService.getGmailProfile(tokens.access_token);

        // Persist mailbox with encrypted tokens.
        // Multi-tenant isolation: connectMailbox throws a 409
        // EMAIL_ALREADY_CONNECTED_ELSEWHERE when this Google account is already
        // connected by a DIFFERENT workspace (migration 130). That MUST surface as a
        // friendly settings-page indicator, never a 500 on the OAuth redirect — so we
        // catch connect errors here (inside the outer try) and redirect with an
        // email_error flag instead of letting them fall through to the generic catch.
        try {
            await emailMailboxService.connectMailbox({
                companyId: company_id,
                userId: user_id,
                tokens,
                profile,
            });
        } catch (connectErr) {
            if (connectErr && connectErr.code === 'EMAIL_ALREADY_CONNECTED_ELSEWHERE') {
                console.warn(
                    `[EmailOAuth] ${profile.email_address} already connected to another workspace `
                    + `(company ${company_id} attempt rejected)`
                );
                return res.redirect(`${SETTINGS_URL}?email_error=already_connected`);
            }
            console.error('[EmailOAuth] connectMailbox failed:', connectErr.message);
            return res.redirect(`${SETTINGS_URL}?email_error=connect_failed`);
        }

        console.log(`[EmailOAuth] Mailbox connected for company ${company_id}: ${profile.email_address}`);

        // EMAIL-TIMELINE-001 (TASK-ET-6) — start the Gmail push watch on connect.
        // Best-effort: a watch failure (e.g. GMAIL_PUBSUB_TOPIC unset or Pub/Sub not
        // provisioned) MUST NOT break the OAuth connect flow — the 5-min poll covers
        // inbound until push is available. startWatch is itself safe-fail; we still
        // try/catch so an unexpected throw can't change the redirect below.
        try {
            await providerRegistry.get(company_id).startWatch(company_id);
        } catch (watchErr) {
            console.warn(`[EmailOAuth] startWatch (non-fatal) for company ${company_id}:`, watchErr.message);
        }

        return res.redirect(`${SETTINGS_URL}?connected=1`);
    } catch (err) {
        console.error('[EmailOAuth] Callback error:', err.message);
        return res.redirect(`${SETTINGS_URL}?error=${encodeURIComponent('Failed to connect mailbox')}`);
    }
});

module.exports = router;
