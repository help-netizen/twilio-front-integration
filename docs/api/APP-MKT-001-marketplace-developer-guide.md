# Blanc Marketplace Developer Guide

**Feature:** `APP-MKT-001`
**Audience:** external app/service developers

---

## 1. What You Build

A Blanc marketplace app is an external or internal service that a tenant company can connect from Blanc. After connection, your service receives tenant-scoped API credentials and uses Blanc public APIs to read or write allowed data.

Your app must not connect to the Blanc PostgreSQL database directly. If your app needs persistence, queues, model outputs, logs, or embeddings, run and secure those in your own environment.

---

## 2. Marketplace Submission Checklist

Provide Blanc with:

- App manifest JSON.
- Short and long description.
- Provider/developer name.
- Support email.
- Privacy/data-retention URL.
- Requested scopes and justification for each scope.
- Provisioning mode:
  - `manual`
  - `push_credentials`
  - `none`
- HTTPS provisioning endpoint if using `push_credentials`.
- Sandbox/test tenant setup notes.
- Rollback/disconnect behavior.
- Expected API call volume and polling schedule.
- Incident/security contact.

Blanc reviews and publishes vetted apps. Public self-service publishing is not part of P0.

---

## 3. App Manifest

Example:

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

Rules:
- `app_key` must be a stable lowercase slug.
- `requested_scopes` must be the minimum needed access.
- `provisioning_url` must be HTTPS when `provisioning_mode = push_credentials`.
- External published apps must include support and privacy links.

---

## 4. Scopes

P0 scope taxonomy:

| Scope | Meaning |
|-------|---------|
| `full_access` | Temporary trusted broad access; still tenant-scoped, rate-limited, and audited |
| `leads:read` | Read leads |
| `leads:create` | Create leads |
| `leads:update` | Update leads |
| `contacts:read` | Read contacts |
| `contacts:create` | Create contacts |
| `contacts:update` | Update contacts |
| `jobs:read` | Read jobs/work orders |
| `jobs:create` | Create jobs/work orders |
| `jobs:update` | Update jobs/work orders |
| `calls:read` | Read call metadata |
| `calls.transcripts:read` | Read call transcripts |
| `email:read` | Read synced shared mailbox data |
| `email:send` | Send email through Blanc mailbox APIs |
| `tasks:read` | Read tasks |
| `tasks:create` | Create tasks |
| `tasks:update` | Update tasks |
| `notes:read` | Read notes |
| `notes:create` | Create notes |
| `analytics:read` | Read analytics/reporting endpoints |

Request the narrowest scopes possible. Blanc may initially approve `full_access` for trusted early apps, but your integration should still document the module-level access it uses.

---

## 5. Authentication

Runtime API calls use headers:

```http
X-BLANC-API-KEY: blanc_xxx
X-BLANC-API-SECRET: <secret>
```

The secret is sent to your provisioning endpoint once during installation. Store it in your secret manager. Blanc stores only a hash and cannot show it again.

Base URL:

```text
https://<blanc-host>/api/v1/integrations
```

Example:

```bash
curl -sS "$BLANC_API_BASE/analytics/summary?from=2026-05-01&to=2026-05-04" \
  -H "X-BLANC-API-KEY: $BLANC_API_KEY" \
  -H "X-BLANC-API-SECRET: $BLANC_API_SECRET"
```

---

## 6. Provisioning Endpoint

If your manifest uses `push_credentials`, implement a HTTPS endpoint that accepts Blanc's install event.

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

Respond:

```json
{
  "ok": true,
  "external_installation_id": "provider-install-123"
}
```

Security expectations:
- Verify `X-Blanc-Signature`.
- Reject stale timestamps.
- Store credentials in a secret manager.
- Never log the secret.
- Return non-2xx only when provisioning truly failed.

Signature algorithm:

```text
signature = HMAC_SHA256(provisioning_shared_secret, timestamp + "." + raw_request_body)
header = "sha256=" + hex(signature)
```

Use constant-time comparison when validating signatures. Reject timestamps outside a short tolerance window, for example 5 minutes.

Node.js verification example:

```js
const crypto = require('crypto');

function verifyBlancSignature({ rawBody, timestamp, signatureHeader, sharedSecret }) {
  const now = Math.floor(Date.now() / 1000);
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > 300) {
    return false;
  }

  const expectedHex = crypto
    .createHmac('sha256', sharedSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const expected = Buffer.from(`sha256=${expectedHex}`, 'utf8');
  const received = Buffer.from(signatureHeader || '', 'utf8');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
```

---

## 7. API Standards

Blanc integration APIs use:
- JSON request/response bodies.
- ISO 8601 timestamps.
- Cursor pagination for large lists.
- Consistent error envelope:

```json
{
  "success": false,
  "code": "SCOPE_INSUFFICIENT",
  "message": "This integration does not have calls.transcripts:read scope.",
  "request_id": "req_abc"
}
```

For mutating endpoints that can create duplicates, send an idempotency key when documented:

```http
Idempotency-Key: your-stable-operation-id
```

---

## 8. Current Implemented API Surface

App installation is initiated by a tenant admin inside Blanc, not by the external app. Blanc internal marketplace endpoints handle app install/disconnect and send your provisioning endpoint a one-time credential payload when `provisioning_mode = push_credentials`.

Existing endpoints:

| Method | Path | Scope |
|--------|------|-------|
| `POST` | `/leads` | `leads:create` |
| `GET` | `/analytics/summary` | `analytics:read` |
| `GET` | `/analytics/calls` | `analytics:read` |
| `GET` | `/analytics/leads` | `analytics:read` |
| `GET` | `/analytics/jobs` | `analytics:read` |

Additional module endpoints for calls, transcripts, email, tasks, and notes are planned by `APP-MKT-001` tasks and should be documented as they are implemented.

---

## 9. Disconnect Behavior

When a tenant disconnects your app:
- Blanc revokes the API credentials.
- Future API requests return 401.
- Blanc does not delete data stored in your system.
- Your app should stop polling/syncing for that tenant after receiving 401 or after your own installation state is updated.

---

## 10. Data Handling Expectations

- Store only data required for your app's function.
- Use encryption at rest for tenant data.
- Keep tenant data logically isolated.
- Provide deletion/retention process on request.
- Do not use Blanc tenant data to train shared models unless explicitly approved in writing.
- Log request IDs for support, but do not log secrets or sensitive transcript/email content unless required and protected.
