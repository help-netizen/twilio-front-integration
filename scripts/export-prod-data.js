// export-prod-data.js — Run on prod via: fly ssh console -a abc-metrics -C "node -" < scripts/export-prod-data.js
// Exports: last 100 calls + 100 SMS conversations, ALL leads/jobs/estimates/invoices/payments.
const { Pool } = require('pg');

// Return raw strings for all PG types — avoids Date coercion, JSON parsing issues
const types = require('pg').types;
for (let oid = 1; oid < 15000; oid++) types.setTypeParser(oid, v => v);

const CID = '00000000-0000-0000-0000-000000000001';

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (sql) => pool.query(sql).then(r => r.rows);
  const log = (name, arr) => { process.stderr.write(`  ${name}: ${arr.length}\n`); return arr; };

  try {
    // === ALL contacts (needed for leads, jobs, estimates FK) ===
    const contacts = log('contacts', await q(`SELECT * FROM contacts WHERE company_id = '${CID}'`));

    // === ALL timelines ===
    const timelines = log('timelines', await q(`SELECT * FROM timelines WHERE company_id = '${CID}'`));

    // === Last 100 parent calls + their children ===
    const parentCalls = await q(`
      SELECT * FROM calls WHERE company_id = '${CID}' AND parent_call_sid IS NULL
      ORDER BY started_at DESC NULLS LAST LIMIT 100
    `);
    const parentSids = parentCalls.map(c => c.call_sid);
    const childCalls = parentSids.length ? await q(`
      SELECT * FROM calls WHERE company_id = '${CID}'
        AND parent_call_sid IN (${parentSids.map(s => `'${s}'`).join(',')})
    `) : [];
    const calls = [...parentCalls, ...childCalls];
    log('calls', calls);

    const allSids = calls.map(c => c.call_sid);

    // Recordings & transcripts for these calls
    const recordings = log('recordings', allSids.length ? await q(`
      SELECT * FROM recordings WHERE company_id = '${CID}'
        AND call_sid IN (${allSids.map(s => `'${s}'`).join(',')})
    `) : []);

    const transcripts = log('transcripts', allSids.length ? await q(`
      SELECT * FROM transcripts WHERE company_id = '${CID}'
        AND call_sid IN (${allSids.map(s => `'${s}'`).join(',')})
    `) : []);

    // === Last 100 SMS conversations + messages + media ===
    const smsConversations = log('sms_conversations', await q(`
      SELECT * FROM sms_conversations WHERE company_id = '${CID}'
      ORDER BY last_message_at DESC NULLS LAST LIMIT 100
    `));

    const smsMessages = log('sms_messages', smsConversations.length ? await q(`
      SELECT * FROM sms_messages WHERE company_id = '${CID}'
        AND conversation_id IN (${smsConversations.map(c => `'${c.id}'`).join(',')})
    `) : []);

    const smsMedia = log('sms_media', smsMessages.length ? await q(`
      SELECT * FROM sms_media WHERE message_id IN (${smsMessages.map(m => `'${m.id}'`).join(',')})
    `) : []);

    // === ALL leads ===
    const leads = log('leads', await q(`SELECT * FROM leads WHERE company_id = '${CID}'`));

    // === ALL jobs ===
    const jobs = log('jobs', await q(`SELECT * FROM jobs WHERE company_id = '${CID}'`));

    // === ALL estimates + items ===
    const estimates = log('estimates', await q(`SELECT * FROM estimates WHERE company_id = '${CID}'`));
    const estIds = estimates.map(e => e.id);
    const estimateItems = log('estimate_items', estIds.length ? await q(`
      SELECT * FROM estimate_items WHERE estimate_id IN (${estIds.join(',')})
    `) : []);

    // === ALL invoices + items ===
    const invoices = log('invoices', await q(`SELECT * FROM invoices WHERE company_id = '${CID}'`));
    const invIds = invoices.map(i => i.id);
    const invoiceItems = log('invoice_items', invIds.length ? await q(`
      SELECT * FROM invoice_items WHERE invoice_id IN (${invIds.join(',')})
    `) : []);

    // === ALL payment transactions ===
    const payments = log('payment_transactions', await q(`SELECT * FROM payment_transactions WHERE company_id = '${CID}'`));

    // === CRM users & memberships (for owner refs) ===
    const crmUsers = log('crm_users', await q(`SELECT * FROM crm_users`));
    const memberships = log('company_memberships', await q(`SELECT * FROM company_memberships WHERE company_id = '${CID}'`));

    // Output — order = FK-safe import order
    const data = {
      crm_users: crmUsers,
      company_memberships: memberships,
      contacts,
      timelines,
      calls,
      recordings,
      transcripts,
      leads,
      jobs,
      estimates,
      estimate_items: estimateItems,
      invoices,
      invoice_items: invoiceItems,
      payment_transactions: payments,
      sms_conversations: smsConversations,
      sms_messages: smsMessages,
      sms_media: smsMedia,
    };

    process.stdout.write(JSON.stringify(data));
  } catch (e) {
    process.stderr.write('ERROR: ' + e.message + '\n');
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
