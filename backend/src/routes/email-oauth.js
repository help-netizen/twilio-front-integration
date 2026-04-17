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

const router = express.Router();

const SETTINGS_URL = '/settings/email';

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

        // Persist mailbox with encrypted tokens
        await emailMailboxService.connectMailbox({
            companyId: company_id,
            userId: user_id,
            tokens,
            profile,
        });

        console.log(`[EmailOAuth] Mailbox connected for company ${company_id}: ${profile.email_address}`);
        return res.redirect(`${SETTINGS_URL}?connected=1`);
    } catch (err) {
        console.error('[EmailOAuth] Callback error:', err.message);
        return res.redirect(`${SETTINGS_URL}?error=${encodeURIComponent('Failed to connect mailbox')}`);
    }
});

module.exports = router;
