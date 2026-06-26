# SLOT-ENGINE-001 — UX polish (implementable spec)

**Status:** Spec · **Type:** UX / copy / accessibility polish over merged SLOT-ENGINE-001.
**Source requirements:** `Docs/requirements.md` → "SLOT-ENGINE-001 — UX polish (2026-06-25)" (SE-UX-1..7 / AC-1..16).
**Architecture:** `Docs/architecture.md` → "SLOT-ENGINE-001 UX polish — design notes (2026-06-25)".
**Feature spec:** `docs/specs/SLOT-ENGINE-001.md` (unchanged; this pack is polish only).

## Scope (HARD — exactly three files)
- `slot-engine/src/engine.js` — **`explain()` only** (content + signature). One call site inside `recommendSlots`.
- `frontend/src/components/conversations/CustomTimeModal.tsx` — rec cards, tech pills, panel header/empty state, pagination arrows, overlay bands, map info-window.
- `frontend/src/components/conversations/CustomTimeModal.css` — temp-bar classes, warm tokens, dead-rule deletion.

**No changes** to engine scoring/ranking/feasibility/config/output-contract fields, `slotEngineService`/proxy, DB, marketplace gating, tenant isolation, `--blanc-*` token names, or `Blanc*` identifiers. No new files/components/deps/routes. **`explanation` stays a `string` field** on each recommendation — only its content changes; `score`/`confidence` are read, never written.

**Protected invariant — reschedule/edit path:** `isNewJob = !initialSlot && !excludeJobId`. When `isNewJob === false`, the recommendations effect early-returns (`CustomTimeModal.tsx:570`), `recsEnabled` stays `false`, `showRecPanel` stays `false`, `recsForSelectedDate`/`recommendedTechIds`/`recsByTech` are empty, and no overlay bands render. **Every change below is reachable only on the new-job path** — the reschedule/edit path must be byte-for-byte unaffected (no temp-bar, no panel, no vocab change, no extra renders). Verify the tech-pill vocabulary change is purely a label swap in JSX that already only renders on populated tech bars (unaffected in reschedule since panel/recs are off, but the tech bar itself renders in both modes — the "Recommended"/"Preselected" pills are gated by `recommendedTechIds`/`suggestedTechId`, both empty/undefined in reschedule, so no pill shows; only the literal "Suggested"→"Preselected" copy on the `suggestedTechId` pill is shared and is a label-only change — see §4 edge note).

---

## 1. SE-UX-1 (P0) — `explain(m)` clean English builder

**Current (engine.js:293-300):** `explain(win, date, tech, m)` returns Russian text ("технік уже работает рядом", "Плюсы:", "Риск: …") with a redundant `${date}, ${win.start}-${win.end}, ${tech.name}` prefix.

### New signature
`explain(m)` — drop the unused `win`/`date`/`tech` params. Update the single call site in `recommendSlots` (the only caller) to pass just `m` (the metrics object). Card already renders date/window/tech, so the prefix is removed entirely.

### Output contract (behavioral)
- Return type: **non-empty `string`** for every candidate. Never `''`, never `null`/`undefined`.
- Content: **positives only**, ASCII English, no snake_case, no Russian characters, no date/time/window/technician name, no "технік"/"Риск".
- **Low-geo handling — DECIDED:** `explain()` carries **ONLY positives**. It does **NOT** append any approximate-address / risk text for `geo_confidence < 0.7`. The approximate-address signal is surfaced **exclusively** by the card's dispatch flag (§3, driven by `rec.requires_dispatch_confirmation`). Rationale: keeps the reason line purely positive and avoids double-signalling; the dispatch flag is the actionable channel.

### Phrase bank (mirror the existing positive conditions — same thresholds as `reasonCodes`)
Build a `bits: string[]` array in this order:

| Condition (on `m`) | Phrase appended |
|---|---|
| `m.nearest_existing_job_distance_miles != null && m.nearest_existing_job_distance_miles <= 5` | `tech already working nearby` |
| `m.extra_travel_minutes <= 15` | `little extra driving` |
| `m.route_slack_minutes >= 30` | `comfortable schedule gap` |

