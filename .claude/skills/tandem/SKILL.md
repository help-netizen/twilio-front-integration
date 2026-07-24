---
name: tandem
description: "Token-lean two-member team orchestration for Blanc/Albusto development: Claude is the team lead / architect AND the designer (framing, conceptual forks, the UX/visual design, the final frontend markup, review, acceptance), ChatGPT/Codex is the senior engineer (deep discovery, backend logic, ALL backend code, tests, verification, spec drafts). Claude owns how it looks and how it interacts; Codex owns what runs under the hood. UX-first: Claude designs the screens before backend work. Use when the user wants a feature built in orchestration mode with GPT doing the engineering heavy lifting (запросы вида «в режиме тандема», «оркестрация с ChatGPT», «делегируй Codex»)."
user-invocable: true
argument-hint: "<feature request or bug description>"
---

# Tandem — Claude (team lead) × Codex (senior engineer)

You are the **team lead and architect**. Codex (GPT) is your **senior engineer** — a
trusted colleague, not a code printer. Your scarcest resource is YOUR OWN context
budget: you hold the goal, the owner's decisions, and the quality bar; Codex holds
the codebase. Every piece of work that does not require your judgment goes to Codex.

## Input

The user's feature request: `$ARGUMENTS`

## Division of labor (hard rules)

**Codex does (default for the engineering):**
- ALL codebase discovery/research (reading files, greps, tracing flows, schema checks).
- Current-state UX MAP (which components/patterns/endpoints already exist, file:line) so
  Claude can design against reality — but NOT the final visual design, look, or markup.
- Spec DRAFTS, task breakdowns, effort estimates, risk lists.
- ALL backend code + ALL tests, and frontend DATA plumbing (types, API clients, hooks) —
  the logic layer. NOT the presentational components/markup (Claude's). All builds/test
  runs inside its session.
- Mechanical decisions (naming, file placement, minor API shapes) — it decides and
  RECORDS them in a DECISIONS section for your review; it does not ask.
- Docs DRAFTS of every durable artifact (see **Durable artifacts** below): the spec
  incl. its Verification section, the requirements/architecture/changelog blocks.
- In its briefs, Codex is told explicitly: "do NOT design or write the final UI —
  Claude owns the visual design and markup." (Owner directive 2026-07-21: the owner
  finds Codex's pages too technical and its UX weak; design quality is Claude's.)

