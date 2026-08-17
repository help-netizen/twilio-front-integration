# Project Instructions

## UI Design Principles

### Philosophy

**Every element must justify its presence.** If it doesn't help the user complete a task — remove it. Don't decorate — design.

### Layers & overlays — THE canonical pattern (always use this)

**Every entity view/edit surface is a right-side slide-over "layer" (шторка), never a center modal.** This is the app's core interaction model — job view, lead card, estimate/invoice editors, forms all slide in from the right. New UIs MUST follow it. Full spec: `docs/specs/FORM-CANON.md`. Gold-standard examples: `EstimateItemDialog.tsx`, `NewJobModal.tsx`, `TaskFormDialog.tsx`.

- **Component:** `<Dialog><DialogContent variant="panel">` with `DialogPanelHeader` (pinned title) → `DialogBody className="md:px-8 md:py-7"` (scrollable; inner `<div className="mx-auto w-full max-w-[740px] space-y-6">`) → `DialogPanelFooter` (sticky; `<Button variant="ghost">Cancel</Button>` + primary `<Button>Save</Button>`). On mobile this variant **automatically becomes a bottom-sheet** — no extra code. Read-only detail views may instead use `ui/FloatingDetailPanel`.
- **Center modals (`variant="dialog"`) are ONLY for confirmations / short alerts** ("Delete this?"), never for viewing or editing entities.
- **Fields = floating-label canon (filled, PALETTE-V2):** `FloatingField` (text/number/textarea), `FloatingSelect` (+ `SelectItem`), `PhoneInput` (phones). No stacked/side `<Label>` above fields. Fields are **filled** (`var(--blanc-field)` fill, transparent border, floated label INSIDE the fill) — the primitives do this themselves; never add call-site backgrounds/borders/label patches. Toggles/checkboxes use `Checkbox` and are NOT floated (label beside).
- **Buttons = one component, one scale (BUTTON-CANON, owner 2026-08-17).** Every button is `ui/button.tsx`; the call site chooses `variant` (default / secondary / outline / ghost / destructive) and `size` (`action` 44px for an entity card's next move, `default` 36px inside forms and toolbars, `sm`, `icon`) — and nothing else. **Never** hand-write `h-[52px]`, `text-[15px]` or `rounded-[15px]` on a `<Button>`: that is how eleven spellings of the same primary appeared across the finance surfaces. **Never `truncate` a label** — a shortened verb ("Mark appr…") is worse than a taller cluster; put the row in `flex flex-wrap` so a label that will not share a line takes one of its own at full width. The reference implementation is the job card.
- **Field rhythm:** groups separated by `space-y-6`; fields within a group `space-y-3.5`; short pairs `grid grid-cols-1 sm:grid-cols-2 gap-3.5`.
- **Close affordance** is built in (OverlayClose / OVERLAY-CLOSE-CANON) — don't hand-roll close buttons. `Escape`/backdrop handled by the shared overlay logic.
- **Tokens only** (see Design System below); never hardcode hex outside the `--blanc-*` set.

### Hierarchy & Composition

- **Entity name/title — always large** (`h2`, `text-2xl`, font `--blanc-font-heading`). This is the entry point — the eye catches it first.
- **Contact data (phone, email) is part of identity**, not a separate section. It goes in the header right under the name, with no "CONTACT INFORMATION" heading.
- **Technical IDs (contact_id, serial_id, zenbooker_id) — don't show.** Users don't need them. If a link to an external system is needed — use a small icon next to the name (e.g. "ZB") that opens in a new tab.
- **Only show data that exists.** No "Secondary Phone: —". No data — no row.

### Type scale — TYPE-CANON-001 (the level-two rule)

**Three sizes on a screen, not eleven.** `32px` the one number or name the screen exists for · `20px` a section heading (`.blanc-section-heading`) · `15px` **everything below one**. Full spec: `docs/specs/TYPE-CANON-001.md`.

- **Below a section heading nothing changes size.** Hierarchy there comes from exactly two signals:
  - **Weight** — `500` is the voice; `600` marks a group heading (Contact, Schedule, Location) and figures meant to be compared.
  - **Colour** — `--blanc-ink-3` names a thing, `--blanc-ink-1` answers it. `--blanc-warning` / `--blanc-success` appear only where they mean money owed or a credit; `--blanc-danger` only for failure.
- **Use the classes, don't retype the values:** `.blanc-l2` / `.blanc-l2-quiet` / `.blanc-l2-heading` (design-system.css), or `LEVEL_TWO` / `LEVEL_TWO_QUIET` / `LEVEL_TWO_HEADING` from `styles/levelTwo.ts` where the style is a React prop. A fresh `text-[13px]` or `fontSize: '12.5px'` at a call site is the exact bug this canon exists to prevent — `styles/typeScale.test.ts` is a ratchet that fails when the count grows.
- **No new uppercase eyebrows.** `.blanc-eyebrow` (11px tracked caps) is legacy; a group heading is `.blanc-l2-heading` — black and bold at body size.
- Reference implementation: the payment card (`components/payments/`, `JobInfoSections variant="flat"`).

### Section Separation

- **No horizontal lines (`<hr>`, `border-top`, `<Separator>`).** They look like noise and don't fit the clean neutral design system.
- **Sections are separated by spacing and layout**, not borders. If a section card is needed, use subtle background `rgba(25, 25, 25, 0.03)` (or `var(--blanc-surface-muted)` on white), border-radius 16px, padding 14-16px. But prefer flat layout when possible. **Containers are invisible** (LAYOUT-CANON rule 7): list/area wrappers carry no bg/border/radius/shadow — surface belongs to content tiles only.
- **Section headers** — `.blanc-eyebrow` (11px, uppercase, letter-spacing). Keep them to a minimum. If two sections can merge — merge them.

### Simplification

- **Related entities go in one list.** Leads and Jobs -> "Leads & Jobs". Don't multiply headers when content format is similar.
- **Section names must be literal and clear.** "Leads & Jobs", not "Activity". The user shouldn't have to think about what it means.
- **Fewer headers = less cognitive load.** If data is self-evident (a phone number looks like a phone number) — no header needed.

### Interactivity

- **Inline editing where possible.** Notes — textarea right in the card, saves on blur. Don't force opening a dialog for a single field.
- **Action buttons next to data.** Call/Timeline buttons — next to the phone number. Don't put them in separate blocks.

### Visual Balance

- **Two-column grid** — columns should be balanced by height and density. Don't stack 5 sections in one column and 1 in another.
- **Cards inside lists** — border `var(--blanc-line)`, border-radius `rounded-xl`. Hover: border slightly darker. No shadows.
- **Icon markers in lists** — small (3.5-4), color `var(--blanc-ink-3)`, no backgrounds/circles. Just the icon itself.

### What NOT to Do

- No decorative elements (avatar circles, icons for the sake of icons)
- No empty field states ("—", "N/A") — if empty, don't render the row
- No data duplication (ID in header and in card)
- No "designer-y" words in UI when direct ones exist ("Activity" -> "Leads & Jobs")
- No overloaded cards: emojis, unnecessary badges, small details that don't help make decisions

### Design System — Albusto PALETTE-V2

Source of truth: `frontend/src/styles/design-system.css` (`--blanc-*` are internal token names only — NEVER ship the word "Blanc" in UI; product is Albusto). Palette is a **neutral canvas, NOT warm cream** — it migrated off the old beige aesthetic; ignore the stale "warm beige" comment at the top of that file.

- Canvas: `--blanc-bg` #F1F1F0 (neutral light gray), `--blanc-bg-deep` #E8E8E6. Surfaces (white / frosted-glass): `--blanc-surface-strong` #FFFFFF, `--blanc-surface` rgba(255,255,255,.88), `--blanc-surface-muted` #F6F6F6.
- Text (neutral ink): `--blanc-ink-1` #191919, `--blanc-ink-2` #6E6E6E, `--blanc-ink-3` #8A8A8A.
- **Action color = the single violet accent: `--blanc-accent` #7F42E1** (all primary buttons/links). `--blanc-accent-soft` #E7DBFD (lavender — Action-Required plaques, soft highlights). Field fill: `--blanc-field` #F0F0F0.
- Borders: `--blanc-line` rgba(25,25,25,.08), `--blanc-line-strong` rgba(25,25,25,.20).
- Entity colors: job #2f63d8 · lead #b26a1d · task/success #1b8b63 · danger #F0503F.
- Radii: 10 / 16 / 22 / 28px. Fonts: IBM Plex Sans (body), Manrope (headings).
- Eyebrow label: `.blanc-eyebrow` (11px, uppercase, 0.14em letter-spacing, `--blanc-ink-3`)

### Visual QA & audit (check your frontend work)

Two skills own visual quality. **Before** handing off any new or changed screen, panel (шторка), sheet, form, or component, run **`design-qa`** (`.claude/skills/design-qa`) — the source-vs-render gate. When the user asks to **audit / review / critique / assess** an existing flow, run **`audit`** (`.claude/skills/audit`). This discipline holds even when you don't formally invoke the skill:

- **A screenshot is not QA by itself.** Put the source (mockup / a reference screen already in the app / this canon) and your render into **one comparison**, at the **same viewport, theme, and state**, then judge the visible differences. Don't judge a scaled screenshot — verify the capture is 1:1 at the intended size (`resize_window`).
- **Check five surfaces every time**, even if only one was named: type (TYPE-CANON 32/20/15), spacing/rhythm (FORM-CANON), colour/tokens (`--blanc-*` only — no raw hex), asset quality, copy.
- **Never fake a visible asset** with inline/hand-rolled SVG, CSS art, div/span shapes, emoji, or placeholder boxes — use a real asset measured to its slot (icon-library icons are fine).
- **Inside the existing product, find the similar screen + the design system first** and build on it — don't reinvent a hero/palette/type/spacing that already exists.
- Severity P0–P3; iterate (fix → re-capture the same state → compare) until no actionable P0/P1/P2 remains. Verdict is **passed** or **blocked** — never hand off a frontend change as done while a P0/P1/P2 stands.
