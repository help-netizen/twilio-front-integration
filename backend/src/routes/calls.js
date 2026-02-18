const express = require('express');
const router = express.Router();
const queries = require('../db/queries');
const fetch = require('node-fetch');
const { generateCallSummary } = require('../services/callSummaryService');

// =============================================================================
// GET /api/calls — list calls with cursor pagination
// =============================================================================
router.get('/', async (req, res) => {
    try {
        const {
            cursor,
            limit = 50,
            status,
            has_recording,
            has_transcript,
            contact_id,
        } = req.query;

        const companyId = req.companyFilter?.company_id;
        const result = await queries.getCalls({
            cursor: cursor ? parseInt(cursor) : undefined,
            limit: Math.min(parseInt(limit) || 50, 200),
            status: status || undefined,
            hasRecording: has_recording === 'true' ? true : undefined,
            hasTranscript: has_transcript === 'true' ? true : undefined,
            contactId: contact_id ? parseInt(contact_id) : undefined,
            companyId,
        });

        res.json({
            calls: result.calls.map(formatCall),
            next_cursor: result.nextCursor,
            count: result.calls.length,
        });
    } catch (error) {
        console.error('Error fetching calls:', error);
        res.status(500).json({ error: 'Failed to fetch calls' });
    }
});

// =============================================================================
// GET /api/calls/active — active (non-final) calls
// =============================================================================
router.get('/active', async (req, res) => {
    try {
        const calls = await queries.getActiveCalls(req.companyFilter?.company_id);
        res.json({
            active_calls: calls.map(formatCall),
            count: calls.length,
        });
    } catch (error) {
        console.error('Error fetching active calls:', error);
        res.status(500).json({ error: 'Failed to fetch active calls' });
    }
});

