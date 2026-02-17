/**
 * Twilio Media Stream WebSocket Server
 *
 * Accepts WebSocket connections from Twilio Media Streams,
 * parses the stream protocol (connected/start/media/stop),
 * and routes audio to the realtime transcription service.
 *
 * Mounts on the existing HTTP server via upgrade event.
 * Path: /ws/twilio-media
 */
const { WebSocketServer } = require('ws');
const transcriptService = require('./realtimeTranscriptService');

let wss = null;

/**
 * Initialize the Media Stream WebSocket server
 * @param {import('http').Server} httpServer — the Express HTTP server
 */
function initMediaStreamServer(httpServer) {
    wss = new WebSocketServer({ noServer: true });

    // Handle HTTP → WS upgrade for our specific path
    httpServer.on('upgrade', (request, socket, head) => {
        const { pathname } = new URL(request.url, `http://${request.headers.host}`);

        if (pathname === '/ws/twilio-media') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            // Not our path — let it fall through (or destroy if nothing else handles it)
            socket.destroy();
        }
    });

    wss.on('connection', handleConnection);

    console.log('[MediaStream] WebSocket server initialized on /ws/twilio-media');
}

/**
 * Handle a single Twilio Media Stream WebSocket connection
 * @param {import('ws').WebSocket} ws
 */
function handleConnection(ws) {
    // Per-connection state
    const state = {
        callSid: null,
        streamSid: null,
        customParameters: {},
        tracks: new Set(),
        packetCount: 0
    };

    console.log('[MediaStream] New Twilio connection');

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            handleTwilioEvent(msg, state, ws);
        } catch (e) {
            console.error('[MediaStream] Parse error:', e.message);
        }
    });

    ws.on('close', (code) => {
        console.log(`[MediaStream] Connection closed (code=${code}) callSid=${state.callSid} packets=${state.packetCount}`);

        // Ensure transcript session is terminated
        if (state.callSid) {
            transcriptService.terminateSession(state.callSid).catch(err => {
                console.error(`[MediaStream] Terminate error for ${state.callSid}:`, err.message);
            });
        }
    });

    ws.on('error', (err) => {
        console.error(`[MediaStream] WebSocket error (callSid=${state.callSid}):`, err.message);
    });
}

/**
 * Handle individual Twilio Media Stream protocol events
 *
 * Events:
 *   - connected: initial handshake
 *   - start: stream metadata (callSid, streamSid, customParameters, tracks)
 *   - media: audio data (base64 payload, track name, timestamp)
 *   - stop: stream ended
 *   - dtmf: DTMF digit (ignored for transcription)
 */
function handleTwilioEvent(msg, state, ws) {
    switch (msg.event) {
        case 'connected':
            console.log('[MediaStream] Twilio connected', { protocol: msg.protocol });
            break;

        case 'start': {
            state.callSid = msg.start.callSid;
            state.streamSid = msg.streamSid;
            state.customParameters = msg.start.customParameters || {};

            // Collect track names
            if (msg.start.tracks) {
                msg.start.tracks.forEach(t => state.tracks.add(t));
            }

            console.log(`[MediaStream] Stream started`, {
                callSid: state.callSid,
                streamSid: state.streamSid,
                tracks: [...state.tracks],
                params: state.customParameters
            });

            // Create transcription session for this call
            const effectiveCallSid = state.customParameters.callSid || state.callSid;
            transcriptService.createSession(effectiveCallSid, {
                streamSid: state.streamSid,
                direction: state.customParameters.direction || 'unknown',
                tracks: [...state.tracks]
            });

            break;
        }

        case 'media': {
            state.packetCount++;

            // msg.media.payload is base64-encoded mulaw audio
            // msg.media.track is 'inbound' or 'outbound'
            const track = msg.media.track;
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');

            const effectiveCallSid = state.customParameters.callSid || state.callSid;
            transcriptService.routeAudio(effectiveCallSid, track, audioBuffer);
            break;
        }

        case 'stop': {
            console.log(`[MediaStream] Stream stopped`, {
                callSid: state.callSid,
                streamSid: state.streamSid,
                reason: msg.stop?.reason,
                packets: state.packetCount
            });

            const effectiveCallSid = state.customParameters.callSid || state.callSid;
            transcriptService.terminateSession(effectiveCallSid).catch(err => {
                console.error(`[MediaStream] Terminate error:`, err.message);
            });
            break;
        }

        case 'dtmf':
            // DTMF digits — not relevant for transcription, ignore
            break;

        default:
            console.log(`[MediaStream] Unknown event: ${msg.event}`);
    }
}

/**
 * Get server stats for monitoring
 */
function getStats() {
    return {
        connections: wss ? wss.clients.size : 0,
        activeSessions: transcriptService.getActiveSessions()
    };
}

module.exports = { initMediaStreamServer, getStats };
