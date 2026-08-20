# INVOICE-REMOVE-001 — removing an invoice without losing the money (OB-70)

**Status:** shipped to master 20.08.2026 (`58edca87` + `0e704642`, migration 288) — not in production · **Owner decisions:** 19.08.2026 ·
**Backlog:** `docs/owner-backlog.md` OB-70

## The problem

A paid invoice cannot be taken off a job. `voidInvoice` refuses anything in `draft`; `deleteInvoice` accepts
only `draft` and orphans the payment when it runs. The invoice the owner hit (J-1668-2) took a card payment
while still a draft and never became "issued", so the red button said **Void** and the server answered
**"Draft invoices must be deleted, not voided"** — a sentence about our bookkeeping, thrown at someone who
just wanted the invoice gone.

Money is already job-centric (`paymentLedgerService` derives an invoice's paid figure from the job's payment
pool — see [[pay-jobcentric-001]]). What is missing is a way to detach an invoice from that pool.

## The model (owner, 19.08 — locked)

1. **One action: Remove invoice.** Any status — draft, issued, partially paid, paid. The invoice leaves the
   job; **the payments stay on the job**.
2. **A payment belongs to the job and is *applied* to at most one invoice.** Removing the invoice makes its
   payments *unapplied* — job credit. Unapplied money always counts in the job's Paid.
   **One exception, and it is the owner's:** if the job has exactly one active invoice, unapplied money shows
   on it. With two or more, unapplied money shows on none of them — only in the job's Paid. This replaces
   today's allocator, which spreads the job's pool across invoices *oldest first* and ignores `invoice_id`
   entirely, so an invoice can read "paid" while its own payment list is empty.
3. **Re-attaching is always asked, never guessed.** On removing an invoice that has payments, the system looks
   for another candidate invoice, by priority:
   1. an invoice whose **total** equals the payment amount;
   2. an invoice whose **balance due** (not total) equals the sum of the payments being detached
      (e.g. $95 + $100 = $195 → the invoice with $195 still due, which may be larger and part-paid);
   3. otherwise any unpaid or partly paid invoice, even if the payment exceeds it.
   If a candidate exists the dispatcher is **asked explicitly** and chooses. No silent auto-match, *even when
   the match is unique* — misattributed money is worse than one extra question. If no candidate exists (or all
   other invoices are paid), the payments detach silently into credit.
4. **Job finance is sums.** Estimated = Σ active estimates · Invoiced = Σ active invoices (void excluded) ·
   Paid = Σ job payments · Due = Invoiced − Paid. **A negative Due is a credit, not an error** —
   over-collection is normal and is never "settled" behind the user's back ([[pay-jobcentric-001]]).
   Two clarifications that "excluded" got wrong:
   - **Refunds are netted, not excluded.** $100 taken and $30 refunded is Paid **$70** — neither $100 nor $0.
     A voided payment counts as zero.
   - **Tips are outside Paid** (owner, 19.08). A $115 charge on a $100 invoice is Paid $100, Due $0, and the
     $15 shows as its own figure. Counting the tip as payment made Due read −$15 — a "credit" the customer
     never overpaid, which would then be offered against their next invoice.

Deferred by the owner, not in this spec: applying an existing credit to an invoice from the payment side, and
auto-picking-up credits when a new invoice is created.

### Precedent (why this shape)

HouseCall Pro, Jobber, Workiz and QuickBooks all keep the payment and change its *state*: Jobber puts it on the
account balance, QuickBooks calls it unapplied cash. All of them void only unpaid invoices — you detach the
money first. None of them silently re-applies money to another invoice. Reconciled payments are never deleted.

## Settled while building (Claude, 19.08 — after Codex's map)

- **Over-application is allowed and not split.** Rule 3 may put $195 on an invoice with $100 due: the whole
  payment goes to the chosen invoice. No allocation table, no `applied_amount` — splitting one payment
  across invoices is out of OB-70. **A negative Due belongs to the job, never to a document** (owner,
  PAY-JOB-CENTRIC): the invoice reports what it actually received ($195) with its balance floored at $0,
  and the $95 surfaces as the job's credit. An invoice reading "Due −$95" would invite someone to chase it.
