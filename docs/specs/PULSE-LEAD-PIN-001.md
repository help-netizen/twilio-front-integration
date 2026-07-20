# PULSE-LEAD-PIN-001 — pinned condensed Lead bar in Pulse

Status: Implemented (frontend only)

Owner-approved mockup: `docs/mockups/PULSE-LEAD-PIN-001.html`

Precedent: `PULSE-CONTACT-PIN-001` / OB-12

## Problem

The Lead branch rendered `LeadDetailPanel` as a fixed-height card inside the Pulse
timeline. On a long thread it scrolled away, taking the Lead identity and workflow
actions with it. Expanding an in-flow replacement would also change the scroll
container height and risk reverse-pagination compensation.

## Requirements

- **FR-LP-01 — one sticky stack.** The Lead bar and Action Required plaque live in
  the existing `.pulse-sticky-stack`; Contact and Lead must not create independent
  sticky elements.
- **FR-LP-02 — exact desktop geometry.** The Lead bar is 68px tall and uses the
  Contact bar's shell padding, radius, gaps, 40px action controls, 13px action
  radius, and 15px icons. Its left rail is `--blanc-info`.
- **FR-LP-03 — identity.** Render `LEAD #<SerialId> · <JobType>` on the kicker,
  with Job Type grey and normal case. The name is the entity title. No separate
  fact/address line is added.
- **FR-LP-04 — status is state.** Status appears inline after the name as a 26px
  full pill (`border-radius:999px`) with per-status tint and a leading dot. It is
  DB-FSM-driven and calls the existing Pulse status handler. The full
  `LeadDetailPanel` header uses the same state-pill at its normal 42px height.
- **FR-LP-05 — actions.** The collapsed bar mirrors the panel action set: Edit,
  Convert to Job when eligible, the existing overflow menu (Mark Lost when
  eligible and Delete Lead), and Activate for the existing lost-lead state.
  Expand is separate. Source remains full-panel-only. No Call/Text/Email controls
  are added to the Lead bar.
- **FR-LP-06 — overlay expansion.** The Lead detail card leaves the timeline flow.
  Expand opens the existing `LeadDetailPanel` in `DialogContent variant="panel"`;
  the canonical Dialog supplies desktop focus/dismiss and the mobile bottom sheet.
  Opening/closing changes no timeline scroll-container height.
- **FR-LP-07 — responsive ladder.** A single desktop-only container-query ladder
  is shared with Contact: action labels collapse at 640px; secondary identity
  detail drops at 440px; identity truncates only after action labels are gone.
  Mobile uses a stacked grid and retains action labels.
- **FR-LP-08 — accessibility.** Every action that can become icon-only has a stable
  `aria-label`; status reports its current value; expand and overflow have explicit
  names. Radix owns keyboard navigation and dismissal for both dropdowns and panel.

## Implementation seams

- `PulsePinnedBar`, `PulsePinnedBarAction`, and `PulsePinnedBarExpand` own the shared
  Contact/Lead shell and action chrome. Entity identity and grid tracks remain in
  `PulseContactBar` and `PulseLeadBar`.
- `LeadStatusDropdown` is the single DB-driven status control used by the collapsed
  bar and the full panel header. `leadStatusStyles` remains the status palette.
- `LeadActionButtons` owns the existing action eligibility and overflow contents,
  rendering either bar or footer chrome. This prevents collapsed and expanded
  actions from drifting.
- `PulsePage` owns `leadCardOpen`, closes it when the selected lead/timeline changes,
  mounts `PulseLeadBar` inside the existing sticky stack, and mounts exactly one full
  `LeadDetailPanel` inside the overlay.

## Scope, tenancy, and integrations

Frontend only. No endpoint, query, schema, permission, tenancy, or integration
behavior changed. The implementation calls only the handlers already exposed by
`usePulsePage`; Source retains its existing `lead_source.view` gate.

## Verification

- `env -u NODE_USE_SYSTEM_CA npm run build` (from `frontend`) — exit 0
  (`tsc -b` + Vite production build; only the repository's existing chunk warnings).
- `env -u NODE_USE_SYSTEM_CA npm test` (from `frontend`) — 43 files,
  248/248 tests passed.
- Targeted contract suite: `PulseLeadBar.test.ts` — 12/12 green.
- Named sabotage **SAB-LEAD-STICKY-MEMBERSHIP**: temporarily replaced the Lead-bar
  mount inside `.pulse-sticky-stack`; the sticky membership contract turned red
  (1 failed / 11 passed), then the exact mount was restored and the suite returned
  to 12/12 green.

## Out of scope

- No Lead phone/reach actions.
- No Source chip in the collapsed bar.
- No backend changes and no change to the existing Delete callback semantics.
- No redesign of the full `LeadDetailPanel` beyond the required shared status pill
  and mechanically shared action renderer.
