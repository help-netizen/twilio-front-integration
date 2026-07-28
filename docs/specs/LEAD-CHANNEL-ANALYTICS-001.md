# LEAD-CHANNEL-ANALYTICS-001 — lead-source funnel and unit economics

**Status:** draft; chunks 1a and 1b implemented
**Date:** 2026-07-27 · **Area:** Analytics / lead attribution / marketplace integrations  
**Chunk 1a commit:** `2f87ca1b`
**Chunk 1b Phase A commit:** `7511c1bf`

## Goal

Give the owner one acquisition-cohort view that follows every lead source from
request through conversion, completed visit, completed repair, and net collection,
then shows whether each channel, service area, and technician earns or loses money.

## Scope

Chunk 1a:

- Add tenant-owned canonical lead-source channels and raw-source aliases without
  rewriting the original `leads.job_source`.
- Capture durable first-reached timestamps for lead conversion, visit completion,
  and final repair completion, including a best-effort historical backfill.
- Build a fresh tenant-safe acquisition-cohort aggregate across leads, jobs,
  invoices, payment transactions, calls, service areas, and technicians.
- Expose summary, channel/area/technician breakdown, and data-quality reads.
- Add the Settings → Analytics page, route, navigation entry, API client, and a
  loaded-state server-render smoke test.
- Return explicit no-cost-source values until an advertising connector exists.

Chunk 1b:

- Add the native Google Ads marketplace connector, including its marketplace card.
- Reuse the owner-approved credential-handling approach and operational learnings
  from the external Telegram-reporter project.
- Pull spend automatically when connected and feed ad spend and ROAS into the
  connector-neutral analytics seams.
- Keep the integration model pluggable so sources can be enabled or disabled
  independently and a newly connected source starts pulling its own data.

Out of scope for chunk 1a: Google Ads OAuth/credentials, campaign synchronization,
ad-spend persistence, marketplace card seeding, non-Google cost sources, write
actions from analytics, and any AI/MCP tool.

## Owner decisions

1. The base integration is the native marketplace app named **Google Ads**; its
   connector lands in chunk 1b.
2. Lead sources are pluggable and independently enableable/disableable; connecting
   a source automatically pulls that source's data.
3. The v1 profit lens is ROAS plus marketing contribution.
4. The funnel includes both intermediate operational stages: Visit completed and
   Job is Done.
5. Analytics has a dedicated Settings section and is also surfaced through the
   Google Ads marketplace app.
6. Completed standalone payments with no invoice are excluded from attributed
   contribution and reported as `tax_basis_unknown_cents`.
7. A lead assigned to multiple distinct technicians gives each technician equal
   credit; duplicate occurrences of the same technician do not add weight.

## Metric and cohort contract

- The cohort is leads created between `from` and `to`, inclusive by company-local
  calendar date using the company's timezone (fallback `America/New_York`).
- Later funnel and revenue events remain attached to their acquisition lead, so a
  mature lead is not dropped merely because the downstream event occurred after
  the selected acquisition period.
- Net revenue is completed invoice-linked payments less completed refunds, in
  integer cents; voided transactions do not contribute.
- Marketing contribution is net revenue less attributed call cost and observed ad
  spend. Summary and channel projections subtract all period spend.
- Spend is summed as provider micros by company, channel, and inclusive performance
  date range, then converted once to integer cents after summation. Summary spend
  is the exact sum of the resulting channel cents.
- ROAS is net revenue divided by ad spend. It is `null` when spend is zero; the API
  never fabricates a zero ROAS.
- Channel rows carry their observed channel spend. A spend-bearing channel with no
  attributed cohort leads remains visible as a synthetic zero-lead row whose
  contribution is the negative spend.
- Area and technician spend is modeled: each channel's integer-cent spend is
  allocated equally across that channel's attributed cohort leads, with residual
  cents deterministically reconciled. Area receives each lead's allocation;
  technicians retain the existing equal split across distinct technicians, so
  dimension rows reconcile exactly. Spend for a channel with no attributed cohort
  leads, or a missing/inactive channel, is not distributed and is surfaced as
  `unallocated_spend_cents`.
- Calls are attributed only within the company and to the nearest company lead for
  the contact. Area and technician joins repeat company scope.
- Canonical source identity is company-owned. An inactive or unmapped alias falls
  into the tenant's `unattributed` channel.
- A non-null `gclid` takes precedence over raw-source alias mapping and attributes
  the lead to the company's active canonical `google_ads` channel. If that channel
  does not exist or is inactive, the existing alias/unattributed behavior is
  unchanged.

## Task breakdown