- Join non-empty `bits` with `" · "` (space–middot–space).
- **Fallback:** if `bits.length === 0`, return the constant string `Good fit for this route`.
- Capitalization: phrases are sentence-fragment lowercase as written above (the card renders them as a sub-line, no leading-cap requirement). Do not add a trailing period.

**Examples**
- all three true → `tech already working nearby · little extra driving · comfortable schedule gap`
- only slack → `comfortable schedule gap`
- none → `Good fit for this route`

### AC mapping
- AC-1: no Russian chars, no "технік"/"Риск" anywhere in engine output. ✓
- AC-2: no date/time/window/tech name; metric-poor candidates yield the non-empty fallback, never `''`. ✓
- AC-3: engine tests assert only `typeof explanation === 'string'` and `explanation.length > 0` (shape, not literal copy). Remove/relax any test asserting literal explanation text. ✓

### Edge cases
- `m` present but all positive metrics false/absent → fallback `Good fit for this route`.
- `nearest_existing_job_distance_miles == null` → first condition false (the `!= null` guard), phrase skipped — matches current `reasonCodes` semantics.
- Thresholds are inclusive (`<= 5`, `<= 15`, `>= 30`) — exactly mirrors current behavior; do not change the boundary direction.
- `geo_confidence < 0.7` → no effect on `explain()` output (positives only).

---

## 2. SE-UX-2 (P1) — Temperature mini-bar + `tempFromRec`

Replaces the visible raw `score` number AND the raw `confidence` enum chip with **one** thin vertical "temperature" bar on the **left edge** of each rec card.

### Helper — `tempFromRec({ score, confidence })` (pure, module-local in CustomTimeModal.tsx)
Place beside `recToSlotDates`/`parseHHMM`. Reads only `confidence` (`'high' | 'medium' | 'low'`) and `score` (number). Returns `{ fillPct: number, colorVar: string, label: string }`.

```
tier   = confidence                                  // 'high' | 'medium' | 'low'
fillPct = clamp(Math.round(score), 0, 100)           // percent of bar HEIGHT, filled from the bottom
```

| tier | colorVar (fill) | label (tooltip/aria only) |
|---|---|---|
| `high`   | `var(--blanc-success)`  | `Best match` |
| `medium` | `var(--blanc-job)`      | `Good fit`   |
| `low`    | `var(--blanc-warning)`  | `Worth a look` |

