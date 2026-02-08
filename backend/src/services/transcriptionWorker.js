/**
 * Transcription Worker — Variant B Post-Call Transcription
 *
 * Polls transcription_jobs queue, downloads recording audio from Twilio,
 * sends to STT provider (OpenAI Whisper), saves result to transcripts table.
 */
const db = require('../db/connection');
const queries = require('../db/queries');
const fetch = require('node-fetch');
const FormData = require('form-data');

// Configuration
const POLL_INTERVAL_MS = 5000;
const MAX_ATTEMPTS = 3;

/**
 * Publish realtime event (imported lazily to avoid circular deps)
 */
function publishRealtimeEvent(eventType, data, traceId) {
    try {
        const { getRealtimeService } = require('./realtimeService');
        const svc = getRealtimeService();
        if (svc) svc.publish(eventType, data, traceId);
    } catch (_) {
        // realtimeService not available in standalone mode
    }
}

/**
 * Download recording audio from Twilio as a Buffer
 */
async function downloadRecording(recordingSid) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
        throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not configured');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`;
    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const res = await fetch(url, {
        headers: { 'Authorization': authHeader },
        redirect: 'follow',
    });

    if (!res.ok) {
        throw new Error(`Twilio recording download failed: ${res.status} ${res.statusText}`);
    }

    return await res.buffer();
}

/**
 * Transcribe audio using OpenAI Whisper API
 */
async function transcribeWithWhisper(audioBuffer, recordingSid) {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        throw new Error('OPENAI_API_KEY not configured — set it in .env to enable transcription');
    }

    const form = new FormData();
    form.append('file', audioBuffer, {
        filename: `${recordingSid}.mp3`,
        contentType: 'audio/mpeg',
    });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('language', 'en');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...form.getHeaders(),
        },
        body: form,
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI Whisper API error: ${res.status} — ${body}`);
    }

    const data = await res.json();
    return {
        text: data.text || '',
        confidence: null,       // Whisper doesn't return per-segment confidence easily
        languageCode: data.language || 'en',
    };
}

/**
 * Process one transcription job
 */
async function processOneJob() {
    // Atomically claim one queued job
    const jobRes = await db.query(`
        UPDATE transcription_jobs
        SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id = (
            SELECT id FROM transcription_jobs
            WHERE status = 'queued' AND attempts < $1
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING *
    `, [MAX_ATTEMPTS]);

    if (jobRes.rowCount === 0) return false; // no jobs

    const job = jobRes.rows[0];
    const traceId = `txn-${job.id}`;
    console.log(`[${traceId}] Processing transcription job: call=${job.call_sid} rec=${job.recording_sid} attempt=${job.attempts}`);

    try {
        // 1. Download audio from Twilio
        const audioBuffer = await downloadRecording(job.recording_sid);
        console.log(`[${traceId}] Downloaded ${audioBuffer.length} bytes`);

        // 2. Send to STT (Whisper)
        const result = await transcribeWithWhisper(audioBuffer, job.recording_sid);
        console.log(`[${traceId}] Transcribed: ${result.text.substring(0, 100)}...`);

        // 3. Update transcript row
        await db.query(`
            UPDATE transcripts
            SET status = 'completed',
                text = $3,
                confidence = $4,
                language_code = $5,
                updated_at = now()
            WHERE call_sid = $1 AND recording_sid = $2 AND status = 'processing'
        `, [job.call_sid, job.recording_sid, result.text, result.confidence, result.languageCode]);

        // 4. Mark job as done
        await db.query(`UPDATE transcription_jobs SET status = 'done', updated_at = now() WHERE id = $1`, [job.id]);

        // 5. Emit transcript.ready
        publishRealtimeEvent('transcript.ready', {
            callSid: job.call_sid,
            recordingSid: job.recording_sid,
            status: 'completed',
            text: result.text,
            confidence: result.confidence,
        }, traceId);

        console.log(`[${traceId}] Transcription completed successfully`);

    } catch (err) {
        console.error(`[${traceId}] Transcription failed:`, err.message);

        // Update transcript to failed
        await db.query(`
            UPDATE transcripts
            SET status = 'failed', updated_at = now()
            WHERE call_sid = $1 AND recording_sid = $2 AND status = 'processing'
        `, [job.call_sid, job.recording_sid]);

        // Mark job as failed (or back to queued if retries remain)
        if (job.attempts >= MAX_ATTEMPTS) {
            await db.query(
                `UPDATE transcription_jobs SET status = 'failed', error_text = $2, updated_at = now() WHERE id = $1`,
                [job.id, err.message]
            );
        } else {
            await db.query(
                `UPDATE transcription_jobs SET status = 'queued', error_text = $2, updated_at = now() WHERE id = $1`,
                [job.id, err.message]
            );
        }

        publishRealtimeEvent('transcript.ready', {
            callSid: job.call_sid,
            recordingSid: job.recording_sid,
            status: 'failed',
            text: null,
        }, traceId);
    }

    return true; // processed a job
}

/**
 * Start the transcription worker loop
 */
async function startTranscriptionWorker() {
    console.log('🎙️  Transcription worker started');
    console.log(`   Poll interval: ${POLL_INTERVAL_MS}ms | Max attempts: ${MAX_ATTEMPTS}`);
    console.log(`   STT provider: OpenAI Whisper (${process.env.OPENAI_API_KEY ? 'key configured' : '⚠️  OPENAI_API_KEY not set'})`);

    while (true) {
        try {
            const processed = await processOneJob();
            if (!processed) {
                // No jobs — wait before polling again
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            }
            // If we processed one, immediately try the next (drain the queue)
        } catch (err) {
            console.error('Transcription worker error:', err.message);
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        }
    }
}

module.exports = { startTranscriptionWorker, processOneJob };
