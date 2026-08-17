# QA Rubric — design → implementation

Use this for a thorough design-QA pass. It is tool-agnostic; map every check to the Albusto canon (`CLAUDE.md`, `docs/specs/*`, `design-system.css`).

## Fidelity checklist

- **Layout** — frame size, alignment, content order, grouping, card radius (10/16/22/28), elevation, borders. LAYOUT-CANON: containers are invisible (list/area wrappers carry no bg/border/radius/shadow — surface belongs to content tiles).
- **Spacing** — page margins, section gaps, item gaps, padding, tap-target spacing, vertical rhythm. FORM-CANON rhythm: `space-y-6` between groups, `space-y-3.5` within, short pairs `grid ... gap-3.5`. Flag cramped text, collapsed sections, density drift.
- **Typography** — family, weight, size, line-height, letter-spacing, wrapping, truncation, hierarchy. TYPE-CANON-001: **32 / 20 / 15 only**; below a section heading, differentiate by weight (500 body voice, 600 group heading / compared figures) and colour (`--blanc-ink-1` answers, `--blanc-ink-3` names), never by a new size. A fresh `text-[13px]` / `fontSize:'12.5px'` at a call site is a finding (the `typeScale.test.ts` ratchet guards this).
- **Colour** — token mapping (every colour a `--blanc-*`; no raw hex outside the token set), accent `#7F42E1`, `--blanc-accent-soft` for Action-Required, entity colours (job `#2f63d8`, lead `#b26a1d`, task/success `#1b8b63`, danger `#F0503F`), warning/success only where they mean money owed / credit, danger only for failure. Contrast holds in **both** light and dark.
- **Imagery** — every target asset is accounted for and matches subject, crop, aspect, sharpness, background treatment. Real assets only.
- **Icons** — all present, matching stroke weight, size, style family, alignment; small and quiet in lists (size 3.5–4, `--blanc-ink-3`, no backgrounds/circles per LAYOUT-CANON).
- **Surfaces** — rounded cards, borders, dividers, shadows, fills match the target rather than generic component defaults. **No `<hr>` / `border-top` / `<Separator>`** — sections separate by spacing (Section-Separation canon).
- **Responsiveness** — no overlap, clipping, collapsing into adjacent sections, awkward wrapping, or broken hierarchy across mobile / tablet / desktop. Mobile respects the nav canon (no top header; 5 primary + More) and sheet/keyboard canons.
- **Implementation shortcuts** — flag custom CSS art, inline/hand-rolled SVG substitutes, placeholder avatars, decorative blobs, fake product imagery, dummy `—`/`N/A` rows.

## Mandatory passes (don't rely on "looks close")

- **Fonts** — identify mismatched family/fallback, weight, scale, line-height, letter-spacing, hierarchy, cramped text, display-vs-body optical treatment. Look carefully; use focused-region zoom for weight differences.
- **Spacing & layout** — compare frame/crop, alignment, margins, padding, gaps, sizes, radii, elevation, borders, vertical rhythm; cite where drift changes hierarchy, density, readability, or causes collisions.
- **Viewport resilience** — mobile / tablet / desktop widths for overlap, clipping, collapsing sections, broken grids, awkward wrapping, controls that become unusable.
- **Colour & tokens** — palette, opacity, shadows, contrast, semantic/disabled/active states, and whether implementation maps to `--blanc-*` intent (not raw hex).
- **Asset fidelity** — subject match, crop, scale, aspect, sharpness, transparency/masking, background integration. Div/CSS art or hand-rolled SVG replacing a real asset is banned.
- **Copy** — app copy (not dynamic content) is coherent, English, literal, stands alone.
- **Icons** — zoom in; all visible and interaction-hidden icons implemented, aligned, consistent.
- **States & interactions** — hover, focus, active, selected, disabled, loading, success, error, empty, and any control the core experience needs.
- **AI-shortcut artifacts** — generic rounded cards, unnecessary borders, decorative CSS blobs, fake SVG illustrations, half-built avatars, mismatched hero art, emoji-as-asset.

## Accessibility

Contrast, focus indicators, keyboard reachability, semantic controls, labels, tap targets at real mobile sizes, layout stability when text wraps / scales / holds longer real-world strings, reduced-motion.

## What makes a finding useful

One specific mismatch · evidence from **both** source and render · user/fidelity impact · a concrete fix (token / class / component / CSS) · severity by user impact, not taste · the affected surface named.

Avoid: vague "make it more polished"; treating every pixel diff as a bug when intent is preserved; criticizing known placeholder content unless it affects the goal; bundling unrelated flaws into one finding.
