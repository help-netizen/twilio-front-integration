/**
 * Backfill script: re-generate Gemini summaries for calls where
 * gemini_summary was stored as raw truncated JSON (starts with '{').
 *
 * Usage: node backend/src/cli/backfill_broken_summaries.js
 */
const db = require('../db/connection');
const { generateCallSummary } = require('../services/callSummaryService');

async function main() {
    console.log('[Backfill] Finding calls with broken gemini_summary...');

    const { rows } = await db.query(`
        SELECT id, call_sid, text, raw_payload
        FROM transcripts
        WHERE status = 'completed'
          AND raw_payload->>'gemini_summary' LIKE '{%'
        ORDER BY id
    `);

    console.log(`[Backfill] Found ${rows.length} affected calls`);

    for (const row of rows) {
        const { id, call_sid, text, raw_payload } = row;
        console.log(`\n[Backfill] Processing ${call_sid} (id=${id})...`);

        if (!text || text.trim().length === 0) {
            console.log(`  ⏭ No transcript text, skipping`);
            continue;
        }

        try {
            const result = await generateCallSummary(text);
            if (result.error) {
                console.warn(`  ⚠ Gemini error: ${result.error}`);
                continue;
            }

            // Update raw_payload with corrected gemini data
            const updatedPayload = {
                ...raw_payload,
                gemini_summary: result.summary,
                gemini_entities: result.entities,
                gemini_generated_at: new Date().toISOString(),
            };

            await db.query(
                `UPDATE transcripts SET raw_payload = $1, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify(updatedPayload), id]
            );

            console.log(`  ✅ Fixed: summary=${result.summary?.length} chars, ${result.entities?.length} entities`);
        } catch (err) {
            console.error(`  ❌ Failed: ${err.message}`);
        }

        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log('\n[Backfill] Done!');
    process.exit(0);
}

main().catch(err => {
    console.error('[Backfill] Fatal error:', err);
    process.exit(1);
});
