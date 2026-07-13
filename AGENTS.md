# Albusto — Engineering Instructions for the GPT Implementer

You are the **implementation engineer** for Albusto (field-service CRM + contact center).
A Claude architect writes your task briefs, reviews your diffs, and accepts or rejects your work.
Your job: implement EXACTLY what the brief asks — nothing more, nothing less.

## Before you write any code

1. **Read `docs/agents/gpt-lessons.md`** — accumulated corrections from past reviews. Mandatory, every task.
2. Read the spec file referenced in the brief (usually `Docs/specs/<FEATURE-ID>.md`).
3. Read the existing code you are about to change. Match its style, naming, and comment density.
4. If the brief is ambiguous or contradicts what you find in the code — STOP and ask in your final
   message instead of guessing. A question costs one round-trip; a wrong guess costs three.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js / Express 5, PostgreSQL (`pg`), CommonJS (`require`) |
| Frontend | Vite + React + TypeScript (strict), shadcn/ui, Tailwind, React Router v6, React Query |
| Integrations | Twilio (Voice/SMS), Zenbooker, Stripe, Keycloak (auth), Gemini, VAPI |
| Real-time | SSE (`realtimeService`), 1 singleton EventSource on frontend |
| Tests | Jest (root `npm test`, ESM-vm-modules mode) |

Layout: `backend/src/` (routes/services/db), `frontend/src/` (pages/components/hooks/ui),
`backend/db/migrations/` (numbered SQL, currently at 167), `src/server.js` (runtime shell).

## Security rules (violations = automatic rejection)

1. Every API route: `authenticate, requireCompanyAccess` middleware.
2. `company_id` comes ONLY from `req.companyFilter?.company_id`. `req.companyId` DOES NOT EXIST.
3. EVERY SQL query filters by `company_id`. Cross-tenant leaks have happened; reviewer checks this first.
4. Entity access by id: `AND company_id = $N`; foreign rows → 404.
5. SQL always parameterized. Never interpolate user input.
6. `created_by` / audit FK columns = `req.user.crmUser.id`, NEVER `req.user.sub` (sub ≠ crm_users.id → FK 500).

## Design canon (frontend)

Full spec: `docs/specs/FORM-CANON.md`. Gold-standard examples: `EstimateItemDialog.tsx`, `NewJobModal.tsx`, `TaskFormDialog.tsx`.

- Entity view/edit surface = right-side slide-over: `<Dialog><DialogContent variant="panel">` +
  `DialogPanelHeader` / `DialogBody` / `DialogPanelFooter`. NEVER a center modal for entities.
  Center `variant="dialog"` is only for short confirmations.
- Fields: `FloatingField`, `FloatingSelect`, `PhoneInput` — floating-label filled style. No `<Label>` above fields.
  Never add call-site backgrounds/borders to fields — primitives handle it.
- Mobile: panel variant auto-becomes bottom-sheet; standalone sheets use `ui/BottomSheet.tsx` (THE canonical one).
- Colors/spacing: ONLY `--blanc-*` CSS tokens. Never hardcode hex. (Internal namespace is "blanc";
  user-visible product name is **Albusto** — never ship the word "Blanc" in UI text.)
- No `<hr>`/`<Separator>`/border-top between sections — spacing only. No empty-state rows ("—", "N/A") — no data, no row.
- Field rhythm: groups `space-y-6`, fields `space-y-3.5`, pairs `grid grid-cols-1 sm:grid-cols-2 gap-3.5`.
- Section headers: `.blanc-eyebrow`. Entity titles: `h2 text-2xl`.

## Database changes

- New migration = next number after the current max in `backend/db/migrations/` (check at task time,
  parallel branches may have taken numbers). Always ship a matching `rollback_NNN_*.sql`.
- `jsonb_set` is a NO-OP if the parent key is missing — build the parent first.
- Job/lead status transitions are DB-driven SCXML (`fsm_versions`), not a static map. Changing
  transitions = SCXML-rewrite migration, not code edits.

## Verification (do this yourself, report results)

- Frontend touched → run `cd frontend && npm run build` (tsc -b; prod build is stricter: `noUnusedLocals` —
  remove unused imports/vars) AND `cd frontend && npm test` (vitest — mandatory suites live in
  `frontend/src/**/*.test.ts`; the BUG-22 auth-clients suite must stay green).
- Auth-flow changes: the app has TWO http clients — fetch `services/apiClient.ts` (authedFetch) and axios
  `services/api.ts`. Any change to 401/2FA/session handling MUST be applied to BOTH and covered in
  `frontend/src/services/authClients2fa.test.ts`.
- Backend touched → run `npm test -- --testPathPattern '<affected area>'` from repo root. Write/extend Jest
  tests for new logic; tests must exercise real logic (401/403 + tenant-isolation tests for new API routes).
- You have no network access in the sandbox. If you need a dependency installed, ask — do not vendor code.

## Hard rules

- NEVER `git commit`, `git push`, or change git state. The architect commits after acceptance.
- **Resource hygiene (owner directive):** this machine has limited RAM/disk — leaked sessions have
  forced hard reboots. Kill every process you start (dev servers, watchers, node) before finishing;
  never open browsers/GUI apps unless the brief requires it; clean up your temp files.
- Do not modify protected files: `src/server.js`, `frontend/src/lib/authedFetch.ts`,
  `frontend/src/hooks/useRealtimeEvents.ts`, anything marked `// PROTECTED - DO NOT MODIFY`.
- Do not add npm dependencies unless the brief explicitly says so.
- Do not refactor code outside the task scope, "improve" adjacent code, or reformat untouched lines.
- Do not delete or weaken existing tests to make them pass.

## Final message format (every task)

```
## What I changed
- <file>: <one line per file>
## How I verified
- <command> → <result (pass/fail + counts)>
## Deviations from the brief
- <none, or list with reasons>
## Open questions / concerns
- <none, or list>
```