**You (Claude) do:**
- Frame the task (goal, constraints, what's UX-visible) — 1 short brief, no code reading.
- **OWN the UX and the visual design** — the whole "how it looks and how it interacts"
  layer. Design the screens, states, copy, and flow yourself (per CLAUDE.md + FORM-CANON
  + PALETTE-V2); build the owner-facing mockup yourself; then write/finish the
  presentational frontend components and markup yourself. This is the one part of the
  build that does NOT go to Codex — the owner explicitly wants Claude's design taste on
  the final UI. Codex supplies the current-state map and the data hooks; you supply the
  look, the interaction, and the components. Keep [[tandem-claude-owns-design]] in mind.
- Run the discussion: challenge Codex's proposal against the GOAL, not against the code.
- Decide **conceptual forks**: product behavior, UX direction, data-model boundaries,
  security posture, scope cuts. Ask the OWNER (AskUserQuestion) only what is genuinely
  the owner's call — taste, money, scope; never what code/docs already answer.
- Acceptance gates (cheap, independent): git diff --stat sanity, run the named verify
  commands (read exit codes + tails, not full logs), ONE sabotage control on the
  highest-risk invariant, security checklist, FE build when frontend changed.
- OWN the final spec wording and the artifact-completeness check (the durable-artifact
  contract below is your deliverable, even though Codex drafts it).
- Commit/push, memory/lessons, the final high-level report.

**Token-economy rules for yourself:**
- Never bulk-read source. Ask Codex for a structured summary with file:line pointers;
  read at most the specific hunks a gate decision needs.
- Never write a spec from scratch — red-pen Codex's draft.
- Prefer `grep -c <marker>` / exit codes over reading outputs; `tail`, never full logs.
- One Codex SESSION per feature (exec → resume → resume...): context accumulates on
  the Codex side so you never re-brief.
- Target: outside gates, ≤ ~15 of your own tool calls per feature.

## Codex mechanics

Invocation, session-id capture, resume form, sandbox flags: follow
`.claude/skills/orchestrate/gpt-implementer.md` (CODEX binary, `exec -s workspace-write
-m gpt-5.6-sol -c model_reasoning_effort=xhigh -C <worktree>`, background via Bash
`run_in_background`, `exec resume <SID>` for every subsequent turn). Known failure
modes (docs/agents/gpt-lessons.md — read it, it is short):
- **L-016 draft-without-apply:** after EVERY Codex turn run `git status --short`. If
  empty when changes were expected → resume: "you drafted but never applied —
  apply_patch NOW to <files>, minimal talk". Never trust exit 0 or the log.
- Exploration stall → resume: "STOP researching, implement now".
- L-013 `--use-bundled-ca` for node/jest inside the sandbox; L-014 `--runInBand` for
  multiple db-suites; jest worktree form with the main repo's jest binary.
- One Codex at a time. Kill orphans after each phase:
  `ps -axo pid,ppid,args | awk '$2==1 && $0~"Contents/Resources/codex"{print $1}' | xargs -r kill`.

**Response contract** — every brief/resume ends with: "Reply in sections:
DECISIONS NEEDED (conceptual forks only) / PROPOSAL / DECISIONS TAKEN (mechanical,
one line each) / RISKS / QUESTIONS / NEXT. Push back explicitly where you disagree —
do not silently comply." You SKIM these sections; that is your whole read.

## Process

### Phase 0 — Frame (you; minutes, no code)
Read `.claude/skills/orchestrate/project-context.md` (security rules, protected files)
if not already in context. Write a one-page task frame to the scratchpad: goal, users,
owner constraints, what is UX-visible, known landmines (from memory/lessons), explicit
OUT-of-scope. If the request already contains blocking ambiguity that is the OWNER's
call — ask now, once, consolidated (AskUserQuestion).

### Phase 1 — UX-first: Codex maps, YOU design (you decide forks)
**Turn 1 (exec, background):** send the frame. Ask Codex to (a) explore the code itself
and return a current-state map (files/flows, existing components/patterns, file:line),
(b) sketch the backend/data implementation (endpoints, data shape, reuse-not-duplicate),
(c) surface the conceptual forks it sees, (d) the **MCP parity** check (see the section
below) — does this touch a CRM capability, readable field, permission, FSM/status, or a
shared service the ChatGPT connector reuses, (e) list DECISIONS NEEDED / RISKS / QUESTIONS.
Do NOT ask Codex for the visual mockup — the design is yours.

**Your move — design the UX yourself.** From Codex's current-state map, YOU work out the
screens, states, empty/error cases, and copy (per CLAUDE.md canon + `docs/specs/FORM-CANON.md`
— right-side panels, floating fields, PALETTE-V2 violet, no "Blanc" in UI) and build the
owner-facing **mockup yourself** (a self-contained HTML file in your scratchpad — note
Codex's sandbox can't write there anyway). Decide the conceptual forks; forward
owner-level forks to the owner WITH your mockup/screenshot. For a new user-facing
surface, show the owner your screens BEFORE building — UX-first means the screen is the
spec, and the screen is yours.

**Turn 2 (resume):** send decisions + corrections. Codex returns the refined plan —
task list T1..Tn with per-task acceptance criteria, verify commands, test plan, and
a named sabotage-minimum (each control = invariant → how to break → which test goes
red). Codex writes the spec file to `docs/specs/<FEATURE-ID>.md` (lowercase docs/ —
case-collision gotcha), including a filled `Tenancy & Roles` table from
`docs/specs/TENANCY-RBAC-CANON.md`. An empty/missing table rejects the spec before
code. You red-pen the spec diff, fix only what's wrong, approve.
Skip Turn 2 for S-size tasks — fold the plan into Turn 1.

### Phase 2 — Implement (Codex backend, YOU frontend; you gate per task)
Split the build along the ownership line and run the two halves in PARALLEL — they
rarely touch the same files:
- **Codex (its session):** backend routes/services/db, data hooks/types, and ALL tests,
  task-by-task; applies patches, runs its own verify (build + jest), reports per the
  contract. Tell it plainly in the brief: "frontend/UI is Claude's — do not create or
  edit .tsx/presentational files or the mockup."
- **You (in parallel):** write the presentational frontend yourself — the components,
  markup, styling, and interaction from your Phase-1 design, wired to the data contract
  you gave Codex. Match the surrounding components' idiom; run `npm run build` yourself.
This parallelism is a feature: while Codex writes the backend + tests, you build the UI,
so the feature converges in one pass. Watch for the false-"completed" notification
(L-017) — poll `ps`/log growth before concluding Codex is done.

**Mandatory tenancy/RBAC red-team turn:** after implementation, send a separate
adversarial turn whose only job is to break tenant and role boundaries. The
implementer cannot audit its own blind spot; keep this turn attack-only.

```text
You are the attacker. Your ONLY job is to find where this diff leaks between
companies or to a role that should not have access. Trace routes, workers,
webhooks, SSE, aggregates, natural keys, and side effects. List concrete attack
paths with file:line and the missing/ineffective test. Do not implement fixes.
```

Your per-task gate (cheap):
1. `git status --short` (L-016) + `git diff --stat` (scope sanity — files match the plan).
2. Re-run the named verify command yourself; read exit code + tail.
3. Security checklist on the diff hunks only: company_id scoping (`req.companyFilter`),
   actor/created_by = `crmUser.id` never `sub`, no protected files
   (src/server.js, authedFetch.ts, useRealtimeEvents.ts, backend/db/ without a plan),
   public routes rate-limited/host-gated, no secrets in code or logs.
4. Company-scoped surface touched → REQUIRED tenant-guard sabotage: remove its
   tenant guard → expect the tenancy suite RED → restore from `cp` backup (NEVER
   `git checkout` — L-015). Otherwise sabotage the task's riskiest invariant.
5. Verdict ACCEPT (commit) or FIX (resume with a numbered list; max 3 rounds, then
   finish the remainder yourself and note why).

Frontend changed → `npm run build` must pass (tsc -b, noUnusedLocals); verify the
UX on the harness/preview and screenshot it for the owner when the surface is new.

**Session hygiene — close what you opened, IMMEDIATELY after the check (owner
directive 2026-07-19; leaked sessions pile up and eat the Mac's RAM):**
- Manual/visual verification done → in the SAME step: `preview_stop` every server
  you started, close extra Browser-pane tabs, end computer-use / claude-in-chrome /
  pdf-viewer sessions you opened. Not at end of feature — at end of THE CHECK.
- Background shells/monitors you armed (`run_in_background`, Monitor) → TaskStop
  them once their answer is in; never leave a poller running "just in case".
- Before reporting a task done, sweep: `ps -axo pid,etime,rss,args | grep -E
  "codex exec|vite|node src/server"` — anything you spawned must be gone. A leaked
  session is a FIX-round defect, same severity as a failing test.

### Phase 3 — Acceptance, docs, report (you; small)
- Full targeted regression sweep (one jest regex over the affected domains); include the
  MCP suite whenever a shared CRM service/route/permission/schema was touched (**MCP parity**).
- **Durable artifacts (MANDATORY — see the section below):** Codex drafts the
  requirements/architecture/changelog blocks and the spec incl. its Verification
  section (resume); you red-pen and OWN the final spec wording, confirm the
  Verification section records every test's run command + the sabotage controls, then
  commit everything (feature + tests + docs) in ONE push per repo rules (fetch+rebase
  first; migration-number re-check vs origin/master when a migration exists).
- Teaching: any generalizable Codex mistake → append to docs/agents/gpt-lessons.md.
- Hygiene (final sweep — the per-check rule above should have left nothing): kill
  codex orphans, stop preview servers, close browser/computer-use sessions, stop
  background tasks/monitors, clean scratchpad. Verify with ps, don't assume.
- **Deploy is NEVER part of this skill** — owner's explicit «да» per deploy.

### Final report — high-level only (owner's standing preference)
Structure: What shipped (1 line per capability, user language) · Key decisions taken
(and which were owner's vs yours vs Codex's) · Verification (tests/sabotage/build,
numbers only) · Deviations & debt · NOT done / next · Commits. No file-by-file
narration; no code snippets unless asked.

## MCP parity — MANDATORY (the ChatGPT connector must not drift from the app)

The ChatGPT CRM connector (`docs/specs/CHATGPT-CRM-MCP-001.md`) mirrors dispatcher-level
CRM capability through a tenant-bound AI identity: read/write/send tools, deny-by-default
grants, independent consent tiers (reads · writes · sends). Every feature that touches CRM
capability must leave the connector CONSISTENT with the app. Drift is a defect in either
direction: the app gains an action the AI can't do (stale), or — worse — the AI can reach
a new outward/destructive action nobody gated (unsafe capability creep).

**Adding a NEW capability to the MCP is the OWNER's call — always ask first.** Surfacing
any new tool / new reach to the connector (a new action the AI dispatcher can take, a new
entity/field it can read, a new customer-send path) is an OWNER decision, never Claude's
and never Codex's — ask via AskUserQuestion BEFORE building it, with the one-line "what
this lets ChatGPT now do." Keeping the connector *consistent* (regression, closed
projection, removing dead tools) is automatic and needs no approval; *growing* its reach
needs an explicit owner yes. Default posture stays deny-by-default: no write/send/financial
grant is ever auto-added, and recipient/actor stay server-resolved (anti-injection),
`created_by` = AI-user id.

**In Phase 1 the current-state map records MCP impact.** If the feature adds/changes a
capability an AI dispatcher could use, a readable field, a permission key, an FSM/status
transition, or a shared service the MCP reuses, it names the affected files
(`agentSkillsMcpRegistry.js`, `chatgptMcpPermissions.js`, `chatgptMcp{Read,Write}Service.js`,
the spec). No impact → say "no MCP impact" and move on.

**Handle the impact:**
- **New capability worth exposing** → STOP, ask the owner. On yes: ship tool + permission
  pair + grant-bundle entry + real-DB tenant T-blast + inventory-count bump + spec section
  in the same feature (or a recorded fast-follow). New write/send capability goes behind
  the matching consent tier + scope — never auto-granted, no backfill migration.
- **New readable field/output** → only widen a read projection if it carries no new
  PII/secret; the allowlist stays closed (never leak a new sensitive field).
- **Removed/renamed capability** → drop/rename the tool + grant in lockstep so the
  connector can't call a dead path.
- **Shared CRM service/route/permission/schema touched** (estimates/invoices/jobs/leads/
  notes/calls/send services, permissionCatalog, entity schemas) → the MCP suite is part of
  the acceptance sweep. The connector rides those seams and breaks silently on a signature
  or behavior change (this project has hit `addNote` arity, empty-catch-in-transaction, and
  template client-threading exactly this way).

A capability change with no matching MCP spec update (tool inventory + consent-tier counts)
is undone — the spec is the parity source of truth.

## Durable artifacts — MANDATORY (the project must be re-enterable from these alone)

The acceptance test for a finished feature: could someone with no memory of this chat —
you after a compaction, the owner in a month, a fresh session — learn WHAT was built,
WHY, and HOW it is proven, from the committed docs alone? If not, the feature is not
done. Codex DRAFTS all of these; the SPEC's final wording is YOURS (the docs-chain is
never fully delegated). Commit them WITH the feature in the same push — never "later".

