# APP-MKT-001 — Marketplace Apps Platform Test Cases

**Related spec:** `docs/specs/APP-MKT-001-marketplace-apps-platform.md`

---

## P0 Backend / Security

### TC-APP-MKT-001: Marketplace apps require tenant integrations permission
- **Type:** integration
- **Verify:** `GET /api/marketplace/apps` returns 401 without auth, 403 without `tenant.integrations.manage`, 200 with permission.

### TC-APP-MKT-002: Marketplace app list is company-scoped
- **Type:** integration
- **Verify:** installation status shown for company A does not appear for company B.

### TC-APP-MKT-003: Only published apps appear in tenant storefront
- **Type:** service/integration
- **Verify:** `draft`, `review`, and `disabled` apps are excluded from `GET /api/marketplace/apps`.

### TC-APP-MKT-004: Connect creates tenant-scoped credential and installation
- **Type:** service/integration
- **Verify:** `manual` / `push_credentials` install creates `api_integrations.company_id = req.companyFilter.company_id`, requested scopes, marketplace linkage, installation row, and audit event. `none` install creates an installation and no credential.

### TC-APP-MKT-005: Connect rejects duplicate active installation
- **Type:** integration
- **Verify:** second install for the same `(company_id, app_id)` returns `409 APP_ALREADY_INSTALLED`.

### TC-APP-MKT-006: Tenant cannot install unpublished/disabled app
- **Type:** integration
- **Verify:** install on non-published app returns `400 APP_NOT_INSTALLABLE` or 404 according to route design.

### TC-APP-MKT-007: Marketplace install response never exposes secret to tenant UI
- **Type:** integration
- **Verify:** response body from `POST /api/marketplace/apps/:appKey/install` does not include plaintext `secret`.

### TC-APP-MKT-008: Push provisioning receives one-time credential payload
- **Type:** service
- **Verify:** provisioning service sends key id, secret, scopes, app key, installation id, company id, API base URL, timestamp, request id, and HMAC signature.

### TC-APP-MKT-009: Provisioning failure revokes credential
- **Type:** service/integration
- **Verify:** non-2xx/timeout marks installation `provisioning_failed`, records sanitized error, revokes linked `api_integrations` credential, and logs audit event.

### TC-APP-MKT-010: Retry provisioning creates fresh credential
- **Type:** integration
- **Verify:** retry after `provisioning_failed` creates a new credential, does not reuse previous secret/key, updates installation linkage, and audits retry.

### TC-APP-MKT-011: Disconnect revokes runtime access
- **Type:** integration
- **Verify:** disconnect marks installation disconnected/revoked, sets `revoked_at` on credential, and subsequent runtime API request returns 401.

### TC-APP-MKT-012: Disconnect is tenant-isolated
- **Type:** integration
- **Verify:** company B cannot disconnect company A installation by id; response is 404.

### TC-APP-MKT-013: Shared scope guard supports exact scopes
- **Type:** unit
- **Verify:** `hasIntegrationScope(['leads:create'], 'leads:create')` returns true; unrelated scopes return false.

### TC-APP-MKT-014: Shared scope guard supports full_access without bypassing auth
- **Type:** unit/integration
- **Verify:** `full_access` passes route scope guard, but missing/invalid API key still returns 401 and revoked key still returns 401.

### TC-APP-MKT-015: Existing leads integration remains backward compatible
- **Type:** regression integration
- **Verify:** existing key with `leads:create` can still call `POST /api/v1/integrations/leads`; missing scope still returns 403.

### TC-APP-MKT-016: Existing analytics integration remains backward compatible
- **Type:** regression integration
- **Verify:** existing key with `analytics:read` can still call `/api/v1/integrations/analytics/*`; missing scope still returns 403.

### TC-APP-MKT-017: Runtime API uses integration company id
- **Type:** integration
- **Verify:** external app key scoped to company A cannot read/mutate company B rows through any APP-MKT endpoint added in P0.

### TC-APP-MKT-018: Audit events do not store secrets
- **Type:** service
- **Verify:** `marketplace_installation_events.payload_json` never contains `secret`, `X-BLANC-API-SECRET`, or provisioning request body with plaintext credentials.

---

## P0 Frontend

### TC-APP-MKT-019: Integrations page preserves existing sections
- **Type:** E2E/manual
- **Verify:** Zenbooker webhook/API key controls and manual API key table remain accessible after tabbed layout.

### TC-APP-MKT-020: Marketplace card status and actions render correctly
- **Type:** component
- **Verify:** available, connected, provisioning failed, disconnected, and unavailable states show correct badge/action.

### TC-APP-MKT-021: Connect dialog shows requested access
- **Type:** component/E2E
- **Verify:** scope summary appears before confirm; confirm triggers install mutation.

### TC-APP-MKT-022: Tenant UI never renders marketplace app secret
- **Type:** component/E2E
- **Verify:** no plaintext secret field/card/modal is rendered for marketplace install flow.

### TC-APP-MKT-023: Disconnect dialog warns about credential revoke
- **Type:** component/E2E
- **Verify:** disconnect confirmation copy is present and successful mutation updates app state.

---

## P1 / Operational

### TC-APP-MKT-024: Provisioning HMAC validation example is documented
- **Type:** docs/manual
- **Verify:** developer guide includes signing algorithm, timestamp tolerance, and Node.js verification example or pseudocode.

### TC-APP-MKT-025: Manifest examples validate against required fields
- **Type:** docs/unit optional
- **Verify:** example manifests include required fields, valid scopes, HTTPS provisioning URL where needed, support contact, and privacy URL.

### TC-APP-MKT-026: Credential metadata distinguishes marketplace vs manual keys
- **Type:** integration
- **Verify:** manual API keys have null marketplace linkage; marketplace credentials are linked to app/install ids.

### TC-APP-MKT-027: Last used timestamp surfaces from api_integrations
- **Type:** service/frontend
- **Verify:** app list shows `last_used_at` from linked credential when available.

### TC-APP-MKT-028: Sanitized provisioning errors are user-safe
- **Type:** service
- **Verify:** stored/displayed error does not include credential payload, secret, stack trace, or provider auth headers.
