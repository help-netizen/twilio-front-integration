/**
 * Conversations Webhooks
 * Handles Twilio Conversations pre/post webhook events.
 */
const twilio = require('twilio');
const conversationsService = require('../services/conversationsService');

async function handleConversationsPre(req, res) {
    // Pre-event: pass-through (no blocking logic needed yet)
    res.status(200).send();
}

async function handleConversationsPost(req, res) {
    // Validate Twilio signature. FAIL CLOSED in production: a missing auth token
    // or missing signature is a rejection, not a bypass — this handler mutates
    // state (processWebhookEvent), so an unsigned request must never reach it.
    if (process.env.NODE_ENV !== 'development') {
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const signature = req.headers['x-twilio-signature'];
        const url = `${process.env.CALLBACK_HOSTNAME}${req.originalUrl}`;
        const valid = authToken && signature
            && twilio.validateRequest(authToken, signature, url, req.body || {});
        if (!valid) {
            console.warn('[ConvWebhook] Rejected post-event: missing/invalid Twilio signature');
            return res.status(403).send('Invalid signature');
        }
    }

    // Return 200 immediately, process async
    res.status(200).send();

    try {
        const eventType = req.body.EventType;
        if (eventType) {
            await conversationsService.processWebhookEvent(eventType, req.body);
        }
    } catch (err) {
        console.error('[ConvWebhook] Error processing post-event:', err);
    }
}

module.exports = { handleConversationsPre, handleConversationsPost };
