# LIST-PAGINATION-UNIFY-001 — unified list pagination

**Status:** PHASE A ACCEPTED / PHASE B IMPLEMENTED / OWNER PERF + MANUAL UX GATES PENDING

**Date:** 2026-07-18

**Surfaces:** `/leads`, `/jobs`, `/tasks`, `/contacts`, `/payments`

**Implementation in this turn:** Phase B, frontend T9–T15 only

## 1. Goal

Replace the five independent list-paging implementations with one frontend mechanism:

- cursor-backed forward loading;
- an explicit **Load more** button as the only continuation trigger;
- one shared request/state/dedup/abort implementation;
- one shared footer and one count vocabulary;
- server-authoritative filters, search, and sorts, so every loaded page belongs to the same complete result set;
- totals over all matching rows, not over a loaded client snapshot;
- for Payments, a server-calculated transaction count and dollar sum over all matching rows.

Success means an operator can apply any existing list control and explicitly click **Load more** to receive the next rows from that same globally filtered and sorted result set without an artificial 100/200/500/1000-row ceiling. Reaching the end of the list never starts a request.

## 2. Owner decisions and binding interpretation

The following are settled and are not implementation forks:

1. **Full result-set correctness.** Every search, filter, and sort currently applied only to a fetched client snapshot moves to an equivalent backend predicate or whitelisted order expression. Controls and rows do not change.
2. **Payments summary correctness.** The Payments header transaction count and `SUM(amount_paid)` are computed in PostgreSQL across every matching row before `LIMIT`; a page-only sum is a correctness defect.
3. **Page sizes.** Leads 100; Jobs 50; Tasks 50; Contacts 50; Payments 50. Mobile and desktop use the same size.
4. **Cursor pagination.** Leads defaults to `(created_at,id)`; Jobs and Payments use `(selected sort value,id)`; Contacts uses `id`; Tasks uses the selected sort tuple described in §5.3.
5. **Manual continuation only.** While `has_more=true`, a visible **Load more** button is always rendered. It is the primary and only continuation affordance: there is no observer, sentinel, scroll listener, restored-tab trigger, or other automatic fetch path.
6. **Indexes.** The cursor-index migration is approved as migration 187 because 186 is occupied on current master. Its number must be re-checked against the worktree and the live `origin/master` head immediately before either migration file is created.
7. **Security.** Leads and Jobs list routes and services fail closed without tenant context. Jobs searchable custom-field discovery is company-scoped.
8. **Abort and dedup.** The shared hook aborts obsolete requests and admits at most one request for a given next cursor. Contacts search is debounced and its current direct-call-plus-effect double request is removed.
9. **Existing presentation.** Lead/Job/Task rows and mobile tiles remain unchanged. Their existing `MobileListPage` shell remains. Contacts/Payments are not moved into that shell as part of this work.
10. **Boundary/default fixes.** Every cursor page uses a `limit + 1` probe. Leads no longer reports `has_more=true` at an exact page-size boundary. Jobs uses one default sort on both form factors.

### 2.1 Necessary correction to the shorthand Lead cursor decision

The owner-approved shorthand “Leads cursor `(created_at,id)`” is exact for the default **Created** sort. It cannot also be used for the existing Status/Name/Phone/Email/Location/Job Type/Source/ID sorts: fetching pages by creation time and then globally displaying them by another field necessarily skips the rows that should have sorted into earlier pages.

Therefore the binding, correctness-preserving interpretation is:

- default Lead sort: `(created_at DESC, id DESC)`;
- any other selected Lead sort: `(normalized selected sort expression, id)` in the selected direction.

The sort control remains unchanged. This is not an optional expansion; it is required by owner decision 1.

### 2.2 One Jobs default

The single Jobs default is:

```sql
ORDER BY j.start_date DESC NULLS LAST, j.id DESC
```

This intentionally changes the present desktop default from `created_at DESC`. The current mobile list groups by scheduled date; a created-time cursor can split and reorder scheduled-date groups as more pages arrive. `start_date DESC` is therefore the only existing default that keeps the same server order coherent in both the desktop table and the mobile grouped list. The mobile-only sort-setting effect is removed.

## 3. Invariants

1. Every list query and every metadata/facet/aggregate query is scoped by `company_id` from `req.companyFilter?.company_id`.
2. Effective provider visibility and Tasks ownership visibility are part of both the row predicate and cursor fingerprint.
3. A page has a deterministic total order. `id` is the final, unique tiebreaker.
4. Cursor values are SQL parameters. Sort expressions come only from closed server-side maps.
5. `TIMESTAMPTZ` cursor values retain PostgreSQL microseconds; they are not round-tripped through JavaScript `Date`.
6. `BIGINT` cursor IDs are encoded as decimal strings and are never coerced through JavaScript `Number`.
7. `has_more` comes from fetching `limit + 1`, returning at most `limit`, and minting a cursor from the last returned row only when the probe row exists.
8. Search/filter/sort/company changes abort the old generation, discard any late result, clear the cursor chain, and start at the first page.
9. Initial totals, Payments aggregates, and facets are calculated over the complete matching predicate. They are never derived by flattening loaded pages.
10. Subsequent cursor pages do not repeat total/aggregate/facet scans.
11. Rows already loaded remain visible during `loading-more` and a load-more error.
12. No list fetches a continuation without an explicit **Load more** or **Retry load more** click. Errors never trigger an automatic retry loop.
13. `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`, and `src/server.js` remain untouched.

