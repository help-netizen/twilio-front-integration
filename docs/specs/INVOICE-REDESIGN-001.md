# INVOICE-REDESIGN-001 — Mobile-first invoice rebuild

**Owner directive (2026-08-13/14):** rebuild every invoice screen, mobile-first. The
create flow, the detail/view, and every nested 2nd/3rd-level surface. Flat, no wasted
space, big tap-safe controls, nothing important hidden.

**Visual spec = the approved mockups** (design phase, owner-reviewed live): 9 screens.
Current-state inventory: `docs/specs/INVOICE-REDESIGN-001-inventory.md` (26 surfaces,
Codex). This doc is the behavioral spec + task plan + verification contract.

Ownership (tandem): **Claude** owns the visual/UX and the presentational components +
markup; **Codex** owns backend/data plumbing, the bug fixes, and ALL tests (Jest + the
`e2e/` Playwright coverage per the E2E-on-touch rule).

## Approved decisions (owner, this session — binding)

1. **Full-screen on mobile, ONE scrolling surface.** No pinned header, no pinned footer
   — the title and the primary CTA scroll with the body. (Editor + Detail.) Desktop may
   keep pinned chrome.
2. **Flat.** No `rounded-2xl`/rgba section boxes. A section = `.blanc-eyebrow` label +
   spacing. Containers only for *state* (error / "no items" / payment-uncertainty /
   confirmation), never for plain document sections.
3. **ONE overlay close** = a single ✕ (OverlayClose canon). No back-arrow/Cancel
   duplication, no dedicated top row. The ✕ is **close-safely**: when the editor is
   dirty it asks *Discard / Keep editing* (screen 9) — never silently discards a filled
   form.
4. **Big full-width buttons** (~48–52px, job-status-button size), but **one primary per
   screen** (violet). Secondary (Resend/Preview/Edit) neutral; Void **subordinate/muted**.
   Secondary + destructive stacked UNDER the primary CTA.
5. **No kebab.** Collect payment / Resend / Preview / Edit are visible. "Send reminder"
   → neutral **"Resend"** (plain re-send, not a reminder).
6. **Void protected:** muted, at the very bottom, + a confirmation that names the invoice
   #, balance, and consequence. **Delete for drafts, Void for issued** — never both on one
   record. (Today Void/Delete run with NO confirmation — this is a real safety fix.)
7. **Line-item editing → a sheet** (floating fields, keyboard-aware). BUT a known Price
   Book preset/group inserts in **one tap** (no sheet round-trip); the sheet is only for a
   *custom* item or an *edit*.
8. **Payment terms removed from the create form** (document-setting; edited on the invoice
   detail beside the due date).
9. **Clean lucide line-icons**, no emoji. **Floating-label inputs** (FORM-CANON) — this +
   one keyboard contract is the real fix for the janky inputs.
10. Keep the AI **"Generate from a report"** block (owner likes it; works).

## Scope — surfaces (maps to the 9 mockup screens)

FE = Claude (components/markup). BE = Codex (routes/services/data hooks/tests).

- **S1/S2 Editor** (`InvoiceEditorDialog`) — FE rebuild: unpin chrome on mobile, flatten,
  floating fields, item read-rows → item sheet, close-safely, remove payment-terms, keep
  AI card, button hierarchy.
- **S3 Detail** (`InvoiceDetailPanel`) — FE rebuild: flatten, actions out of the kebab,
  primary up top, Void muted+bottom+confirm, close-safely.
- **S4 Item sheet** (reuse/replace `EstimateItemDialog`) — FE: floating fields, no pinned
  footer mobile; picker one-tap insert (preset/group adds immediately).
- **S5 Send** (`InvoiceSendDialog`) — FE: align to the flat/big-button language.
- **S6 Invoices list** (`InvoicesPage`) — FE: mobile row/card (no 7-col table),
  plain-language status, "Load more". BE: **pagination `page`↔`offset` fix**.
- **S7 Collect payment** — FE sheet + BE: wire **invoice-level** collection (invoiceStripe
  link/manual endpoints are declared but not registered; ManualCardDialog has a dormant
  `invoiceId`). Allocate to the invoice ledger.
