const express = require('express');
const router = express.Router();
const { handleVoiceStatus, handleRecordingStatus } = require('../webhooks/twilioWebhooks');

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
