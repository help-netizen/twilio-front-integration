# Test Cases: SLOT-ENGINE-001 — UX polish

**Spec:** `docs/specs/SLOT-ENGINE-001-UX-POLISH.md` (authoritative — copy strings, `tempFromRec` mapping, 4-state ladder).
**Requirements:** `docs/requirements.md` → "SLOT-ENGINE-001 — UX polish (2026-06-25)" (SE-UX-1..7 / AC-1..16).
**Engine under test:** `slot-engine/src/engine.js` → `explain(m)`.
**Test runner:** plain `node --test` (NOT Jest) — match the style of `slot-engine/test/engine.test.js` / `scenarios.test.js`.

---

## Coverage

- **Automated (engine, node:test): 12 cases** — `EXP-01 .. EXP-12`.
  - P0: 5 (EXP-01, EXP-02, EXP-06, EXP-07, EXP-12) · P1: 4 (EXP-03, EXP-04, EXP-05, EXP-08) · P2: 3 (EXP-09, EXP-10, EXP-11).
  - Type: all **Unit** (pure-function `explain(m)` assertions, shape/content only — never literal-copy-fragile beyond the defined constant + the contracted phrase substrings).
- **Manual / visual checklist (frontend, no RTL harness): 16 items** — `MAN-01 .. MAN-16`, one per AC, plus regression guard + build gate.
  - Includes 1 regression guard (`MAN-15`, reschedule/edit path untouched) and 1 build gate (`MAN-16`, `npm run build` / `tsc -b`).

### Test file placement (recommendation to Tester agent)

Create a **new dedicated file** `slot-engine/test/explain.test.js`. Rationale: `explain` becomes a first-class unit with a focused contract; a dedicated file keeps the assertions readable and isolated from the pipeline-integration suites (`engine.test.js`, `scenarios.test.js`). Import `explain` directly — **it must be added to `module.exports`** of `engine.js` for unit testing (currently only `recommendSlots`/`buildSnapshot`/`checkFeasibility` are exported). If the implementer prefers not to widen the export surface, the same cases can be driven end-to-end via `recommendSlots(...)` and asserted on `recommendations[*].explanation`; the dedicated direct-unit form is preferred for precision and is what the cases below assume (with a fallback note where pipeline-driving is required).

### Pre-existing-suite guard (already verified at authoring time)

`engine.test.js` and `scenarios.test.js` assert **only** on `reason_codes` (machine tokens — untouched by this work) and structural shape; **no** test asserts on the Russian `explanation` literal. All 26 existing tests pass. AC-3 is therefore already satisfied for the legacy suites — **no relaxation needed**. `EXP-12` formalizes this as a guard.

---

## Engine — automated cases (`node --test`)

> Input convention: each case constructs a metrics object `m` (the shape `explain` receives — same fields the engine builds at `engine.js:167-177`). Only the fields `explain` reads matter: `nearest_existing_job_distance_miles`, `extra_travel_minutes`, `route_slack_minutes`, `geo_confidence`. Other metric fields are irrelevant to `explain` and may be omitted.
> Helper for forbidden-content assertions (Tester to implement once, reuse across cases): assert the returned string contains **no** Cyrillic (`/[Ѐ-ӿ]/`), **no** snake_case token (`/[a-z]+_[a-z]/`), **no** `YYYY-` date (`/\d{4}-\d{2}-\d{2}/`), **no** `HH:MM` time (`/\d{1,2}:\d{2}/`), and none of the literals `технік`, `Риск`, `Плюсы`.

---

### EXP-01: All three positives present → joined with " · " in spec order
- **Priority:** P0
- **Type:** Unit
- **Related:** SE-UX-1 / AC-1, AC-2 · spec §1 phrase bank + examples
- **Preconditions:** `explain` exported (or pipeline-driven fallback).
- **Input (`m`):** `{ nearest_existing_job_distance_miles: 1.2, extra_travel_minutes: 8, route_slack_minutes: 45, geo_confidence: 0.9 }`
- **Steps:**
  1. Call `explain(m)`.
- **Expected result:** returns exactly
  `tech already working nearby · little extra driving · comfortable schedule gap`
  (three phrases, in this order, joined by `" · "` — space, U+00B7 middot, space). No leading/trailing whitespace, no trailing period.

---

