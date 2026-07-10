#!/usr/bin/env node
/**
 * GMAIL-PUSH-FIX-001 — TC-GPF-007 LIVE push e2e smoke (DEPLOY-TIME, opt-in).
 *
 * The real proof that inbound email now arrives via the Gmail→Pub/Sub PUSH (seconds)
 * and not the ~10-minute reconciliation poll. Run ONCE, sequentially, from INSIDE the
 * prod app container AFTER the fix is deployed. Never in headless CI.
 *
 * What it does:
 *   1. Resolve a connected Gmail mailbox (argv[2] / PUSH_COMPANY_ID, else the most-
 *      recently-updated connected gmail mailbox).
 *   2. Build an authed Gmail client from the STORED OAuth token
 *      (emailMailboxService.getValidAccessToken + createOAuth2Client) — the same seam
 *      GmailProvider uses.
 *   3. Self-send a UNIQUE-subject email via the RAW Gmail API
 *      (users.messages.send with a hand-built base64url MIME). This deliberately does
 *      NOT go through emailService.sendEmail — that path hydrates/imports the thread
 *      itself and would make the row appear via the SEND path, voiding the measurement.
 *      The raw send triggers a Gmail history change → Pub/Sub push → api.albusto.com
 *      push route → emailTimelineService.ingestPushNotification.
 *   4. Record T0 at send; poll email_messages for the unique subject every ~2s.
 *   5. PASS iff the row appears within ~15s (push delivered). FAIL if it only appears
 *      much later (the ~10-min poll reconciled it → push still broken) or never.
 *   6. The FIX#3 `[EmailPush] push handled …` log fires in the APP process (PID 1)
 *      stdout, a DIFFERENT stream from this `docker compose exec` — so the script
 *      prints the exact host-side grep to confirm it (and auto-greps PUSH_APP_LOG if
 *      that file path is provided).
 *
 * Harness rules (from the brief — do not deviate):
 *   • Stage this file on the host, `docker cp` it into the container, then run:
 *       docker compose exec -T app node /tmp/verify-gmail-push-fix-001.js
 *     Do NOT pipe via `ssh 'bash -s'` stdin — that stream is consumed by the
 *     `docker compose exec -T … node` and the script never arrives.
 *   • require paths are ROOT-relative (ROOT = /app in the container).
 *   • Subscription is already retargeted to api.albusto.com — NO Google Cloud step
 *     here. If push still fails, that is the SIGNAL (deploy / ingest / sub issue),
 *     not a test defect.
 *
 * Cleanup: the probe email is a throwaway — delete it from the mailbox and optionally
 * `DELETE FROM email_messages WHERE subject = '<the unique subject>'`.
 *
 * Usage:
 *   node scripts/verify-gmail-push-fix-001.js [companyId]
 *   PUSH_COMPANY_ID=… PUSH_PASS_MS=15000 PUSH_MAX_WAIT_MS=45000 PUSH_APP_LOG=/proc/1/fd/1 \
 *     node scripts/verify-gmail-push-fix-001.js
 *
 * Exit code 0 only on PASS (row via push ≤ PASS_MS). Any FAIL / error → non-zero.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const ROOT = path.resolve(__dirname, '..'); // /app in the container
const db = require(path.join(ROOT, 'backend/src/db/connection'));
const emailMailboxService = require(path.join(ROOT, 'backend/src/services/emailMailboxService'));

const PASS_MS = parseInt(process.env.PUSH_PASS_MS || '15000', 10); // ≤ this → push worked
const MAX_WAIT_MS = parseInt(process.env.PUSH_MAX_WAIT_MS || '45000', 10); // give-up bound → FAIL
const POLL_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveMailbox() {
    const wanted = process.argv[2] || process.env.PUSH_COMPANY_ID || null;
    if (wanted) {
        const r = await db.query(
            `SELECT company_id, email_address FROM email_mailboxes
             WHERE company_id = $1 AND status = 'connected' AND provider = 'gmail' LIMIT 1`,
            [wanted]
        );
        if (!r.rows[0]) throw new Error(`no connected gmail mailbox for company ${wanted}`);
        return r.rows[0];
    }
    const r = await db.query(
        `SELECT company_id, email_address FROM email_mailboxes
         WHERE status = 'connected' AND provider = 'gmail'
         ORDER BY updated_at DESC NULLS LAST, id ASC LIMIT 1`
    );
    if (!r.rows[0]) throw new Error('no connected gmail mailbox found');
    return r.rows[0];
}

function base64url(str) {
    return Buffer.from(str, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// Hand-built RFC 5322 MIME → base64url (Gmail raw). From/To = the connected mailbox.
function buildRawMime({ address, subject }) {
    const mime = [
        `From: ${address}`,
        `To: ${address}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        `GMAIL-PUSH-FIX-001 live push probe. Safe to delete. (${subject})`,
    ].join('\r\n');
    return base64url(mime);
}

async function gmailClient(companyId) {
    const accessToken = await emailMailboxService.getValidAccessToken(companyId);
    const oauth2 = emailMailboxService.createOAuth2Client();
    oauth2.setCredentials({ access_token: accessToken });
    return google.gmail({ version: 'v1', auth: oauth2 });
}

// Best-effort automated log check when the app stdout is readable as a file
// (e.g. PUSH_APP_LOG=/proc/1/fd/1). Returns true/false, or null when unavailable.
function checkLogFile(companyId) {
    const file = process.env.PUSH_APP_LOG;
    if (!file) return null;
    try {
        const txt = fs.readFileSync(file, 'utf8');
        return txt.split('\n').some(
            (l) => /\[EmailPush\] push handled/.test(l) && l.includes(companyId)
        );
    } catch (_) {
        return null;
    }
}

async function main() {
    const mb = await resolveMailbox();
    const companyId = mb.company_id;
    const address = mb.email_address;
    const subject = `GMAIL-PUSH-FIX-001 probe ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`[verify] company=${companyId} mailbox=${address}`);
    console.log(`[verify] unique subject: ${subject}`);
    console.log(`[verify] PASS threshold ${PASS_MS / 1000}s · give-up ${MAX_WAIT_MS / 1000}s`);

    const gmail = await gmailClient(companyId);
    const raw = buildRawMime({ address, subject });

    const T0 = Date.now();
    const send = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    console.log(`[verify] raw self-send accepted id=${send.data.id} threadId=${send.data.threadId} (T0 set)`);

    let seenMs = null;
    let rowId = null;
    while (Date.now() - T0 < MAX_WAIT_MS) {
        const r = await db.query(
            `SELECT id, created_at FROM email_messages
             WHERE company_id = $1 AND subject = $2
             ORDER BY id DESC LIMIT 1`,
            [companyId, subject]
        );
        if (r.rows[0]) {
            seenMs = Date.now() - T0;
            rowId = r.rows[0].id;
            break;
        }
        await sleep(POLL_MS);
    }

    console.log('');
    let pass = false;
    if (seenMs == null) {
        console.log(`FAIL  row never appeared within ${Math.round(MAX_WAIT_MS / 1000)}s — push not landing (or ingest errored).`);
        console.log('      Check: Pub/Sub sub → api.albusto.com; app logs for [EmailPush]/[EmailTimeline] errors.');
    } else if (seenMs <= PASS_MS) {
        pass = true;
        console.log(`PASS  email_messages row ${rowId} appeared in ${(seenMs / 1000).toFixed(1)}s (≤ ${PASS_MS / 1000}s) → PUSH delivered.`);
    } else {
        console.log(`FAIL  row appeared in ${(seenMs / 1000).toFixed(1)}s (> ${PASS_MS / 1000}s) — likely the ~10-min POLL reconciled it; push still broken.`);
    }

    // FIX#3 log confirmation.
    console.log('');
    const logHit = checkLogFile(companyId);
    if (logHit === true) {
        console.log('[verify] [EmailPush] push handled log CONFIRMED via PUSH_APP_LOG.');
    } else {
        if (logHit === false) {
            console.log('[verify] WARNING: PUSH_APP_LOG readable but no [EmailPush] push handled line seen for this company.');
        }
        console.log('[verify] REQUIRED manual confirmation — the FIX#3 log line (run on the HOST):');
        console.log(`  docker compose logs --since=2m app | grep '\\[EmailPush\\] push handled'`);
        console.log(`  → expect a line for company=${companyId} with processed>=1.`);
    }

    console.log('');
    console.log(`[verify] CLEANUP: probe email is throwaway — delete it, and optionally:`);
    console.log(`  DELETE FROM email_messages WHERE subject = '${subject}';`);

    return pass ? 0 : 1;
}

(async () => {
    let code = 1;
    try {
        code = await main();
    } catch (err) {
        console.error('[verify] ERROR:', err && (err.stack || err.message) ? (err.stack || err.message) : err);
        code = 1;
    } finally {
        try { await db.pool.end(); } catch (_) { /* ignore */ }
    }
    process.exit(code);
})();
