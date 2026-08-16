import path from 'node:path';

/**
 * Central env + run-identity for the E2E suite.
 * Secrets (test-user creds) come ONLY from env — never hard-coded (see spec §4).
 */
export const BASE_URL =
    process.env.E2E_BASE_URL || 'https://kurais-mac-mini.taile2152e.ts.net';

export const ADMIN_USER = process.env.E2E_ADMIN_USER || '';
export const ADMIN_PASS = process.env.E2E_ADMIN_PASS || '';
export const PROVIDER_USER = process.env.E2E_PROVIDER_USER || '';
export const PROVIDER_PASS = process.env.E2E_PROVIDER_PASS || '';

/**
 * Direct-grant (ROPG) token acquisition is OPT-IN and off by default: `crm-web` is a
 * public browser client that almost certainly has direct grants disabled, and hard-coding
 * a Keycloak host here is a foot-gun (the old default pointed at a now-dead fly host).
 * The default token path is browser-Bearer capture (see fixtures/api.ts) — it needs no
 * Keycloak host and works regardless of client flow settings. To enable ROPG, set
 * E2E_KEYCLOAK_URL (or E2E_KEYCLOAK_TOKEN_URL) to the staging issuer explicitly.
 */
export const KEYCLOAK_REALM = process.env.E2E_KEYCLOAK_REALM || 'crm-prod';
export const KEYCLOAK_CLIENT_ID = process.env.E2E_KEYCLOAK_CLIENT_ID || 'crm-web';
export const KEYCLOAK_URL = (process.env.E2E_KEYCLOAK_URL || '').replace(/\/$/, '');
export const KEYCLOAK_TOKEN_URL =
    process.env.E2E_KEYCLOAK_TOKEN_URL ||
    (KEYCLOAK_URL ? `${KEYCLOAK_URL}/realms/${encodeURIComponent(KEYCLOAK_REALM)}/protocol/openid-connect/token` : '');

export const AUTH_DIR = path.resolve(__dirname, '..', '.auth');
export const ADMIN_STORAGE_STATE = path.join(AUTH_DIR, 'admin.json');

export const hasAdmin = (): boolean => Boolean(ADMIN_USER && ADMIN_PASS);
export const hasProvider = (): boolean => Boolean(PROVIDER_USER && PROVIDER_PASS);

/**
 * The job lifecycle (create / reschedule / assign) was historically coupled to
 * Zenbooker (`POST /api/jobs` 500'd with "ZENBOOKER_API_KEY is not configured").
 * ZB-DECOUPLE Phase F REMOVED that coupling — job-create is now fully native — so
 * the job-dependent P0 tests (JOB/EST/INV/SCH) run BY DEFAULT. Opt out only against
 * a pre-Phase-F staging build with E2E_JOBS_NATIVE=0.
 */
export const JOBS_NATIVE = process.env.E2E_JOBS_NATIVE !== '0';
export const JOBS_BLOCKED_REASON =
    'Skipped: E2E_JOBS_NATIVE=0 set (pre-ZB-decouple staging). Job-create is native since ' +
    'Phase F — leave E2E_JOBS_NATIVE unset. See docs/specs/E2E-REGRESSION-001.md';

/**
 * Can this environment actually dispatch a document to a customer?
 *
 * On staging, deliberately NOT: `bin/sanitize-env.sh` blanks every Twilio
 * credential and rotates `EMAIL_TOKEN_ENCRYPTION_KEY` to a value that cannot
 * decrypt the seeded mailbox tokens, precisely so a test run can never text or
 * email a real customer. That is the correct posture, and it means any case
 * whose SETUP needs a real send is untestable there.
 *
 * Invoices feel this and estimates do not: an estimate reaches `sent` through a
 * plain PUT, while an invoice's status is workflow-owned — only `/send` issues
 * one. So a case that needs an issued invoice is skipped unless the environment
 * says it can dispatch (E2E_CAN_DISPATCH_DOCUMENTS=1), rather than reported as
 * a failure of the code under test.
 */
export const CAN_DISPATCH_DOCUMENTS = process.env.E2E_CAN_DISPATCH_DOCUMENTS === '1';
export const DISPATCH_BLOCKED_REASON =
    'Skipped: this environment cannot dispatch documents (staging blanks Twilio and ' +
    'rotates the mailbox key by design), and issuing an invoice requires a real send. ' +
    'Set E2E_CAN_DISPATCH_DOCUMENTS=1 where sending is genuinely safe. ' +
    'See docs/specs/E2E-REGRESSION-001.md';

/**
 * Unique per-process run id. Prefixes every created entity name so runs are
 * idempotent, identifiable, and safe to run in parallel / repeatedly (spec §5).
 */
function makeRunId(): string {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 6);
    return `e2e-${stamp}-${rand}`;
}
export const RUN_ID = process.env.E2E_RUN_ID || makeRunId();