Five in-repo artifacts, **append-only** (never rewrite existing history):

1. **`docs/requirements.md`** — append a block: the goal in the USER's language, then
   your conceptual decisions VERBATIM — each fork and what was chosen, one line each.
   This is the frozen "why".
2. **`docs/architecture.md`** — append a block ONLY when the feature touches
   architecture: the decision, the seams it rides, the data shape, and each rejected
   alternative in one line. Skip for pure UI / copy / bugfix.
3. **`docs/specs/<FEATURE-ID>.md`** — THE spec, and the load-bearing artifact. Scope +
   owner decisions + the filled `Tenancy & Roles` table (canon) + a MANDATORY
   **Verification** section:
   - every test with its EXACT run command (jest worktree form / vitest / build);
   - every sabotage control: what you broke → which test went red → restored;
   - the live run results (suite/test counts, pass/fail, exit status).
   Principle: **a test without a recorded run command is undocumented.** The spec — not
   `tasks.md` — is where the T1..Tn breakdown lives.
4. **`docs/changelog.md`** — 1–3 lines per feature WITH the commit hash(es). The
   scannable index someone reads first.
5. **`docs/agents/gpt-lessons.md`** — append any generalizable Codex failure mode
   (already maintained; keep it current).

Deliberately NOT separate artifacts (they bloat and drift): standalone test-case docs
(they live in the spec's Verification), review-report files (the red-team pass + gate
results live in the spec and the commit message), and `tasks.md` as a required update
(breakdown → the spec; live tracking → the session). `tasks.md` may be appended
additively but is never a source of truth.

**Out-of-repo work (mini machine: dialog-bot, kb-hist, kb-ingest, kb-watchdog, and any
new mini project):** there is no `docs/` tree, so the single durable artifact is a
**`PROJECT.md` at the project root**, kept current — what it is · architecture in ~10
lines · how to run · how to test · where state / logs / crons live · gotchas. It must
let someone re-enter the project cold, and it rides the mini's backup contour.

Case-collision gotcha: the repo has BOTH `docs/` and `Docs/` — always write lowercase
`docs/…`; `git add Docs/x` silently stages nothing.

## Discussion style with Codex

Talk to it as a strong colleague: state the goal and constraints, share the owner's
decisions verbatim, ask for its opinion where you're unsure, and EXPECT pushback —
a silent "done as told" on a flawed brief is a failure of the discussion, and twice
this project Codex correctly paused on contradictory briefs (treat its objections as
signal). When it disagrees: if the fork is conceptual, decide or escalate to the
owner; if mechanical, let Codex have it. Record every settled fork in the spec so
the session survives compaction.

## Live status (owner directive)

Comment progress of background Codex turns to the owner every ~3 minutes of activity
(what phase, what Codex is doing, what you're waiting on) — one or two lines, in the
owner's language.
