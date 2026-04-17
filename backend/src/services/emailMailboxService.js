/**
 * Email Mailbox Service (EMAIL-001)
 *
 * OAuth URL generation, state signing/validation, token exchange,
 * encrypted token persistence, mailbox lifecycle management.
 */
const crypto = require('crypto');
const { google } = require('googleapis');
const emailQueries = require('../db/emailQueries');

const ENCRYPTION_KEY = process.env.EMAIL_TOKEN_ENCRYPTION_KEY; // 32-byte hex
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/email/oauth/google/callback';
const STATE_SECRET = process.env.EMAIL_OAUTH_STATE_SECRET || 'blanc-email-oauth-state-secret';

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
];

// ─── Encryption helpers ──────────────────────────────────────────────────

function getEncryptionKey() {
    if (!ENCRYPTION_KEY) throw new Error('EMAIL_TOKEN_ENCRYPTION_KEY is not configured');
    return Buffer.from(ENCRYPTION_KEY, 'hex');
}

function encrypt(plaintext) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(ciphertext) {
    const key = getEncryptionKey();
    const [ivHex, authTagHex, dataHex] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(data) + decipher.final('utf8');
}

// ─── OAuth state signing ─────────────────────────────────────────────────

function signOAuthState(companyId, userId) {
    const payload = JSON.stringify({ company_id: companyId, user_id: userId, ts: Date.now() });
    const hmac = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
    const encoded = Buffer.from(payload).toString('base64url');
    return `${encoded}.${hmac}`;
}

function validateOAuthState(state) {
    const [encoded, hmac] = state.split('.');
    if (!encoded || !hmac) return null;

    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');

    const hmacBuf = Buffer.from(hmac, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (hmacBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(hmacBuf, expectedBuf)) {
        return null;
    }

    const parsed = JSON.parse(payload);
    // Reject states older than 10 minutes
    if (Date.now() - parsed.ts > 10 * 60 * 1000) return null;

    return parsed;
}

// ─── OAuth2 client ───────────────────────────────────────────────────────

function createOAuth2Client() {
    return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

function buildAuthUrl(companyId, userId) {
    const oauth2 = createOAuth2Client();
    const state = signOAuthState(companyId, userId);
    return oauth2.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state,
    });
}

async function exchangeCode(code) {
    const oauth2 = createOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    return tokens;
}

async function getGmailProfile(accessToken) {
    const oauth2 = createOAuth2Client();
    oauth2.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    return {
        email_address: profile.data.emailAddress,
        history_id: profile.data.historyId,
    };
}

// ─── Mailbox lifecycle ───────────────────────────────────────────────────

async function connectMailbox({ companyId, userId, tokens, profile }) {
    const mailbox = await emailQueries.upsertMailbox({
        company_id: companyId,
        provider: 'gmail',
        email_address: profile.email_address,
        display_name: profile.display_name || null,
        provider_account_id: profile.provider_account_id || null,
        status: 'connected',
        access_token_encrypted: encrypt(tokens.access_token),
        refresh_token_encrypted: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        created_by: userId,
        updated_by: userId,
    });

    // Initialize sync state
    await emailQueries.upsertSyncState({
        mailbox_id: mailbox.id,
        company_id: companyId,
        last_history_id: profile.history_id || null,
    });

    return mailbox;
}

async function getMailboxStatus(companyId) {
    const mailbox = await emailQueries.getMailboxByCompany(companyId);
    if (!mailbox) return null;
    // Never return encrypted tokens
    return {
        id: mailbox.id,
        provider: mailbox.provider,
        email_address: mailbox.email_address,
        display_name: mailbox.display_name,
        status: mailbox.status,
        last_synced_at: mailbox.last_synced_at,
        last_sync_status: mailbox.last_sync_status,
        last_sync_error: mailbox.last_sync_error,
        created_at: mailbox.created_at,
    };
}

async function getDecryptedTokens(companyId) {
    const mailbox = await emailQueries.getMailboxWithTokens(companyId);
    if (!mailbox) return null;
    if (!mailbox.access_token_encrypted) return null;

    return {
        mailbox_id: mailbox.id,
        access_token: decrypt(mailbox.access_token_encrypted),
        refresh_token: mailbox.refresh_token_encrypted ? decrypt(mailbox.refresh_token_encrypted) : null,
        token_expires_at: mailbox.token_expires_at,
        status: mailbox.status,
    };
}

async function refreshAccessToken(companyId) {
    const tokenData = await getDecryptedTokens(companyId);
    if (!tokenData || !tokenData.refresh_token) {
        throw new Error('No refresh token available');
    }

    const oauth2 = createOAuth2Client();
    oauth2.setCredentials({ refresh_token: tokenData.refresh_token });

    try {
        const { credentials } = await oauth2.refreshAccessToken();
        await emailQueries.updateMailboxTokens(tokenData.mailbox_id, {
            access_token_encrypted: encrypt(credentials.access_token),
            refresh_token_encrypted: credentials.refresh_token ? encrypt(credentials.refresh_token) : null,
            token_expires_at: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
        });
        return credentials.access_token;
    } catch (err) {
        console.error('[EmailMailboxService] Token refresh failed:', err.message);
        await emailQueries.updateMailboxStatus(tokenData.mailbox_id, {
            status: 'reconnect_required',
            last_sync_status: 'error',
            last_sync_error: 'Token refresh failed — reconnection needed',
        });
        throw err;
    }
}

async function getValidAccessToken(companyId) {
    const tokenData = await getDecryptedTokens(companyId);
    if (!tokenData) throw new Error('No mailbox connected');
    if (tokenData.status !== 'connected') throw new Error(`Mailbox status: ${tokenData.status}`);

    // If token expires within 5 minutes, refresh
    const expiresAt = tokenData.token_expires_at ? new Date(tokenData.token_expires_at) : null;
    if (expiresAt && expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
        return refreshAccessToken(companyId);
    }
    return tokenData.access_token;
}

async function disconnectMailbox(companyId, userId) {
    const mailbox = await emailQueries.getMailboxByCompany(companyId);
    if (!mailbox) return null;
    return emailQueries.disconnectMailbox(mailbox.id, userId);
}

module.exports = {
    // encryption (internal, but exported for testing)
    encrypt,
    decrypt,
    // OAuth
    signOAuthState,
    validateOAuthState,
    buildAuthUrl,
    exchangeCode,
    getGmailProfile,
    createOAuth2Client,
    // lifecycle
    connectMailbox,
    getMailboxStatus,
    getDecryptedTokens,
    getValidAccessToken,
    refreshAccessToken,
    disconnectMailbox,
};
