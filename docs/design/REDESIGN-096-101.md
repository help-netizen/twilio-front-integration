# Redesign — Features 096–101 (Platform, Auth, Telephony, Automation, Billing)

Scope: the screens introduced by migrations **096–101**:

| # | Area | Primary routes |
|---|------|----------------|
| 096 | RBAC / Team management / Super-admin | `/settings/users`, `/settings/admin`, `/settings/admin/companies/:id` |
| 097 | Signup / OTP / Onboarding | `/signup`, `/onboarding`, Keycloak login, auth gates |
| 098 | Company telephony config | `/settings/telephony/*`, `/settings/phone-calls` |
| 099 | Softphone + A2P (10DLC) | SoftPhone widget, `/calls/live/:id`, A2P flow in Phone Numbers |
| 100 | Automation rules + FSM workflows | `/settings/automation`, `/settings/workflows/:key`, `/settings/actions-notifications` |
| 101 | Platform billing | `/settings/billing` |

---

## TL;DR — the two complaints, plus the real root cause

The user's two complaints ("узкая колонка" / "флоу непонятный") are **symptoms of three systemic problems** found in nearly every screen:

1. **Narrow column inside a wide page.** Hardcoded max-widths and inline detail panels crush content on real monitors:
   - Billing `maxWidth: 880` single column ([BillingPage.tsx:76](frontend/src/pages/BillingPage.tsx#L76)) — 3 usage bars in a thin ribbon.
   - Provider Settings `maxWidth: 800` in a full-width pane ([ProviderSettingsPage.tsx:20](frontend/src/pages/telephony/ProviderSettingsPage.tsx#L20)).
   - Rule editor in a **540px drawer** — condition rows truncate ([AutomationPage.tsx:109](frontend/src/pages/AutomationPage.tsx#L109), [RuleEditor.tsx:99](frontend/src/components/automation/RuleEditor.tsx#L99)).
   - Routing Logs: opening the inline 300px detail panel squeezes the caller column to ellipsis ([RoutingLogsPage.tsx:304](frontend/src/pages/telephony/RoutingLogsPage.tsx#L304)).
   - Ops Dashboard `1.2fr 1fr` + fixed 4-track call row crams the transfer `<select>` into half width ([OperationsDashboardPage.tsx:136](frontend/src/pages/telephony/OperationsDashboardPage.tsx#L136)).
   - User tables capped with `max-w-5xl` + `w-[160px]` filters + `max-w-[200px]` profile cells ([CompanyUsersPage.tsx:25](frontend/src/pages/CompanyUsersPage.tsx#L25)).

2. **Confusing flow.** Multi-step processes are encoded as cryptic one-liners, jargon, or graphs with no legend:
   - **A2P 10DLC**: a 7-state registration journey compressed into one status pill with inline text-link actions and empty-body POSTs ([PhoneNumbersPage.tsx:245-298](frontend/src/pages/telephony/PhoneNumbersPage.tsx#L245)).
   - **FSM workflow builder**: a bipartite graph that draws every status **twice** (source column / target column) with no legend or column headers, plus raw SCXML/State-ID/Transition-ID exposed to non-technical admins ([workflowNodeTypes.tsx:164](frontend/src/components/workflows/workflowNodeTypes.tsx#L164), [workflowInspectors.tsx:395](frontend/src/pages/workflows/workflowInspectors.tsx#L395)).
   - **Rule timer trigger**: shows "delay seconds" AND a cron field at once, submits both ([RuleEditor.tsx:75-85](frontend/src/components/automation/RuleEditor.tsx#L75)); raw operators `eq/ne/in/nin/contains/truthy` exposed.
   - **Signup → email-sent**: a hard dead-end — no resend, no "wrong email", no progress indicator ([SignupPage.tsx:128](frontend/src/pages/auth/SignupPage.tsx#L128)).
   - **OTP**: one letter-spaced input faking a code field, focus not returned on error ([OnboardingPage.tsx:173](frontend/src/pages/auth/OnboardingPage.tsx#L173)).
   - **Billing**: no downgrade, no cancel, no payment-method management; a `past_due` badge with no way to fix it.

3. **Root cause: most of these screens bypass the Blanc design system entirely.** They are built with hardcoded hex, inline styles, banned `<Separator>`/`border-bottom` dividers, decorative circles, and `—`/`N/A` empty rows. The few that use `var(--blanc-*)` (Routing Logs, the FSM canvas) look like a different, more finished product. This is why the whole cluster reads as "ужасный UI" — it isn't one design, it's six.

**Strategy:** fix the systemic layer first (one pass, huge visual payoff), then the per-area flow redesigns, then the functional gaps. Details below.

---

## Part 1 — Systemic fixes (apply across ALL six areas first)

These are mechanical, low-risk, and remove ~70% of the findings. Do them before per-screen work.

### S1. Tokenize — kill hardcoded hex/inline styles
Replace `#111827`, `#6b7280`, `#e5e7eb`, `#6366f1`, `#16a34a`, `bg-blue-50`, `text-orange-500`, `text-gray-500`, `#1a1a2e` (softphone), etc. with the Blanc tokens: `--blanc-ink-1/2/3`, `--blanc-line`, `--blanc-bg`, `--blanc-surface-strong`, radii 10/16/22/28, IBM Plex Sans / Manrope. Worst offenders: `SignupPage`, `OnboardingPage`, `PhoneNumbersPage`, `OperationsDashboardPage`, `AutomationPage`, `RuleEditor`, `BillingPage`, `SoftPhoneWidget.css` (full dark theme → light Blanc), plus the auth fallback screens that render on a **black `#0a0a0a` background with emoji** ([AuthProvider.tsx:256](frontend/src/auth/AuthProvider.tsx#L256), [ProtectedRoute.tsx:50](frontend/src/auth/ProtectedRoute.tsx#L50)).

### S2. Remove every divider
Delete all `<Separator>` and `border-bottom`/`border-top`/`border-right` used as section/row separators; replace with spacing or a subtle `rgba(117,106,89,0.04)` / `rounded-xl` card. Confirmed instances: `CompanyUsersPage:30`, `SuperAdminPage:98`, `AdminCompanyDetailPage:100`, `PhoneCallsSettingsPage:106`, `OperationsDashboardPage:121/137/156/169`, `ActionRequiredSettingsPage` (×6), `NotificationsSection:279`, `ActiveCallWorkspacePage:22/50`, `SoftPhoneWidget.css:110/478`, signup "or with email" 1px rule.

### S3. A standard page-width system (fixes "узкая колонка")
Adopt two container patterns and apply consistently:
- **Settings list/detail pages:** full pane width with `px-6` and a sensible `max-w-6xl` for tables (not `max-w-5xl`/`800`/`880`). Let tables use the horizontal space.
- **Data pages with a detail view:** master list fills the pane; the detail is an **overlay drawer (absolute right sheet)**, never an inline flex sibling that reflows/crushes the list (Routing Logs, Active Call, rule editor).
- **Forms (auth, dialogs):** consistent **440px** centered card across the whole flow (signup 420 vs onboarding 460 today — unify).
- **Wide data dashboards:** responsive grids `repeat(auto-fit, minmax(320px, 1fr))` so columns wrap instead of crushing (Ops Dashboard, Billing usage).

### S4. One shared status component
Call states, A2P states, billing status, agent presence, rule triggers are all modeled as ad-hoc inline string ternaries with color-only meaning. Build one `<StatusBadge tone label>` (text + token color + optional icon, never color-only — a11y) and reuse everywhere.

### S5. No empty filler
Never render `—` / `N/A`. If data is absent, hide the row/field. Fix: `SuperAdminHelpers:16/22`, `PhoneCallsSettingsPage:154`, `RoutingLogsPage:517` (show the phone number instead of `—`), `RouteManagerOverviewPage:15`, `AdminCompanyDetailPage:90` (timezone fallback), `workflowInspectors:348`, `BillingPage` over-limit.

### S6. Human language; hide technical IDs
No raw role keys, operator enums, permission strings, State-ID/Transition-ID, SCXML, slugs/UUIDs as first-class content. Access-denied should say "You don't have access — ask an admin", not "Required permission: pulse.view". Operators become "is / is not / is one of / contains / exists". Move power-user IDs (copy-company-UUID) into an overflow menu.

### S7. Replace native `alert()` / `confirm()`
The telephony/A2P/automation screens use `window.alert`/`window.confirm` for errors and destructive actions ([PhoneNumbersPage.tsx:60](frontend/src/pages/telephony/PhoneNumbersPage.tsx#L60) +8 more, [AutomationPage.tsx:46](frontend/src/pages/AutomationPage.tsx#L46)). Use the existing toast (`sonner`) for errors and an inline confirm for destructive actions.

---

## Part 2 — Per-area redesign

### 096 · RBAC / Teams / Super-admin

**Screens:** Company Users (`/settings/users`), Company-User dialogs, Super-admin (`/settings/admin`), Companies Manager, Admin Company Detail.

**Key problems**
- The **same 6-column user table is duplicated** across `CompanyUsersPage` and `AdminCompanyDetailPage`, but with **two different action patterns** (inline icon buttons vs `MoreHorizontal` dropdown) — confusing for anyone who uses both.
- **Functional bug:** role filter options are `company_admin`/`company_member` while the table renders `tenant_admin`/`manager`/`dispatcher`/`provider` — filtering by role doesn't match what's shown ([CompanyUsersPage.tsx:34](frontend/src/pages/CompanyUsersPage.tsx#L34) vs `:14-19`).
- Cramped columns: `w-[160px]` filters + `max-w-[200px]` profile cell inside a centered `max-w-5xl`.
- Edit user is a `max-w-md` (~448px) modal carrying role + 4 toggles + color + provider link — too narrow.
- Heading inflation on Super-admin (3 nested headings per tab); `TabsList max-w-md` pinned narrow vs `max-w-6xl` body.

**Redesign**
- Extract **one `UsersTable` component** with a single action pattern (`MoreHorizontal` dropdown: Edit / Reset password / Disable) used by both pages. One fix solves duplication, inconsistency, cramped columns, and a11y labels.
- Widen container to `max-w-6xl`; filters become `min-w-[160px] flex-1`; uncap the profile cell (badges on one line, or fold into the role cell as small icons).
- Fix the role-filter vocabulary to the real keys.
- Convert Edit-user modal to an **expandable inline row panel** (toggles save on change — Blanc inline-edit) or widen to `max-w-xl`. Section labels → `.blanc-eyebrow`. Temp-password box → Blanc card token.
- Super-admin: one heading per tab, count badge inline; `TabsList` sizes to content; skip empty PolicyCard metrics instead of `—`/`N/A`.
- Title hierarchy: all entity titles → `text-2xl` Manrope (currently `text-xl` on user pages, `text-2xl` on admin).

### 097 · Signup / OTP / Onboarding

**Flow today:** `/signup` (account) → email-sent **dead-end** → (leave app, click email link) → Keycloak hosted login → `OnboardingGate` → `/onboarding` (phone → code → company) → `/pulse`. Google signup skips email-verify and lands on `/onboarding` — two different destinations.

**Key problems**
- **email-sent is a hard dead-end** — no resend, no "wrong email / go back", no progress, no explanation that a sign-in step follows ([SignupPage.tsx:128](frontend/src/pages/auth/SignupPage.tsx#L128)).
- **OTP is one letter-spaced input**, not 6 cells; focus isn't returned on error; resend-timer conflicts with expiry ("request a new one" while resend is still disabled) ([OnboardingPage.tsx:173](frontend/src/pages/auth/OnboardingPage.tsx#L173)).
- No global progress model across a genuine 4–6 step funnel; no Back from the `company` step.
- Every auth screen is **hardcoded hex inline**; divider lines, a 56px icon circle, box-shadow on the Places dropdown; Places list has no combobox a11y.
- Auth gate + access-denied screens are **black background + Inter + emoji** and leak permission keys.
- **Migration is named `trusted_devices` but there is no trusted-device / "remember this device" / session-revoke UI** in the frontend at all — missing surface.

**Redesign**
- **Unblock email-sent:** add "Resend email" (30–60s cooldown, reuse the OTP resend pattern) + "Use a different email" (returns to account with state), and one line "After you confirm, you'll sign in to finish setup."
- **Real 6-cell OTP component:** `--blanc-line` borders, `rounded-xl` ~48px cells, auto-advance, backspace-to-prev, paste-to-fill, `autoComplete="one-time-code"`; re-focus first empty cell on error, announce via `aria-live`; on `OTP_EXPIRED` force-enable resend.
- Unify all auth cards to **440px**, fully tokenized; remove the "or with email" rule (spacing + quiet "or"), the icon circle, the dropdown shadow; make Places a proper ARIA combobox.
- Add a lightweight **progress indicator** ("Step 2 of 3") in onboarding; add Back to the code step.
- Re-skin the auth gate / access-denied onto `--blanc-bg` (Manrope, quiet spinner, no emoji); replace permission-key text with a human sentence.
- Decide whether trusted-device management is in scope; if yes, it's a net-new screen.

### 098 · Company telephony

**Screens:** Phone Calls (orphaned), Overview, Phone Numbers, Provider Settings, Audio Library, Routing Logs, Operations Dashboard. (User Groups / Call Flow Builder / softphone covered elsewhere.)

**Key problems**
- **IA is incoherent.** `/settings/phone-calls` is a peer config screen that's **not in the nav and has no sidebar** (rendered without `TelephonyLayout`, [App.tsx:128](frontend/src/App.tsx#L128)). The Overview hub just mirrors the sidebar and its Dashboard card points at a legacy `/calls/dashboard` redirect. "Provider Settings" (read-only status) and "Routing Logs" (reporting) are both filed under "Advanced".
- **Two per-number properties split across two screens:** group assignment lives in Phone Numbers, SIP-vs-browser routing lives in the hidden Phone Calls page.
- **Phone Numbers is a 375-line mega-screen** mixing connect-tenant, buy, release, A2P compliance, and group assignment — with two hand-rolled modals and the A2P 7-state pill.
- Narrow columns: Routing Logs detail panel squeeze; Ops Dashboard `1.2fr 1fr` + fixed call row; Provider Settings `maxWidth:800` in a wide pane.
- Whole area is raw hex except Routing Logs; `<Separator>`/border dividers; `—` fillers; dead Audio Library buttons ([AudioLibraryPage.tsx:21](frontend/src/pages/telephony/AudioLibraryPage.tsx#L21)).

**Redesign — new IA**
- **Overview** → a real status dashboard (connection, # numbers, # groups, month usage, A2P state — data already in `telephonyApi.getOverview`), or delete and land on Dashboard.
- **Numbers** → buy/release + group assignment + **routing mode merged in** (absorb Phone Calls; delete the orphan route) + a "Connection" status strip (absorb Provider Settings). Wrap the table in an overflow container; drop the constant "Provider=twilio" column; tokenized status badges instead of ✓/✗ glyphs.
- **SMS / Compliance** → promote A2P 10DLC into its **own stepper page** (see 099).
- **Audio Library** → wire or hide the dead buttons; bare play icon (no circle).
- **Activity** → Routing Logs, with the detail as an **overlay drawer** (not inline) so the caller column stops truncating; show the phone number instead of `—`.
- **Live** → Operations Dashboard with a responsive `auto-fit minmax(320px,1fr)` group grid; pull the transfer control out of the cramped 4-track row into a per-call action/popover; replace border-rules with spacing.

### 099 · Softphone + A2P

**Surfaces:** SoftPhone floating widget (global), Active Call Workspace (`/calls/live/:id`), A2P registration (dialog + status pill in Phone Numbers). No mic-permission flow, no manual presence toggle.

**Key problems**
- The widget is a **full dark theme (`#1a1a2e`)** — a foreign-looking product bolted on; banned divider lines inside it.
- **No Hold and no Transfer in the real dialer** even though the backend models a hold queue and shows "Call waiting" banners users can't act on ([SoftPhoneWidget.tsx:85](frontend/src/components/softphone/SoftPhoneWidget.tsx#L85)).
- `connecting`/`ringing`/`connected` collapsed into one branch, distinguished only by a small pill color — operationally unsafe.
- **No microphone-permission flow** anywhere (`getUserMedia` is never called); first call just fails with a raw Twilio error shown for 3s. No manual presence (Available/Away/Offline).
- **Active Call Workspace is a non-functional mock** (dead Hold/Transfer/End, fake data, decorative avatar circle) duplicating the real widget.
- **A2P** journey lives entirely in one status pill; step 2 is an empty-body POST behind a text link; intermediate states have no refresh/poll → dead-ends; errors via `alert()`.

**Redesign**
- Re-skin the widget to **light Blanc** (`--blanc-surface-strong`, tokens, Manrope number, one accent green for Call, red for End); remove the header divider.
- Add **Hold + Transfer** to the connected state; make "Call waiting" an actionable swap. Give each call state a distinct visual treatment (ringing = pulsing outline; connected = large tabular-nums timer as hero).
- Add an explicit **mic-permission step** in the warm-up dialog (request `getUserMedia`, handle `NotAllowedError` with recovery copy). Make the status dot a real **presence toggle**. When `phoneAllowed===false`, show the panel with a reason instead of hiding it. Bump small touch targets (header 24px, keypad) to ≥40px.
- **A2P as a 3-step stepper** (Business verification → Messaging campaign → SMS enabled) on its own page, each with an explicit status badge, inline (not `alert`) errors, real campaign confirmation panel, and a "Check status"/poll so `*_pending` isn't a dead-end. Client-side EIN/website/state validation.
- **Wire or delete** the Active Call Workspace mock.

### 100 · Automation rules + FSM workflows

**Screens:** Automation rules list + RuleEditor drawer, Workflow (FSM) builder, Actions & Notifications, Notifications section. Note: two unrelated "automation" systems the user must mentally separate, with nothing explaining how they relate.

**Key problems**
- **FSM builder is the worst "флоу непонятный":** the bipartite layout draws every status **twice** (source/target columns) with no legend; raw **SCXML XML dump**, "State ID", "Transition ID", "Initial/Final State" exposed to non-technical admins; **Save silently auto-publishes to production**; IconPicker strings are in Russian while the rest is English; reachable only by drilling through Lead Form settings (no index route).
- **RuleEditor narrow-column:** built in a 540px drawer; condition rows `field + op + value + trash` truncate; raw operator enums; timer shows delay-seconds AND cron simultaneously and submits both; delay in raw seconds; action params labeled only by vanishing placeholders; an existing `VariablePicker` isn't used; **no test/preview** anywhere.
- **Actions & Notifications heading soup:** h1 → "Actions" → "Automation Triggers" → "Notifications" (4 headers before the first control) + **six `<Separator>`s**.
- Rules side is 100% hardcoded hex; two different delay UIs exist in the same product (nice "5 min/1 hour" selects on Actions page vs raw seconds in RuleEditor).

**Redesign**
- **Rules list:** render each rule as a **readable sentence** — *"When a job is completed, if status = done → send SMS, create task"* — so conditions are visible without opening each. Blanc tokens; name as the large entry point.
- **RuleEditor:** move out of the 540px drawer into a **centered ~720px panel**. Natural-language conditions `[field ▾] [is ▾] [value]`. Timer = a single segmented choice — *"Wait [1 hour ▾] after [event ▾]"* **or** *"On a schedule [daily 9am ▾]"*, never both; duration picker instead of seconds. Titled action cards with real labels; wire in `VariablePicker`. Add a **"Test rule"** that runs against a sample event and shows which conditions matched / what would fire.
- **FSM builder:** for contact-center admins, lead with a **simple status list + per-status "allowed next steps" form** (status name, who can move it, confirm?, icon) — a readable table, not a graph. Offer the graph as an optional "Diagram view"; if kept, collapse to **one node per status** with labeled arrows (or add "From"/"To" column headers + legend). Remove SCXML/State-ID/Transition-ID from the default inspector (Advanced disclosure). Replace silent auto-publish with an explicit **Publish** using the already-built `PublishDialog`/`VersionHistory`. Localize IconPicker.
- **Actions & Notifications:** collapse to one heading; drop the redundant "Actions"/"Automation Triggers" headers (eyebrows per group); remove all `<Separator>`; reuse this page's good SLA select pattern in RuleEditor.

### 101 · Platform billing

**Surface:** the entire platform-billing cabinet is one page, `/settings/billing`.

**Key problems**
- **Functional dead-ends:** no **payment-method management** anywhere (a `past_due`/`unpaid` company gets a red badge with **no way to fix the card**); no **downgrade** and no **cancel** (every non-current plan says "Upgrade", even cheaper ones); `billing_enabled===false` strands the user with grey "contact us" text and no link.
- **Narrow column:** `maxWidth: 880` single column on a wide settings page; 3 usage bars stacked in a thin ribbon.
- **Money is never the hero:** no KPI header for current price / next bill amount / next bill date; usage bars show raw `used/cap` with no projected overage cost and no period label.
- Hardcoded status hex (3 copies of the same red); color-only over-limit signal; generic "Subscription" h1 is bigger than the actual plan-name identity; "Invoices" collides with the customer-facing Invoices area.

**Redesign**
- **Widen to ~1100px, two-column.** Left (~2fr): a **money-first KPI summary header** (Current plan & price, Next bill amount + date, Status) as the entry point with the plan name as the large title; below it the usage grid. Right (~1fr): plan/change cards + billing history.
- **Add a Payment-method block** + a `billingApi.portal()` (Stripe customer-portal) endpoint; surface a prominent "Update payment method" CTA in the header when `past_due`/`unpaid`.
- **Usage as a responsive meter grid** (3 cards wide, stacking), each with `used/cap`, bar, and **projected overage $** (derive from `plan.metered`) + a period label ("Jun 1–30, resets Jul 1").
- **Direction-aware plan CTAs:** Current (disabled) / Upgrade / Switch-Downgrade computed from price; highlight the current plan.
- Rename platform "Invoices" → **"Billing history"**; make `billing_enabled===false` actionable (real Contact button); tokenize status colors with a text/icon over-limit indicator.

---

## Part 3 — Functional bugs found (fix regardless of the redesign)

These are correctness issues, not just aesthetics:

1. **Role filter mismatch** — filter values `company_admin`/`company_member` don't match rendered roles `tenant_admin`/`manager`/`dispatcher`/`provider` ([CompanyUsersPage.tsx:34](frontend/src/pages/CompanyUsersPage.tsx#L34), [AdminCompanyDetailPage.tsx:110](frontend/src/pages/AdminCompanyDetailPage.tsx#L110)). Verify against the backend's accepted `role` param.
2. **Billing past_due dead-end** — no payment-method update path; the most urgent billing action is unreachable.
3. **Audio Library Upload / Create-TTS buttons have no `onClick`** ([AudioLibraryPage.tsx:21](frontend/src/pages/telephony/AudioLibraryPage.tsx#L21)).
4. **Active Call Workspace is a dead mock** (`/calls/live/:id`) with non-functional controls.
5. **A2P "create campaign" posts an empty body** with no form/confirmation ([PhoneNumbersPage.tsx:67](frontend/src/pages/telephony/PhoneNumbersPage.tsx#L67)); intermediate states never refresh.
6. **No microphone-permission handling** in the softphone (`getUserMedia` never called).
7. **FSM Save auto-publishes to production silently** — a typo goes live immediately.
8. **Overview Dashboard card → `/calls/dashboard`** legacy double-redirect ([RouteManagerOverviewPage.tsx:16](frontend/src/pages/telephony/RouteManagerOverviewPage.tsx#L16)).
9. **Trusted-device UI missing** despite migration 097's name (decide if in scope).

---

## Part 4 — Prioritized roadmap

**P0 — systemic + worst flow/dead-ends (highest payoff, mostly mechanical)**
1. S1–S2 (tokenize + kill dividers) across all six areas — the single biggest "looks finished" win.
2. Billing: two-column + money KPI header + **payment-method/`portal()`** (functional dead-end).
3. A2P: 3-step stepper with status + refresh (kills the worst telephony flow).
4. OTP: real 6-cell input; signup email-sent resend/back.
5. Routing Logs + Active Call: detail-as-overlay-drawer (kills the narrow-column crush).
6. Fix the functional bugs in Part 3 (role filter, dead buttons, dead mock, auto-publish guard).

**P1 — per-area flow redesigns**
7. RuleEditor → 720px natural-language builder + Test; rules list as sentences.
8. FSM builder → status-list-first, graph optional, de-jargon, explicit Publish.
9. Telephony IA: merge Phone Calls into Numbers; Overview as real status; new nav grouping.
10. Softphone: Hold/Transfer + distinct call states + mic-permission + presence toggle.
11. RBAC: shared `UsersTable`; widen + uncap columns; inline user edit.

**P2 — polish & consistency**
12. Shared `<StatusBadge>` (S4); replace all `alert()/confirm()` (S7); remove all `—` (S5); de-jargon (S6); unify titles to `text-2xl`/Manrope and card radii to `rounded-xl`.

---

## Part 5 — Notes on sequencing

- P0 step 1 is a near-mechanical sweep and unblocks the perceived-quality complaint fastest; it can ship before any flow redesign.
- The flow redesigns (A2P stepper, RuleEditor, FSM, OTP) each have a backend touch-point — confirm API shapes before building (A2P state machine, billing portal endpoint, rule test endpoint).
- Build the shared primitives (`UsersTable`, `<StatusBadge>`, OTP cells, overlay `<Drawer>`, duration picker) once and reuse — several findings collapse into single components.
