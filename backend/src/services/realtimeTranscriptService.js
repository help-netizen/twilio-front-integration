/**
 * Realtime Transcript Service — Session Manager + Event Publisher
 *
 * Dual-channel mode: separate AssemblyAI sessions for inbound (customer)
 * and outbound (agent) tracks. This avoids garbled audio from mixing
 * two tracks into one stream.
 */
const { AssemblyAISession } = require('./assemblyAIBridge');
const realtimeService = require('./realtimeService');
const db = require('../db/connection');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// Active transcription sessions: callSid → session object
const activeSessions = new Map();

// Global turn counter per call to interleave turns from both tracks
let globalTurnCounter = 0;

/**
 * Create dual-channel transcription sessions for a call.
 * Each track (inbound/outbound) gets its own AssemblyAI session.
 *
 * @param {string} callSid
 * @param {Object} meta — { direction, streamSid }
 */
function createSession(callSid, meta = {}) {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
        console.error(`[TranscriptSvc:${callSid}] ASSEMBLYAI_API_KEY not set, skipping`);
        return null;
    }

    if (activeSessions.has(callSid)) {
        console.warn(`[TranscriptSvc:${callSid}] Session already exists, reusing`);
        return activeSessions.get(callSid);
    }

    console.log(`[TranscriptSvc:${callSid}] Creating dual-channel sessions`);

    const session = {
        callSid,
        meta,
        segments: [],           // merged transcript segments from both tracks
        aaiInbound: null,       // AssemblyAI session for inbound (customer)
        aaiOutbound: null,      // AssemblyAI session for outbound (agent)
        closedCount: 0,         // how many sessions have closed (finalize at 2)
        finalized: false,
        createdAt: new Date()
    };

    // Turn handler factory — creates handler for a specific track
    function makeTurnHandler(trackName, speaker) {
        return (turnData) => {
            // Use AAI's turn_order, prefixed with track to avoid collisions
            const turnOrder = turnData.turnOrder != null
                ? turnData.turnOrder * 10 + (trackName === 'inbound' ? 0 : 1)
                : (++globalTurnCounter);

            const segment = {
                seq: turnOrder,
                ...turnData,
                speaker,
                track: trackName
            };

            // Upsert: replace existing segment with same turn_order
            const existingIdx = session.segments.findIndex(s => s.seq === turnOrder);
            if (existingIdx >= 0) {
                session.segments[existingIdx] = segment;
            } else {
                session.segments.push(segment);
            }

            // Broadcast live delta via SSE
            realtimeService.broadcast('transcript.delta', {
                callSid,
                track: trackName,
                speaker,
                text: turnData.text,
                isFinal: turnData.isFinal,
                turnOrder: turnOrder,
                startMs: turnData.startMs,
                endMs: turnData.endMs,
                receivedAt: turnData.receivedAt
            });
        };
    }

    const handleError = (err) => {
        console.error(`[TranscriptSvc:${callSid}] Error:`, err.message);
    };

    const handleClose = (trackName) => () => {
        console.log(`[TranscriptSvc:${callSid}] ${trackName} session closed`);
        session.closedCount++;

        // Finalize when both sessions are closed (or after first if only one track)
        if (session.closedCount >= 2 && !session.finalized) {
            finalizeSession(callSid);
        }
    };

    // Create AAI session for inbound (customer) track
    session.aaiInbound = new AssemblyAISession({
        apiKey,
        callSid: `${callSid}-in`,
        track: 'inbound',
        onTurn: makeTurnHandler('inbound', 'customer'),
        onError: handleError,
        onClose: handleClose('inbound')
    });
    session.aaiInbound.connect();

    // Create AAI session for outbound (agent) track
    session.aaiOutbound = new AssemblyAISession({
        apiKey,
        callSid: `${callSid}-out`,
        track: 'outbound',
        onTurn: makeTurnHandler('outbound', 'agent'),
        onError: handleError,
        onClose: handleClose('outbound')
    });
    session.aaiOutbound.connect();

    activeSessions.set(callSid, session);
    return session;
}

/**
 * Route audio chunk to the correct AssemblyAI session.
 * inbound → customer session, outbound → agent session
 *
 * @param {string} callSid
 * @param {string} track — 'inbound' | 'outbound'
 * @param {Buffer} audioChunk — raw mulaw audio bytes
 */
function routeAudio(callSid, track, audioChunk) {
    const session = activeSessions.get(callSid);
    if (!session) return;

    if (track === 'inbound' && session.aaiInbound) {
        session.aaiInbound.sendAudio(audioChunk);
    } else if (track === 'outbound' && session.aaiOutbound) {
        session.aaiOutbound.sendAudio(audioChunk);
    }
}