## 4. Common cursor contract

### 4.1 Request rules

All five routes accept:

```text
limit=<positive integer>
cursor=<opaque token>       # absent on the first page
```

The first page omits both `cursor` and `offset`. Existing offset parameters remain available for non-page callers during this feature; sending both a non-empty `cursor` and `offset` is `400 INVALID_CURSOR_REQUEST`.

The page sizes in §2 are frontend constants, not total-result caps. Existing per-request safety maxima may remain for legacy callers. `/tasks` stops asking for 500 rows and `/payments` stops asking for 200/1000 rows; both continue through as many 50-row cursor pages as needed.

### 4.2 Additive response shape

Each cursor-capable response exposes this pagination object, while retaining any legacy top-level fields needed by other callers:

```ts
interface CursorPagination {
  mode: 'cursor';
  limit: number;
  returned: number;
  has_more: boolean;
  next_cursor: string | null;
  /** Complete match count on page one; null on continuation pages. */
  total: number | null;
}
```

- Leads and Contacts extend their existing `data.pagination`.
- Jobs adds `data.pagination` while its offset-mode fields remain backward compatible.
- Tasks adds `data.pagination` beside `data.tasks`.
- Payments adds `data.pagination` beside `data.rows`, `data.aggregates`, and `data.facets`.
- On the first page, `total` is a non-negative integer and is produced by the exact same normalized predicate as the row query.
- On a continuation page, `total` is `null`; the hook retains the first page's value.
- An empty first page is `{ returned:0, has_more:false, next_cursor:null, total:0 }`.

### 4.3 Cursor token

`backend/src/utils/listCursor.js` owns versioned base64url encoding/decoding. The decoded payload contains only:

```ts
{
  v: 1;
  endpoint: 'leads' | 'jobs' | 'tasks' | 'contacts' | 'payments';
  sort: string;
  direction: 'asc' | 'desc';
  fingerprint: string;
  values: Array<string | boolean | null>;
}
```

The fingerprint is SHA-256 over a canonical server-side representation of endpoint, company, effective provider/owner scope, normalized filters/search/sort/direction, and page size. It contains no raw user data. A cursor from another endpoint, tenant, actor scope, filter generation, sort, direction, or page size returns `400 INVALID_CURSOR`; it never silently starts a different walk.

Malformed base64url, malformed JSON, unsupported versions, wrong tuple arity/types, non-decimal BIGINT text, invalid timestamp text, and tokens above a small fixed length are also `400 INVALID_CURSOR`.

The token is opaque continuity state, not an authorization credential. Every continuation query independently applies the current authenticated tenant and permission scope.

### 4.4 SQL ordering and comparison

- Whitelisted text sorts use a documented normalized expression such as `LOWER(COALESCE(column,''))`; numeric fields remain numeric.
- Nullable sorts use an explicit null-rank plus value plus `id`, preserving `NULLS LAST` in both directions.
- For descending non-null tuples the continuation predicate is lexicographically “less than”; ascending uses “greater than”. Nullable cases are expanded into parameterized boolean clauses rather than interpolated values.
- Timestamp cursor projections use an explicit UTC microsecond text projection (for example, `YYYY-MM-DDTHH24:MI:SS.USZ`) and the predicate casts the supplied text back to `timestamptz`.
- The data query asks for `limit + 1`; hydration (Lead team, Job tags/finance) is applied only to the at-most-`limit` returned IDs.

## 5. Per-endpoint contract

### 5.1 Leads — `GET /api/leads`

**Page size:** 100.

**Existing server filters retained:** `start_date`, `end_date`, `only_open`, repeated `status`.

**New server-authoritative inputs:**

- `search` — case-insensitive name, company, phone, email, serial ID, and metadata fields whose `lead_custom_fields` row is `company_id = l.company_id`, `is_searchable=true`, `is_system=false`;
- repeated `source` — exact `job_source` membership;
- repeated `job_type` — exact `job_type` membership;
- `rejected_only=true` — `metadata @> '{"rely_filter":{"rejected":true}}'`;
- `sort_by` — `Status | FirstName | Phone | Email | City | JobType | JobSource | CreatedDate | SerialId`;
- `sort_order=asc|desc`;
- `limit=100`, optional `cursor`.

**Default:** `CreatedDate desc`.

**Cursor:** default `(created_at,id)`; alternate `(selected normalized expression,id)`. `SerialId` is numeric. Unknown sort names/directions are `400`, not fallback-to-default.

**Response:** current `results` and `filters`; extended cursor pagination. Page one runs the full-match count. Every page uses the extra-row probe, including legacy offset mode, fixing the exact-100 false positive.

**Tenant rule:** route returns 403 before calling the service when company context is absent; `listLeads` also throws `TENANT_CONTEXT_REQUIRED` before its first query. The optional `if (companyId)` branch is removed from this list path.

### 5.2 Jobs — `GET /api/jobs`

**Page size:** 50.