| Task | Chunk | Status | Acceptance |
|---|---|---|---|
| T1 — Source identity and milestones | 1a | **DONE** | Migration 212 adds company-scoped channels/aliases, durable milestone columns, triggers, backfill, indexes, and rollback. |
| T2 — Tenant-safe cohort facts | 1a | **DONE** | Fresh service scopes the base lead cohort and every downstream join by company; it does not reuse the F014-affected legacy analytics service. |
| T3 — Summary, breakdown, and quality API | 1a | **DONE** | Three read endpoints validate period/dimension, preserve integer cents, and require both catalog permissions. |
| T4 — Analytics Settings experience | 1a | **DONE** | `/settings/analytics`, Settings navigation, the marketing-analytics redirect, six KPIs, full funnel, three breakdown dimensions, and data quality render from React Query v5. |
| T5 — Release evidence and render smoke | 1a | **DONE** | Backend suites, real-PostgreSQL tenancy control, TypeScript build, and loaded-state SSR smoke evidence are recorded below. |
| T6 — Google Ads marketplace connector | 1b | **DONE** | Migration 213, native derived-connection app, company-bound encrypted credential lifecycle, scheduler/lease-based automatic pull, sync status, bootstrap, and safe reconnect/disconnect behavior shipped in Phase A. |
| T7 — Pluggable cost ingestion and live ROAS | 1b | **DONE** | Phase B consumes tenant-scoped connector-neutral daily performance facts, reports observed/unallocated spend and non-secret connected-source status, and wires ROAS plus marketing contribution into every projection. |

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `GET /api/lead-channel-analytics/summary` aggregate | `req.companyFilter?.company_id`, passed as required `companyId`; company-local dates and spend rows resolve from the same company | company UUID + `from`/`to`; no client-supplied entity id | `reports.financial.view` **and** `lead_source.view` | tenant_admin ✓; manager ✓; dispatcher ✗; provider ✗ | An unscoped base cohort, downstream invoice/call join, or cost snapshot would inflate another tenant's revenue, calls, funnel, or spend. |
| `GET /api/lead-channel-analytics/breakdown` aggregate | same required company context; base cohort and channel/area/technician joins repeat company predicates | company UUID + `dimension` + `from`/`to`; channel/area/technician keys are output only | `reports.financial.view` **and** `lead_source.view` | tenant_admin ✓; manager ✓; dispatcher ✗; provider ✗ | Shared source text, postal codes, contacts, or technician ids could cross-credit another tenant if any natural-key join lost company scope. |
| `GET /api/lead-channel-analytics/data-quality` aggregate | same required company context; cohort, standalone-payment, spend, and connector-status queries all filter company | company UUID + `from`/`to`; no client-supplied entity id | `reports.financial.view` **and** `lead_source.view` | tenant_admin ✓; manager ✓; dispatcher ✗; provider ✗ | An unscoped payment/spend/status scan could disclose another tenant's invoice-less net or connector state and distort attribution coverage or unallocated spend. |

Tenant/RBAC test contract:

- `T-own`: authenticated reads for the resolved company return only that company's
  cohort and finance facts.
- `T-foreign`: not applicable as an entity-id 404 case because none of these
  aggregate endpoints accepts an entity/company id from the client; a caller cannot
  address a foreign row. Missing trusted tenant context fails closed.
- `T-blast`: two companies share source text, phone, postal code, and downstream
  facts; every endpoint remains company-A-only.
- `R-matrix`: tenant_admin and manager allow paths pass for all three endpoints;
  dispatcher and provider deny paths return 403 before the service is called.
- Sabotage: removing the base cohort's tenant guard makes the real-PostgreSQL suite
  fail, proving the guard is load-bearing.
- Spend sabotage `SAB-LCA-COST-COMPANY`: removing `company_id = $1` from
  `loadCostSnapshot` makes company A absorb company B's same-account,
  same-campaign, same-date spend and fails the real-PostgreSQL summary assertion.

Chunk 1b must apply the same contract to every connector worker, credential lookup,
external account/customer id, spend row, and sync status. Workers have no `req`, so
they must accept a trusted `companyId` explicitly and bind every external natural
key to it.

## Endpoint contracts

```text
GET /api/lead-channel-analytics/summary?from&to → {kpis:{leads,converted,visit_completed,jobs_done,revenue_net_cents,call_cost_cents,ad_spend_cents,roas,marketing_contribution_cents}, funnel:[{stage,count,conv_pct}], period:{from,to,timezone}}
GET /breakdown?dimension=channel|area|technician&from&to → {dimension, rows:[{key,label,leads,jobs_done,revenue_net_cents,ad_spend_cents|null,roas|null,marketing_contribution_cents,funnel_counts:{leads,converted,visit_completed,jobs_done}}], totals:{...}}
GET /data-quality?from&to → {attribution_coverage_pct, unallocated_spend_cents, tax_basis_unknown_cents, connected_sources:[{key:'google_ads',label:'Google Ads',status,last_synced_at,synced_from_date,synced_through_date}]}
```

With no connection and no spend, the response bytes remain at the chunk-1a
contract: summary/totals `ad_spend_cents=0`, all ROAS values `null`, breakdown-row
`ad_spend_cents=null`, `unallocated_spend_cents=0`, and
`connected_sources=[]`.

