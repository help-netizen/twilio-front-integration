const db = require('./src/db/connection');
const queries = require('./src/db/queries');

(async () => {
    try {
        const t0 = Date.now();
        const calls = await queries.getCallsByTimeline({ limit: 50, offset: 0 });
        const t1 = Date.now();
        console.log('1. getCallsByTimeline:', t1 - t0, 'ms, rows:', calls.length);

        const total = await queries.getTimelinesWithCallsCount();
        const t2 = Date.now();
        console.log('2. getTimelinesWithCallsCount:', t2 - t1, 'ms, total:', total);

        // SMS-only query
        const smsOnly = await db.query(
            'SELECT sc.*, sc.customer_digits FROM sms_conversations sc ORDER BY sc.last_message_at DESC NULLS LAST LIMIT 200'
        );
        const t3 = Date.now();
        console.log('3. SMS-only query:', t3 - t2, 'ms, rows:', smsOnly.rows.length);

        // Build existing digits set
        const existingDigits = new Set();
        for (const c of calls) {
            const tl = c.tl_phone || '';
            if (tl) existingDigits.add(tl.replace(/\D/g, ''));
            const cp = c.contact ? (typeof c.contact === 'string' ? JSON.parse(c.contact) : c.contact) : null;
            if (cp && cp.phone_e164) existingDigits.add(cp.phone_e164.replace(/\D/g, ''));
            if (cp && cp.secondary_phone) existingDigits.add(cp.secondary_phone.replace(/\D/g, ''));
            if (c.from_number) existingDigits.add(c.from_number.replace(/\D/g, ''));
            if (c.to_number) existingDigits.add(c.to_number.replace(/\D/g, ''));
        }

        // How many SMS-only need resolving?
        let needResolve = 0;
        for (const s of smsOnly.rows) {
            if (!s.customer_digits || existingDigits.has(s.customer_digits)) continue;
            needResolve++;
        }
        console.log('4. SMS-only needing resolution:', needResolve);

        // Resolve each sequentially
        const t4 = Date.now();
        const existingDigits2 = new Set(existingDigits);
        let resolved = 0;
        for (const s of smsOnly.rows) {
            if (!s.customer_digits || existingDigits2.has(s.customer_digits)) continue;
            existingDigits2.add(s.customer_digits);
            await queries.findContactByPhoneOrSecondary(s.customer_e164);
            await queries.findOrCreateTimeline(s.customer_e164, s.company_id);
            resolved++;
        }
        const t5 = Date.now();
        console.log('5. SMS-only resolve:', t5 - t4, 'ms for', resolved, 'items (' + (resolved > 0 ? Math.round((t5 - t4) / resolved) : 0) + 'ms each)');

        // Unread enrichment
        const cids = calls.map(c => c.contact_id).filter(Boolean);
        if (cids.length > 0) {
            await db.query('SELECT id, has_unread FROM contacts WHERE id = ANY($1)', [cids]);
        }
        const t6 = Date.now();
        console.log('6. Unread enrichment:', t6 - t5, 'ms');

        console.log('=== TOTAL:', t6 - t0, 'ms ===');
        process.exit(0);
    } catch (err) {
        console.error(err.message, err.stack);
        process.exit(1);
    }
})();
