# APP-MKT-001 — Marketplace Apps Platform Spec

**Status:** Spec
**Related requirements:** `docs/requirements.md#APP-MKT-001-marketplace-apps-platform`
**Related architecture:** `docs/architecture.md#APP-MKT-001--marketplace-apps-platform`

---

## 1. Goal

Provide a controlled marketplace where tenant companies can connect vetted external/internal apps. Installing a runtime app creates tenant-scoped server-to-server API credentials under the hood; `provisioning_mode = none` apps can be installed without credentials. Apps interact with Blanc only through documented public APIs and scopes.

P0 must make the developer onboarding and app installation model stable enough that a third-party developer can implement an app without direct database access or private Blanc code knowledge.

---

## 2. Actors

| Actor | Access |
|-------|--------|
| Tenant admin / manager | Uses Blanc UI with `tenant.integrations.manage` |
| Blanc operator | Seeds/reviews marketplace catalog entries |
| Third-party app | Uses `/api/v1/integrations/*` with app credentials |
| External developer | Receives developer docs and provides manifest/provisioning details |

---

## 3. UI Behavior

### 3.1 Integrations settings workspace

`/settings/integrations` becomes a tabbed workspace:
- `Marketplace`
- `API Keys`
- `Zenbooker`

The existing manual API key table and Zenbooker controls remain available. Their behavior must not change except layout placement.

### 3.2 Marketplace app card

Each published app card shows:
- app name
- provider name
- category
- short description
- requested access summary
- status badge:
  - `Available`
  - `Connected`
  - `Provisioning failed`
  - `Disconnected`
  - `Unavailable`
- last used timestamp when connected and available
- primary action:
  - `Connect` if not active
  - `Disconnect` if connected/provisioning failed
  - `Retry` if provisioning failed and provisioning mode supports retry

Tenant users do not see API secrets for marketplace-installed apps.

### 3.3 Connect dialog

Before connecting, show:
- app/provider
- requested scopes rendered as plain language modules
- data access warning
- support contact
- privacy/security link when available

User confirms. The UI sends `POST /api/marketplace/apps/:appKey/install`.

### 3.4 Disconnect dialog

Before disconnecting, show:
- app name
- statement that API credentials will be revoked
- note that app-owned external data is not deleted by Blanc

User confirms. The UI sends `POST /api/marketplace/installations/:id/disconnect`.

---

## 4. Internal API Contracts

All endpoints require:
- Keycloak auth
- `tenant.integrations.manage`
- `requireCompanyAccess`

### 4.1 List apps

`GET /api/marketplace/apps`

Response:

```json
{
  "success": true,
  "apps": [
    {
      "app_key": "call-qa-agent",
      "name": "Call QA Agent",
      "provider_name": "Blanc Labs",
      "category": "ai",
      "short_description": "Scores dispatcher calls from transcripts.",
      "requested_scopes": ["calls:read", "calls.transcripts:read"],
      "access_summary": ["Call metadata", "Call transcripts"],
      "provisioning_mode": "push_credentials",
      "status": "published",
      "installation": {
        "id": 42,
        "status": "connected",
        "installed_at": "2026-05-04T12:00:00.000Z",
        "last_used_at": "2026-05-04T12:30:00.000Z",
        "provisioning_error": null
      }
    }
  ],
  "request_id": "req_..."
}
```

Rules:
- Only `published` apps are returned to tenant users.
- If a published app has no tenant installation, `installation = null`.
- Disabled/draft/review apps are excluded from tenant storefront.

### 4.2 Install app

`POST /api/marketplace/apps/:appKey/install`

Request body is optional in P0:

```json
{
  "confirm_scopes": ["calls:read", "calls.transcripts:read"]
}
```

Behavior:
1. Load published app by `app_key`.
2. Reject if app is not `published`.
3. Reject if active installation already exists.
4. Create marketplace installation for current `company_id`.
5. For `manual` and `push_credentials`, create `api_integrations` credential with app requested scopes and current `company_id`, then link it to the installation.
6. For `none`, do not create a runtime API credential.
7. If `provisioning_mode = push_credentials`, call provisioning endpoint with one-time secret.
8. If provisioning succeeds, status is `connected`.
9. If provisioning fails, revoke credential and set status `provisioning_failed` with sanitized error.

Success response:

```json
{
  "success": true,
  "installation": {
    "id": 42,
    "app_key": "call-qa-agent",
    "status": "connected",
    "installed_at": "2026-05-04T12:00:00.000Z",
    "provisioning_error": null
  },
  "request_id": "req_..."
}
```

Error cases:
- `404 APP_NOT_FOUND`
- `409 APP_ALREADY_INSTALLED`
- `400 APP_NOT_INSTALLABLE`
- `502 PROVISIONING_FAILED`
- `500 INTERNAL_ERROR`

### 4.3 List installations

`GET /api/marketplace/installations?include_inactive=true|false`

Response:

```json
{
  "success": true,
  "installations": [
    {
      "id": 42,
      "app_key": "call-qa-agent",
      "app_name": "Call QA Agent",
      "status": "connected",
      "requested_scopes": ["calls:read", "calls.transcripts:read"],
      "installed_at": "2026-05-04T12:00:00.000Z",
      "disconnected_at": null,
      "last_used_at": "2026-05-04T12:30:00.000Z"
    }
  ],
  "request_id": "req_..."
}
```

### 4.4 Disconnect app