// =============================================================================
// GET /api/calls/by-contact — grouped by contact (conversations replacement)
// =============================================================================
router.get('/by-contact', async (req, res) => {
    try {
        const { limit = 20, offset = 0, search } = req.query;
        const companyId = req.companyFilter?.company_id;
        const calls = await queries.getCallsByContact({
            limit: parseInt(limit),
            offset: parseInt(offset),
            companyId,
            search: search || null,
        });
        const total = await queries.getContactsWithCallsCount(companyId);

        // Format calls first
        let conversations = calls.map(c => ({
            ...formatCall(c),
            call_count: parseInt(c.call_count || 0),
        }));

        // Enrich with SMS data: find latest SMS for each contact's phone
        try {
            // Normalize phones to digits-only for comparison
            // (contacts may store "+1 (401) 602-3506", SMS stores "+14016023506")
            const phoneMap = {}; // digits → original phone
            for (const c of conversations) {
                const raw = c.contact?.phone_e164;
                if (raw) {
                    const digits = raw.replace(/\D/g, '');
                    phoneMap[digits] = raw;
                }
            }
            const digitPhones = Object.keys(phoneMap);

            if (digitPhones.length > 0) {
                const db = require('../db/connection');
                const smsResult = await db.query(
                    `SELECT customer_e164,
                            regexp_replace(customer_e164, '\\D', '', 'g') as customer_digits,
                            last_message_at,
                            last_message_direction,
                            last_message_preview,
                            (SELECT COUNT(*) FROM sms_messages m
                             JOIN sms_conversations sc2 ON sc2.id = m.conversation_id
                             WHERE sc2.customer_e164 = sc.customer_e164) as sms_count
                     FROM sms_conversations sc
                     WHERE regexp_replace(customer_e164, '\\D', '', 'g') = ANY($1)`,
                    [digitPhones]
                );

                // Build digits → SMS data map
                const smsMap = {};
                for (const row of smsResult.rows) {
                    const digits = row.customer_digits;
                    const existing = smsMap[digits];
                    if (!existing || (row.last_message_at && (!existing.last_message_at || new Date(row.last_message_at) > new Date(existing.last_message_at)))) {
                        smsMap[digits] = row;
                    }
                }

                // Merge SMS data into conversations
                for (const conv of conversations) {
                    const raw = conv.contact?.phone_e164;
                    const digits = raw ? raw.replace(/\D/g, '') : null;
                    const sms = digits ? smsMap[digits] : null;
                    const callTime = new Date(conv.started_at || conv.created_at);
                    const smsTime = sms?.last_message_at ? new Date(sms.last_message_at) : null;

                    conv.sms_count = sms ? parseInt(sms.sms_count || 0) : 0;

                    if (smsTime && smsTime > callTime) {
                        // SMS is the most recent interaction
                        conv.last_interaction_at = sms.last_message_at;
                        conv.last_interaction_type = sms.last_message_direction === 'inbound' ? 'sms_inbound' : 'sms_outbound';
                    } else {
                        // Call is the most recent interaction
                        conv.last_interaction_at = conv.started_at || conv.created_at;
                        conv.last_interaction_type = 'call';
                    }
                }
            }
        } catch (smsErr) {
            console.warn('[by-contact] SMS enrichment failed, using call-only order:', smsErr.message);
            // Fallback: just set call-only interaction data
            for (const conv of conversations) {
                conv.last_interaction_at = conv.started_at || conv.created_at;
                conv.last_interaction_type = 'call';
                conv.sms_count = 0;
            }
        }

        // =====================================================================
        // Add SMS-only contacts (those with SMS but NO calls)
        // =====================================================================
        try {
            const existingDigits = new Set();
            for (const c of conversations) {
                // Track all phone formats from existing call-based contacts
                const raw = c.contact?.phone_e164;
                if (raw) existingDigits.add(raw.replace(/\D/g, ''));
                if (c.from_number) existingDigits.add(c.from_number.replace(/\D/g, ''));
                if (c.to_number) existingDigits.add(c.to_number.replace(/\D/g, ''));
            }

            const db = require('../db/connection');
            // Find SMS conversations that don't match any existing contact phone
            const smsOnlyResult = await db.query(
                `SELECT sc.*,
                        regexp_replace(sc.customer_e164, '\\D', '', 'g') as customer_digits,
                        (SELECT COUNT(*) FROM sms_messages m
                         WHERE m.conversation_id = sc.id) as sms_count
                 FROM sms_conversations sc
                 ORDER BY sc.last_message_at DESC NULLS LAST
                 LIMIT 200`
            );

            for (const smsRow of smsOnlyResult.rows) {
                const digits = smsRow.customer_digits;
                if (existingDigits.has(digits)) continue; // already in call-based results
                existingDigits.add(digits); // prevent duplicates from multiple sms_conversations

                // Apply search filter to SMS-only contacts too
                if (search) {
                    const searchTerm = search.trim().toLowerCase();
                    const searchDigits = searchTerm.replace(/\D/g, '');
                    let matches = false;
                    // Phone digits match
                    if (searchDigits.length > 0 && digits.includes(searchDigits)) matches = true;
                    // Friendly name match
                    if (smsRow.friendly_name && smsRow.friendly_name.toLowerCase().includes(searchTerm)) matches = true;
                    // Customer phone match (formatted)
                    if (smsRow.customer_e164 && smsRow.customer_e164.toLowerCase().includes(searchTerm)) matches = true;
                    if (!matches) continue;
                }

                // Resolve or create contact
                let contact = null;
                try {
                    contact = await queries.findOrCreateContact(smsRow.customer_e164);
                } catch (e) {
                    console.warn('[by-contact] Failed to resolve SMS-only contact:', e.message);
                }

                // Build a synthetic conversation entry with no call data
                conversations.push({
                    id: null,
                    call_sid: null,
                    direction: smsRow.last_message_direction === 'inbound' ? 'inbound' : 'outbound',
                    from_number: smsRow.customer_e164,
                    to_number: smsRow.proxy_e164 || '',
                    status: 'completed',
                    is_final: true,
                    started_at: smsRow.last_message_at,
                    ended_at: null,
                    duration_sec: null,
                    created_at: smsRow.created_at,
                    updated_at: smsRow.updated_at,
                    contact: contact ? {
                        id: contact.id,
                        phone_e164: contact.phone_e164,
                        full_name: contact.full_name,
                        email: contact.email,
                        created_at: contact.created_at,
                        updated_at: contact.updated_at,
                    } : null,
                    call_count: 0,
                    sms_count: parseInt(smsRow.sms_count || 0),
                    last_interaction_at: smsRow.last_message_at,
                    last_interaction_type: smsRow.last_message_direction === 'inbound' ? 'sms_inbound' : 'sms_outbound',
                });
            }
        } catch (smsOnlyErr) {
            console.warn('[by-contact] SMS-only contacts failed:', smsOnlyErr.message);
        }

        // Enrich with has_unread from BOTH sms_conversations AND contacts tables
        try {
            const dbConn = require('../db/connection');

            // 1) SMS unread: from sms_conversations
            const phoneNumbers = conversations
                .map(c => c.contact?.phone_e164 || c.from_number)
                .filter(Boolean);
            const smsUnreadMap = {};
            const convIdMap = {};
            if (phoneNumbers.length > 0) {
                const smsResult = await dbConn.query(
                    `SELECT id, customer_e164, has_unread FROM sms_conversations WHERE customer_e164 = ANY($1)`,
                    [phoneNumbers]
                );
                for (const row of smsResult.rows) {
                    smsUnreadMap[row.customer_e164] = row.has_unread;
                    convIdMap[row.customer_e164] = row.id;
                }
            }

            // 2) Call unread: from contacts
            const contactIds = conversations
                .map(c => c.contact?.id)
                .filter(Boolean);
            const contactUnreadMap = {};
            if (contactIds.length > 0) {
                const contactResult = await dbConn.query(
                    `SELECT id, has_unread FROM contacts WHERE id = ANY($1)`,
                    [contactIds]
                );
                for (const row of contactResult.rows) {
                    contactUnreadMap[row.id] = row.has_unread;
                }
            }

            // 3) Merge: unread if EITHER source says so
            for (const conv of conversations) {
                const phone = conv.contact?.phone_e164 || conv.from_number || '';
                const cid = conv.contact?.id;
                const smsUnread = phone ? (smsUnreadMap[phone] || false) : false;
                const contactUnread = cid ? (contactUnreadMap[cid] || false) : false;
                conv.has_unread = smsUnread || contactUnread;
                conv.sms_conversation_id = phone ? (convIdMap[phone] || null) : null;
            }
        } catch (e) {
            console.warn('[by-contact] Unread enrichment failed:', e.message);
        }

        // Final dedup by contact phone digits (keeps entry with most calls)
        {
            const beforeCount = conversations.length;
            const seen = new Map(); // digits → index
            const deduped = [];
            for (const conv of conversations) {
                const raw = conv.contact?.phone_e164 || conv.from_number || '';
                const digits = raw.replace(/\D/g, '');
                if (!digits) { deduped.push(conv); continue; }
                const existing = seen.get(digits);
                if (existing !== undefined) {
                    console.log('[by-contact] DEDUP: removing duplicate', digits, 'idx', deduped.length);
                    // Keep the one with more calls (prefer call-based over SMS-only)
                    if ((conv.call_count || 0) > (deduped[existing].call_count || 0)) {
                        // Merge SMS data into the better entry
                        deduped[existing] = { ...conv, sms_count: Math.max(conv.sms_count || 0, deduped[existing].sms_count || 0) };
                    } else {
                        deduped[existing].sms_count = Math.max(conv.sms_count || 0, deduped[existing].sms_count || 0);
                    }
                } else {
                    seen.set(digits, deduped.length);
                    deduped.push(conv);
                }
            }
            console.log(`[by-contact] DEDUP: ${beforeCount} -> ${deduped.length} (removed ${beforeCount - deduped.length})`);
            conversations = deduped;
        }

        // Final sort: unread first, then by last interaction (most recent first)
        conversations.sort((a, b) => {
            if (a.has_unread !== b.has_unread) return a.has_unread ? -1 : 1;
            const ta = new Date(a.last_interaction_at || 0);
            const tb = new Date(b.last_interaction_at || 0);
            return tb - ta;
        });

        res.json({
            conversations,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset),
        });
    } catch (error) {
        console.error('Error fetching calls by contact:', error);
        res.status(500).json({ error: 'Failed to fetch calls by contact' });
    }
});

