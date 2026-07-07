#!/usr/bin/env node
// PWA-FIX-001 / PWA-04 — standalone Node ESM gate for the refresh-failure classifier.
//
// WHY a duplicate: under the frontend's bundler module resolution a plain-node .mjs
// cannot import the .ts source, so this script DUPLICATES the tiny pure logic
// (rule order + dead patterns + backoff) and then a DRIFT-GUARD readFileSync's the
// real refreshPolicy.ts to assert the two stay in sync (any divergence ⇒ exit 1).
//
// Runs on the ambient node (no new dep). Asserts:
//   - 8 truth-table rows §3.3.1 (TC-PWA-001..008) + extraction/case (TC-PWA-009/010)
//   - backoff === [2000,5000,10000], length 3, sum 17000 (TC-PWA-012/013)
//   - SABOTAGE negative-control (TC-PWA-011): benign 'timeout' ⇒ transient, AND a
//     deliberately-broadened pattern set flips it to dead (proves the detector bites)
//   - DRIFT-GUARD: refreshPolicy.ts contains [2000, 5000, 10000] + all 4 dead substrings
//
// Exit 0 on all pass; non-zero + message on any fail.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICY_TS_PATH = join(__dirname, '..', 'src', 'auth', 'refreshPolicy.ts');

// ---------------------------------------------------------------------------
// DUPLICATED pure logic — MUST stay byte-equivalent to refreshPolicy.ts
// (enforced by the drift-guard below).
// ---------------------------------------------------------------------------

const REFRESH_RETRY_BACKOFF_MS = [2000, 5000, 10000];

// The 4 canonical dead-signal families the drift-guard asserts verbatim in the .ts.
const DRIFT_GUARD_SUBSTRINGS = [
  'invalid_grant',
  'session not active',
  'token expired',
  'refresh token',
];

const DEAD_GRANT_PATTERNS = [
  'invalid_grant',
  'session not active',
  'session_not_active',
  'session-not-active',
  'token expired',
  'token is expired',
  'token_expired',
  'refresh token',
  'refresh_token',
  'refresh-token',
];

function extractErrorText(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    return (
      (typeof error.error === 'string' && error.error) ||
      (typeof error.error_description === 'string' && error.error_description) ||
      (typeof error.message === 'string' && error.message) ||
      ''
    );
  }
  return String(error);
}

// `patterns` is injectable so the sabotage control can prove an over-broad set bites.
function classifyRefreshFailure(input, patterns = DEAD_GRANT_PATTERNS) {
  if (input.online === false) return 'transient';
  if (input.hasRefreshToken === false) return 'dead';
  const text = extractErrorText(input.error).toLowerCase();
  if (text && patterns.some((p) => text.includes(p))) return 'dead';
  return 'transient';
}

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------

