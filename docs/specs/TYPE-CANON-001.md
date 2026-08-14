# TYPE-CANON-001 — one type below the section heading

**Status:** adopted 2026-08-14 · reference implementation shipped (`7049608e`, payment card)
**Owner decision:** «сделай вообще все одним шрифтом внутри второго уровня, только цветом делить, серый и чёрный» → then «подзаголовки второго уровня сделай чёрным и жирным».

---

## The problem this fixes

The payment card was refined round by round, and each round added half a step:
11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 18, 20, 32. Eleven sizes on one column.
At that point the word **Contact** was heavier than the customer's name beneath
it — the label outranked its own answer, and the eye had no reliable rule for
what mattered.

Across the whole frontend at adoption time: **29 distinct ad-hoc sizes** in
**605** Tailwind `text-[Npx]` occurrences plus **76** inline `fontSize` props.
Seven of those sizes are half-steps (9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5)
that exist for no reason anyone can name.

## The rule

Three sizes on a screen:

| Level | Size | What it is |
|---|---|---|
| 0 | **32px** Manrope 600 | The one number or name the screen exists for — a payment's amount, an entity's title. At most one per screen. |
| 1 | **20px** Manrope 600 | A section heading. `.blanc-section-heading`. |
| 2 | **15px** IBM Plex Sans | **Everything below a section heading.** |

**Inside level two nothing changes size.** Hierarchy is carried by exactly two
signals, and there are only two of each:

- **Weight** — `500` is the voice. `600` marks a group heading (Contact,
  Schedule, Location, Provider) and figures meant to be compared (Total / Paid
  / Due). Nothing is `700`; `font-bold` is a third level nobody asked for.
- **Colour** — `--blanc-ink-3` names a thing, `--blanc-ink-1` answers it.
  `--blanc-warning` / `--blanc-success` appear only where they mean money owed
  or a credit, `--blanc-danger` only for failure. Semantic colour is not
  decoration and never marks mere importance.

Consequences that fall out of the rule:

- A group heading is **not** a smaller heading — same size as its rows, made a
  heading by weight and colour. Its icon takes the heading's colour, because a
  grey mark in front of black bold text reads as two separate objects.
- **No uppercase eyebrows in new work.** `.blanc-eyebrow` is legacy.
- **No dashed rules between rows** in flat surfaces: the grey label already
  marks where one field ends. (Framed cards keep theirs — a line inside a frame
  belongs to something.)
- Pills, bubbles and chips are the same 15/500; their tint is what makes them a
  status, not a size and weight of their own.

## Where the rule lives

One definition, two spellings, never a third:

- `frontend/src/styles/design-system.css` — `.blanc-l2`, `.blanc-l2-quiet`,
  `.blanc-l2-heading` (for `className`).
- `frontend/src/styles/levelTwo.ts` — `LEVEL_TWO`, `LEVEL_TWO_QUIET`,
  `LEVEL_TWO_HEADING`, `LEVEL_TWO_LABEL_WIDTH` (for React `style` props).

A call site that writes `text-[13px]` or `fontSize: '12.5px'` is the exact
regression this canon exists to prevent.

## Migration — a ratchet, not a rewrite

Restyling 605 call sites at once would be one enormous untestable diff. Instead
`frontend/src/styles/typeScale.test.ts` freezes today's counts as a **ceiling**
and fails when any of them grows:

- total ad-hoc `text-[Npx]` occurrences,
- distinct sizes in use,
- half-step sizes.

New work therefore cannot add to the pile, and each migrated surface lowers the
ceiling — the numbers in that test only ever go down. Lower them in the same
commit that migrates a surface.

Suggested order, most-looked-at first:

1. **Half-steps everywhere** (~42 sites) — pure mechanical noise removal, no design judgment needed.
2. **Entity cards** — job, lead, contact. The job card is the payment card's twin and the inconsistency is most visible there.
3. **Lists** — Jobs, Leads, Pulse, Payments rows.
4. **Settings and Marketplace** — lowest traffic, largest surface.

## Verification

- `frontend/src/components/payments/PaymentDetailPanel.test.tsx` — the rule's
  behavioural gate on the reference implementation: CSS and the TS twin must
  agree; no size other than the 32px hero; no `font-bold`; headings carry weight
  and colour but no size; flat groups separated by space, not lines.
- `frontend/src/styles/typeScale.test.ts` — the app-wide ratchet.
- Sabotage controls run at adoption: setting `.blanc-l2` to 16px, adding
  `fontSize` to `LEVEL_TWO_HEADING`, and adding `font-bold` to a pill each
  turned the suite red; all restored from backup.
