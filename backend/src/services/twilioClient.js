/**
 * Twilio REST Client — process-wide singleton.
 *
 * Use `getTwilioClient()` from any module that needs the Twilio Node SDK.
 * The first call reads `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` from env
 * and constructs a single `twilio(sid, token)` instance whose internal
 * `https.Agent` keep-alive pool is shared by every subsequent caller.
 *
 * Why: instantiating `twilio(...)` per request creates a new HTTPS agent
 * each time, leaving idle keep-alive sockets behind that accumulate as
 * ESTABLISHED outbound connections to api.twilio.com. See TWC-001.
 */
const twilio = require('twilio');

let _client = null;

function getTwilioClient() {
    if (_client) return _client;

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;

    if (!sid || !token) {
        throw new Error(
            'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required'
        );
    }

    _client = twilio(sid, token);
    return _client;
}

module.exports = { getTwilioClient };
