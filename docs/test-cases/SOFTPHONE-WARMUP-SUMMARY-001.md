# Тест-кейсы: SOFTPHONE-WARMUP-SUMMARY-001

Mobile-proof warm-up modal (three belts + `useIsMobileDevice` capability gate) + "Today at a glance" summary content + additive `parent_type` pass-through on `GET /api/tasks/count`.

**Sources:** spec `Docs/specs/SOFTPHONE-WARMUP-SUMMARY-001-SPEC.md` (PRIMARY; §refs below), requirements `## SOFTPHONE-WARMUP-SUMMARY-001` (END of `Docs/requirements.md`, :4912), architecture (END of `Docs/architecture.md`, :5611).

**Harness reality (pinned):** frontend has NO test runner — frontend verification = STATIC (grep) / BUILD (tsc) / PREVIEW (Claude Browser + `?warmup=preview`) / REVIEW (honest code-review, explicitly flagged). Backend jest EXISTS: `tests/routes/tasks.test.js` (GET /count describe at :86). **Worktree jest trap (spec §6.1):** root `package.json` has `testPathIgnorePatterns: ["/node_modules/", "/\\.claude/worktrees/"]` — a default `npx jest` run from inside this worktree executes ZERO tests. Run either:

```
npx jest tests/routes/tasks.test.js tests/tasksCount.test.js --testPathIgnorePatterns=/node_modules/
# or
npx jest --testPathIgnorePatterns "/node_modules/" --roots "$(pwd)/tests" --testPathPatterns "tasks"
```

### Покрытие

- Всего тест-кейсов: 32
- P0: 21 | P1: 10 | P2: 1 | P3: 0
- UNIT (backend jest): 5 | STATIC: 12 | BUILD: 1 | PREVIEW: 6 | REVIEW: 8

Existing docs checked: `TASKS-COUNT-BADGE-001.md` covers the /count endpoint baseline (its jest TC-5..24 live at `tests/routes/tasks.test.js:86-175`) — NOT duplicated here; this doc adds only the `parent_type` delta + drift guards. `tests/tasksCount.test.js:46-60` already covers `parent_type` at the query layer — no new cases there.

---

## A. UNIT — backend jest (`tests/routes/tasks.test.js`, extend the GET /count describe at :86)

Shared preconditions (existing harness in the file): supertest over `makeApp()`, mocked `db.query` (`mockQuery`), real `tasksQueries` layer, default identity = manager with `tasks.view`+`tasks.manage`, `ME` = crmUser.id, `kc` = Keycloak sub. Mock: `mockQuery.mockResolvedValueOnce({ rows: [{ count: N }] })`.

### TC-WS-01: `?parent_type=timeline` adds the timeline predicate, NO new SQL param
- **Приоритет:** P0 | **Тип:** UNIT (jest)
- **§ref:** spec §5.3-1, §5.2; AC-4; FR-COUNT-API
- **Шаги:** `GET /api/tasks/count?parent_type=timeline` (manager identity).
- **Ожидаемый результат:** 200 `{ ok: true, data: { count: N } }`; captured SQL contains `t.thread_id IS NOT NULL`; **params array unchanged vs the no-param call** (predicate is `IS NOT NULL`, no `$n` added — assert `params.length` equals the no-param case / params = `[companyId, 'open']`); manager role branch intact (`sql` does NOT match `/t\.owner_user_id = \$/`); tenant scoping present (`t.company_id = $1`).

### TC-WS-02: no param → SQL byte-identical to today (drift guard)
- **Приоритет:** P0 | **Тип:** UNIT (jest)
- **§ref:** spec §5.3-2, §5.2 backward-compat; AC-4
- **Шаги:** `GET /api/tasks/count` (no query string).
- **Ожидаемый результат:** SQL does **NOT** contain `thread_id IS NOT NULL` beyond what `HAS_ENTITY_PARENT` already carries — strongest form: capture the no-param SQL+params and assert byte-equality with a snapshot of today's shape (same predicate set, same `$n` numbering as the existing TC-8 assertions). Nav-badge number semantics unchanged.

