# Тест-кейсы: MOBILE-TECH-APP-002 — iOS field-tech app parity (Finance-on-job / Tasks / Search)

**Date:** 2026-07-06 · **Sources:** `Docs/specs/MOBILE-TECH-APP-002-SPEC.md` (§-refs below), `Docs/requirements.md` §MOBILE-TECH-APP-002 (AC-1..11), `Docs/architecture.md` §MOBILE-TECH-APP-002 (module map).
**Target repo:** `albusto-mobile` (jest-expo harness, 44/44 green today). Conventions verified in code: tests are **co-located** (`src/lib/foo.test.ts`, `src/sync/engine.test.ts` style), pure libs tested headless, API orchestration tested via `jest.mock('@/api/client')` (see `engine.test.ts`), `client.ts` itself testable with a `global.fetch` mock. **NO component/render harness exists** (no @testing-library/react-native) → all UI behavior is TYPE: MANUAL (simulator/device). `tsc --noEmit` and `expo prebuild` are release gates.

**Backend note (checklist deviation, justified):** AC-11 = zero backend diffs, so the standard 401/403-middleware and cross-company-isolation *API* tests are NOT re-written here — those gates live in the untouched backend and its existing suites. Server-side scoping is instead verified from the client side: the app must send NO scope filters (TC-SEC-1, TC-API-3) and the real-account checks TC-UI-14 / TC-UI-19 (§8.5 release verification, AC-6/AC-9).

### Покрытие
- Всего тест-кейсов: **69**
- P0: **25** | P1: **24** | P2: **16** | P3: **4**
- Unit (jest): **32** | Integration (jest, mocked client/fetch): **7** | MANUAL (simulator/device/real backend): **24** | STATIC (grep/build gate): **6**

Priorities: P0 = data-integrity + contract hinges (dirty-flag/AC-3, envelope parsing/G1, money coercion, no-SQLite-writes/AC-8, release gates) · P1 = core UX logic · P2 = degradations/edge · P3 = polish/a11y.

---

## A. `api/client` error-envelope parsing (§2.4, G1, E3) — suite `src/api/client.test.ts`

Mock: `global.fetch = jest.fn()` returning `{ok:false, status, text: async () => body}` shaped responses (plus a 2xx case). No `@/api/client` mock — this suite tests the real module.

