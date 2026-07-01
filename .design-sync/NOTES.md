# Albusto Design System — sync notes (durable; read before any re-sync)

Product name is **Albusto**. Internal tokens/classes are `--blanc-*` / `.blanc-*` (legacy name) —
they stay internal; never surface "Blanc" in anything user-facing.

## Shape & config
- **Package shape** (no Storybook). Components = PascalCase exports of the frontend UI kit,
  exposed on `window.AlbustoUI`. `globalName: AlbustoUI`, `pkg: albusto-ui`, `srcDir: src/components/ui`.
- **83 components** discovered from the compiled bundle; **15 authored previews** (below), the rest ship the
  honest floor card (intentional — see "Floor cards").
- **CSS is prebuilt, not compiled by the converter.** `cssEntry: dist/albusto-ds.css` is the app's already-compiled
  Tailwind v4 + Blanc stylesheet (~213 KB). `styles.css` `@import`s it, so every rendered design gets the real tokens/fonts.

## Environment setup (worktree-specific; all gitignored, recreate per run)
This run built from a git **worktree** that SHARES `node_modules` with the main repo. To make the package
shape resolve, these were created (all in `.gitignore`, so a fresh clone must recreate them):
1. `frontend/node_modules/albusto-ui` → symlink to `..` (so `PKG_DIR` resolves to the frontend package).
   Because node_modules is shared, this actually resolves to the MAIN repo's `frontend/`.
2. `frontend/dist/albusto-ds.css` — the compiled app CSS, copied to BOTH the worktree and the MAIN repo
   `frontend/dist/` (PKG_DIR resolves to MAIN). Regenerate with the app's normal CSS build if it drifts.
3. `frontend/index.d.ts` — empty stub so the types scan finds a file instead of crashing.
Build/validate/capture invocation (from the worktree root):
```
node .ds-sync/package-build.mjs   --config .design-sync/config.json --node-modules frontend/node_modules --out ./ds-bundle
node .ds-sync/package-validate.mjs ./ds-bundle
node .ds-sync/package-capture.mjs --out ./ds-bundle [--components A,B]
```
**Re-sync risk — `config.json.tsconfig` is an ABSOLUTE path into this worktree.** It MUST be absolute *here*:
because node_modules is shared, `PKG_DIR`/workspaceRoot resolve to the MAIN repo, so a path relative to the
config (`.design-sync/tsconfig.paths.json`) is looked up under the main repo and "not found" → `@/lib/utils`
fails to resolve and the whole bundle errors (verified). On a **normal single checkout** (not a worktree),
workspaceRoot == the repo root, so a repo-root-relative path works — repoint it then. The tsconfig itself is
portable: `baseUrl: ../frontend`, `paths: {"@/*": ["./src/*"]}` (relative to its own location), for `@/lib/utils`.

## Preview authoring contract (proven — 15/15 authored, every cell graded good)
- `.design-sync/previews/<Name>.tsx`, one per component, **markerless**. Named exports = graded cells,
  each a **function component** returning JSX: `export const Variants = () => (<…/>);` (PascalCase; 2–6/file).
  The html mount only renders `/^[A-Z]/` **function** exports (`React.createElement(export)`), NOT bare elements.
- Import from the package root: `import { Button, Card, TableCell } from 'albusto-ui';` — the compiler redirects
  the specifier to `window.AlbustoUI` at build. `@/lib/utils` also resolves.
- JSX is automatic — **do NOT `import React`** (the `React.CSSProperties` type is still ambient for inline-style typing).
- Tokens resolve in previews: `style={{ color: 'var(--blanc-ink-3)' }}` (ink-1 primary / ink-2 secondary / ink-3 hint).
- Icons: tiny inline `<svg viewBox="0 0 24 24" …>` — do NOT import lucide (keeps the preview bundle self-contained;
  lands correctly in the `[&_svg]:size-4` slot).
- Content = real Albusto domain, never foo/bar: jobs + statuses (New/Scheduled/In progress/Done), customers
  (Kathy DeCecco), providers (Marcus Bell, Dana Ruiz), estimates/invoices (#1042), addresses (18 Maple St, Newton).
- **Secondary button is intentionally pale** (soft-blue `--blanc-job-soft`) — the token, not a render bug.

## Radix overlays render statically IN-CARD (no cardMode override needed here)
Open them by default and the capture shows the portal inside the card:
- Select/DropdownMenu/Dialog/Popover: `defaultOpen`.  Tooltip: wrap in `<TooltipProvider>` + `<Tooltip defaultOpen>`.
- Capture **isolates each cell** — a portal's `fixed inset-0` scrim is confined to its own row, does not bleed to
  siblings. Multiple open-portal cells per file are safe (Dialog file has two independent open dialogs).
- **Gotcha:** Radix sub-primitives (`DialogTitle/Description/Header/Footer`, and by analogy other `*Primitive.*`
  wrappers) render **blank outside their Root**. A "static chrome" fallback must use plain `<h2>/<p>/<div>`,
  or just author a second `defaultOpen` root. (First Dialog fallback captured blank until re-authored as a real Dialog.)
- The generated `<Name>.d.ts` only declares the root export with permissive `[key: string]: unknown` props;
  sub-export names (TabsList, TableCell, DialogFooter…) come from the real source `frontend/src/components/ui/<name>.tsx`.
  The package root re-exports every named symbol, so importing sub-parts from `'albusto-ui'` resolves fine.

## Authored previews (15) — all cells graded `good`
Solo: **Button** (Variants/Sizes/WithIcon/Disabled), **Card** (JobCard/Notice), **Select** (Field/Open/Placeholder).
Batch A (forms): **Badge** (Variants/JobStatuses/InContext), **Input** (Field/States/Disabled),
**Textarea** (NoteField/States), **Checkbox** (LabeledRow/States/Disabled), **Switch** (LabeledRow/States/Disabled),
**Separator** (Horizontal/Vertical).
Batch B (compound/overlay): **Tabs** (JobPanel/FinanceSplit), **Table** (JobsTable/EstimateItems),
**Skeleton** (JobCardLoading/ListLoading), **Tooltip** (OnProvider/StatusHint/Trigger),
**DropdownMenu** (JobActions/Trigger), **Dialog** (CancelJob/Confirmation).

## Floor cards (the deliberate baseline — NOT failures)
~26 unauthored components ship the typographic floor card. They are either **structural sub-parts already shown
compositionally inside their parent's authored card** — Card*/Table*/Dialog*/DropdownMenu*/Select* parts —
or **headless roots** with no standalone static render: Collapsible, Command, CommandShortcut, ScrollArea,
Toaster, Label (Label is also composed inside Input/Checkbox/Select previews). Authorable incrementally on any re-sync.

## Known render warns (triaged legitimate — a re-sync flags any warn NOT listed here as new)
- `[FONT_REMOTE]` "IBM Plex Sans", "Manrope", "source-code-pro" — a remote font `@import` is present; assumed served at runtime.
- `[RENDER_BLANK]` on the ~26 floor-card components above — expected; they are unauthored, not broken.
