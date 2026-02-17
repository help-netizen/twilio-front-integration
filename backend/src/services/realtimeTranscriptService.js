/**
 * Realtime Transcript Service — Session Manager + Event Publisher
 *
 * Single-channel mode: both tracks (inbound + outbound) are mixed into
 * one AssemblyAI session to minimize cost. Speaker attribution is inferred
 * from the Twilio track label on each audio packet.
 */
const { AssemblyAISession } = require('./assemblyAIBridge');
const realtimeService = require('./realtimeService');
const db = require('../db/connection');

// Active transcription sessions: callSid → { session, segments, meta }
const activeSessions = new Map();

/**
 * Create a single-channel transcription session for a call.
 * Both inbound (caller) and outbound (agent) audio is fed into one
 * AssemblyAI session.
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

    console.log(`[TranscriptSvc:${callSid}] Creating single-channel session`);

    const session = {
        callSid,
        meta,
        segments: [],           // collected transcript segments
        turnCounter: 0,
        aaiSession: null,       // single AssemblyAI session
        closed: false,
        finalized: false,
        lastTrack: null,        // last track that sent audio (for rough speaker hint)
        createdAt: new Date()
    };

    // Turn handler — called by AssemblyAI when a phrase is recognized
    const handleTurn = (turnData) => {
        session.turnCounter++;

        // Since we're mixing both tracks, AssemblyAI doesn't know the speaker.
        // We use the last-seen track as a rough heuristic for speaker label.
        const speaker = session.lastTrack === 'outbound' ? 'agent' : 'customer';

        const segment = {
            seq: session.turnCounter,
            ...turnData,
            speaker,
            track: session.lastTrack || 'mixed'
        };
        session.segments.push(segment);

        // Broadcast live delta via SSE
        realtimeService.broadcast('transcript.delta', {
            callSid,
            track: segment.track,
            speaker: segment.speaker,
            text: turnData.text,
            isFinal: turnData.isFinal,
            turnOrder: segment.seq,
            startMs: turnData.startMs,
            endMs: turnData.endMs,
            receivedAt: turnData.receivedAt
        });
    };

    const handleError = (err) => {
        console.error(`[TranscriptSvc:${callSid}] Error:`, err.message);
    };

    const handleClose = () => {
        console.log(`[TranscriptSvc:${callSid}] AssemblyAI session closed`);
        session.closed = true;

        if (!session.finalized) {
            finalizeSession(callSid);
        }
    };

    // Create single AssemblyAI session
    session.aaiSession = new AssemblyAISession({
        apiKey,
        callSid,
        track: 'mixed',
        onTurn: handleTurn,
        onError: handleError,
        onClose: handleClose
    });
    session.aaiSession.connect();

    activeSessions.set(callSid, session);
    return session;
}

/**
 * Route audio chunk to the AssemblyAI session.
 * Both inbound and outbound audio go to the same session.
 *
 * @param {string} callSid
 * @param {string} track — 'inbound' | 'outbound'
 * @param {Buffer} audioChunk — raw mulaw audio bytes
 */
function routeAudio(callSid, track, audioChunk) {
    const session = activeSessions.get(callSid);
    if (!session || !session.aaiSession) return;

    // Remember last track for rough speaker attribution
    session.lastTrack = track;
    session.aaiSession.sendAudio(audioChunk);
}

/**
 * Terminate transcription for a call (called on stream stop)
 * @param {string} callSid
 */
async function terminateSession(callSid) {
    const session = activeSessions.get(callSid);
    if (!session) return;

    console.log(`[TranscriptSvc:${callSid}] Terminating session`);

    if (session.aaiSession && !session.closed) {
        await session.aaiSession.terminate();
    }

    // If finalize hasn't been triggered by close handler, do it now
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
                     is_final, sequence_no, speaker, track, raw_payload)
                 VALUES ($1, $2, 'realtime', 'completed', $3,
                         true, $4, $5, $6, $7)
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
                    })
                ]
            );
        }

        // Summary row with full merged text
        const summarySid = `rt-${callSid}-summary`;
        await db.query(
            `INSERT INTO transcripts
                (transcription_sid, call_sid, mode, status, text,
                 is_final, sequence_no, raw_payload)
             VALUES ($1, $2, 'realtime', 'completed', $3,
                     true, 0, $4)
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
                    mode: 'single-channel',
                    provider: 'assemblyai',
                    finalizedAt: new Date().toISOString()
                })
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
            ready: session.aaiSession?.ready || false,
            closed: session.closed,
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
        if (session.aaiSession) session.aaiSession.destroy();
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
