---
name: frontend-design
description: Distinctive, intentional visual design for Albusto's BRAND and greenfield surfaces — the marketing site (albusto.com), landing / campaign pages, marketplace & onboarding hero moments, brand & email assets, standalone artifacts and prototypes. Use when the surface is public-facing or greenfield and wants a memorable identity. NOT for the CRM product UI: inside the app shell the project canon (CLAUDE.md, TYPE/FORM/LAYOUT-CANON, design-qa) governs — defer to it.
license: Apache-2.0 — adapted from Anthropic's frontend-design skill; see LICENSE.txt
---

# Frontend Design — Albusto brand & greenfield surfaces

*Adapted for Albusto from Anthropic's `frontend-design` skill (Apache-2.0). The craft below is theirs; the scope and brand grounding are Albusto's.*

Approach a brand surface as the design lead at a small studio: this client rejected templated proposals and is paying for a point of view. Make deliberate, opinionated choices about palette, typography, and layout specific to the brief, and take one real aesthetic risk you can justify.

## Where this applies — read first

Albusto has two design worlds that want opposite things:

- **CRM product UI** — anything inside the authenticated app shell (jobs, leads, schedule, Pulse, estimates/invoices, payments, settings, the native mobile app). Here the **project canon wins, not this skill**: `CLAUDE.md` UI Design Principles + `docs/specs/` (TYPE-CANON 32/20/15, FORM-CANON right-side panels + floating fields, LAYOUT-CANON invisible containers, PALETTE-V2 `--blanc-*` tokens) + the `design-qa` gate before handoff. It is deliberately quiet: neutral canvas, one violet accent, no decoration, every element justifies its presence. Do **not** bring this skill's "take a risk / characterful display face / signature flourish" ethos here — it is the opposite of the canon.
- **Brand / greenfield surfaces** — the marketing site (albusto.com), landing & campaign pages, marketplace/onboarding hero moments, brand & email assets, standalone artifacts and prototypes. **This is where this skill applies**, and where a memorable identity is the point.

Unsure which world? Is it inside the logged-in CRM? → canon. Is it a public/brand/greenfield page? → this skill.

## Ground it in Albusto, not a blank page

Distinctive ≠ inventing a new brand. Start from what Albusto already is:

- **Accent:** violet `#7F42E1` is the through-line (`albusto-brand-assets`, `frontend/src/styles/design-system.css`). Build the palette around it; don't swap to a random brand colour.
- **Real assets only:** use the v2 flat brand marks / logo from the brand-asset set — never hand-draw or approximate the wordmark in inline SVG/CSS. Measure the slot, place the real asset.
- **Voice:** Albusto is a field-service CRM for home-service pros (ABC Homes is the flagship tenant). Audience = owners, dispatchers, technicians. Concrete and operator-facing — never generic SaaS filler.
- **Not cream.** Albusto deliberately left the warm-beige aesthetic for a neutral canvas; the `#F4F1EA` cream look is an off-brand default here.

## Design principles (brand surfaces)

- **The hero is a thesis.** Open with the most characteristic thing in the subject's world — a headline, an image, an interactive moment. A big number + label + gradient accent is the template answer; use it only if it is genuinely best.
- **Typography carries personality.** Pair a characterful display face with a clean body face and set an intentional scale. (The product uses IBM Plex Sans / Manrope; a brand page may reach further — deliberately.)
- **Structure is information.** Numbering, eyebrows, dividers should encode something true, not decorate. Numbered markers (01/02/03) only when the content really is a sequence.
- **Motion is deliberate.** One orchestrated moment beats scattered effects; too much reads as AI-generated.
- **Match complexity to the vision.** Maximalist needs elaborate execution; minimal needs precise spacing, type, and detail.

## AI-default calibration

AI-generated design clusters around three looks — treat them as defaults, not choices: (1) warm cream `#F4F1EA` + high-contrast serif + terracotta; (2) near-black + a single acid-green/vermilion pop; (3) broadsheet hairline rules, zero radius, dense columns. For Albusto: (1) is doubly off-brand (we left beige), and a lone-violet-on-black is **not** automatically our brand — the violet is a considered accent, not a neon pop. Where the brief pins a direction, follow it exactly; where it leaves an axis free, don't spend that freedom on a default.

## Process: brainstorm → plan → critique → build → critique

Two passes. **Plan** a compact token system from the brief: colour (4–6 named hex, starting from `#7F42E1`), type (2+ roles — a restrained display face, a body face, a utility face if needed), layout (one-sentence concept + ASCII wireframe), and the **signature** — the one element the page is remembered by. **Critique** the plan against the brief: if any part reads like the generic default you'd produce for any similar page, revise it and say what you changed. Only then write the code, deriving every colour/type decision from the plan. Watch CSS selector specificity (type- vs element-selectors cancelling padding/margins). Do most iteration in your thinking; show the user only high-confidence ideas.

## Restraint & self-critique

Spend your boldness in one place — let the signature be the one memorable thing, keep everything else quiet, cut decoration that doesn't serve the brief. Quality floor without announcing it: responsive to mobile, visible keyboard focus, reduced motion respected. Critique as you build; screenshot if the environment supports it. Chanel's rule: before leaving, remove one accessory.

## Writing / UX copy (this part aligns with the CRM canon too)

Words are design material, not decoration. Write from the user's side of the screen — name things by what people control (a person manages *notifications*, not *webhook config*). Active voice; a control says exactly what happens ("Save changes", not "Submit") and keeps its name through the flow ("Publish" → toast "Published"). Errors explain what went wrong and how to fix it, in the interface's voice — no apologies, no vagueness. An empty screen is an invitation to act. Sentence case, plain verbs, tone matched to brand and audience.

## The other design skills

- **`artifact-design`** — governs publishable Artifacts specifically (heavy overlap; its process wins for artifact pages). This skill is the broader brand-surface guidance.
- **`design-qa`** — the source-vs-render gate; run it before handing off a brand page too (five fidelity surfaces, real viewport, verdict `passed | blocked`).
- **`audit`** — for reviewing an existing brand / marketing flow.
- **CRM product UI → `CLAUDE.md` + `docs/specs/` canons** — this skill steps aside there.
