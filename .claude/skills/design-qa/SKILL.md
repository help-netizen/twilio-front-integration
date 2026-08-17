---
name: design-qa
description: "Pre-handoff visual QA gate for Albusto frontend work: compare the source visual target (owner screenshot, mockup, a reference screen, or the design canon) against the rendered implementation before calling a frontend change done. Normalizes viewport/theme/state, puts source and render in ONE comparison, checks five fidelity surfaces (type, spacing, color/tokens, assets, copy), files P0–P3 findings, and iterates until passed. This is an INTERNAL gate, not a broad UX critique — for 'review/critique our flow' use the audit skill. Use before handing off any new or changed screen, panel, sheet, or component."
user-invocable: true
argument-hint: "<what was built + where to see it: preview name / URL / component / harness>"
---

# Design QA — visual gate before handoff

Compare a frontend change against its **source visual target** as a product-quality reviewer, not a generic aesthetic critic. The output is a prioritized, evidence-grounded fix list and a single verdict: **passed** or **blocked**.

This is the gate you run **before** telling the owner a frontend task is done. It is not a UX critique of a live product — route "audit / review / critique our onboarding/checkout/settings flow" to [audit](../audit/SKILL.md).

## When it applies

Run design-qa when the change is visible in the browser: a new or changed screen, panel (шторка), bottom-sheet, form, card, list, or component. Skip it for non-visual work (types, data wiring, tests, backend). This composes with — does not replace — the harness's `<verification_workflow>` (console/network/build checks): design-qa is the **visual-fidelity** pass on top of "does it run".

## Two artifacts are required

A real QA run needs BOTH:

- **Source visual target** — the owner's screenshot/mockup, a Figma node if provided, a **reference screen already in the app** ("match the estimate editor"), or, when there is no picture, the **design canon** itself (`docs/specs/FORM-CANON.md`, `TYPE-CANON-001.md`, LAYOUT-CANON, and `frontend/src/styles/design-system.css` tokens).
- **Rendered implementation** — the running change: the dev preview (Browser-MCP), staging (`mini`), or a component harness (`frontend/src/harness/*`).

If either cannot be opened or captured, the verdict is **blocked** — name the blocker, do not hand off as done.

## Capture (our stack — no Sites, no Work Mode, no device-frame template)

1. Bring up the implementation: `preview_start {name}` for the dev server (never Bash), or open staging, or the relevant `*-harness.html`.
2. Capture with the Browser-MCP: `computer{action:"screenshot"}` for the visual, `read_page` for structure/text, `javascript_tool` for computed CSS/token values, `read_console_messages` for errors.
3. Capture the **states that matter**, not just the happy path: empty / loading / error, hover / focus / active / selected / disabled, and — for anything mobile — the keyboard-open state.

## Normalize BEFORE you compare (this is the honest-viewport rule)

- Match the **same viewport, theme, and state** in the render and the source before judging. Use `resize_window` — mobile `{preset:"mobile"}` (390×812) or an explicit device width, desktop `{preset:"desktop"}`, and `colorScheme` for light/dark (the app is theme-aware).
- **Do not judge a scaled screenshot.** Confirm the capture is 1:1 at the intended viewport (a shrunk-to-fit screenshot is invalid for fidelity). This is the transferable core of the old "393×852" rule — generalized: verify captured size == intended size.
- Differences caused only by viewport mismatch, browser chrome, or density are **not findings** — normalize them away first, then judge type, spacing, color, assets, and state.

## The one rule people get wrong

**A screenshot on its own is not QA.** Put the **source and the render into one comparison** and judge the visible differences from that combined view — never "these two look about right" from memory or two separate glances. When details are small (type weight, alignment, icon, token), do a **focused region comparison** in addition to the full-view one.

## Five fidelity surfaces — check every one, every time

Even if the owner named only one area, make an explicit pass over all five, mapped to our canon:

1. **Type** — family, weight, size, line-height, hierarchy, wrapping, truncation. Enforce **TYPE-CANON-001**: 32 / 20 / 15 only; below a section heading, hierarchy is weight (500 vs 600) + colour (`--blanc-ink-1/2/3`), never a fresh font size. A stray `text-[13px]` is the bug this canon exists to catch.
2. **Spacing / rhythm** — margins, padding, gaps, radii (10/16/22/28), the FORM-CANON field rhythm (`space-y-6` groups, `space-y-3.5` within), no cramped or colliding elements.
3. **Colour / tokens** — every colour is a `--blanc-*` token (no raw hex outside the token set), correct accent (`#7F42E1`), correct entity/semantic colours, contrast holds in **both** light and dark.
4. **Asset quality** — logos, illustrations, product imagery, and non-standard icons are **real assets**, correctly sized to their slot. **Automatic fail:** any visible asset faked with inline/hand-rolled SVG, CSS art, div/span shapes, emoji, or placeholder boxes. Measure the slot, then fit the asset — no lazy crops or stretched images.
5. **Copy** — app copy is English (UI-language canon), literal and clear (LAYOUT/UX canon: "Leads & Jobs", not "Activity"), no empty `—`/`N/A` rows.

Also flag: rounded cards / borders / shadows that appear in the render but not the target (LAYOUT-CANON "containers are invisible"), and the owner's prompt leaking into the UI instead of the app standing on its own.

## Severity

- **P0** — blocks the task, breaks layout, severe a11y failure, or an impossible interaction.
- **P1** — major mismatch or usability regression a user will notice.
- **P2** — moderate visual drift, wrong state, responsive break, or a fixable polish gap. Overflow that hides a persistent control, or a mismatch that changes above-the-fold content / density / wrapping, is **P2 or higher**.
- **P3** — minor refinement; does not block acceptance.

## Iterate — QA is a loop, not a verdict

On any P0/P1/P2: record it, keep the result **blocked**, apply the fix, **re-capture at the same viewport and state**, and compare against the source again. Build / lint / dependency / preview fixes are **not** design-QA iterations. The pass is real only when a comparison finds no actionable P0/P1/P2 and no visual fix was made in response.

## Output

Lead with the findings, ordered by severity. For each: **severity · location (screen/component/selector) · what differs (source does X, render does Y) · evidence · why it matters · the concrete fix** (with the token/class/component when known). Separate objective mismatches from subjective polish. End with a short implementation checklist and, if useful, the screenshot proof for the owner.

Then state the verdict explicitly — exactly one of:

- **passed** — no actionable P0/P1/P2; any P3 is listed as follow-up polish.
- **blocked** — actionable P0/P1/P2 remain (or an artifact was missing); name the blocker.

Keep a written record only when it's worth it: an inline report is the default; persist `<scratchpad>/design-qa-<feature>.md` when the owner wants the trail (source path, render path, viewport, pixel size + normalization, states, full-view + focused evidence, findings, iteration history, verdict). Do **not** litter the repo root with `design-qa.md`.

## Reference

Full rubric: [references/qa-rubric.md](references/qa-rubric.md). Canon: `CLAUDE.md` (UI Design Principles), `docs/specs/FORM-CANON.md`, `docs/specs/TYPE-CANON-001.md`, `frontend/src/styles/design-system.css`.
