/**
 * Transcription Service — AssemblyAI post-call transcription
 *
 * Reusable core: download recording → AssemblyAI → Gemini summary → save to transcripts.
 * Used by both the manual /transcribe endpoint and the auto-transcription in inboxWorker.
 */
const fetch = require('node-fetch');
const queries = require('../db/queries');
const db = require('../db/connection');
const { generateCallSummary } = require('./callSummaryService');

/**
 * Transcribe a call recording using AssemblyAI, generate Gemini summary,
 * and save everything to the transcripts table.
 *
 * @param {string} callSid - Twilio call SID
 * @param {string} recordingSid - Twilio recording SID
 * @param {string} [traceId] - optional trace ID for logging
 * @returns {Promise<{status: string, transcript?: string, gemini_summary?: string, gemini_entities?: Array, sentimentScore?: number}>}
 */
async function transcribeCall(callSid, recordingSid, traceId = `auto-${callSid}`) {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
        throw new Error('ASSEMBLYAI_API_KEY not configured');
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
        throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not configured');
    }

    // Check if transcript already exists
    const media = await queries.getCallMedia(callSid);
    if (media.transcripts?.length > 0 && media.transcripts[0].status === 'completed') {
        console.log(`[${traceId}] Transcript already exists for ${callSid}, skipping`);
        return { status: 'already_exists', transcript: media.transcripts[0].text };
    }

    console.log(`[${traceId}] Starting transcription for ${callSid} (rec: ${recordingSid})`);

    // 1. Download audio from Twilio
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`;
    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const audioRes = await fetch(twilioUrl, {
        headers: { 'Authorization': authHeader },
        redirect: 'follow',
    });
    if (!audioRes.ok) {
        throw new Error(`Failed to fetch recording from Twilio: ${audioRes.status}`);
    }
    const audioBuffer = await audioRes.buffer();
    console.log(`[${traceId}] Downloaded ${audioBuffer.length} bytes`);

    // 2. Upload audio to AssemblyAI
    const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: {
            'authorization': apiKey,
            'content-type': 'application/octet-stream',
        },
        body: audioBuffer,
    });
    if (!uploadRes.ok) {
        const err = await uploadRes.text();
        throw new Error(`AssemblyAI upload failed: ${err}`);
    }
    const { upload_url } = await uploadRes.json();

    // 3. Submit transcription job
    const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: {
            'authorization': apiKey,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            audio_url: upload_url,
            speech_models: ['universal-2'],
            language_detection: true,
            speaker_labels: true,
            format_text: true,
            sentiment_analysis: true,
        }),
    });
    if (!transcriptRes.ok) {
        const err = await transcriptRes.text();
        throw new Error(`AssemblyAI transcription submit failed: ${err}`);
    }
    const job = await transcriptRes.json();

    // 4. Poll for completion (max ~3 minutes)
    let result = job;
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts && result.status !== 'completed' && result.status !== 'error'; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${job.id}`, {
            headers: { 'authorization': apiKey },
        });
        result = await pollRes.json();
    }

    if (result.status === 'error') {
        throw new Error(`Transcription failed: ${result.error}`);
    }
    if (result.status !== 'completed') {
        throw new Error('Transcription timed out');
    }

    // 5. Format as dialog from utterances (Speaker A / Speaker B)
    let dialogText = result.text; // fallback
    if (result.utterances && result.utterances.length > 0) {
        dialogText = result.utterances
            .map(u => `[${u.start}ms] Speaker ${u.speaker}: ${u.text}`)
            .join('\n\n');
    }

    // 6. Compute overall sentiment score (-1 to +1)
    let sentimentScore = null;
    const sentResults = result.sentiment_analysis_results || [];
    if (sentResults.length > 0) {
        let weightedSum = 0;
        let totalConf = 0;
        for (const s of sentResults) {
            const val = s.sentiment === 'POSITIVE' ? 1 : s.sentiment === 'NEGATIVE' ? -1 : 0;
            const conf = s.confidence || 0.5;
            weightedSum += val * conf;
            totalConf += conf;
        }
        sentimentScore = totalConf > 0 ? Math.round((weightedSum / totalConf) * 100) / 100 : 0;
    }

    // 7. Generate Gemini summary (non-fatal if it fails)
    let geminiSummary = null;
    let geminiEntities = [];
    let geminiGeneratedAt = null;
    try {
        console.log(`[${traceId}] Generating Gemini summary...`);
        const summaryResult = await generateCallSummary(dialogText);
        if (summaryResult && !summaryResult.error) {
            geminiSummary = summaryResult.summary;
            geminiEntities = summaryResult.entities;
            geminiGeneratedAt = new Date().toISOString();
            console.log(`[${traceId}] Gemini summary OK: ${geminiSummary?.length} chars, ${geminiEntities.length} entities`);
        } else {
            console.warn(`[${traceId}] Gemini summary skipped: ${summaryResult?.error}`);
        }
    } catch (geminiErr) {
        console.error(`[${traceId}] Gemini summary failed (non-fatal):`, geminiErr.message);
    }

    // 8. Save to transcripts table
    const transcriptionSid = `aai_${job.id}`;
    await queries.upsertTranscript({
        transcriptionSid,
        callSid,
        recordingSid,
        mode: 'post-call',
        status: 'completed',
        languageCode: result.language_code || null,
        confidence: result.confidence || null,
        text: dialogText,
        isFinal: true,
        rawPayload: {
            assemblyai_id: job.id,
            entities: [],
            sentimentScore,
            gemini_summary: geminiSummary,
            gemini_entities: geminiEntities,
            gemini_generated_at: geminiGeneratedAt,
        },
    });

    // 9. Clean up stale "processing" placeholder
    try {
        await db.query(
            `DELETE FROM transcripts WHERE call_sid = $1 AND transcription_sid IS NULL AND status = 'processing'`,
            [callSid]
        );
    } catch (e) { /* ignore cleanup errors */ }

    // 10. Publish realtime event so frontend updates
    try {
        const realtimeService = require('./realtimeService');
        realtimeService.publishCallUpdate({
            eventType: 'transcript.ready',
            callSid,
            recordingSid,
            status: 'completed',
            text: dialogText,
            gemini_summary: geminiSummary,
            gemini_entities: geminiEntities,
        });
    } catch (_) { /* realtimeService not available */ }

    console.log(`[${traceId}] ✅ Transcription completed: ${dialogText?.length} chars, ${result.utterances?.length || 0} utterances, sentiment=${sentimentScore}`);

    return {
        status: 'completed',
        transcript: dialogText,
        sentimentScore,
        gemini_summary: geminiSummary,
        gemini_entities: geminiEntities,
    };
}

module.exports = { transcribeCall };