### TC-WS-03: `?parent_type=bogus` silently ignored (no 400)
- **Приоритет:** P0 | **Тип:** UNIT (jest) — негативный
- **§ref:** spec §5.3-3, §5.2 validation path (`isValidParentType`, pinned no-400 contract); AC-4
- **Входные данные:** `GET /api/tasks/count?parent_type=bogus`
- **Ожидаемый результат:** 200 (NOT 400); SQL+params **byte-equal to TC-WS-02** (assert equality of the two captured SQL strings and params arrays).

### TC-WS-04: provider scope (no `tasks.manage`) + `?parent_type=timeline` → both predicates
- **Приоритет:** P0 | **Тип:** UNIT (jest)
- **§ref:** spec §5.3-4, §5.2 role scoping; AC-4
- **Предусловия:** `makeApp({ permissions: ['tasks.view', 'tasks.create'] })` (no manage).
- **Шаги:** `GET /api/tasks/count?parent_type=timeline`.
- **Ожидаемый результат:** SQL contains BOTH `t.owner_user_id = $2` AND `t.thread_id IS NOT NULL`; `params[1] === ME` (crmUser.id, never `kc` sub — `params` does not contain `'kc'`); status param `'open'` still present. Data isolation: `t.company_id = $1` present (cross-tenant probe can only count own company's rows).

### TC-WS-05: existing 9 GET /count tests stay green untouched
- **Приоритет:** P1 | **Тип:** UNIT (jest) — regression
- **§ref:** spec §5.3 last para; §7 protected (`/count` no-param behavior, role branch)
- **Шаги:** run the full file with the worktree-override command above.
- **Ожидаемый результат:** all pre-existing cases in `tests/routes/tasks.test.js` (:87-175: happy path, 403 no-perm, manager/provider scoping, list-predicate parity, HAS_ENTITY_PARENT, route order `/count` vs `/:id`, assignee_id parity, 500 envelope) pass WITHOUT edits; `tests/tasksCount.test.js` untouched and green. Security baseline (403 without `tasks.view`, tenant `$1` scoping) is carried by these existing tests — not re-written here.

---

## B. STATIC — grep/inspection against the worktree (no runner needed)

All run from repo root. FAIL = grep result differs from stated expectation.

### TC-WS-06: Belt 1 — `softPhoneEnabled` includes `!isMobileDevice`
- **Приоритет:** P0 | **Тип:** STATIC
- **§ref:** spec §2 table row 1; FR-MOBILE-FIX D1; AC-1
- **Шаги:** `grep -n "softPhoneEnabled = " frontend/src/components/layout/AppLayout.tsx`
- **Ожидаемый результат:** the expression is `!isMobile && !isMobileDevice && softPhoneGroupsLoaded && softPhoneGroups.length > 0` — only the `!isMobileDevice` term added, rest verbatim (§7 protected semantics).

### TC-WS-07: Belts 2a/2b — explicit `!isMobile && !isMobileDevice` in arming effect AND Dialog `open`
- **Приоритет:** P0 | **Тип:** STATIC
- **§ref:** spec §2 table rows 2a/2b; FR-MOBILE-FIX (b); AC-1
- **Шаги:** grep `AppLayout.tsx` for the arming `useEffect` (`setShowWarmUp(true)`) and the `WarmUpSummaryDialog open=` expression.
- **Ожидаемый результат:** arming = `if (!isMobile && !isMobileDevice && softPhoneEnabled && voice.phoneAllowed && voice.deviceReady)` with deps gaining `isMobile, isMobileDevice`; Dialog open = `(showWarmUp || warmUpPreview) && !isMobile && !isMobileDevice && !location.pathname.startsWith('/schedule')`. The belt must NOT rely on `softPhoneEnabled`'s indirection — both explicit terms present in BOTH surfaces.

### TC-WS-08: Belt 3 — reset-on-flip effect exists
- **Приоритет:** P0 | **Тип:** STATIC
- **§ref:** spec §2 table row 3; FR-MOBILE-FIX (c); AC-1
- **Шаги:** grep `AppLayout.tsx` for `setShowWarmUp(false)` inside an effect.
- **Ожидаемый результат:** `useEffect(() => { if (isMobile || isMobileDevice) setShowWarmUp(false); }, [isMobile, isMobileDevice])` — un-latches a modal armed during a transient wrong-width window.

### TC-WS-09: Widget render gate includes `!isMobileDevice`
- **Приоритет:** P0 | **Тип:** STATIC
- **§ref:** spec §2 table row 5; FR-MOBILE-FIX D1 (no softphone artifacts on mobile)
- **Шаги:** `grep -n "SoftPhoneWidget" frontend/src/components/layout/AppLayout.tsx`
- **Ожидаемый результат:** render is `{!isMobile && !isMobileDevice && <SoftPhoneWidget …/>}`.

### TC-WS-10: `useIsMobileDevice` imported ONLY by AppLayout (guardrail)
- **Приоритет:** P0 | **Тип:** STATIC
- **§ref:** spec §1.3 consumer restriction, §6.4-2
- **Шаги:** `grep -rn "useIsMobileDevice" frontend/src --include="*.ts*"`
- **Ожидаемый результат:** hits ONLY in `hooks/useIsMobile.ts` (definition + JSDoc guardrail note) and `components/layout/AppLayout.tsx` (import + call + belt sites). No layout/overlay file adopts it; no parallel width hook appears in any other file.

### TC-WS-11: `useIsMobile` still exported with the same signature
- **Приоритет:** P0 | **Тип:** STATIC (compile coverage via TC-WS-18)
- **§ref:** spec §1.2, §1.4; FR-MOBILE-FIX (a) drop-in constraint
- **Шаги:** grep `frontend/src/hooks/useIsMobile.ts` for the export.
- **Ожидаемый результат:** `export function useIsMobile(breakpoint: number = DEFAULT_BREAKPOINT): boolean` (optional param, default 768) still present; width-only semantics (NO `pointer: coarse` term in §1.2's query). The 26 call-sites are not individually re-tested — they compile unchanged under the strict prod tsc (TC-WS-18 is the gate) and are §7-protected.

### TC-WS-12: old modal copy fully gone
- **Приоритет:** P0 | **Тип:** STATIC — негативный
- **§ref:** spec §3.2/§0.2; FR-SUMMARY content swap
- **Шаги:** `grep -rn "SoftPhone Ready\|Enable incoming call ringtone\|Enable Ringtone" frontend/src`
- **Ожидаемый результат:** ZERO hits. No other 'SoftPhone Ready' strings remain anywhere in `frontend/src`.

### TC-WS-13: D4 copy verbatim in `WarmUpSummaryDialog.tsx`
- **Приоритет:** P0 | **Тип:** STATIC
- **§ref:** spec §3.2 (incl. columns table); FR-COPY; D4
- **Шаги:** grep `frontend/src/components/layout/WarmUpSummaryDialog.tsx` for each string.
- **Ожидаемый результат:** exact strings present: `Today at a glance` (DialogTitle), `Enabling sound for incoming calls` (DialogDescription), column labels `Pulse inbox` / `New leads` / `Open tasks`, primary button `Let's go`. Routes wired per §3.2: `/pulse`, `/leads`, `/tasks`. "Blanc" appears nowhere in UI strings.

### TC-WS-14: gesture order — `warmUpAudio()` is the FIRST synchronous statement
- **Приоритет:** P0 | **Тип:** STATIC
- **§ref:** spec §2.7 gesture contract; AC-3; softphone-warmup canon (protected)
- **Шаги:** read `handleWarmUpDismiss` and the column-navigate handler in `AppLayout.tsx` (and any handler in `WarmUpSummaryDialog.tsx`).
- **Ожидаемый результат:** in EVERY dismiss/navigate path `warmUpAudio()` is the first synchronous statement — no `await`, `setTimeout`, or state update before it. Column order exactly: `warmUpAudio(); setShowWarmUp(false); navigate(path);`. "Let's go" = `warmUpAudio(); setShowWarmUp(false);` (no navigation).

### TC-WS-15: `?warmup=preview` wrapped in `import.meta.env.DEV`
- **Приоритет:** P0 | **Тип:** STATIC
- **§ref:** spec §6.3 prod safety
- **Шаги:** `grep -n "warmup" frontend/src/components/layout/AppLayout.tsx`
- **Ожидаемый результат:** `const warmUpPreview = import.meta.env.DEV && new URLSearchParams(location.search).get('warmup') === 'preview';` — the `import.meta.env.DEV` guard is part of the SAME expression (statically replaced with `false` in prod builds → dead code). The dismiss handler strips the param only under `if (warmUpPreview)`.

### TC-WS-16: orphaned imports removed from AppLayout
- **Приоритет:** P0 | **Тип:** STATIC (enforced by BUILD TC-WS-18 — prod `noUnusedLocals`)
- **§ref:** spec §0.7-3, §3.1
- **Шаги:** grep `AppLayout.tsx` import block.
- **Ожидаемый результат:** `Phone`, `Button`, `Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter` no longer imported by `AppLayout.tsx` (they were used ONLY by the old :192 JSX; they now live in `WarmUpSummaryDialog.tsx`). `WarmUpSummaryDialog` is imported instead.

### TC-WS-17: hook mechanics greps — coarse-pointer OR-term, 767.98 query, rAF one-shot + cleanup
- **Приоритет:** P1 | **Тип:** STATIC
- **§ref:** spec §1.1 (rAF, dual listeners, cleanup), §1.2 (query), §1.3 (query), §6.4-1/-4
- **Шаги:** grep `frontend/src/hooks/useIsMobile.ts`.
- **Ожидаемый результат:** (a) `useIsMobileDevice` query is the single matchMedia string `(max-width: 767.98px), (pointer: coarse)` — comma-OR, `(pointer: coarse)` present; (b) `useIsMobile` query template yields `(max-width: 767.98px)` at default breakpoint (`breakpoint - 0.02`); (c) `requestAnimationFrame(check)` scheduled ONCE in the effect (never re-scheduled) and `cancelAnimationFrame` in the cleanup; (d) BOTH `mql.addEventListener('change', …)` AND `window.addEventListener('resize', …)` subscribed, both removed in cleanup; (e) `check` reads `mql.matches`, never `innerWidth`.

---

## C. BUILD

### TC-WS-18: frontend production typecheck/build green
- **Приоритет:** P0 | **Тип:** BUILD
- **§ref:** spec §6.1-1; AC-5
- **Шаги:** `cd frontend && npm run build` (tsc -b; prod Docker is stricter — `noUnusedLocals`).
- **Ожидаемый результат:** exit 0. This single gate carries: all 26 `useIsMobile` call-sites compile (TC-WS-11), the `?? 0` badge-prop coercions typecheck against unchanged `AppNavTabs`/`BottomNavBar` prop types (§4.1), orphaned-import cleanup (TC-WS-16), `WarmUpSummaryDialogProps` shape (§3.1).

---

## D. PREVIEW — Claude Browser, desktop viewport, dev servers per `.claude/launch.json` (backend :3100, frontend vite :3001)

Preconditions: both servers started; logged in via local KC when available. **Reality (spec §6.2):** `voice.deviceReady` never fires in dev without live Twilio creds — the modal cannot arm naturally; ALL preview cases use the committed DEV mechanism `?warmup=preview` (§6.3). If the local KC session is unavailable in the automated browser, TC-WS-20's numeric cross-check degrades to "—"-layout verification (itself a valid D5/AC-6 check) and AC-2's numeric part falls to REVIEW TC-WS-31 + the jest SQL assertions (documented degradation, not a silent skip).

### TC-WS-19: preview renders the summary dialog
- **Приоритет:** P0 | **Тип:** PREVIEW
- **§ref:** spec §3.2, §6.3 script; FR-SUMMARY; AC-2 (layout half)
- **Шаги:** open `http://localhost:3001/pulse?warmup=preview` → `preview_snapshot`.
- **Ожидаемый результат:** dialog open: title "Today at a glance", description "Enabling sound for incoming calls", THREE stat columns (buttons) labeled "Pulse inbox" / "New leads" / "Open tasks", full-width primary "Let's go". `preview_inspect` on the stat surface confirms the CloudBanner (`.blanc-cloud`) background backs the 3-column grid. No `Phone` icon, no old copy.

### TC-WS-20: counts show live numbers matching nav badges + AR, or "—"
- **Приоритет:** P1 | **Тип:** PREVIEW
- **§ref:** spec §3.3, §4.3, §6.3; AC-2, AC-6; D5
- **Шаги:** authenticated preview → read the three column values and the nav badge values (`preview_snapshot`/`preview_eval`); check `preview_network` for exactly one `GET /api/tasks/count?parent_type=timeline`.
- **Ожидаемый результат:** column 2 = leads badge, column 3 = tasks badge, column 1 = pulse badge + AR count (the `?parent_type=timeline` response); `0` renders as `0` (not "—"). Unauthenticated/failed fetch → "—" in `var(--blanc-ink-3)` with NO toast/error UI and the modal already visible (never blocked on counts). The AR fetch fires only when the dialog is effectively open; nav badges never change from it.

### TC-WS-21: Pulse column click → navigate + dismiss + param stripped
- **Приоритет:** P0 | **Тип:** PREVIEW
- **§ref:** spec §2.7 row 2, §6.3 dismiss-in-preview; AC-3
- **Шаги:** in the open preview dialog, `preview_click` the "Pulse inbox" column (from `/leads?warmup=preview` for an observable route change, or per §6.3 click "New leads" from `/pulse`).
- **Ожидаемый результат:** lands on the column's route (`/pulse`), modal closed, `warmup=preview` no longer in the URL (param dropped by navigation), no console errors. (warmUpAudio's audible effect is not assertable in the harness — the gesture ORDER is TC-WS-14 STATIC.)

### TC-WS-22: "Let's go" dismisses without navigation
- **Приоритет:** P0 | **Тип:** PREVIEW
- **§ref:** spec §2.7 row 1, §6.3; AC-3; scenario 2 ("nothing pending")
- **Шаги:** open `http://localhost:3001/pulse?warmup=preview` → click "Let's go".
- **Ожидаемый результат:** modal closes, route stays `/pulse`, `warmup` param stripped (`navigate(location.pathname, { replace: true })`) — the dialog does NOT re-open on the same URL. Bonus (P2, same session): Esc and the corner × also close it; a backdrop click does NOT (pinned §2.7 row 5).

### TC-WS-23: hit targets ≥44px
- **Приоритет:** P1 | **Тип:** PREVIEW
- **§ref:** spec §3.2-2, §3.4
- **Шаги:** `preview_inspect` each of the three column buttons and "Let's go".
- **Ожидаемый результат:** each column button height ≥ 64px (`min-h-[64px]`) and ≥44px in both dimensions; buttons are real `<button type="button">` with `aria-label` combining label + value (e.g. `Pulse inbox: 7`, or `Pulse inbox: not loaded` when null).

### TC-WS-24: `/schedule` suppression + badge regression sweep
- **Приоритет:** P1 | **Тип:** PREVIEW
- **§ref:** spec §2.5, §6.5; §7 protected `/schedule` term; §4.1 `?? 0`
- **Шаги:** open `http://localhost:3001/schedule?warmup=preview`; then navigate to `/pulse` in-app.
- **Ожидаемый результат:** on `/schedule` the modal does NOT render (the `!location.pathname.startsWith('/schedule')` term gates preview too); nav badges render NUMBERS (0 before fetches resolve — the `?? 0` coercions, never blank/`null` text). Navigating off `/schedule` (param still present) opens the modal — today's latch behavior preserved. Sanity: any entity form on a narrow browser window still bottom-sheets (`useIsMobile` width semantics unchanged, §6.5).

---

## E. REVIEW — honest code-review verdicts (NOT executable in this harness; flagged as such)

These cannot be executed here: no iOS device/PWA, no reliable `pointer: coarse` emulation, no Twilio Device in dev. Each is a review of implemented code against the spec's normative text; the reviewer must cite the exact lines. They are the ONLY coverage for the mobile half of AC-1 — flagged as the feature's honest verification gap.

### TC-WS-25: iOS PWA standalone cold-start timeline vs code
- **Приоритет:** P0 | **Тип:** REVIEW
- **§ref:** spec §2.2 (root-cause timeline), §1.1 rAF one-shot, §2 belt 3; FR-MOBILE-FIX; AC-1; scenario 3
- **Шаги (review):** walk the mount sequence with a transiently-wide `innerWidth` and no subsequent `resize`: initializers → `(pointer: coarse)` term in `useIsMobileDevice` true regardless of width → belts 1/2a/2b block → no token fetch/Device/`deviceReady`; independently the rAF one-shot corrects the width term within one painted frame; hypothetical armed latch is killed by belt 3 + kept closed by belt 2b.
- **Ожидаемый результат (verdict):** with the code as written, `showWarmUp=true` + rendered dialog is unreachable on a coarse-pointer device at every point of the timeline; `cancelAnimationFrame` in cleanup prevents setState-after-unmount (§1.5-4).

### TC-WS-26: landscape phone (932px) leak closed
- **Приоритет:** P2 | **Тип:** REVIEW
- **§ref:** spec §2.3, §1.5-3
- **Ожидаемый результат (verdict):** rotation to landscape → `useIsMobile=false` (layout desktop-ish, unchanged today) but `useIsMobileDevice=true` via `(pointer: coarse)` → all belts still block; on rotation mql `change` fires and belt 3 resets any latch. Optional best-effort (non-gating, §6.4-5): devtools iPhone emulation → no Twilio token request in the network tab.

### TC-WS-27: iPad / wide+coarse = deliberate desktop-layout-but-no-softphone
- **Приоритет:** P1 | **Тип:** REVIEW
- **§ref:** spec §2.4 (pinned deliberate change), §1.4; §7 out-of-scope (iPad softphone deliberately dropped)
- **Ожидаемый результат (verdict):** iPad landscape: `useIsMobile=false` → all 26 layout call-sites render DESKTOP (overlay canon classification unchanged — `dialog/select/popover/dropdown-menu/useOverlayDismiss` untouched); `useIsMobileDevice=true` → no Device registration, no widget, no modal. Reviewer confirms this is documented as a product change, NOT flagged as a bug or "fixed".

### TC-WS-28: belt independence (any single belt failing leaves two blocking)
- **Приоритет:** P1 | **Тип:** REVIEW
- **§ref:** spec §2.6; AC-1
- **Ожидаемый результат (verdict):** the three failure hypotheticals of §2.6 hold in the code as written: (1) belt-1 failure → 2a blocks arming, 2b blocks render; (2) belt-2a failure → 2b blocks render, belt 3 un-latches; (3) belt-2b-alone failure unreachable while 2a+3 hold. No belt relies on another's expression (explicit terms, not indirection through `softPhoneEnabled`).

### TC-WS-29: dismiss table — all 5 rows implemented exactly
- **Приоритет:** P0 | **Тип:** REVIEW (rows 1-2 also exercised live by TC-WS-21/22)
- **§ref:** spec §2.7 (exhaustive, pinned); AC-3; §7 protected gesture contract
- **Ожидаемый результат (verdict):** all five paths verified against code: "Let's go" (warm+close, no nav), column click (warm→close→navigate, synchronous order), corner × via Radix `onOpenChange(false)` → `handleWarmUpDismiss`, Esc via Radix keydown → same, backdrop `onPointerDownOutside={e => e.preventDefault()}` **kept — does NOT dismiss** (prevents a warm-up-less close). No sixth dismiss path exists (e.g. no auto-dismiss timer).

### TC-WS-30: badge `?? 0` coercions — observable behavior byte-equal
- **Приоритет:** P1 | **Тип:** REVIEW (compile half = TC-WS-18; render half = TC-WS-24)
- **§ref:** spec §4.1; §7 protected badge plumbing
- **Ожидаемый результат (verdict):** exactly six prop-expression coercions (`AppNavTabs` :180 + `BottomNavBar` :187, three each); the three `useState` initializers become `useState<number | null>(null)`; fetch/poll/SSE callback BODIES byte-identical (including the pinned `fetchUnreadCount` bare `data.count || 0` shape, §0.7-4); badge components and prop types untouched. Net: badges render `0` until first fetch — same as today.

### TC-WS-31: `pulseInbox` null-if-either-null sum rule
- **Приоритет:** P1 | **Тип:** REVIEW (numeric live check = TC-WS-20 when authenticated)
- **§ref:** spec §4.3 (PINNED), §4.4 timing edges; AC-2, AC-6
- **Ожидаемый результат (verdict):** `counts.pulseInbox = pulseUnreadCount === null || arCount === null ? null : pulseUnreadCount + arCount` — NO partial sum (rejected for honesty); `newLeads`/`openTasks` passed through raw. §4.4 edges hold: modal never waits for counts; arCount failure → column 1 "—" while 2-3 numeric; dismiss-before-counts harmless; re-arm refires `fetchArCount` (trigger effect on the effective-open condition, no poll/SSE for arCount).

### TC-WS-32: `/schedule` suppression term kept verbatim
- **Приоритет:** P1 | **Тип:** REVIEW (behavior half = TC-WS-24)
- **§ref:** spec §2.5; §7 protected
- **Ожидаемый результат (verdict):** the Dialog `open` expression contains `!location.pathname.startsWith('/schedule')` character-for-character; `showWarmUp` stays latched `true` on `/schedule` (no reset) so navigating off opens the modal — today's behavior byte-preserved.

---

## FR/AC → TC matrix

| Requirement | TCs | Coverage type |
|---|---|---|
| FR-MOBILE-FIX (a) hardened hook | TC-WS-11, 17, 25, 26 | STATIC + REVIEW |
| FR-MOBILE-FIX (b) explicit belts | TC-WS-07, 09 | STATIC |
| FR-MOBILE-FIX (c) reset-on-flip | TC-WS-08, 25 | STATIC + REVIEW |
| FR-MOBILE-FIX D1 (no artifacts on mobile) | TC-WS-06, 09, 26, 27 | STATIC + REVIEW-only |
| FR-MOBILE-FIX 26-call-site compat | TC-WS-11, 18, 24, 27 | STATIC + BUILD + PREVIEW + REVIEW |
| FR-SUMMARY (content, columns, clicks) | TC-WS-13, 19, 20, 21, 22, 23, 29 | STATIC + PREVIEW + REVIEW |
| FR-COUNT-API | TC-WS-01, 02, 03, 04, 05 | UNIT |
| FR-COPY (D4) | TC-WS-12, 13 | STATIC |
| AC-1 (mathematically impossible on mobile) | TC-WS-06, 07, 08, 09, 10, 17, 25, 26, 28 | STATIC + **REVIEW-only for the device half** |
| AC-2 (live counts match badges + AR) | TC-WS-19, 20, 31 | PREVIEW (auth-dependent) + REVIEW |
| AC-3 (click = navigate+dismiss+warm; Let's go) | TC-WS-14, 21, 22, 29 | STATIC + PREVIEW + REVIEW |
| AC-4 (parent_type + backward-compat + role scope) | TC-WS-01, 02, 03, 04 | UNIT |
| AC-5 (build + jest green) | TC-WS-18, 05 (+ UNIT run command) | BUILD + UNIT |
| AC-6 (D5 "—"/fail-silent) | TC-WS-20, 31 | PREVIEW + REVIEW |
| Spec §6.3 preview mechanism itself | TC-WS-15, 19, 21, 22 | STATIC + PREVIEW |
| §1.3 guardrail (single consumer) | TC-WS-10 | STATIC |
| §7 protected surfaces | TC-WS-05, 11, 24, 30, 32 | UNIT + STATIC + PREVIEW + REVIEW |

## Honest gaps (flagged, not hidden)

1. **AC-1's device half is REVIEW-only** (TC-WS-25/26/27/28): no iOS device, no PWA standalone, no reliable `(pointer: coarse)` emulation in this harness. Frontend has no unit runner, so the hook's rAF/mql mechanics are grep+review, not executed. Optional non-gating devtools emulation noted in TC-WS-26.
2. **AC-2's numeric cross-check depends on a local KC session** in the automated browser; without it, TC-WS-20 degrades to "—"-layout verification and the numeric claim rests on TC-WS-31 review + TC-WS-01..04 SQL assertions (per spec §6.3, this degradation is pre-approved).
3. **Natural arming path (Twilio `deviceReady`) is not reproducible in dev** — every PREVIEW case goes through `?warmup=preview`; the real arming chain is covered only by TC-WS-07 STATIC + review.
4. **`warmUpAudio()`'s audible/AudioContext effect is not assertable** — only gesture ORDER (TC-WS-14) and dismiss-path wiring (TC-WS-29) are verified.
