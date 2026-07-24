# MOBILE-CATCHUP-BE — backend catch-up contract for the native technician app

**Task marker:** `MOBILE-CATCHUP-BE`  
**Date:** 2026-07-23  
**Status:** implemented in the main CRM worktree; not deployed  
**Owner decisions:** D1 = B (in-app OTP plus native trusted device); D2 = recommended parity scope

## 1. Scope

This backend increment closes three blockers between the current CRM and the
native technician app:

1. a Keychain-backed native trusted-device credential for the live SMS-2FA gate;
2. provider-only assigned-contact search without granting `contacts.view`;
3. live linked-contact names in job sync/list/detail/search, including a
   contact-update-aware delta cursor.

It also pins the Keycloak client isolation regression: `chatgpt-crm-mcp` remains
blocked from ordinary `/api/*`, while `crm-web` and `crm-mobile` remain valid
ordinary API clients.

Out of scope: mobile repository changes, web UI changes, global provider contact
permissions, blanket `crm-mobile` 2FA exemptions, payments, and schema changes.

## 2. Native trusted-device contract

### 2.1 Existing OTP steps

All requests use the normal Keycloak access token:

```http
Authorization: Bearer <keycloak_access_token>
```

1. `POST /api/auth/otp/send` with an empty JSON body.
2. `POST /api/auth/otp/verify` with:

   ```json
   { "code": "123456" }
   ```

   Success remains:

   ```json
   { "ok": true, "otp_token": "<short-lived-login-otp-jwt>" }
   ```

These endpoints remain 2FA-exempt. No cookie persistence is required by the
native app.

### 2.2 Native trust exchange

The native app then calls:

```http
POST /api/auth/trust-native-device
Authorization: Bearer <keycloak_access_token>
Content-Type: application/json
```

```json
{
  "otp_token": "<value returned by /api/auth/otp/verify>",
  "device_id": "<stable random install identifier>",
  "device_name": "Rashid’s iPhone"
}
```

- `otp_token` must be a valid login-purpose OTP proof for the authenticated
  user's current verified phone.
- `device_id` is required, 8–200 characters, and may contain ASCII letters,
  digits, `.`, `_`, `:`, and `-`. It is an app-install identifier, not the
  secret credential.
- `device_name` is optional and truncated to 60 safe characters.

Success (`200`):

```json
{
  "ok": true,
  "device_credential": "<32-char opaque random hex credential>",
  "trusted_days": 30,
  "expires_in_seconds": 2592000
}
```

The response sets `Cache-Control: no-store` and `Pragma: no-cache`, sets no
cookie, and is the only time that credential is returned. The server stores
only `SHA-256(pepper + credential)` in `trusted_devices`, tied to
`crm_users.id`; a hash of `device_id` and the safe device name are retained in
the existing row label for device attribution.

Errors:

- `400 VALIDATION_ERROR` — malformed `device_id`;
- `401 AUTH_REQUIRED` — missing/invalid Keycloak identity;
- `401 OTP_REQUIRED` — invalid/expired/wrong-purpose OTP proof or proof for a
  different verified phone;
- `500 INTERNAL_ERROR` — persistence failure.

### 2.3 Protected API requests

After exchange, every non-exempt native API request sends:

```http
X-Albusto-Device: <device_credential>
```

The 2FA middleware accepts either this header or the existing web
`albusto_td` httpOnly cookie. Both resolve through the same
`otpService.isDeviceTrusted(crm_user_id, credential)` lookup and the same
revocation/expiry rules. A bad native header does not override a valid web
cookie. There is no `azp === 'crm-mobile'` exemption.

### 2.4 Mobile persistence

The mobile implementation must store both `device_id` and
`device_credential` in iOS Keychain, keyed by Keycloak issuer plus user `sub`.
They persist across cold restarts and app updates. The credential must never be
stored in AsyncStorage, SQLite, logs, analytics, crash metadata, or a query
string.

On explicit account removal/sign-out, delete that account's Keychain entries.
On `401 PHONE_VERIFICATION_REQUIRED`, discard the stale credential, run OTP
again, and replace it with the newly returned value. A copied Keychain secret is
a bearer credential; hardware attestation is not part of this increment.

The existing web flow remains exactly:

```http
POST /api/auth/trust-device
```

with the existing `Set-Cookie: albusto_td=...; HttpOnly; Secure; SameSite=Lax`.

## 3. Provider assigned-contact search

`GET /api/contacts?search=<q>&limit=<n>` has a route-local provider branch.
It is allowed only when all of the following are true:

