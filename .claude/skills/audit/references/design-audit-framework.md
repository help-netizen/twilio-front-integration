# Design Audit Framework

Structure for `audit` — systematic assessment across an experience, not feedback on a single artifact. If the request is a single screen / component / modal, keep the audit scoped to that surface.

## Modes

- UX audit · Accessibility audit · Combined audit

## UX audit lenses

- Task entry and discoverability
- Information architecture
- Interaction flow and friction
- Hierarchy and clarity (does the eye catch the one thing the screen exists for — the 32px name/number?)
- Trust and reassurance
- Default states and empty states (Albusto: no empty `—`/`N/A` rows — absence should mean the row is gone, not blank)
- Copy and calls to action (literal, English, no "designer-y" words when a direct one exists)
- Consistency across the experience (tokens, canon, the right-side-panel interaction model)

## Accessibility audit lenses

- Perceivable content and contrast risks (check both light and dark themes)
- Semantic structure and reading order
- Keyboard access and focus behavior
- Target size and interaction affordances (real mobile tap sizes)
- Labels, instructions, and error recovery
- Motion, timing, and state-change communication (respect reduced-motion)
- Responsive reflow and zoom resilience
- Assistive-technology clarity and robustness

## Output structure

**UX audit:** Audit scope · User goal · Strengths · Notable risks · Opportunity areas · Optional comparison context · Recommendations.

**Accessibility audit:** Audit scope · Accessibility target · Confirmed strengths · Likely issues · WCAG-relevant considerations · Evidence limits and verification gaps · Recommendations.

**Combined audit:** Audit scope · User goal + accessibility target · Strengths · UX risks · Accessibility risks · Opportunity areas · Evidence limits and verification gaps · Recommendations.

## Guardrails

- Focus on experience patterns, not business strategy.
- Keep comparator products optional; use them only when they sharpen the audit.
- Separate structural issues from polish issues.
- Tie every recommendation back to the user goal, workflow, or accessibility outcome.
- Do not imply full WCAG compliance without the implementation detail to support the claim.
- Anchor design findings in the Albusto canon (CLAUDE.md, `docs/specs/*`, `design-system.css`): token drift, TYPE-CANON (32/20/15), invisible containers, no `<hr>`/separators, real-assets-only, mobile nav/sheet/keyboard canons.