### TC-CLI-1: Nested envelope `{ok:false, error:{code,message}}` → ApiError.code + message extracted
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** §2.4 row 3 (estimates/invoices/tasks producers), G1, E3
- **Входные данные:** fetch → status 409, body `{"ok":false,"error":{"code":"ARCHIVED","message":"Estimate is archived"}}`
- **Шаги:** call `getJson('/api/estimates/1')`, catch.
- **Ожидаемый результат:** thrown `ApiError` with `status=409`, `code='ARCHIVED'`, `message='Estimate is archived'`. **NOT** `[object Object]`, **NOT** `code=undefined` (that is today's bug — this test must fail on master @ 59b8860 and pass after §2.4).
- **Файл для теста:** `src/api/client.test.ts`

### TC-CLI-2: Legacy flat `{code,message}` envelope — regression
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** §2.4 row 1 (auth middleware)
- **Входные данные:** status 401, body `{"code":"AUTH_INVALID","message":"Token expired"}`
- **Ожидаемый результат:** `code='AUTH_INVALID'`, `message='Token expired'` — unchanged behavior after the §2.4 extension.
- **Файл для теста:** `src/api/client.test.ts`

### TC-CLI-3: Legacy `{error:"string"}` envelope — regression
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** §2.4 row 2 (jobs.js/sync.js), G10 (`GET /api/jobs/:id` 404 flat)
- **Входные данные:** status 404, body `{"ok":false,"error":"Job not found"}`
- **Ожидаемый результат:** `message='Job not found'`, `code=undefined`. (This is the S-SRCH-10 trigger — message keying is forbidden, status 404 is what the UI maps.)
- **Файл для теста:** `src/api/client.test.ts`

### TC-CLI-4: Price-book `{error:"code_string", message}` — message wins, top-level code preserved
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** §2.4 row 4, G9
- **Входные данные:** status 403, body `{"error":"forbidden","message":"Missing permission price_book.view"}`
- **Ожидаемый результат:** `message='Missing permission price_book.view'` (message wins per §2.4 rule); `code` stays from top level (`parsed.code` absent → undefined; `error` is a string so it must NOT be mistaken for a code object).
- **Файл для теста:** `src/api/client.test.ts`

### TC-CLI-5: Non-JSON / empty error body → raw text fallback, no throw-in-throw
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** §2.4 rule (`?? rawBody`), §2.1 loading-must-resolve
- **Входные данные:** (a) status 502, body `<html>Bad gateway</html>`; (b) status 500, body `''`
- **Ожидаемый результат:** (a) `message='<html>Bad gateway</html>'`; (b) `message='HTTP 500'`; `code=undefined` in both; the parser never throws its own exception.
- **Файл для теста:** `src/api/client.test.ts`

### TC-CLI-6: Nested envelope with partial object `{error:{}}` → safe undefineds
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** §2.4 extraction rule (defensive branch)
- **Входные данные:** status 400, body `{"ok":false,"error":{}}`
- **Ожидаемый результат:** `code=undefined`, `message` falls back to the raw body string (per rule chain `parsed.message ?? … ?? rawBody`). No crash.
- **Файл для теста:** `src/api/client.test.ts`

---

## B. `lib/documents` — draft model, dirty flag, money, totals (§3.4, §2.5, G4/G8, E8/E10) — suite `src/lib/documents.test.ts`

Named suite from §8.4. Pure lib, no mocks.

### TC-DOC-1: Untouched items ⇒ PUT payload has NO `items` key (AC-3 hinge)
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** §3.4.2, E10, AC-3 "untouched ⇒ untouched", architecture risk 1
- **Предусловия:** draft seeded from a GET fixture with 2 items; user edits ONLY `tax_rate` (scalar).
- **Шаги:** build payload via the lib's payload builder.
- **Ожидаемый результат:** `'items' in payload === false` (assert key ABSENCE, e.g. `expect(Object.keys(payload)).not.toContain('items')` — not `toBeUndefined`, since `JSON.stringify` masks the difference downstream but the builder contract is key-absent); `tax_rate` present. `itemsTouched === false`.
- **Файл для теста:** `src/lib/documents.test.ts`

### TC-DOC-2: Touched items ⇒ payload carries the FULL normalized array
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** §3.4.2 (touched → array), AC-3 "edited ⇒ replaced"
- **Предусловия:** draft seeded with 2 items; user edits item[0].quantity 1→3.
- **Ожидаемый результат:** `itemsTouched === true`; `payload.items` = array of ALL lines (both items, not a diff), each matching the §3.4.5 shape `{name, description?, quantity, unit_price, unit?, taxable?, sort_order?, price_book_item_id?}`; quantity/unit_price are numbers.
- **Файл для теста:** `src/lib/documents.test.ts`

### TC-DOC-3: Emptied items ⇒ payload `items: []` (invoice transactional clear)
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** §3.4.2 (emptied → `[]`), §3.4.7 invoice-edit branch, AC-3 "emptied ⇒ cleared", INVOICE-EDIT-ITEMS-001
- **Предусловия:** invoice draft seeded with 2 items; user deletes both lines.
- **Ожидаемый результат:** `payload.items` is `[]` (present, empty array — NOT key-absent, NOT null).
- **Файл для теста:** `src/lib/documents.test.ts`

### TC-DOC-4: Every line operation sets `itemsTouched`; scalar edits never do
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** §3.4.2 ("set by ANY add/remove/edit/reorder; never by scalar-only edits")
- **Входные данные:** four independent drafts: (a) add line, (b) remove line, (c) edit line name, (d) reorder lines; plus (e) edit `discount_value` only, (f) edit `tax_rate` only.
- **Ожидаемый результат:** (a)-(d) `itemsTouched===true`; (e)-(f) `itemsTouched===false`. Also: add-then-remove-back (net no-op) still `true` — the flag tracks touch, not deep-equality.
- **Файл для теста:** `src/lib/documents.test.ts`

### TC-DOC-5: Money coercion — pg JSON-strings → numbers, `formatMoney`
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** §2.5, G11, architecture risk 2
- **Входные данные:** `toNumber('1234.5')`, `toNumber('0.00')`, `toNumber(7)`, `toNumber(null)`, `toNumber(undefined)`, `toNumber('')`, `toNumber('abc')`; `formatMoney(1234.5)`
- **Ожидаемый результат:** `1234.5 / 0 / 7 / 0 / 0 / 0 / 0` (nullish + non-numeric → safe 0, never `NaN` — a `NaN` reaching a total is the failure mode); `formatMoney(1234.5) === '$1,234.50'` (§2.5 exact format).
- **Файл для теста:** `src/lib/documents.test.ts`

### TC-DOC-6: Estimate totals preview — pct discount cap 100, fixed cap subtotal, tax on (taxable − discount)⁺
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** §3.4.4, architecture §1 totals math
- **Входные данные:** lines `[{qty:2, unit_price:'50', taxable:true}, {qty:1, unit_price:'25', taxable:false}]` (subtotal 125, taxable_subtotal 100); cases: (a) `discount_type:'pct', discount_value:150` → capped 100% ⇒ discount 125; (b) `'fixed', 200` → capped at subtotal 125; (c) `'fixed', 110`, `tax_rate:6.25` → tax = round((100−110)⁺ × 0.0625, 2) = **0** (negative clamps to 0); (d) `'pct', 10`, `tax_rate:6.25` → discount 12.5, tax = round((100−12.5)×0.0625,2)=5.47, total = 125−12.5+5.47.
- **Ожидаемый результат:** exact numbers above; line `amount = qty × unit_price` throughout.
- **Файл для теста:** `src/lib/documents.test.ts`

### TC-DOC-7: Invoice totals preview — tax on full subtotal, flat `discount_amount`
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** §3.4.4 (invoice formula differs from estimate)
- **Входные данные:** same lines as TC-DOC-6, `tax_rate:6.25`, `discount_amount:'10'` (string — coercion path)
- **Ожидаемый результат:** tax = round(125 × 0.0625, 2) = 7.81 (NO taxable-subset, NO discount subtraction before tax); total = 125 − 10 + 7.81 = 122.81.
- **Файл для теста:** `src/lib/documents.test.ts`

### TC-DOC-8: Zero-line Save gate matrix (estimate vs invoice, create vs edit, hasSummary)
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** §3.4.7, G4/G5, S-FIN-13/14, E8
- **Входные данные:** lib's `canSave(draft)`-style guard: (a) estimate create, 0 lines; (b) estimate create, 1 line; (c) estimate edit, 0 lines, `hasSummary=false`; (d) estimate edit, 0 lines, `hasSummary=true`; (e) invoice create, 0 lines; (f) invoice edit, 0 lines.
- **Ожидаемый результат:** blocked / allowed / blocked / allowed / blocked / **allowed** (invoice edit-clear is legal per AC-3; UI adds a confirm, the lib allows). Server `400 VALIDATION 'Estimate requires at least one item or Summary'` stays unreachable.
- **Файл для теста:** `src/lib/documents.test.ts`

### TC-DOC-9: Item input normalization mirrors server `normalizeItem` limits
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** §3.4.1 (qty > 0, price ≥ 0, name required — server 400s unreachable)
- **Входные данные:** freeform line attempts: name `''`/`'  '`; qty `0`, `-1`, `'2'`; unit_price `-5`, `'0'`, `'12.50'`
- **Ожидаемый результат:** empty/whitespace name rejected at lib level; qty coerced to number and floored at valid `>0` (invalid → rejected or clamped per lib contract — pin ONE behavior and assert it); price `≥0` enforced; string inputs coerce; defaults on add = qty 1, price 0 (§3.4.1).
- **Файл для теста:** `src/lib/documents.test.ts`

### TC-DOC-10: Rounding — 2-decimal `round` half-cent cases in both formulas
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** §3.4.4 / §2.5 (preview-only, but must not visibly diverge from server on common inputs)
- **Входные данные:** qty 3 × unit_price '33.335'; tax_rate 6.625 on subtotal 100.005
- **Ожидаемый результат:** amounts and tax round to exactly 2 decimals via the lib's `round(x,2)`; no floating artifacts like `6.6300000001` in the returned numbers.
- **Файл для теста:** `src/lib/documents.test.ts`

---

## C. `lib/priceBook` — expand coercion, mappings, category filter (§3.5, G9, D3) — suite `src/lib/priceBook.test.ts`

Named suite from §8.4. Pure lib.

### TC-PB-1: Group expand rows → draft lines with string→number coercion, order preserved
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S-FIN-23, G9/§6 row 12 (`quantity`/`unit_price` are strings), AC-2 (group bulk-add persists exactly)
- **Входные данные:** `expandRowsToLines([{name:'Compressor', description:'OEM', quantity:'2', unit:'pc', unit_price:'189.00', taxable:true}, {name:'Labor', quantity:'1.5', unit_price:'95', taxable:false}])`
- **Ожидаемый результат:** 2 draft lines in the same order; `quantity===2` and `1.5` (numbers), `unit_price===189` and `95` (numbers); name/description/unit/taxable carried. These values feed the SAVE payload — a string leaking through would corrupt the created document (hence P0).
- **Файл для теста:** `src/lib/priceBook.test.ts`

### TC-PB-2: Single Item → one draft line (prefill + `price_book_item_id` carried, qty 1)
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S-FIN-22, §3.4.5 payload shape
- **Входные данные:** `itemToLine({id: 42, name:'Drain pump', unit_price:'75.00', taxable:true, unit:'pc'})`
- **Ожидаемый результат:** line `{name:'Drain pump', quantity:1, unit_price:75, taxable:true, unit:'pc', price_book_item_id:42}` — id carried so the server links the catalog item; qty defaults 1 and stays editable (lib returns a plain mutable draft line).
- **Файл для теста:** `src/lib/priceBook.test.ts`

### TC-PB-3: Client-side group filter by `category_id` (G9 — no server param)
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** §3.5 S-FIN-22, G9, architecture risk 3
- **Входные данные:** `filterGroupsByCategory(groups, categoryId)` with groups carrying `category_id` values `7`, `'7'`, `8`, `null`; filter for category `'7'`
- **Ожидаемый результат:** groups with category 7 returned regardless of number/string typing (compare `String(id)` — §2.5 id rule); `null`-category and other-category groups excluded; empty input array → `[]`.
- **Файл для теста:** `src/lib/priceBook.test.ts`

### TC-PB-4: Malformed expand row → safe defaults, no NaN lines
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** §3.5 (defensive), §2.5
- **Входные данные:** expand row `{name:'X', quantity:null, unit_price:'abc'}`
- **Ожидаемый результат:** line gets qty fallback (1) and price fallback (0) — or the row is dropped; pin ONE behavior; never a `NaN` in a draft line.
- **Файл для теста:** `src/lib/priceBook.test.ts`

---

## D. `lib/tasks` — grouping, optimistic reducer, parent model (§4, G2/G3) — suite `src/lib/tasks.test.ts`

Named suite from §8.4. Pure lib. Fixtures = task rows per §6 row 14 shape.

### TC-TSK-1: Grouping — Overdue first, Upcoming asc, No-due-date last (stable partition)
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S-TSK-1, G3 (server order `due_at ASC NULLS LAST, created_at DESC` — grouping is a partition, not a re-sort)
- **Входные данные:** `now = 2026-07-06T12:00Z`; tasks pre-sorted in server order: due `07-01`, `07-04`, `07-06T18:00`, `07-09`, `null`, `null`
- **Ожидаемый результат:** groups `Overdue=[07-01, 07-04]` (due_at < now), `Upcoming=[07-06T18:00, 07-09]`, `NoDueDate=[null, null]` — within each group the incoming relative order is preserved (stability assertion).
- **Файл для теста:** `src/lib/tasks.test.ts`

### TC-TSK-2: Due-line boundaries — "Due today" vs "Overdue" at the `now` edge
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** S-TSK-1 row copy ("Due today" / "Due Jul 8" / "Overdue — Jul 2"), §7
- **Входные данные:** `now = 2026-07-06T12:00Z`; due values: `2026-07-06T11:59Z` (past, same day), `2026-07-06T18:00Z` (future, same day), `2026-07-08`, `2026-07-02`
- **Ожидаемый результат:** per spec rule overdue = `due_at < now` strictly: `11:59` → Overdue bucket; `18:00` → Upcoming with label "Due today"; `07-08` → "Due Jul 8"; `07-02` → "Overdue — Jul 2". `done` tasks are never in the Overdue bucket (rule says open+past only).
- **Файл для теста:** `src/lib/tasks.test.ts`

### TC-TSK-3: Optimistic complete — flip in place, reconcile with server task
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S-TSK-7, FR-TSK-2
- **Входные данные:** reducer state of 3 open tasks; action `completeStart(id2)` → then `completeSuccess(id2, serverTask)` where serverTask has `status:'done', completed_at:'…'`
- **Ожидаемый результат:** after `completeStart`: row id2 `status:'done'` optimistically (checked/strikethrough source of truth), row STAYS in place (no removal), per-row `inFlight=true`; after `completeSuccess`: row replaced by `serverTask` verbatim (reconcile — never keep the optimistic guess §2.3.3 exception), `inFlight=false`. Other rows untouched (referential check ok).
- **Файл для теста:** `src/lib/tasks.test.ts`

### TC-TSK-4: Complete failure → revert restores the exact original row
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S-TSK-8, E14
- **Входные данные:** same state; `completeStart(id2)` then `completeFailure(id2)`
- **Ожидаемый результат:** row id2 deep-equals its pre-action snapshot (`status:'open'`, same due_at etc.), `inFlight=false`. List length unchanged. (Alert copy mapping is UI — TC-UI-15.)
- **Файл для теста:** `src/lib/tasks.test.ts`

### TC-TSK-5: Double-tap lock — actions on an in-flight row are no-ops
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** S-TSK-9, §2.3.2
- **Входные данные:** `completeStart(id2)` twice in a row
- **Ожидаемый результат:** second `completeStart` is ignored (state unchanged by the second dispatch); no toggle-back, no duplicate in-flight marker.
- **Файл для теста:** `src/lib/tasks.test.ts`

### TC-TSK-6: Parent row model — all six types + unknown (G2, OQ-M2-1)
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** §4.4 table, G2, AC-7, E16
- **Входные данные:** `parentModel(task)` for `parent_type` ∈ `job` (parent_label 'Chen — Fridge repair'), `lead` ('Chen'), `contact`, `estimate`, `invoice`, `timeline` ('Re: quote'), `'automation_rule'` (unknown future value), and `undefined`
- **Ожидаемый результат:** `job` → `{navigable:true, label:'Chen — Fridge repair'}`; `lead` → `{navigable:false, label:'Lead · Chen'}` (type-prefixed) and same pattern for contact/estimate/invoice; `timeline` → `{navigable:false, label:'Conversation'}` (or parent_label per §4.4); unknown/undefined → `{navigable:false, label:<parent_label or raw type>}` — **no throw for ANY input** (crash here fails AC-7).
- **Файл для теста:** `src/lib/tasks.test.ts`

### TC-TSK-7: Pagination append — defensive dedup by task id
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** S-TSK-5
- **Входные данные:** page1 = tasks ids `[1..100]`, page2 (offset 100) = ids `[100, 101, 102]` (id 100 duplicated by a concurrent insert shifting offsets)
- **Ожидаемый результат:** merged list has each id once (compare `String(id)`), order = page1 order then new page2 rows.
- **Файл для теста:** `src/lib/tasks.test.ts`

---

## E. `lib/search` — predicate, dedup, latest-wins (§5) — suite `src/lib/search.test.ts`

Named suite from §8.4. Pure lib.

### TC-SRCH-1: Local predicate — case-insensitive substring over the 4 fields
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S-SRCH-1, FR-SRCH-1, AC-8 (local tier)
- **Входные данные:** cached `SyncJob`s: `{customer_name:'Mrs. Chen'}`, `{address:'12 Beacon St'}`, `{city:'Quincy'}`, `{service_name:'Dryer Repair'}`, `{customer_name:'Smith'}`; queries `'chen'`, `'BEACON'`, `'quin'`, `'repair'`, `'zzz'`
- **Ожидаемый результат:** each of the first four queries matches exactly its one job (case-insensitive, substring anywhere); `'zzz'` → `[]`. Jobs with `null` in a field don't crash the predicate.
- **Файл для теста:** `src/lib/search.test.ts`

### TC-SRCH-2: Blank / whitespace-only query → no results, no server-tier eligibility
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** S-SRCH-2 ("Whitespace-only = blank"), §5.2 (`query.trim().length ≥ 2` gate)
- **Входные данные:** queries `''`, `'   '`, `'a'` against the eligibility helper + predicate
- **Ожидаемый результат:** `''`/`'   '` → predicate returns nothing (blank state), server-tier eligibility `false`; `'a'` (1 char) → local filter MAY run, server eligibility `false` (min 2 chars).
- **Файл для теста:** `src/lib/search.test.ts`

### TC-SRCH-3: Server/local dedup by `String(id)` — local wins
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S-SRCH-3, E19, §2.5 id rule
- **Входные данные:** local hits with ids `['42', '43']` (SQLite strings); server results with ids `[42, 44]` (JSON numbers)
- **Ожидаемый результат:** "More results" = only id 44 (42 deduped via `String(42)==='42'`, local section keeps it); a strict `===` on raw values (which would NOT dedup `42` vs `'42'`) must fail this test.
- **Файл для теста:** `src/lib/search.test.ts`

### TC-SRCH-4: Latest-request-wins guard — stale response dropped
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** §5.2, E18
- **Входные данные:** guard helper: issue token for query `'che'` (req A), then for `'chen'` (req B); resolve B's result, then A's late result
- **Ожидаемый результат:** B's result is accepted; A's is rejected/ignored by the guard (`isCurrent(tokenA) === false` after B was issued). Applying results out of order can never leave A's rows rendered.
- **Файл для теста:** `src/lib/search.test.ts`

### TC-SRCH-5: Local search at 300 jobs is synchronous and fast (budget by construction)
- **Приоритет:** P3
- **Тип:** Unit
- **Связанный сценарий:** §8.1 (< 100 ms @ 300 jobs; "jest asserts the predicate, perf asserted by construction")
- **Входные данные:** 300 generated jobs; query `'st'`
- **Ожидаемый результат:** plain synchronous call returns correct matches (spot-check count); no async/await in the local path (typing-level assertion: return type is an array, not a Promise).
- **Файл для теста:** `src/lib/search.test.ts`

---

## F. Integration (jest, `jest.mock('@/api/client')` per `engine.test.ts` convention — assert call args = the wire contract)

### TC-API-1: `documentsApi.updateDoc` — items-key presence flows through verbatim
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** §3.4.3, §6 rows 6-7, AC-3 end-to-end (lib → api layer)
- **Моки:** `@/api/client` → `putJson`/`postJson` jest.fn returning `{ok:true, data:{...}}`
- **Шаги:** call `updateDoc('invoice', id, payloadUntouched)` and `updateDoc('invoice', id, payloadEmptied)` where payloads come from the REAL `lib/documents` builder (no hand-built fixtures — this is the seam test).
- **Ожидаемый результат:** first call's body arg has NO `items` key; second call's body has `items: []`. Path = `/api/invoices/{id}`. Nothing in the api layer re-adds/strips the key.
- **Файл для теста:** `src/api/documentsApi.test.ts`

### TC-API-2: `documentsApi.sendDoc` — canonical `'sms'`, no `includePaymentLink`
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** §3.6.4, G7, §6 rows 8-9, D5/AC-5
- **Моки:** client postJson → `{ok:true, data:{status:'sent'}}`
- **Входные данные:** `sendDoc('invoice', id, {channel:'sms', recipient:'+16175550100', message:'Hi'})`
- **Ожидаемый результат:** POST body = exactly `{channel:'sms', recipient, message}` — `channel` is never `'text'` (G7 alias not used), `includePaymentLink` key ABSENT (grep-companion: TC-SEC-3).
- **Файл для теста:** `src/api/documentsApi.test.ts`

### TC-API-3: `tasksApi.listTasks` — query string carries ONLY `limit`/`offset`
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** S-TSK-1, G3, D6, AC-6, §2.6 (no owner/assignee/status params — server defaults + scopes)
- **Моки:** client getJson → `{ok:true, data:{tasks:[]}}`
- **Шаги:** `listTasks({limit:100})`, then `listTasks({limit:100, offset:100})`
- **Ожидаемый результат:** called paths are `/api/tasks?limit=100` and `/api/tasks?limit=100&offset=100` — assert the FULL path string contains no `status`, `owner`, `assignee`, `parent_type` substrings. This is the client half of AC-6.
- **Файл для теста:** `src/api/tasksApi.test.ts`

### TC-API-4: `tasksApi.createTask` / `patchTask` — bodies per contract, no `owner_user_id`
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S-TSK-10, §6 rows 16-17, AC-6/AC-7
- **Моки:** client postJson/patch fn → 201 `{ok:true,data:{task}}`
- **Входные данные:** `createTask({parent_type:'job', parent_id:'j1', description:'Order pump', due_at:'2026-07-08T00:00:00Z'})`; `patchTask('t1', {status:'done'})`
- **Ожидаемый результат:** create body = exactly the 4 keys (no `owner_user_id`, no `title` — field is `description`); patch body = `{status:'done'}` (value `'done'`, never `'completed'` — architecture risk 4).
- **Файл для теста:** `src/api/tasksApi.test.ts`

### TC-API-5: `searchApi` — jobs/contacts query strings; `getJobOnline` unwraps job
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** §5.2/§5.3, §6 rows 18-20, G10
- **Моки:** client getJson → G10-shaped fixtures (`{ok,data:{results,total,offset,limit,has_more}}` jobs; `{ok,data:{results,pagination},meta}` contacts; `{ok,data:job}` detail)
- **Ожидаемый результат:** `searchJobs('chen')` → path `/api/jobs?search=chen&limit=20`, returns `results` unwrapped (SyncJob-shaped); `searchContacts('chen')` → `/api/contacts?search=chen&limit=20`; query is URL-encoded (`'mrs chen'` → `mrs%20chen`); no other params ever (no owner filters — §2.6). `getJobOnline('j9')` returns the job object; a 404 `ApiError` propagates (not swallowed).
- **Файл для теста:** `src/api/searchApi.test.ts`

### TC-API-6: `useOnlineQuery` state classifier — ApiError vs network vs 403
- **Приоритет:** P1
- **Тип:** Integration (pure classifier function exported from the hook module — no renderer exists, so the decision logic MUST be extracted pure; testing the hook's render lifecycle itself is TC-UI-1/3 MANUAL)
- **Связанный сценарий:** §2.1 state table, E1/E4, architecture §3 hook contract
- **Входные данные:** classify: `new ApiError(500,'boom')`, `new ApiError(403,'nope')`, `new TypeError('Network request failed')`, `new ApiError(404,'gone')`, plus the pre-check input `sync.offline===true`
- **Ожидаемый результат:** 500 → `error`; 403 → `error` + `forbidden=true`; non-ApiError → `offline` (same classification the SyncEngine uses — cross-check against `src/sync` helper if shared); 404 → `error` with status accessible; offline pre-check → `offline` without calling fetch.
- **Файл для теста:** `src/hooks/useOnlineQuery.test.ts`

### TC-API-7: `priceBookApi` + badge count — read-only paths, silent count failure
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** §3.5 (S-FIN-27), §4.5 (E17), §6 rows 10-13, 15
- **Моки:** client getJson: categories/groups/expand/items fixtures; for count: first `{ok:true,data:{count:3}}`, then reject `ApiError(500)`
- **Ожидаемый результат:** priceBookApi calls only GET paths (`/categories`, `/groups`, `/groups/:id/expand`, `/items?...`) — no POST/PUT/DELETE functions exist in the module; `countTasks()` returns 3 on success and on failure resolves to a sentinel (null/0) WITHOUT throwing (badge fail-silent — callers can't accidentally alert).
- **Файл для теста:** `src/api/tasksApi.test.ts` (count) + `src/api/priceBookApi.test.ts`

---

## G. MANUAL — simulator/device against a real backend (jest mocks the DB — house lesson §8.5). Real `provider` account, prod-DB copy for the release pass.

### TC-UI-1: Finance section happy path on a cached job
- **Приоритет:** P0
- **Тип:** MANUAL
- **Связанный сценарий:** S-FIN-1, AC-1
- **Предусловия:** provider account; job assigned to them with ≥1 estimate + ≥1 invoice (invoice with partial payment so `balance_due > 0`); device online.
- **Шаги:** open the job from Schedule.
- **Ожидаемый результат:** cached part (identity/status/notes) renders INSTANTLY; "ESTIMATES & INVOICES" streams in separately (spinner inline, never full-screen); rows show number + status pill + total; the invoice row also "Balance $X"; estimates listed before invoices; old read-only `Field label="Invoice"` line is GONE; row tap → document detail.
- **Файл для теста:** — (simulator)

### TC-UI-2: Finance section — empty job / create affordances
- **Приоритет:** P1
- **Тип:** MANUAL
- **Связанный сценарий:** S-FIN-2, AC-1
- **Шаги:** open a job with zero documents.
- **Ожидаемый результат:** no rows, no "—"/"N/A"; only "+ Estimate" and "+ Invoice". On a job WITH docs, the same affordances appear below the rows.

### TC-UI-3: Offline — finance placeholder while the cached card still renders
- **Приоритет:** P0
- **Тип:** MANUAL
- **Связанный сценарий:** S-FIN-3, E1/E2, AC-1, user story 7
- **Шаги:** airplane mode → open a cached job.
- **Ожидаемый результат:** card renders from cache; finance section = ONE `NeedsConnection` ("Needs connection / Connect to the internet and try again." + Retry); create affordances dimmed, tap → "You're offline / Reconnect to save your changes."; NO infinite spinner. Reconnect + Retry → data loads.

### TC-UI-4: Partial failure — one list errors, the other renders
- **Приоритет:** P2
- **Тип:** MANUAL (needs a fault injection — e.g. Charles/proxy 500 on `/api/invoices`)
- **Связанный сценарий:** S-FIN-4, E5
- **Ожидаемый результат:** estimates rows render; inline row "Couldn't load invoices. Retry" for the failed kind only; section never blanks wholesale; Retry re-fetches only what's needed.

### TC-UI-5: 403 read state (misconfigured tenant)
- **Приоритет:** P2
- **Тип:** MANUAL (temporarily revoke `estimates.view` from the provider role in the access grid)
- **Связанный сценарий:** S-FIN-5, S-TSK-6, E4
- **Ожидаемый результат:** finance section (and Tasks tab body when `tasks.view` revoked) show "Not available for your account" once, no Retry hammering, no crash/logout. Restore perms after.

### TC-UI-6: Document detail render + zero-item gating
- **Приоритет:** P1
- **Тип:** MANUAL
- **Связанный сценарий:** S-FIN-8, S-FIN-12, E8, G6
- **Предусловия:** one zero-item estimate (create via web with summary only), one zero-item invoice, one normal doc of each kind.
- **Ожидаемый результат:** detail shows number-as-title, status, only-existing dates, items with qty × price and amount, totals block; invoice shows Amount paid / Balance due (display-only — NO payment buttons, AC-5). Zero-item estimate: "No items yet", totals $0.00, **Send disabled** + "Add at least one item to send."; zero-item invoice: Send ENABLED (G6). The server's Russian «В эстимейте нет items» must never surface.

### TC-UI-7: Create estimate — editor-first round-trip with Price Book (AC-2 core)
- **Приоритет:** P0
- **Тип:** MANUAL (release-gating, §8.5)
- **Связанный сценарий:** S-FIN-13, S-FIN-22/23/24, §3.4, AC-2, G4
- **Шаги:** job card → "+ Estimate" → editor opens EMPTY (verify via web/API: no draft created yet — G4) → Price Book picker → category → tap one Item (line added, picker stays open) → tap a Group (ALL member lines appended in order) → search field finds an item across categories → Done → edit a line's price inline → add a freeform line (name/qty/price) → totals footer says "Preview" and updates live → Save.
- **Ожидаемый результат:** 201 → `router.replace` to the new detail (Back → JobDetail, NOT a dead editor); reopen the doc — items persist EXACTLY (names, qty, prices, order); open the same estimate in the web CRM — identical items/totals (server totals may differ by rounding from the preview — the DETAIL view must show the server's numbers).

### TC-UI-8: Create invoice + edit round-trip incl. the AC-3 on-wire check
- **Приоритет:** P0
- **Тип:** MANUAL (with a proxy/backend log to inspect the PUT body — the on-device половина of AC-3)
- **Связанный сценарий:** S-FIN-14, §3.4.2-3, AC-3, E10
- **Шаги:** create an invoice with 2 lines → save → reopen editor, change ONLY tax rate → Save (inspect PUT body: NO `items` key) → verify in web the items are byte-identical (ids/timestamps unchanged) → reopen, delete both lines → confirm "Remove all items from this invoice?" → Save (PUT body `items: []`) → verify items cleared in web.
- **Ожидаемый результат:** three wire shapes match TC-DOC-1/2/3 exactly; the untouched save does NOT recreate item rows server-side.

### TC-UI-9: Abandon create + discard confirms
- **Приоритет:** P1
- **Тип:** MANUAL
- **Связанный сценарий:** S-FIN-15, S-TSK-13, E12
- **Ожидаемый результат:** Back/dismiss with unsaved lines → "Discard this estimate?"/"Discard this invoice?" [Keep editing / Discard]; Discard → no document exists server-side (check web); TaskComposer with typed text → "Discard this task?". Dismiss with NOTHING typed → no confirm.

### TC-UI-10: Sent-estimate edit — draft-reset hint + server status flip
- **Приоритет:** P1
- **Тип:** MANUAL
- **Связанный сценарий:** §3.4.6, G8, E9
- **Предусловия:** an estimate in status `sent`.
- **Ожидаемый результат:** editor shows persistent "Saving returns this estimate to draft." under the title; after Save the detail shows status `draft` (server reset); editing a sent INVOICE shows NO such hint and status does not reset.

### TC-UI-11: Archived estimate — stale open + 409 mid-edit
- **Приоритет:** P2
- **Тип:** MANUAL (second actor archives from web mid-flow)
- **Связанный сценарий:** S-FIN-10, S-FIN-18, S-FIN-19, E7
- **Ожидаемый результат:** (a) archived doc opened from a stale link → read-only: Edit/Send hidden, "Archived — read-only."; (b) archive it from web WHILE mobile is editing → Save → alert "This estimate was archived / It's now read-only. Ask the office to restore it." → back to detail showing archived state; (c) delete a doc from web mid-view → mobile 404 → "This document is no longer available" → back, section no longer lists it.

### TC-UI-12: Send sheet — channels, prefill, happy path (AC-4 core)
- **Приоритет:** P0
- **Тип:** MANUAL (release-gating, §8.5)
- **Связанный сценарий:** §3.6.1-4, S-FIN-28 success, AC-4, G11
- **Предусловия:** tenant with Gmail mailbox connected + company SMS number + wallet OK; contact with email+phone.
- **Шаги:** send the estimate by Email; send the invoice by Text.
- **Ожидаемый результат:** channel selector = Email/Text; recipient prefilled from `contact_email`/`contact_phone` per channel (editable; empty prefill → "No email on file"/"No phone on file" hint); Send → toast "Sent", sheet closes, detail refetches → status `sent`; received artifacts (email PDF+public link / SMS) MATCH what the web send produces for the same doc (side-by-side); NO payment framing anywhere in the invoice email flow beyond the server default.

### TC-UI-13: Send error matrix (tenant-level + recoverable)
- **Приоритет:** P2
- **Тип:** MANUAL (fault-inject per case: disconnect mailbox / tenant without proxy number / drained wallet sandbox / bad recipient)
- **Связанный сценарий:** S-FIN-28, E13, §7 copy catalog
- **Ожидаемый результат:** 409 MAILBOX_NOT_CONNECTED → "Email isn't set up / Ask the office to connect the company mailbox." (sheet CLOSES onto alert); 422 NO_PROXY → "Text isn't set up…" (closes); 402 WALLET_BLOCKED → "Sending is paused…" (closes); 422 NO_PHONE → "Enter a valid phone number" (sheet STAYS open); 400 → "Couldn't send / Check the recipient and try again." (stays open). No Gmail/Twilio/wallet internals leak. Offline tap → "You're offline / Reconnect to send."

### TC-UI-14: Tasks tab — list scope, complete, create (AC-6/AC-7 core)
- **Приоритет:** P0
- **Тип:** MANUAL (release-gating, §8.5 — needs a SEEDED SECOND USER with own tasks)
- **Связанный сценарий:** S-TSK-1/7/10/11, AC-6, AC-7, D6
- **Предусловия:** prod-DB copy; provider A (no `tasks.manage`) with open tasks (some overdue, some undated); user B with distinct tasks in the same company.
- **Шаги:** log in as A → Tasks tab → complete one task → create a task from JobDetail → create a task from the tab (job picker).
- **Ожидаемый результат:** list shows ONLY A's tasks (B's absent — server `scopeOwnerId`, app sent no owner param); groups: Overdue first (warning color), then by due date, undated last; complete = one tap → row flips instantly, PATCH lands, next refresh drops it, badge decrements; both created tasks appear in the tab AND in the web CRM with parent = the chosen job and owner = A (AC-7: task from JobDetail carries that job's id); tapping a job-parent task opens that job; a `lead`/`timeline`-parent task (seed one via web) renders as info-only chip ("Lead · X" / "Conversation") with NO press affordance and NO crash.

### TC-UI-15: Task failure paths — revert + copy
- **Приоритет:** P2
- **Тип:** MANUAL (delete the task from web first / airplane mode)
- **Связанный сценарий:** S-TSK-8, S-TSK-12, E14, E15, §7
- **Ожидаемый результат:** completing a web-deleted task → row reverts, "This task is gone / It may have been deleted." + list refetch; offline complete → revert + "You're offline / Reconnect to complete tasks."; composer Save with a stale picker job deleted server-side → "That job is no longer available / Pick another job." + picker refresh; empty description → Save disabled (no server round-trip).

### TC-UI-16: Tasks tab — empty state, offline, pagination, badge
- **Приоритет:** P2
- **Тип:** MANUAL
- **Связанный сценарий:** S-TSK-2/3/4/5, §4.5, E17, FR-TSK-5/6
- **Ожидаемый результат:** zero tasks → "No open tasks." + "Tasks assigned to you show up here." (no error styling); airplane mode → full-tab `NeedsConnection`, pull-to-refresh does NOT toast-storm; >100 tasks (seed) → "Load more" footer appends the next page without duplicates; badge = open count, hidden at 0, refreshes on tab focus / foreground / after complete+create; kill the count endpoint (proxy 500) → badge silently absent, zero alerts; offline → count call SKIPPED (no network attempt in the log).

### TC-UI-17: Search — local tier + airplane mode (AC-8 first half)
- **Приоритет:** P0
- **Тип:** MANUAL
- **Связанный сценарий:** S-SRCH-1/2/8, FR-SRCH-1/4, AC-8
- **Шаги:** Schedule header search affordance → modal opens autofocused → type a cached customer's name; then airplane mode and repeat.
- **Ожидаемый результат:** "On your schedule" results appear per keystroke with no perceptible lag; blank input → hint "Search your jobs, past visits, and customers."; offline: local results still work, server sections collapse to ONE row "Server search needs a connection." — no spinner loop, no toasts; Cancel dismisses.

### TC-UI-18: Search — server tiers, dedup, old-job open, cache purity (AC-8 second half)
- **Приоритет:** P0
- **Тип:** MANUAL (release-gating, §8.5)
- **Связанный сценарий:** S-SRCH-3/4/9/10, E19/E20, D1, AC-8
- **Предусловия:** provider with an assigned job OLDER than the 30-day cache window; ability to snapshot the app's SQLite file + sync cursor (e.g. simulator container copy / debug readout).
- **Шаги:** search the old customer's name → "More results" section returns the old job (local section can't) → snapshot SQLite+cursor → open the job → status actions visible → back → snapshot again.
- **Ожидаемый результат:** the job renders FULLY online (detail from `GET /api/jobs/:id`); a job present in BOTH tiers appears once, in the local section; SQLite bytes + sync cursor are IDENTICAL before/after (AC-8 — byte compare); server tier fires only after ≥300 ms pause and ≥2 chars; killing the jobs search (proxy 500) → compact "Couldn't search the server. Retry" row while local stays; a fast query rewrite never shows stale results (latest-wins observable: type 'che' → 'chen' quickly).

### TC-UI-19: Contacts search → Call (AC-9)
- **Приоритет:** P1
- **Тип:** MANUAL (real device for `tel:`)
- **Связанный сценарий:** S-SRCH-6/7, FR-SRCH-3, AC-9, MOBILE-NO-SOFTPHONE-001
- **Предусловия:** company A provider; company B has a contact with a similar name (cross-tenant regression); a provider-invisible contact (not linked to their jobs) in company A.
- **Ожидаемый результат:** partial-name and phone-fragment queries return matching provider-visible contacts (name + phone(s)); Call button opens the NATIVE dialer with `phone_e164`; company-B and unassigned contacts NEVER appear; a phoneless contact shows name+email, no Call button, non-interactive; no contact detail/edit/create surfaces exist.

### TC-UI-20: v1 regression smoke (AC-10)
- **Приоритет:** P0
- **Тип:** MANUAL (+ the automated half = TC-REL-1)
- **Связанный сценарий:** AC-10, §9 protected core
- **Шаги:** full v1 smoke on the build: login (M01), delta sync + schedule render, job open from cache, status FSM transitions, add note + photo, push token registration; then background the app mid-save (E22) and re-open.
- **Ожидаемый результат:** all v1 flows unchanged; no SQLite migration prompt (SCHEMA_VERSION 1); mid-write backgrounding either lands (focus-refetch reconciles) or alerts per §2.3.4 — no queue, no corruption; 401 mid-flow (expire the session via kcadm) → existing re-login flow, app recovers (E23).

### TC-UI-21: A11y spot checks
- **Приоритет:** P3
- **Тип:** MANUAL (VoiceOver + Dynamic Type)
- **Связанный сценарий:** §8.3
- **Ожидаемый результат:** task checkbox announces role=checkbox + checked state, hit target ≥44pt; task rows read "{description}, due {date}, {parent_label}"; NeedsConnection Retry is a labeled button; money strings scale with Dynamic Type without truncation; Price Book picker / Send sheet / TaskComposer dismiss by swipe AND a visible Cancel/Done.

### TC-UI-22: Editor offline mid-flow — draft survival
- **Приоритет:** P2
- **Тип:** MANUAL
- **Связанный сценарий:** S-FIN-16, S-FIN-21, E2
- **Ожидаемый результат:** airplane mode while typing lines → editor stays usable; Save → "You're offline / Reconnect to save your changes." and the draft is INTACT after dismissing; reconnect → Save succeeds (no auto-retry happened in between); app kill loses the draft (accepted — verify no crash on relaunch).

### TC-UI-23: Concurrent edit — last-write-wins visibility
- **Приоритет:** P3
- **Тип:** MANUAL (two actors)
- **Связанный сценарий:** S-FIN-20, E11
- **Ожидаемый результат:** web edits the doc while mobile's editor is open → mobile Save overwrites (no conflict UI — accepted); returning to detail focus-refetches and shows the final server state; no stale rendering.

### TC-UI-24: Job reassigned while finance loads
- **Приоритет:** P3
- **Тип:** MANUAL (dispatcher reassigns from web at the right moment)
- **Связанный сценарий:** S-FIN-7, E6
- **Ожидаемый результат:** the v1 job-gone overlay wins; finance queries are abandoned (no late alerts/toasts over the overlay); Back returns to Schedule.

---

## H. STATIC — grep / build gates (scriptable, run in CI or pre-merge; repo = `albusto-mobile`)

### TC-SEC-1: No client-side scope filters anywhere
- **Приоритет:** P0
- **Тип:** STATIC (grep)
- **Связанный сценарий:** §2.6, §8.2, AC-6
- **Шаги:** `grep -rn "assignee_id\|owner_user_id" src/` (excluding type definitions of RESPONSE shapes — `owner_user_id` may appear as a read field in `Task` types).
- **Ожидаемый результат:** zero hits in any REQUEST-building code path (query strings, POST bodies). Complements TC-API-3/4.

### TC-SEC-2: No `include_archived`, no price-book writes, no unused task routes
- **Приоритет:** P1
- **Тип:** STATIC (grep)
- **Связанный сценарий:** §8.2, S-FIN-27, §6 "Explicitly NOT called", OQ-M2-4
- **Шаги:** `grep -rn "include_archived\|price-book/import\|price-book/export" src/`; verify `priceBookApi.ts` exports only the 4 GET functions; `grep -rn "tasks/assignees\|/api/tasks.*DELETE" src/`.
- **Ожидаемый результат:** zero hits / reads-only module.

### TC-SEC-3: No payment surfaces (AC-5)
- **Приоритет:** P0
- **Тип:** STATIC (grep + screen audit note)
- **Связанный сценарий:** §3.7, D5, AC-5
- **Шаги:** `grep -rn "record-payment\|stripe-terminal\|includePaymentLink\|collect_offline" src/`
- **Ожидаемый результат:** no hits beyond the pre-existing dormant v1.5 seed (pin its exact file in the test log); `includePaymentLink` appears NOWHERE (always omitted). MANUAL companion: screen audit during TC-UI-6/12 confirms no payment UI.

### TC-SEC-4: No new SQLite writes from online fetch paths (D1/AC-8 hinge)
- **Приоритет:** P0
- **Тип:** STATIC (grep)
- **Связанный сценарий:** §2.6, §5.5, E20, architecture risk 5, §9 protected core
- **Шаги:** list all import sites/callers of `db/jobsRepo` write functions (and any `src/db/*` write API) before/after the diff; confirm `src/db/schema.ts` SCHEMA_VERSION === 1; confirm zero imports of `src/db` write functions from `src/api/searchApi.ts`, `src/app/job/[id].tsx` online branch, and all new modules.
- **Ожидаемый результат:** the set of write callers is IDENTICAL to master @ 59b8860; no new migration files. Runtime companion: TC-UI-18 byte-compare.

### TC-SEC-5: Backend repo untouched (AC-11)
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** AC-11, §9
- **Шаги:** `git -C <backend repo> status --porcelain` at merge time; `ls backend/migrations | tail -1`.
- **Ожидаемый результат:** zero diffs; highest migration = 155.

### TC-REL-1: Quality gates — jest green (44 existing + new named suites) + tsc + prebuild
- **Приоритет:** P0
- **Тип:** STATIC (build gate)
- **Связанный сценарий:** §8.4, AC-10
- **Шаги:** in `albusto-mobile`: `npx jest` (worktree note: add `--testPathIgnorePatterns "/node_modules/"` per JOBS-UX-RBAC-001 gotcha), `npx tsc --noEmit`, `npx expo prebuild --no-install` (clean tree).
- **Ожидаемый результат:** ALL suites green — the 7 existing (44 tests) plus the new named suites `documents`, `priceBook`, `tasks`, `search`, `client` (§8.4 names them explicitly); tsc clean; prebuild applies.

---

## Coverage matrix (FR/AC → TC)

| Req | Covered by | Notes |
|---|---|---|
| FR-FIN-1 | TC-UI-1/2/3/4/5, TC-API-6 | section render is MANUAL (no RTL harness) |
| FR-FIN-2 | TC-UI-6, TC-UI-11, TC-CLI-1 | |
| FR-FIN-3 | TC-UI-7/8/9, TC-DOC-8 | editor-first per G4 |
| FR-FIN-4 | TC-DOC-1..4/9, TC-API-1, TC-UI-8/10/22/23 | AC-3 chain: lib → api → wire |
| FR-FIN-5 | TC-PB-1..4, TC-API-7, TC-UI-7, TC-SEC-2 | |
| FR-FIN-6 | TC-API-2, TC-UI-12/13, TC-CLI-1 | |
| FR-FIN-7 | TC-SEC-3, TC-UI-6/12 | |
| FR-TSK-1 | TC-TSK-1/2/7, TC-API-3, TC-UI-14/16 | |
| FR-TSK-2 | TC-TSK-3/4/5, TC-API-4, TC-UI-14/15 | |
| FR-TSK-3 | TC-API-4, TC-UI-14/15, TC-UI-9 | |
| FR-TSK-4 | TC-TSK-6, TC-UI-14 (job-tap + info-only) | S-TSK-14 cache-miss tap = TC-UI-18 fallback path |
| FR-TSK-5 | TC-API-7 (silent count), TC-UI-16 | nice-to-have → P2 |
| FR-TSK-6 | TC-UI-16 (offline tab), TC-SEC-4 | |
| FR-SRCH-1 | TC-SRCH-1/2/5, TC-UI-17 | |
| FR-SRCH-2 | TC-SRCH-3/4, TC-API-5, TC-UI-18 | |
| FR-SRCH-3 | TC-API-5, TC-UI-19 | |
| FR-SRCH-4 | TC-UI-17, TC-UI-18 (500 row), TC-SRCH-2 | |
| AC-1 | TC-UI-1/2/3 | |
| AC-2 | TC-UI-7 (P0 manual — release-gating) | |
| AC-3 | **TC-DOC-1/2/3/4 + TC-API-1 (jest) + TC-UI-8 (on-wire)** | the feature's #1 hinge |
| AC-4 | TC-UI-12 (artifact parity is inherently manual) | |
| AC-5 | TC-SEC-3 + screen audits in TC-UI-6/12 | |
| AC-6 | TC-API-3 + TC-SEC-1 (client half) + TC-UI-14 (server half, seeded 2nd user) | jest cannot prove server scoping — §8.5 house lesson |
| AC-7 | TC-TSK-6 (unknown-type no-crash) + TC-UI-14 | |
| AC-8 | TC-SRCH-1/3 + TC-UI-17/18 (byte-compare) + TC-SEC-4 | |
| AC-9 | TC-UI-19 | server-scoping regression — manual only (backend untouched, no app-side logic to unit-test) |
| AC-10 | TC-REL-1 (jest/tsc) + TC-UI-20 (smoke) | |
| AC-11 | TC-SEC-5 | |
| §2.4/G1 | TC-CLI-1..6 | |
| §2.5 money | TC-DOC-5/7, TC-PB-1 | |
| E1..E23 | E1→UI-3/16/17 · E2→UI-3/22 · E3→CLI-1 · E4→UI-5 · E5→UI-4 · E6→UI-24 · E7→UI-11 · E8→DOC-8/UI-6 · E9→UI-10 · E10→DOC-1/API-1/UI-8 · E11→UI-23 · E12→UI-9 · E13→UI-13 · E14→TSK-4/UI-15 · E15→UI-15/18 · E16→TSK-6 · E17→API-7/UI-16 · E18→SRCH-4 · E19→SRCH-3/UI-18 · E20→UI-18/SEC-4 · E21→UI-16 (Load more) + S-FIN-6 passive row in UI-1 setup w/ >20 docs (P3, fold into UI-1 if seeded) · E22/E23→UI-20 | |

**Known gaps (accepted, with reasons):**
1. **UI render states of `useOnlineQuery`/`NeedsConnection`/section components have no automated tests** — the repo has no component-render harness (no @testing-library/react-native, decision stands from v1). Mitigated: decision logic extracted pure (TC-API-6) + MANUAL suite G. If a render harness is ever added, TC-UI-1/3/16/17 are the first candidates to automate.
2. **AC-4 "artifacts match web"** cannot be automated from the app repo (email/SMS dispatch is backend + external) — TC-UI-12 manual side-by-side only.
3. **S-FIN-6 ">20 docs passive row"** covered only if seeded during TC-UI-1 (P3 — realistic jobs have <10 docs).
4. **Debounce timing (≥300 ms) and the <100 ms local budget** asserted by construction/observation (TC-SRCH-5, TC-UI-18), not by timer-mock tests — timer tests on debounce hooks without a render harness are brittle; the eligibility helper (min-2-chars) IS unit-tested (TC-SRCH-2).
5. **Copy catalog §7** verified opportunistically inside the manual cases that trigger each alert (UI-3/9/10/11/13/15/16), not as a standalone sweep.
