---
name: audit
description: "Walk a real Albusto flow and report UX, design, and accessibility findings grounded in captured screenshots. Use when the owner asks to audit, review, critique, inspect, assess, or give feedback on a product flow, journey, funnel, onboarding / checkout / settings path, screen, or multi-step experience. Captures each step in the browser (dev preview or staging), verifies every screenshot, and reports inline with findings tied to evidence. For comparing a freshly built screen against its mockup before handoff, use design-qa instead."
user-invocable: true
argument-hint: "<flow or screen to audit, e.g. 'the onboarding flow' / 'the invoice editor'>"
---

# Audit — review a live flow from evidence

Use this when the owner wants to **audit, review, critique, inspect, assess, or get feedback** on a product flow or screen. The output is not a loose opinion — it is:

- screenshots of the flow, rendered inline in the report,
- a numbered step list,
- UX and design findings tied to specific steps/screenshots,
- accessibility risks tied to specific steps/screenshots,
- clear limits on what could **not** be checked from screenshots alone.

This is a **user-facing** review of something that already exists. It is different from [design-qa](../design-qa/SKILL.md), which is the internal source-vs-render gate before handoff. If the same request also asks to fix/redesign afterward, audit **first**, then continue through tandem/orchestrate.

## Route before you start

1. Identify the surface (which product area / screen).
2. Identify the flow or task the user is auditing.
3. Pick where to capture: the dev preview (`preview_start {name}`, never Bash) or staging (`mini`). Prefer the environment that reaches the real flow with realistic data. If auth or state blocks the flow and cannot be reached, that is a **blocker**, not an audit — say so.
4. Walk and capture the flow step by step.
5. Save and inspect every screenshot before trusting it.
6. Return the audit inline with the accepted screenshots.

## Capture with the Browser-MCP

- Use the in-app Browser tools: `navigate`, `read_page` (structure/text, gives refs), `computer` (click/type/screenshot), `resize_window` (mobile vs desktop, light vs dark), `read_console_messages` (surfaces a11y/JS issues).
- Observe the visible state before acting. Before each click/type, target one clear control from the latest `read_page`. After each action, take the cheapest check that proves what changed (read_page for structure, screenshot for visual state).
- For **each step**: wait until the screen is loaded and stable → check for spinners, blank areas, login walls, error pages, cookie dialogs, half-rendered content → screenshot → **inspect the screenshot** → reject and re-capture if it is blank, loading, cropped, blocked, or the wrong state → note strengths, UX issues, a11y risks, and any limits for that step. Name screenshots in order (`01-start`, `02-form-filled`, `03-confirmation`).

## Evidence discipline (hard rule)

- Use **only** evidence captured in the current run. No memory, prior chats, old traces, cached screenshots, or earlier artifacts as evidence unless the owner provides them.
- Do not audit until the surface, flow, and capture environment are known.
- Do not claim full accessibility compliance from screenshots alone — say what is visible and what still needs real assistive-tech / keyboard testing.
- Help-center pages and web searches are **research**, not an audit. If the actual flow could not be accessed and captured, do not call it an audit.

## What to inspect

Follow [references/design-audit-framework.md](references/design-audit-framework.md) for the UX and accessibility lenses and the output structure. Ground design findings in the Albusto canon (`CLAUDE.md` UI Design Principles, `docs/specs/*`, `design-system.css`) — call out token drift, TYPE-CANON violations, invisible-container breaks, faked assets, and mobile nav/sheet/keyboard-canon issues where they appear.

## Final report

Lead with the overall verdict, then the numbered step list — each step: **number · short description · general health**. Under it, the highest-impact changes and the evidence limits, with every finding tied to the step or screenshot that supports it. Render the accepted screenshots inline in flow order. Keep the language direct; no broad design jargon when a plain phrase works. Figma boards are **not** part of the default output — only produce one if the owner explicitly asks.
