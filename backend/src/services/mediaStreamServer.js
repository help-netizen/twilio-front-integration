/**
 * Twilio Media Stream WebSocket Server
 *
 * The HTTP upgrade is quarantined because Twilio custom parameters arrive only
 * in the first `start` frame. No session or audio is accepted until that frame's
 * short-lived HMAC token and AccountSid binding have both been verified.
 */
const { WebSocketServer } = require('ws');
const transcriptService = require('./realtimeTranscriptService');
const telephonyTenantService = require('./telephonyTenantService');
const { verifyStreamToken } = require('./mediaStreamTokenService');

const AUTHENTICATION_TIMEOUT_MS = 5000;
let wss = null;

function securityMetric(event, reason) {
    console.warn('[MediaStreamSecurity]', {
        event,
        reason,
        metric: 'twilio_media_stream_auth_rejected_total',
        increment: 1,
    });
}

function rejectConnection(ws, state, reason) {
    if (state.rejected) return;
    state.rejected = true;
    securityMetric('twilio.media_stream.rejected', reason);
    try { ws.close(1008, 'Unauthorized media stream'); } catch { /* socket already closed */ }
}

async function validateUpgradeSignature(request, accountSid) {
    if (!request?.headers?.['x-twilio-signature']) return false;
    try {
        // Reuse the established validator with the exact WSS URL emitted in
        // TwiML, avoiding proxy reconstruction differences behind Caddy.
        const { validateTwilioSignature, mediaStreamUrl } = require('../webhooks/twilioWebhooks');
        return await validateTwilioSignature(request, {
            accountSid,
            params: {},
            url: mediaStreamUrl(),
        });
    } catch {
        return false;
    }
}

/**
 * Initialize the Media Stream WebSocket server.
 * @param {import('http').Server} httpServer
 */
function initMediaStreamServer(httpServer) {
    wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
        const { pathname } = new URL(request.url, `http://${request.headers.host}`);
        if (pathname !== '/ws/twilio-media') {
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });

    wss.on('connection', handleConnection);
    console.log('[MediaStream] WebSocket server initialized on /ws/twilio-media');
}

/**
 * Handle a quarantined Twilio Media Stream connection.
 * @param {import('ws').WebSocket} ws
 * @param {import('http').IncomingMessage} request
 */
function handleConnection(ws, request = null) {
    const state = {
        authenticated: false,
        rejected: false,
        companyId: null,
        callSid: null,
        accountSid: null,
        streamSid: null,
        direction: 'unknown',
        tracks: new Set(),
        packetCount: 0,
    };

    const authenticationTimer = setTimeout(() => {
        if (!state.authenticated) rejectConnection(ws, state, 'start_timeout');
    }, AUTHENTICATION_TIMEOUT_MS);
    authenticationTimer.unref?.();

    let messageChain = Promise.resolve();
    ws.on('message', (raw) => {
        messageChain = messageChain.then(async () => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                rejectConnection(ws, state, 'invalid_json');
                return;
            }
            await handleTwilioEvent(msg, state, ws, request);
        }).catch(() => rejectConnection(ws, state, 'event_processing_failed'));
    });

    ws.on('close', (code) => {
        clearTimeout(authenticationTimer);
        console.log(`[MediaStream] Connection closed (code=${code}) packets=${state.packetCount}`);
        if (state.authenticated && state.companyId && state.callSid) {
            transcriptService.terminateSession(state.companyId, state.callSid).catch(() => {
                securityMetric('twilio.media_stream.terminate_failed', 'session_error');
            });
        }
    });

    ws.on('error', () => {
        securityMetric('twilio.media_stream.socket_error', 'socket_error');
    });
}

async function handleTwilioEvent(msg, state, ws, request) {
    if (state.rejected) return;

    switch (msg.event) {
        case 'connected':
            break;

        case 'start': {
            if (state.authenticated) {
                rejectConnection(ws, state, 'duplicate_start');
                return;
            }

            const customParameters = msg.start?.customParameters || {};
            let claims;
            try {
                claims = verifyStreamToken(customParameters.streamToken);
            } catch {
                claims = null;
            }
            if (!claims) {
                rejectConnection(ws, state, 'invalid_token');
                return;
            }

            const startCallSid = msg.start?.callSid;
            const startAccountSid = msg.start?.accountSid;
            if (startCallSid !== claims.call_sid || startAccountSid !== claims.account_sid) {
                rejectConnection(ws, state, 'token_context_mismatch');
                return;
            }

            let resolvedCompanyId;
            try {
                resolvedCompanyId = await telephonyTenantService.resolveCompanyByAccountSid(startAccountSid);
            } catch {
                resolvedCompanyId = null;
            }
            if (!resolvedCompanyId || resolvedCompanyId !== claims.company_id) {
                rejectConnection(ws, state, 'account_binding_mismatch');
                return;
            }

            const signatureValid = await validateUpgradeSignature(request, startAccountSid);
            if (!signatureValid) {
                rejectConnection(ws, state, 'invalid_twilio_signature');
                return;
            }

            state.authenticated = true;
            state.companyId = claims.company_id;
            state.callSid = claims.call_sid;
            state.accountSid = claims.account_sid;
            state.direction = claims.direction || 'unknown';
            state.streamSid = msg.streamSid || msg.start?.streamSid || null;
            for (const track of msg.start?.tracks || []) state.tracks.add(track);

            transcriptService.createSession(state.companyId, state.callSid, {
                streamSid: state.streamSid,
                direction: state.direction,
                tracks: [...state.tracks],
            });
            break;
        }

        case 'media': {
            if (!state.authenticated) {
                rejectConnection(ws, state, 'media_before_start');
                return;
            }
            state.packetCount++;
            const audioBuffer = Buffer.from(msg.media?.payload || '', 'base64');
            transcriptService.routeAudio(
                state.companyId,
                state.callSid,
                msg.media?.track,
                audioBuffer
            );
            break;
        }

        case 'stop':
            if (!state.authenticated) {
                rejectConnection(ws, state, 'stop_before_start');
                return;
            }
            await transcriptService.terminateSession(state.companyId, state.callSid);
            break;

        case 'dtmf':
            if (!state.authenticated) rejectConnection(ws, state, 'dtmf_before_start');
            break;

        default:
            rejectConnection(ws, state, 'unknown_event');
    }
}

function getStats() {
    return {
        connections: wss ? wss.clients.size : 0,
        activeSessions: transcriptService.getActiveSessions(),
    };
}

module.exports = {
    initMediaStreamServer,
    getStats,
    handleConnection,
    handleTwilioEvent,
    AUTHENTICATION_TIMEOUT_MS,
};
