# Albusto Design System — conventions

Albusto is a warm, calm, editorial CRM for a home-services business (jobs, leads,
contacts, estimates, invoices, scheduling). The visual language is internally codenamed
**Blanc** and every token/class is prefixed `--blanc-*` / `.blanc-*` — that name is
internal only. **The product is Albusto; never surface "Blanc" in user-facing text.**

**Design, don't decorate.** Every element must justify its presence — if it doesn't help
the user finish a task, remove it. Prefer flat layout and generous spacing over chrome.

## Foundations

- **Type:** IBM Plex Sans (body), Manrope (headings). An entity's name/title is the entry
  point — always large (`h2` / `text-2xl`, heading font). Body is comfortable, not dense.
- **Text hierarchy (tokens):** `--blanc-ink-1` primary · `--blanc-ink-2` secondary · `--blanc-ink-3` hints/labels.
- **Surfaces:** `--blanc-bg`, `--blanc-surface-strong` (#fffdf9). Subtle section tint `rgba(117,106,89,0.04)`.
- **Lines:** `--blanc-line` (rgba 117,106,89 / .18), `--blanc-line-strong`. **Accent:** `--blanc-job` / `--blanc-job-soft` (soft blue). **Danger:** `--blanc-danger`.
- **Radii:** 10 / 16 / 22 / 28px. Cards `rounded-xl`; controls 10px; sheets 22px. **No shadows** on cards — use a border and darken it on hover.
- **No horizontal rules.** Separate sections with spacing and layout, never `<hr>` / `border-top`. (A `Separator` exists for genuine inline dividers — use sparingly.)
- **Eyebrow labels:** `.blanc-eyebrow` (11px, uppercase, 0.14em tracking, ink-3). Keep headers to a minimum; merge sections whose content format is similar.

## Composition principles

- The entity name is large and first; contact data (phone, email) sits **under the name as
  part of identity** — no "CONTACT INFORMATION" heading.
- **Only render data that exists.** No "—" / "N/A" rows; if a field is empty, omit the row.
- Don't show technical IDs. A link to an external system is a small icon beside the name.
- Related entities go in one literal-named list ("Leads & Jobs", not "Activity").
- **Inline editing where possible** — a note is a textarea in the card that saves on blur, not a dialog. Put action buttons next to the data they act on.
- Two-column grids are balanced by height and density, not stacked 5-vs-1.

## Components — how they compose

- **Button** — exactly one primary action per surface. `default` = the main action (solid accent);
  `secondary` = emphasized non-primary, intentionally a soft-blue tint (not a muted gray);
  `outline` = neutral bordered; `ghost` = tertiary / cancel / dismiss (text only); `destructive` = delete;
  `link` = inline text action. Sizes `sm` / `default` / `lg` / `icon`. Icons go in the leading slot.
- **Card** — `Card › CardHeader (CardTitle + CardDescription + CardAction) › CardContent › CardFooter`.
  Title in the heading font, description muted; a status **Badge** belongs in `CardAction` (top-right);
  primary/secondary buttons framed in the footer. `rounded-xl`, bordered, no shadow.
- **Badge** — short status/label chips (Scheduled, Overdue, Paid, Draft). Variants default / secondary /
  destructive / outline. At most one inline glyph.
- **Input / Textarea** — always labeled (pair with **Label**). Helper text in ink-3. Textarea is the
  inline notes pattern (saves on blur).
- **Select** — Radix: `Select › SelectTrigger › SelectValue` + `SelectContent › SelectItem`; group with
  `SelectGroup` / `SelectLabel` / `SelectSeparator`. The trigger is a bordered 10px-radius control.
- **Checkbox / Switch** — labeled form rows. Switch = on/off settings; Checkbox = flags / multi-select.
- **Tabs** — `Tabs › TabsList › TabsTrigger` + `TabsContent`. Sections a detail panel (Details / Notes / History).
- **Table** — `Table › TableHeader › TableRow › TableHead` + `TableBody › TableRow › TableCell`
  (+ optional `TableCaption` / `TableFooter`). Right-align numeric columns.
- **Dialog / DropdownMenu / Tooltip / Popover** — Radix overlays. Dialog for confirms/forms
  (`DialogHeader` › `DialogTitle` + `DialogDescription`, actions in `DialogFooter`). DropdownMenu for
  entity/row actions (a `DropdownMenuLabel`, items, a separator, the destructive item last). Tooltip must be
  wrapped in `TooltipProvider`.
- **Skeleton** — compose loading placeholders that mirror the real layout (title/meta bars + a circle),
  never a single lone bar.

## Don'ts

- No decorative avatars or icons-for-icons'-sake; no emojis or badges that don't aid a decision.
- No horizontal rules, heavy separators, or card shadows.
- No empty-field placeholders, no duplicated IDs, no "designer-y" labels when a literal word exists.
- Never ship the internal codename "Blanc" — the product is **Albusto**.
