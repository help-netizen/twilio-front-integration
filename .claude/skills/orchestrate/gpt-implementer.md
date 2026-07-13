# GPT Implementer Protocol (Codex / gpt-5.6-sol)

How the Orchestrator (Claude = architect + product owner + reviewer) delegates implementation
to GPT via Codex CLI. Goal: GPT writes the code, Claude guards quality — and spends its own
tokens only on briefs, diffs, and verdicts.

## Roles

| | Claude (you) | GPT (Codex) |
|---|---|---|
| Product/architecture/spec | ✅ | — |
| Task briefs, discussion | ✅ | asks questions |
| Implementation + unit tests | — | ✅ |
| Self-verification (build/jest) | — | ✅ runs itself |
| Independent verification | ✅ (exit codes) | — |
| Diff review, verdict | ✅ | fixes per feedback |
| Commits, docs, deploy | ✅ | NEVER commits |
| Teaching (lessons log) | ✅ appends | reads every task |

## Invocation (CLI-first; MCP `mcp__codex__codex` is the fallback)

```bash
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex   # NOT Codex.app (renamed 2026-07-11)
$CODEX exec -s workspace-write -m gpt-5.6-sol -c model_reasoning_effort=xhigh \
  -C "<absolute worktree path>" \
  -o "$SCRATCHPAD/gpt-task-<ID>-r<round>.md" \
  "<brief>" </dev/null 2>&1 | tee "$SCRATCHPAD/gpt-task-<ID>-r<round>.log" | grep -m1 'session id:'
```

- Capture the `session id:` from the banner — fix rounds continue the SAME session:
  `$CODEX exec resume -c 'sandbox_mode="workspace-write"' <SESSION_ID> "<fix list>" </dev/null 2>&1 | tee <log>`
  ⚠️ `resume` does NOT accept `-s`/`-o` (verified v0.144): sandbox only via the `-c sandbox_mode` config
  override, and the final message must be taken from stdout (tail of the log), not `-o`.
  Do NOT use `resume --last` — parallel sessions may exist.
- GPT auto-reads repo `AGENTS.md` + `~/.codex/AGENTS.md`; the brief does not need to repeat canon.
- Sandbox has no network. If deps must be installed, Claude installs them before invoking.
- Long tasks: codex exec has no hard timeout, but keep tasks ≤ ~1 significant module; split bigger work.

## Brief template (keep it SHORT — pointers, not payloads)

```
TASK <FEATURE-ID>-T<N>: <one-line goal>

Read first:
- Docs/specs/<FEATURE-ID>.md (the spec — authoritative)
- docs/agents/gpt-lessons.md (mandatory)
- <2-5 file paths GPT must study before editing>

Scope:
- <bullet: exact changes expected, per file/module>

Acceptance criteria:
- <observable behaviors, incl. edge cases worth calling out>

Constraints:
- <task-specific constraints; migration number to use; what NOT to touch>

Verify: <exact commands GPT must run and report>
```

**Plan-first for M/L tasks:** first turn = same brief + "Reply with your implementation PLAN only
(files + approach + risks). Do NOT edit anything yet." Review the plan (cheap), then
`resume <SID> "Plan approved with adjustments: ... Implement now."`
Skip for small tasks.

## Review procedure (token-disciplined)

1. Read GPT's final message (`-o` file) — deviations/questions first.
2. `git status --short` — file set matches scope? Out-of-scope files = instant fix round.
3. `git diff --stat`, then `git diff` — review the full diff ONCE per round. Only open full source
   files when the diff is insufficient to judge correctness.
4. Independent gates (never trust the self-report):
   - frontend touched → `cd frontend && npm run build` AND `cd frontend && npm test` (vitest; exit codes,
     read output only on failure)
   - backend touched → `npm test -- --testPathPattern '<area>'` (same)
5. Review checklist, in priority order:
   - tenant scoping (`company_id` on every new query; `req.companyFilter?.company_id`)
   - correctness vs spec + acceptance criteria
   - security: parameterized SQL, auth middleware, `crmUser.id` for FKs
   - design canon (panel dialogs, floating fields, tokens, no separators)
   - tests are real (exercise logic, not mocked-to-green; 401/403 + isolation for new routes)
   - no scope creep, no dependency additions, no protected-file edits, no weakened tests
6. Verdict:
   - **ACCEPT** → Claude commits (Co-Authored-By both agents' contributions as usual), updates docs.
   - **FIX** → `resume <SID>` with a NUMBERED fix list (terse, imperative, cite file:line).
     Max **3 fix rounds**; after that Claude fixes the remainder itself and logs why.

## Teaching loop (this is how GPT gets better)

- Every review mistake that is *general* (would recur on other tasks) → append a one-liner to
  `docs/agents/gpt-lessons.md` (`L-NNN (date) — lesson`). Task-specific misses don't go there.
- If the same lesson is violated twice → also tighten the relevant section of `AGENTS.md`.
- Periodically (every ~10 lessons) fold stable lessons into `AGENTS.md` and prune the log.

## Resource hygiene (owner directive — MANDATORY)

After every codex run and at the end of each implementation loop:
- kill orphaned codex CLI processes:
  `ps -axo pid,ppid,args | awk '$2==1 && $0~"Contents/Resources/codex"{print $1}' | xargs kill 2>/dev/null`
  (this never touches the ChatGPT.app GUI);
- one codex task at a time on the macbook — no parallel fleets here;
- stop any dev servers / previews started for verification; remove bulky scratchpad artifacts.

## When NOT to delegate

- One-to-three-line fixes where the brief would exceed the diff — do it yourself.
- Prod emergencies (deploy/rollback/data repair) — Claude only.
- Tasks requiring live preview-driven UI iteration (browser feedback loop) — Claude drives the
  browser; GPT can still do the initial implementation from spec.
