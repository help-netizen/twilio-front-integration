const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const twilio = require('twilio');

// In-memory store for demo (replace with database in production)
const syncedCalls = new Map();

/**
 * Verify Front webhook signature
 */
function verifyFrontSignature(req) {
    const signature = req.headers['x-front-signature'];
    if (!signature) return false;

    const body = JSON.stringify(req.body);
    const hash = crypto
        .createHmac('sha256', process.env.FRONT_APP_SECRET)
        .update(body)
        .digest('base64');

    return signature === hash;
}

/**
 * Verify Twilio webhook signature
 */
function verifyTwilioSignature(req) {
    const twilioSignature = req.headers['x-twilio-signature'];
    if (!twilioSignature) return false;

    const url = `${process.env.CALLBACK_HOSTNAME}${req.originalUrl}`;

    return twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        twilioSignature,
        url,
        req.body
    );
}

/**
 * Front Channel Webhook
 * Receives events from Front when users interact with the channel
 */
router.post('/front/channel', (req, res) => {
    // Verify signature in production
    if (process.env.NODE_ENV === 'production' && !verifyFrontSignature(req)) {
        console.error('Invalid Front signature');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type, payload, metadata } = req.body;

    console.log(`📨 Front webhook: ${type}`);

    switch (type) {
        case 'message':
            // User is trying to compose/reply from Front
            // For call logging channel, we might not support outbound composition
            // But we must respond with external IDs

            console.log('User message from Front:', payload);

            res.json({
                external_id: `front_response_${Date.now()}`,
                external_conversation_id: metadata.external_conversation_ids?.[0] || `conv_${Date.now()}`
            });
            break;

        case 'message_imported':
            // Our synced message was successfully imported
            console.log('✅ Message imported to Front:', payload.id);
            res.status(200).send('OK');
            break;

        case 'conversation_merged':
            // Conversations were merged in Front
            console.log('🔀 Conversations merged:', metadata);
            res.status(200).send('OK');
            break;

        default:
            console.log('Unknown event type:', type);
            res.status(200).send('OK');
    }
});

/**
 * Twilio Status Webhook
 * Receives call status updates from Twilio
 */
router.post('/twilio/status', async (req, res) => {
    // Verify signature in production
    if (process.env.NODE_ENV === 'production' && !verifyTwilioSignature(req)) {
        console.error('Invalid Twilio signature');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { CallSid, CallStatus, From, To, Duration, Direction } = req.body;

    console.log(`📞 Twilio webhook: Call ${CallSid} - ${CallStatus}`);

    // Only sync completed calls
    if (CallStatus === 'completed') {
        try {
            // Check if already synced
            if (syncedCalls.has(CallSid)) {
                console.log(`Call ${CallSid} already synced`);
                return res.status(200).send('OK');
            }

            // Mark as synced (prevent duplicates)
            syncedCalls.set(CallSid, {
                status: CallStatus,
                syncedAt: new Date()
            });

            console.log(`✅ Call ${CallSid} ready for sync`);
            console.log(`   From: ${From}, To: ${To}, Duration: ${Duration}s, Direction: ${Direction}`);

            // TODO: Fetch full call details and sync to Front
            // This will be implemented with the sync service

            res.status(200).send('OK');
        } catch (error) {
            console.error('Error processing Twilio webhook:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    } else {
        // Call not completed yet, just acknowledge
        res.status(200).send('OK');
    }
});

/**
 * Twilio Incoming Call Webhook
 * Receives notifications when a call is received
 */
router.post('/twilio/incoming', (req, res) => {
    const { CallSid, From, To } = req.body;

    console.log(`📞 Incoming call: ${CallSid} from ${From} to ${To}`);

    // Return TwiML to handle the call (optional)
    // For now, just log and let Twilio handle according to console settings
    res.type('text/xml');
    res.send(`
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Thank you for calling. Your call is being recorded.</Say>
    </Response>
  `);
});

module.exports = router;
