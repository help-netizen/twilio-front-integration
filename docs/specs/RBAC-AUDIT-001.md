# RBAC-AUDIT-001 — Role-based access control audit (2026-06-28)

**Type:** audit / review (no code changes in this pass). Verdict: **the role system is real, seeded, and
working; the core is solid. A handful of real gaps are worth fixing — none is a confirmed active breach.**

## 1. The model (as-is)
- **4 preset roles per company** (migrations 046/047/050, `roleQueries`, `authorizationService`):
  `tenant_admin` (= "Admin"), `manager` (= "Manager"), `dispatcher` (= "Dispatcher"),
  `provider` (= "Technician"). The owner's "Dispatcher/Technician/Manager/Admin" all exist (Technician =
  `provider`, Admin = `tenant_admin`). Tenant Admin is locked.
- **42 permissions** (catalog seeded in `050_seed_role_configs.sql`) + **5 value-scopes**
  (`job_visibility`, `financial_scope`, `dashboard_scope`, `report_scope`, `job_close_scope`).
- **Access-grid tables** exist: `company_role_configs`, `company_role_permissions`, `company_role_scopes`,
  `company_membership_permission_overrides`, `company_membership_scope_overrides`.
- **Resolution flow** (works): `keycloakAuth` → `crm_users` → active `company_membership` → role config
  perms+scopes → per-member overrides → `req.authz.{permissions,scopes}` + `req.companyFilter.company_id`.
  Middleware: `requirePermission` / `requireTenantContext` / `requirePlatformRole` (deny-by-default, audits
  403s). Frontend reads it from `GET /api/auth/me`; `useAuthz().hasPermission/hasAnyPermission`.

## 2. What's healthy (verified)
- Roles seeded + resolve correctly; tenant_admin gets MANDATORY_ADMIN_PERMISSIONS baseline.
- **Core business routes are heavily permission-gated AND company-scoped** (`requirePermission` counts:
  payments 11, invoices 25, estimates 24, leads 18, jobs 23, contacts/users/most-settings gated).
- Recent BUSINESS features respect RBAC on the backend: SEND-DOC (estimates.send/invoices.send),
  payments (collect_online/offline/refund), COMPANY-PROFILE + settings (tenant.company.manage),
  stripe/marketplace/email-settings (tenant.integrations.manage).
- Frontend routes gated via `ProtectedRoute permissions`; nav + settings menu gated on `hasPermission`;
  **no super_admin tenant bypass** (ALB-106). Financial tab, schedule dispatch, workflow publish gated.
- **Mobile reworks did NOT regress gating** (the owner's specific worry): SCHED/JOBS/LEADS mobile match
  desktop gating; the Jobs mobile payment pill is *extra* careful (gated on `financial_data.view ||
  invoices.view`). New-job / Create-lead buttons are ungated on BOTH desktop and mobile (pre-existing —
  see G4 — not a mobile regression). Multi-tenant `req.companyFilter` scoping intact in the new features.

## 3. Gaps / risks (severity-ranked, calibrated)
- **G1 — No in-app editor for the access grid (HIGH for "is it still actual").** The role matrix +
  per-member overrides are schema + **seeded defaults only**; **no route imports `roleQueries`**, so a
  tenant admin can ASSIGN a user a role (Users page) but **cannot customize a role's permissions or set
  per-user overrides** in the app. The grid the owner remembers building exists as data + resolution, not
  as an editable surface. → Decide: build the editor, or accept fixed roles + assignment-only.
- **G2 — `vapi-tools` fails OPEN (MEDIUM/HIGH — verify prod).** `vapi-tools.js`: if `VAPI_TOOLS_SECRET`
  is unset it `return next()` (skips auth) and operates on `DEFAULT_COMPANY_ID`. If the env var is ever
  missing in prod, the endpoint is open (lead injection into the default company). → Verify prod sets it;
  change to **fail-closed** (503 when unset).
- **G3 — `crmMcpPublic` mounted unauthenticated (MEDIUM — verify).** `app.use('/mcp/crm', …)` has no
  `authenticate`; it relies on an internal public-context/API-key middleware. → Confirm the API-key
  scoping is tight (per-key contact/account whitelist) and intentional.
- **G4 — Frontend buttons not permission-gated (MEDIUM — UX/correctness, not a security hole).** Backend
  enforces, but the UI shows actions a low-privilege role can't perform → they click and get 403:
  **Create Lead** (no `leads.create` check), **Send** on estimate/invoice (no `estimates.send`/
  `invoices.send`), **Collect Payment** (no `payments.collect_*`), **Jobs Export**, **AI Assistant**.
  Same on desktop and mobile. → Wrap each in `hasPermission`/`hasAnyPermission`.
- **G5 — `notification-settings` (and `jobs-list-fields`) fall back to "first company" (MEDIUM — verify).**
  Flagged: when `req.companyFilter` is absent they resolve the first company in the DB → cross-tenant
  settings read/write for a context-less (e.g. super_admin) caller; `notification-settings` PUT uses an
  inline role check instead of `requirePermission`. → Require explicit `req.companyFilter`; add
  `requirePermission('tenant.company.manage')`.
- **G6 — Fine-grained gating coverage is uneven (MEDIUM — needs precise re-audit).** Some non-core routers
  (telephony admin, voice/calls, a few integrations like `integrations-zenbooker` mutations) are
  `authenticate + requireCompanyAccess` but lack `requirePermission` — company-scoped (no cross-tenant
  leak) but role-agnostic, so e.g. a `provider` could call them. NOTE: the audit agent's specific list was
  unreliable (`schedule.js`/`messaging.js` ARE gated; some filenames were wrong) — a precise re-pass is
  needed before gating these.
- **G7 — Spec drift (LOW).** `crm-auth-rbac-production-checklist.md` mentions `accountant`/`viewer` roles
  not implemented (we use `manager`); legacy `company_admin→tenant_admin` / `company_member→dispatcher`
  mapping is still active (compat debt).

## 4. Recommended remediation (pick per owner)
- **R1 (quick, frontend-only):** G4 — gate the UI buttons (Create Lead / Send / Collect / Export / AI) on
  permissions. Low risk, improves role UX immediately.
- **R2 (security hardening, backend):** G2 vapi-tools fail-closed (+ verify prod secret); verify/​tighten
  G3 crmMcpPublic; G5 remove first-company fallback + add permission on notification-settings.
- **R3 (precise route re-audit):** G6 — enumerate every router's mount + per-endpoint gating accurately,
  then add `requirePermission` where a low role shouldn't reach (esp. telephony admin + integration
  mutations).
- **R4 (feature):** G1 — build the access-grid editor (API over `roleQueries`/`membershipQueries` +
  a tenant-admin UI to edit role permissions + per-user overrides). Largest effort.

Each R-item, if approved, runs the standard orchestrate implement→test→review pipeline.
