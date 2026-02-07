const express = require('express');
const router = express.Router();
const { handleVoiceStatus, handleRecordingStatus, handleVoiceInbound, handleDialAction } = require('../webhooks/twilioWebhooks');

/**
 * POST /webhooks/twilio/voice-status
 * Receives Twilio voice status callbacks
 * 
 * Twilio sends this webhook for call status changes:
 * - queued, initiated, ringing, in-progress, completed, busy, no-answer, failed, canceled
 */
router.post('/twilio/voice-status', handleVoiceStatus);

/**
 * POST /webhooks/twilio/recording-status
 * Receives Twilio recording status callbacks
 * 
 * Twilio sends this webhook when recordings are ready:
 * - in-progress, completed, absent, failed
 */
router.post('/twilio/recording-status', handleRecordingStatus);

/**
 * POST /webhooks/twilio/voice-inbound
 * Receives NEW incoming call, stores initial record, returns TwiML
 * 
 * This is the Voice URL for SIP Domain (or phone numbers)
 * Twilio calls this BEFORE connecting the call
 */
router.post('/twilio/voice-inbound', handleVoiceInbound);

/**
 * POST /webhooks/twilio/dial-action
 * Receives final Dial result after <Dial> completes
 * 
 * Gets DialCallStatus: completed, busy, no-answer, failed, canceled
 */
router.post('/twilio/dial-action', handleDialAction);

/**
 * GET /webhooks/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'twilio-webhooks',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
