# JOB-ESTIMATE-MULTI — allow more than one estimate per job (UI parity with invoices)

**Type:** bug-fix (UI parity) · **Area:** frontend only · **Backend:** no change needed.

## Problem
On the Job card → Finance tab, the **Estimate** section ("Customer-facing repair
proposal for this job.") only exposes a **Create estimate** button in its EMPTY state
(`estimates.length === 0`). Once one estimate exists, the section just lists estimates
with **no affordance to add another**. The sibling **Invoices & payments** section, by
contrast, shows a **persistent "New invoice"** button in its section header whenever
`invoices.length > 0`. Users need to create multiple estimates on one job, exactly like
invoices.

## Root cause
Purely presentational. The data model already supports many estimates per job
(`estimates` is an array rendered with `.map`; the editor creates a NEW estimate via
`setEditingEstimate(null); setShowEstimateEditor(true)`). Only the persistent header
button is missing from the Estimates section.

## Change (single file: `frontend/src/components/jobs/JobFinancialsTab.tsx`)
In the **Estimate** `<section>` header (the `flex items-start justify-between … px-4 py-3`
row that holds the "Estimate" title + description), add a persistent **"New estimate"**
button on the right, shown only when `estimates.length > 0`, **mirroring the Invoices
header button** (the `invoices.length > 0 && <Button variant="outline" size="sm" …>New
invoice</Button>` block):

```tsx
{estimates.length > 0 && (
    <Button variant="outline" size="sm" onClick={() => { setEditingEstimate(null); setShowEstimateEditor(true); }}>
        <Plus className="mr-1 size-4" />New estimate
    </Button>
)}
```

- Same `onClick` as the existing empty-state **Create estimate** button (open the editor
  for a brand-new estimate).
- Same styling/label convention as **New invoice** (`variant="outline"`, `size="sm"`,
  `<Plus className="mr-1 size-4" />`).

## Out of scope / do NOT touch
- The empty-state "Create estimate" button (unchanged).
- The Invoices section (unchanged).
- Any backend, API, migration, estimate-editor internals.

## Acceptance criteria
1. With ≥1 estimate on the job, a **New estimate** button appears in the Estimate section
   header (top-right), visually matching the invoices **New invoice** button.
2. Clicking it opens the estimate editor for a **new** estimate (`editingEstimate === null`,
   `showEstimateEditor === true`).
3. With 0 estimates, behaviour is unchanged (empty-state card + its Create estimate button).
4. The Invoices section is byte-unchanged.

## Verify
- `cd frontend && npm run build` (tsc -b clean — prod build is strict on unused/any).
- If a JobFinancialsTab render test/harness exists, add/extend it to assert the header
  button renders when `estimates.length > 0` and is absent at 0; otherwise no jest is
  required (presentational parity change) — state which.
