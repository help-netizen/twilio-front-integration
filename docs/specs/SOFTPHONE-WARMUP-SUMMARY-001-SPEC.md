# SOFTPHONE-WARMUP-SUMMARY-001 — SPEC

Mobile-proof the SoftPhone warm-up modal (three independent belts + device-capability gate) and replace its content with a "Today at a glance" day-start summary (Pulse inbox / New leads / Open tasks). Desktop-only by construction; `warmUpAudio()` user-gesture canon preserved on every dismiss path. Frontend + ONE additive backend route tweak; NO migration, no new endpoints, no SSE changes.

Sources: requirements `## SOFTPHONE-WARMUP-SUMMARY-001` (END of `Docs/requirements.md`, :4912), architecture `## SOFTPHONE-WARMUP-SUMMARY-001` (END of `Docs/architecture.md`, :5611). Code quotes below re-verified line-accurate on 2026-07-10; code wins on conflict.

---

## §0 — Ground truth (line-accurate) + discrepancies

### §0.1 `frontend/src/hooks/useIsMobile.ts` (entire hook, :14-27)

```ts
export function useIsMobile(breakpoint: number = DEFAULT_BREAKPOINT): boolean {
    const [isMobile, setIsMobile] = useState<boolean>(
        () => typeof window !== 'undefined' && window.innerWidth < breakpoint,
    );

    useEffect(() => {
        const check = () => setIsMobile(window.innerWidth < breakpoint);
        check();
        window.addEventListener('resize', check);
        return () => window.removeEventListener('resize', check);
    }, [breakpoint]);

    return isMobile;
}
```

Width-only (`innerWidth < breakpoint`), `resize` listener only — THE root-cause surface (iOS PWA standalone cold start can read a wide `innerWidth` with no later `resize`).

### §0.2 `frontend/src/components/layout/AppLayout.tsx` — gates & modal

- `:39` — `const isMobile = useIsMobile();`
- `:44` — `const softPhoneEnabled = !isMobile && softPhoneGroupsLoaded && softPhoneGroups.length > 0;`
- `:45` — `const voice = useTwilioDevice({ enabled: softPhoneEnabled });`
- `:48` — `const [showWarmUp, setShowWarmUp] = useState(false);`
- `:73` — arming effect:
  ```ts
  useEffect(() => { if (softPhoneEnabled && voice.phoneAllowed && voice.deviceReady) setShowWarmUp(true); }, [softPhoneEnabled, voice.phoneAllowed, voice.deviceReady]);
  ```
- `:74` — `const handleWarmUpDismiss = useCallback(() => { warmUpAudio(); setShowWarmUp(false); }, []);`
- `:192` — the warm-up Dialog (single line; NO mobile gate in `open` today):
  ```tsx
  <Dialog open={showWarmUp && !location.pathname.startsWith('/schedule')} onOpenChange={open => { if (!open) handleWarmUpDismiss(); }}><DialogContent className="sm:max-w-[360px]" onPointerDownOutside={e => e.preventDefault()}><DialogHeader className="text-center sm:text-center"><div className="flex justify-center mb-2"><Phone className="size-8 text-primary" /></div><DialogTitle>SoftPhone Ready</DialogTitle><DialogDescription>Enable incoming call ringtone so you don't miss any calls.</DialogDescription></DialogHeader><DialogFooter className="sm:justify-center"><Button onClick={handleWarmUpDismiss} size="lg" className="w-full"><Phone />Enable Ringtone</Button></DialogFooter></DialogContent></Dialog>
  ```
  Note `onPointerDownOutside={e => e.preventDefault()}` — **backdrop click does NOT dismiss today; PINNED (kept)** in the new dialog (§2.7).
- `:193` — `{!isMobile && <SoftPhoneWidget voice={voice} … />}`

### §0.3 `AppLayout.tsx` — badge counters (:94-160)

- `:94` — `const [pulseUnreadCount, setPulseUnreadCount] = useState(0);`
- `:95-102` — `fetchUnreadCount`: `authedFetch('/api/pulse/unread-count')` → **`setPulseUnreadCount(data.count || 0)`** (NOTE: parses `data.count`, not the `data.data.count` envelope), `catch { }`, guarded `if (!company) return;`. Trigger `:103`: mount + `location.pathname`.
- `:109` — `const [leadsNewCount, setLeadsNewCount] = useState(0);` `:110-117` `fetchLeadsNewCount`: `/api/leads/new-count` → `setLeadsNewCount(json?.data?.count ?? json?.count ?? 0)`. Triggers `:118` (mount+route) + `:119-123` (60s poll).
- `:130` — `const [openTasksCount, setOpenTasksCount] = useState(0);` `:131-138` `fetchOpenTasksCount`: `/api/tasks/count` → `setOpenTasksCount(json?.data?.count ?? json?.count ?? 0)`. Triggers `:139` (mount+route) + `:140-144` (60s poll).
- `:146-160` — `useRealtimeEvents` SSE: pulse refetch on call/message/read events; `onGenericEvent` refetches leads on `lead.created|lead.updated` and tasks on `task.changed`, both company-guarded.
- Badge consumers: `:180` `<AppNavTabs … pulseUnreadCount={pulseUnreadCount} leadsNewCount={leadsNewCount} openTasksCount={openTasksCount} …/>`, `:187` `<BottomNavBar …same three props…/>`.

