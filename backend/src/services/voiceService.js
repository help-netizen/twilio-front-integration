/**
 * Voice Service — Twilio Access Token generation for WebRTC SoftPhone.
 *
 * Uses Twilio API Key + Secret to mint short-lived Access Tokens with VoiceGrant.
 * Each FSM user gets a tenant-scoped identity so Twilio can route incoming calls
 * to the correct browser session without mixing users across companies.
 */

const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// Required env vars (validated at usage time, not import time)
const ACCOUNT_SID = () => process.env.TWILIO_ACCOUNT_SID;
const API_KEY = () => process.env.TWILIO_API_KEY;
const API_SECRET = () => process.env.TWILIO_API_SECRET;
const TWIML_APP_SID = () => process.env.TWILIO_TWIML_APP_SID;

const TOKEN_TTL = 3600; // 1 hour

/**
 * Generate a Twilio Access Token with VoiceGrant for the given identity.
 *
 * @param {string} identity — unique tenant-scoped user identity
 * @returns {{ token: string, identity: string, expiresAt: string }}
 */
function generateToken(identity) {
    if (!ACCOUNT_SID() || !API_KEY() || !API_SECRET() || !TWIML_APP_SID()) {
        throw new Error('Missing Twilio SoftPhone env vars: TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID');
    }

    const voiceGrant = new VoiceGrant({
        outgoingApplicationSid: TWIML_APP_SID(),
        incomingAllow: true,
    });

    const token = new AccessToken(
        ACCOUNT_SID(),
        API_KEY(),
        API_SECRET(),
        { identity, ttl: TOKEN_TTL }
    );

    token.addGrant(voiceGrant);

    const expiresAt = new Date(Date.now() + TOKEN_TTL * 1000).toISOString();

    console.log(`[VoiceService] Token generated for identity="${identity}", expires=${expiresAt}`);

    return {
        token: token.toJwt(),
        identity,
        expiresAt,
    };
}

/**
 * ALB-107 phase 2: mint a token with the tenant subaccount's own creds when
 * the company has softphone setup; legacy/default company uses env creds.
 */
async function generateTokenForCompany(companyId, identity) {
    const telephonyTenantService = require('./telephonyTenantService');
    const creds = await telephonyTenantService.getSoftphoneCreds(companyId);
    if (!creds) return generateToken(identity);

    const voiceGrant = new VoiceGrant({
        outgoingApplicationSid: creds.twimlAppSid,
        incomingAllow: true,
    });
    const token = new AccessToken(creds.accountSid, creds.apiKeySid, creds.apiKeySecret, { identity, ttl: TOKEN_TTL });
    token.addGrant(voiceGrant);
    return {
        token: token.toJwt(),
        identity,
        expiresAt: new Date(Date.now() + TOKEN_TTL * 1000).toISOString(),
    };
}

module.exports = { generateToken, generateTokenForCompany };
