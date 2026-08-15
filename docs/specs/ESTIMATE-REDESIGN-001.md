# ESTIMATE-REDESIGN-001 — Estimates, rebuilt around getting a yes

**Owner directive (2026-08-14/15):** rebuild every estimate screen the way invoices were
rebuilt. UX follows `INVOICE-REDESIGN-001` (one scroll, one ✕, big buttons, no kebab);
type follows the payment card, `TYPE-CANON-001` (32 / 20 / 15, weight and colour only).

**Visual spec = the approved mockups** — 10 screens, owner-reviewed live, in
`ESTIMATE-REDESIGN-001-mockups.html`. **Current state** = `ESTIMATE-REDESIGN-001-inventory.md`
(19 surfaces, 313 cited file:line ranges, Codex). This doc is the behavioural spec, the
task plan and the verification contract.

Ownership (tandem): **Claude** owns the visual/UX, the presentational components and the
markup; **Codex** owns backend/data plumbing, the bug fixes, and ALL tests (Jest + the
`e2e/` Playwright coverage per the E2E-on-touch rule).

---

## 1. Why this is not a copy of the invoice pass

An invoice asks to be **paid**. An estimate asks to be **agreed to**. Every decision below
falls out of that: the loudest thing on the screen is where the proposal stands on the way
to an answer, and the primary button is always the next move toward it.

The inventory also found that the document does not hold still. **Any edit resets a
non-draft estimate to `draft`** — including editing one line item, and including linking a
job (`estimatesService.js:267-340`, `:390-417`, `:888-930`). There are **no transition
guards at all**: Send always writes `sent`, Approve writes `approved`, Decline writes
`declined`, none of them checking the prior status (`:574-737`, `:740-886`). So an
approved estimate can be re-sent back to `sent`, and a declined one can be approved.

## 2. Approved decisions (owner, this session — binding)

1. **Three layers, one skeleton, every surface.** ① Identity — amount, status, and ONE
   quiet line naming the customer and the job. Context is a line, never a section. ② The
   document — Summary → Items → Total, present on every surface that shows the estimate,
   including the customer's page. ③ The record — History, at the very bottom, in grey.
   Actions sit between ① and ②.
2. **"Create invoice" is available at every status**, beside the primary. From `draft` or
   `sent` it also marks the estimate approved, in the same transaction. Reason: the
   customer usually says yes on the spot, and recording that should not cost three taps.
