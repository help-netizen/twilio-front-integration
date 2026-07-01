# OVERLAY-CANON-002 — Overlay system consolidation + mobile-sheet canon + settings-page modernization

**Status:** ✅ COMPLETE — all 6 phases implemented, each independently adversarially-reviewed (APPROVED, 0 blockers) and build-green; mobile-sheet + settings-page changes preview-proven. Frontend-only, no backend/migrations. NOT yet committed/deployed (awaiting owner). Deferred non-blocking edges recorded in the review-follow-ups sections below.

Builds on OVERLAY-CLOSE-CANON-001 (`useOverlayDismiss` + `OverlayClose`) and SHEET-CANON-001 (`ui/BottomSheet`).

## Problem (from the 3-audit investigation)

1. **Two mobile-sheet mechanisms.** `dialog.tsx` renders bottom-pinned full-width on mobile via `max-md:` classes (30 of 33 dialogs inherit it) — but that is a *different* mechanism from the canonical `ui/BottomSheet` (no grab handle, no drag-dismiss, content-driven vs fixed height). "Modals become sheets" is true but **behavior is inconsistent**.
2. **Dropdowns don't become sheets.** ~36 raw Radix `Select` (11 files) / `DropdownMenu` (16) / `Popover` (9) sites still float as anchored popovers on mobile. Only ~6 pickers were hand-migrated (Snooze, AssignOwner, DateRange, Jobs/Leads filters, Command).
3. **5 duplicate overlay surfaces.** `Dialog` (centered + right-drawer), `BottomSheet`, `FloatingDetailPanel`, `AIAssistantModal`, `FullscreenImageViewer` each re-implement portal + backdrop + Esc + scroll-lock + focus.
4. **No stacking.** No overlay registry; z-index is ad-hoc (`z-50`…`z-[9999]`, no scale; `overlayLayout.ts` holds widths only). Stacked overlays collide (focus-trap escapes between layers, backdrop confusion).
5. **Three bespoke centered-column modals** on mobile: `AIAssistantModal`, `TwoFactorGate`, `UserGroupsPage` `Modal`. Plus 2 custom fixed popovers (`SlotContextMenu`, `OverflowPopover`).
6. **Old settings pages** render as a narrow centered column **on desktop** with hardcoded grays instead of Blanc tokens (`QuickMessagesPage` = `maxWidth:720 margin:auto` + `#111827`; `LeadFormSettingsPage` = bespoke `.lfsp-*` CSS; ~7 pages total: GoogleEmail, TechnicianPhotos, ActionRequired, Company, StripePayments, Vapi).

## Decisions (owner interview)

- **Stacking:** desktop = **card-stack** (lower layer offset-left + dimmed, top on top, tap-lower/Back to return); **mobile = simple z-cover** (top fully covers lower; closing top reveals lower — no offset).
- **Merge depth:** **shared core + thin variant wrappers** (not one mega-component). Public APIs of Dialog/BottomSheet/etc. stay stable.
- **Mobile pickers:** full canonical `BottomSheet` (grab handle, title, drag).
- **"Narrow centered column":** about **desktop**, primarily **old settings pages** → modernize to the full-width shell + Blanc tokens.

## Target architecture

One overlay foundation: an `OverlayStack` context (registry → depth → auto z-index + desktop card-stack transforms; mobile = cover) layered on the existing `useOverlayDismiss`; a **centralized z-index scale** in `overlayLayout.ts`; and the **mobile→sheet rule baked into the primitives** (dialogs + Select/DropdownMenu/Popover auto-render the canonical `BottomSheet` on mobile). Net: consistent behavior, "all modals + dropdowns → sheet on mobile" becomes a property of the components (few call-site edits), stacking works, 5 surfaces collapse to thin variants over one core.

## Phased plan