// =============================================================================
// POST /api/calls/contact/:contactId/mark-read — team-wide mark read
// =============================================================================
router.post('/contact/:contactId/mark-read', async (req, res) => {
    try {
        const { contactId } = req.params;
        console.log(`[MARK-READ-DEBUG] POST /contact/${contactId}/mark-read called`, {
            referer: req.headers.referer || req.headers.referrer,
            origin: req.headers.origin,
            userAgent: (req.headers['user-agent'] || '').substring(0, 80),
        });
        const contact = await queries.markContactRead(parseInt(contactId));
        if (!contact) {
            return res.status(404).json({ error: 'Contact not found' });
        }
        // SSE broadcast so all users see the read state
        const realtimeService = require('../services/realtimeService');
        realtimeService.broadcast('contact.read', { contactId: parseInt(contactId) });
        res.json({ contact });
    } catch (error) {
        console.error('Error marking contact read:', error);
        res.status(500).json({ error: 'Failed to mark contact read' });
    }
});

// =============================================================================
// GET /api/calls/contact/:contactId — all calls for a contact
// =============================================================================
router.get('/contact/:contactId', async (req, res) => {
    try {
        const calls = await queries.getCallsByContactId(parseInt(req.params.contactId));
        res.json({ calls: calls.map(formatCall), count: calls.length });
    } catch (error) {
        console.error('Error fetching contact calls:', error);
        res.status(500).json({ error: 'Failed to fetch contact calls' });
    }
});

