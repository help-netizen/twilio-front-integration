/**
 * Migration Script: Fix Call Directions and Statuses
 * 
 * Reprocesses all existing calls using the new CallProcessor microservice
 * to fix direction swapping and incorrect status display issues.
 * 
 * Usage:
 *   node backend/src/scripts/fixCallData.js
 */

const CallProcessor = require('../services/callProcessor');
const db = require('../db/connection');

async function fixAllCalls() {
    console.log('🔧 Starting call data migration...\n');

    try {
        // Get all messages from database
        const result = await db.query(`
            SELECT id, twilio_sid, metadata, direction, status, from_number, to_number, duration, end_time
            FROM messages
            ORDER BY id
        `);

        const messages = result.rows;
        console.log(`📊 Found ${messages.length} calls to process\n`);

        let fixed = 0;
        let unchanged = 0;
        let errors = 0;

        for (const msg of messages) {
            try {
                // Reconstruct call data from database record
                const callData = {
                    sid: msg.twilio_sid,
                    from: msg.from_number,
                    to: msg.to_number,
                    direction: msg.metadata?.twilio_direction || msg.direction,
                    status: msg.metadata?.twilio_status || msg.status,
                    duration: msg.duration,
                    endTime: msg.end_time,
                    parentCallSid: msg.metadata?.parent_call_sid || null,
                    ...msg.metadata
                };

                // Process with new microservice
                const processed = CallProcessor.processCall(callData);

                // Check if changes are needed
                const directionChanged = processed.direction !== msg.direction;
                const statusChanged = processed.status !== msg.status;

                if (directionChanged || statusChanged) {
                    // Update record
                    await db.query(`
                        UPDATE messages
                        SET 
                            direction = $1,
                            status = $2,
                            metadata = jsonb_set(
                                jsonb_set(
                                    COALESCE(metadata, '{}'::jsonb),
                                    '{actual_direction}',
                                    to_jsonb($1::text)
                                ),
                                '{display_status}',
                                to_jsonb($2::text)
                            )
                        WHERE id = $3
                    `, [processed.direction, processed.status, msg.id]);

                    fixed++;
                    console.log(`✅ Fixed ${msg.twilio_sid}:`);
                    if (directionChanged) {
                        console.log(`   Direction: ${msg.direction} → ${processed.direction}`);
                    }
                    if (statusChanged) {
                        console.log(`   Status: ${msg.status} → ${processed.status}`);
                    }
                } else {
                    unchanged++;
                }

            } catch (error) {
                errors++;
                console.error(`❌ Error processing ${msg.twilio_sid}:`, error.message);
            }
        }

        console.log(`\n📈 Migration Summary:`);
        console.log(`   ✅ Fixed: ${fixed}`);
        console.log(`   ⏭️  Unchanged: ${unchanged}`);
        console.log(`   ❌ Errors: ${errors}`);
        console.log(`   📊 Total: ${messages.length}\n`);

        process.exit(0);
    } catch (error) {
        console.error('💥 Migration failed:', error);
        process.exit(1);
    }
}

// Run migration
fixAllCalls();
