# Project Instructions

## UI Design Principles

### Philosophy

**Every element must justify its presence.** If it doesn't help the user complete a task — remove it. Don't decorate — design.

### Layers & overlays — THE canonical pattern (always use this)

**Every entity view/edit surface is a right-side slide-over "layer" (шторка), never a center modal.** This is the app's core interaction model — job view, lead card, estimate/invoice editors, forms all slide in from the right. New UIs MUST follow it. Full spec: `docs/specs/FORM-CANON.md`. Gold-standard examples: `EstimateItemDialog.tsx`, `NewJobModal.tsx`, `TaskFormDialog.tsx`.

- **Component:** `<Dialog><DialogContent variant="panel">` with `DialogPanelHeader` (pinned title) → `DialogBody className="md:px-8 md:py-7"` (scrollable; inner `<div className="mx-auto w-full max-w-[740px] space-y-6">`) → `DialogPanelFooter` (sticky; `<Button variant="ghost">Cancel</Button>` + primary `<Button>Save</Button>`). On mobile this variant **automatically becomes a bottom-sheet** — no extra code. Read-only detail views may instead use `ui/FloatingDetailPanel`.
- **Center modals (`variant="dialog"`) are ONLY for confirmations / short alerts** ("Delete this?"), never for viewing or editing entities.
- **Fields = floating-label canon:** `FloatingField` (text/number/textarea), `FloatingSelect` (+ `SelectItem`), `PhoneInput` (phones). No stacked/side `<Label>` above fields; fields are border-only on the panel surface. Toggles/checkboxes use `Checkbox` and are NOT floated (label beside).
- **Field rhythm:** groups separated by `space-y-6`; fields within a group `space-y-3.5`; short pairs `grid grid-cols-1 sm:grid-cols-2 gap-3.5`.
- **Close affordance** is built in (OverlayClose / OVERLAY-CLOSE-CANON) — don't hand-roll close buttons. `Escape`/backdrop handled by the shared overlay logic.
- **Tokens only** (see Design System below); never hardcode hex outside the `--blanc-*` set.

### Hierarchy & Composition

- **Entity name/title — always large** (`h2`, `text-2xl`, font `--blanc-font-heading`). This is the entry point — the eye catches it first.
- **Contact data (phone, email) is part of identity**, not a separate section. It goes in the header right under the name, with no "CONTACT INFORMATION" heading.
- **Technical IDs (contact_id, serial_id, zenbooker_id) — don't show.** Users don't need them. If a link to an external system is needed — use a small icon next to the name (e.g. "ZB") that opens in a new tab.
- **Only show data that exists.** No "Secondary Phone: —". No data — no row.

### Section Separation

- **No horizontal lines (`<hr>`, `border-top`, `<Separator>`).** They look like noise and don't fit the warm design system.
- **Sections are separated by spacing and layout**, not borders. If a section card is needed, use subtle background `rgba(117, 106, 89, 0.04)`, border-radius 16px, padding 14-16px. But prefer flat layout when possible.
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

### Design System (Blanc)

- Backgrounds: `--blanc-bg`, `--blanc-surface-strong` (#fffdf9)
- Text: `--blanc-ink-1` (primary), `--blanc-ink-2` (secondary), `--blanc-ink-3` (hints)
- Borders: `--blanc-line` (rgba 117,106,89 / 0.18)
- Radii: 10 / 16 / 22 / 28px
- Fonts: IBM Plex Sans (body), Manrope (headings)
- Eyebrow label: `.blanc-eyebrow` (11px, uppercase, 0.14em letter-spacing, `--blanc-ink-3`)