### §0.4 `backend/src/routes/tasks.js` — GET /count (:70-87)

Mounted `app.use('/api/tasks', authenticate, requireCompanyAccess, tasksRouter)`; `companyId(req)` = `req.companyFilter?.company_id` (:25-27); `canManage(req)` = `_devMode || permissions.includes('tasks.manage')` (:31-33).

```js
// :72
router.get('/count', requirePermission('tasks.view'), async (req, res) => {
    try {
        const filters = { status: 'open' };                     // :74 ← THE diff line
        // Same visibility branch as GET /: managers count all; everyone else own.
        if (canManage(req)) {
            if (req.query.assignee_id) filters.assignee_id = req.query.assignee_id;
        } else {
            filters.scopeOwnerId = actorId(req);
        }
        const count = await tasksQueries.countTasks(companyId(req), filters);
        res.json({ ok: true, data: { count } });
    } catch (err) { … res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to count tasks' } }); }
});
```

GET `/` (:48) already does `parent_type: req.query.parent_type || undefined` — the /count diff mirrors it byte-for-byte.

### §0.5 `backend/src/db/tasksQueries.js` — NO changes; behavior relied upon

- `:141-143` — `if (filters.parent_type && isValidParentType(filters.parent_type)) { conditions.push(\`t.${PARENTS[filters.parent_type].col} IS NOT NULL\`); }` — no `$n` param added; invalid/absent values silently ignored.
- `:28` — `timeline: { col: 'thread_id', … }` → `parent_type=timeline` adds `t.thread_id IS NOT NULL`.
- `:79-80` — `HAS_ENTITY_PARENT` always AND'ed in (`:127`), whose timeline term carries `t.created_by IN ('user', 'agent')` — combined = exactly the AR-TASK-UNIFY-001 Action-Required definition.

### §0.6 Supporting facts

- `frontend/src/components/NotificationReminderBanner.tsx:16-26` — existing `matchMedia('(max-width: 767px)')` init-from-`.matches` + `change`-listener precedent.
- `frontend/src/components/ui/CloudBanner.tsx` — `variant?: "hero" | "compact"` (default `"compact"`, `p-5`), pure presentation over `.blanc-cloud` (`design-system.css:827`).
- `frontend/src/components/ui/dialog.tsx:87` — `const isMobile = useIsMobile()` drives the OVERLAY-CANON-002 mobile bottom-sheet chrome; DialogContent has a built-in corner × (`OverlayClose`, routed through Radix `onOpenChange(false)`); Radix owns Esc.
- `frontend/src/hooks/useTwilioDevice.ts` — `deviceReady` flips true only on Twilio `Device` `'registered'` (`:170`) after `fetchVoiceToken()` (`:165`) succeeds with `allowed !== false` (`:167`). **In local dev without live Twilio creds/groups, `deviceReady` may never fire → the modal never arms naturally** (drives the §6 preview-mechanism decision).
- Tests (repo-root `tests/`, NOT `backend/tests/`): `tests/routes/tasks.test.js` — `describe('GET /count — open-task badge (TASKS-COUNT-BADGE-001)')` at `:86-176`, supertest + mocked `db.query`, real query layer; `tests/tasksCount.test.js` — query-layer coverage, `parent_type` already tested at `:46-60` (no edits needed there).
- Root `package.json` jest config: `"testPathIgnorePatterns": ["/node_modules/", "/\\.claude/worktrees/"]` — running jest from inside THIS worktree matches the ignore pattern and runs ZERO tests unless overridden (§6).
- `useIsMobile` call-site audit re-verified: **26 call sites** (grep, hook file excluded) — matches the requirements list; all no-arg / default breakpoint.

### §0.7 Discrepancies (requirements/architecture vs code)

