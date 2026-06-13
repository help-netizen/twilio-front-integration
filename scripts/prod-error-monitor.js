#!/usr/bin/env node

/**
 * Production Error Log Monitor (Vultr / docker compose)
 *
 * Streams live logs from the prod app container on the Vultr server (via
 * `ssh … docker compose logs -f app`) and captures errors into a structured
 * JSON file. Each error entry includes timestamp, source, category, severity,
 * and surrounding context lines so issues can be analyzed and fixed offline.
 *
 * Usage:
 *   node scripts/prod-error-monitor.js          # stream & capture
 *   node scripts/prod-error-monitor.js --replay  # show captured errors
 *
 * Config (env overrides):
 *   PROD_SSH      ssh target            (default deploy@108.61.87.117)
 *   PROD_APP_DIR  compose dir on server (default /opt/albusto)
 *   PROD_SERVICE  compose service name  (default app)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── Config ───────────────────────────────────────────────────────────────────
const PROD_SSH = process.env.PROD_SSH || 'deploy@108.61.87.117';
const PROD_APP_DIR = process.env.PROD_APP_DIR || '/opt/albusto';
const PROD_SERVICE = process.env.PROD_SERVICE || 'app';
const HOST_LABEL = PROD_SSH.replace(/^.*@/, '');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'errors.json');
const ARCHIVE_DIR = path.join(LOG_DIR, 'archive');
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const CONTEXT_LINES_BEFORE = 5;
const CONTEXT_LINES_AFTER = 5;
const INCIDENT_GROUP_WINDOW_MS = 2000;

// Stream new log lines only (--tail=0) so the auto-restart loop never
// re-captures historical errors. --no-log-prefix drops the "app-1  | " prefix.
const REMOTE_LOG_CMD =
  `cd ${PROD_APP_DIR} && docker compose logs -f --no-log-prefix --tail=0 ${PROD_SERVICE}`;

// ── Error-detection patterns ─────────────────────────────────────────────────
const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
  /\bRangeError\b/,
  /\bECONNREFUSED\b/,
  /\bENOTFOUND\b/,
  /\bETIMEDOUT\b/,
  /\bfailed\b/i,
  /❌/,
  /\bcrash(ed)?\b/i,
  /\b50[0-9]\b/,        // 500-509 HTTP errors
  /\bFATAL\b/i,
  /\bunhandled\b/i,
  /\buncaught\b/i,
  /\brejection\b/i,
  /\bpanic\b/i,
  /\bOOM\b/,
  /\bKILLED\b/,
  /\bdoes not exist\b/i,
  /\bCannot find module\b/i,
  /\b(at .+\(.+:\d+:\d+\))/,  // stack trace frames
];

// ── False-positive exclusions ────────────────────────────────────────────────
const FALSE_POSITIVE_PATTERNS = [
  /Failed: 0/i,                       // success summary: "Processed: 1, Failed: 0"
  /Processed:.*Failed: 0/i,           // worker summary lines
  /^\d{4}-.*- (GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) \//,  // HTTP request log line
  /console\.error/,                   // literal code references
  /error_count.*:\s*0/i,             // metrics with zero errors
  /\bno\s+error/i,                   // "no error" style messages
  /without error/i,
  /\bTRACE\b/,                        // debug trace lines (e.g. [UNREAD-TRACE])
  /\bcalled for\b.*\bat\s+/,          // debug call-trace lines with stack info
  /\d+ sent, 0 failed\b/,             // SSE broadcast with 0 failures
];

// ── Error categorisation ─────────────────────────────────────────────────────
function categorise(message) {
  if (/column .* does not exist|relation .* does not exist|duplicate key|violates|constraint|deadlock/i.test(message))
    return 'database';
  if (/TypeError|ReferenceError|SyntaxError|RangeError|Cannot read prop|undefined is not|is not a function/i.test(message))
    return 'runtime';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|network|fetch failed/i.test(message))
    return 'network';
  if (/\b50[0-9]\b|Bad Gateway|Service Unavailable|Internal Server Error/i.test(message))
    return 'http';
  if (/ENOMEM|OOM|heap|memory/i.test(message))
    return 'memory';
  if (/auth|token|unauthorized|forbidden|jwt|401|403/i.test(message))
    return 'auth';
  return 'unknown';
}

function severity(message) {
  if (/FATAL|OOM|KILLED|panic|crash|uncaught|unhandled/i.test(message)) return 'critical';
  return 'error';
}

// Extract a [Tag] source from the message, e.g. "[ZbWebhook]" → "ZbWebhook"
function extractSource(message) {
  const match = message.match(/\[([A-Za-z][A-Za-z0-9_-]+)\]/);
  return match ? match[1] : null;
}

// ── ANSI escape-code stripper ────────────────────────────────────────────────
// app/docker output may be colored; we strip it for clean parsing and storage
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(str) { return str.replace(ANSI_RE, ''); }

// ── Log-line parser ──────────────────────────────────────────────────────────
// With `docker compose logs --no-log-prefix` each line is the app's raw stdout.
// The app prefixes its own lines with an ISO timestamp; fall back to now() if not.
const ISO_RE = /^(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)/;

function parseLogLine(raw) {
  const clean = stripAnsi(raw);
  const m = clean.match(ISO_RE);
  return {
    timestamp: m ? m[1] : new Date().toISOString(),
    host: HOST_LABEL,
    message: clean,
    raw: clean,
  };
}

// ── Ring buffer for context tracking ─────────────────────────────────────────
class RingBuffer {
  constructor(size) { this.size = size; this.buf = []; }
  push(item) { this.buf.push(item); if (this.buf.length > this.size) this.buf.shift(); }
  snapshot() { return [...this.buf]; }
  clear() { this.buf = []; }
}

// ── File I/O helpers ─────────────────────────────────────────────────────────
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function readErrors() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); }
  catch { return []; }
}

function writeErrors(errors) {
  ensureDir(LOG_DIR);
  fs.writeFileSync(LOG_FILE, JSON.stringify(errors, null, 2), 'utf8');
}

function rotateIfNeeded() {
  if (!fs.existsSync(LOG_FILE)) return;
  const stat = fs.statSync(LOG_FILE);
  if (stat.size < MAX_LOG_SIZE_BYTES) return;

  ensureDir(ARCHIVE_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = path.join(ARCHIVE_DIR, `errors-${stamp}.json`);
  fs.renameSync(LOG_FILE, archivePath);
  console.log(`📦 Archived ${LOG_FILE} → ${archivePath}`);
}

function generateId() {
  return `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Replay mode ──────────────────────────────────────────────────────────────
function showReplay() {
  const errors = readErrors();
  if (errors.length === 0) {
    console.log('No errors captured yet.');
    return;
  }
  console.log(`\n📋 ${errors.length} error(s) captured in ${LOG_FILE}\n`);
  for (const e of errors) {
    const sev = e.severity === 'critical' ? '🔴' : '🟠';
    console.log(`${sev} [${e.timestamp}] ${e.category}${e.source ? ' / ' + e.source : ''}`);
    console.log(`   ${e.errorLine}`);
    if (e.context && e.context.length > 0) {
      console.log('   ── context ──');
      for (const c of e.context) console.log(`   │ ${c}`);
    }
    console.log('');
  }
}

// ── Main monitor ─────────────────────────────────────────────────────────────
function startMonitor() {
  console.log(`\n🔍 Production Error Monitor — streaming docker logs from ${PROD_SSH} (${PROD_SERVICE})...`);
  console.log(`   Output: ${LOG_FILE}`);
  console.log(`   Press Ctrl+C to stop\n`);

  const logProcess = spawn('ssh', [PROD_SSH, REMOTE_LOG_CMD], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  logProcess.on('error', (err) => {
    console.error(`❌ Failed to start ssh: ${err.message}`);
    console.error(`   Make sure you can reach the server: ssh ${PROD_SSH} 'echo ok'`);
    process.exit(1);
  });

  const rl = readline.createInterface({ input: logProcess.stdout });

  const contextBuf = new RingBuffer(CONTEXT_LINES_BEFORE);
  let pendingAfterLines = 0;
  let currentEntry = null;
  let lastErrorTime = 0;
  let linesSinceError = 0;
  let totalErrors = 0;
  let sessionStart = new Date();

  function flushEntry() {
    if (!currentEntry) return;
    const errors = readErrors();
    errors.push(currentEntry);
    rotateIfNeeded();
    writeErrors(errors);

    totalErrors++;
    const sev = currentEntry.severity === 'critical' ? '🔴 CRITICAL' : '🟠 ERROR';
    console.log(`${sev} #${totalErrors} [${currentEntry.timestamp}] ${currentEntry.category}${currentEntry.source ? ' / ' + currentEntry.source : ''}`);
    console.log(`  → ${currentEntry.errorLine}`);

    currentEntry = null;
    pendingAfterLines = 0;
  }

  function isErrorLine(message) {
    // Check false positives first
    for (const fp of FALSE_POSITIVE_PATTERNS) {
      if (fp.test(message)) return false;
    }
    // Check error patterns
    for (const pat of ERROR_PATTERNS) {
      if (pat.test(message)) return true;
    }
    return false;
  }

  rl.on('line', (raw) => {
    const parsed = parseLogLine(raw.trim());
    const msg = parsed.message;

    // If we are collecting "after" context for a pending error
    if (currentEntry && pendingAfterLines > 0) {
      currentEntry.context.push(parsed.raw);
      pendingAfterLines--;
      linesSinceError++;
      if (pendingAfterLines === 0) {
        flushEntry();
      }
      // Even while collecting after-context, check if this line is also an error
      // and if so, we start a new entry (after flushing current)
      if (isErrorLine(msg)) {
        flushEntry(); // force-flush if still pending
        const now = Date.now();
        const isRelated = (now - lastErrorTime) < INCIDENT_GROUP_WINDOW_MS;
        lastErrorTime = now;

        currentEntry = {
          id: generateId(),
          timestamp: parsed.timestamp,
          host: parsed.host,
          errorLine: msg.trim(),
          context: [...contextBuf.snapshot()],
          category: categorise(msg),
          severity: severity(msg),
          source: extractSource(msg),
          relatedToPrevious: isRelated,
        };
        pendingAfterLines = CONTEXT_LINES_AFTER;
        linesSinceError = 0;
      }
      contextBuf.push(parsed.raw);
      return;
    }

    // Normal line processing
    if (isErrorLine(msg)) {
      flushEntry(); // flush any previous pending entry

      const now = Date.now();
      const isRelated = (now - lastErrorTime) < INCIDENT_GROUP_WINDOW_MS;
      lastErrorTime = now;

      currentEntry = {
        id: generateId(),
        timestamp: parsed.timestamp,
        host: parsed.host,
        errorLine: msg.trim(),
        context: [...contextBuf.snapshot()],
        category: categorise(msg),
        severity: severity(msg),
        source: extractSource(msg),
        relatedToPrevious: isRelated,
      };
      pendingAfterLines = CONTEXT_LINES_AFTER;
      linesSinceError = 0;
    }

    contextBuf.push(parsed.raw);
  });

  // Handle process exit
  logProcess.on('close', (code) => {
    flushEntry();
    console.log(`\n⚠️  ssh log stream exited with code ${code}. Restarting in 5s...`);
    setTimeout(startMonitor, 5000);
  });

  logProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[ssh stderr] ${text}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    flushEntry();
    const elapsed = Math.round((Date.now() - sessionStart.getTime()) / 1000);
    console.log(`\n✅ Monitor stopped. Captured ${totalErrors} error(s) in ${elapsed}s.`);
    console.log(`   View with: node scripts/prod-error-monitor.js --replay`);
    logProcess.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Entry point ──────────────────────────────────────────────────────────────
if (process.argv.includes('--replay')) {
  showReplay();
} else {
  startMonitor();
}