- the actor has `provider.enabled`;
- the actor does not rely on a global `contacts.view` grant;
- `getProviderScope(req)` resolves `job_visibility=assigned_only`;
- trimmed `search` is non-empty.

The service keeps both predicates:

```sql
c.company_id = <req.companyFilter.company_id>
AND EXISTS (
  SELECT 1
  FROM jobs pj
  WHERE pj.contact_id = c.id
    AND pj.company_id = c.company_id
    AND pj.assigned_provider_user_ids @> <crm_users.id>
)
```

Provider success preserves the standard contacts envelope and pagination but
projects every result to exactly:

```json
{
  "id": 42,
  "name": "Ada Assigned",
  "phone": "+16175550142",
  "email": "ada@example.com"
}
```

`phone` is the primary `phone_e164`, falling back to `secondary_phone`. No
notes, company id, addresses, Zenbooker data, second phone, or timestamps leave
the provider route. A provider request without search or with company-wide
scope is `403 ACCESS_DENIED`. The existing `contacts.view` office response is
unchanged and remains the full contact list contract.

This route-local read is consistent with
`MOBILE-TECH-APP-002-SPEC.md` §5.3, which already defines provider visibility as
contacts linked to assigned jobs. It does not create a Contacts module or grant
global contact access.

## 4. Live contact names and delta cursor

Job sync, list, detail, sort, and search use the same-company join:

```sql
LEFT JOIN contacts c
  ON c.id = j.contact_id
 AND c.company_id = j.company_id
```

The wire value is:

```sql
COALESCE(c.full_name, j.customer_name) AS customer_name
```

Thus linked jobs reflect a contact rename immediately; orphan or invalid
cross-company links retain the safe denormalized job fallback.

For `GET /api/sync/jobs`, the internal cursor clock is:

```sql
GREATEST(j.updated_at, COALESCE(c.updated_at, j.updated_at))
```

It is used only in the incremental predicate, ordering, and `next_cursor`.
The external cursor format stays `<ISO8601>|<jobId>`. The public Job field
`updated_at` remains `j.updated_at`; no job row is rewritten on a contact
rename, and `sync_changed_at` is never serialized.

## 5. Tenancy and roles

| Surface | Required route permission | Record scope | Result |
|---|---|---|---|
| Native trust exchange | valid Keycloak Bearer + login OTP proof | authenticated `crm_users.id` and its verified phone | one hashed trusted-device row |
| Contacts office list | `contacts.view` | request company; existing role scope | existing full response |
| Provider contact search | `provider.enabled`, assigned-only, non-empty search | request company + jobs assigned to current `crm_users.id` | compact projection only |
| Job sync/list/detail/search | existing `jobs.view` route gates | request company + existing provider scope | live same-company contact name |
| Ordinary API with MCP client token | rejected before human resolution | none | `401 AUTH_INVALID` |
| Ordinary API with `crm-web`/`crm-mobile` token | unchanged | existing route/company/RBAC gates | allowed when the actor is authorized |

Required security checks are T-own, T-foreign (empty/404), T-blast with the same
phone in two tenants and byte-identical foreign rows, and R-matrix deny cells.

## 6. Database and rollout

No migration is required. The existing `trusted_devices` table already contains
`user_id`, `device_id_hash`, label, expiry, revocation, and last-use fields.
At implementation time the maximum migration number is 198 in both the
worktree and `origin/master`; 199 remains free.

Deploy the backend before enabling the mobile OTP handoff. Existing web clients
require no change. Rolling back the application code removes native-header
acceptance and the provider contact route branch; already minted native rows are
inert and expire/revoke through the existing trusted-device lifecycle.

## 7. Acceptance

- Verified-phone user without cookie/header gets
  `401 PHONE_VERIFICATION_REQUIRED` on `/api/sync/jobs`.
- The native exchange returns a no-store credential, stores only its hash, and
  sends no cookie.
- The header unlocks `/api/sync/jobs`; existing cookie still unlocks it.
- MCP tokens remain rejected; `crm-web` and `crm-mobile` remain accepted.
- Provider search returns only assigned, same-company contacts and only the
  compact projection; deny cells execute no SQL.
- Renaming a linked contact without touching the job returns the job on the
  next sync page, with the live name and unchanged public job timestamp.
- Job list, detail, and search agree on the live name.

Executed evidence is recorded in
`docs/test-cases/MOBILE-CATCHUP-BE.md`.
