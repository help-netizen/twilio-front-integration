# PF007-HARDENING-001 — Manual Verification Checklist

**Scope:** provider assigned-only visibility, tenant isolation, deny-by-default RBAC.
**Automated coverage:** `tests/pf007ProviderScope.test.js`, `tests/jobsProviderScope.test.js`,
`tests/scheduleProviderScope.test.js`, `tests/contactsPulseTenantIsolation.test.js`,
`tests/paymentsRoute.test.js` (PF007 block), `tests/routes/fsm.test.js` (PF007 block).

## Test users

Prepare in one tenant (Company A):
- **Admin** — `tenant_admin` (all permissions)
- **Dispatcher** — `dispatcher` (`job_visibility: all`, no finance permissions)
- **Provider** — `provider` with scope override `job_visibility: assigned_only`,
  profile mapped to a Zenbooker team member (`zenbooker_team_member_id`)

And a second tenant (Company B) with its own admin and data.

## 1. Provider assigned-only (backend)

- [ ] `GET /api/jobs` as Provider returns only jobs whose `assigned_provider_user_ids`
      contains the provider's `crm_users.id`
- [ ] `GET /api/jobs/:id` for a non-assigned job → **404** (not 403)
- [ ] `GET /api/jobs/:id/history` and `/notes` follow the same rule
- [ ] `GET /api/schedule` as Provider: only own `job`/`task` items, **no `lead` items**
- [ ] `GET /api/contacts` as Provider: only contacts linked to visible assigned jobs
- [ ] `GET /api/pulse/timeline/:contactId` for a foreign client → 404
- [ ] Re-assign the job in Zenbooker → provider loses access after webhook sync

## 2. Tenant isolation (two companies)

- [ ] Admin of Company A requesting Company B entity ids (jobs, contacts, users,
      timelines, estimates, invoices, payments) → **404** everywhere
- [ ] `GET /api/users` as Company A admin never lists Company B members
- [ ] SMS phone-number match cannot pull Company B conversations into an A timeline
- [ ] `POST /api/pulse/threads/:id/*` on a Company B timeline id → 404

## 3. super_admin has no tenant bypass

- [ ] Platform super admin on any `/api/jobs|contacts|pulse|schedule|payments` route →
      `403 PLATFORM_SCOPE_ONLY`
- [ ] `/settings/admin` (platform UI) still reachable for the platform super admin
- [ ] Tenant navigation is not rendered for a platform-only session

## 4. Deny-by-default route permissions

- [ ] Dispatcher without `financial_data.view`: Pulse timeline has `financial_events: []`
- [ ] User without `payments.view`: `GET /api/payments`, `/summary` → 403 (no totals leak)
- [ ] User without `payments.refund`: refund/void → 403
- [ ] User without `schedule.dispatch`: reassign/reschedule/from-slot/settings → 403
- [ ] Closing a job (`Job is Done` / `Canceled`) without `jobs.close` /
      `jobs.done_pending_approval` → 403 (both `PATCH /api/jobs/:id/status` and FSM apply)
- [ ] `GET /api/fsm/job/actions?roles=company_admin` as Provider does NOT reveal
      admin-only actions (server-side roles win)

## 5. Frontend gating (UI is convenience, backend is authoritative)

- [ ] Top nav and mobile nav show only workspaces backed by permissions
      (`/schedule` tab requires `schedule.view`, not `jobs.view`)
- [ ] Settings menu hides entries without backing `tenant.*` permission
- [ ] Provider on Jobs page: network tab shows **no** requests to
      `/api/settings/job-tags`, `/api/settings/jobs-list-fields`
- [ ] Provider job detail: no Finance tab, **no** requests to `/api/estimates`,
      `/api/invoices`
- [ ] Provider on Schedule: **no** requests to `/api/schedule/settings`,
      `/api/zenbooker/team-members`; reassign/create-from-slot controls absent
- [ ] Direct URL navigation to a hidden page shows Access Denied

## Known gaps / rollout risks

1. **Migration 096 must be applied before deploy** (and the provider bridge mapped in
   Team Management) — otherwise `assigned_only` providers see zero jobs.
2. `requireRole('super_admin')` on legacy `/api/admin/*` routes still accepts the
   Keycloak realm role; platform_role in DB is the target source (compat window).
3. Phone-lookup helpers default to the legacy company when no tenant context is
   passed (webhook paths) — correct for current single-tenant data; revisit when
   multiple companies share Twilio numbers.
4. `messages`, `leads`, `calls`, `email` surfaces are outside PF007-HARDENING-001
   scope and keep their current behavior (follow-up hardening candidates).
5. Provider scope for contacts/pulse depends on `jobs.assigned_provider_user_ids`
   freshness; it is refreshed on every Zenbooker sync and on bridge-mapping changes.