### EXP-02: No positives → exact fallback constant
- **Priority:** P0
- **Type:** Unit
- **Related:** SE-UX-1 / AC-2 · spec §1 fallback ("Good fit for this route")
- **Input (`m`):** `{ nearest_existing_job_distance_miles: 12, extra_travel_minutes: 40, route_slack_minutes: 10, geo_confidence: 0.9 }` (all positive conditions false: dist>5, extra>15, slack<30)
- **Steps:**
  1. Call `explain(m)`.
- **Expected result:** returns **exactly** `Good fit for this route` (the constant). Non-empty string; never `''`, `null`, or `undefined`.

---

### EXP-03: Only "near" positive → single phrase
- **Priority:** P1
- **Type:** Unit
- **Related:** SE-UX-1 · spec §1 (dist ≤ 5 → "tech already working nearby")
- **Input (`m`):** `{ nearest_existing_job_distance_miles: 3, extra_travel_minutes: 40, route_slack_minutes: 10, geo_confidence: 0.9 }`
- **Expected result:** returns exactly `tech already working nearby` (no `" · "`, no other phrase, no fallback).

---

### EXP-04: Only "extra travel" positive → single phrase
- **Priority:** P1
- **Type:** Unit
- **Related:** SE-UX-1 · spec §1 (extra ≤ 15 → "little extra driving")
- **Input (`m`):** `{ nearest_existing_job_distance_miles: 20, extra_travel_minutes: 5, route_slack_minutes: 10, geo_confidence: 0.9 }`
- **Expected result:** returns exactly `little extra driving`.

---

### EXP-05: Only "slack" positive → single phrase
- **Priority:** P1
- **Type:** Unit
- **Related:** SE-UX-1 · spec §1 (slack ≥ 30 → "comfortable schedule gap"); mirrors the spec example "only slack → comfortable schedule gap"
- **Input (`m`):** `{ nearest_existing_job_distance_miles: 20, extra_travel_minutes: 40, route_slack_minutes: 50, geo_confidence: 0.9 }`
- **Expected result:** returns exactly `comfortable schedule gap`.

---

### EXP-06: English-only / no-leak content guard
- **Priority:** P0
- **Type:** Unit
- **Related:** SE-UX-1 / AC-1, AC-2 · spec §1 output contract
- **Input (`m`):** a representative set — run the guard against the outputs of **at least**: EXP-01's three-positive `m`, EXP-02's no-positive `m`, and EXP-08's low-geo `m`. (Table-drive over these three.)
- **Steps:**
  1. For each `m`, call `explain(m)`.
- **Expected result:** every output:
  - contains **no Cyrillic** (`/[Ѐ-ӿ]/` does not match),
  - contains none of `технік`, `Риск`, `Плюсы`,
  - contains **no snake_case token** (e.g. `near_existing_jobs`, `low_extra_travel` — `/[a-z]+_[a-z]/` does not match),
  - contains **no `YYYY-MM-DD` date** and **no `HH:MM` time**,
  - contains **no technician-name prefix** (no leading `"<word>, "` resembling the old `${date}, ${win.start}-${win.end}, ${tech.name}.` prefix — assert the string does NOT start with the legacy prefix shape and does not contain `". "` segment joins).
  - is ASCII-only (every char code < 128) **except** the middot `·` (U+00B7) used as the join separator.

---

### EXP-07: Low geo confidence carries ONLY positives (no risk text appended)
- **Priority:** P0
- **Type:** Unit
- **Related:** SE-UX-1 · spec §1 "Low-geo handling — DECIDED" (explain stays positives-only; the approx-address signal lives exclusively on the card dispatch flag, NOT in `explain`)
- **Input (`m`):** `{ nearest_existing_job_distance_miles: 1, extra_travel_minutes: 5, route_slack_minutes: 50, geo_confidence: 0.4 }` (low geo, all three positives true)
- **Steps:**
  1. Call `explain(m)`.
- **Expected result:** returns exactly
  `tech already working nearby · little extra driving · comfortable schedule gap`
  — **identical** to the same `m` with `geo_confidence: 0.9`. Specifically: output contains **no** "approx", "Approx", "ZIP", "address", "Risk", "Риск", "приблизительная", or any risk/uncertainty wording. `geo_confidence < 0.7` has **zero** effect on the returned string.

---

