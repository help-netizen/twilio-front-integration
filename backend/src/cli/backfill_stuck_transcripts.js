#!/usr/bin/env node

/**
 * Backfill Stuck Transcripts
 *
 * Finds all transcripts stuck in 'processing' state (no text),
 * and re-runs transcription via AssemblyAI (same as manual button).
 *
 * Usage:
 *   node backend/src/cli/backfill_stuck_transcripts.js
 *   fly ssh console -a abc-metrics -C "node src/cli/backfill_stuck_transcripts.js"
 */

require('dotenv').config();
const db = require('../db/connection');
const { transcribeCall } = require('../services/transcriptionService');

const MAX_DURATION_SEC = 600; // Skip recordings > 10 minutes
const DELAY_BETWEEN_MS = 2000; // 2s delay between calls to avoid rate limits

async function main() {
    console.log('🔍 Finding stuck transcripts (status=processing, no text)...');

    const result = await db.query(`
        SELECT t.call_sid, t.recording_sid, r.duration_sec
        FROM transcripts t
        JOIN recordings r ON r.recording_sid = t.recording_sid
        WHERE t.status = 'processing' AND t.text IS NULL
          AND COALESCE(r.duration_sec, 0) <= $1
        ORDER BY t.created_at ASC
    `, [MAX_DURATION_SEC]);

    console.log(`Found ${result.rows.length} stuck transcripts to backfill`);

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < result.rows.length; i++) {
        const { call_sid, recording_sid, duration_sec } = result.rows[i];
        const progress = `[${i + 1}/${result.rows.length}]`;

        try {
            console.log(`${progress} Transcribing ${call_sid} (recording: ${recording_sid}, duration: ${duration_sec}s)...`);
            const res = await transcribeCall(call_sid, recording_sid, `backfill-${i}`);
            if (res.status === 'already_exists') {
                console.log(`${progress} ⏭️  Already exists, skipped`);
                skipped++;
            } else {
                console.log(`${progress} ✅ Done`);
                success++;
            }
        } catch (err) {
            console.error(`${progress} ❌ Failed: ${err.message}`);
            failed++;
        }

        // Small delay between calls
        if (i < result.rows.length - 1) {
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_MS));
        }
    }

    console.log(`\n📊 Backfill complete: ${success} success, ${skipped} skipped, ${failed} failed`);
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
