# MARKETPLACE-LEADGEN-SPLIT-001 — Behavior Spec (split «Lead Generator» into five per-source lead apps, catalog-only)

**Status:** Spec · **Priority:** P2 · **Backend-only (migration + boot-list line + one guarded disconnect path)** · **Date:** 2026-07-13
**Requirements:** `Docs/requirements.md` «MARKETPLACE-LEADGEN-SPLIT-001» (US-1..6, FR-1..7, NFR-1..6) · **Architecture:** `Docs/architecture.md` «MARKETPLACE-LEADGEN-SPLIT-001 — architecture» (D1–D3, authoritative)
**Builds on:** APP-MKT-001 (migration 083 catalog/installations model), REPAIR-ADVISOR-001 (161 seed shape), SEND-DOC-001 (132 boot-ordering precedent). Code refs verified in this worktree 2026-07-13.

## 1. Overview

One marketplace app (`app_key='lead-generator'`, «Lead Generator») today fronts five distinct external lead streams (Website / Pro Referral / Rely / NSA / LHG), all posted by ONE external service with ONE live credential (`api_integrations` row 1). Migration **169** re-shapes the catalog: rename the existing app to **«Website Leads»** (key frozen), add four per-source apps, and auto-connect all four for the default company on the SAME shared credential. Because five installations then share one credential, `disconnectInstallation` gains a **refcount guard** (FR-5, the only non-catalog change): revoke only when the disconnecting row is the LAST active installation on that credential. Lead ingestion (`POST /leads`, token+scope) is untouched — per-source connect state is informational (FR-6). Do-not-restate here: full column list of `marketplace_apps`/`marketplace_installations` (083), install/provisioning flows (APP-MKT-001).

## 2. Exact contracts

### 2.1 Migration `backend/db/migrations/170_split_lead_generator_marketplace_apps.sql` — three statements, strictly this order

**(1) Guarded rename UPDATE (FR-2).** Only `name` + the two descriptions + `updated_at`; every other column (incl. `provider_name='Blanc Labs'`, `app_key`, scopes, urls) untouched:

```sql
UPDATE marketplace_apps
SET name = 'Website Leads',
    short_description = 'Creates inbound leads from your company website.',
    long_description = 'Posts orders and form submissions from your company website into Albusto as leads with source attribution.',
    updated_at = NOW()
WHERE app_key = 'lead-generator'
  AND (name IS DISTINCT FROM 'Website Leads'
       OR short_description IS DISTINCT FROM 'Creates inbound leads from your company website.'
       OR long_description IS DISTINCT FROM 'Posts orders and form submissions from your company website into Albusto as leads with source attribution.');
```

The `IS DISTINCT FROM` guard (132:71 style) makes the re-run a no-op *when already renamed*; in the boot replay 083 has just re-asserted «Lead Generator» inside the SAME transaction, so there the guard intentionally fires every boot (atomic — readers never observe the intermediate name).

**(2) Four-row `INSERT … ON CONFLICT (app_key) DO UPDATE` (FR-1).** One multi-VALUES statement, 083/161 shape; the DO UPDATE SET list = every seeded column + `updated_at = NOW()`. Exact row values (each is a spec contract — C2 asserts them):

| app_key | name | short_description | long_description |
|---|---|---|---|
| `pro-referral-leads` | Pro Referral Leads | Creates inbound leads from Pro Referral. | Posts Pro Referral leads into Albusto with source attribution. |
| `rely-leads` | Rely Leads | Creates inbound leads from Rely. | Posts Rely leads into Albusto with source attribution. |
| `nsa-leads` | NSA Leads | Creates inbound leads from NSA. | Posts NSA leads into Albusto with source attribution. |
| `lhg-leads` | LHG Leads | Creates inbound leads from LHG. | Posts LHG leads into Albusto with source attribution. |

Shared per-row values: `provider_name='Albusto'` · `category='lead_generation'` · `app_type='internal'` · `requested_scopes='["leads:create"]'::jsonb` · `provisioning_mode='manual'` · `status='published'` · `support_email='support@albusto.com'` · `docs_url='/settings/api-docs'` · `metadata='{"access_summary":["Create leads"]}'::jsonb` · `privacy_url`/`logo_url` **omitted** (161/126 precedent — avoids `blanc.local`, NFR-4). **«LHG Leads» stays the acronym** — the prod `job_source` value is literally `LHG`; do NOT expand. Draft-copy status lives in the migration header comment only, never in user-visible strings; no string may promise per-source enforcement (FR-6), none may contain «Blanc» (NFR-4).