### EXP-08: Low geo + no positives → still the clean fallback (no risk appended)
- **Priority:** P1
- **Type:** Unit
- **Related:** SE-UX-1 · spec §1 edge ("geo_confidence < 0.7 → no effect on explain() output")
- **Input (`m`):** `{ nearest_existing_job_distance_miles: 30, extra_travel_minutes: 40, route_slack_minutes: 10, geo_confidence: 0.3 }`
- **Expected result:** returns **exactly** `Good fit for this route` (no risk suffix, no approximate-address text). Confirms the fallback path is also positives-only under low geo.

---

### EXP-09: Threshold edge — distance exactly 5 (inclusive `<= 5`)
- **Priority:** P2
- **Type:** Unit
- **Related:** SE-UX-1 · spec §1 ("Thresholds are inclusive `<= 5`"); mirrors `reasonCodes` boundary
- **Input A (`m`):** `{ nearest_existing_job_distance_miles: 5, extra_travel_minutes: 40, route_slack_minutes: 10, geo_confidence: 0.9 }` → expect output **includes** `tech already working nearby` (so: exactly that single phrase).
- **Input B (`m`):** same but `nearest_existing_job_distance_miles: 5.1` → expect output is `Good fit for this route` (phrase excluded; `> 5` fails).
- **Expected result:** boundary `=5` IN, `5.1` OUT.

---

### EXP-10: Threshold edges — extra exactly 15 and slack exactly 30 (inclusive)
- **Priority:** P2
- **Type:** Unit
- **Related:** SE-UX-1 · spec §1 (inclusive `<= 15`, `>= 30`)
- **Input A (`m`):** `{ nearest_existing_job_distance_miles: 20, extra_travel_minutes: 15, route_slack_minutes: 10, geo_confidence: 0.9 }` → expect exactly `little extra driving` (extra `=15` IN).
- **Input B (`m`):** same but `extra_travel_minutes: 15.1` → expect `Good fit for this route` (extra OUT).
- **Input C (`m`):** `{ nearest_existing_job_distance_miles: 20, extra_travel_minutes: 40, route_slack_minutes: 30, geo_confidence: 0.9 }` → expect exactly `comfortable schedule gap` (slack `=30` IN).
- **Input D (`m`):** same as C but `route_slack_minutes: 29.9` → expect `Good fit for this route` (slack OUT).
- **Expected result:** `extra=15` IN / `15.1` OUT; `slack=30` IN / `29.9` OUT.

---

### EXP-11: `nearest_existing_job_distance_miles == null` → "near" phrase skipped
- **Priority:** P2
- **Type:** Unit
- **Related:** SE-UX-1 · spec §1 edge ("nearest...== null → first condition false via the `!= null` guard"); matches `reasonCodes` semantics (empty-day candidate where nearest is null)
- **Input A (`m`):** `{ nearest_existing_job_distance_miles: null, extra_travel_minutes: 5, route_slack_minutes: 50, geo_confidence: 0.9 }` → expect exactly `little extra driving · comfortable schedule gap` (near-phrase NOT included; the other two present).
- **Input B (`m`):** `{ nearest_existing_job_distance_miles: null, extra_travel_minutes: 40, route_slack_minutes: 10, geo_confidence: 0.9 }` → expect `Good fit for this route` (null near + no other positive → fallback).
- **Expected result:** `null` distance never produces the "near" phrase and never throws.

---

### EXP-12: Pre-existing suites stay green + AC-3 shape-only guard (regression)
- **Priority:** P0
- **Type:** Unit (suite-level guard)
- **Related:** SE-UX-1 / AC-3 · spec §1 AC mapping + "Build/verification gate"
- **Preconditions:** `explain(m)` ships; call site in `recommendSlots` updated to pass only `m`.
- **Steps:**
  1. Run `node --test` in `slot-engine/`.
  2. From `recommendSlots(...)` output (use the `scenarios.test.js` fixtures or `engine.test.js` `baseRequest()`), assert for **every** `rec` in `recommendations`: `typeof rec.explanation === 'string'` **and** `rec.explanation.length > 0`.
  3. Assert no test in the repo asserts on a Russian/literal explanation fragment (grep guard at review time — confirmed clean at authoring; keep this assertion shape-only).