/**
 * Terminate transcription for a call (called on stream stop)
 * @param {string} callSid
 */
async function terminateSession(callSid) {
    const session = activeSessions.get(callSid);
    if (!session) return;

    console.log(`[TranscriptSvc:${callSid}] Terminating sessions`);

    // Terminate both AAI sessions
    const terminations = [];
    if (session.aaiInbound) terminations.push(session.aaiInbound.terminate().catch(e => e));
    if (session.aaiOutbound) terminations.push(session.aaiOutbound.terminate().catch(e => e));
    await Promise.all(terminations);

    // If finalize hasn't been triggered by close handlers, do it now
    if (!session.finalized) {
        await finalizeSession(callSid);
    }
}

/**
 * Finalize the transcript: merge segments, persist to DB, broadcast event
 * @param {string} callSid
 */
async function finalizeSession(callSid) {
    const session = activeSessions.get(callSid);
    if (!session || session.finalized) return;

    session.finalized = true;
    console.log(`[TranscriptSvc:${callSid}] Finalizing — ${session.segments.length} segments`);

    try {
        // Sort segments by startMs, fallback to seq order
        const sorted = [...session.segments].sort((a, b) => {
            if (a.startMs != null && b.startMs != null) return a.startMs - b.startMs;
            return a.seq - b.seq;
        });

        // Build full text
        const fullText = sorted
            .filter(s => s.text && s.text.trim())
            .map(s => `${s.speaker === 'customer' ? 'Customer' : 'Agent'}: ${s.text}`)
            .join('\n');

        // Persist each segment to transcripts table
        for (const seg of sorted) {
            if (!seg.text || !seg.text.trim()) continue;

            const transcriptionSid = `rt-${callSid}-${seg.seq}`;
            await db.query(
                `INSERT INTO transcripts
                    (transcription_sid, call_sid, mode, status, text,
                     is_final, sequence_no, speaker, track, raw_payload, company_id)
                 VALUES ($1, $2, 'realtime', 'completed', $3,
                         true, $4, $5, $6, $7, $8)
                 ON CONFLICT (transcription_sid) DO NOTHING`,
                [
                    transcriptionSid,
                    callSid,
                    seg.text,
                    seg.seq,
                    seg.speaker,
                    seg.track,
                    JSON.stringify({
                        sessionId: seg.sessionId,
                        startMs: seg.startMs,
                        endMs: seg.endMs,
                        turnOrder: seg.turnOrder,
                        words: seg.words
                    }),
                    DEFAULT_COMPANY_ID
                ]
            );
        }

        // Summary row with full merged text
        const summarySid = `rt-${callSid}-summary`;
        await db.query(
            `INSERT INTO transcripts
                (transcription_sid, call_sid, mode, status, text,
                 is_final, sequence_no, raw_payload, company_id)
             VALUES ($1, $2, 'realtime', 'completed', $3,
                     true, 0, $4, $5)
             ON CONFLICT (transcription_sid) DO UPDATE SET
                 text = EXCLUDED.text,
                 status = 'completed',
                 updated_at = now()`,
            [
                summarySid,
                callSid,
                fullText,
                JSON.stringify({
                    segmentCount: sorted.length,
                    mode: 'dual-channel',
                    provider: 'assemblyai',
                    finalizedAt: new Date().toISOString()
                }),
                DEFAULT_COMPANY_ID
            ]
        );

        // Broadcast finalized event
        realtimeService.broadcast('transcript.finalized', {
            callSid,
            text: fullText,
            segmentCount: sorted.length,
            finalizedAt: new Date().toISOString()
        });

        console.log(`[TranscriptSvc:${callSid}] Finalized: ${sorted.length} segments, ${fullText.length} chars`);

    } catch (err) {
        console.error(`[TranscriptSvc:${callSid}] Finalize error:`, err.message);
    } finally {
        activeSessions.delete(callSid);
    }
}

/**
 * Get active session info (for monitoring)
 */
function getActiveSessions() {
    const result = [];
    for (const [callSid, session] of activeSessions) {
        result.push({
            callSid,
            segments: session.segments.length,
            inboundReady: session.aaiInbound?.ready || false,
            outboundReady: session.aaiOutbound?.ready || false,
            closedCount: session.closedCount,
            finalized: session.finalized,
            createdAt: session.createdAt
        });
    }
    return result;
}

/**
 * Force cleanup all sessions (for shutdown)
 */
function destroyAll() {
    for (const [, session] of activeSessions) {
        if (session.aaiInbound) session.aaiInbound.destroy();
        if (session.aaiOutbound) session.aaiOutbound.destroy();
    }
    activeSessions.clear();
}

module.exports = {
    createSession,
    routeAudio,
    terminateSession,
    finalizeSession,
    getActiveSessions,
    destroyAll
};