| Phase | Goal | Verification / gate |
|---|---|---|
| **0** | Foundation (invisible): z-index scale + `OverlayStack` context + `useOverlayDismiss` stacking-awareness | build green; single-overlay behavior + z-order unchanged |
| **1** | Merge 5 surfaces into shared core + thin variants; fix behavior gaps (AIAssistant focus-trap, viewer backdrop) | dev-preview each surface desktop+mobile |
| **2** | Mobile→sheet at the primitive level: `dialog.tsx` delegates to canon; `Select`/`DropdownMenu`/`Popover` → canonical sheet on mobile; fix 3 bespoke modals + 2 custom popovers | 390px: pickers open as sheets; desktop unchanged |
| **3** | Desktop card-stack transforms (offset/dim/peek); mobile cover | 2-3 stacked overlays desktop→pile, mobile→cover |
| **4** | Modernize ~7 old settings pages: narrow-centered → full-width shell + Blanc tokens | dev-preview each page desktop |
| **5** | Field dedup (FloatingField/FloatingSelect/PhoneInput → shared FloatingLabel); final audit + changelog + memory | build + review |

## Phase 0 — detailed spec (this checkpoint)

**Invariant: zero visible/behavioral regression for the single-overlay case** (99% of current usage). This phase only adds infrastructure and centralizes z-index.