- **Hard delete only for a pristine draft**: no payments, no Stripe sessions, never sent or publicly linked,
  no tasks, no AI generation, not converted from an estimate. Anything with financial or external history is
  **voided** instead, because deleting it cascades away items, revisions, events and tasks — the audit trail.
- **Stripe settling late is part of this task, not a follow-up.** Today a checkout that succeeds after the
  invoice is voided is dropped (`INVOICE_TERMINAL`), and after a hard delete the webhook can look up an
  invoice that no longer exists. Either way the customer is charged and the ledger has nothing. A late
  settlement must land as job-level credit.
- **Permission stays `invoices.create`** (owner, 19.08) — the same right that creates an invoice removes it,
  Provider included. The gate lives in one helper so changing that later is a one-line change.

## Behaviour

### Removing
| Invoice state | What happens to the invoice | What happens to its payments |
|---|---|---|
| draft, nothing paid | deleted | — |
| draft, paid | **voided** (kept for audit — money touched it) | detached → job credit, or re-applied if the dispatcher says so |
| issued / partial / paid | voided | same |
| already void / refunded | Remove is not offered | — |

The draft/void split stays under the hood. The label is **Remove invoice** in every case: the distinction the
user was shown is exactly what produced the error message above.

### The confirm
One dialog, three bodies — always naming the figure, never "the payments":

- nothing paid → "This takes the invoice off the job. Nothing has been paid on it."
- paid, no candidate → "The **$462.00** already paid stays on the job as credit — you can put it on the next invoice."
- paid, candidate exists → the same line, plus an explicit, **unchecked** choice:
  `☐ Put $462.00 on invoice 1668-3 — $462.00 due`

Confirm `Remove invoice` (danger) · Cancel `Keep`.

### Where the money is visible after removal
The job's Paid keeps the amount. On an invoice card whose job holds unapplied money, one quiet line under the
totals says so — otherwise the card reads "Paid $0.00" while the job reads "Paid $462.00" and nothing explains
the gap:

> Job credit $462.00 not applied to this invoice

No action on that line in OB-70 (applying credit is deferred).

## What the UI needs from the API (shape is Codex's call, the requirement is not)

The dialog must know **before** the user confirms: the amount that would be detached, and the candidate
invoice (number + what is due on it) if there is one. A confirm that says "this may re-attach something
somewhere" is not a confirm. So removal is *previewed*, then *performed with the dispatcher's answer*:
the perform call carries either "leave it as credit" or "apply it to invoice X" — the server never decides
that on its own, and never re-asks after the fact.

## Frontend

- `useInvoice` capabilities: `canDelete` + `canVoid` collapse into **`canRemove`** = `invoices.create` (owner,
  19.08 — the right that creates an invoice removes it) and the invoice is not already terminal
  (`void` / `refunded`).
- `InvoiceDetailPanel`: the two danger menu items become one **Remove invoice**; the destructive confirm gains
  the candidate branch (the shared `InvoiceConfirmDialog` already takes a `children` slot).
- Job finance: `calculateJobFinanceSummary` already drops void/refunded invoices, already nets refunds and
  already colours a negative Due as a credit — but it is **not** already correct, and this spec should not
  have said so (Codex, 19.08). It counts tips into Paid, so `Due = Invoiced − Paid` does not hold on any job
  with a tip; it recomputes everything on the client from a list capped at `limit: 100`; and it is a second
  opinion beside `jobFinanceQueries`, which is what the jobs list and Inspector actually read. **Phase 2**
  makes the backend projector the single source and has the panel read it.

## Verification

- Removing a paid invoice keeps the job's Paid unchanged and drops Invoiced by that invoice's total.
- Removing an invoice with a candidate present and the box left unchecked leaves the money unapplied.
- Removing with the box checked shows the amount on the chosen invoice and nowhere else.
- Double-submit removes once (idempotent) — the second call must not detach or re-apply anything twice.
- A payment belonging to another company is never touched (T-own / T-foreign / T-blast).
- Stripe-settled and refunded payments are never deleted by a removal — only unapplied.