3. **No confirmation for it — an Undo instead.** The toast states what changed ("Invoice
   #1043 created · marked approved") and offers Undo. Confirm the rare and destructive;
   undo the frequent and constructive.
4. **When an invoice already exists the button opens it.** Never a second invoice; the
   service is already idempotent (`estimatesService.js:947-953`).
5. **The customer can approve or decline from `/e/:token`.** This is the whole point:
   today the page cannot say yes, so approvals are typed in by a dispatcher from memory.
6. **Declining raises a task**, the same second: `"EST-#### declined — win it back"`, due
   today, assigned to the estimate's author (unassigned if absent), carrying the reason.
7. **The decline reason is asked once and never required** — four chips (price / chose
   someone else / not now / something else) plus optional free text.
8. **No permanent captions under buttons.** A warning about a rare action belongs to the
   tap, not to every viewing of the card.
9. **The generate card keeps its shipped size and shape** (lavender panel, own heading,
   real text area). Only the words change: it does not require a formal report, so it no
   longer says one — "Write the estimate for me / say what the job is, in your own words".
10. **On mobile the card carries no Generate button**: tapping it opens the existing
    `FullScreenTextEditor` — **kept exactly as shipped** — and Generate lives there, above
    the keyboard. **Desktop keeps the button in the card.**
11. **`＋ Search the price book or add a new item…`** replaces a bare "Add item": it says
    what it searches, so nobody has to open it to find out.

### Decision taken by the lead (owner did not object; flag if wrong)

12. **Edit-resets-to-draft stays**, because changing it is a data-model job, not a screen
    job. But it stops being silent: tapping **Edit on a non-draft estimate** asks first,
    naming the consequence ("This will return EST-1039 to draft and clear the customer's
    approval"). The already-created invoice is unaffected.

## 3. Scope — surfaces

Ten mockup screens; nineteen inventoried surfaces. Every surface has a verdict.

| # | Surface | Verdict |
|---|---|---|
| S1 | Estimates list (`EstimatesPage`) | Rebuild: mobile rows, plain-language status with age, load-more, **and a New action — standalone creation is absent today**. |
| S2–S4 | Detail (`EstimateDetailPanel`) | Rebuild on the one skeleton; actions out of the kebab; status-driven button matrix; History at the bottom. |
| S5 | Editor (`EstimateEditorDialog`) | Rebuild: one scroll, floating fields, item rows → sheet, generate card above Summary. |
| S6 | Report editor (`FullScreenTextEditor`) | **Unchanged.** Generate moves into its action bar on mobile. |
| S7 | Item sheet (`EstimateItemDialog` + the editor's inline twin) | **Collapse the two implementations into one.** |
| S8 | Send (`EstimateSendDialog`) | Rebuild to the flat language; header names the estimate (kills the wrong-recipient class of bug). |
| S9 | Public page (`PublicEstimateViewPage`) | Rebuild + **Approve / Decline**. |
| S10 | Public decline reason | New. |
| H | Summary editors (two implementations) | **Collapse into one.** |
| J | Price Book picker | Keep; one-tap insert for a known preset/group; hide "save to catalog" without `price_book.manage`. |
| K | Preview | The detail's instance is **unreachable dead code** — delete it. Fix the template-failure state that shows "Loading template…" forever. |
| M | Order list | Keep, labelled internal. |
| N | Decline reason (staff) | Keep; share its vocabulary with S10. |
| P, Q | Two kebab menus | Delete both; actions become visible. |
| R | Link Job (`window.prompt`) | Replace with a job picker sheet. |
| O | Task surfaces | Reuse unchanged. |
| S | PDF | Unchanged. |
| B, C | Job / Lead finance sections | Keep; **fix Lead's New Estimate, which only renders when the lead has zero estimates**. |

## 4. Bugs and safety gaps to fix (from the inventory)

1. **Unhydrated edit destroys the line items.** The standalone row passes the list row
   straight into the editor, which initialises missing items to `[]` and always sends a
   full replacement (`EstimatesPage.tsx:66-69`, `EstimateEditorDialog.tsx:91-110`,
   `:288-315`). Saving from a list row can delete every line.
2. **Wrong-recipient send.** The row stores `sendEstimateId` while the dialog takes the
   recipient from `page.selectedEstimate` (`EstimatesPage.tsx:184-188`, `:237-245`).
3. **No transition guards** (§1). Send/Approve/Decline must validate the prior status.
4. **The public token never dies** — no expiry, no revocation, and no archived/status
   condition on lookup (`estimatesQueries.js:661-690`). A declined or archived estimate
   stays retrievable forever.
5. **Permissions are not reflected in the UI**: the detail checks only `estimates.send`
   and `price_book.manage`, so a view-only user sees Edit / Archive / Create-invoice
   (`EstimateDetailPanel.tsx:74-80`).
6. **Destructive actions run without confirmation** (archive, delete, decline-on-behalf).
7. **`viewed` is unreachable** — the status exists and is filterable, but no code writes
   it; the public view only logs an activity (`estimatesService.js:1193-1236`).

## 5. Task plan

Each phase: FE (Claude) + BE (Codex), independently reviewable, gated by build + jest +
the phase's E2E green on staging.

- **P1 — the yes.** BE: public approve/decline (rate-limited, idempotent, token dies on
  decline, records actor/IP/UA), decline → task, `viewed` on first open, transition
  guards. FE: S9 + S10.
- **P2 — detail.** FE: S2–S4 on the skeleton, button matrix, History, no kebab, Edit
  confirm (§2.12). BE: convert-from-any-status + approval side-effect + Undo endpoint,
  permission-gated action visibility.
- **P3 — editor.** FE: S5 + S7 (one item sheet, one summary editor), generate card. BE:
  edit hydration (bug 1), item-sheet contract.
- **P4 — list & send.** FE: S1 rows + New. BE: send single-object prefill (bug 2).
- **P5 — leftovers.** Link Job picker, dead Preview removal, Lead's New Estimate, token
  expiry policy.

## 6. Verification (mandatory)

- **Jest** (Codex) per task: the two bugs, transition guards, public approve/decline
  idempotency + token death, decline→task, convert-from-any-status, permission gates.
- **Frontend build** `npm run build` green after every FE task.
- **E2E on staging** per `e2e-coverage-on-touch`: create → send → customer approves →
  invoice; customer declines → task exists; edit-from-list keeps its items.
- **Sabotage** (Claude gate): one control per riskiest invariant — the tenant guard on the
  public routes, and the edit-hydration fix — break it, watch the suite go red, restore
  from a `cp` backup.
- **Type gate:** `styles/typeScale.test.ts` must not rise; new estimate components use
  `.blanc-l2` / `LEVEL_TWO`, not hand-written sizes.

## 7. Out of scope

Options/tiers/alternates, deposit collection (legacy columns, ignored by the write path),
`valid_until` expiry as a status, signatures on the public page, the estimate PDF layout,
and the dormant `/api/portal` accept/decline endpoints. Deploy is owner-gated.
