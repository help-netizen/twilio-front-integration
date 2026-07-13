# Test Cases: RELY-LEADS-SETTINGS-001 — Rely Leads settings + ingest acceptance filter with rejected-lead marker

**Spec (AUTHORITATIVE):** `Docs/specs/RELY-LEADS-SETTINGS-001.md` (scenarios S-1..7, F-1..17, R-1..7, U-1..8, D-1..2; pinned semantics P-1..P-14; decision matrix §5 M1–M19; invariants §9). **Architecture:** `Docs/architecture.md` «RELY-LEADS-SETTINGS-001» (A1–A4, D1–D9, test seams). **Requirements:** `Docs/requirements.md` «RELY-LEADS-SETTINGS-001» (US-1..6, FR-1..11, NFR-1..8).
**Builds on:** MARKETPLACE-LEADGEN-SPLIT-001 cases (`Docs/test-cases/MARKETPLACE-LEADGEN-SPLIT-001*.md` — stay valid, one pre-authorized amendment below) and SERVICE-TERR-002 cases (`tests/territoryService.test.js`, `tests/serviceTerritoryZip.test.js` — the seam is reused as-is, its suites are the P-3 geocode-null proof and are NOT restated here).

## Locked design facts these cases assert against (from spec/arch — do not re-litigate)

1. **Catalogs (verbatim, order = matcher precedence):** `RELY_UNIT_TYPES` (12): Washer · Dryer · Refrigerator · Freezer · Dishwasher · Range · Oven · Cooktop · Microwave · Ice Maker · Garbage Disposal · Vent Hood. `RELY_BRANDS` (15): Whirlpool · GE · Samsung · LG · Maytag · Kenmore · KitchenAid · Frigidaire · Bosch · Electrolux · Amana · Sub-Zero · Viking · Thermador · Speed Queen. Single source `backend/src/services/relyLeadsCatalog.js`; FE has NO mirror (A3).
2. **Matcher (P-1):** `norm(s) = s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()`; entry `E` matches raw `R` iff `` ` ${norm(R)} ` `` contains `` ` ${norm(E)} ` ``. **Parser (P-2):** first `/^\s*issue\s*:\s*(.+)$/i` line → unit_raw, first `/^\s*brand\s*:\s*(.+)$/i` line → brand_raw; `Issue 2:` never matches.
3. **Filter contract (D4):** `evaluateRelyLead(payload, companyId)` NEVER throws; verdict `{accepted, reason: 'out_of_area'|'unit_not_serviced'|'brand_not_serviced'|null, extracted:{zip,unit,brand}, active:{zone,unit_types,brands}, error}`; order zone → unit → brand, first fail = single reason; inactive filter ⇒ pass. `isRelyLead` = `String(payload?.JobSource ?? '').trim().toLowerCase() === 'rely'` (P-12).
4. **Marker (R-1, exact shape):** `rely_filter: {rejected:true, reason, evaluated_at:<ISO>, zip, unit, brand}` — rides the SAME INSERT via `createLead(payload, companyId, {systemMetadata:{rely_filter}})`; accepted lead has NO `rely_filter` key at all (never `{rejected:false}`). `RESERVED_METADATA_KEYS = ['rely_filter']` stripped inside `extractCustomMetadata` for EVERY caller (P-9, exported for tests).
5. **Badge predicate (R-4, exact):** `AND NOT COALESCE(metadata @> '{"rely_filter":{"rejected":true}}'::jsonb, false)` appended to `countNewLeads`; `NEW_LEAD_STATUSES` unchanged `['Submitted','New','Review']`; the COALESCE keeps `metadata IS NULL` legacy rows counted.
6. **Settings write (S-3, exact SQL):** `SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('settings', $3::jsonb)` — whole-object top-level merge via `marketplaceQueries.setInstallationSettings`; seeded `seeded_by`/`shared_credential` survive. One `writeEvent({eventType:'settings_updated', payload:{app_key, zone_mode, custom_zip_count, unit_type_count, brand_count}})` per successful PUT; counts only, never the ZIP list.
7. **Settings API resolution (both verbs):** ① appKey ∉ `{'rely-leads'}` → 404 `SETTINGS_NOT_SUPPORTED` ② `getPublishedAppByKey` null → 404 `APP_NOT_FOUND` ③ `findActiveInstallation` null OR `status !== 'connected'` → 404 `APP_NOT_INSTALLED` (P-8). 400 taxonomy: `INVALID_SETTINGS` / `INVALID_ZONE_MODE` / `INVALID_ZIPS` (≤10 raw offending tokens in message) / `ZIP_LIST_TOO_LARGE` (>500) / `INVALID_UNIT_TYPES` / `INVALID_BRANDS` — via `MarketplaceServiceError` through the existing `handleError` envelope `{success:false, code, message, request_id}`.
8. **Log (D-1, exact):** ONE `console.log('[RelyLeadFilter]', JSON.stringify({decision, reason, extracted, active, fail_open_error?, company_id, lead_uuid, serial_id}))` per *evaluated* Rely lead, emitted AFTER `createLead` returns; fail-open additionally `console.error('[RelyLeadFilter] fail-open', err)`. Non-Rely: zero lines, zero queries.
9. **Frozen envelope (FR-11):** rejected Rely lead still answers `201 {success:true, lead_id, serial_id, contact_id, request_id}` — byte-identical shape/status.
10. **Zone lazy-activity (P-4/P-5):** company mode + zip present → `isZipInTerritory` FIRST; `inside:true` ⇒ pass with NO activity queries. `inside:false` OR missing zip → guard `territoryRadiusQueries.getSettings` → `countListZips` (list) / `listRadii().length` (radius); zero data ⇒ zone INACTIVE ⇒ pass; data ⇒ reject `out_of_area`. Custom mode: non-empty list + missing zip ⇒ reject with 0 territory calls. Geocode-null (P-3) reaches the filter as the seam's `{inside:false, mode:'radius'}` — a decision, NOT the error path (already proven never-throw by `tests/territoryService.test.js` TC-TERR2-004 set).
11. **Untouched-by-design:** `src/server.js` mount (`authenticate → requirePermission('tenant.integrations.manage') → requireCompanyAccess` at `/api/marketplace`), `territoryService`, `integrationsAuth`/`integrationScopes`/rate limiter, FSM, `NEW_LEAD_STATUSES`, migrations (NO mig 170).

## Harness & conventions (verified in-repo)

