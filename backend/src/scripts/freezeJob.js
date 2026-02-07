#!/usr/bin/env node

/**
 * Freeze Job
 * 
 * Automatically freezes final calls that have exceeded the cooldown period.
 * Frozen calls are excluded from hot/warm reconciliation to save API quota.
 * 
 * Usage:
 *   node backend/src/scripts/freezeJob.js
 * 
 * Environment variables:
 *   FREEZE_COOLDOWN_HOURS - Hours after finalization to freeze (default: 6)
 *   FREEZE_BATCH_SIZE - Number of calls to process per run (default: 100)
 */

require('dotenv').config();
const db = require('../db/connection');
const { shouldFreeze } = require('../services/stateMachine');

const COOLDOWN_HOURS = parseInt(process.env.FREEZE_COOLDOWN_HOURS || '6');
const BATCH_SIZE = parseInt(process.env.FREEZE_BATCH_SIZE || '100');

async function runFreezeJob() {
    console.log('🧊 Starting freeze job...');
    console.log(`   Cooldown: ${COOLDOWN_HOURS} hours`);
    console.log(`   Batch size: ${BATCH_SIZE}`);

    try {
        // Find final calls that should be frozen
        const result = await db.query(`
            UPDATE messages
            SET sync_state = 'frozen'
            WHERE id IN (
                SELECT id FROM messages
                WHERE is_final = true
                  AND finalized_at < NOW() - INTERVAL '${COOLDOWN_HOURS} hours'
                  AND (sync_state IS NULL OR sync_state = 'active')
                ORDER BY finalized_at
                LIMIT $1
            )
            RETURNING id, twilio_sid, status, finalized_at
        `, [BATCH_SIZE]);

        const frozenCount = result.rows.length;

        if (frozenCount > 0) {
            console.log(`✅ Froze ${frozenCount} calls:`);
            result.rows.forEach(call => {
                const age = Math.round((Date.now() - new Date(call.finalized_at)) / (1000 * 60 * 60));
                console.log(`   - ${call.twilio_sid}: ${call.status} (finalized ${age}h ago)`);
            });
        } else {
            console.log('   No calls to freeze');
        }

        // Stats
        const stats = await db.query(`
            SELECT 
                sync_state,
                COUNT(*) as count
            FROM messages
            WHERE is_final = true
            GROUP BY sync_state
        `);

        console.log('\n📊 Final call stats:');
        stats.rows.forEach(row => {
            console.log(`   ${row.sync_state || 'active'}: ${row.count}`);
        });

        await db.pool.end();
        console.log('\n✅ Freeze job completed');
        process.exit(0);

    } catch (error) {
        console.error('❌ Freeze job failed:', error);
        await db.pool.end();
        process.exit(1);
    }
}

runFreezeJob();
