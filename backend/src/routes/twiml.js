const express = require('express');
const router = express.Router();

/**
 * TwiML endpoint for incoming voice calls
 * 
 * Generates TwiML that:
 * 1. Dials to Twilio SIP domain (connects to Bria)
 * 2. Sends status callbacks for ALL call events
 */
router.post('/voice', (req, res) => {
    const baseUrl = process.env.WEBHOOK_BASE_URL || 'https://abc-metrics.fly.dev';
    const statusCallbackUrl = `${baseUrl}/webhooks/twilio/voice-status`;

    // Twilio SIP domain - connects to Bria softphone
    // Using dispatcher user from Bria config: dispatcher@abchomes.sip.us1.twilio.com
    const sipUser = process.env.SIP_USER || 'dispatcher';
    const sipDomain = process.env.SIP_DOMAIN || 'abchomes.sip.us1.twilio.com';
    const sipEndpoint = `sip:${sipUser}@${sipDomain}`;

    // Dial action callback - gets final DialCallStatus
    const dialActionUrl = `${baseUrl}/webhooks/twilio/dial-action`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="60"
          action="${dialActionUrl}"
          method="POST">
        <Sip statusCallback="${statusCallbackUrl}"
             statusCallbackEvent="initiated ringing answered completed"
             statusCallbackMethod="POST">${sipEndpoint}</Sip>
    </Dial>
</Response>`;

    console.log('[TwiML] Generated voice response:', {
        statusCallbackUrl,
        dialActionUrl,
        sipEndpoint,
        sipUser,
        sipDomain,
        from: req.body.From,
        to: req.body.To || req.body.Called,
        callSid: req.body.CallSid
    });

    res.type('text/xml');
    res.send(twiml);
});

module.exports = router;
