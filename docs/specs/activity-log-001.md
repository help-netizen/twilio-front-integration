# ACTIVITY-LOG-001 — Unified action history across entities

Status: SPEC (owner-reviewed catalog + decisions locked; implementation phased, not started)
Owner decisions: locked 2026-07-26. Discovery audit: `scratchpad/activity-audit.md` (this worktree,
not committed). Owner-facing catalog artifact: Activity Log — каталог событий.

## 1. Goal

Every state-changing ACTION on Estimate, Invoice, Payment, Job, Lead, Contact is recorded as one
durable event (who · when · what) and surfaces in the entity's **History** tab, so the full
chronology is reconstructable. Notes stay notes (never separate events). The Pulse/contact Timeline
is a separate chronology and is OUT of scope — untouched.

## 2. Current state (from the audit — why this is consolidation, not "add a log call")

- Four disconnected stores: `audit_log` (49 calls, almost all auth/RBAC/telephony/Stripe),
  `domain_events` (the ONLY table History reads for job/lead/contact), `estimate_events`,
  `invoice_events` (written, never surfaced in History).
- `HistorySection` (job/lead/contact only) → `GET /:id/history` → `eventService.getEntityHistory`
  → `domain_events` (minus `note_added`) + embedded JSONB notes. It does NOT read `audit_log`,
  `estimate_events`, or `invoice_events`. Estimate/Invoice/Payment have no History surface.
- Notes are embedded JSONB (`jobs.notes`, `leads.structured_notes`, `contacts.structured_notes`),
  and note edit/delete WRONGLY emit `note_edited`/`note_deleted` domain events today.
- `domain_events` stores Keycloak `sub`; `audit_log` expects `crm_users.id` — the two disagree.
- `auditService.log()` swallows insert failures (fire-and-forget) — cannot guarantee "every action".
- Financial children can be parentless (contact-only invoices/payments; payment has no `lead_id`).
- Actor/tenancy defects at many action sites (job cancel/enroute/start/complete drop company;
  ZB proxy routes; contact address/merge; payment related-IDs unvalidated) — see audit §F.

## 3. Owner decisions (LOCKED)

| # | Decision | Choice |
|---|---|---|
| D1 | Whose actions appear | Human + AI agents + integrations (ZB/Stripe webhook), each labeled by `actor_type`. Bulk/background sync is **coalesced** (one row, not per-record). |
| D2 | Field-edit granularity | ONE coarse `<entity>.updated` per **explicit save commit**. **No changed-field detail** (for now). Intermediate/draft/autosave changes emit NOTHING until the user saves. |
| D3 | Parentless financials | Roll contact-only invoices/payments into **Contact** History. No new per-entity History tab. |
| D4 | Gray-zone actions | Log ALL: sends (email/SMS/link), customer views + receipts, payment-session starts + link minting, and money failures (payment/refund/send failed). |

Standing rules (owner, prior): notes are never separate events (remove existing note_edited/
note_deleted from History); Timeline untouched.

## 4. Canonical model

### 4.1 Store
`audit_log` becomes the single business-action journal (correct shape already: actor/action/
target/company/details/created_at). History reads it. The three legacy business-event tables
(`domain_events`, `estimate_events`, `invoice_events`) are read-only for pre-cutover rows and are
no longer written for the six domains after cutover (§7).

### 4.2 Action envelope
```json
{
  "action": "estimate.sent",
  "target_type": "estimate", "target_id": "123",
  "company_id": "<uuid, REQUIRED>",
  "actor_id": "<crm_users.id | null>",
  "details": {
    "actor_type": "user | ai | integration | system | client",
    "actor_label": "Sara | Zenbooker | Stripe | <null for user>",
    "parent_type": "job | lead | contact | null",
    "parent_id": "<id | null>",
    "source": "crm | portal | webhook | agent | mcp | sync",
    "summary": { "...safe scalars only (ids, status, amount, counts)..." }
  }
}
```
- `action` naming: `entity.action` (`estimate.sent`, `invoice.voided`, `payment.refunded`,
  `job.status_changed`, `lead.converted`, `contact.merged`).
- `actor_id` is ONLY `req.user.crmUser.id` for humans; NEVER Keycloak `sub`, NEVER a contact BIGINT.
  Non-human actors leave `actor_id` null and are identified by `details.actor_type` + `actor_label`.
- `details` allowlist ONLY: ids, status names, field/section names, amounts+currency, counts,
  channel, redacted source. FORBIDDEN: message/note bodies, public tokens/URLs, full email/phone,
  signatures, raw Stripe/ZB payloads, arbitrary request bodies. (Audit §F PII list.)

### 4.3 Canonical logger
New `activityLog(client, event)` helper:
- `company_id` REQUIRED (throws if absent — no unscoped business events).
- Accepts an optional transaction `client` so the event INSERT shares the mutation's transaction
  (atomic). For DB actions this is mandatory; a swallow-failures fire-and-forget path is not allowed.
- Resolves/validates `actor_id` (crm user) and stamps `actor_type`.
- Validates + snapshots `parent_type/parent_id` (§4.4).
- Applies the details allowlist.
- External/webhook/provider flows that cannot share a DB tx use an idempotent outbox (Phase 5;
  until then those specific events are best-effort and explicitly marked).

