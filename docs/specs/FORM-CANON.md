# Blanc Form Canon — migration spec (MODAL-REDESIGN-001)

Gold-standard reference: **`frontend/src/components/jobs/NewJobDialog.tsx`** — read it before editing.

Goal: every form dialog becomes a right-side **panel drawer** with a white surface and
**floating-label** fields. Presentation/layout only — never change business logic, state,
validation, props, or API calls.

> **PALETTE-V2 (W2, 2026-07-02):** поля переведены на **filled-канон** — заливка
> `var(--blanc-field)` (#F0F0F0), бордер transparent, floated-лейбл живёт ВНУТРИ заливки
> (top ~6px, `--blanc-ink-3`), фокус = бордер `--blanc-line-strong`. Это уже зашито в
> примитивы (`floating-field`, `floating-select`, `PhoneInput`, `input`, `textarea`,
> `select`) — при миграции форм просто используй примитивы, ничего не докрашивая.
> Правило 9 ниже обновлено соответственно. См. `docs/specs/PALETTE-V2.md`.

## Shared components (already built — DO NOT modify them; just import)
- `../ui/dialog`: `DialogContent` (use `variant="panel"`), `DialogPanelHeader`, `DialogBody`,
  `DialogPanelFooter`, `DialogTitle`, `DialogDescription`.
- `../ui/floating-field`: `FloatingField` (text/email/textarea), `FloatingLabel` (generic wrapper).
- `../ui/floating-select`: `FloatingSelect` (selects).
- `../ui/PhoneInput`: `PhoneInput` — pass `label="Phone"` for floating mode.
- `../ui/button`: `Button`.

`FloatingField` props: `label`, `id`, `value`, `onChange`, `type?`, `textarea?`, `rows?`,
`inputMode?`, `disabled?`, `className?`.
`FloatingSelect` props: `label`, `value`, `onValueChange`, `id?`, children = `<SelectItem>` from `../ui/select`.

## Structure (match NewJobDialog exactly)
```tsx
<Dialog open={open} onOpenChange={...}>
  <DialogContent variant="panel">
    <DialogPanelHeader>
      <DialogTitle className="text-[22px] font-semibold leading-tight"
        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}>
        {Title}
      </DialogTitle>
      <DialogDescription className="sr-only">{short purpose}</DialogDescription>
    </DialogPanelHeader>

    <DialogBody className="md:px-8 md:py-7">
      <div className="mx-auto w-full max-w-[740px] space-y-6">
        {/* groups separated by space-y-6; fields within a group: space-y-3.5 */}
      </div>
    </DialogBody>

    <DialogPanelFooter>
      <Button variant="ghost" onClick={close}>Cancel</Button>
      <Button onClick={save} disabled={...}>{Primary}</Button>
    </DialogPanelFooter>
  </DialogContent>
</Dialog>
```

## Field rules
1. Text / email → `<FloatingField label="Name" id="x-name" value={v} onChange={e=>set(e.target.value)} />`.
   The label REPLACES the old `<Label>` and the placeholder. Delete old `<Label>` elements.
2. Textarea → `<FloatingField textarea rows={3} label="Notes" ... />`.
3. Select → `<FloatingSelect label="Status" value={v} onValueChange={set}><SelectItem .../></FloatingSelect>`.
4. Phone → `<PhoneInput label="Phone" value={v} onChange={set} id="x-phone" />`.
5. Money/amount → `<FloatingField label="Amount" inputMode="decimal" value={v} onChange={...} />`
   (keep the existing numeric parsing/formatting in the handler).
6. Pair short related fields in one row: `<div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5"> ... </div>`
   (e.g. First/Last name). Three-up (City/State/Zip) → `grid-cols-[2fr_104px_1fr]`.
7. **Do NOT floating-ize** (keep as labeled controls, but make sure they have NO custom bg —
   they sit on the near-white panel): switches/toggles, checkboxes, color pickers, date/time
   pickers, day-of-week button sets, Stripe Payment Element, async roster selectors.
   For these, keep a concise label (`<Label>` or `.blanc-eyebrow`) beside/above the control.
8. Remove redundant block-heading eyebrows; rely on spacing. Keep a heading only if a section
   genuinely needs a name.
9. Never set a field background color at call-sites. Fields are **filled** by the primitives
   themselves (`var(--blanc-field)` fill, transparent border, label inside the fill) — do not
   add your own backgrounds, borders or label patches on top.
10. If the file was already migrated to `variant="panel"` with old `DialogHeader`/`DialogFooter`
    + stacked `<Label>`s, replace that structure with the canon above.

## Don'ts
- Don't touch the shared components listed above.
- Don't change validation, gating, submit logic, API calls, or state shape.
- Don't introduce new dependencies.
- Remove now-unused imports (`Label`, `Input`, `Textarea`, etc.) — the prod build uses
  `noUnusedLocals`, so leftover unused imports fail the build.

## Done criteria
- The form renders as a right-side near-white panel with floating-label fields.
- No leftover stacked `<Label>` above inputs (except the kept non-floating controls).
- No unused imports.