### 0.1 z-index scale → `components/ui/overlayLayout.ts`
Add a named scale (values preserve the CURRENT z-order):
```ts
export const OVERLAY_Z = {
  panel: 80,      // FloatingDetailPanel (non-modal right card, desktop)
  modal: 140,     // Dialog, AIAssistantModal
  dropdown: 150,  // Select / Popover / DropdownMenu content (ABOVE modal by design — a Select inside a Dialog must pop above it)
  sheet: 200,     // BottomSheet panel
  lightbox: 1000, // Fullscreen viewers
} as const
export const OVERLAY_Z_BACKDROP = { panel: 0, modal: 140, dropdown: 0, sheet: 190, lightbox: 999 } as const
export const OVERLAY_CLOSE_Z = 141 // OverlayClose affordance, just above a modal panel
```
Migrate each site to reference the scale (keep Tailwind arbitrary values via a small helper or inline `style={{ zIndex: OVERLAY_Z.x }}` where a class can't be dynamic — Radix content uses className, so keep the `z-[150]` class but add a comment `/* OVERLAY_Z.dropdown */`, OR safelist; the implementer picks the least-churn faithful approach and documents it). Sites: `BottomSheet.tsx` 190/200, `dialog.tsx` 140 (×2), `OverlayClose.tsx` 141, `select.tsx`/`popover.tsx`/`dropdown-menu.tsx` 150, `FullscreenImageViewer.tsx` 9999→lightbox(1000), `AIAssistantModal.tsx` 50→modal(140) [**deliberate fix** — a modal was sitting below the detail panel; flag it], `FloatingDetailPanel.tsx` (locate its 80/120).

### 0.2 `OverlayStack` context → new `components/ui/OverlayStack.tsx`
- `OverlayStackProvider` — mount in `App.tsx` wrapping the routed app (inside providers).
- `useOverlayStack(id, open)` → registers/unregisters `id` on open/close; returns `{ depth, isTop, count }` (depth = index in open-order, isTop = last opened, count = total open).
- **Provider-optional & SSR-safe:** if no provider is present (isolated tests), the hook returns `{ depth: 0, isTop: true, count: 1 }` — never throws.
- Phase 0 tracks state only; **no visual transforms** (those are Phase 3).

### 0.3 `useOverlayDismiss` — stacking awareness
- Auto-register with `OverlayStack` while `open` (stable auto-generated id).
- **Esc: only the topmost overlay responds** (gate the keydown handler on `isTop`). Fixes: two stacked overlays no longer both close on one Esc.
- **Tab-trap: only the topmost traps** (gate `onKeyDown` Tab logic on `isTop`); focus capture-on-open stays per-overlay.
- Scroll-lock ref-counting: unchanged (already correct).
- **Backward-compat invariant:** single overlay → `isTop===true` always → behavior byte-identical to today.

### 0.4 Dead CSS
`.blanc-mobile-sheet` is already removed — only a stale *comment* at `design-system.css:933`. Optionally tidy the comment; no rule to delete.

### Acceptance (Phase 0)
- `npm run build` (strict tsc) green.
- Single overlay: Esc/backdrop/scroll-lock/focus identical to before.
- z-order unchanged (except the flagged AIAssistantModal 50→140).
- No `OverlayStackProvider`-missing crash (a component rendered outside the provider still works).
- No visual change anywhere.

### Phase 0 review follow-ups (fold into Phase 1/2 — not Phase 0 regressions)
- **Straggler z-index outside the scale:** `TwoFactorGate` (`zIndex:9999`), the AppLayout access-denied banner (`AppLayout.tsx:125`, 9999), and hardcoded confirm-modals at `zIndex:1000` (workflowInspectors, UserGroupsPage, CallFlowBuilderPage) now sit above/tie the lightbox tier (1000). No live collision today (none co-exist with the viewer), but Phase 1/2 should migrate these onto `OVERLAY_Z` so there's no 9999/1000 cliff.

## Phase 1 — detailed spec (shared core + thin variants)

New `components/ui/Overlay.tsx` core: `createPortal` + backdrop + `useOverlayDismiss` (Phase-0 stack-aware) + z from `OVERLAY_Z`/`OVERLAY_Z_BACKDROP` + variant positioning/animation.
```ts
type OverlayVariant = 'bottom-sheet' | 'right-drawer' | 'centered' | 'lightbox'
```
Variant → tier: `bottom-sheet`→sheet, `centered`→modal, `right-drawer`→modal (modal) / panel (non-modal), `lightbox`→lightbox. Defaults per variant (bottom-sheet: drag+grab-handle+scroll-lock+focus-trap; right-drawer non-modal: no scroll-lock/focus-trap; lightbox: no backdrop-close).

**The 4 hand-rolled surfaces become thin wrappers over the core, PUBLIC APIS + VISUALS/BEHAVIOR UNCHANGED (call sites untouched):**
- `BottomSheet` → `variant="bottom-sheet"` (keep fixed-height sizing, grab handle, drag).
- `FloatingDetailPanel` → `variant="right-drawer" modal={false}` (non-modal, panel tier, desktop no scroll-lock).
- `AIAssistantModal` → `variant="centered"` (+ **enable focus-trap** — the flagged fix).
- `FullscreenImageViewer` → `variant="lightbox"` (image controls stay in the wrapper).

**`Dialog` (dialog.tsx) stays on Radix** — a mature library foundation, not a hand-rolled dup; it already shares the z-scale + `OverlayClose`. Merging it into the custom core would forfeit Radix a11y/focus/nesting for 30 dialogs — out of scope. Its mobile→canonical-sheet delegation is Phase 2. (This is the faithful "thin variants" reading: the real duplication was the 4 hand-rolled surfaces.)

Gate: build green; dev-preview each of the 4 surfaces desktop + mobile — visuals/behavior identical to pre-Phase-1 (this is a refactor, not a redesign).

### Phase 3 review follow-ups (deferred polish — non-blocking, both edges verified non-regressions)
- **Mixed Radix/custom Esc double-close (latent, unreachable):** if a custom overlay (BottomSheet/FloatingDetailPanel/AIAssistantModal) ever opened OVER a Radix dialog on desktop, one Esc would close both (Radix listens capture-phase + gates only on its own layer stack; the `isTop` gate can't suppress it). Not reachable today (dialogs open over panels, not vice-versa; mobile has no Esc) and pre-dated Phase 3. If such a pairing is ever added, unify Esc through one owner.
- **Entry-animation snap (sub-0.24s cosmetic):** dialog-over-dialog opened mid-entry briefly shows the lower dialog's `blancSlideInRight` keyframe overriding the inline card-stack transform, then snaps. Detail-panel-behind-dialog is unaffected (opacity-only entry). Fix if desired by moving the card-stack transform to a WRAPPER element distinct from the animated node (NOT `animation-fill-mode`, which would freeze the keyframe).

## Out of scope / risks
- Radix `Dialog` keeps its own focus/Esc/layering; Phase 0 only centralizes its z-index and (later) wraps it. Do NOT double-handle Esc for Radix dialogs.
- Dropdown tier (150) intentionally ABOVE modal (140) — do not "fix" it.
- Backend, migrations, deploy: untouched. No RTL harness — verify via `npm run build` + dev-preview (390px + desktop; `VITE_FEATURE_AUTH_ENABLED!=='true'` bypasses Keycloak).