- **Expected result:** all suites pass (≥ 26 prior + the new `explain` cases); every shipped `explanation` is a non-empty string; no literal-copy assertion on `explanation` exists anywhere. (Engine assertions are shape-only per AC-3, so copy can evolve.)

---

## Frontend — manual / visual checklist + build gate

> **No React Testing Library harness exists for `CustomTimeModal` in this repo**, so each frontend AC is a precise manual/visual verification step performed in the running app on the **new-job path** (`isNewJob === true`: open "Custom time" from a new-job/lead context — no `initialSlot`, no `excludeJobId`), plus a `tsc -b` build gate. Verify with the marketplace slot-engine app **enabled** for the tenant unless a state says otherwise.

| ID | AC | Priority | What to verify (PASS criteria) |
|---|---|---|---|
| **MAN-01** | AC-4 | P1 | **Temperature mini-bar exists, one per card.** Each rec card shows exactly ONE thin vertical bar on the **left edge** (~5px wide, track at `left:6px`). Fill **height ∝ score** (filled from the bottom); fill **color ∝ tier**: `high` = warm green `--blanc-success` (#1b8b63), `medium` = blue `--blanc-job` (#2f63d8), `low` = warm amber `--blanc-warning` (#b26a1d). No second quality indicator on the face. Card text clears the bar (left padding ~18px). |
| **MAN-02** | AC-5 | P1 | **Raw score is OFF the face.** No visible numeric score on any card; no `confidence` text chip. The number appears **only** in the card's hover `title` / `aria-label` as `"<label> · score <N>"` (e.g. `Best match · score 88`). Inspect the card `<button>`: `aria-label`/`title` present and correctly formatted; `.ctm-rec-card__score` and `.ctm-rec-card__confidence` spans are gone from the DOM. |
| **MAN-03** | AC-6 | P1 | **Dispatch flag humanized + conditional + amber.** For a low-geo / `requires_dispatch_confirmation` rec the card shows exactly `Approx. address — confirm` (en-dash `—`, lowercase "confirm"), styled amber (`color:#b45309; background:rgba(245,158,11,0.14)`). For recs **without** the flag, NO flag row / no empty `__meta` row renders. "Dispatch confirm" wording is gone. |
| **MAN-04** | AC-7 | P1 | **Sub-text is always human English, no snake_case.** Every card's reason sub-line shows English copy (engine `explanation`, e.g. "tech already working nearby · …" or "Good fit for this route"). No `near_existing_jobs`-style token ever appears. Force a missing-explanation case (or trust the constant): the sub-line still renders `Good fit for this route` (fallback constant), never blank, never a machine token. |
| **MAN-05** | AC-8 | P1 | **Vocabulary — "Recommended".** Panel header reads **"Recommended times"** (was "Suggested times"). The engine-driven tech-bar pill reads **"Recommended"** (unchanged). |
| **MAN-06** | AC-9 | P1 | **Vocabulary — "Preselected".** On a **copied/duplicate** job flow (the `suggestedTechId` lane), the copied-tech pill reads **"Preselected"** (was "Suggested"). No user-facing "Suggested" remains. (Class names `__suggested`/`isSuggested` are internal — not user-facing — and are expected to be unchanged.) |
| **MAN-07** | AC-10 | P2 | **Empty-state copy (enabled + reachable + zero recs).** With the app enabled and the engine returning zero recs for a date (engine reachable, empty result — e.g. pick a far-out/over-booked day), the panel **stays visible** with header "Recommended times" and a muted row **"No nearby openings — try another day"** (en-dash). The panel does NOT disappear. |
| **MAN-08** | AC-11 | P2 | **Graceful absence (disabled / unreachable).** With the slot-engine marketplace app **disabled** (or engine unavailable), the recommendations panel is **absent** and the modal is otherwise unchanged — no temp-bar, no header, no empty row (no regression to prior graceful behavior). |
| **MAN-09** | AC-10/AC-11 ladder | P2 | **Full 4-state ladder, in order.** On the new-job path, exercise each state and confirm the correct single render: (1) **Loading** → spinner + "Finding best times…"; (2) **Unavailable** → "Suggestions unavailable right now."; (3) **Empty** → "No nearby openings — try another day"; (4) **List** → rec cards. Header "Recommended times" is on top in all four. Disabled → whole panel absent (not part of the ladder). |
| **MAN-10** | AC-12 | P2 | **Warm tokens, no cold slate.** Visually inspect the modal (date-nav, hints, timelines empty/labels, map border/overlay/legend, tech-bar arrows): neutrals are warm Albusto tones, no cold slate-blue. Inspect computed styles / CSS: `--muted-foreground`→`--blanc-ink-3`, `--border`→`--blanc-line`; dead dark hex fallbacks (`#27303f`, `#0f172a`, `#1e293b`, `#334155`, `#64748b`, `#94a3b8`, `#e2e8f0`) are removed from the touched rules. (Functional colors `#16a34a` hover, `#ef4444` now-line, `#d97706`/`#b45309` amber are intentionally kept.) |
| **MAN-11** | AC-13 | P2 | **Pagination arrows = shared `Button`.** The technician prev/next arrows render as the shared `Button` (`variant="ghost"`, `size="icon"`), matching the date-nav arrows; raw `<button className="ctm-tech-bar__arrow">` markup is gone. 24px sizing preserved. Disabled logic intact: prev disabled on first page (`techPage===0`), next disabled on last (`techPage >= totalPages-1`); clicks page correctly. |
| **MAN-12** | AC-15 | P2 | **Overlay bands keyboard-accessible.** Each recommendation overlay band in a tech timeline is **focusable** (Tab reaches it; `role="button"`, `tabIndex=0`), has an `aria-label` like `Recommended <start>–<end>` (en-dash), and **Enter** and **Space** both activate it (applies the rec, same as click) without scrolling the page on Space. Existing click + title tooltip still work. |
| **MAN-13** | AC-16 | P3 | **No emoji in map info-window.** Open a job marker's Google Maps info-window: the 🕓 and 🔧 emoji are **gone**; the time string and service name text remain (e.g. plain `<div>10:00–12:00</div>` / `<div>Service name</div>`). |
| **MAN-14** | AC-14 | P3 | **Dead CSS deleted.** Confirm `.ctm-timelines__footer`, `.ctm-timelines__dots`, `.ctm-timelines__dot`, `.ctm-timelines__dot--active`, `.ctm-timelines__legend`, `.ctm-timelines__legend-item`, `.ctm-timelines__legend-dot` are removed from `CustomTimeModal.css` and that grep finds **no** JSX reference to any of them in `CustomTimeModal.tsx`. No visual regression (they were orphaned). |
| **MAN-15** | Protected invariant (regression guard) | **P0** | **Reschedule/edit path byte-for-byte unaffected.** Open "Custom time" in a **reschedule/edit** context (`isNewJob === false`: with `initialSlot` or `excludeJobId`). Confirm: NO temp-bar, NO recommendations panel, NO empty-state, NO overlay rec-bands, NO "Recommended times" vocab; the recommendations effect early-returns (no fetch fired — check network). The only shared change is the preselected-tech pill copy "Suggested"→"Preselected" **if** a `suggestedTechId` is set via copy-job; otherwise no pill. No extra renders, no behavioral diff. |
| **MAN-16** | Build gate | **P0** | **`npm run build` (tsc -b) is green** in `frontend/`. Stricter prod build (noUnusedLocals): removing the `score`/`confidence` spans leaves no unused vars; `tempFromRec` and `REC_FALLBACK_REASON` are referenced. (Verify with `npm run build`, not just `tsc --noEmit`.) Also run `node --test` in `slot-engine/` — green (covered by EXP-12). |

---

## Notes for the Tester agent

- **Engine cases are the only automatable surface** — implement `EXP-01..EXP-12` as `node --test` in `slot-engine/test/explain.test.js`. Prefer direct `explain(m)` unit calls (add `explain` to `module.exports`); fall back to `recommendSlots(...)`-driven assertions on `recommendations[*].explanation` only if the export is rejected.
- **Do not** re-introduce any assertion on the literal `explanation` Russian text in the legacy suites; AC-3 keeps engine assertions shape-only.
- **Frontend `MAN-*` are manual** — there is no RTL/Jest DOM harness for `CustomTimeModal`; do not scaffold one (out of scope). The build gate (`MAN-16`) is the automatable backstop on the frontend side.
- Security/tenant-isolation API tests are **N/A** for this change: scope is `explain()` content + presentational/CSS polish; no routes, DB, middleware, or tenant boundaries are touched (spec §Scope).