**(3) Default-company auto-connect INSERT-SELECT (FR-4).** Exact shape — the LATERAL credential resolve and the status-blind NOT EXISTS are both load-bearing:

```sql
INSERT INTO marketplace_installations
    (company_id, app_id, api_integration_id, status, installed_at, metadata)
SELECT
    '00000000-0000-0000-0000-000000000001'::uuid,
    a.id,
    src.api_integration_id,
    'connected',
    NOW(),
    '{"seeded_by":"MARKETPLACE-LEADGEN-SPLIT-001","shared_credential":true}'::jsonb
FROM marketplace_apps a
CROSS JOIN LATERAL (
    SELECT mi.api_integration_id
    FROM marketplace_installations mi
    JOIN marketplace_apps lg ON lg.id = mi.app_id AND lg.app_key = 'lead-generator'
    WHERE mi.company_id = '00000000-0000-0000-0000-000000000001'::uuid
      AND mi.status = 'connected'
      AND mi.api_integration_id IS NOT NULL
    ORDER BY mi.created_at DESC
    LIMIT 1
) src
WHERE a.app_key IN ('pro-referral-leads', 'rely-leads', 'nsa-leads', 'lhg-leads')
  AND NOT EXISTS (
      SELECT 1 FROM marketplace_installations existing
      WHERE existing.company_id = '00000000-0000-0000-0000-000000000001'::uuid
        AND existing.app_id = a.id
  );
```

Contract points: credential resolved **by subquery from the newest CONNECTED default-co `lead-generator` installation — never hardcoded** (prod resolves to 1); `CROSS JOIN LATERAL` over a LIMIT-1 subquery ⇒ zero source rows empties the whole SELECT (M4); `NOT EXISTS` is deliberately **status-blind** — any (default-co, app) row of ANY status suppresses the seed forever (M5), because the partial-unique index `idx_marketplace_installations_one_active` (083:63-65, `WHERE status IN ('connected','provisioning_failed')`) would NOT block an `ON CONFLICT`-style insert against a disconnected row. `installed_by` omitted (NULL = migration actor). `api_integrations` is only ever READ (NFR-1). **No `marketplace_installation_events` rows are seeded** — an events INSERT has no natural idempotency key under boot replay; `metadata.seeded_by` is the audit trail (decision, not omission). No `RAISE NOTICE` anywhere (replays every boot). No `CREATE INDEX CONCURRENTLY` — the file must stay transaction-safe (it runs inside the ensure-list BEGIN/COMMIT).

### 2.2 Boot-list registration (FR-3)

