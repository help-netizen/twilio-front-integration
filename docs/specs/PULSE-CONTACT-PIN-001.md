# PULSE-CONTACT-PIN-001 — pinned condensed contact bar in the Pulse timeline (OB-12)

## Problem

On a long thread the in-flow contact card scrolls away; with reverse pagination the
user lives in a permanent scroll, so identity and reach actions were effectively
unreachable (owner report, 2026-07-18).

## Behaviour

- The contact card LEFT the scroll flow. A condensed **bar** is pinned in one sticky
  stack with the Action Required plaque (`.pulse-sticky-stack`, top:0, z:5 — one
  wrapper; two sibling sticky elements would fight for top:0).
- Bar content: name; second line = address; **Call / Text / Email**; `Notes` (only
  when notes exist — the presence of the link IS the indicator); `Leads & Jobs N`;
  expand chevron.
- **Expansion opens the full `PulseContactPanel` as a canonical overlay panel**
  (bottom sheet on mobile). Overlay ⇒ zero height change in the scroll container ⇒
  reverse-pagination scroll compensation untouched.
- Lead threads, the new-lead wizard and the Anonymous timeline keep their existing
  in-flow cards; the bar applies to the contact branch only.

## Owner decisions (2026-07-19)

| Fork | Decision | Consequence implemented |
|---|---|---|
| Leads & Jobs count | **Open only** | Bar and panel share `isOpenLead`/`isOpenJob` (contactBarHelpers); the panel's "Only Open" toggle defaults ON, and it now filters JOBS too (historically leads only). |
| Bar address | **Freshest job/lead** | Leads carry no address in this model ⇒ freshest job with an address wins; fallbacks: contact default address → first address → company name → nothing. |
| Email without mailbox | Button visible | Click → toast with a Connect action → `/settings/integrations/google-email`. |
| Primary action | Call (violet) | No phone ⇒ the first reachable channel promotes (email-only contact gets violet Email). |

## Mechanics

- `usePulsePage` now fetches the contact's jobs once (shared by bar count/address and
  the panel via a new `jobs` prop; the panel self-fetches only when the prop is absent
  — other hosts unaffected) and exposes `messageTargets`.
- Text/Email set the composer target (`setSelectedTarget`) and bump a `focusSignal`
  (new optional `SmsForm` prop): `textarea.focus()` scrolls it into view natively, so
  the timeline scroll logic is untouched. Call reuses `ClickToCallButton` (softphone
  on desktop, `tel:` on mobile) restyled as the primary action.
- `Notes` / `Leads & Jobs` open the panel scrolled to that section (`focusSection`).
- Degradation ladder is a **container query on the bar** (desktop only; the timeline
  column is narrow beside the conversation list even on wide monitors): labels →
  icons at 640px; address line drops at 440px; the name never truncates before the
  labels do. Mobile keeps labels in a stacked grid (approved mockup).

## Tenancy & Roles (per TENANCY-RBAC-CANON)

| Surface | Change | Tenancy |
|---|---|---|
| Backend | **None** — bar derives from existing `getContact` + `listJobs` responses | Existing routes' scoping unchanged |
| New endpoints | None | — |
| New queries | None | — |

## Verification

- vitest 207/207 (11 new: predicates, address fallbacks, notes presence, sticky-stack
  and overlay wiring contracts); build (tsc -b) exit 0.
- Sabotage: dropped the panel's `isOpenJob` filter → contract test red; restored → green.
- Live dev-server checks: bar renders for a contact thread; violet Call with grey
  Text/Email; email-only contact promotes Email to violet; Text focuses the composer;
  Email switches the composer channel and keeps focus; disconnected mailbox → connect
  toast; expansion opens the panel with "Only Open" ON; mobile 375px = stacked labelled
  grid, no overflow; desktop bar 624px = icon-only with the name intact; sticky stack
  computed `sticky/0/5`.

Mockup (approved during review): `docs/mockups/PULSE-CONTACT-PIN-001.html`.