- **S8 Void / Delete confirm** — FE center dialog + BE: confirmation contract (void reason?
  today no body); status-gated (Delete drafts / Void issued).
- **S9 Close-safely** — FE: dirty-check confirm on the ✕.

## Cross-cutting (structural — mostly BE/Codex)

- **Bugs:** (1) hydrate the full invoice before Edit (list-row Edit can save `items:[]`);
  (2) Send derives every prefill from ONE invoice object/ID (row Send can pair the wrong
  recipient); (3) pagination `page`↔`offset`.
- **Permissions:** action visibility must match backend perms (view-only must not see
  Edit/Void/Delete → 403); permission-gate the payments fetch (it swallows 403 as empty).
- **One keyboard contract:** full-screen form + one keyboard-safe field sheet — replace the
  5 competing viewport/focus mechanisms; deliberate documented autofocus (picker says
  "no auto-keyboard" but autofocuses).
- **One detail container** across Job / Lead / Invoices (Lead uses a different container).
- Price Book "Create new" copy: don't promise catalog save without `price_book.manage`.

## Task plan (phased; each task: FE or BE, acceptance, verify)

- **P1 — Editor** *(FE T1)* + *(BE T1: edit-hydration bug + data hook)*. Accept: mobile
  editor is one scroll, flat, floating fields, close-safely, item sheet, no payment-terms;
  `npm run build` green; editor jest + E2E create-invoice green on staging.
- **P2 — Detail** *(FE T2)* + *(BE T2: permission-gated actions + payments-fetch gate)*.
  Accept: actions visible (no kebab), Void muted+confirm, flat, close-safely.
- **P3 — Confirmations & collect** *(FE T3: item sheet one-tap, Void/Delete confirm,
  Close-safely, Collect sheet)* + *(BE T3: invoice-level collect wiring, void/delete
  contract, Send single-object prefill bug)*.
- **P4 — List** *(FE T4: mobile rows/status/load-more)* + *(BE T4: pagination fix)*.
- **P5 — Structural** *(BE T5: one keyboard contract seam, container unify, price-book
  copy)* + *(FE: adopt the keyboard contract across the sheets)*.

Each phase ships behind `npm run build` + jest + the phase's E2E green on staging before
prod. Phases are independently reviewable/committable.

## Tenancy & Roles (canon — `docs/specs/TENANCY-RBAC-CANON.md`)

| Concern | Rule |
|---|---|
| Company scoping | every invoice read/write stays `req.companyFilter`-scoped; no cross-company id acceptance. |
| Actor | `created_by`/actor = `crmUser.id`, never `sub`. |
| `invoices.send` | gates Resend. |
| `payments.collect_offline` / online | gate Collect methods + the payments fetch + payment void. |
| `price_book.manage` | gates "save to catalog" on custom item create. |
| view-only (`invoices.view`) | must NOT see Edit/Void/Delete/Collect affordances. |
| Void/Delete | company-scoped; confirmation payload carries no cross-company id. |

## Verification (MANDATORY)

- **Jest** (Codex) per task — units for the 3 bugs, permission gates, invoice-collect,
  void/delete contract. Worktree form: `../../../node_modules/jest/bin/jest.js --config ... --testPathIgnorePatterns "/node_modules/"`.
- **Frontend build:** `npm run build` (tsc -b, noUnusedLocals) green after every FE task.
- **E2E on staging** (per `e2e-coverage-on-touch`): new/extended Playwright specs for
  create-invoice, detail-actions, collect, void-confirm, list; `data-testid` on the driven
  nodes (Claude). Gate: `set -a && . e2e/.env.local && set +a && cd e2e && npm run smoke`
  GREEN vs staging after the master→staging auto-deploy, before prod. Recorded here per task.
- **Sabotage** (Claude gate): one control per riskiest invariant (tenant guard on the
  invoice routes; the edit-hydration fix) → break → suite RED → restore from `cp` backup.
- **MCP parity:** invoice CRUD/send are shared services the ChatGPT connector rides — run
  the MCP suite when their signatures change.

## Out of scope (this feature)

PublicInvoicePayPage redesign, Invoice PDF layout, invoice-template settings editor, the
desktop-only chrome (unpin is mobile-first; desktop may keep pinned). Deploy is owner-gated.
