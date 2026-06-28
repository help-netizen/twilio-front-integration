# RBAC-ROLES-EDITOR-001 (RBAC-AUDIT-001 R4) — in-app access-grid editor

**Type:** feature · backend + frontend · **migration: none** (tables 046/047 already exist).
**Surface:** new desktop-only Settings page "Roles & Access", gated `tenant.roles.manage`.
Owner decisions: role permission matrix **+ per-user overrides** (scopes deferred); overrides as a **2nd tab**
in the same page; **desktop-only**.

## Why
The role matrix (`company_role_permissions`) + per-member overrides (`company_membership_permission_overrides`)
exist as data + are resolved per-request (no cache → edits take effect on next `/api/auth/me`), but there is
**no edit API/UI**. R4 adds the editor.

## Backend
### Permission catalog (new runtime source)
- New `backend/src/services/permissionCatalog.js`: `PERMISSION_CATALOG` = ordered groups
  `[{ category, items: [{ key, label }] }]` covering the **48 seeded permissions** (source of truth =
  migrations 050 + 074 fsm.* + 118 payments.collect_keyed/terminal). Categories per the audit grouping
  (Governance, Dashboard, Messaging, Contacts & Leads, Jobs & Schedule, Financial, Reports, Field/Other,
  FSM). Export `ALL_PERMISSION_KEYS` (flat) too. Keep it the single UI source so rows stay in sync.
### Queries
- `roleQueries.js` add **`setRolePermission(roleConfigId, permissionKey, isAllowed)`** — upsert into
  `company_role_permissions` (ON CONFLICT (role_config_id,permission_key) DO UPDATE is_allowed). Add
  **`ensureRoleConfigs(companyId, createdBy)`** — if `listRoleConfigs` empty, call `seedRoleConfigs`
  (lazy-seed safety net for companies created outside bootstrap).
- `membershipQueries.js` add **`setPermissionOverride(membershipId, permissionKey, overrideMode)`** —
  `overrideMode ∈ {'allow','deny'}` upserts; `null` → DELETE the row. (Reuse `getPermissionOverrides`.)
### Route — `backend/src/routes/rolesPermissions.js`, mount in `src/server.js` at `/api/settings/roles`
with `authenticate, requireCompanyAccess, requirePermission('tenant.roles.manage')`:
- `GET /` → `{ catalog: PERMISSION_CATALOG, mandatoryAdminPermissions, roles: [{ role_key, display_name,
  is_locked, permissions: { <key>: boolean } }] }` for the company (call `ensureRoleConfigs` first; build
  each role's `permissions` map from `getRolePermissions`).
- `PUT /:roleKey/permissions` → body `{ permission_key, is_allowed }` (single toggle). Guards:
  **reject if role is `tenant_admin`/locked** (400 — Admin is full-access, not editable); validate
  `permission_key ∈ ALL_PERMISSION_KEYS`; resolve the role_config for (company, roleKey); `setRolePermission`;
  `auditService.log`. Return the updated role permission map.
- `GET /members` → company members for the overrides tab: `[{ membership_id, user_id, name, email, role_key,
  role_name, status, overrides: { <key>: 'allow'|'deny' } }]` via `userService.listUsers` +
  `getPermissionOverrides`. Tenant-scoped to `req.companyFilter.company_id`.
- `PUT /members/:membershipId/overrides` → body `{ permission_key, override_mode: 'allow'|'deny'|null }`.
  Guards: the membership MUST belong to `req.companyFilter.company_id` (else 404 — no cross-tenant);
  validate key; `setPermissionOverride` (null → clear); audit. Note: for a `tenant_admin` member, a `deny`
  on a MANDATORY_ADMIN permission is still re-granted by the resolver baseline — surface that in the UI copy.
### No cache to invalidate (resolver reads DB per request).

## Frontend
- `services/rolesApi.ts`: `getRoleMatrix()`, `setRolePermission(roleKey, key, isAllowed)`, `getMembers()`,
  `setMemberOverride(membershipId, key, mode|null)` (via `authedFetch`, `{ ok, data }` envelope).
- `pages/RolesAccessPage.tsx` (new), route `/settings/roles` (App.tsx) gated
  `<ProtectedRoute permissions={['tenant.roles.manage']}>`; add a Settings-nav entry (gated same).
  - **Tab "Roles"** — the matrix: permissions grouped by `catalog` category (rows) × roles (columns:
    **Admin = locked/disabled, always checked**; Manager/Dispatcher/Technician = toggle checkboxes). Toggle
    → optimistic update + `setRolePermission` + toast; revert on error. Header note: "Admin always has full
    access; some Admin permissions are mandatory."
  - **Tab "People"** — pick a member (list/select) → show role + a per-permission tri-state
    (Inherit / Allow / Deny) reflecting role default + override; change → `setMemberOverride`
    (Inherit = clear). Show the effective result.
  - **Desktop-only:** on mobile (`useIsMobile`) render a short "Manage roles on a larger screen" notice
    (the matrix is too wide for phones; per decision).
- Blanc design (CLAUDE.md): clean table, no heavy borders, eyebrow group headers, near-white surface.

## Edge cases / guards
- Admin/locked role not editable (backend 400 + UI disabled). · Unknown permission_key → 400. · Cross-tenant
  membership → 404. · Removing a mandatory perm from Admin is impossible (locked) and from an admin via
  override is neutralized by the baseline (UI copy notes it). · Empty role configs → lazy-seeded. · Changes
  apply on the affected user's next request (no logout needed; mention in UI).

## Tests / verify
Backend: add a jest suite for the new route (gating 403 without `tenant.roles.manage`; tenant_admin edit
rejected; cross-tenant override 404; setRolePermission upsert; override set/clear) — DB is mocked like the
other route tests. Frontend has no harness → verify by `npm run build` (tsc -b strict) + dev preview
(auth bypassed) + review. No migration. Backend deploy = app rebuild; frontend deploy = rebuild + logout-all.

## Constraints
`requirePermission` from `middleware/authorization.js`; reuse `auditService`, `userService.listUsers`,
`authorizationService.MANDATORY_ADMIN_PERMISSIONS`. Don't change the resolver or existing role seeds. Company
scope strictly `req.companyFilter.company_id`. Build green.
