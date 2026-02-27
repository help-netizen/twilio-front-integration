// Temp script to diagnose stale ringing call on production
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

(async () => {
    const sid = 'CA29c52e2d6e3145cb9ed17eed3551e04a';

    // 1. Call events 
    console.log('=== CALL EVENTS ===');
    const events = await pool.query(
        `SELECT event_type, event_time, 
            payload->>'CallStatus' as twilio_status,
            payload->>'SequenceNumber' as seq
     FROM call_events WHERE call_sid = $1 ORDER BY event_time ASC`,
        [sid]
    );
    events.rows.forEach(x => console.log(JSON.stringify(x)));
    console.log('Total events:', events.rows.length);

    // 2. Child legs
    console.log('\n=== CHILD LEGS ===');
    const children = await pool.query(
        `SELECT call_sid, status, is_final, from_number, to_number, started_at, ended_at, duration_sec
     FROM calls WHERE parent_call_sid = $1 ORDER BY started_at ASC`,
        [sid]
    );
    children.rows.forEach(x => console.log(JSON.stringify(x)));
    console.log('Total children:', children.rows.length);

    // 3. Webhook inbox
    console.log('\n=== WEBHOOK INBOX ===');
    const inbox = await pool.query(
        `SELECT id, event_type, status,
            payload->>'CallStatus' as twilio_status,
            received_at, processed_at, error_text
     FROM webhook_inbox WHERE call_sid = $1 ORDER BY received_at ASC`,
        [sid]
    );
    inbox.rows.forEach(x => console.log(JSON.stringify(x)));
    console.log('Total inbox events:', inbox.rows.length);

    // 4. ALL non-final calls
    console.log('\n=== ALL NON-FINAL ACTIVE CALLS ===');
    const nf = await pool.query(
        `SELECT call_sid, status, from_number, to_number, started_at, parent_call_sid
     FROM calls WHERE is_final = false 
     AND status IN ('initiated','ringing','in-progress','queued')
     ORDER BY started_at DESC LIMIT 10`
    );
    nf.rows.forEach(x => console.log(JSON.stringify(x)));
    console.log('Total non-final:', nf.rows.length);

    await pool.end();
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
