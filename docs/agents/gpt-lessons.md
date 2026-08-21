# GPT Implementer — Lessons Log

Accumulated corrections from architect reviews. **Read this file before every task.**
Newest lessons at the top. The architect (Claude) appends a lesson whenever a review
finds a mistake worth preventing next time. Keep entries one-to-three lines, concrete, imperative.

Format: `L-NNN (YYYY-MM-DD) — <lesson>`

---

- **L-029 (2026-08-21)** — `codex exec resume`: the `-s/--sandbox` and `-C/--cd` flags belong to the
  parent `exec` and must precede the `resume` subcommand (`codex exec -s workspace-write -C <wt> resume
  <SID> "<prompt>"`); after `resume` they error `unexpected argument` and the run applies nothing while a
  trailing echo masks exit 0. Confirm a resume actually attached (`git diff --stat` changed) before trusting it.
- **L-028 (2026-08-17)** — Structural migrations must never require environment variables,
  provider readback, credentials, or tenant resource rows; keep operational discovery, validation,
  and data backfill in an explicit company-scoped dry-run-by-default CLI.
- **L-027 (2026-08-16)** — Vapi assistant webhook `server.secret` is write-only: `GET /assistant`
  returns only `isServerUrlSecretSet`; verify a PATCH by that flag, never by secret echo. This differs
  from `model.tools[].server.secret`, whose value is readable, so never log or fixture tool readback.
- **L-026 (2026-08-14)** — Before adding authentication middleware to an existing route, find every
  frontend consumer and prove that its request mechanism can send the required credential. Browser
  subresources such as `<img src>` and ordinary download links cannot attach an Authorization header;
  use a narrow, short-lived capability instead of putting a full access token in the URL.
- **L-025 (2026-08-14)** — Verify raw SQL migrations with the deployment transport itself
  (`psql -v ON_ERROR_STOP=1 -f` in autocommit), not only as one `db.query()` inside a test transaction.
  Driver-green does not validate statement-level transaction rules such as bare `LOCK TABLE`.
- **L-020 (2026-07-18)** — Natural-key actions (phone/email/SID/external id) MUST also scope by `company_id`; seed two tenants with the same key and use `T-blast` to prove the other row is byte-unchanged.
- **L-019 (2026-07-18)** — RBAC must be designed, not inferred: every new route declares one catalog permission and adds a deny test for every `R-matrix` cell.
- **L-018 (2026-07-18)** — Worktree `frontend/node_modules` goes STALE after pulling master: new deps
  (e.g. `heic-to`, `vitest`) are declared in package.json but not installed, so `npm run build` fails on
  missing packages that have nothing to do with your diff. Codex's sandbox has NO network — do not treat
  this as your bug and do not try to install. Report it as an environment gap; the architect runs
  `npm install` and owns the build gate.

- **L-017 (2026-07-16)** — NEVER put `&` inside a harness run_in_background Bash command that
  launches codex: the wrapper shell exits instantly (fires a FALSE "completed" notification) while
  codex keeps running detached (PPID 1) — you then misread half-written logs as L-016 and pile a
  resume onto a still-running session (two writers, one session file). Launch codex as the DIRECT
  background command (no `&`, no trailing echo); before diagnosing any "premature exit", check
  `ps -axo pid,ppid,etime,args | grep "Resources/codex"` for a live process and whether the log still grows.