`backend/src/db/marketplaceQueries.js` `ensureMarketplaceSchema` — exactly ONE line appended after the 161 entry (:47), i.e. AFTER the 083 line (:27), with a 132-style comment (rename self-heals over 083's `ON CONFLICT DO UPDATE` re-assert; the 132-after-087 precedent :38-41):

```js
await query(readMigration('170_split_lead_generator_marketplace_apps.sql'));
```

Existing entries and their order are byte-unchanged. The list runs inside the advisory-lock transaction (`pg_advisory_xact_lock(hashtext('blanc_marketplace_schema'))`, :17) on every boot; the memoized no-client path (:51-69) COMMITs or ROLLBACKs atomically.

### 2.3 Rollback `backend/db/migrations/rollback_170_split_lead_generator_marketplace_apps.sql` (FR-7)

FK-forced order (`marketplace_installations.app_id` is ON DELETE RESTRICT):
1. DELETE `marketplace_installations` whose `app_id` resolves to the four new app_keys — the default-co seeded rows AND any other company's self-service installs.
2. DELETE the four `marketplace_apps` rows (four keys only).
3. UPDATE `lead-generator` back to the exact 083 seed strings: name «Lead Generator», short «Creates inbound leads from external campaigns.», long «Posts validated campaign leads into Blanc with source attribution.» (083 re-asserts these next boot anyway once the list entry is gone; NFR-4 governs NEW strings only).

Script header MUST state: (a) rolling back also requires deleting the `readMigration('169_…')` line from `ensureMarketplaceSchema`; (b) self-service-minted credentials of other companies are NOT revoked/deleted — `api_integrations.marketplace_app_id`/`marketplace_installation_id` clear via ON DELETE SET NULL, keys stay valid-but-orphaned, revocable via the integrations UI; (c) the script never touches the original `lead-generator` installation row, the live `api_integrations` row, or any other app's rows. `marketplace_installation_events` audit rows survive (installation_id/app_id SET NULL — rollback_161 precedent). Every statement idempotent (no-op when already rolled back).

### 2.4 Disconnect guard (FR-5) — function signatures

**New query helper** in `backend/src/db/marketplaceQueries.js` (+ added to `module.exports` :359-374):

```
countOtherActiveInstallationsOnCredential(companyId, apiIntegrationId, excludeInstallationId, client = null) → Promise<int>
```

Semantics: returns `0` immediately when `apiIntegrationId` is falsy (mirrors `revokeCredentialById` :260); otherwise `SELECT COUNT(*)::int FROM marketplace_installations WHERE company_id = $1 AND api_integration_id = $2 AND id <> $3 AND status IN ('connected', 'provisioning_failed')`. The active-set predicate `('connected','provisioning_failed')` is EXACTLY the set used by the partial-unique index (083:63-65), the disconnect precondition (marketplaceService.js:512), and `reconcileRevokedInstallations` (marketplaceQueries.js:87) — «still needs the credential» ≡ «row the system treats as active». Company-scoped (G5). Calls `ensureMarketplaceSchema(client)` + `queryFor(client)` like every sibling helper. All SQL stays in marketplaceQueries — the service never issues raw SQL (repo convention).

**`disconnectInstallation(companyId, actorId, installationId, { requestId })` edit** (`backend/src/services/marketplaceService.js:502-558`) — ONLY the :516-544 region changes; signature, 404/409 preconditions (:509-514), BEGIN/COMMIT/ROLLBACK/release framing, and return shape `{ id, status, disconnected_at }` are byte-unchanged:

1. Compute `otherActive = await marketplaceQueries.countOtherActiveInstallationsOnCredential(companyId, installation.api_integration_id, installationId, client)` before any revoke.
2. Call `revokeCredentialById(installation.api_integration_id, companyId, client)` **only when `otherActive === 0`**; `writeCredentialRevokedEvent(…, reason: 'disconnect')` only when that revoke returned a row (unchanged condition).
3. `markDisconnected` status expression extends today's (:532): `!installation.api_integration_id || revoked || otherActive > 0 ? 'disconnected' : 'revoked'`.
4. The existing `'disconnected'` event payload (:543) gains one field: `{ credential_revoked: Boolean(revoked), credential_shared: otherActive > 0 }`.

**Status truth table** (rows 1–3 = today's behavior, byte-compatible; row 4 = new):

| # | api_integration_id | otherActive | revoke attempted | revoke result | final status | credential_revoked event |
|---|---|---|---|---|---|---|
| 1 | NULL | 0 (short-circuit) | no | — | `disconnected` | no |
| 2 | set, not shared | 0 | yes | row | `disconnected` | yes |
| 3 | set, not shared | 0 | yes | null (company mismatch) | `revoked` | no |
| 4 | set, **shared** | > 0 | **no** | — | `disconnected` | no |

No `FOR UPDATE` is added — the concurrent-disconnect race is accepted in the safe direction (G8). `retryProvisioning` (:560-580) is intentionally NOT guarded: unreachable for the lead apps (`provisioning_mode='manual'` ⇒ `INSTALLATION_NOT_RETRYABLE`, :567-569) and push-credentials installs always own their freshly-minted credential.

## 3. Scenarios — M (migration & boot)

- **M1 — fresh apply.** *Given* a database at migration 168 where 083's seed exists (default-co has one CONNECTED `lead-generator` installation with `api_integration_id=1`), *when* `170_split_lead_generator_marketplace_apps.sql` is applied once (psql at deploy), *then*: `marketplace_apps` has exactly 5 rows with `category='lead_generation'`; `lead-generator`'s name is «Website Leads» and both descriptions match §2.1(1) verbatim, all its other columns byte-identical to before; the four new rows match the §2.1(2) table exactly; four new `marketplace_installations` rows exist for company `00000000-0000-0000-0000-000000000001` ONLY, each `status='connected'`, `api_integration_id` = the value resolved from the newest connected `lead-generator` installation (=1 on prod), `installed_at` set, `installed_by` NULL, `metadata = {"seeded_by":"MARKETPLACE-LEADGEN-SPLIT-001","shared_credential":true}`; zero rows written to `marketplace_installation_events`; `api_integrations` byte-identical before/after (NFR-1).

- **M2 — idempotent re-apply.** *Given* M1 has run, *when* the same file is applied again (arbitrarily many times), *then* row counts and row ids in `marketplace_apps` and `marketplace_installations` are stable (upsert refreshes `updated_at` only; the NOT EXISTS suppresses every installation re-seed); no duplicate active row can ever violate `idx_marketplace_installations_one_active`; `api_integrations` still untouched (NFR-2).

- **M3 — boot replay + rename self-heal (FR-3 ordering).** *Given* 169 is registered in `ensureMarketplaceSchema` after the 083 line, *when* the app boots (or a test calls the REAL `ensureMarketplaceSchema(client)` — the client-arg path :15-48 skips the memo and replays the whole list), *then* within ONE advisory-locked transaction 083 re-asserts name «Lead Generator» and 169 immediately re-renames to «Website Leads» — the post-boot catalog ALWAYS reads «Website Leads», and no concurrent reader ever observes the intermediate name. Registration missing or ordered BEFORE 083 ⇒ this scenario fails (name reverts) — the db-suite pins it behaviorally, not by source grep.

- **M4 — no-source-installation company (fresh/dev DB, or owner disconnected the original).** *Given* the default company has NO row matching the LATERAL predicate (`lead-generator`, `status='connected'`, `api_integration_id IS NOT NULL`) — e.g. a fresh dev DB, or the original installation is disconnected/revoked, *when* 169 runs, *then* the LATERAL yields zero rows ⇒ ZERO installations are seeded (statements 1–2 still apply). Five tiles render Available for the default company. **A `'connected'` row with a NULL credential is never created.** This is intended US-4-style semantics, not a defect; the seed self-heals on a later boot only if a connected source installation appears AND no (default-co, app) row was created meanwhile.

- **M5 — disconnected-row non-resurrection.** *Given* M1 ran and the owner later disconnected «NSA Leads» (its row now `status='disconnected'`), *when* 169 replays at next boot, *then* the status-blind NOT EXISTS sees the existing (default-co, nsa-leads) row and seeds NOTHING — the row stays `disconnected`, no second row appears. Same holds for `revoked` rows. (An `ON CONFLICT`-based seed would have resurrected it — the partial index ignores inactive rows; this is why NOT EXISTS is the contract.)

- **M6 — rollback, live installation untouched.** *Given* M1 (5 apps, 4 seeded installations), *when* `rollback_169_*.sql` runs (and the ensure-list line is removed per header), *then*: the four new apps' installation rows are deleted first, then the four app rows; `lead-generator` reads name «Lead Generator» + exact 083 descriptions again; the ORIGINAL `lead-generator` installation row is byte-identical (id, status, `api_integration_id` link); `api_integrations` row 1 untouched — `revoked_at` still NULL, external posting never blinks (US-6/NFR-1); no other app's rows change. Re-running the rollback is a no-op.

- **M7 — rollback with other-company self-service installs.** *Given* company B self-installed «Rely Leads» (own minted credential, per C4), *when* the rollback runs, *then* B's installation row is deleted (FK RESTRICT forces it), B's minted `api_integrations` row SURVIVES with `marketplace_app_id`/`marketplace_installation_id` nulled (ON DELETE SET NULL) — valid-but-orphaned, revocable via the integrations UI, exactly as the script header documents. `marketplace_installation_events` audit rows survive with SET-NULL references.

- **M8 — NFR-1 proof obligation.** *Given* any of M1/M2/M3/M6, *then* a full before/after snapshot of `api_integrations` (every column, every row) is byte-identical across: applying 169, re-applying 169, boot replay, and rollback. This is the acceptance gate for «zero failed external posts attributable to this feature» — `integrationsAuth.js:141` keeps accepting the live token because `revoked_at` stays NULL.

## 4. Scenarios — G (disconnect guard)

- **G1 — disconnect ONE shared source is not a kill-switch (US-5).** *Given* default-co has the five installations all referencing `api_integration_id=1`, *when* the owner disconnects «NSA Leads» (`POST /api/marketplace/installations/:id/disconnect`), *then* `countOtherActiveInstallationsOnCredential` returns 4 (>0) ⇒ `revokeCredentialById` is **NOT called**, NO `credential_revoked` event is written, the row is marked `status='disconnected'` (truth-table row 4), the `'disconnected'` event payload is `{ credential_revoked: false, credential_shared: true }`, transaction COMMITs. `api_integrations.revoked_at` stays NULL ⇒ `POST /leads` keeps returning 2xx for ALL five streams; the other four tiles stay Connected.

- **G2 — disconnect the LAST active installation revokes, as today.** *Given* four of the five are already disconnected and only «Website Leads» (the original row) is active on credential 1, *when* it is disconnected, *then* `otherActive === 0` ⇒ `revokeCredentialById(installation.api_integration_id, companyId, client)` runs, `revoked_at` is set, a `credential_revoked` event (reason `'disconnect'`) is written, status = `'disconnected'` (truth-table row 2), payload `{ credential_revoked: true, credential_shared: false }`. Subsequent external posts get 401 `AUTH_KEY_REVOKED` (integrationsAuth.js:141). This is FR-5's exact boundary: NFR-1 protects against any SINGLE disconnect, not an owner deliberately tearing everything down. Behavior for a sole-installation app (every non-lead app today) is byte-identical to pre-feature.

- **G3 — `reconcileRevokedInstallations` does NOT cascade.** *Given* G1 just happened (shared disconnect, revoke skipped), *when* any list/get runs `reconcileRevokedInstallations(companyId)` (marketplaceQueries.js:76-91 — fires on every `listPublishedAppsWithInstallation`/`getInstallationById`), *then* its predicate `ai.revoked_at IS NOT NULL` matches nothing (revoked_at is still NULL) ⇒ the other four rows stay `connected`, none flips to `revoked`. (This cascade is exactly what an unguarded disconnect would have triggered — the guard prevents the revoke itself, so the reconciler needs NO change.)

- **G4 — other `revokeCredentialById` sites unaffected.** The guard exists ONLY at the disconnect site (:516). *Given* install-flow provisioning fails (:426) or retry-provisioning fails (:667), *then* those sites still revoke unconditionally — correct, because each revokes a credential freshly minted within the same flow, never the shared one. *Given* `retryProvisioning` is attempted on a lead app, *then* it 409s `INSTALLATION_NOT_RETRYABLE` before any revoke (`provisioning_mode='manual'`, :567-569). No other callers exist (audited: 4 sites total).

- **G5 — company-scoping of the count.** *Given* (hypothetically) another company's installation row referenced the same `api_integration_id`, *then* it does NOT count toward `otherActive` — the helper filters `company_id = $1`. Rationale: `revokeCredentialById` itself is company-scoped (`WHERE id = $1 AND company_id = $2`, marketplaceQueries.js:267-268), so the guard measures exactly the population whose credential that revoke could kill; cross-tenant rows neither block nor permit a revoke (isolation preserved; credentials are company-owned so the cross-company case cannot legitimately arise).

- **G6 — NULL credential short-circuit.** *Given* an installation with `api_integration_id IS NULL` is disconnected, *then* the helper returns 0 without querying, revoke is skipped by `revokeCredentialById`'s own null-guard as today, status = `'disconnected'` (truth-table row 1), payload `{ credential_revoked: false, credential_shared: false }`.

- **G7 — regression pin: revoke-returned-null still yields `'revoked'`.** *Given* a non-shared installation whose credential row does not match the company (revoke returns null), *then* status = `'revoked'` (truth-table row 3) — the extended expression must NOT change this leg (`otherActive` is 0, `revoked` is null ⇒ falls through to `'revoked'` exactly as :532 does today).

- **G8 — concurrent disconnect race (accepted).** *Given* two of the five sharers are disconnected simultaneously, *when* both READ-COMMITTED transactions each still see the other row active, *then* BOTH may skip the revoke — the credential can survive with zero active rows. This failure mode is strictly the safe direction (a wrong revoke is impossible: revoking requires every other sharer's disconnect to be already committed). No `FOR UPDATE` is added — documented, accepted. A later G2-style last-disconnect (or manual revoke via the integrations UI) cleans up.

- **G9 — error semantics unchanged.** Unknown installation id ⇒ 404 `INSTALLATION_NOT_FOUND`; status not in (`connected`,`provisioning_failed`) ⇒ 409 `INSTALLATION_NOT_ACTIVE`; any throw (incl. from the new helper) ⇒ ROLLBACK + client release + error propagates to the route's existing error mapping. The helper is called AFTER the preconditions, INSIDE the transaction, on the same `client`.

## 5. Scenarios — C (catalog surface)

- **C1 — five lead apps listed (US-1).** *Given* migration applied, *when* `GET /api/marketplace/apps` (route marketplace.js:31 → `listApps` → `listPublishedAppsWithInstallation`) runs for ANY company, *then* the response contains five published apps with `category='lead_generation'`: «Website Leads» (`lead-generator`), «Pro Referral Leads» (`pro-referral-leads`), «Rely Leads» (`rely-leads`), «NSA Leads» (`nsa-leads`), «LHG Leads» (`lhg-leads`). All five flow through the generic `mapAppRow` path — the `listApps` overlays touch ONLY `google-email`/`telephony-twilio` (marketplaceService.js:252-264) and are unchanged.

- **C2 — row values exact.** For the four new apps every field matches §2.1(2): `provider_name='Albusto'`, `app_type='internal'`, `requested_scopes=["leads:create"]`, `provisioning_mode='manual'`, `status='published'`, `support_email='support@albusto.com'`, `docs_url='/settings/api-docs'`, `metadata.access_summary=["Create leads"]`, no `privacy_url`/`logo_url`, names/descriptions verbatim, «LHG Leads» not expanded. `lead-generator` keeps `provider_name='Blanc Labs'` and all non-renamed fields (rebrand = explicit non-goal). No string anywhere claims per-source enforcement; no NEW string contains «Blanc».

- **C3 — default company sees five Connected (US-2).** *Given* the M1 seed, *when* the owner (default co) opens `/settings/integrations`, *then* all five lead tiles render Connected, each backed by its OWN `marketplace_installations` row (the original for `lead-generator`, four seeded rows for the rest), all sharing `api_integration_id=1`. Rendering uses the existing generic connected-tile branch (Disconnect + optional setup) — `IntegrationsPage.tsx` hardcodes only `vapi-ai`/`stripe-payments`/`google-email`/`telephony-twilio` (:256-280) and value-copy for `smart-slot-engine`/`ai-repair-advisor` (:58-60); zero frontend edits (NFR-5 — an app-key special case turning out to be needed is a spec violation to escalate, not to hardcode).

- **C4 — other companies see Available; self-service Enable mints own credential (US-4).** *Given* any non-default company, *then* the five apps list as available/disconnected (no installation row — the seed is company-scoped, NFR-3). *When* that company clicks Enable (existing `POST /api/marketplace/apps/:appKey/install` → `installApp`), *then* the generic manual-mode path runs unchanged: `provisioning_mode='manual'` ≠ `'none'` ⇒ a NEW company-owned `leads:create` credential is minted (`createCredentialForInstallation`); no `derived_connection` reject and no `requires_connected_gmail` prerequisite applies (neither is set in the new apps' metadata). Exactly today's Lead Generator behavior.

- **C5 — re-Enable after disconnect.** *Given* the owner disconnected «Rely Leads» (G1) and later re-enables it, *then* `installApp` mints a NEW credential for the new installation row (it does not re-attach credential 1); the original shared token keeps working for the remaining sharers, still protected by the guard through THEIR rows. The disconnected old row stays as history (partial-unique index permits one ACTIVE row only). Consequence: a re-enabled source posts under the OLD shared token anyway (external service is untouched) — the new credential is unused until someone configures it externally; this is acceptable catalog-only semantics per FR-6 and needs no code.

- **C6 — connect state is informational (FR-6).** *Given* «Rely Leads» is disconnected, *when* the external service posts a Rely lead with the shared token, *then* `POST /leads` still succeeds (token valid + scope `leads:create` — `authenticateIntegration`/`requireIntegrationScope` unchanged, integrations-leads.js:33). Nothing in this feature routes, gates, or attributes leads per app. Any copy implying otherwise violates the spec.

## 6. Component interaction (no new surface)

- Catalog read: `IntegrationsPage.tsx` → authedFetch `GET /api/marketplace/apps` → `listApps` → `marketplaceQueries.listPublishedAppsWithInstallation(companyId)` (per-company LEFT JOIN LATERAL newest installation) → generic tiles.
- Disconnect: tile button → `POST /api/marketplace/installations/:id/disconnect` (marketplace.js:64) → `disconnectInstallation` (guarded, §2.4) → `marketplace_installation_events` audit rows.
- Router mount unchanged: `app.use('/api/marketplace', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, marketplaceRouter)` (src/server.js:267); `company_id` = `req.companyFilter?.company_id` end-to-end.
- No SSE, no React-Query cache changes, no new endpoints, no payload-shape changes beyond the additive `credential_shared` field inside the audit event's `payload_json` (server-side audit data only — the disconnect HTTP response shape `{ success, installation:{ id, status, disconnected_at } }` is unchanged).
- External ingestion: Vultr rely-lead-processor → `POST /leads` (`authenticateIntegration` + `requireIntegrationScope('leads:create')`) — byte-identical (NFR-6).

## 7. Invariants preserved (Implementer/Tester checklist)

1. `api_integrations` row 1 never written by 169 / boot replay / guard-skipped disconnect / rollback — `revoked_at` NULL throughout (NFR-1; M8 snapshot proof).
2. `POST /leads`, `integrationsAuth.js`, `integrationScopes.js` not edited; 401/scope semantics byte-identical (NFR-6).
3. `app_key='lead-generator'` frozen; the original `lead-generator` installation row (id, `api_integration_id`, status) untouched by both migration and rollback.
4. `provider_name='Blanc Labs'` on existing rows NOT rebranded (follow-up).
5. Partial-unique index invariant holds: at most one ACTIVE row per (company, app); the seed's status-blind NOT EXISTS is strictly stronger.
6. `ensureMarketplaceSchema`: existing entries + order byte-unchanged; exactly one appended 169 line, after 083; list still transaction-safe (169 has no CONCURRENTLY).
7. Disconnect: 404/409 preconditions, transaction framing, return shape, `markDisconnected`/`writeEvent` signatures unchanged; truth-table rows 1–3 = today's behavior.
8. `reconcileRevokedInstallations` not edited; G3 holds purely because `revoked_at` stays NULL.
9. Revoke sites :426/:580/:667 unguarded on purpose (own-credential / unreachable).
10. Zero `frontend/src` edits (NFR-5); zero edits to other apps' seeds (083-161) or lifecycle.
11. No `marketplace_installation_events` seeded by the migration; guard adds no new event TYPE (only the additive `credential_shared` payload field).
12. New-string language: English only, no «Blanc», no enforcement claims (NFR-4/FR-6).
13. Existing test suites (marketplaceTelephonyOverlay, googleEmailMarketplace) need NO mock additions — they never exercise disconnect; the new helper is additive to the mocked module.
14. Protected files untouched: `src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts`; `backend/db/` changes = exactly the two 169 files.

## 8. Security & data isolation

- Every new/changed read-write is company-scoped: the seed hardcodes the default-co UUID in BOTH the INSERT-SELECT and its NOT EXISTS; the guard count filters `company_id`; `revokeCredentialById` stays `WHERE id AND company_id`.
- Multi-tenant blast radius of the migration: other companies observe ONLY four more published apps in the shared catalog (by design — the catalog is global, installation state is per-company); none of their rows are created, modified, or deleted (NFR-3). Rollback deletes other companies' self-service installs of the four keys ONLY (M7, documented).
- Marketplace endpoints keep the `authenticate + requirePermission('tenant.integrations.manage') + requireCompanyAccess` gate; no new endpoint, no new permission.
- No secrets appear in migration files, metadata, or event payloads (`payload_json` gains only booleans).

## 9. Non-goals (explicit)

- **No frontend change** — five apps render via the existing generic tile branch + `MarketplaceConnectDialog`; escalate (don't hardcode) if a special case surfaces.
- **No external-service change** — the Vultr rely-lead-processor, its token, payloads, and `job_source` values stay untouched; zero redeploys.
- **No per-source enforcement** — disconnecting a source app does NOT stop that source's ingestion (FR-6); building real enforcement is a separate future feature.
- **No Blanc→Albusto rebrand of existing rows** (`lead-generator`, `call-qa-agent`, … keep «Blanc Labs»/blanc.local fields) — noted follow-up.
- **No credential split/re-issuance** — the five default-co installations intentionally share `api_integrations` row 1; no `api_integrations` writes of any kind.
- **No final marketing copy** — descriptions ship as drafts (header-comment noted); future copy edits land in 169 itself (it self-heals every boot), never in a data patch.
- **No concurrency hardening** of disconnect (`FOR UPDATE`) — G8 race accepted in the safe direction.
- **No Yelp-flow or onboarding-checklist involvement** (Yelp is task-based, not marketplace-token based).