`POST /api/marketplace/installations/:id/disconnect`

Behavior:
1. Load installation by id and current `company_id`.
2. If not found, return 404.
3. Revoke linked `api_integrations` credential.
4. Mark installation `disconnected` or `revoked`.
5. Append audit event.

Success:

```json
{
  "success": true,
  "installation": {
    "id": 42,
    "status": "disconnected",
    "disconnected_at": "2026-05-04T13:00:00.000Z"
  },
  "request_id": "req_..."
}
```

Error cases:
- `404 INSTALLATION_NOT_FOUND`
- `409 INSTALLATION_NOT_ACTIVE`
- `500 INTERNAL_ERROR`

### 4.5 Retry provisioning

`POST /api/marketplace/installations/:id/retry-provisioning`

P0 retry creates a fresh credential, because previous failed credentials must be revoked after failed provisioning.

Error cases:
- `404 INSTALLATION_NOT_FOUND`
- `409 INSTALLATION_NOT_RETRYABLE`
- `502 PROVISIONING_FAILED`

---

## 5. Runtime External API Behavior

### 5.1 Auth

All app runtime calls use:

```http
X-BLANC-API-KEY: blanc_xxx
X-BLANC-API-SECRET: <secret>
```

`authenticateIntegration` resolves:
- `req.integrationId`
- `req.integrationKeyId`
- `req.integrationScopes`
- `req.integrationCompanyId`

### 5.2 Scope guard

Shared helper:

```text
hasIntegrationScope(scopes, required)
```

Rules:
- If scopes contains `full_access`, allow.
- If scopes contains exact `required`, allow.
- Otherwise deny with `403 SCOPE_INSUFFICIENT`.

Existing endpoints must migrate to the helper:
- `/api/v1/integrations/leads` requires `leads:create`.
- `/api/v1/integrations/analytics/*` requires `analytics:read`.

### 5.3 Tenant isolation

Every integration service query must use `req.integrationCompanyId`. Access by id must include `company_id` filtering and return 404 for foreign tenant data.

---

## 6. Provisioning Endpoint Contract

Apps using `push_credentials` provide a HTTPS endpoint.

Blanc request:

```http
POST /blanc/provision
Content-Type: application/json
X-Blanc-Signature: sha256=<hex_hmac>
X-Blanc-Timestamp: 1777896000
X-Blanc-Request-Id: req_abc
```

Body:

```json
{
  "event": "app.install",
  "app_key": "call-qa-agent",
  "installation_id": "42",
  "company_id": "00000000-0000-0000-0000-000000000001",
  "api_base_url": "https://example.com/api/v1/integrations",
  "credentials": {
    "key_id": "blanc_xxx",
    "secret": "one-time-secret"
  },
  "scopes": ["calls:read", "calls.transcripts:read"],
  "issued_at": "2026-05-04T12:00:00.000Z"
}
```

Expected provider response:

```json
{
  "ok": true,
  "external_installation_id": "provider-install-123"
}
```

Failure handling:
- Non-2xx, timeout, invalid JSON where JSON is expected, or `ok: false` is failure.
- Blanc must sanitize and store error text without secrets.
- Blanc revokes the credential associated with failed provisioning.

---

## 7. Developer Manifest

Required fields:

```json
{
  "app_key": "call-qa-agent",
  "name": "Call QA Agent",
  "provider_name": "Example AI",
  "category": "ai",
  "app_type": "external",
  "short_description": "Scores dispatcher calls from transcripts.",
  "requested_scopes": ["calls:read", "calls.transcripts:read"],
  "provisioning_mode": "push_credentials",
  "provisioning_url": "https://example.com/blanc/provision",
  "support_email": "support@example.com",
  "privacy_url": "https://example.com/privacy",
  "docs_url": "https://example.com/docs/blanc"
}
```

Validation:
- `app_key` lowercase slug.
- `requested_scopes` non-empty.
- `provisioning_url` HTTPS when mode is `push_credentials`.
- External published apps require `support_email` and `privacy_url`.

---

## 8. Edge Cases

| Case | Expected behavior |
|------|-------------------|
| App already connected | `409 APP_ALREADY_INSTALLED` |
| App disabled after install | Existing credential remains until explicitly disconnected unless Blanc/admin revokes it |
| Credential revoked manually | Marketplace read paths reconcile the installation to `revoked`; it no longer blocks reconnect |
| Provisioning endpoint times out | Revoke credential, status `provisioning_failed`, show retry |
| User disconnects during failed provisioning | Mark disconnected/revoked idempotently |
| Foreign installation id | 404 |
| Missing `tenant.integrations.manage` | 403 |
| Missing runtime scope | 403 `SCOPE_INSUFFICIENT` |
| `full_access` runtime app | Allowed by scope guard but still tenant-scoped/rate-limited |

---

## 9. Acceptance Criteria

- Marketplace tab lists published apps with accurate tenant status.
- Connect creates a company-scoped installation and, for `manual` / `push_credentials` apps, a company-scoped credential.
- Tenant UI never displays marketplace app secrets.
- Disconnect revokes runtime API access.
- Provisioning failures do not leave usable orphan credentials.
- Existing manual API keys still work.
- Existing Zenbooker settings still work.
- Existing F014 analytics API still works.
- Developer docs include manifest examples and provisioning contract.
- Tests cover 401/403, tenant isolation, provisioning failure, and disconnect/revoke behavior.