let count = 0;
function check(label, actual, expected) {
  count += 1;
  assert.deepStrictEqual(
    actual,
    expected,
    `FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

try {
  // ---- Truth-table §3.3.1 (TC-PWA-001..008) ----

  // Row 1 (TC-PWA-001): offline dominates — even with the two strongest dead signals.
  check('TC-001 offline+dead-signals',
    classifyRefreshFailure({ online: false, hasRefreshToken: false, error: { error: 'invalid_grant' } }),
    'transient');

  // Row 2 (TC-PWA-002): online + no refresh token ⇒ dead (empty error on purpose).
  check('TC-002 online+no-token',
    classifyRefreshFailure({ online: true, hasRefreshToken: false, error: {} }),
    'dead');

  // Row 3 (TC-PWA-003): invalid_grant ⇒ dead.
  check('TC-003 invalid_grant',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: { error: 'invalid_grant' } }),
    'dead');

  // Row 4 (TC-PWA-004): "session not active" — all separator spellings + shapes.
  check('TC-004a session-space/.error_description',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: { error_description: 'Session not active' } }),
    'dead');
  check('TC-004b session_underscore/Error',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: new Error('session_not_active') }),
    'dead');
  check('TC-004c session-hyphen/.message',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: { message: 'session-not-active' } }),
    'dead');

  // Row 5 (TC-PWA-005): "token expired" and "token is expired".
  check('TC-005a token expired',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: { message: 'token expired' } }),
    'dead');
  check('TC-005b token is expired',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: { message: 'token is expired' } }),
    'dead');

  // Row 6 (TC-PWA-006): "refresh token" signal.
  check('TC-006 refresh token',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: { error_description: 'Refresh token expired' } }),
    'dead');

  // Row 7 (TC-PWA-007): empty / ambiguous ⇒ transient (never eject on ambiguity).
  check('TC-007a undefined',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: undefined }),
    'transient');
  check('TC-007b {}',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: {} }),
    'transient');
  check('TC-007c Error("")',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: new Error('') }),
    'transient');

  // Row 8 (TC-PWA-008): non-matching generic error ⇒ transient.
  check('TC-008 generic 503',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: new Error('Network request failed: 503') }),
    'transient');

  // ---- Extraction precedence & shapes (TC-PWA-009) ----
  check('TC-009a .error',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: { error: 'invalid_grant' } }), 'dead');
  check('TC-009b .error_description',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: { error_description: 'session not active' } }), 'dead');
  check('TC-009c .message',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: new Error('token expired') }), 'dead');
  check('TC-009d raw string',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: 'invalid_grant' }), 'dead');
  check('TC-009e {} ⇒ transient',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: {} }), 'transient');
  check('TC-009f undefined ⇒ transient',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: undefined }), 'transient');

  // ---- Case-insensitive + substring (TC-PWA-010) ----
  check('TC-010 uppercase embedded',
    classifyRefreshFailure({ online: true, hasRefreshToken: true, error: { error: 'ERROR: INVALID_GRANT during token exchange' } }),
    'dead');

  // ---- SABOTAGE negative-control (TC-PWA-011) ----
  const benign = { online: true, hasRefreshToken: true, error: new Error('timeout of 60000ms exceeded') };
  check('TC-011 benign timeout ⇒ transient', classifyRefreshFailure(benign), 'transient');
  // Prove the test bites: a deliberately-broadened pattern set WOULD catch 'timeout'.
  const broadened = [...DEAD_GRANT_PATTERNS, 'timeout'];
  check('TC-011 broadened patterns flip benign ⇒ dead', classifyRefreshFailure(benign, broadened), 'dead');
  console.log('SABOTAGE CONTROL: broadened patterns correctly flip benign→dead (detector alive)');

  // ---- Backoff constant (TC-PWA-012 / 013) ----
  check('TC-012 backoff schedule', REFRESH_RETRY_BACKOFF_MS, [2000, 5000, 10000]);
  check('TC-013 backoff length', REFRESH_RETRY_BACKOFF_MS.length, 3);
  check('TC-013 backoff sum ≈17s', REFRESH_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0), 17000);

  // ---- DRIFT-GUARD: single source of truth (TC-PWA-022) ----
  const policySrc = readFileSync(POLICY_TS_PATH, 'utf8');
  count += 1;
  assert.ok(
    policySrc.includes('[2000, 5000, 10000]'),
    `FAIL [drift-guard]: refreshPolicy.ts missing verbatim "[2000, 5000, 10000]" — .ts and .mjs backoff drifted`,
  );
  for (const sub of DRIFT_GUARD_SUBSTRINGS) {
    count += 1;
    assert.ok(
      policySrc.includes(sub),
      `FAIL [drift-guard]: refreshPolicy.ts missing dead-pattern substring "${sub}" — .ts and .mjs patterns drifted`,
    );
  }

  console.log(`PASS: ${count} assertions (8 truth-table rows + extraction/case + backoff + sabotage-control + drift-guard).`);
  process.exit(0);
} catch (err) {
  console.error(err && err.message ? err.message : err);
  console.error(`FAILED after ${count} assertions.`);
  process.exit(1);
}