// =============================================================================
// GET /api/calls/:callSid — single call detail
// =============================================================================
router.get('/:callSid', async (req, res) => {
    try {
        const call = await queries.getCallByCallSid(req.params.callSid, req.companyFilter?.company_id);
        if (!call) {
            return res.status(404).json({ error: 'Call not found' });
        }
        res.json({ call: formatCall(call) });
    } catch (error) {
        console.error('Error fetching call:', error);
        res.status(500).json({ error: 'Failed to fetch call' });
    }
});

// =============================================================================
// GET /api/calls/:callSid/recording.mp3 — proxy audio from Twilio
// =============================================================================
router.get('/:callSid/recording.mp3', async (req, res) => {
    try {
        const media = await queries.getCallMedia(req.params.callSid);
        const recording = media.recordings?.[0];

        if (!recording || recording.status !== 'completed') {
            return res.status(404).json({ error: 'Recording not available' });
        }

        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;

        if (!accountSid || !authToken) {
            return res.status(500).json({ error: 'Twilio credentials not configured' });
        }

        // Twilio REST API for recording media
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recording.recording_sid}.mp3`;
        const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

        const twilioRes = await fetch(twilioUrl, {
            headers: { 'Authorization': authHeader },
            redirect: 'follow',
        });

        if (!twilioRes.ok) {
            console.error(`Twilio recording fetch failed: ${twilioRes.status}`);
            return res.status(502).json({ error: 'Failed to fetch recording from Twilio' });
        }

        res.set('Content-Type', 'audio/mpeg');
        res.set('Accept-Ranges', 'bytes');
        if (twilioRes.headers.get('content-length')) {
            res.set('Content-Length', twilioRes.headers.get('content-length'));
        }

        twilioRes.body.pipe(res);
    } catch (error) {
        console.error('Error proxying recording:', error);
        res.status(500).json({ error: 'Failed to proxy recording' });
    }
});

// =============================================================================
// GET /api/calls/:callSid/media — recordings + transcripts (structured)
// =============================================================================
router.get('/:callSid/media', async (req, res) => {
    try {
        const callSid = req.params.callSid;
        const media = await queries.getCallMedia(callSid);
        const recording = media.recordings?.[0];
        // Prefer the completed transcript over processing/enqueued ones
        const transcript = media.transcripts?.find(t => t.status === 'completed') || media.transcripts?.[0];

        res.json({
            callSid,
            recording: recording ? {
                recordingSid: recording.recording_sid,
                status: recording.status,
                playbackUrl: recording.status === 'completed' ? `/api/calls/${callSid}/recording.mp3` : null,
                durationSec: recording.duration_sec,
                channels: recording.channels,
            } : null,
            transcript: transcript ? (() => {
                let payload = {};
                try {
                    payload = typeof transcript.raw_payload === 'string'
                        ? JSON.parse(transcript.raw_payload)
                        : (transcript.raw_payload || {});
                } catch { payload = {}; }
                return {
                    status: transcript.status,
                    text: transcript.text,
                    confidence: transcript.confidence,
                    languageCode: transcript.language_code,
                    updatedAt: transcript.updated_at,
                    entities: payload.entities || [],
                    sentimentScore: payload.sentimentScore ?? null,
                    gemini_summary: payload.gemini_summary || null,
                    gemini_entities: payload.gemini_entities || [],
                    gemini_generated_at: payload.gemini_generated_at || null,
                };
            })() : null,
        });
    } catch (error) {
        console.error('Error fetching call media:', error);
        res.status(500).json({ error: 'Failed to fetch call media' });
    }
});

// =============================================================================
// POST /api/calls/:callSid/transcribe — generate transcription via AssemblyAI
// =============================================================================
router.post('/:callSid/transcribe', async (req, res) => {
    const callSid = req.params.callSid;
    try {
        const apiKey = process.env.ASSEMBLYAI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not configured' });
        }

        // 1. Get recording for this call
        const media = await queries.getCallMedia(callSid);
        const recording = media.recordings?.[0];
        if (!recording || recording.status !== 'completed') {
            return res.status(404).json({ error: 'No completed recording found for this call' });
        }

        // 2. Check if transcript already exists
        if (media.transcripts?.length > 0 && media.transcripts[0].status === 'completed') {
            return res.json({ status: 'already_exists', transcript: media.transcripts[0].text });
        }

        // 3. Build Twilio recording URL (direct, authenticated)
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recording.recording_sid}.mp3`;

        // 4. Download audio from Twilio into a buffer
        const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        const audioRes = await fetch(twilioUrl, {
            headers: { 'Authorization': authHeader },
            redirect: 'follow',
        });
        if (!audioRes.ok) {
            return res.status(502).json({ error: `Failed to fetch recording from Twilio: ${audioRes.status}` });
        }
        const audioBuffer = await audioRes.buffer();

        // 5. Upload audio to AssemblyAI
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
            return res.status(502).json({ error: `AssemblyAI upload failed: ${err}` });
        }
        const { upload_url } = await uploadRes.json();

        // 6. Submit transcription job
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
                entity_detection: true,
                sentiment_analysis: true,
            }),
        });
        if (!transcriptRes.ok) {
            const err = await transcriptRes.text();
            return res.status(502).json({ error: `AssemblyAI transcription submit failed: ${err}` });
        }
        const job = await transcriptRes.json();

        // 7. Poll for completion (max ~3 minutes)
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
            return res.status(500).json({ error: `Transcription failed: ${result.error}` });
        }
        if (result.status !== 'completed') {
            return res.status(504).json({ error: 'Transcription timed out' });
        }

        // 8. Format as dialog from utterances (Speaker A / Speaker B)
        let dialogText = result.text; // fallback
        if (result.utterances && result.utterances.length > 0) {
            dialogText = result.utterances
                .map(u => `Speaker ${u.speaker}: ${u.text}`)
                .join('\n\n');
        }

        // 9. Extract entities
        const entities = (result.entities || []).map(e => ({
            entity_type: e.entity_type,
            text: e.text,
            start: e.start,  // ms
            end: e.end,      // ms
        }));

        // 10. Compute overall sentiment score (-1 to +1)
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

        // 10. Generate Gemini summary (non-blocking — if it fails, we still save transcript)
        let geminiSummary = null;
        let geminiEntities = [];
        let geminiGeneratedAt = null;
        try {
            console.log(`[Transcribe] Generating Gemini summary for ${callSid}...`);
            const summaryResult = await generateCallSummary(dialogText, {
                callerPhone: req.body?.callerPhone || null,
                callTime: req.body?.callTime || null,
            });
            if (summaryResult && !summaryResult.error) {
                geminiSummary = summaryResult.summary;
                geminiEntities = summaryResult.entities;
                geminiGeneratedAt = new Date().toISOString();
                console.log(`[Transcribe] Gemini summary OK for ${callSid}: ${geminiSummary?.length} chars, ${geminiEntities.length} entities`);
            } else {
                console.warn(`[Transcribe] Gemini summary skipped for ${callSid}: ${summaryResult?.error}`);
            }
        } catch (geminiErr) {
            console.error(`[Transcribe] Gemini summary failed for ${callSid}:`, geminiErr.message);
        }

        // 11. Save to DB (entities + gemini data stored in raw_payload)
        const transcriptionSid = `aai_${job.id}`;
        await queries.upsertTranscript({
            transcriptionSid,
            callSid,
            recordingSid: recording.recording_sid,
            mode: 'post-call',
            status: 'completed',
            languageCode: result.language_code || null,
            confidence: result.confidence || null,
            text: dialogText,
            isFinal: true,
            rawPayload: {
                assemblyai_id: job.id,
                entities,
                sentimentScore,
                gemini_summary: geminiSummary,
                gemini_entities: geminiEntities,
                gemini_generated_at: geminiGeneratedAt,
            },
        });

        console.log(`✅ Transcription completed for ${callSid}: ${dialogText?.length} chars, ${result.utterances?.length || 0} utterances, ${entities.length} entities, sentiment=${sentimentScore}`);
        res.json({
            status: 'completed',
            transcript: dialogText,
            entities,
            sentimentScore,
            gemini_summary: geminiSummary,
            gemini_entities: geminiEntities,
        });
    } catch (error) {
        console.error(`Error transcribing call ${callSid}:`, error);
        res.status(500).json({ error: 'Failed to generate transcription' });
    }
});