Stable validation errors use `{error:{code,message}}`. `from` and `to` are required
valid `YYYY-MM-DD` calendar dates with `to >= from`; the inclusive UTC date span is
capped by `MAX_RANGE_DAYS = 731` and a wider request returns
`RANGE_TOO_WIDE`/400. `dimension` is exactly `channel`, `area`, or `technician`.

Known limits / future hardening: a database `statement_timeout` and pagination for
very large tenants are deferred; the 731-day cap is the chunk-1a availability
mitigation.

## Architecture

`leadChannelAnalyticsService.js` builds one company-scoped fact per acquisition
lead, then derives the three projections from those facts. This seam keeps cohort
membership, attribution, and totals consistent across summary, breakdown, and
data-quality responses. Source identity is normalized through
`lead_source_channels` and `lead_source_aliases`; raw lead source text remains an
audit input rather than a mutable reporting key.

The service is intentionally fresh and does not reuse `analyticsService.js`, whose
F014 path has a known cross-tenant leak. The company cohort guard, repeated
downstream company predicates, and integer reconciliation for equal technician
splits are release invariants.

Chunk 1b adds spend through a connector-neutral boundary:
`lead_source_performance_daily` holds company-bound provider performance facts,
while a separate cost snapshot query feeds the projection layer without modifying
cohort membership. Connector installations own enable/disable and sync lifecycle;
the analytics engine reads neither OAuth credentials nor provider responses.
Google Ads is the first provider, not a hard-coded assumption in the cost
projection contract.

## Verification

### Chunk 1a backend

Environment: `DATABASE_URL=postgresql://localhost/twilio_calls`.

```text
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/leadChannelAnalytics.service.test.js tests/leadChannelAnalytics.routes.test.js tests/leadChannelAnalytics.db.test.js
```

Result: 3 suites, 31/31 passed (includes the range-cap regression below).

Tenant-guard sabotage control: neutered the cohort tenancy (`JOIN company_context`
→ `CROSS JOIN` and dropped `WHERE l.company_id = $1`) → the real-PostgreSQL
isolation suite went RED (`T-blast` `channel.totals.leads` 1 → 250, plus 3 more
failures) → restored byte-identical from a `cp` backup. This proves the guard is
load-bearing.

Focused range-cap regression:

```text
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/leadChannelAnalytics.service.test.js
```

Result: exit 0; 1 suite passed; 8/8 tests passed, including the inclusive 731-day
allow and 732-day `RANGE_TOO_WIDE`/400 denial.

### Chunk 1a frontend

```text
tsc -b
```

Result: clean.

Focused SSR render smoke, run from `frontend/`:

```text
env -u NODE_USE_SYSTEM_CA NODE_OPTIONS='--import=data:text/javascript,globalThis.__dirname=process.cwd()' ./node_modules/.bin/vitest run src/pages/AnalyticsPage.test.tsx --reporter=verbose --configLoader runner
```

Result: exit 0; 1 test file passed; 1/1 test passed. The runner loader is required
in this restricted worktree because bundled config loading attempts to write under
the main repository's read-only symlinked `node_modules/.vite-temp`; the one-shot
bootstrap preserves the existing `vitest.config.ts` without leaving a helper file.

### Chunk 1b Phase B backend

Implementation-side non-PostgreSQL regression:

```text
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/leadChannelAnalytics.service.test.js tests/leadChannelAnalytics.routes.test.js
```

Result: exit 0; 2 suites passed; 25/25 tests passed unchanged.

Owner real-PostgreSQL gate (required after review):

```text
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js --config ./package.json --testPathIgnorePatterns /node_modules/ --runInBand --forceExit --runTestsByPath tests/leadChannelAnalytics.service.test.js tests/leadChannelAnalytics.routes.test.js tests/leadChannelAnalytics.db.test.js
```

Inventory after the Phase B extension: 3 suites and 37 tests. The 12-test
real-PostgreSQL suite covers no-source byte compatibility, live summary/channel
spend, zero-lead synthetic rows, modeled area/technician allocation,
`unallocated_spend_cents`, non-secret connected-source status, gclid precedence,
and tenant isolation. Execution is intentionally pending the owner-run
PostgreSQL gate.

Owner sabotage gate: copy `leadChannelAnalyticsService.js` to a backup; remove
`WHERE company_id = $1` from the `lead_source_performance_daily` scan inside
`loadCostSnapshot`; run the three-suite command and confirm
`SAB-LCA-COST-COMPANY` goes RED because company A spend is inflated by company B;
restore the service exactly with `cp` and rerun green. This gate is intentionally
pending owner execution.

## Integration and MCP impact

Chunk 1b integrates with Google Ads through the marketplace connector described
above. Chunk 1a has **no MCP impact (read-only analytics, no new AI-reachable
capability)**.