- Jest files in top-level `tests/*.test.js`; mocks by relative path `jest.mock('../backend/src/…')` with `mock*`-prefixed factory closures (pattern `tests/marketplaceLeadgenSplit.test.js:6-29`). `supertest@7` is a devDependency (route-harness precedent: `tests/agentSkillsMcp.test.js` — bare `express()` + injector middleware + real router).
- **Worktree run form (L-012/L-013):** worktrees have NO local `node_modules` — run via the main checkout, with the Keychain flag:
  `node --use-bundled-ca /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js tests/<file> --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit`
  (from the worktree root; the explicit ignore overrides package.json's skip). Report the EXACT command executed (L-011).
- Real-Postgres cases follow `tests/marketplaceLeadgenSplit.db.test.js`: `beforeAll` probe → `dbReady`; every case self-skips (`SKIPPED-NEEDS-DB`) when no mig-169 DB is reachable; fixture rows tagged and deleted in `afterAll`.
- **FE = NO test harness** (no vitest/jest-dom/frontend node_modules). U-group cases are source-STRUCTURAL jest checks + faithful-replica logic per the `tests/pulseContactItem.displayName.test.js` precedent, each paired with a manual/harness verification step against FORM-CANON.
- **Settings-suite mock table** (copy the leadgen factory + extend): `jest.mock('../backend/src/db/marketplaceQueries', …)` with all leadgen keys **plus `setInstallationSettings`, `getConnectedRelySettings`**; `jest.mock('../backend/src/db/territoryRadiusQueries', () => ({ getSettings: mockRadiusGetSettings, countListZips: mockCountListZips, listRadii: mockListRadii }))`; the four sibling mocks (`emailQueries`, `emailMailboxService`, `integrationsService`, `marketplaceProvisioningService`) verbatim from leadgen. Real `marketplaceService` + real `routes/marketplace.js` on top.
- **Filter-suite mock table:** `db/connection` stub + `marketplaceQueries` (only `getConnectedRelySettings`) + `services/territoryService` (`isZipInTerritory`) + `db/territoryRadiusQueries` (guard trio). Helper `stubSettings(settingsOrNull)` resolves `getConnectedRelySettings` with the shape the shipped query fn returns (the installation `metadata` object carrying `{seeded_by, shared_credential, settings}` — align with implementation); `null` = no connected installation. Pure fns (`isRelyLead`, `parseZipList`, `parseDescription`, `matchCatalogEntry`, `buildMarker`) are required directly, no mocks.
- **Ingest-suite mock table:** `jest.mock('../backend/src/middleware/integrationsAuth', () => ({ rejectLegacyAuth: pass, validateHeaders: pass, authenticateIntegration: (req,_res,next)=>{ req.integrationCompanyId = COMPANY; next(); } }))`; `integrationScopes` → `{ requireIntegrationScope: () => pass }`; `rateLimiter` → pass-through. Per-case either (a) mocked `relyLeadFilterService.evaluateRelyLead` (branch/marker cases; keep `jest.requireActual` for `isRelyLead`/`buildMarker`) with real route + mocked `leadsService` (mock must also export a `LeadsServiceError` class — the route's catch references it), or (b) REAL `leadsService` over mocked `db/connection` (guard/badge cases) with `realtimeService`/`zenbookerClient`/`fsmService` mocked per `tests/leadsNewCount.test.js:6-9`; `db.query` SQL-dispatch mock per `tests/yelpCallTask.test.js:53` (`/select api_name from lead_custom_fields/i` → registered rows; `/insert into leads/i` → `{rows:[{uuid:'RL01', serial_id: 4242, id: 77}]}`; uuid-uniqueness probe → `{rows:[]}`).
- **D-log assertion recipe:** `jest.spyOn(console, 'log')`; collect `spy.mock.calls.filter(c => c[0] === '[RelyLeadFilter]')`; `JSON.parse(call[1])` and assert fields — robust to arg order because D5 pins the exact 2-arg form.
- **Baseline rule (order of work):** the Implementer's change must FIRST pass all UNTOUCHED existing suites (stay-green list below, incl. the one pre-authorized amendment); only THEN are the new suites added.

## Coverage

- **Total test cases: 51**
- **P0: 23 · P1: 25 · P2: 3 · P3: 0**
- **unit-pure (no mocks): 4** · **unit-mocked service: 30** · **unit-mocked route (supertest): 6** · **structural (source checks + replica logic): 9** · **db (real Postgres, self-skip): 2**
- Scenario matrix: **41/41** spec scenarios covered (S 7/7, F 17/17, R 7/7, U 8/8, D 2/2) — table at the end.
- 401/403 for the settings API are enforced by the UNTOUCHED `src/server.js:268` mount (invariant §9.8) — pinned structurally (TC-S6-02), not driven end-to-end (no Keycloak in jest; same deviation as every marketplace suite). Tenant isolation is driven at route level (TC-S6-01).

### Named sabotage controls (first-class; procedure: apply the sabotage manually, confirm RED, revert)

| # | Property | Control case(s) | Sabotage | Exact red-condition |
|---|---|---|---|---|
| 1 | The ingest branch actually evaluates Rely leads | TC-R1-01 (+TC-F4-01, TC-D1-01) | **SAB-FILTER-DROP** — delete/skip the `isRelyLead → evaluateRelyLead` block in `integrations-leads.js` (createLead always 2-arg) | TC-R1-01 RED: `mockCreateLead.mock.calls[0][2]` is `undefined` where `{systemMetadata:{rely_filter:{rejected:true, reason:'out_of_area', …}}}` is expected; TC-D1-01 RED: zero `[RelyLeadFilter]` lines where exactly 1 reject line expected |
| 2 | Non-Rely stays byte-identical | TC-F1-01 | **SAB-NONRELY-FILTERED** — remove the `isRelyLead` gate (evaluate every payload) or loosen P-12 (e.g. `includes('rely')`) | TC-F1-01 RED: `mockEvaluateRelyLead` called for `JobSource:'Yelp'`/absent/`'RelyX'` (expected `.not.toHaveBeenCalled()`), and/or a `[RelyLeadFilter]` line appears (expected 0) |
| 3 | External payloads can never write the marker | TC-R2-01 (+TC-R3-01) | **SAB-GUARD-STRIP-DROP** — remove the `RESERVED_METADATA_KEYS` delete-loop from `extractCustomMetadata` | TC-R2-01 RED: the captured `INSERT INTO leads` metadata param contains `"rely_filter":{"rejected":false}` on the accept path (expected: NO `rely_filter` key); TC-R3-01 RED: update merge carries the injected object |
| 4 | Rejected leads never count in the nav badge | TC-R4-01 (+TC-R4-DB-01) | **SAB-BADGE-PREDICATE-DROP** — revert `countNewLeads` to the pre-feature SQL | TC-R4-01 RED: SQL fails `toMatch(/NOT COALESCE\(metadata @> '\{"rely_filter":\{"rejected":true\}\}'::jsonb, false\)/)`; TC-R4-DB-01 RED: count returns 3 (expected 2 — the marked row leaks in) |
| 5 | Company-mode zone goes through the territory seam (radius incl.) | TC-F9-01 (+TC-F6-01, TC-F10-01) | **SAB-ZONE-COMPANY-IGNORE-RADIUS** — resolve zone from `custom_zips` only (company mode never calls `isZipInTerritory`; radius membership ignored) | TC-F9-01 RED: `mockIsZipInTerritory` `.not.toHaveBeenCalled()` where exactly 1 call `(COMPANY, '02043')` expected, and the radius-inside lead's verdict flips (accept→per-sabotage default); TC-F10-01 RED symmetric (radius-outside lead accepted) |
| 6 | Settings API is company-scoped from `req.companyFilter` only | TC-S6-01 | **SAB-SCOPE-DROP** — service/route reads company from params/body/default instead of `companyId(req)` | TC-S6-01 RED: `findActiveInstallation` called with the poisoned `'company-A'` (or the default co) instead of the injected `'company-B'`, and/or company-B receives a 200 with company-A's settings instead of 404 `APP_NOT_INSTALLED` |

### Stay-green list (run after implementation; all must pass UNCHANGED unless marked)

| Suite | Why it must stay green |
|---|---|
| `tests/marketplaceLeadgenSplit.test.js` | Disconnect guard, catalog mapping, structural contracts. **⚠️ ONE pre-authorized amendment (AMEND-1):** TC-C6-01's FRONTEND assertion `expect(frontendSource).not.toMatch(/pro-referral-leads\|rely-leads\|nsa-leads\|lhg-leads/)` becomes `not.toMatch(/pro-referral-leads\|nsa-leads\|lhg-leads/)` — this feature deliberately supersedes LEADGEN-SPLIT "zero frontend work" for the `rely-leads` tile ONLY (requirements preamble; the `IntegrationsPage` gate + dialog + queryKey necessarily contain `'rely-leads'`). The BACKEND half of TC-C6-01 (seamPattern over `integrations-leads.js`/`integrationsAuth.js`/`integrationScopes.js`) must stay green AS-IS — it pins NFR-2: the D5 comment must say `RELY-LEADS-SETTINGS-001` (uppercase — lowercase `rely-leads` would trip it) and no `marketplace*`-named require may enter `integrations-leads.js` (the settings read lives inside `relyLeadFilterService`). TC-G4-02's `revokeCredentialById` count (4) must not change when extending `marketplaceService.js`. |
| `tests/marketplaceLeadgenSplit.db.test.js` | Mig 169 semantics untouched (self-skips without DB). |
| `tests/leadsNewCount.test.js` | `countNewLeads` regex assertions (`company_id = $1`, `lead_lost = false`, `status = ANY`) and the exact 2-param call tolerate the ADDED predicate; `NEW_LEAD_STATUSES` equality pins invariant §9.6; SSE-emit cases pin `emitLeadChange` untouched. |
| `tests/leadsService.convert.test.js`, `tests/leadByContact.test.js`, `tests/agentSkillsBookOnLead.test.js`, `tests/slotEngineHeldLeads.test.js` | `createLead`'s third arg is default-`{}` additive — every existing call site/mocked assertion (they assert `calls[0][0]`/`calls[0][1]` only) is untouched; `convertLead`/`markLost`/`activateLead` untouched (NFR-3). |
| `tests/territoryService.test.js`, `tests/serviceTerritoryZip.test.js` | Invariant §9.5 — the seam is reused, never edited. TC-TERR2-004 set IS the P-3 proof (geocodeZip never throws; transport/no-key/ZERO_RESULTS → null). |
| Yelp set (`tests/yelp*.test.js`, 20+ files) | Yelp leads reach `leadsService.createLead(payload, companyId)` 2-arg (or mock it wholesale) — the filter exists ONLY in the integrations ingest path (NFR-2); `yelpFixtures` untouched. |
| `tests/googleEmailMarketplace.test.js`, `tests/marketplaceTelephonyOverlay.test.js` | `marketplaceService` additions are new exports only; existing flows call none of them. |

## Proposed test files

| File | Kind | Contents |
|---|---|---|
| `tests/relyLeadFilter.test.js` (NEW) | unit-pure + unit-mocked service | pure parser/matcher/discriminator/parseZipList set (F-15, F-17) + `evaluateRelyLead` decision-matrix M1–M18 table-driven over mocked `getConnectedRelySettings`/`territoryService`/`territoryRadiusQueries` (F-2..F-14, F-16) |
| `tests/relyLeadsSettings.test.js` (NEW) | unit-mocked service + route (supertest) | S-group: GET defaults/self-heal/territory block, PUT canonicalization + merge shape + audit event, 400 taxonomy, 404 trio, P-6, tenancy (S-6), D-2 |
| `tests/relyLeadIngest.test.js` (NEW) | unit-mocked route (supertest) + unit-mocked service | F-1/F-17 route edges, R-1/R-2/R-3/R-5/R-6/R-7, R-4 SQL predicate, D-1 log line, FR-11 envelope pin |
| `tests/relyLeadsUi.structural.test.js` (NEW) | structural + replica-logic | U-1..U-8 source pins (gate, FORM-CANON markers, catalogs-from-payload, chip copy, FLAGS filter predicate) + `src/server.js` mount pin (TC-S6-02) + no-"Blanc" scan of the new FE files |
| `tests/relyLeadsSettings.db.test.js` (NEW) | db (real PG, self-skip) | **Justified real-PG pair** — the only two claims mocks cannot prove are Postgres jsonb semantics: (1) the `\|\|` top-level merge preserves seeded keys byte-for-byte, (2) the `@>`/COALESCE badge predicate vs `metadata IS NULL` rows. Two cases, self-skipping, leadgen `.db` pattern. No wider db suite is warranted: everything else is deterministic service logic already pinned by mocks. |

---

## S — Settings API (`tests/relyLeadsSettings.test.js` unless noted)

### TC-S1-01 · GET returns defaults + verbatim catalogs on the seeded no-settings installation — P0 · unit-mocked service · covers S-1 (US-6)
- **Setup:** `getPublishedAppByKey('rely-leads')` → `{id:'app-rely', app_key:'rely-leads', status:'published'}`; `findActiveInstallation(COMPANY,'app-rely')` → `{id:7, status:'connected', metadata:{seeded_by:'MARKETPLACE-LEADGEN-SPLIT-001', shared_credential:true}}` (NO `settings` key); `mockRadiusGetSettings` → `{active_mode:'list'}`; `mockCountListZips` → `12`.
- **Steps:** `await marketplaceService.getAppSettings(COMPANY, 'rely-leads')`.
- **Expected:** result carries `app_key:'rely-leads'`, `installation_id:7`, `settings` deep-equal `{zone:{mode:'company', custom_zips:[]}, unit_types:[], brands:[]}`; `catalogs.unit_types` deep-equal the 12-entry list `['Washer','Dryer','Refrigerator','Freezer','Dishwasher','Range','Oven','Cooktop','Microwave','Ice Maker','Garbage Disposal','Vent Hood']` and `catalogs.brands` the 15-entry list `['Whirlpool','GE','Samsung','LG','Maytag','Kenmore','KitchenAid','Frigidaire','Bosch','Electrolux','Amana','Sub-Zero','Viking','Thermador','Speed Queen']`; `territory` = `{active_mode:'list', has_data:true}`. **No write:** `setInstallationSettings` and `writeEvent` `.not.toHaveBeenCalled()`.

### TC-S1-02 · GET with no `company_territory_settings` row ⇒ `active_mode:'list'`, `has_data:false` — P2 · unit-mocked service · covers S-1 (territory block edge)
- **Setup:** as TC-S1-01 but `mockRadiusGetSettings` → `undefined`/row-absent default (query-layer default `'list'` — align stub with the shipped fn's no-row return) and `mockCountListZips` → `0`.
- **Expected:** `territory` = `{active_mode:'list', has_data:false}`; radius-mode variant (`{active_mode:'radius'}` + `mockListRadii` → `[]`) yields `{active_mode:'radius', has_data:false}`; `countListZips` NOT called in radius mode, `listRadii` NOT called in list mode (mode-correct guard pair).

### TC-S2-01 · stored settings self-heal at read (P-7) — P1 · unit-mocked service · covers S-2
- **Setup:** installation `metadata.settings = {zone:{mode:'teleport'}, unit_types:['Dishwasher','Toaster'], brands:'x'}`.
- **Steps:** `getAppSettings(COMPANY, 'rely-leads')`.
- **Expected:** effective `settings` deep-equal `{zone:{mode:'company', custom_zips:[]}, unit_types:['Dishwasher'], brands:[]}` — unknown mode → `'company'`, non-catalog `'Toaster'` dropped, non-array `brands` → `[]`. **Read-time only:** `setInstallationSettings` `.not.toHaveBeenCalled()` (stored row NOT rewritten).

### TC-S3-01 · PUT happy path — free-form ZIPs canonicalized, catalog casing canonicalized, audit event — P0 · unit-mocked service · covers S-3 (US-1)
- **Setup:** resolution mocks as TC-S1-01; `setInstallationSettings` resolves the updated row (metadata = seeded keys + the settings arg it received).
- **Input:** `updateAppSettings(COMPANY, 'crm-user-1', 'rely-leads', {zone:{mode:'custom', custom_zips:"02301, 02302; 2043\n02744, 02301"}, unit_types:['dishwasher'], brands:[]}, {requestId:'req-t'})`.
- **Expected:** echo `settings.zone.custom_zips` deep-equal `['02301','02302','02043','02744']` (split on `/[\s,;]+/`; `'2043'`→`'02043'` leading-zero recovery; duplicate `'02301'` deduped preserving order); `unit_types` deep-equal `['Dishwasher']` (canonicalized to the EXACT catalog string). `setInstallationSettings` called ONCE with `(COMPANY, 7, settingsObject)` where `settingsObject.updated_at` is a valid ISO timestamp and `settingsObject.updated_by === 'crm-user-1'` (crm_users.id, NOT a Keycloak sub); client-supplied `updated_at`/`updated_by` in the body are ignored. `writeEvent` called EXACTLY ONCE with `expect.objectContaining({eventType:'settings_updated', companyId:COMPANY, installationId:7, requestId:'req-t', payload:{app_key:'rely-leads', zone_mode:'custom', custom_zip_count:4, unit_type_count:1, brand_count:0}})` — payload has NO zips array (PII-lean pin: `JSON.stringify(payload)` does not contain `'02301'`). Absent top-level key defaults: omitting `brands` in a second call ⇒ stored `brands:[]`.

### TC-S3-02 · PUT write goes through the top-level `||` merge fn with the WHOLE settings object — P0 · unit-mocked service (+ structural) · covers S-3 (FR-1, invariant §9.7)
- **Steps:** after TC-S3-01's call, inspect the write seam.
- **Expected:** the ONLY metadata write is `setInstallationSettings` (no raw `db.query` UPDATE from the service, no `jsonb_set` anywhere); its third arg is the COMPLETE settings object (zone+unit_types+brands+updated_*), never a deep path fragment. **Structural companion:** `backend/src/db/marketplaceQueries.js` source for `setInstallationSettings` matches `/COALESCE\(metadata, '\{\}'::jsonb\) \|\| jsonb_build_object\('settings', \$3::jsonb\)/` and does NOT contain `jsonb_set` in that fn. (Real-PG semantics → TC-S3-DB-01.)

### TC-S4-01 · PUT 400 taxonomy — ZIP classes — P1 · unit-mocked service · covers S-4
- **Steps/table:** (a) `{zone:{mode:'custom', custom_zips:'02301, ABCDE'}}` → rejects with `MarketplaceServiceError` `{code:'INVALID_ZIPS', httpStatus:400}` and `message` containing the RAW token `'ABCDE'`; (b) 501 distinct 5-digit ZIPs → `{code:'ZIP_LIST_TOO_LARGE', httpStatus:400}`; (c) message caps offenders at 10: input with 12 bad tokens `BAD01…BAD12` → message names ≤10 raw tokens.
- **Expected (every row):** `setInstallationSettings` and `writeEvent` `.not.toHaveBeenCalled()` — no write, no event on validation failure.

### TC-S4-02 · PUT 400 taxonomy — shape / mode / catalog classes — P1 · unit-mocked service · covers S-4
- **Steps/table:** `{zone:'custom'}` (non-object zone) → `INVALID_SETTINGS`; `unit_types:'Dishwasher'` (non-array list field) → `INVALID_SETTINGS`; `{zone:{mode:'radius'}}` → `INVALID_ZONE_MODE`; `{unit_types:['Toaster']}` → `INVALID_UNIT_TYPES`; `{brands:['Sony']}` → `INVALID_BRANDS`. Case-insensitive canonicalization is NOT a 400: `{brands:['sub-zero','SPEED QUEEN']}` → 200-path with stored `['Sub-Zero','Speed Queen']`.
- **Expected:** each error row: exact `code`, `httpStatus:400`, no write, no event.

### TC-S5-01 · 404 taxonomy + resolution precedes validation — P0 · unit-mocked service · covers S-5
- **Steps/table:** (a) `getAppSettings(COMPANY,'nsa-leads')` (published row exists) → `{code:'SETTINGS_NOT_SUPPORTED', httpStatus:404}` — same for `'pro-referral-leads'`, `'lhg-leads'`, `'lead-generator'`, `'garbage-key'`; `getPublishedAppByKey` `.not.toHaveBeenCalled()` for non-whitelisted keys (whitelist gate is step ①). (b) `'rely-leads'` + `getPublishedAppByKey` → null → `APP_NOT_FOUND`. (c) app found + `findActiveInstallation` → null → `APP_NOT_INSTALLED`. (d) **PUT with an INVALID body** (`unit_types:['Toaster']`) against a company with NO installation → `APP_NOT_INSTALLED` (404 wins over the would-be 400 — resolution precedes validation).
- **Expected:** exact codes/statuses; no write/no event anywhere.

### TC-S5-02 · `provisioning_failed` installation is NOT settings-eligible (P-8) — P1 · unit-mocked service · covers S-5
- **Setup:** `findActiveInstallation` → `{id:8, status:'provisioning_failed', metadata:{}}` (the query returns both statuses — verified).
- **Expected:** GET and PUT both reject `{code:'APP_NOT_INSTALLED', httpStatus:404}`; no write, no event, no territory reads.

### TC-S6-01 · tenancy at route level — company only from `req.companyFilter`, poisoned inputs ignored — P0 · unit-mocked route (supertest) · covers S-6 (US-5, NFR-6) · **SAB-SCOPE-DROP control**
- **Setup:** `express()` app: `app.use(express.json())` → injector `req.companyFilter={company_id:'company-B'}; req.user={crmUser:{id:'crm-b'}}; req.requestId='req-b'` → real `routes/marketplace.js`. Mocks: `getPublishedAppByKey` → app row; `findActiveInstallation` → `null` for `'company-B'`.
- **Steps:** `GET /apps/rely-leads/settings?company_id=company-A` and `PUT /apps/rely-leads/settings` with body `{company_id:'company-A', installation_id: 1, zone:{mode:'company', custom_zips:[]}}`.
- **Expected:** both → `404` body `{success:false, code:'APP_NOT_INSTALLED', message:<any>, request_id:'req-b'}`; `findActiveInstallation` called with `('company-B', <app.id>)` — NEVER with `'company-A'` (params/query/body cannot address a foreign tenant; there is no foreign id to probe by construction); no error message references company A. Second half: same harness with `findActiveInstallation('company-B')` → connected row ⇒ 200 returns B's OWN settings.

### TC-S6-02 · 401/403 mount pin (structural, `src/server.js` untouched) — P1 · structural (in `tests/relyLeadsUi.structural.test.js`) · covers S-6
- **Steps:** read `src/server.js`; locate the `/api/marketplace` mount line.
- **Expected:** line matches `app.use('/api/marketplace', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, marketplaceRouter)` (whitespace-tolerant regex) — the inherited chain that yields 401 (no/invalid token) and 403 (missing `tenant.integrations.manage`) BEFORE the router; `routes/marketplace.js` itself contains NO `req.params`/`req.body`/`req.query` read of a company id (regex: no `company_id` access outside the `companyId(req)` helper).

### TC-S7-01 · PUT `mode:'custom'` + empty list is VALID and stored as-is (P-6) — P1 · unit-mocked service · covers S-7
- **Input:** `{zone:{mode:'custom', custom_zips:[]}, unit_types:[], brands:[]}`.
- **Expected:** resolves 200-path; `setInstallationSettings` called with `zone:{mode:'custom', custom_zips:[]}`; `writeEvent` payload `{…, zone_mode:'custom', custom_zip_count:0, …}`; NO validation error (not an error state — zone filter simply inactive at ingest, matrix M3 → TC-F3-01).

### TC-S3-DB-01 · real-PG: `||` merge preserves seeded keys byte-for-byte — P1 · db (self-skip) · covers S-3 (FR-1) — `tests/relyLeadsSettings.db.test.js`
- **Setup:** `dbReady` probe else `SKIPPED-NEEDS-DB`. Seed (tagged, rolled back in `afterAll`): a `marketplace_installations` row with `metadata = '{"seeded_by":"MARKETPLACE-LEADGEN-SPLIT-001","shared_credential":true}'::jsonb` for a fixture company + the real `rely-leads` app id (or a tagged fixture app row).
- **Steps:** call the REAL `marketplaceQueries.setInstallationSettings(companyId, installationId, {zone:{mode:'custom', custom_zips:['02301']}, unit_types:['Dishwasher'], brands:[], updated_at:'2026-07-13T00:00:00.000Z', updated_by:null})` twice (second call with different settings — replace semantics).
- **Expected:** after each write, `SELECT metadata` shows `seeded_by` and `shared_credential` UNCHANGED at top level; `metadata.settings` equals EXACTLY the last argument (whole-object replace, no deep-merge residue from the previous settings — e.g. first-write `unit_types:['Dishwasher']` gone after a second write with `unit_types:[]`); row `updated_at` bumped. A `metadata = NULL` row variant also works (`COALESCE` leg).

### TC-R4-DB-01 · real-PG: badge predicate vs marker + NULL-metadata rows — P1 · db (self-skip) · covers R-4 (FR-9, invariant §9.9) — `tests/relyLeadsSettings.db.test.js`
- **Setup:** seed 3 tagged `leads` rows for a fixture company, all `status='Submitted'`, `lead_lost=false`: L1 `metadata='{}'`, L2 `metadata='{"rely_filter":{"rejected":true,"reason":"out_of_area","evaluated_at":"2026-07-13T00:00:00.000Z","zip":"02888","unit":null,"brand":null}}'`, L3 `metadata=NULL`.
- **Steps:** real `leadsService.countNewLeads(fixtureCompanyId)`.
- **Expected:** count === **2** (L1 + L3 counted; L2 excluded). Control: with the pre-feature SQL the same fixture returns 3 (SAB-BADGE-PREDICATE-DROP red on this case as count 3). Also assert an UNRELATED marker (`metadata='{"rely_filter":{"rejected":false}}'`) row would be COUNTED (containment is on `{"rejected":true}`).

## F — Ingest filter (`tests/relyLeadFilter.test.js` unless noted)

### TC-F15-01 · parser line-scan set (P-2) — P1 · unit-pure · covers F-15
- **Steps/table (`parseDescription`):** `'Issue: Dishwasher - not draining\nBrand: GE Profile'` → `{unit_raw:'Dishwasher - not draining', brand_raw:'GE Profile'}`; `'Issue 2: Dryer'` alone → `{unit_raw:null, brand_raw:null}` (digit breaks the pattern — secondary units out of scope); `'Issue: Dishwasher\nIssue: Washer'` → `unit_raw:'Dishwasher'` (FIRST line wins); `'issue :  Oven'` → `unit_raw:'Oven'` (space before colon allowed by `/^\s*issue\s*:\s*(.+)$/i`); no `Description` / empty string / no matching line → both null; values trimmed.

### TC-F15-02 · matcher token-containment set (P-1) — P1 · unit-pure · covers F-15
- **Steps/table (`matchCatalogEntry(raw, catalog)`):**
  - `'Dishwasher - not draining'` → `'Dishwasher'`; **`'Dishwasher'` must NOT match `'Washer'`** (space-padded containment: `' dishwasher '` does not contain `' washer '` — substring trap pin).
  - `'GE Profile'` → `'GE'`; `'ridge'` → `null` for brands (word-boundary safe); `'General Electric'` → `null` (no alias table v1 → unrecognized → treated as missing).
  - `'Sub-Zero'`, `'sub zero'`, `'SUB ZERO'` → `'Sub-Zero'`; `'SubZero'` → `null` (single-token norm `subzero`); `'SpeedQueen'` → `null`, `'Speed Queen'` → `'Speed Queen'`.
  - Catalog order = precedence: `'Microwave oven'` → `'Oven'` (Oven idx 6 precedes Microwave idx 8); `'Refrigerator ice maker'` → `'Refrigerator'`; `'Washer and Dryer'` → `'Washer'` (multi-appliance single first match — owner-approved v1).
  - Returns the EXACT canonical catalog string (never the raw), `null` on no match / null raw.

### TC-F15-03 · `parseZipList` normalization set — P1 · unit-pure · covers F-15 (shared PUT seam, S-3/S-4 underpinning)
- **Steps/table:** `"02301, 02302; 2043\n02744, 02301"` → `{zips:['02301','02302','02043','02744'], invalid:[]}` (split `/[\s,;]+/`, `'2043'`→`'02043'`, dedupe order-preserving); `['02301-1234']` (ZIP+4) → `['02301']`; `'02301, ABCDE'` → `{zips:['02301'], invalid:['ABCDE']}` (RAW token reported); string[] and free-form string inputs equivalent; empty/whitespace input → `{zips:[], invalid:[]}`.

### TC-F17-01 · `isRelyLead` discriminator edges (P-12) — P1 · unit-pure · covers F-17
- **Steps/table:** `{JobSource:' RELY '}` → true; `'rely'` → true; `'Rely'` → true; `'RelyX'` → false; `'Rely Leads'` → false; absent key → false; `null` → false; numeric `5` → false; object `{}` → false (`String(...)` coercion, never a throw); no payload (`undefined`) → false.

### TC-F2-01 · no connected installation ⇒ accept-all, marker-free (M1, NFR-8) — P0 · unit-mocked service · covers F-2
- **Setup:** `stubSettings(null)` (hot-path SQL filters `status='connected'` — never-installed / disconnected / provisioning_failed all look identical here).
- **Steps:** `evaluateRelyLead({JobSource:'Rely', PostalCode:'02888', Description:'Issue: Furnace'}, COMPANY)`.
- **Expected:** verdict `{accepted:true, reason:null, active:{zone:false, unit_types:false, brands:false}, error:null}`; `getConnectedRelySettings` called once with `(COMPANY)`; `isZipInTerritory`, `mockRadiusGetSettings`, `mockCountListZips`, `mockListRadii` all `.not.toHaveBeenCalled()`.

### TC-F3-01 · custom zone hit + empty-custom inactive + normalization (M3, M4) — P0 · unit-mocked service · covers F-3 (US-1) and S-7's ingest half
- **Steps/table:** settings `zone:{mode:'custom', custom_zips:['02301','02302','02043','02744']}`: payload `PostalCode:'02744'` → `accepted:true`, `extracted.zip:'02744'`; `PostalCode:'2744'` (dropped leading zero) → ALSO accepted (normalizeZip before comparison). Settings `custom_zips:[]` (P-6): any/no ZIP → `accepted:true`, `active.zone:false`.
- **Expected (all rows):** territory seam + guard mocks `.not.toHaveBeenCalled()` (custom mode = 0 territory calls; total budget = the 1 settings read).

### TC-F4-01 · custom zone miss ⇒ reject `out_of_area`, unit/brand not reached (M5, M17-partial) — P0 · unit-mocked service · covers F-4 · **SAB-FILTER-DROP co-control**
- **Setup:** custom list as above; unit filter ALSO active (`unit_types:['Dishwasher']`) with a payload unit that would ALSO fail (`Description:'Issue: Washer'`).
- **Steps:** `evaluateRelyLead({JobSource:'Rely', PostalCode:'02888', Description:'Issue: Washer'}, COMPANY)`.
- **Expected:** `{accepted:false, reason:'out_of_area'}` — the SINGLE first-fail reason (never `unit_not_serviced`); `extracted.zip:'02888'`; `active:{zone:true, unit_types:true, brands:false}`; verdict shape has exactly the 5 D4 keys.

### TC-F5-01 · custom zone active + missing ZIP ⇒ reject, 0 territory calls (M5a, P-5) — P1 · unit-mocked service · covers F-5
- **Steps:** payload with NO `PostalCode` (and variant `PostalCode:''`), custom list non-empty.
- **Expected:** `{accepted:false, reason:'out_of_area', extracted:{zip:null,…}}`; `isZipInTerritory`/guard mocks never called.

### TC-F6-01 · company list-mode hit ⇒ pass, activity guard NOT executed (M6, P-4) — P0 · unit-mocked service · covers F-6 (US-2)
- **Setup:** settings `zone:{mode:'company', custom_zips:[]}` (or settings key absent — defaults, M2); `mockIsZipInTerritory` → `{inside:true, area:'Brockton', city:'Brockton', state:'MA', zip:'02301', mode:'list'}`.
- **Steps:** `evaluateRelyLead({JobSource:'Rely', PostalCode:'02301'}, COMPANY)`.
- **Expected:** `accepted:true`; `isZipInTerritory` called EXACTLY once with `(COMPANY, '02301')`; **`mockRadiusGetSettings`/`mockCountListZips`/`mockListRadii` `.not.toHaveBeenCalled()`** (cheap-accept-first — containment implies data exists; the P-4 pin).

### TC-F7-01 · company list-mode miss with data ⇒ reject (M7) — P0 · unit-mocked service · covers F-7
- **Setup:** `mockIsZipInTerritory` → `{inside:false, mode:'list'}`; guard: `mockRadiusGetSettings` → `{active_mode:'list'}`, `mockCountListZips` → `41`.
- **Expected:** `{accepted:false, reason:'out_of_area'}`; guard pair called once each (`getSettings`, `countListZips`); `listRadii` not called (mode-correct).

### TC-F8-01 · zero territory data ⇒ zone INACTIVE ⇒ pass (M8, M2 — the [PRODUCT] guard) — P0 · unit-mocked service · covers F-8 (and F-2's M2 default-settings row)
- **Steps/table:** (a) settings ABSENT on a connected installation (M2 defaults: zone=company) + `inside:false` + list mode `countListZips` → `0` ⇒ `accepted:true`, `active.zone:false`; (b) radius mode `mockListRadii` → `[]` ⇒ same; (c) missing ZIP + zero data ⇒ ALSO accept (M11's pass leg). A fresh company with the seeded installation and no territory setup rejects NOTHING on day one.
- **Expected:** verdict accepted, `reason:null`, no marker fields set; `error:null` (this is NOT the fail-open path).

### TC-F9-01 · company radius-mode hit through the SEAM (M9) — P1 · unit-mocked service · covers F-9 (US-2) · **SAB-ZONE-COMPANY-IGNORE-RADIUS control**
- **Setup:** `mockIsZipInTerritory` → `{inside:true, area:'02043', city:'Hingham', state:'MA', zip:'02043', mode:'radius'}` (geocache-hit semantics live INSIDE the seam — reused, not re-tested).
- **Steps:** `evaluateRelyLead({JobSource:'Rely', PostalCode:'02043'}, COMPANY)`.
- **Expected:** `accepted:true`; `isZipInTerritory` called EXACTLY once with `(COMPANY, '02043')`; guard trio `.not.toHaveBeenCalled()`. RED under sabotage #5: the seam is never called and the verdict no longer follows radius membership.

### TC-F10-01 · radius miss + geocode-null pin ⇒ reject as DECISION, not error (M10, M10a, P-3) — P1 · unit-mocked service · covers F-10
- **Steps/table:** (a) outside-all-circles: `mockIsZipInTerritory` → `{inside:false, mode:'radius', zip:'03038'}` + guard `{active_mode:'radius'}`/`mockListRadii` → `[{id:1, radius_miles:25}]` ⇒ `{accepted:false, reason:'out_of_area', error:null}`; (b) geocode-null (Google outage / no key / ZERO_RESULTS on a never-cached ZIP) reaches the filter as the SAME seam shape `{inside:false, mode:'radius', zip:'02043'}` ⇒ SAME reject — assert `error:null` and NO `console.error('[RelyLeadFilter] fail-open', …)` (decision, not fail-open; supersedes the architecture shorthand). The never-throws underpinning = existing `tests/territoryService.test.js` TC-TERR2-004 set (stay-green).
- **Expected:** both rows reject `out_of_area`; guard pair invoked (getSettings + listRadii), `countListZips` never.

### TC-F11-01 · company mode + missing ZIP ⇒ guard decides (M11) — P1 · unit-mocked service · covers F-11
- **Steps/table:** no `PostalCode`; (a) list mode `countListZips` → `41` ⇒ reject `out_of_area`; (b) zero data ⇒ accept (covered structurally in TC-F8-01(c), re-asserted here).
- **Expected:** **`isZipInTerritory` `.not.toHaveBeenCalled()`** (no zip → straight to guard); `extracted.zip: null`.

### TC-F12-01 · unit filter accept / reject / fail-open (M12, M13, M14) — P0 · unit-mocked service · covers F-12
- **Setup:** zone inactive (custom empty), settings `unit_types:['Dishwasher']`.
- **Steps/table:** `Description:'Issue: Dishwasher - not draining'` → `accepted:true`, `extracted.unit:'Dishwasher'` (canonical); `'Issue: Washer'` → `{accepted:false, reason:'unit_not_serviced', extracted:{unit:'Washer'}}`; NO `Issue:` line → accept (`extracted.unit:null`); `'Issue: Furnace'` (unrecognized) → accept — fail-open [OWNER]; `unit_types:[]` ⇒ `active.unit_types:false` ⇒ accept regardless.
- **Expected:** 0 territory/guard calls in every row (pure after the settings read).

### TC-F13-01 · brand filter, evaluated LAST (M15, M16, US-4) — P0 · unit-mocked service · covers F-13
- **Setup:** zone inactive, unit inactive, `brands:['Whirlpool','GE']`.
- **Steps/table:** `Description:'Brand: Kenmore'` → `{accepted:false, reason:'brand_not_serviced', extracted:{brand:'Kenmore'}}`; NO `Brand:` line (the common case) → accept; `'Brand: General Electric'` → accept (unrecognized → missing, P-1); `'Brand: SubZero'` → accept; `'Brand: GE Profile'` → accept (`extracted.brand:'GE'` ∈ selection).

### TC-F14-01 · AND ordering + first-fail single reason (M17) — P0 · unit-mocked service · covers F-14
- **Setup:** all three filters active: custom `['02301']`, `unit_types:['Dishwasher']`, `brands:['Whirlpool']`.
- **Steps/table:** (a) `{PostalCode:'02888', Description:'Issue: Washer\nBrand: Kenmore'}` (fails all three) → reason `'out_of_area'` ONLY; (b) `{PostalCode:'02301', Description:'Issue: Washer\nBrand: Kenmore'}` → `'unit_not_serviced'` (zone passed, unit is first fail; brand matcher result irrelevant); (c) `{PostalCode:'02301', Description:'Issue: Dishwasher\nBrand: Kenmore'}` → `'brand_not_serviced'`; (d) company-mode variant of (b): `inside:true` short-circuits every guard query (P-4 re-pin under full-stack ordering).
- **Expected:** exactly ONE reason per verdict; `active` reports all three true.

### TC-F16-01 · ANY throw ⇒ fail-open accept + error log (M18) — P0 · unit-mocked service · covers F-16
- **Steps/table:** (a) `getConnectedRelySettings` rejects `new Error('relation "marketplace_installations" does not exist')` (P-14 missing-table on fresh DB); (b) `mockIsZipInTerritory` rejects (`getSettings` DB error inside the seam propagates); (c) settings row with a poisoned shape that makes the parser throw (e.g. `Description` getter throwing via `Object.defineProperty` — implementation-tolerant: any internal throw).
- **Expected (every row):** `evaluateRelyLead` RESOLVES (never rejects) with `{accepted:true, error:<err.message>}`; `console.error` spy saw ONE call whose args start `('[RelyLeadFilter] fail-open', err)` with `err.stack` present; verdict carries `reason:null`; no marker will be written (accept ⇒ no third arg — asserted end-to-end in TC-R7-01).

### TC-F1-01 · non-Rely byte-identical (M19, NFR-2) — P0 · unit-mocked route (supertest) · covers F-1 — `tests/relyLeadIngest.test.js` · **SAB-NONRELY-FILTERED control, SAB-FILTER-DROP co-control**
- **Setup:** ingest harness (mocked auth chain, `req.integrationCompanyId = COMPANY`); `relyLeadFilterService` mocked with `evaluateRelyLead: mockEvaluate` + REAL (`jest.requireActual`) `isRelyLead`; `leadsService` mocked (`createLead` → `{UUID:'RL01', SerialId:4242, ClientId:'77'}` + `LeadsServiceError` class); `console.log` spy.
- **Steps:** POST `/leads` three times: `JobSource:'Yelp'`, JobSource ABSENT, `JobSource:'RelyX'` (each with `FirstName:'A', LastName:'B', Phone:'6175551212'`).
- **Expected (each):** `mockEvaluate` `.not.toHaveBeenCalled()`; `mockCreateLead.mock.calls[n][2]` is strictly `undefined` (no systemMetadata — tolerant of arity-2 vs explicit-undefined, the load-bearing property is NO third-arg object); ZERO `console.log` calls with first arg `'[RelyLeadFilter]'`; response `201` with body keys exactly `{success:true, lead_id:'RL01', serial_id:4242, contact_id:<null|id>, request_id:<any>}`. Companion: LEADGEN TC-C6-01's backend seamPattern assertion over `integrations-leads.js` stays green (see stay-green — pins zero marketplace coupling in this file).

### TC-F17-02 · discriminator at the route: `' RELY '` runs the filter — P1 · unit-mocked route (supertest) · covers F-17 (route half)
- **Steps:** same harness; POST with `JobSource:' RELY '`, `mockEvaluate` → `{accepted:true, reason:null, extracted:{zip:null,unit:null,brand:null}, active:{zone:false,unit_types:false,brands:false}, error:null}`.
- **Expected:** `mockEvaluate` called ONCE with `(req.body-payload, COMPANY)` — company arg strictly `req.integrationCompanyId`'s value; exactly ONE `[RelyLeadFilter]` accept line; `createLead` third arg `undefined` (accepted ⇒ no marker, R-7 pin at route level).

## R — Rejected-lead write (`tests/relyLeadIngest.test.js`)

### TC-R1-01 · rejected verdict ⇒ marker in the createLead options, same request, envelope frozen — P0 · unit-mocked route (supertest) · covers R-1 (US-3) + FR-11 (invariant §9.1) · **SAB-FILTER-DROP control**
- **Setup:** harness as TC-F1-01; `mockEvaluate` → `{accepted:false, reason:'out_of_area', extracted:{zip:'02888', unit:'Dishwasher', brand:null}, active:{zone:true,unit_types:true,brands:false}, error:null}`; REAL `buildMarker` (requireActual).
- **Steps:** POST `/leads` `{FirstName:'Ada', LastName:'L', Phone:'6175551212', JobSource:'Rely', PostalCode:'02888', Description:'Issue: Dishwasher'}`.
- **Expected:** `mockCreateLead` called ONCE with third arg deep-matching `{systemMetadata:{rely_filter:{rejected:true, reason:'out_of_area', evaluated_at: expect.stringMatching(ISO-8601), zip:'02888', unit:'Dishwasher', brand:null}}}` — the exact §7 marker shape, canonical extracted values, null where missing. Response STATUS 201 and body keys/values identical to the accepted case of TC-F1-01 (`success:true, lead_id, serial_id, contact_id, request_id` — nothing about rejection leaks to the poster). Status stays default `'Submitted'` (payload carries no Status; no FSM call — `fsmService` mock untouched).

### TC-R2-01 · injection guard on create: external `rely_filter` stripped, server marker wins — P0 · unit-mocked service (real `leadsService`, mocked db) · covers R-2 (P-9) · **SAB-GUARD-STRIP-DROP control**
- **Setup:** real `leadsService`; `db.query` SQL-dispatch: `lead_custom_fields` SELECT → `{rows:[{api_name:'crm_ref'}, {api_name:'rely_filter'}]}` (adversarial: the flat key IS registered), INSERT → returning row. `realtimeService`/`zenbookerClient`/`fsmService` mocked.
- **Steps/table:** (a) accept path: `createLead({FirstName:'A', Metadata:{rely_filter:{rejected:false}, other_key:'keep'}, rely_filter:'x', crm_ref:'zb-9'}, COMPANY)` (NO third arg); (b) reject path: same payload + `{systemMetadata:{rely_filter:{rejected:true, reason:'out_of_area', evaluated_at:'2026-07-13T00:00:00.000Z', zip:'02888', unit:null, brand:null}}}`.
- **Expected:** capture the INSERT's metadata param (`JSON.parse`): (a) has `other_key:'keep'` and `crm_ref:'zb-9'` but **NO `rely_filter` key at all** (both the `Metadata` object key AND the registered flat key stripped); (b) `rely_filter` deep-equals the SERVER marker (merge order `{...meta, ...systemMetadata}` — server value wins), `other_key`/`crm_ref` still present (other custom metadata flows unchanged). Exported `leadsService.RESERVED_METADATA_KEYS` deep-equals `['rely_filter']`. Exactly ONE `INSERT INTO leads` and ZERO `UPDATE leads SET metadata` statements (same-INSERT pin, P-10).

### TC-R3-01 · injection guard on update: strip + merge-never-deletes, no systemMetadata on update — P1 · unit-mocked service · covers R-3 (NFR-7)
- **Setup:** real `leadsService.updateLead`; db dispatch: existing-metadata SELECT → `{rows:[{metadata:{rely_filter:{rejected:true, reason:'out_of_area'}, note:'x'}}]}`; UPDATE → returning row.
- **Steps:** `updateLead('RL01', {Comments:'hi', Metadata:{rely_filter:{rejected:false}, note:'y'}}, COMPANY)`.
- **Expected:** the UPDATE's metadata param keeps `rely_filter:{rejected:true, reason:'out_of_area'}` UNTOUCHED (external object stripped BEFORE merge; `{...existing, ...meta}` never deletes) and updates `note:'y'`. `updateLead`'s signature gains NO systemMetadata support (structural: the fn signature/arity in `leadsService.js` — marker is create-time-only).

### TC-R4-01 · badge exclusion predicate — SQL pin incl. COALESCE — P0 · unit-mocked service · covers R-4 (FR-9) · **SAB-BADGE-PREDICATE-DROP control**
- **Setup:** real `leadsService.countNewLeads` over mocked db (`{rows:[{count:2}]}`).
- **Steps:** `await countNewLeads(COMPANY)`.
- **Expected:** returns 2; the executed SQL matches ALL of: `/company_id\s*=\s*\$1/`, `/lead_lost\s*=\s*false/`, `/status\s*=\s*ANY/`, **and `/NOT COALESCE\(metadata @> '\{"rely_filter":\{"rejected":true\}\}'::jsonb, false\)/`** (the COALESCE is load-bearing — bare `NOT (metadata @> …)` fails this regex); params still exactly `[COMPANY, ['Submitted','New','Review']]` (`NEW_LEAD_STATUSES` unchanged — invariant §9.6). NULL-metadata semantics → TC-R4-DB-01 (real PG).

### TC-R5-01 · SSE/badge coherence: marker rides the INSERT that precedes `lead.created` — P1 · unit-mocked service · covers R-5 (P-10)
- **Setup:** real `leadsService.createLead` with systemMetadata (TC-R2-01(b) fixture); `realtimeService.broadcast` mock.
- **Steps:** create; inspect `db.query` and `broadcast` invocation orders.
- **Expected:** the ONLY leads write is the single INSERT whose metadata param ALREADY contains `rely_filter` (no post-create metadata UPDATE exists to race); `broadcast('lead.created'-carrying event)` `invocationCallOrder` AFTER the INSERT's — so a client refetch of `/new-count` can never observe a counted-then-uncounted flash. Event payload keys unchanged (`company_id`/`status`/`lead_id` minimal shape — pins the untouched `emitLeadChange`).

### TC-R6-01 · DTO exposure via rowToLead spread — P1 · unit-mocked service · covers R-6 (FR-8)
- **Setup:** real `leadsService.listLeads` + `getLeadByUUID` over mocked db returning one row with `metadata = {rely_filter:{rejected:true, reason:'out_of_area', evaluated_at:'…', zip:'02888', unit:null, brand:null}}` and `status:'Submitted'`.
- **Expected:** each DTO exposes the marker BOTH as `lead.Metadata.rely_filter` AND top-level `lead.rely_filter` (metadata spread — no route/DTO wiring); trustworthy at top level because of the P-9 strip (TC-R2-01). `listLeads only_open` behavior untouched: the mocked row (Submitted) is not filtered out (no `only_open` predicate change — invariant §9.10; structural: `listLeads` source's only_open clause still excludes only Lost/Converted).

### TC-R7-01 · accepted lead is marker-FREE (absence, not `rejected:false`) — P0 · unit-mocked route (supertest) · covers R-7
- **Setup:** ingest harness; `mockEvaluate` → accept verdict; mocked `leadsService`.
- **Steps:** POST a Rely payload.
- **Expected:** `mockCreateLead.mock.calls[0][2]` strictly `undefined` — D5 passes NO options object on accept (never `{systemMetadata:{rely_filter:{rejected:false}}}`); combined with TC-R2-01(a) the row provably has no `rely_filter` key ⇒ accepted Rely rows byte-identical to pre-feature rows.

## U — Frontend (`tests/relyLeadsUi.structural.test.js`; each case = structural jest checks + a manual/harness step per FORM-CANON — the repo ships no FE test harness)

### TC-U1-01 · Settings button gate: `rely-leads` + `connected` ONLY — P0 · structural · covers U-1
- **Structural:** `frontend/src/pages/IntegrationsPage.tsx` contains a single conditional matching (whitespace-collapsed) `app.app_key === 'rely-leads'` AND `installation?.status === 'connected'` guarding a `Settings` button render; the `provisioning_failed` branch region (between the `'provisioning_failed'` Retry render and the Disconnect ternary) contains NO `Settings` render; `'rely-leads'` appears in NO other lead-tile branch (the other four keys `pro-referral-leads|nsa-leads|lhg-leads|lead-generator` appear NOWHERE in frontend/src — the AMEND-1 boundary).
- **Manual:** connected rely-leads tile shows Settings (outline, sm) before Disconnect; nsa/lhg/pro-referral/website tiles don't; a `provisioning_failed` rely tile shows Retry/Disconnect only; not-installed shows Enable only.

### TC-U2-01 · panel is FORM-CANON verbatim, no "Blanc" — P0 · structural · covers U-2 (NFR-6, invariant §9.11)
- **Structural:** `frontend/src/pages/RelyLeadsSettingsDialog.tsx` exists and contains ALL of: `variant="panel"`, `DialogPanelHeader`, the literal title `Rely Leads settings`, `DialogBody`, `md:px-8 md:py-7`, `max-w-[740px]`, `space-y-6`, `DialogPanelFooter`, a `variant="ghost"` Cancel button and a primary Save; contains NONE of: `variant="dialog"`, a hand-rolled close button (`aria-label="Close"` outside the shared primitive), the string `Blanc` (case-sensitive; `--blanc-` CSS tokens are allowed — scan for `/Blanc/` NOT preceded by `--`), hardcoded hex outside the `--blanc-*` set. Data wiring: `useQuery` with key `['rely-leads-settings']` and `enabled: open`.
- **Manual:** opens as right slide-over (bottom-sheet on mobile), Escape/backdrop close, GET-error → toast + retry-able panel.

### TC-U3-01 · zone group: radios, territory hint, zero-data warning — P1 · structural · covers U-3
- **Structural:** dialog source contains eyebrow `SERVICE AREA` (`.blanc-eyebrow`), radio rows `Same as company settings` and `Custom ZIP list`, hint literals `Currently: ZIP list` and `Currently: radius areas`, and the exact warning `Your company has no service territory data yet — leads are accepted everywhere until you add some` gated on `has_data`-false.
- **Manual:** switching radios preserves typed ZIPs within the open session (state not destroyed on toggle).

### TC-U4-01 · ZIP textarea: FloatingField, live count, server-authoritative errors — P2 · structural · covers U-4
- **Structural:** `FloatingField` with `textarea` and label `ZIP codes`; client split regex `/[\s,;]+/` present; count copy contains `ZIP codes recognized`; non-blocking invalid-preview copy (`don't look like ZIP codes`); the save handler surfaces the server 400 message via `toast.error` (client preview advisory — PUT re-parse is the authority, TC-S4-01).
- **Manual:** paste `02301, 02302; 2043` + newline `02744` → live count 4; save with `ABCDE` present → toast names `ABCDE`.

### TC-U5-01 · checkbox grids render FROM the GET `catalogs` payload (A3 — no FE mirror) — P1 · structural · covers U-5
- **Structural:** dialog renders grids from a `catalogs` field of the fetched response (source references `catalogs.unit_types`/`catalogs.brands`); the dialog/`marketplaceApi.ts` contain NO catalog literals — grep `frontend/src` for `Vent Hood`, `Speed Queen`, `Thermador` → ZERO hits (the two lists live ONLY in `backend/src/services/relyLeadsCatalog.js`); empty-selection hint literal `No filter — all leads accepted` present; `Checkbox` used (non-floated, label beside); grid classes `grid-cols-2 sm:grid-cols-3`.
- **Manual:** 12 unit checkboxes, 15 brand checkboxes, catalog order = display order.

### TC-U6-01 · save flow: PUT, invalidate, toasts, close semantics — P2 · structural · covers U-6
- **Structural:** `marketplaceApi.ts` exports `fetchRelyLeadsSettings` (GET `/api/marketplace/apps/rely-leads/settings` via authedFetch) and `saveRelyLeadsSettings` (PUT, body = canonical settings); dialog mutation onSuccess: invalidates `['rely-leads-settings']`, `toast.success('Settings saved')`, closes; onError keeps the panel open. `authedFetch.ts` and `useRealtimeEvents.ts` byte-untouched (git-diff/structural — invariant §9.8).
- **Manual:** Cancel/Escape/backdrop → no PUT fired; save → success toast → panel closes; settings apply prospectively only (no re-evaluation of existing leads — NFR-7, nothing to observe client-side).

### TC-U7-01 · Rejected chip + reason copy (table / mobile / detail) — P0 · structural + replica-logic · covers U-7 (US-3)
- **Structural:** `frontend/src/components/leads/leadConstants.ts` exports `REJECTED_REASON_COPY` deep-equal (via literal source match) `{out_of_area:'Rejected — out of service area', unit_not_serviced:'Rejected — unit type not serviced', brand_not_serviced:'Rejected — brand not serviced'}`; `leadsTableHelpers.tsx` `case 'status'` block references `rely_filter` and appends a pill using `hexToRgba` with `#DC2626`; `LeadMobileCard.tsx` row-1 pill row references `rely_filter`; `LeadDetailPanel.tsx` `LeadHeader` renders the literal reason line (`text-[13px]`, `#DC2626`).
- **Replica-logic (faithful expression, pulseContactItem precedent):** `copyFor(reason) = REJECTED_REASON_COPY[reason] ?? 'Rejected'` → `'out_of_area'` → `'Rejected — out of service area'`; unknown/future `'zone_v2'` → `'Rejected'` (fallback title); pill renders IFF `lead.rely_filter?.rejected` — `{rejected:true}` yes, `{rejected:false}` no, key absent no (R-7 symmetry).
- **Manual:** rejected lead shows the pill in list + mobile card, reason line on detail; no pill on any pre-feature lead.

### TC-U8-01 · FLAGS filter: `rejectedOnly` client-side narrowing — P1 · structural + replica-logic · covers U-8 (A4)
- **Structural:** `LeadsPage.tsx` declares `rejectedOnly` state and `filteredLeads` gains a line matching `l.rely_filter?.rejected === true`; `LeadsFilterBody.tsx` renders a 4th `FilterColumn` with title `FLAGS` and items `['Rejected']`; `activeFilterCount` arithmetic includes the flag; `onClearAll` resets it; plumbing props appear in `LeadsFilters.tsx` AND `LeadsMobileBar.tsx`; `FilterColumn` component itself byte-untouched (its export signature/source region unchanged); no `listLeads` param added (`only_open` untouched — grep `leadsApi`/`LeadsPage` for a new server param → none).
- **Replica-logic:** predicate over `[{rely_filter:{rejected:true}}, {rely_filter:{rejected:false}}, {rely_filter:{}}, {}]` keeps EXACTLY the first (strict `=== true` — the truthy-object trap: `{rejected:false}` row must not pass).
- **Manual:** toggle Rejected in desktop popover + mobile View-options sheet → list narrows to marked leads over loaded pages; removable "Rejected" chip in the active row; visible row count = the rejected count affordance.

## D — Observability

### TC-D1-01 · decision log line — exact shape, one per evaluated lead, after create — P1 · unit-mocked route (supertest) · covers D-1 (FR-10, P-11) — `tests/relyLeadIngest.test.js`
- **Setup:** ingest harness; `console.log`/`console.error` spies; mocked `leadsService.createLead` → `{UUID:'RL01', SerialId:4242, ClientId:'77'}`.
- **Steps/table:** (a) reject verdict POST; (b) accept verdict POST; (c) fail-open verdict (`{accepted:true, error:'settings read failed', …}`); (d) non-Rely POST.
- **Expected:** (a) exactly ONE call `console.log('[RelyLeadFilter]', <json>)` where `JSON.parse(json)` deep-matches `{decision:'reject', reason:'out_of_area', extracted:{zip:'02888', unit:'Dishwasher', brand:null}, active:{zone:true, unit_types:true, brands:false}, company_id:COMPANY, lead_uuid:'RL01', serial_id:4242}` and has NO `fail_open_error` key; the log call's order is AFTER `mockCreateLead`'s resolution (uuid/serial present prove it). (b) same shape with `decision:'accept', reason:null`. (c) adds `fail_open_error:'settings read failed'`. (d) ZERO `[RelyLeadFilter]` lines. Never more than one line per request in any row.

### TC-D2-01 · settings audit event discipline — P1 · unit-mocked service · covers D-2 — `tests/relyLeadsSettings.test.js`
- **Steps/table:** (a) successful PUT (TC-S3-01) → `writeEvent` EXACTLY once, `eventType:'settings_updated'`, counts-only payload; (b) GET → `writeEvent` never; (c) failed PUT (each 400 of TC-S4-01/02 + each 404 of TC-S5-01) → `writeEvent` never; (d) ingest reject (any TC-F4/F7 fixture through `evaluateRelyLead`) → `writeEvent` never (rejects are NOT evented — the log line + marker are the record).

---

## Coverage matrix (41/41)

| Spec scenario | Test case(s) | Priority | Type |
|---|---|---|---|
| S-1 GET defaults | TC-S1-01, TC-S1-02 | P0, P2 | unit-mocked |
| S-2 self-heal | TC-S2-01 | P1 | unit-mocked |
| S-3 PUT happy/merge/audit | TC-S3-01, TC-S3-02, TC-S3-DB-01 | P0, P0, P1 | unit-mocked, +db |
| S-4 400 taxonomy | TC-S4-01, TC-S4-02 | P1, P1 | unit-mocked |
| S-5 404 taxonomy | TC-S5-01, TC-S5-02 | P0, P1 | unit-mocked |
| S-6 tenancy+permission | TC-S6-01, TC-S6-02 | P0, P1 | route, structural |
| S-7 custom+empty valid | TC-S7-01 (+TC-F3-01 ingest half) | P1 | unit-mocked |
| F-1 non-Rely byte-identical | TC-F1-01 | P0 | route |
| F-2 no installation | TC-F2-01 | P0 | unit-mocked |
| F-3 custom hit | TC-F3-01 | P0 | unit-mocked |
| F-4 custom miss | TC-F4-01 | P0 | unit-mocked |
| F-5 custom + missing ZIP | TC-F5-01 | P1 | unit-mocked |
| F-6 company list hit | TC-F6-01 | P0 | unit-mocked |
| F-7 company list miss | TC-F7-01 | P0 | unit-mocked |
| F-8 zero-territory guard | TC-F8-01 | P0 | unit-mocked |
| F-9 radius hit | TC-F9-01 | P1 | unit-mocked |
| F-10 radius miss + geocode-null | TC-F10-01 | P1 | unit-mocked |
| F-11 company + missing ZIP | TC-F11-01 | P1 | unit-mocked |
| F-12 unit filter | TC-F12-01 | P0 | unit-mocked |
| F-13 brand filter | TC-F13-01 | P0 | unit-mocked |
| F-14 AND ordering | TC-F14-01 | P0 | unit-mocked |
| F-15 parser/matcher edges | TC-F15-01, TC-F15-02, TC-F15-03 | P1 ×3 | unit-pure |
| F-16 fail-open | TC-F16-01 | P0 | unit-mocked |
| F-17 discriminator | TC-F17-01, TC-F17-02 | P1, P1 | unit-pure, route |
| R-1 same-INSERT marker | TC-R1-01 | P0 | route |
| R-2 injection guard create | TC-R2-01 | P0 | unit-mocked |
| R-3 injection guard update | TC-R3-01 | P1 | unit-mocked |
| R-4 badge exclusion | TC-R4-01, TC-R4-DB-01 | P0, P1 | unit-mocked, db |
| R-5 SSE coherence | TC-R5-01 | P1 | unit-mocked |
| R-6 DTO exposure | TC-R6-01 | P1 | unit-mocked |
| R-7 accepted marker-free | TC-R7-01 (+TC-R2-01a) | P0 | route |
| U-1 button gate | TC-U1-01 | P0 | structural |
| U-2 panel canon | TC-U2-01 | P0 | structural |
| U-3 zone group | TC-U3-01 | P1 | structural |
| U-4 ZIP textarea | TC-U4-01 | P2 | structural |
| U-5 checkbox grids | TC-U5-01 | P1 | structural |
| U-6 save flow | TC-U6-01 | P2 | structural |
| U-7 rejected chip | TC-U7-01 | P0 | structural |
| U-8 FLAGS filter | TC-U8-01 | P1 | structural |
| D-1 decision log | TC-D1-01 | P1 | route |
| D-2 audit event | TC-D2-01 | P1 | unit-mocked |

**Deliberate scope notes:** no E2E (no browser harness in repo; Rely posts come from Vultr — untouched per NFR-4); no FSM cases (invariant §9.4 — no transition logic changed; rejected leads use the default `Submitted` INSERT with no FSM call, pinned inside TC-R1-01); NFR-5 query-band (P-13) is asserted as seam-call counts in the F-cases (mocks can't count the seam's INTERNAL queries — the spec's absolute numbers are informative); un-reject, retroactive re-evaluation, other-app settings = non-goals (§10) — no cases by design.