### 4.4 Parent rollup
Relationship columns (audit §D): Estimate `contact_id/lead_id/job_id` (job wins, else lead);
Invoice `+estimate_id` (job → lead → contact); Payment `contact_id/estimate_id/invoice_id/job_id`
(job → via invoice/estimate → contact; **no lead_id**). Parent precedence: **direct job > lead >
contact**; payment derives through invoice/estimate when no direct link.

- Each child event stamps a validated `details.parent_type/parent_id` snapshot at write time.
- Parent History query returns rows where `(target_type,target_id)` is the parent's own OR a child
  whose stored `details.parent_*` matches the parent **OR** a child currently related to the parent
  (union, de-duped by `audit_log.id`). This preserves event-time truth AND lets a later-linked job
  see the child's earlier lead-era history. Old rows are NEVER rewritten on reparent.

### 4.5 Edit-on-save rule (D2)
`<entity>.updated` fires exactly once, at the persisting save commit:
- Estimate/Invoice editor: the single "Save" commit (the whole-document PUT). The item sub-endpoints
  (`POST/PUT/DELETE /:id/items[...]`) MUST NOT each emit an event when they are part of an editor
  save; if the current editor autosaves items individually, Phase 2 batches them so exactly one
  `updated` event results per user Save. No event for opening/typing/adding-items-before-save.
- Job inline fields (description/tags/location — each is its own persisting commit): one `job.updated`
  per committed inline save is correct (there is no separate draft).
- No changed-field list in `details` for now (D2). Status transitions are their OWN event
  (`*.status_changed`), not folded into `updated`.

## 5. History surfaces
- `HistorySection` / `getEntityHistory` extended to union: entity's own `audit_log` rows + child
  rows (§4.4) + embedded notes (unchanged) + legacy pre-cutover `domain_events`. One ordered,
  paginated, de-duped stream.
- Remove `note_edited`/`note_deleted` from History output (D-standing); stop writing them.
- Renderer: map each `entity.action` to an icon + human sentence + actor (with AI/Sync chip) +
  time, per the catalog artifact. Entity color per CLAUDE.md (job #2f63d8, lead #b26a1d,
  estimate=accent, payment=success).
- NO new History tab for Estimate/Invoice/Payment (D3) — they roll to job/lead/contact.
- Pulse routes/aggregation/UI: UNTOUCHED.

## 6. Event catalog
Canonical per-entity action list = the owner-reviewed catalog artifact (§2 of it). Exhaustive
route/service/actor/scope mapping = audit `scratchpad/activity-audit.md` §C. Gray-zone additions
(D4) included: `*.sent`, `*.viewed`, `*.receipt_sent`, `*.payment_session_started`,
`*.link_created`, `*.send_failed`/`payment.failed`/`refund.failed`.

## 7. Phasing (each phase: own commit, tests, gate; deploy owner-gated per batch)

- **P1 Foundation:** `activityLog` helper; migration adding audit_log indexes
  `(company_id,target_type,target_id,created_at DESC)` and the JSON-parent partial index;
  rewrite `getEntityHistory` to the union read-model + parent rollup; drop note_edited/note_deleted;
  renderer mappings for the new keys. Tests: logger (company-required, actor resolution, details
  allowlist, tx-atomic), parent-rollup union query, history de-dup, note-not-evented. NO behavior
  wired yet beyond notes cleanup.
- **P2 Financial:** wire Estimate + Invoice + Payment actions to `activityLog` with parent snapshot;
  enforce the edit-on-save rule (batch editor saves to one `updated`); contact-only rollup (D3).
- **P3 Job:** wire Job actions; FIX the actor-not-passed + company-dropped defects in
  cancel/enroute/start/complete/reschedule paths (audit §F) as part of adding their events.
- **P4 Lead + Contact:** wire Lead + Contact actions; fix the `"undefined"` aggregate defects
  (mark-lost/reactivate/assign), contact-merge human-actor, and the raw contact side-writes' scope.
- **P5 Cutover + polish:** legacy read cutoff timestamp; bulk-sync/webhook coalescing + idempotent
  outbox for external flows; wire all D4 gray-zone events; full tenant/RBAC + durability regression.

Cutover safety: to avoid double-counting, either (a) audit-only writes after a cutover timestamp with
legacy read only before it, or (b) a single helper writing canonical + compatibility projection in
one tx. Chosen in P5; P1–P4 keep legacy readable and do not dual-write with fail-soft helpers.

## 8. Non-negotiables / guards
- `company_id` on every business event; foreign-entity actions stay 404 (no cross-tenant).
- Human actor = `crmUser.id` only ([[created-by-fk-crm-user-id]]); system/AI/integration via actor_type.
- No PII/tokens/bodies in `details`.
- Notes never become events; Timeline never touched.
- An action event MUST NOT legitimize a tenancy-unsafe write — the underlying write is fixed in the
  same phase that logs it.

## 9. Verification (per phase)
Independent jest re-run (worktree form, `--use-bundled-ca --runInBand`); one sabotage per phase on
its riskiest invariant (P1: break parent-rollup union → parent stops seeing child rows → RED; P2:
break edit-on-save batching → multiple updated events → RED); FE build when History renderer
changes; tenant-scope test on every newly-logged mutation.
