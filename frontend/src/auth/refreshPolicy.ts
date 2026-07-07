// PWA-FIX-001 — pure transient-vs-dead refresh-failure classifier.
//
// NO React, NO keycloak import, NO timers, NO fetch. The *decision* lives here
// (pure, unit-testable); the impure orchestrator (`refreshTokenOrLogin`, timers,
// sleep, kc.login) lives in AuthProvider.tsx (PWA-05) and imports from this module.
//
// Spec: Docs/specs/PWA-FIX-001-SPEC.md §3.3 (API) + §3.3.1 (classifier truth-table).

/**
 * Retry backoff schedule (ms) for a transient refresh failure.
 * Its length (3) IS the retry budget; sum ≈ 17s ceiling per reject event.
 * §1.4.2–§1.4.3, §4.2. Consumed by AuthProvider's `refreshTokenOrLogin`.
 */
export const REFRESH_RETRY_BACKOFF_MS = [2000, 5000, 10000] as const;

export type RefreshFailureKind = 'transient' | 'dead';

export interface RefreshFailureInput {
  /** kc.refreshToken AFTER the failed updateToken (falsy ⇒ adapter gave up ⇒ dead). */
  hasRefreshToken: boolean;
  /** navigator.onLine at failure time (false ⇒ transient, dominates all else). */
  online: boolean;
  /** The rejection keycloak handed us (may be undefined / {} / string / Error). */
  error: unknown;
}

/**
 * Lowercased substrings that mean a genuinely dead session (grant/session/expiry
 * signals from the token endpoint). Kept as plain substrings so the .mjs
 * drift-guard can assert each one verbatim against this file. Matching is
 * case-insensitive (we lowercase the extracted text) and non-anchored (substring),
 * so real Keycloak sentences like "ERROR: invalid_grant during token exchange"
 * still classify dead. Separator flexibility ('session not active' /
 * 'session_not_active' / 'session-not-active') is handled by listing the
 * separator-agnostic core plus underscore/hyphen spellings.
 *
 * NOTE: deliberately narrow — biased to transient. Broadening this (e.g. adding
 * 'token', 'timeout', 'failed') is a regression caught by the sabotage
 * negative-control in verify-pwa-refresh-policy.mjs (TC-PWA-011).
 */
const DEAD_GRANT_PATTERNS: readonly string[] = [
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

/**
 * Pull a string out of whatever keycloak rejected with. Field precedence:
 * `.error` → `.error_description` → `.message` → `String(error)`.
 * Returns '' for undefined / null / `{}` / an Error with an empty message,
 * so an ambiguous reject classifies transient (never eject on ambiguity).
 */
function extractErrorText(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const candidate =
      (typeof obj.error === 'string' && obj.error) ||
      (typeof obj.error_description === 'string' && obj.error_description) ||
      (typeof obj.message === 'string' && obj.message) ||
      '';
    return candidate;
  }
  return String(error);
}

/**
 * Classify a refresh failure as 'transient' (retry) or 'dead' (redirect once).
 *
 * Rule order (§3.3.1) — first match wins:
 *   1. online === false          ⇒ 'transient'  (offline blip dominates, short-circuit)
 *   2. hasRefreshToken === false  ⇒ 'dead'       (adapter cleared token ⇒ real expiry)
 *   3. error text ⊇ any DEAD_GRANT_PATTERNS ⇒ 'dead'  (grant/session/expiry signal)
 *   4. otherwise                  ⇒ 'transient'  (empty/ambiguous/generic ⇒ retry)
 *
 * Bias: ambiguous ⇒ transient. NEVER eject on ambiguity — a genuinely-dead-but-
 * silent session is still caught by retry-budget exhaustion (§1.4.3).
 */
export function classifyRefreshFailure(input: RefreshFailureInput): RefreshFailureKind {
  // (1) offline dominates — even if the error looks dead and the token is gone.
  if (input.online === false) return 'transient';

  // (2) adapter cleared the refresh token while online ⇒ genuine expiry.
  if (input.hasRefreshToken === false) return 'dead';

  // (3) explicit grant/session/expiry signal in the error text.
  const text = extractErrorText(input.error).toLowerCase();
  if (text && DEAD_GRANT_PATTERNS.some((p) => text.includes(p))) return 'dead';

  // (4) empty / ambiguous / non-matching ⇒ retry.
  return 'transient';
}
