const express = require('express');
const router = express.Router();
const { validateTwilioSignature } = require('../webhooks/twilioWebhooks');

/**
 * TwiML endpoint for incoming voice calls
 *
 * Generates TwiML that:
 * 1. Dials to Twilio SIP domain (connects to Bria)
 * 2. Sends status callbacks for ALL call events
 * 3. Routes to voice-dial-action for voicemail on no-answer
 *
 * Twilio-called: reject unsigned requests in production so an attacker who
 * knows the URL cannot mint TwiML that exposes the SIP topology or redirects
 * the call. Same guard the main webhooks already run (twilioWebhooks.js).
 */
router.post('/voice', async (req, res) => {
    if (process.env.NODE_ENV !== 'development' && !(await validateTwilioSignature(req))) {
        return res.status(403).type('text/xml').send('<Response><Reject/></Response>');
    }
    const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.CALLBACK_HOSTNAME || 'https://api.albusto.com';
    const statusCallbackUrl = `${baseUrl}/webhooks/twilio/voice-status`;

    // Twilio SIP domain - connects to Bria softphone
    // Support multiple SIP users (ring all simultaneously)
    const sipDomain = process.env.SIP_DOMAIN || 'abchomes.sip.us1.twilio.com';
    const sipUsers = (process.env.SIP_USERS || process.env.SIP_USER || 'dispatcher').split(',').map(u => u.trim());
    const sipEndpoints = sipUsers.map(user =>
        `        <Sip statusCallback="${statusCallbackUrl}"
             statusCallbackEvent="initiated ringing answered completed"
             statusCallbackMethod="POST">sip:${user}@${sipDomain}</Sip>`
    ).join('\n');

    // Dial action callback - gets final DialCallStatus + voicemail
    const dialActionUrl = `${baseUrl}/webhooks/twilio/voice-dial-action`;

    // Recording status callback
    const recordingStatusUrl = `${baseUrl}/webhooks/twilio/recording-status`;

    const dialTimeout = Number(process.env.DIAL_TIMEOUT || 25);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="${dialTimeout}"
          action="${dialActionUrl}"
          method="POST"
          record="record-from-answer-dual"
          recordingStatusCallback="${recordingStatusUrl}"
          recordingStatusCallbackMethod="POST">
${sipEndpoints}
    </Dial>
</Response>`;

    console.log('[TwiML] Generated voice response:', {
        statusCallbackUrl,
        dialActionUrl,
        sipUsers,
        sipDomain,
        dialTimeout,
        from: req.body.From,
        to: req.body.To || req.body.Called,
        callSid: req.body.CallSid
    });

    res.type('text/xml');
    res.send(twiml);
});

module.exports = router;
