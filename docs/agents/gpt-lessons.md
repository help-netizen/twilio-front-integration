# GPT Implementer — Lessons Log

Accumulated corrections from architect reviews. **Read this file before every task.**
Newest lessons at the top. The architect (Claude) appends a lesson whenever a review
finds a mistake worth preventing next time. Keep entries one-to-three lines, concrete, imperative.

Format: `L-NNN (YYYY-MM-DD) — <lesson>`

---

- **L-014 (2026-07-13)** — Node 25 on this mac SEGFAULTS when `NODE_USE_SYSTEM_CA=1` is in the env
  (macOS keychain code): `unset NODE_USE_SYSTEM_CA` (or use `--use-bundled-ca`) before node/vite/jest.
  This was the mystery behind earlier Vite exit-139 crashes.
- **L-013 (2026-07-13)** — TWO http clients exist: fetch `services/apiClient.ts` AND axios `services/api.ts`.
  Auth/401/2FA handling changes go into BOTH, with coverage in `authClients2fa.test.ts` (BUG-22: the axios
  client missing the 2FA code caused an infinite kc.login() reload loop on prod).
- **L-012 (2026-07-12)** — Worktrees have NO local `node_modules`. Run jest via the main checkout:
  `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath <file> --testPathIgnorePatterns "/node_modules/"`. Do not create node_modules symlinks (or remove them before finishing).
- **L-011 (2026-07-12)** — In "How I verified", report the EXACT command you executed, byte-for-byte.
  Never substitute the canonical/equivalent command (e.g. reporting `npm test` when you actually ran a
  direct jest path). The reviewer re-runs your command; a mismatch reads as a false report.
- **L-010 (2026-07-12)** — Timezone: all user-facing dates/times normalize to `company.timezone`
  (default `America/New_York`). Never use server-local `new Date()` semantics for scheduling logic.
- **L-009 (2026-07-12)** — Technician identifiers in scheduling code are Zenbooker TEXT ids, not
  numeric CRM ids. Check the actual column type before joining.
- **L-008 (2026-07-12)** — SSE events must be registered in BOTH `genericEventTypes` AND
  `namedEvents` on the frontend hook, or the event silently never arrives.
- **L-007 (2026-07-12)** — Express route order matters: literal routes (`/new-count`) BEFORE
  param routes (`/:uuid`), or the param route swallows them.
- **L-006 (2026-07-12)** — Mobile Radix Select inside a Dialog needs the established 4-layer
  pointer-events pattern — reuse existing Select/BottomSheet primitives, never hand-roll dropdowns.
- **L-005 (2026-07-12)** — List/area wrapper containers are INVISIBLE (no bg/border/radius/shadow);
  surface styling belongs to content tiles only (LAYOUT-CANON rule 7).
- **L-004 (2026-07-12)** — Frontend prod build enforces `noUnusedLocals`: every unused import or
  variable fails the Docker build even if local `vite dev` works. Run `npm run build`, not just dev.
- **L-003 (2026-07-12)** — `jsonb_set()` silently no-ops when the parent path is missing; create the
  parent object first (`COALESCE(col, '{}'::jsonb)` / nested jsonb_set).
- **L-002 (2026-07-12)** — `created_by` and other FK-to-`crm_users` columns take
  `req.user.crmUser.id`. Using the Keycloak `sub` gives an FK violation (500) that only shows on prod data.
- **L-001 (2026-07-12)** — Every new SQL query must be scoped by `company_id` from
  `req.companyFilter?.company_id`. This codebase had a real cross-tenant leak; the reviewer checks tenant
  scoping before anything else.

- **L-013 (2026-07-13)** — Inside the codex sandbox, bare `node …/jest.js` can crash with macOS
  `SecItemCopyMatching failed -50` (Keychain). The fix is `node --use-bundled-ca …/jest.js` — use it
  for every jest invocation run from a codex session; outside the sandbox the flag is harmless.

- **L-014 (2026-07-13)** — Real-PG suites that rebuild shared objects (CREATE OR REPLACE FUNCTION,
  migration replays) MUST NOT run in parallel jest workers against the shared dev DB — you get
  `tuple concurrently updated` / `deadlock detected`. Any verify command combining two or more
  *.db.test.js files needs `--runInBand`.
