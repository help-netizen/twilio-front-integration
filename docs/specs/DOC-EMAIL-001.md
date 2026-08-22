# DOC-EMAIL-001 — the three letters a customer actually gets

**Status:** approved by the owner 21–22.08.2026, in build (tandem — Codex backend templates, Claude
design/copy/frontend/gates) · **Approved mockups:** `docs/specs/doc-email-001/` (open the HTML files;
`build-mockups.js` + `_kit.js` regenerate them)

## Why

The three customer-facing documents had drifted apart, each in its own way:

- **The invoice said everything twice.** `InvoiceSendDialog` pre-filled a paragraph carrying the amount,
  the due date and the pay link, and the backend rendered a full document underneath saying the same.
- **The estimate had no document at all** — `estimatesService.buildEmailBody` wrapped that paragraph and
  a bare link, nothing else.
- **The receipt never answered the only question it exists for.** It showed "Invoice total" and the amount
  paid, and no remaining balance: a customer who paid $10 of $10.70 could not tell whether they were done.
  Its header also printed the number raw — "#INVOICE J-1516-1" — the doubling `utils/docNumber.js` exists
  to prevent.

## One structure, three jobs

Brand → "Hi {First}" and ONE lead sentence → the ask (button) → facts → items → totals → optional operator
note → closing → **a person's sign-off** → company footer.

What differs is only what the letter is for:

| | Estimate | Invoice | Receipt |
|---|---|---|---|
| Heading | `Your estimate — $300.00` | `$210.70 due by Aug 23` | `Payment received — $60.00` |
| Totals end with | Estimate total · Paid so far · **Left to pay** | Invoice total · Paid so far · **Amount due** | Invoice total · Paid so far · **Remaining balance** |
| Button | Approve this estimate | Review & pay $210.70 | — (quiet link when a balance remains) |
| Under the button | One tap, no account needed. Valid until {date}. | Card or bank — payments secured by Stripe. | — |

Invoice states: **due** (`$X due by {date}`), **partly paid** (`$X still due by {date}`), **overdue**
(`$X — past due since {date}`). Receipt states: balance remains, or settled — where the last totals row
reads `Nothing further due` in words rather than a zero to interpret.

## The decisions, and who made them

- **The invoice asks for money.** "Whenever you're ready" is gone: "Please review invoice J-1516-1 and pay
  $210.70 by Aug 23", with the button — carrying the amount — above the itemisation (owner: we are here to
  convert, not to make the customer comfortable; left to himself he would never pay).
- **Trust, not speed.** Under the button: "Card or bank — payments secured by Stripe", not "takes about a
  minute" (owner). What reassures at the moment of paying is who holds the card details.
- **A person signs it.** "Thanks, Dana" — **first name only** — then the company's contacts in the footer
  (owner: we don't hide behind the sign; there must always be a person). The receipt is signed by
  **whoever took the payment**; when the customer paid themselves through the link, by **whoever sent the
  invoice**.
- **The auto-prose goes.** The send dialogs stop composing a paragraph — the letter already carries the
  ask. The field stays, empty, and what the operator types arrives as its own block, "A note from Dana".
- **The number is printed short.** Stored numbers carry the word ("INVOICE J-1516-1"), so any sentence
  that says "invoice" prints `shortDocNumber(...)`.
- **No row that says nothing.** `1 × $95.00` is dropped — at quantity one it repeats the amount already on
  the right; it appears only when the quantity is not one (owner: 95% of lines are a single unit). Nothing
  paid → no "Paid so far" row and no zero.
- **Money already received is "Paid so far"** everywhere — deposit, service call, part-payment. The label
  never names the reason, because the reason varies (owner). The final row differs by obligation:
  **Left to pay** on an estimate (nothing is owed yet), **Amount due** on an invoice.

## Credit against an estimate

A customer who has paid something on the job — a 50% deposit, a service call, an earlier part — sees it on
the estimate:

```
Estimate total   $300.00
Paid so far      −$95.00
Left to pay      $205.00
```

Three rules that make this correct rather than merely persuasive:

1. **The credit is deducted after tax.** That money was already taxed on its own document; taking it off
   before tax would under-collect tax on this one.
2. **The estimate total stays the price of the work.** $300 is what the job costs; $205 is what this
   customer would pay. Two different facts, two different rows.
3. **The same money is never counted twice.** It stays applied where it was paid, or moves — never both.
   The removal machinery from OB-70 (`docs/specs/INVOICE-REMOVE-001.md`) is what moves it.

The data already exists: `documentPaymentQueries.applyEstimatePayments` derives an estimate's
`deposit_paid` / `balance_due` from the job's payment pool. It is simply never shown. **Check its
`Math.min(paid, total)` clamp** — money beyond the estimate's total is silently dropped there.

## Mobile

The letters had **no `meta viewport`**, so a phone laid them out at a 980px desktop viewport and scaled
them down — every readable size became unreadable — and the table was a fixed 600px, which forced sideways
scrolling at 375. Required of every template:

- `<meta name="viewport" content="width=device-width, initial-scale=1">`
- fluid outer table (`width:100%`, `max-width:600px`), never a fixed pixel width
- side padding that drops to 22px under 600px, label/value pairs that stack, and a CTA that spans the
  column
- the base layout must already fit without the media query — clients that strip `<style>` still get a
  readable letter

## Type and surface

Flat: no filled panels, no rounded boxes inside the letter (owner). Hierarchy is weight and colour;
hairlines only where they separate rows of money. **Three sizes — 24 / 15 / 13 — and one family.** The
draft that had seven sizes was the bug this rule exists to prevent.

## Verification

- Every letter renders at 375 and at desktop with no horizontal overflow, and reports exactly three type
  sizes and one font family.
- The totals in each rendered letter add up (assert on the rendered text, not on the inputs).
- A quantity of 1 prints no `1 ×` line; a quantity of 2 prints `2 × $45.00`.
- Nothing paid → no "Paid so far" row.
- A receipt whose invoice still owes money prints the remaining balance; a settled one says "Nothing
  further due".
- No sentence prints a doubled number ("invoice INVOICE …", "#INVOICE …").
- The send dialogs pre-fill nothing for email; SMS keeps its text, since there is no document there.