**Color token decision (verified against the codebase, supersedes the brief's guessed hexes):**
The Albusto design system **does** define warm semantic tokens in `frontend/src/styles/design-system.css`:
`--blanc-success: #1b8b63` (line 61), `--blanc-warning: #b26a1d` (line 62), and `--blanc-job: #2f63d8` (medium/blue, already used throughout this file).
Use these **design-system tokens** (not the cold `#16a34a` / `#d97706` the brief speculated, and not `#22c55e`). This keeps the bar consistent with the warm-token goal of SE-UX-5. Each `var()` may include the literal as a fallback for safety: `var(--blanc-success, #1b8b63)`, `var(--blanc-job, #2f63d8)`, `var(--blanc-warning, #b26a1d)`.
- Unknown/missing `confidence` (defensive) → treat as `low` (`--blanc-warning`, `Worth a look`).

### Render (JSX)
At the **start** of the card's children, before `__top`, render the bar:
```
<span className="ctm-rec-card__temp" aria-hidden="true">
  <span className="ctm-rec-card__temp-fill" style={{ height: `${fillPct}%`, background: colorVar }} />
</span>
```
- The bar is decorative (`aria-hidden`); the human label + score live on the card's accessible name (below).
- **Card accessible name (AC-5):** the rec card `<button>` gets `title` and `aria-label` of the form `` `${label} · score ${Math.round(rec.score)}` `` (e.g. `Best match · score 88`). This is the ONLY place the raw numeric score appears. Dispatchers can hover/screen-read it; it is not visible text.

### CSS (CustomTimeModal.css, in the rec-card block)
- `.ctm-rec-card` — add left padding so text clears the bar, and `position: relative` (if not already) so the absolute bar anchors to the card. Add `padding-left: 18px;` (keep existing `9px 11px` for the other sides → `padding: 9px 11px 9px 18px;`).
- `.ctm-rec-card__temp` (track): `position: absolute; left: 6px; top: 9px; bottom: 9px; width: 5px; border-radius: 999px; background: var(--blanc-line, rgba(117,106,89,0.18)); overflow: hidden;` (muted track, full card height minus padding).
- `.ctm-rec-card__temp-fill` (fill): `position: absolute; left: 0; right: 0; bottom: 0; border-radius: 999px;` — `height` and `background` come from inline style; fills from the bottom up.

### Edge cases
- `score === 100` → `fillPct = 100` (full). `score > 100` (shouldn't happen) → clamped to 100. `score < 0` → clamped to 0 (empty bar, card still clickable).
- `score` exactly at a `confidenceClass` tier boundary: tier comes from the **engine's** `confidence` enum (read-only here), so boundary scores are already classified by the engine — `tempFromRec` does NOT re-derive the tier from `score`. `fillPct` is purely the score magnitude; color is purely `confidence`. (This decouples bar height from bar color by design.)
- `confidence` absent → `low` defaults (above).

---

## 3. SE-UX-2/AC-6 — Dispatch flag + removals

- **Remove from visible card face:**
  - `<span className="ctm-rec-card__score">{Math.round(rec.score)}</span>` (CustomTimeModal.tsx:787) — score moves to `aria-label`/`title` (§2).
  - `<span className="ctm-rec-card__confidence">{rec.confidence}</span>` (CustomTimeModal.tsx:794) — replaced by the temp-bar color.
  - The `.ctm-rec-card__score` and `.ctm-rec-card__confidence` CSS rules may be deleted (no longer referenced).
- **Dispatch flag (replaces "Dispatch confirm"):**
  - Copy: exactly `Approx. address — confirm` (en-dash `—`, lower-case "confirm").
  - Rendered **only when** `rec.requires_dispatch_confirmation` is truthy (unchanged condition; the field is omitted by the engine when false).
  - Reuse the existing `.ctm-rec-card__flag` class (amber: `color: #b45309; background: rgba(245,158,11,0.14)` — already warm-amber, leave as-is).
  - Lives where the old `__meta` row was; the `__meta` wrapper may be kept (now holding only the flag) or the flag rendered directly. If `__meta` becomes empty-only-on-no-flag, render the flag conditionally so no empty row shows.

### AC mapping
AC-4 (one bar, tier color) ✓ · AC-5 (score off-face, in title/aria; confidence chip + score span removed) ✓ · AC-6 (humanized flag, amber, conditional) ✓ · AC-7 (sub-text always human English — see §4 fallback) ✓.

---

## 4. SE-UX-3 (P1) — Vocabulary

Every string + line:

| File:line (current) | Old string | New string |
|---|---|---|
| CustomTimeModal.tsx:759 (`.ctm-recs__header`) | `Suggested times` | `Recommended times` |
| CustomTimeModal.tsx:830 (`.ctm-tech-bar__suggested` pill) | `Suggested` | `Preselected` |
| CustomTimeModal.tsx:833 (`.ctm-tech-bar__recommended` pill) | `Recommended` | `Recommended` (unchanged — engine pill, keep) |

- The **engine** tech pill text stays **"Recommended"** (already correct, line 833). The **copied/preselected** tech pill (line 830, gated by `suggestedTechId`) changes **"Suggested" → "Preselected"**.
- AC-9: also update the lane's related comment/label vocabulary to "Preselected" (the `suggestedTechId` lane is the "copied-from-duplicate" lane). CSS class names (`__suggested`, `--suggested`, `isSuggested` prop) are internal identifiers — **do not rename** (out of scope; only user-facing copy changes). Update the inline code comments that describe this lane to say "Preselected" for clarity, but leave identifiers.

**Sub-text fallback (AC-7):** Replace `const sub = rec.explanation || rec.reason_codes?.[0];` (CustomTimeModal.tsx:773) with `const sub = rec.explanation || REC_FALLBACK_REASON;` where `REC_FALLBACK_REASON = 'Good fit for this route'` is a module-top constant. The `reason_codes?.[0]` snake_case fallback is **removed** so no machine token can leak.
- **Edge — `explanation` present but empty string:** `'' || REC_FALLBACK_REASON` → falls back to the constant (empty string is falsy). With §1, the engine never emits `''`, but this guards the UI regardless. The `{sub && …}` render guard becomes always-true (constant is non-empty), so the sub-line always renders — acceptable and desired (every card shows a reason).

### AC mapping
AC-8 ("Recommended times" header + engine pill "Recommended") ✓ · AC-9 (copied pill "Preselected") ✓.

---

## 5. SE-UX-4 (P2) — Empty state + 4-state ladder

### Panel-visibility change
Current (CustomTimeModal.tsx:674):
`showRecPanel = isNewJob && ((recsEnabled && (recs.length > 0 || recsUnavailable)) || recsLoading)`

New:
`showRecPanel = isNewJob && (recsLoading || (recsEnabled && (recs.length > 0 || recsUnavailable || true)))`
— i.e. once `recsEnabled` is true the panel always renders (covers the empty case). Concretely:
`showRecPanel = isNewJob && (recsLoading || recsEnabled)`
This keeps the protected graceful-degradation behavior: when the app is **disabled** (`recsEnabled === false`) and not loading, the panel stays **absent** (AC-11). When **enabled**, the panel renders in all of loading/unavailable/empty/list (AC-10).

### Empty-state render condition (precise)
The "No nearby openings" row renders when **all** hold:
`isNewJob && recsEnabled && !recsLoading && !recsUnavailable && recs.length === 0`.

### Full 4-state ladder (inside `showRecPanel`, header `Recommended times` always on top)
1. **Loading** — `recsLoading` → `<Loader2 spin/> Finding best times…` (`.ctm-recs__loading`). *(unchanged copy)*
2. **Unavailable** — `!recsLoading && recsUnavailable` (engine reachable=false / `engine_status === 'unavailable'`, `recs.length === 0`) → `Suggestions unavailable right now.` (`.ctm-recs__loading`). *(unchanged copy)*
3. **Empty** — `!recsLoading && !recsUnavailable && recs.length === 0` → **`No nearby openings — try another day`** (en-dash). Render in a muted row; reuse `.ctm-recs__loading` styling or add `.ctm-recs__empty` (same muted look: `color: var(--blanc-ink-3); font-size:12px; padding:4px;`). Spec prefers a dedicated `.ctm-recs__empty` for semantic clarity but `.ctm-recs__loading` reuse is acceptable.
4. **List** — `!recsLoading && recs.length > 0` → `.ctm-recs__list` with rec cards (§2–4).

Render as an `if/else` chain in this exact order (loading → unavailable → empty → list). Note `recsUnavailable` is only set true when `recsEnabled` (effect: `setRecsUnavailable(!!r.enabled && r.engine_status === 'unavailable')`), so state 2 implies enabled.

### Edge cases
- Enabled + reachable + zero recs → state 3 (the new copy). Previously the whole panel vanished — now it stays with the header + empty row.
- Disabled (`recsEnabled === false`) and not loading → `showRecPanel` false → panel absent (AC-11, no regression). Reschedule/edit → `isNewJob` false → absent.
- Loading→loaded transition unchanged (spinner then resolves to one of unavailable/empty/list).

### AC mapping
AC-10 (empty copy when enabled+reachable+zero) ✓ · AC-11 (absent when disabled/unreachable; modal unchanged) ✓.

---

## 6. SE-UX-5 (P2) — Warm tokens; drop dead dark fallbacks

Each declaration to change (selector → property → old → new). Drop the cold hex fallback entirely (no fallback or warm fallback as noted). `--muted-foreground` → `--blanc-ink-3`; `--border` → `--blanc-line`.

| Selector (line) | Property | Old value | New value |
|---|---|---|---|
| `.ctm-date-nav__trigger` (40) | `border` | `1px solid var(--border, #27303f)` | `1px solid var(--blanc-line)` |
| `.ctm-date-nav__hint` (64) | `color` | `var(--muted-foreground, #94a3b8)` | `var(--blanc-ink-3)` |
| `.ctm-timelines__empty` (192) | `color` | `var(--muted-foreground, #64748b)` | `var(--blanc-ink-3)` |
| `.ctm-hours__label` (232) | `color` | `var(--muted-foreground, #64748b)` | `var(--blanc-ink-3)` |
| `.tech-timeline__grid` (313) | `border-left` | `1px solid var(--border, #27303f)` | `1px solid var(--blanc-line)` |
| `.tech-timeline__hour-line` (320) | `border-top` | `1px solid var(--border, #1e293b)` | `1px solid var(--blanc-line)` |
| `.ctm-map` (419) | `border` | `1px solid var(--border, #27303f)` | `1px solid var(--blanc-line)` |
| `.ctm-map__overlay` (426) | `background` | `var(--background, #0f172a)` | `var(--blanc-surface-strong, #fffdf9)` |
| `.ctm-map__overlay` (432) | `color` | `var(--muted-foreground, #64748b)` | `var(--blanc-ink-3)` |
| `.ctm-map__legend` (439) | `background` | `var(--background, #0f172a)` | `var(--blanc-surface-strong, #fffdf9)` |
| `.ctm-map__legend` (449) | `color` | `var(--muted-foreground, #64748b)` | `var(--blanc-ink-3)` |
| `.ctm-tech-bar__arrow` (175) | `color` | `var(--foreground, #e2e8f0)` | `var(--blanc-ink-2)` |
| `.ctm-tech-bar__arrow:hover` (179) | `background` | `var(--muted, #1e293b)` | `var(--blanc-line)` *(or drop — Button handles hover, see §7)* |

**Dead dark hex fallbacks to drop** in the touched rules: `#27303f`, `#0f172a`, `#1e293b`, `#334155`, `#64748b`, `#94a3b8`, `#e2e8f0` (cold-slate). The `#334155` instance lives in `.ctm-timelines__dot` which is deleted in §8 anyway. Leave **warm** literals already in place (e.g. `var(--blanc-ink-3, #94a3b8)` inside the rec-card block is a *fallback after a warm token* — those are fine to keep, but for the rec-card block they may be normalized too; primary requirement is the cold rules above). Do not touch `#16a34a` (green hover preview), `#ef4444` (now-line), `#d97706`/`#b45309` (amber warn/flag) — those are intentional functional colors, not cold neutrals.

### AC mapping
AC-12 (`--muted-foreground`→`--blanc-ink-3`, `--border`→`--blanc-line`, dead dark fallbacks removed). ✓

---

## 7. SE-UX-6 (P2) — Pagination arrows → `Button`

Replace **both** raw `<button className="ctm-tech-bar__arrow">` (CustomTimeModal.tsx:815-822 prev, 840-846 next) with the shared `Button` (already imported):

```
<Button variant="ghost" size="icon" className="ctm-tech-bar__arrow"
        onClick={() => setTechPage(p => Math.max(0, p - 1))}
        disabled={techPage === 0}>
  <ChevronLeft className="w-4" />
</Button>
```
and the symmetric next:
```
<Button variant="ghost" size="icon" className="ctm-tech-bar__arrow"
        onClick={() => setTechPage(p => Math.min(totalPages - 1, p + 1))}
        disabled={techPage >= totalPages - 1}>
  <ChevronRight className="w-4" />
</Button>
```
- Keep the `ctm-tech-bar__arrow` class so the **24px sizing** (`width:24px; height:24px`) is preserved over `size="icon"` defaults.
- Preserve disabled logic exactly (`techPage === 0` / `techPage >= totalPages - 1`).
- This matches the date-nav arrows (CustomTimeModal.tsx:727/747) which already use `Button variant="ghost" size="icon"`.
- CSS note: `Button` brings its own hover/focus; the `.ctm-tech-bar__arrow:hover` rule (§6) may be dropped or kept harmlessly. Keep `:disabled { opacity:.25 }` if `Button`'s disabled styling differs visually — verify in build.

### AC mapping
AC-13 (arrows use shared `Button` ghost/icon; raw markup removed). ✓

---

## 8. SE-UX-7 (P3) — Dead CSS, a11y bands, no emoji

### Dead CSS to delete (CustomTimeModal.css)
- `.ctm-timelines__footer` (248)
- `.ctm-timelines__dots` (254) + `.ctm-timelines__dot` (260) + `.ctm-timelines__dot--active` (270)
- `.ctm-timelines__legend` (276) + `.ctm-timelines__legend-item` (284) + `.ctm-timelines__legend-dot` (289)
Confirm via grep that none of these classes are referenced in `CustomTimeModal.tsx` before deleting (they are orphaned — no JSX uses them). (AC-14)

### Overlay bands — keyboard accessible (CustomTimeModal.tsx:287-296)
The `<div className="tech-timeline__rec-band" onClick=…>` gets:
- `role="button"`
- `tabIndex={0}`
- `onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onApplyRec?.(rec); } }}`
- `aria-label={`Recommended ${fmtTime(dates.start, companyTz)}–${fmtTime(dates.end, companyTz)}`}` (en-dash between start/end; no tech name needed, the band sits in the tech's column).
- Keep existing `onClick` (stops propagation + `onApplyRec`). Keep the `title` tooltip. (AC-15)

### Map info-window — drop emoji (CustomTimeModal.tsx:473-474)
- Line 473: remove `🕓 ` prefix → `<div style="color:#6b7280">${timeStr}</div>`.
- Line 474: remove `🔧 ` prefix → `<div style="color:#6b7280">${job.service_name}</div>`.
- Keep the surrounding conditionals and the time/service text. (AC-16)
- (The `#6b7280`/`#9ca3af` inline colors here are inside a Google Maps InfoWindow HTML string — not Albusto CSS scope; leave them, only the emoji are removed.)

---

## Cross-cutting edge cases (consolidated)
1. **`technicians[0]` missing** — `rec.technicians?.[0]` is `undefined`: card omits the tech line (existing `{tech?.name && …}`); `tempFromRec` still works (reads score/confidence only); `applyRecommendation` already guards `if (!techId) return`. Temp-bar + flag + sub still render. No crash.
2. **Score boundary at tier thresholds** — tier is the engine's `confidence` enum (read-only); bar color follows it; bar height follows clamped score. No re-derivation in the UI, so thresholds (`>=85`, `>=70` in `confidenceClass`) are irrelevant to the card and untouched.
3. **`score > 100` or `< 0`** — `clamp(round(score),0,100)` → full / empty bar; card still clickable; `aria-label` shows the raw rounded score.
4. **Reschedule/edit (`isNewJob === false`)** — no fetch, `recsEnabled` false, `showRecPanel` false, no temp-bar/panel/empty-state/overlay; tech bar renders but `recommendedTechIds` empty and `suggestedTechId` may be set only via `preselectTechId` (copy-job) — its pill copy changes "Suggested"→"Preselected" (the one shared label). This is intended (the preselected lane exists in both modes); it is a label-only change, no behavioral diff. Everything else byte-for-byte unaffected.
5. **`explanation === ''`** — UI falls back to `REC_FALLBACK_REASON`; engine never emits `''` (§1 fallback) so this is defense-in-depth.
6. **Empty list while enabled** — state 3 empty copy, panel stays (no vanish).

## Acceptance traceability
AC-1..3 → §1 · AC-4,5 → §2,§3 · AC-6,7 → §3,§4 · AC-8,9 → §4 · AC-10,11 → §5 · AC-12 → §6 · AC-13 → §7 · AC-14,15,16 → §8.

## Build / verification gate
- Frontend: `npm run build` (tsc -b) must pass — prod Docker is stricter (no unused locals): ensure removed `score`/`confidence` spans don't leave unused vars; `tempFromRec`/`REC_FALLBACK_REASON` are used.
- Engine: `node --test` in `slot-engine/` green; explanation assertions are shape-only.
- No user-facing "Blanc"; no `--blanc-*` / `Blanc*` renames.
