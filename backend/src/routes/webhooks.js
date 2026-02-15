const express = require('express');
const router = express.Router();
const {
    handleVoiceStatus,
    handleRecordingStatus,
    handleTranscriptionStatus,
    handleVoiceInbound,
    handleDialAction,
    handleVoiceFallback,
} = require('../webhooks/twilioWebhooks');

// POST /webhooks/twilio/voice-status — call status changes
router.post('/twilio/voice-status', handleVoiceStatus);

// POST /webhooks/twilio/recording-status — recording lifecycle
router.post('/twilio/recording-status', handleRecordingStatus);

// POST /webhooks/twilio/transcription-status — transcription lifecycle (NEW v3)
router.post('/twilio/transcription-status', handleTranscriptionStatus);

// POST /webhooks/twilio/voice-inbound — new call TwiML
router.post('/twilio/voice-inbound', handleVoiceInbound);

// POST /webhooks/twilio/voice-dial-action — Dial result + voicemail
router.post('/twilio/voice-dial-action', handleDialAction);

// POST /webhooks/twilio/dial-action — Legacy route (keep for compatibility)
router.post('/twilio/dial-action', handleDialAction);

// POST /webhooks/twilio/voice-fallback — Emergency fallback
router.post('/twilio/voice-fallback', handleVoiceFallback);

// GET /webhooks/health
router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'twilio-webhooks-v3',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