**Existing server predicates retained:** status/canceled, provider visibility, search, contact, only-open, scheduled date range, service/job type, selected providers, tags and tag match.

**New server-authoritative input:** `job_source` (comma-separated, matching the route's existing multi-value convention) replaces `useJobsData`'s client-only source filter.

**Search security and semantics:** searchable metadata uses a correlated company-scoped predicate:

```sql
EXISTS (
  SELECT 1
  FROM lead_custom_fields lcf
  WHERE lcf.company_id = j.company_id
    AND lcf.is_searchable = true
    AND lcf.is_system = false
    AND COALESCE(j.metadata ->> lcf.api_name, '') ILIKE $search
)
```

The current unscoped discovery query is deleted. Provider-name filtering uses exact names from `assigned_techs`, not substring matches against serialized JSON.

**Sort:** every currently whitelisted static column plus `meta:<api_name>`, always followed by `id` in the same direction. A metadata key must exist in the current company's custom-field catalog and is passed as a bind to `j.metadata ->> $N`; it is never interpolated into SQL, even after validation. Unknown fields, foreign-company keys, and malformed `meta:` names are `400`. Default for both mobile and desktop is `start_date desc` with nulls last.

**Cursor:** `(null-rank, selected sort value, id)` where nullable; otherwise `(selected sort value,id)`. Timestamp and BIGINT precision rules from §4 apply.

**Facet:** page one returns `facets.providers: string[]`, calculated over all rows matching company/effective provider visibility/search/date/status/source/job-type/tag/open predicates while excluding the selected provider predicate itself. Continuation pages return `facets:null`. This replaces both desktop and mobile derivation from the currently loaded jobs and prevents filter choices from remaining snapshot-limited. Statuses, sources, job types, and tags keep their existing catalogs.

**Tenant rule:** route and `listJobs` both require company context before any query. Missing context is 403 and zero database calls.

### 5.3 Tasks — `GET /api/tasks`

**Page size:** 50.

**Existing predicates retained:** status, parent type, overdue, due range, manager-selected assignee, and non-manager `scopeOwnerId`.

**New server-authoritative inputs:**

- `search` across task description/title, hydrated `parent_label`, and assignee name;
- `sort_by=description|parent_type|parent_label|assignee_name|due_at`;
- `sort_order=asc|desc`;
- optional `cursor`.

The existing role branch remains authoritative. The effective actor/ownership scope is part of the cursor fingerprint.

**Default cursor/order:**

```sql
ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC, t.id DESC
```

For `due_at`, the cursor carries null rank, microsecond due time, microsecond created time, and decimal-string ID. For other selected sorts it carries normalized selected value and ID. Parent type/label expressions are shared between SELECT, search, sort, cursor comparison, and count so the API cannot count a different set from the one it displays.

`tasksQueries.listTasks` remains array-returning for CRM service callers. A cursor-page query function is added for the route; `/api/tasks/count` and entity-card task lists are non-goals and preserve their contracts.

### 5.4 Contacts — `GET /api/contacts`

**Page size:** 50.

**Predicate:** existing company/provider visibility plus debounced search across full name, primary phone, secondary phone, and email.

**Order/cursor:** `ORDER BY c.id DESC`; cursor is a decimal-string `id`. There is no new sort control.

**Response:** complete first-page `total`, exact extra-row `has_more`, and `next_cursor`. Offset remains for small legacy consumers such as the softphone search dropdown.

**Frontend search:** 300 ms trailing debounce. The input setter only changes input state; it does not call the API directly. The debounced value is the query key, eliminating today's direct request plus effect request.

### 5.5 Payments — `GET /api/zenbooker/payments`

`/payments` continues to use the local Zenbooker payments endpoint; it is not switched to another payments API.

**Page size:** 50.

**Existing server predicates retained:** required date range, payment method, quick filter, and search.

**New server-authoritative inputs:**

- `provider` — exact trimmed technician name within the stored comma-separated `tech` value;
- `paid_status=paid|due` — `invoice_paid_in_full IS TRUE` versus `IS NOT TRUE`;
- all existing table sorts: `payment_date`, `amount_paid`, `invoice_amount_due`, `job_number`, `client`, `payment_methods`, `tech`;
- `sort_order=asc|desc`, optional `cursor`.

**Default cursor/order:** `payment_date DESC NULLS LAST, id DESC`. Alternate sorts use normalized selected value plus ID. Money fields are numeric, not string-sorted.

**First-page response:**

```ts
interface PaymentsListData {
  rows: PaymentRow[];
  pagination: CursorPagination;
  aggregates: {
    transaction_count: number;
    /** PostgreSQL NUMERIC serialized as exact decimal text. */
    total_amount: string;
  };
  facets: {
    payment_methods: string[];
    providers: string[];
    undeposited_check_count: number;
  };
}
```

Continuation pages return `aggregates:null` and `facets:null`; the hook retains page-one metadata.

The aggregate query is:

```sql
SELECT COUNT(*)::int AS transaction_count,
       COALESCE(SUM(COALESCE(amount_paid, 0)), 0)::text AS total_amount
FROM zb_payments
WHERE <the exact final row predicate>;
```

It runs before and independently of the page `LIMIT`. `pagination.total` equals `aggregates.transaction_count` on page one. Negative stored amounts, if any, participate in the sum; there is no client rounding or currency conversion.

`facets` replace the current capped `uniqueMethods`, `uniqueProviders`, and `undepositedCheckCount` derivations. To retain the present control semantics, they use the base tenant/date/payment-method/quick/search predicate before provider and paid-status are applied. The final rows and header aggregates apply **all** active predicates, including provider and paid status.

Sync completion and a deposited-check mutation reset/refetch the cursor chain and page-one aggregates. Export keeps its explicitly documented date-range-wide semantics and is not changed by this feature.

## 6. Shared frontend mechanism

This reuses the repository's proven data pieces instead of introducing a second stack: `usePulseTimeline` is the `useInfiniteQuery`/opaque-cursor precedent, and `MobileListPage` remains the mobile shell for Leads/Jobs/Tasks. The new hook generalizes forward append, abort, and dedup. It deliberately does not reuse Pulse's observer or reverse/prepend scroll-anchor behavior.

There is exactly one continuation entry point: the footer button invokes `loadMore()`. The shared hook contains no `IntersectionObserver`, sentinel ref, scroll listener, viewport test, `pageshow`/visibility handler, online handler, or effect that calls `loadMore()`.

### 6.1 Hook

New: `frontend/src/hooks/useLoadMoreList.ts`, backed by React Query's existing `useInfiniteQuery` pattern.

```ts
type LoadMoreState =
  | 'idle-with-more'
  | 'loading-more'
  | 'all-loaded'
  | 'error+retry'
  | 'empty';

interface CursorPage<T, TMeta = never> {
  items: T[];
  pagination: CursorPagination;
  meta: TMeta | null;
}

interface UseLoadMoreListOptions<T, TMeta> {
  /** Must include endpoint, company ID, every normalized filter, debounced search,
      selected sort, and direction. */
  queryKey: readonly unknown[];
  pageSize: number;
  enabled?: boolean;
  fetchPage(args: {
    cursor: string | null;
    limit: number;
    signal: AbortSignal;
  }): Promise<CursorPage<T, TMeta>>;
  getItemKey(item: T): string | number;
}

interface UseLoadMoreListResult<T, TMeta> {
  items: T[];
  total: number | null;
  meta: TMeta | null;
  /** null while disabled or while the first page is loading. */
  state: LoadMoreState | null;
  hasMore: boolean;
  error: Error | null;
  errorPhase: 'first' | 'more' | null;
  isLoadingFirst: boolean;
  isFetching: boolean;
  loadMore(): Promise<void>;
  retry(): Promise<void>;
  /** Abort/remove all pages and fetch a new first page. */
  reset(): Promise<void>;
  /** For non-ordering display-only mutations. Ordering/filter mutations use reset. */
  updateItem(key: string | number, update: (item: T) => T): void;
}
```

Each endpoint adapter maps its existing envelope to `CursorPage`; the hook does not know endpoint-specific query names.

### 6.2 Abort, stale-result rejection, and dedup

1. `fetchPage` consumes the `AbortSignal` supplied by `useInfiniteQuery` and passes it through the existing API service to `authedFetch`; protected auth-client code is not modified.
2. The hook also owns a monotonically increasing generation. A filter/key change or `reset()` aborts all active requests from the old generation. A transport that ignores abort still cannot commit an old-generation result.
3. `loadMore()` is called only by the explicit footer action. It is a no-op unless a successful first page exists, `has_more=true`, and a non-empty `next_cursor` is available.
4. The gate is keyed by `next_cursor`. While that cursor is in flight or has already succeeded, another click is a no-op.
5. Flattening preserves first-seen order and de-duplicates by `getItemKey`; a later copy may update the value at that position but cannot add a duplicate row.
6. A load-more retry requests the same failed cursor. It never clears already loaded pages. React Query automatic retry is disabled; retries are explicit.

### 6.3 Search timing

- Leads, Jobs, Tasks, Contacts: 300 ms trailing debounce before their query key changes.
- Payments retains its current 400 ms trailing debounce.
- Clearing a search updates immediately.
- Debounce controls request timing only; all matching is server-side.

### 6.4 State machine

| State | Entry condition | Rows | Footer/action |
|---|---|---|---|
| `idle-with-more` | a successful page exists with `has_more=true` and no continuation is active | retained | `N of M … loaded`; visible **Load more** |
| `loading-more` | an explicit continuation request is in flight | retained | count retained; same button disabled as **Loading…** |
| `all-loaded` | successful non-empty result with `has_more=false` | retained | `All M … loaded`; no button |
| `error+retry` | first or continuation request failed | none for first error; retained for continuation error | honest error copy plus **Retry** / **Retry load more** |
| `empty` | successful first page with `total=0` | none | existing page empty state; no footer |

The first-page request is the normal query bootstrap, not a continuation state. While it is active, `state` is `null`, `isLoadingFirst=true`, and the existing page-owned skeleton/loading treatment is shown. A browser offline error is handled like any other request error: no queued intent or reconnect-triggered request exists.

### 6.5 Footer

New: `frontend/src/components/lists/LoadMoreFooter.tsx`.

```ts
interface LoadMoreFooterProps {
  state: LoadMoreState | null;
  loadedCount: number;
  totalCount: number | null;
  singularLabel: string; // lead, job, task, contact, transaction
  pluralLabel: string;
  errorPhase: 'first' | 'more' | null;
  onLoadMore(): void;
  onRetry(): void;
}
```

It uses existing Blanc tokens and the existing button primitive; it adds no card or separator. It lives at the end of the actual list content. It renders no sentinel and owns no effects.

The current Lead text `Showing 1 - 1 leads` and every Prev/Next range are replaced by:

- while more exists: **100 of 327 leads loaded** + **Load more**;
- during append: **100 of 327 leads loaded** + disabled **Loading…**;
- after completion: **All 327 leads loaded**;
- continuation error: **100 of 327 leads loaded · Couldn't load more leads.** + **Retry load more**.

The same copy pattern applies to jobs, tasks, contacts, and transactions. The button remains visible for both `idle-with-more` and `loading-more`; only its disabled/loading treatment changes. A separate visual mockup is unnecessary: there is one flat footer row and the state table above completely defines its variants.

## 7. Page integration rules

1. Lead/Job/Task mobile branches remain inside `MobileListPage`; only their old local button/count is replaced.
2. Contacts and Payments keep their current page and scroll shells. Moving them to `MobileListPage` would be a layout redesign and remains debt.
3. Desktop Prev/Next behavior is removed. Loaded rows append on desktop and mobile alike.
4. The existing row and tile components, selection behavior, detail panels, filter controls, and column controls remain visually unchanged.
5. First-load skeletons remain page-owned. A continuation request never swaps the list for a first-load skeleton.
6. A query-key change resets pagination to page one but does not forcibly scroll the operator to the top; existing browser scroll behavior is retained.
7. Any successful in-app mutation that can change membership or the active sort tuple resets the list to a fresh first page. `updateItem` is limited to display-only fields that cannot affect the active predicate/order.
8. Tenant identity is a required segment of every React Query key so cached pages cannot cross a company switch.

## 8. Data-integrity model

### 8.1 Guaranteed for concurrent inserts

With a unique keyset order and unchanged original rows, an insert between page requests cannot shift the continuation boundary:

- an inserted row before the saved cursor is not injected into the already-started walk;
- an inserted row after the saved cursor may appear once in a later page;
- every row present at the start of the walk still appears exactly once by the end;
- frontend key dedup is a second defense, not the source of correctness.

The real-DB test in §11 proves this for all five endpoint shapes, including a dynamic sort and a timestamp tie.

### 8.2 Deliberate non-snapshot behavior

No stateless cursor provides a serializable snapshot when existing rows are updated or deleted between requests. This matters most for mutable Jobs/Tasks/Payments alternate sort fields. An external update can move a row across the cursor boundary; a delete can reduce the final walk; page-one totals/aggregates can become stale until reset.

In-app membership/order mutations reset the chain. External changes are reconciled on the next reset/refetch. A stronger guarantee would require a database snapshot/materialized result token with lifecycle state, which is not approved and is a non-goal. “Full correctness” in this feature means full server predicates/sorts/totals and insert-safe keyset walking, not long-lived snapshot isolation against arbitrary mutations.

## 9. Security requirements

1. Leads and Jobs list routes read company only from `req.companyFilter?.company_id` and return 403 before invoking their service if it is missing.
2. Their services independently reject a missing company before any query; direct service callers cannot accidentally open an unscoped path.
3. Jobs custom-field search correlates `lead_custom_fields.company_id` to the current job/company. No preliminary unscoped custom-field query remains.
4. Every count, facet, aggregate, and cursor-page query repeats tenant and effective visibility predicates. A scoped row-ID list is not used to justify an otherwise unscoped metadata query.
5. Cursors are bound to company and effective visibility via their fingerprint, but SQL company predicates remain mandatory even after successful cursor validation.
6. Foreign-tenant cursor replay returns 400 or an empty scoped result; it can never return the foreign row.

## 10. Index migration

Expected filenames, subject to the mandatory number check at implementation time:

```text
backend/db/migrations/187_list_pagination_cursor_indexes.sql
backend/db/migrations/rollback_187_list_pagination_cursor_indexes.sql
```

Approved indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_lpu_leads_company_created_id
  ON leads (company_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_lpu_jobs_company_start_id
  ON jobs (company_id, start_date DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS idx_lpu_jobs_company_created_id
  ON jobs (company_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_lpu_tasks_company_status_due_created_id
  ON tasks (company_id, status, due_at ASC NULLS LAST, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_lpu_contacts_company_id
  ON contacts (company_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_lpu_zb_payments_company_date_id
  ON zb_payments (company_id, payment_date DESC NULLS LAST, id DESC);
```

The rollback drops exactly these indexes with `IF EXISTS`. The migration is additive and idempotent. It does not add a combinatorial index for every selectable sort.

At implementation time:

1. resolve the maximum forward migration in the worktree;
2. resolve the current remote `refs/heads/master` hash with `git ls-remote`;
3. inspect that exact remote head's migration names, not merely a stale local tracking ref;
4. if 187 is occupied in either tree, renumber both forward and rollback files to the next free number before writing them.

## 11. Performance gate

### 11.1 Known plan risks from discovery

- **Leads:** the current company/date/order path bitmap-scans and sorts; the new default composite index removes the full result sort. Multi-column `%term%` and searchable JSON metadata can still scan the tenant/date slice.
- **Jobs:** current default plans on the production copy use a sequential scan plus sort (about 1,368 rows; the observed start-date case was small but structurally unindexed at the ID tie). The new start/ID index is required. Search, JSON provider filtering, tags, metadata, and unindexed alternate sorts may still scan/sort the scoped match set.
- **Tasks:** current production-copy table is small (about 166 rows) and sequential plans are cheap today, but the default cursor needs the full status/due/created/ID index. Search and derived parent-label sorts necessarily touch joins and may not be index-only.
- **Contacts:** current primary-key walk filters company after reading IDs; the company/ID index is required for tenant-local continuation. `%term%` search may scan the tenant slice.
- **Payments:** the current company/date path is already index-backed; the ID suffix makes ties cursor-safe. Full-match count/sum/facets and multi-column `%term%` search must inspect all matching rows, but only on page one.

No speculative `pg_trgm` or per-sort index matrix is included. If the production-copy gate below fails, release stops and the failing expression receives a separately justified index proposal.

### 11.2 EXPLAIN protocol

Run each statement three times on a read-only production copy, discard the cold first execution, and retain both warm outputs:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS) <exact final SQL with representative binds>;
ROLLBACK;
```

Use a representative high-row tenant and real selective values. Page-two statements must use the actual `next_cursor` tuple returned by page one, including an equal-primary-sort-value tie where available.

T15 creates `tests/listPaginationPlans.db.test.js`, a verification-only harness that wraps the real `db.query` during real service calls, runs `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON)` with the exact SQL text and bind array the service is about to execute, then executes the SELECT normally. The process is forced read-only with `PGOPTIONS`; the harness discovers representative values without inserting fixtures. This avoids a hand-copied EXPLAIN query drifting from production logic.

| Endpoint | EXPLAINs required |
|---|---|
| Leads | default open/30-day page one data; same page two cursor; first-page count; status+source+job-type+rejected predicate; non-empty search including a company-scoped searchable metadata match; one alternate text sort and SerialId sort |
| Jobs | default start-date page one and actual page two; created-at alternate; first-page count; source+provider+tag filters under full provider scope and assigned-only scope; normal-field search and custom-metadata search; provider facet; one unindexed text sort and one `meta:` sort |
| Tasks | manager open/default due page one and page two; non-manager owner-scoped equivalents; first-page count; parent-type filter; search matching parent label and assignee; `parent_label` alternate sort |
| Contacts | default ID page one and page two under full and assigned-only scopes; first-page count; a common search hit and a rare/no-match search |
| Payments | default date page one and page two; first-page count+sum with date/search/method/provider/paid/quick filters; facets; search case; amount sort; tech text sort |

### 11.3 Pass/fail criteria

- Default page-one/page-two row queries use the approved composite index and do not sort the entire tenant table.
- Page-two service execution contains no count, aggregate, or facet query.
- No plan spills to temporary disk.
- Warm row-page statements complete in at most 100 ms on the production copy; first-page search/count/facet/aggregate statements complete in at most 250 ms.
- Any sequential scan over a base table with a high removed-row ratio, any timeout, or any plan above those limits blocks release and is reported with actual rows/buffers before another migration is proposed.

## 12. Test and sabotage gates

### 12.1 Required behavioral tests

1. First page, continuation, final short page, empty page, invalid cursor, cursor/query mismatch, and exact-limit final page for each endpoint adapter.
2. Every existing client-only predicate/sort is proven to affect the complete server result, not only page one.
3. Tenant/provider/owner predicates are identical in row, total, facet, and aggregate queries.
4. Search/filter/sort key changes abort old work and ignore late completion.
5. Rapid or repeated **Load more** clicks for one cursor produce one HTTP request and one appended page.
6. Retry preserves loaded rows and reuses only the failed cursor.
7. No observer, sentinel, scroll listener, viewport/restored-tab handler, or effect-driven continuation exists; reaching the end of a list causes zero requests.
8. Payments count and exact decimal sum apply every active filter and are unchanged by page size.

### 12.2 Named sabotage controls (minimum gate)

1. **SAB-JOBS-CUSTOM-FIELD-TENANT** — seed company B with a searchable custom-field key that company A does not register, while an A job contains that metadata key/value. Searching as A must not match until A owns the field definition, and a B job must never appear. Temporarily remove the `lcf.company_id = j.company_id` predicate: the test must turn red; restore with an exact patch.
2. **SAB-CURSOR-OFFSET-INSERT** — seed more than two pages for every endpoint shape, record baseline IDs, fetch page one, concurrently insert a row before the saved cursor, then walk to completion. Baseline IDs must appear exactly once with no skips; the new ahead-of-cursor row must not shift the walk. Temporarily replace one dynamic and one fixed continuation predicate with offset paging: the test must turn red; restore.
3. **SAB-PAYMENTS-PAGED-AGGREGATE** — seed at least 51 matching payments where row 51 contributes a unique non-zero amount. Page size is 50; `transaction_count` and `total_amount` must include row 51. Temporarily calculate the aggregate from the limited page CTE: the test must turn red; restore.
4. **SAB-LEADS-EXACT-BOUNDARY** — seed exactly 100 matching Leads. Page one must return 100 with `has_more=false` and no cursor. Temporarily restore `results.length >= limit`: the test must turn red; restore.
5. **SAB-LOAD-MORE-DEDUP** — call the shared cursor gate twice with the same cursor. Exactly one admission is allowed. Temporarily remove the in-flight cursor rejection: the core test must turn red; restore.
6. **SAB-MANUAL-LOAD-ONLY** — the structural gate rejects `IntersectionObserver`, sentinel/scroll/restored-tab wiring, and any hook effect that invokes `loadMore`/`fetchNextPage`. Temporarily add an observer token to the shared hook: the test must turn red; restore.

Sabotage is performed in the owning implementation task: apply mutation, run the named test to prove RED, restore with `apply_patch`, rerun GREEN, and report both outcomes. Tests are never weakened to make the sabotage pass.

## 13. Exact touch list

Line anchors are the current 2026-07-18 worktree and must be re-read before editing.

### 13.1 Documentation

- `docs/specs/LIST-PAGINATION-UNIFY-001.md` — new specification.
- `docs/tasks.md:10745` — appended ordered T1–T15 plan.

### 13.2 Backend shared/index/test infrastructure

- `backend/src/utils/listCursor.js` — new cursor codec/fingerprint/validation helpers.
- `backend/db/migrations/187_list_pagination_cursor_indexes.sql` — new, renumbered because 186 is occupied; re-check first.
- `backend/db/migrations/rollback_187_list_pagination_cursor_indexes.sql` — matching rollback.
- `tests/listCursor.test.js` — new pure cursor contract tests.
- `tests/listPaginationMigration.test.js` — new migration structure/idempotency pins.
- `tests/listPaginationUnify.db.test.js` — new real-PostgreSQL page-walk/concurrency/aggregate gate.
- `tests/listPaginationPlans.db.test.js` — new read-only production-copy EXPLAIN harness, created in T15.

### 13.3 Leads backend/frontend

- `backend/src/routes/leads.js:62` — parse new list inputs, mandatory tenant, cursor errors.
- `backend/src/services/leadsService.js:186` — complete predicates/count/dynamic keyset/limit+1.
- `tests/leadsListPagination.test.js` — new route/service contract tests.
- `frontend/src/types/lead.ts:61` and `:70` — params and cursor pagination types; `:176` is the sort whitelist source.
- `frontend/src/services/leadsApi.ts:56` — send cursor/server controls and `AbortSignal`.
- `frontend/src/pages/LeadsPage.tsx:30-100`, `:118-143`, `:149-190` — shared hook, server query key, footer wiring, remove offset/client filtering.
- `frontend/src/hooks/useLeadsActions.ts:9-57` — reset list after membership/order mutations instead of mutating a partial snapshot.
- `frontend/src/components/leads/LeadsTable.tsx:9-18`, `:95-118` — pagination props/footer only; rows unchanged.
- `frontend/src/components/leads/LeadsMobileList.tsx:25-32`, `:108-119` — pagination props/footer only; tiles unchanged.

### 13.4 Jobs backend/frontend

- `backend/src/routes/jobs.js:157` — mandatory tenant, source/cursor parsing, 400 handling.
- `backend/src/services/jobsService.js:679-844`, `:846-916` — scoped search, predicates/facet, dynamic keyset, then existing page hydration.
- `tests/jobsListPagination.test.js` — new route/service/security tests.
- `frontend/src/services/jobsApi.ts:70-94`, `:112` — cursor pagination/facet/request signal types.
- `frontend/src/hooks/useJobsData.ts:15-42`, `:75-163`, `:181-228` — one infinite query, server source filter, one default, remove offset/mobile duplicate path.
- `frontend/src/hooks/useJobsPage.ts:23-26`, `:47-56`, `:64-100` — list reset/update integration.
- `frontend/src/pages/JobsPage.tsx:68-114`, `:117-198` — shared footer wiring on both form factors.
- `frontend/src/components/jobs/JobsTable.tsx:15-31`, `:61-76`, `:151-162` — first-vs-more loading and footer props only; rows unchanged.
- `frontend/src/components/jobs/JobsMobileList.tsx:26-33`, `:88-101`, `:127-138` — shared footer props; tiles/grouping unchanged.
- `frontend/src/components/jobs/JobsFilters.tsx:15-34`, `:49-58` — consume server provider facet instead of loaded jobs.
- `frontend/src/components/jobs/JobsMobileBar.tsx:80-102`, `:158-167` — same provider facet on mobile.
- `frontend/src/components/jobs/JobsFilterBody.tsx:24-25` — update the provider-list contract comment only.

### 13.5 Tasks backend/frontend

- `backend/src/routes/tasks.js:44-66` — parse server search/sort/cursor and return pagination.
- `backend/src/db/tasksQueries.js:39-72`, `:149-230` — shared derived expressions/predicate/count plus new cursor-page function; legacy `listTasks` and `/count` stay compatible.
- `tests/tasksListPagination.test.js` — new route/query contract tests.
- `frontend/src/components/tasks/tasksApi.ts:69-78`, `:117-131` — cursor page types/request signal.
- `frontend/src/pages/TasksPage.tsx:61-127`, `:159-266`, `:269-434` — server query, shared footer on mobile/desktop, remove 500-row snapshot and client sort/search.

### 13.6 Contacts backend/frontend

- `backend/src/routes/contacts.js:138-156` — cursor validation/response errors.
- `backend/src/services/contactsService.js:50-122` — ID keyset, count, limit+1; existing mandatory tenant/provider scope retained.
- `tests/contactsListPagination.test.js` — new route/service tests.
- `frontend/src/types/contact.ts:99-118` — cursor params/pagination.
- `frontend/src/services/contactsApi.ts:83-90` — cursor and signal.
- `frontend/src/pages/ContactsPage.tsx:12-39`, `:62-80`, `:100-125` — debounced shared query; delete direct-call double fire/offset handlers.
- `frontend/src/components/contacts/ContactsList.tsx:1-15`, `:27-42`, `:122-147` — shared footer at end of existing scroll content; tiles unchanged.

### 13.7 Payments backend/frontend

- `backend/src/routes/zenbooker/payments.js:105-137` — provider/paid/cursor/sort inputs and typed 400s.
- `backend/src/services/zenbookerPaymentsSyncService.js:901-995` — shared predicate, dynamic keyset, complete aggregate/facets, limit+1.
- `tests/zenbookerPaymentsListPagination.test.js` — new cursor/filter/aggregate tests.
- `frontend/src/components/payments/paymentTypes.ts:75`, `:126-134` — response metadata and existing sort union.
- `frontend/src/hooks/usePaymentsPage.ts:15-55`, `:101-140` — infinite query, server filters/sort/summary, reset after mutation/sync, remove page slicing and client sum.
- `frontend/src/pages/PaymentsPage.tsx:201-213`, `:215-264` — server aggregate header and shared footer; rows unchanged.
- `frontend/src/pages/PaymentsPage.css:281-289`, `:456-488`, `:553-564` — retain summary styling; remove/replace obsolete Prev/Next-only pagination rules as needed.

### 13.8 Frontend shared/test infrastructure

- `frontend/src/hooks/useLoadMoreList.ts` — new shared manual infinite-query/abort/dedup hook.
- `frontend/src/hooks/useDebouncedSearch.ts` — new shared debounce helper used by all five server-search inputs.
- `frontend/src/hooks/loadMoreListCore.ts` — new pure merge/state/request-gate helpers.
- `frontend/src/hooks/loadMoreListCore.test.ts` — new real-logic unit tests.
- `frontend/src/components/lists/LoadMoreFooter.tsx` — new shared manual footer.
- `tests/listPaginationUi.structural.test.js` — new source contract pins for signal threading, no client snapshot filters/sorts, manual-only button presence, and page wiring.

### 13.9 Explicitly untouched

- `frontend/src/components/layout/MobileListPage.tsx` — reused unchanged.
- All Lead/Job/Task/Contact/Payment row/tile/detail renderers except pagination props around them.
- `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`, `src/server.js`.
- Pulse timeline pagination and `usePulseTimeline`.
- Canonical payment transaction APIs and Payments export service.

## 14. Non-goals

- No row, tile, table-column, filter-control, search-control, detail-panel, or form redesign.
- No virtualization/windowing; loaded rows remain in memory for the current query generation.
- No automatic continuation: no infinite scroll, observer, sentinel, scroll listener, viewport trigger, restored-tab trigger, or reconnect-triggered request.
- No backward pagination or restoration of a specific old offset.
- No immediate removal of legacy offset inputs used by non-page callers.
- No Contacts/Payments `MobileListPage` conversion.
- No changes to Pulse's reverse cursor timeline.
- No new npm dependency.
- No broad search architecture, full-text search, trigram migration, or index for every alternate sort unless the approved production-copy gate proves one necessary and the owner approves the follow-up.
- No serializable database snapshot across arbitrary updates/deletes.
- No change to Payments export scope, payment sync semantics, currency, or accounting signs.
- No migration application, deployment, commit, or push as part of this plan turn.

## 15. Completion criteria

The feature is complete only when:

1. all five pages use `useLoadMoreList` and `LoadMoreFooter` on desktop and mobile, with explicit button clicks as the only continuation path;
2. every existing list control changes the full backend result set;
3. all five first pages expose complete totals and all continuations are cursor-based;
4. Payments header count/sum are server values over all matches;
5. Leads/Jobs missing-tenant paths perform zero SQL and Jobs custom-field search passes tenant isolation;
6. exact-limit and concurrent-insert page walks pass;
7. abort/dedup/manual-only state tests pass;
8. all three required sabotage controls (plus the Lead boundary control) demonstrably turn their targets red and are restored green;
9. the migration apply/rollback/re-apply gate passes with the final free number;
10. every required EXPLAIN passes §11.3;
11. all affected backend suites, the entire frontend test suite, and the production frontend build pass;
12. protected files and out-of-scope row/tile renderers have no unintended diff.