// =============================================================================
// POST /api/calls/:callSid/summarize — (re-)generate Gemini summary
// =============================================================================
router.post('/:callSid/summarize', async (req, res) => {
    const callSid = req.params.callSid;
    try {
        // 1. Load existing transcript
        const media = await queries.getCallMedia(callSid);
        const transcript = media.transcripts?.[0];
        if (!transcript || transcript.status !== 'completed' || !transcript.text) {
            return res.status(404).json({ error: 'No completed transcript found for this call' });
        }

        // 2. Call Gemini
        const summaryResult = await generateCallSummary(transcript.text, {
            callerPhone: req.body?.callerPhone || null,
            callTime: req.body?.callTime || null,
        });

        if (summaryResult.error) {
            return res.status(502).json({ error: `Summary generation failed: ${summaryResult.error}` });
        }

        // 3. Update raw_payload in existing transcript
        let existingPayload = {};
        try {
            existingPayload = typeof transcript.raw_payload === 'string'
                ? JSON.parse(transcript.raw_payload)
                : (transcript.raw_payload || {});
        } catch { existingPayload = {}; }

        existingPayload.gemini_summary = summaryResult.summary;
        existingPayload.gemini_entities = summaryResult.entities;
        existingPayload.gemini_generated_at = new Date().toISOString();

        await queries.upsertTranscript({
            transcriptionSid: transcript.transcription_sid,
            callSid,
            recordingSid: transcript.recording_sid,
            mode: transcript.mode || 'post-call',
            status: transcript.status,
            languageCode: transcript.language_code,
            confidence: transcript.confidence,
            text: transcript.text,
            isFinal: true,
            rawPayload: existingPayload,
        });

        console.log(`✅ Gemini summary (re-)generated for ${callSid}: ${summaryResult.summary?.length} chars, ${summaryResult.entities.length} entities`);
        res.json({
            status: 'completed',
            gemini_summary: summaryResult.summary,
            gemini_entities: summaryResult.entities,
        });
    } catch (error) {
        console.error(`Error generating summary for ${callSid}:`, error);
        res.status(500).json({ error: 'Failed to generate summary' });
    }
});