- **L-016 (2026-07-15)** — `codex exec` (gpt-5.6-sol, ultra reasoning) sometimes DRAFTS the full
  solution in its response but exits WITHOUT calling apply_patch — git shows zero changes even though
  the log "contains" the code. Don't trust the log/exit-0; verify with `git status`. Fix: `codex exec
  resume <SID> "you drafted but never applied — apply_patch NOW to <files>, minimal talk"`. Seen twice
  in one run (backend + frontend). Also: it can burn the whole turn on exploration and stop before
  writing — a resume with "STOP researching, implement now" recovers it.

- **L-015 (2026-07-15)** — Sabotage negative-controls run ON TOP of the implementer's UNCOMMITTED diff.
  Restore by reversing the exact edit (or from a `cp` backup taken first) — NEVER `git checkout <file>`:
  it reverts to HEAD and silently discards the implementer's uncommitted work along with the sabotage.

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

- **L-019 `codex exec resume` rejects `-C` as well as `-s`/`-o`.** Only `exec` takes the
  working-directory flag; on `resume` it dies with `unexpected argument '-C' found` and
  the whole turn is lost (exit 2, zero files changed — looks exactly like an L-016
  draft-without-apply until you read the log). `cd` into the worktree and drop `-C`.
  Hit 2026-07-20 on OB-16.

- **L-021 (2026-07-20)** — A sabotage/security test is theater if it cannot actually fail: (a) an
  injection test that MOCKS the provider to return a safe verdict proves nothing about the prompt;
  (b) a "T-blast" test that only asserts SQL substrings, or that RETURNS SUCCESS when the DB is
  unavailable (instead of a visible skip/sentinel), is falsely green; (c) a control that asserts a
  helper was CALLED, not that the boundary holds. Every named sabotage control must be proven by
  BREAK→red→restore against the REAL code path it guards, and a fresh attack-only red-team (a DIFFERENT
  session, not the implementer) must re-audit — the author who wrote the theater cannot see it. Caught
  on INSPECTOR-AGENT-001: the red-team found a spoofable prompt fence and a falsely-green DB suite that
  the implementer's own "21 sabotage passed" had missed.

- **L-022 Session-compaction → L-016 thrash; recover by writing it yourself + a fresh session.**
  On a long tandem run (ZB-DECOUPLE-001 Phase A/T1), Codex's session hit context compaction
  MID-TASK and drafted-without-applying — twice, on consecutive resumes (`git status` empty both
  times, log ends at `{"outcome":"allow"}` with no apply_patch, and the printed session id changed,
  the tell-tale of a compaction/new-rollout). Resuming the SAME degraded session again just
  re-compacts and produces nothing. Recovery: (a) after ANY Codex turn, `git status --short` — empty
  when files were expected = stalled, do not trust exit 0; (b) if it re-stalls once, STOP resuming
  that session — write the deliverable yourself from the already-approved design (the design/map
  MUST live in a committed durable spec so nothing is lost to the compaction), and start T-next in a
  FRESH `codex exec` (not resume). Deterministic, already-reviewed artifacts (migration SQL) are the
  cheapest to hand-write; validate them independently (e.g. a rolled-back apply against the real
  schema) rather than trusting the stalled session's claims.

## L-023 — gate sweep must cover EVERY sibling test of a changed module, not just the new one

When a task re-keys / rewrites a query module, mocked unit tests elsewhere that assert the OLD
SQL shape (or the OLD call contract) go stale silently — they are a real regression the moment the
production query changes, even though the task never edited them. In ZB-DECOUPLE T3b-2 the uuid-first
rewrite of `technicianWorkScheduleQueries` broke `technicianWorkScheduleMigration.test.js` (asserted
`= ANY($2::text[])` + a bare mock that the new identity-resolution path rejects), and my per-task
verify regex only ran the NEW `*Rekey.db.test.js`, so it slipped through to the final full sweep.
Rule: when gating a change to `<module>Queries.js`/`<module>Service.js`, run EVERY sibling suite that
imports it — `git grep -l "require.*<module>" tests/` — not just the task's own new test. The new
`.db` test proving the new contract does NOT absolve the old mocked tests that assert the superseded
one; either update or delete them in the SAME task. A green new-test next to an unrun stale sibling
is a false ACCEPT.

## L-024 — a safety guard on a destructive op must not be scoped by the actor's tenant filter

ZB-DECOUPLE B5: the contact-merge "zero donor references before archive" guard filtered child-row
checks by `company_id = <merge company>`. That is the natural tenant-scoping instinct — but this guard
exists to prove NOTHING still points at the donor before it is (soft-)deleted. A row owned by ANOTHER
company that references the donor (contact_id FKs are not company-composite, and ZB had cross-tenant
contact leaks historically) slipped past the company filter → the donor was archived → that reference
orphaned. Rule: tenant-scope the WRITES (reassignment can only move this company's rows), but make the
pre-destruction "no references remain" ASSERTION exhaustive — key it on the target's globally-unique id
alone, so a stray cross-tenant reference makes the guard THROW and refuse the op (surfacing the anomaly)
rather than silently destroying. A red-team suite that seeds the anomalous cross-tenant reference is what
catches this; per-task same-company tests never will.