1. **Requirements cite `routes/tasks.js:70-80`** for GET /count; actual handler body is `:72-87`, the `filters` line is `:74` (architecture's `:74` is correct). Cosmetic.
2. **Architecture `:94-144` "badge counters"** — SSE wiring extends to `:160`; counters proper are `:94-144`. Cosmetic.
3. **Architecture "`Phone` import stays (used by header button? verify)"** — VERIFIED: in `AppLayout.tsx`, `Phone` (:8), `Button` (:7), and `Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter` (:6) are used ONLY in the `:192` warm-up JSX. After the content swap ALL of these become orphans in AppLayout and MUST be removed (prod Docker `noUnusedLocals` fails the build otherwise). They move into `WarmUpSummaryDialog.tsx`.
4. **Architecture says `fetch/poll/SSE callbacks stay byte-identical (they set numbers; catch {} leaves null)`** — true, but note `fetchUnreadCount` parses `data.count || 0` (bare shape), unlike the other two (`json?.data?.count ?? json?.count ?? 0`). No change required; pinned as-is.
5. **NotificationReminderBanner precedent cited as `:16-21`** — actually `:16-26` (init `:16-18`, effect `:20-26`). Cosmetic.
6. No existing spec covers this feature (`Docs/specs/` checked: `MOBILE-NO-SOFTPHONE-001.md` covers the original gate, not the modal content nor the leak fix) — no duplication.

---

## §1 — Hooks contract (`frontend/src/hooks/useIsMobile.ts`)

One file, three exports-worth of behavior: a shared internal helper + two public hooks. **No other file may gain a parallel width hook.**

### §1.1 Internal `useMediaQuery(query: string): boolean` (module-private helper, not exported)

- **State init:** `useState<boolean>(() => typeof window !== 'undefined' && window.matchMedia(query).matches)` — SSR guard identical in spirit to today's initializer (`typeof window !== 'undefined'` → `false` on server).
- **Effect** (deps `[query]`), client-only body:
  1. `const mql = window.matchMedia(query);`
  2. `const check = () => setIsMobile(mql.matches);` (reads `mql.matches`, never `innerWidth`).
  3. Run `check()` synchronously (parity with today's effect body — corrects a stale initializer immediately on mount).
  4. Subscribe `mql.addEventListener('change', check)` **AND keep** `window.addEventListener('resize', check)` — the resize listener is a belt: some engines (older iOS WebKit in standalone) have missed mql `change` on PWA viewport corrections.
  5. **rAF one-shot:** `const raf = requestAnimationFrame(check);` — fires once after the first painted frame, when the iOS-standalone viewport has settled; covers the cold-start case where the pre-paint value is wrong and NO `resize`/`change` event ever follows. One-shot only — never re-scheduled.
  6. Cleanup: remove both listeners AND `cancelAnimationFrame(raf)` (prevents setState-after-unmount).
- Returns the boolean.

### §1.2 `useIsMobile(breakpoint: number = 768): boolean` — hardened in place

- Signature UNCHANGED (optional `breakpoint`, default 768 via existing `DEFAULT_BREAKPOINT`).
- Query: `` `(max-width: ${breakpoint - 0.02}px)` `` → default **`(max-width: 767.98px)`** (Tailwind `md` complement; `.98` closes the fractional gap between `max-width: 767px` and `innerWidth < 768`).
- Delegates to `useMediaQuery` (query recomputed if `breakpoint` changes; effect re-subscribes via `[query]` dep).
- **Semantics UNCHANGED: "narrow viewport"** (width-only). Returns `true` ⇔ viewport width ≤ 767.98px. NO pointer/touch term here.

### §1.3 `useIsMobileDevice(): boolean` — NEW export, softphone capability gate ONLY

- Query (single `matchMedia`, comma = OR): **`(max-width: 767.98px), (pointer: coarse)`**.
- Same mechanism (delegates to `useMediaQuery`).
- Returns `true` ⇔ narrow viewport OR the PRIMARY pointer is coarse (iPhone/iPad/Android = `true`; touch-screen laptop with mouse/trackpad primary = `false` — softphone keeps working there).
- **Consumer restriction (guardrail):** imported ONLY by `AppLayout.tsx`. No layout call-site may adopt it — a JSDoc header on the hook states this.

### §1.4 Consumer-compat statement

All **26 existing `useIsMobile` call-sites** (list in requirements FR-MOBILE-FIX; re-verified by grep) are untouched and behavior-identical at width semantics on real devices:

- The only behavioral delta of §1.2 vs today is (a) the 767.98-vs-768 boundary — sub-pixel-only, no real device renders at a fractional 767.x logical width, and (b) *corrections* in previously-broken windows (PWA cold start now snaps to the true value within one frame; that is the fix, not a regression).
- Overlay-canon consumers (`ui/dialog.tsx:87`, `ui/select.tsx:106`, `ui/popover.tsx:58`, `ui/dropdown-menu.tsx:62`, `hooks/useOverlayDismiss.ts:158`) keep their desktop/mobile classification: an iPad or touch laptop stays "desktop" for layout because §1.2 carries no coarse-pointer term.

### §1.5 Edge cases

1. SSR/prerender → initializer returns `false`; first client effect corrects synchronously. (Vite SPA — practically unreachable, guard kept anyway.)
2. `breakpoint` prop changes between renders → effect re-subscribes with the new query (deps `[query]`); state corrected by the synchronous `check()`.
3. Rotation (portrait 430px → landscape 932px on iPhone) → mql `change` fires → `useIsMobile` flips to `false` BUT `useIsMobileDevice` stays `true` via `(pointer: coarse)` → softphone/modal still blocked (landscape-phone leak closed).
4. Unmount before rAF fires → `cancelAnimationFrame` in cleanup, no setState-after-unmount.

---

## §2 — AppLayout belts (FR-MOBILE-FIX b/c) — scenarios

New line next to `:39`: `const isMobileDevice = useIsMobileDevice();`. Exact surface changes (architecture §2 table, normative):

| Surface | After |
|---|---|
| Belt 1 — `softPhoneEnabled` `:44` | `!isMobile && !isMobileDevice && softPhoneGroupsLoaded && softPhoneGroups.length > 0` |
| Belt 2a — arming effect `:73` | `if (!isMobile && !isMobileDevice && softPhoneEnabled && voice.phoneAllowed && voice.deviceReady) setShowWarmUp(true)` (deps gain `isMobile`, `isMobileDevice`) |
| Belt 2b — Dialog `open` | `showWarmUp && !isMobile && !isMobileDevice && !location.pathname.startsWith('/schedule')` (`/schedule` term KEPT verbatim; see §6.3 for the DEV-only preview term) |
| Belt 3 — reset-on-flip (NEW effect) | `useEffect(() => { if (isMobile || isMobileDevice) setShowWarmUp(false); }, [isMobile, isMobileDevice])` |
| Widget render `:193` | `{!isMobile && !isMobileDevice && <SoftPhoneWidget …/>}` |

`useTwilioDevice` internals, `SoftPhoneWidget`, presence, incoming-call auto-open (`:84-89`), `SoftPhoneHeaderButton` gating (`:182`, already behind `softPhoneEnabled && voice.phoneAllowed`) — UNTOUCHED.

### §2.1 Desktop normal flow (arm → modal)

- **Given** a desktop browser (wide viewport, fine primary pointer), a logged-in user in ≥1 softphone group, Twilio voice token allowed.
- **When** the app shell mounts: groups load → `softPhoneEnabled=true` → `useTwilioDevice` registers → `deviceReady=true`.
- **Then** the arming effect sets `showWarmUp=true`; the Dialog opens (belts 2b all pass) showing the "Today at a glance" summary (§3). No behavior change vs today except content.
- **Side effects:** `fetchArCount()` fires once on arm (§4.2). No other new requests.

### §2.2 iOS PWA standalone cold start (THE root-cause timeline)

- **Given** an iPhone Home-Screen (standalone) launch where the pre-paint viewport momentarily reads wide (>768) and NO `resize` event ever follows.
- **When** the shell mounts: `useIsMobile`/`useIsMobileDevice` initializers may briefly read `false`… BUT `useIsMobileDevice` is `true` regardless via `(pointer: coarse)` (pointer capability is not width-dependent) → belts 1/2a/2b already block; independently, the rAF one-shot corrects the width term within one painted frame.
- **Then** `softPhoneEnabled` never becomes `true` on a phone → no token fetch, no Device registration, no `deviceReady` → the modal never arms. Zero softphone artifacts render (widget gate).
- **And if** (hypothetically) a transient window still armed `showWarmUp`: belt 2b keeps the Dialog closed while `isMobileDevice` is `true`, and belt 3 (reset-on-flip) sets `showWarmUp=false` — the latch cannot survive.

### §2.3 Landscape phone (932px wide)

- **Given** an iPhone in landscape (viewport 932×430, coarse pointer).
- **Then** `useIsMobile` = `false` (wide) — layout renders desktop-ish as today — but `useIsMobileDevice` = `true` → all belts block: no Device, no widget, no modal. (This closes the width-only landscape leak.)

### §2.4 iPad / wide touch device (coarse + wide) — DELIBERATE

- **Given** an iPad (landscape 1024+px, coarse primary pointer).
- **Then** layout is DESKTOP (26 call-sites unchanged, `useIsMobile=false`), but softphone is fully OFF (`isMobileDevice=true`): no Device registration, no widget, no warm-up/summary modal.
- This is a **pinned deliberate product change** (architecture §1): previously iPad landscape could register a WebRTC Device; browser softphone is desktop-only by canon. NOT a bug.

### §2.5 `/schedule` suppression (unchanged)

- **Given** desktop, `showWarmUp=true`, user is on a route starting with `/schedule`.
- **Then** the Dialog stays closed (`open` term `!location.pathname.startsWith('/schedule')` kept verbatim); `showWarmUp` stays latched `true`; navigating off `/schedule` opens the modal. Today's behavior, byte-preserved.

### §2.6 Belt independence (AC-1)

Any single belt failing leaves two blocking:
1. Belt 1 fails (e.g. `softPhoneEnabled` somehow true on a phone) → belt 2a's explicit `!isMobile && !isMobileDevice` still blocks arming; belt 2b still blocks rendering.
2. Belt 2a fails (armed during a transient wrong-width window) → belt 2b blocks rendering while flags are correct; belt 3 un-latches the state.
3. Belt 2b alone failing is unreachable while 2a+3 hold (nothing armed) — and if it rendered anyway, belt 3 closes it on the next flag evaluation.

### §2.7 Dismiss paths (all preserved gestures; PINNED)

| Path | Mechanism | Behavior |
|---|---|---|
| "Let's go" button | `onDismiss` → `handleWarmUpDismiss` | `warmUpAudio()` then `setShowWarmUp(false)`; NO navigation (byte-identical semantics to today's Enable Ringtone) |
| Column click | `onNavigate(path)` | `warmUpAudio()` → `setShowWarmUp(false)` → `navigate(path)` — in THIS order, all synchronous in the click handler |
| Corner × (built-in `OverlayClose`) | Radix `onOpenChange(false)` → `handleWarmUpDismiss` | warm + close (click gesture ✓) |
| Esc | Radix keydown → `onOpenChange(false)` → `handleWarmUpDismiss` | warm + close (keyboard is a valid AudioContext gesture) |
| Pointer/click outside (backdrop) | `onPointerDownOutside={e => e.preventDefault()}` | **DOES NOT dismiss — pinned, identical to today** (prevents a warm-up-less close where the AudioContext would stay locked) |

**Gesture contract (softphone-warmup canon):** `warmUpAudio()` is the FIRST synchronous statement in every dismiss/navigate handler. Never `await`, `setTimeout`, or state-update before it.

---

## §3 — `WarmUpSummaryDialog` component contract

**NEW file:** `frontend/src/components/layout/WarmUpSummaryDialog.tsx`. Pure presentation — no fetches, no timers, no state beyond render (precedent: `SoftPhoneHeaderButton.tsx`).

**FORM-CANON ruling (pinned):** confirmation-class dialog → **center `<DialogContent variant="dialog">` stays**; NOT a panel/шторка. This is THE canonical center-modal exception (short, one primary action, exists to capture the audio-unlock gesture). On mobile `dialog.tsx` would auto-bottom-sheet it, but the belts make mobile rendering impossible — moot.

### §3.1 Props (exact)

```ts
interface WarmUpSummaryDialogProps {
    open: boolean;                       // AppLayout passes the fully-belted expression
    counts: {
        pulseInbox: number | null;       // null → "—"
        newLeads: number | null;
        openTasks: number | null;
    };
    onNavigate: (path: string) => void;  // AppLayout: warmUpAudio(); setShowWarmUp(false); navigate(path)
    onDismiss: () => void;               // = handleWarmUpDismiss (warmUpAudio + close), byte-identical semantics
}
```

The component owns the `<Dialog>` markup; AppLayout's `:192` line becomes `<WarmUpSummaryDialog open={…} counts={…} onNavigate={…} onDismiss={…} />` and AppLayout drops the now-orphaned `Phone`/`Button`/`Dialog*` imports (§0.7-3).

### §3.2 Layout contract

`<Dialog open={open} onOpenChange={o => { if (!o) onDismiss(); }}>` → `<DialogContent className="sm:max-w-[520px]" onPointerDownOutside={e => e.preventDefault()}>`:

*(Owner iteration #2, 2026-07-11: humanized — modal felt machine-assembled. Time-of-day greeting replaces "Today at a glance"; "Here's your day at a glance." subtitle; plain phrase labels instead of eyebrow captions (written literally, no CSS text-transform — "Pulse" keeps its capital P); airy padding/rhythm; centered auto-width button; footnote "Sound for incoming calls turns on when you continue." replaces the old header subtext. The strings below are the D4-copy source of truth.)*

1. `DialogHeader` (centered) — `DialogTitle` = time-of-day greeting: `new Date().getHours()` → **"Good morning"** (<12) / **"Good afternoon"** (<18) / **"Good evening"** (else); `text-[28px]`, weight 800, `var(--blanc-font-heading)`, ink-1. `DialogDescription` **"Here's your day at a glance."** — 15px, normal case, `var(--blanc-ink-2)`. (Radix a11y intact: DialogTitle/DialogDescription still provide `aria-labelledby`/`aria-describedby`.)
2. A `grid grid-cols-3 gap-6 sm:gap-8` (generous, `mt-8`) of three `<button type="button">` stat columns directly in the dialog body — visually plain: transparent, no border, no hover plate, no wrapper with bg/border/shadow. *(CloudBanner removed by owner direction 2026-07-11: "no block-in-block; columns directly on the dialog surface".)* Each column:
   - `min-h-[44px]` (≥44px touch/click target); real `<button>` (a11y + click-to-navigate unchanged).
   - Count: `text-4xl tabular-nums`, weight 800, `fontFamily: var(--blanc-font-heading)`, ink-1; hover tints the number to `var(--blanc-accent)`; `count === null` → **"—"** at the same size in `var(--blanc-ink-3)` (no hover tint).
   - Below the count: human phrase written as a literal string ("in Pulse inbox" / "new leads" / "open tasks" — no CSS text-transform; "Pulse" is the product section name and keeps its capital P), 13px, `var(--blanc-ink-2)` — NOT an eyebrow, no uppercase/tracking.
3. Centered auto-width primary `<Button size="lg" className="px-10">` **"Let's go"** → `onDismiss` (not full-width, no DialogFooter).
4. Footnote at the very bottom — 11px, centered, `var(--blanc-ink-3)`: **"Sound for incoming calls turns on when you continue."**

Dialog surface: `sm:max-w-[480px]`, padding `p-8 sm:p-10`, vertical rhythm greeting → ~32px → stats → ~36px → button → footnote.

Columns (D2/D4, exact aria labels, visible phrases and routes):

| # | aria label base | Visible phrase | Count | Click |
|---|---|---|---|---|
| 1 | "Pulse inbox" | "in Pulse inbox" | `counts.pulseInbox` | `onNavigate('/pulse')` |
| 2 | "New leads" | "new leads" | `counts.newLeads` | `onNavigate('/leads')` |
| 3 | "Open tasks" | "open tasks" | `counts.openTasks` | `onNavigate('/tasks')` |

Design constraints: `--blanc-*` tokens only; no `<hr>`/Separator; no decorative icons (the old `Phone` icon is dropped); "Blanc" never in UI (product = Albusto). Copy is English per FR-COPY (pipeline may polish in the same spirit; labels above are the D4 defaults).

### §3.3 Count states

*(Owner iteration #3, 2026-07-10: zero-hiding. A column whose count is a LOADED ZERO is HIDDEN — the stat row is `visible = COLUMNS.filter(c => counts[c.key] !== 0)` rendered as `flex justify-center gap-8 sm:gap-10`, so 1-2 surviving columns re-center. Only a confirmed `0` hides; `null` (loading/error) keeps its "—" column. When ALL three are loaded zeros (`visible.length === 0`), the grid is replaced by one centered human line — **"All clear — nothing urgent right now."** — 15px, `var(--blanc-ink-2)`, same `mt-8` rhythm slot as the stats. This supersedes the iteration-#2 "three zeros" scenario below.)*

| Count value | Rendering |
|---|---|
| `null` (loading/error) | column visible with "—" (ink-3, no hover tint) |
| `0` (loaded zero) | column HIDDEN; remaining columns re-center |
| `> 0` | column visible with the number |
| all three `=== 0` | no columns — "All clear — nothing urgent right now." |

- `number > 0` → render the number.
- `null` → "—" (never a spinner that blocks; a lightweight skeleton pulse on the count element is permitted but "—" is the default). Clicks work identically in both states.
- The modal NEVER waits for counts — `open` is driven solely by the belted warm-up expression.

DEV preview param grammar (extends §6.3 `?warmup=preview`): optional `&counts=a,b,c` overrides the trio passed to the dialog — positional `pulseInbox,newLeads,openTasks`; each slot is a number, or `x`/missing → `null`; in override mode the first value IS `pulseInbox` directly (no AR summing). Examples: `?warmup=preview&counts=0,0,0` (all-clear line), `?warmup=preview&counts=2,x,5` (leads column shows "—"), `?warmup=preview&counts=2,0,5` (leads column hidden, two columns centered). DEV-gated — statically dead in prod.

### §3.4 Accessibility

- Columns are real `<button type="button">` elements (keyboard-focusable, Enter/Space activate — a keypress is a valid AudioContext gesture).
- Each column button gets an `aria-label` combining label + value, e.g. `aria-label="Pulse inbox: 7"` / `"Pulse inbox: not loaded"` when null — the visual layout (big number above caption) reads poorly to SR otherwise.
- Radix Dialog provides `role="dialog"`, `aria-labelledby` (DialogTitle), `aria-describedby` (DialogDescription), focus trap, and focus return — no extra work.
- Hit targets ≥44px (`min-h-[64px]`).

### §3.5 Error handling

None in the component (pure presentation; `null` IS the error/loading state). No toasts — fail-silent per D5.

---

## §4 — Counts plumbing (AppLayout)

### §4.1 Badge states become `number | null`

The three initializers change — `useState<number | null>(null)` for `pulseUnreadCount` (:94), `leadsNewCount` (:109), `openTasksCount` (:130). **Fetch/poll/SSE callbacks stay byte-identical** (each success sets a number; `catch { }` leaves the state as-is — so `null` persists only until the first successful fetch). The two badge consumers change ONLY at the prop expressions:

- `:180` `AppNavTabs` → `pulseUnreadCount={pulseUnreadCount ?? 0} leadsNewCount={leadsNewCount ?? 0} openTasksCount={openTasksCount ?? 0}`
- `:187` `BottomNavBar` → same three `?? 0` coercions.

Badge components, their prop types, and all fetch/poll/SSE plumbing — untouched. **Observable badge behavior is byte-equal:** today `useState(0)` renders 0 until the first fetch; after, `null ?? 0` renders 0 until the first fetch. tsc (`noUnusedLocals` strict prod build) enforces the coercions.

### §4.2 NEW `arCount` state + fetch (the ONLY new request)

- `const [arCount, setArCount] = useState<number | null>(null);`
- `fetchArCount` — same pattern as siblings: guarded `if (!company) return;`, `authedFetch('/api/tasks/count?parent_type=timeline')` → `setArCount(json?.data?.count ?? json?.count ?? 0)`, `catch { }` (fail-silent → stays `null` → "—").
- **Trigger:** `useEffect(() => { if (showWarmUp) fetchArCount(); }, [showWarmUp, fetchArCount]);` — fires when the modal arms (and refires on preview open, §6.3, via the same effective-open condition). NO poll, NO SSE, feeds ONLY the modal. Nav badges never read it.

### §4.3 `counts` mapping (PINNED rule)

```ts
counts = {
    pulseInbox: pulseUnreadCount === null || arCount === null ? null : pulseUnreadCount + arCount,
    newLeads:   leadsNewCount,
    openTasks:  openTasksCount,
}
```

- **`pulseInbox` is `null` if EITHER addend is `null`.** The alternative (partial sum — show whichever addend loaded) is **REJECTED for honesty**: "Pulse inbox 4" when the real total is 7 is a wrong number presented confidently; "—" is honest.
- Column 1 semantics: unread conversations + Action-Required (open tasks with `parent_type=timeline`) — matches AR-TASK-UNIFY-001's definition (§0.5). Overlap between the two addends is accepted (same as the separate nav badges today).

### §4.4 Timing edge cases

1. Modal arms before any badge fetch resolves → all three columns "—"; counters fill in live as fetches land (state updates re-render the open dialog).
2. `arCount` fetch fails, others succeed → column 1 "—" (pinned §4.3), columns 2-3 numeric.
3. User dismisses before counts arrive → no-op; late fetch results still update state harmlessly (dialog closed).
4. Re-arm in the same session (e.g. Device re-registers after network blip): the arming effect can set `showWarmUp=true` again → `fetchArCount` refires (fresh AR number); badge states are already live via poll/SSE.

---

## §5 — Backend contract: `GET /api/tasks/count` + `parent_type`

### §5.1 The change (route layer ONLY, one line)

`backend/src/routes/tasks.js:74` — mirrors GET `/` `:48` byte-for-byte:

```js
- const filters = { status: 'open' };
+ const filters = { status: 'open', parent_type: req.query.parent_type || undefined };
```

Everything else in the handler unchanged (quoted §0.4). No `tasksQueries` changes, no new endpoint, no `server.js` change.

### §5.2 API contract

- `GET /api/tasks/count?parent_type=timeline`
  - **Auth/middleware:** mount-level `authenticate, requireCompanyAccess` + route-level `requirePermission('tasks.view')` (403 without it, no query issued).
  - **Company isolation:** `companyId(req)` = `req.companyFilter?.company_id` → `t.company_id = $1` in `buildTaskListFilters` — count is always tenant-scoped; a cross-tenant `parent_type` probe can only ever count the caller's own company's rows.
  - **Role scoping (unchanged, applies to the filtered count too):** `canManage` → company-wide (optional `?assignee_id` honored); else `scopeOwnerId = req.user.crmUser.id` (never `sub`).
  - **Validation path:** the SAME as GET `/` — `buildTaskListFilters` → `isValidParentType` (`tasksQueries.js:141`); invalid values (`?parent_type=bogus`) and absent values are **silently ignored** (no 400 — pinned: this is the existing list-endpoint contract, /count mirrors it).
  - **Response (shape unchanged):** `200 {"ok":true,"data":{"count":<int>}}`; DB error → `500 {"ok":false,"error":{"code":"INTERNAL","message":"Failed to count tasks"}}`.
  - **`parent_type=timeline` semantics:** adds `t.thread_id IS NOT NULL`; AND'ed with the always-on `HAS_ENTITY_PARENT` (whose timeline term requires `t.created_by IN ('user','agent')`) + `t.status = 'open'` ⇒ exactly the open Action-Required count.
- **Backward-compat (AC-4, byte-level):** no `parent_type` param → `req.query.parent_type || undefined` = `undefined` → `filters.parent_type` falsy → `buildTaskListFilters` emits **byte-identical SQL and params to today** → nav badge number unchanged.

### §5.3 Jest cases (extend `tests/routes/tasks.test.js`, GET /count describe at :86)

1. `?parent_type=timeline` → SQL contains `t.thread_id IS NOT NULL`; params unchanged (no new `$n`); role branch intact.
2. No param → SQL does **NOT** contain `thread_id IS NOT NULL` — today's shape, drift guard.
3. `?parent_type=bogus` → silently ignored; SQL byte-equal to case 2.
4. Provider scope (no `tasks.manage`) + `?parent_type=timeline` → BOTH `t.owner_user_id = $2` (params[1] = crmUser.id) AND `t.thread_id IS NOT NULL` present.

Existing 9 /count tests (:87-175) must stay green untouched. `tests/tasksCount.test.js` already covers `parent_type` at the query layer (`:46-60`) — no edits.

---

## §6 — Verification protocol

### §6.1 Builds & tests

1. **Frontend:** `cd frontend && npm run build` (tsc -b; prod Docker is stricter — `noUnusedLocals` — so the orphaned-import cleanup in AppLayout is build-gating). AC-5.
2. **Backend jest (scoped):** run from repo root. **Worktree gotcha (pinned):** root `package.json` has `testPathIgnorePatterns: ["/node_modules/", "/\\.claude/worktrees/"]` — inside this worktree the default run matches the ignore pattern and executes ZERO tests. Use:
   `npx jest tests/routes/tasks.test.js tests/tasksCount.test.js --testPathIgnorePatterns=/node_modules/`
   Expect: all existing + 4 new cases green.

### §6.2 Live preview — desktop (dev servers via `.claude/launch.json`: `backend` :3100, `frontend` vite :3001)

**Reality check (verified in code, §0.6):** `voice.deviceReady` flips true only after `fetchVoiceToken()` succeeds AND the Twilio `Device` emits `'registered'`. In local dev this requires live Twilio creds + user-group membership — **the modal will typically never arm naturally in dev.** Verifying the dialog needs a deliberate mechanism.

### §6.3 Preview mechanism — DECISION: dev-only query param `?warmup=preview` (committed-code-safe)

**Chosen over** a temporary uncommitted harness route (drifts, not reproducible by the Tester agent, risks leaking into a commit half-finished). The query param is committed, deterministic, and dead in production.

Exact semantics (normative, part of the implementation):

- In `AppLayout.tsx`:
  `const warmUpPreview = import.meta.env.DEV && new URLSearchParams(location.search).get('warmup') === 'preview';`
- Dialog `open` (belt 2b) becomes: `(showWarmUp || warmUpPreview) && !isMobile && !isMobileDevice && !location.pathname.startsWith('/schedule')`.
- `fetchArCount` trigger condition becomes `showWarmUp || warmUpPreview` (so the preview shows real counts when authenticated).
- Dismiss in preview: `handleWarmUpDismiss` additionally strips the param — `if (warmUpPreview) navigate(location.pathname, { replace: true });` — so "Let's go"/Esc/× actually close it; column clicks navigate away (param dropped) and close naturally.
- **Prod safety:** Vite statically replaces `import.meta.env.DEV` with `false` in production builds → `warmUpPreview` is the constant `false`; the `open` expression minifies back to the belted form and the strip-branch is unreachable dead code. The belts (`!isMobile && !isMobileDevice`) still gate the preview even in dev — preview cannot demonstrate a mobile leak, by design.

Preview script (Claude Browser, desktop viewport): start both servers → log in (local KC) → open `http://localhost:3001/pulse?warmup=preview` → assert: title "Today at a glance", subtext, three columns, "Let's go"; counts match nav badges + AR (authenticated) or show "—" (unauthenticated fetch failure — itself a D5 verification); click "New leads" column → lands on `/leads`, modal closed. If the local KC session is unavailable in the automated browser, the preview degrades to visual-layout verification with "—" counts — AC-2's numeric cross-check then falls to the code-review of §4.3 plus the jest SQL assertions.

### §6.4 Mobile part — static/code-review (pinned: no KC session in automated browser + `pointer: coarse` emulation is unreliable in this harness)

Verified by review against §1/§2, not by device:
1. `useIsMobileDevice` query string contains `(pointer: coarse)` as an OR term.
2. All five surfaces of §2's table present (grep for `isMobileDevice` — exactly the belt sites + hook import; no other file imports `useIsMobileDevice`).
3. Reset-on-flip effect exists with deps `[isMobile, isMobileDevice]`.
4. rAF one-shot + `cancelAnimationFrame` in the hook cleanup.
5. Optionally: browser devtools device emulation (iPhone preset sets coarse pointer) → no Twilio token request in the network tab, no modal — best-effort, not gating.

### §6.5 Regression sweep

- Desktop: softphone widget/header button still function (belt 1 only ANDs a `false`-on-desktop term); incoming-call auto-open untouched.
- `/schedule`: modal suppressed; nav badges render numbers (the `?? 0` coercions).
- Overlay canon: open any entity form on a narrow viewport → still bottom-sheets (`useIsMobile` width semantics unchanged).

---

## §7 — Protected / out of scope

**Protected (must not change):**
- `useTwilioDevice` hook internals + its `enabled` gating; `SoftPhoneWidget`; presence publishing; incoming-call auto-open (`AppLayout.tsx:84-89`).
- `warmUpAudio()` user-gesture contract — every dismiss path keeps the gesture (§2.7 table is exhaustive and pinned).
- Badge fetch/poll/SSE plumbing: `fetchUnreadCount`/`fetchLeadsNewCount`/`fetchOpenTasksCount` bodies, their triggers, `useRealtimeEvents`/`onGenericEvent` wiring (`:146-160`) — reused, not modified (only the three `useState` initializers + the six `?? 0` prop coercions change).
- `AppNavTabs`/`BottomNavBar` components and prop types.
- `GET /api/tasks/count` no-param behavior (byte-identical SQL) + role-scoping branch; `tasksQueries.buildTaskListFilters`/`countTasks`/`isValidParentType` — zero changes in `tasksQueries.js`.
- All 26 `useIsMobile` layout call-sites — especially the OVERLAY-CANON-002 swap (`ui/dialog.tsx`, `ui/select.tsx`, `ui/popover.tsx`, `ui/dropdown-menu.tsx`, `useOverlayDismiss.ts`) and the mobile list shells (`JobsPage`/`LeadsPage`/`PulsePage`/`TasksPage`/`SchedulePage`).
- The `/schedule` suppression term in the Dialog `open` expression.
- `softPhoneEnabled` semantics beyond the added `!isMobileDevice` term; `authedFetch.ts`; `useRealtimeEvents.ts`.

**Out of scope:**
- No DB migrations; no new endpoints; no SSE event changes; no new dependencies.
- No poll/SSE freshness for `arCount` (fetched per modal-arm only).
- No mobile summary surface (the summary lives inside the desktop-only warm-up modal).
- iPad softphone support — deliberately dropped (§2.4), not to be "fixed" here.
- Localization; the D4 English strings ship as-is.
- Any change to Twilio token issuance, groups, or presence.

**Files to change (complete list):** `frontend/src/hooks/useIsMobile.ts`, `frontend/src/components/layout/WarmUpSummaryDialog.tsx` (NEW), `frontend/src/components/layout/AppLayout.tsx`, `backend/src/routes/tasks.js` (one line), `tests/routes/tasks.test.js` (4 cases).