// =============================================================================
// GET /api/calls/:callSid/events — event history
// =============================================================================
router.get('/:callSid/events', async (req, res) => {
    try {
        const events = await queries.getCallEvents(req.params.callSid);
        res.json({ events, count: events.length });
    } catch (error) {
        console.error('Error fetching call events:', error);
        res.status(500).json({ error: 'Failed to fetch call events' });
    }
});

// =============================================================================
// GET /api/health/sync — sync health dashboard
// =============================================================================
router.get('/health/sync', async (req, res) => {
    try {
        const health = await queries.getSyncHealth();
        res.json(health);
    } catch (error) {
        console.error('Error fetching sync health:', error);
        res.status(500).json({ error: 'Failed to fetch sync health' });
    }
});

// =============================================================================
// Format call for API response
// =============================================================================
function formatCall(row) {
    const call = {
        id: row.id,
        call_sid: row.call_sid,
        parent_call_sid: row.parent_call_sid,
        direction: row.direction,
        from_number: row.from_number,
        to_number: row.to_number,
        status: row.status,
        is_final: row.is_final,
        started_at: row.started_at,
        answered_at: row.answered_at,
        ended_at: row.ended_at,
        duration_sec: row.duration_sec,
        price: row.price,
        price_unit: row.price_unit,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };

    // Include recording data if joined
    if (row.recording_sid) {
        call.recording = {
            recording_sid: row.recording_sid,
            status: row.recording_status,
            playback_url: row.recording_status === 'completed' ? `/api/calls/${row.call_sid}/recording.mp3` : null,
            duration_sec: row.recording_duration_sec,
        };
    }

    // Include transcript data if joined
    if (row.transcript_status) {
        call.transcript = {
            status: row.transcript_status,
            text: row.transcript_text,
        };
    }

    // Include contact if joined
    if (row.contact) {
        call.contact = typeof row.contact === 'string' ? JSON.parse(row.contact) : row.contact;
    }

    // Include call_count if present (from by-contact query)
    if (row.call_count !== undefined) {
        call.call_count = parseInt(row.call_count);
    }

    return call;
}

module.exports = router;
