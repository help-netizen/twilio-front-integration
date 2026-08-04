# APP-EGRESS-001 — an app reaches the outside world (OB-53)

Status: spec for phase I; owner card OB-53, one deliberate deviation in §2.
Depends on: APP-DATA-001 (manifest declarations, budgets, dry-run stores),
APP-GW-001 (run-token gateway), APP-RUN-001 (isolate bridge), APP-STUDIO-001 §5.

## 1. Why

The purchasing app keeps a perfect table and still cannot order a part. The
distributor scenario the owner named — a supplier shipping their own app —
is exactly this: call *their* API with *their* customer's key. Egress is what
turns an app from a service inside the CRM into an integration with the world.

It is also the single most dangerous capability in the platform: an app that
can make outbound requests is an exfiltration channel unless the destination,
the credentials and the volume are all pinned down. Hence everything below.

## 2. Where the proxy lives — a deviation, stated plainly

The OB-53 card said "outbound proxy on the apps server". This spec puts the
**egress route in the CRM gateway** instead, and the reasoning is the secrets:

- Our own doctrine calls the runner the untrusted side of the wall. A proxy on
  the apps server needs the supplier key available there — pushed per run or
  stored beside the isolates. A compromised runner then *reads* keys.
- With the proxy in the CRM, the key never crosses the wall. A compromised
  runner can at worst *use* a connection through its short-lived run token —
  never see the credential. Strictly less to steal.
- Consent, moderation and budgets already live in the CRM; the egress gate
  joins them instead of duplicating them remotely.

Cost: external calls originate from the CRM host and briefly hold its
connections. At v1 volume (a purchasing order, not a firehose) that is
acceptable; if a tenant's app ever needs bulk egress, moving the proxy out
becomes a performance project, not a security redesign.

## 3. Declared connections, not URLs

A version may declare up to **2 connections**:

```jsonc
{"connections": [{
    "name": "supplier",                    // ^[a-z][a-z0-9_]{0,31}$
    "base_url": "https://api.supplier.com", // https origin only — no path, port 443 implied
    "auth": {"kind": "bearer"}              // or {"kind": "header", "header": "X-API-Key"}
}]}
```

The app never sees or supplies a URL — it names a connection and a path.
Moderation sees the declared origins; approving a version approves exactly
those. The declaration rides in `scanner_report` beside actions and
subscriptions, immutable once submitted, re-pinned on version acceptance.

## 4. The secret

`app_installation_secrets` (migration 238): company_id, installation_id,
connection_name, ciphertext (AES-256-GCM under `APP_SECRETS_KEY` from env),
set_by, set_at. One row per (installation, connection).

- **Write-only API**: `PUT /api/apps/installations/:id/secrets/:connection`
  (tenant admin, live-gated). The value is never returned by any endpoint —
  status reads as `set` / `not set` only.
- The CRM egress route decrypts at call time and injects per the declared
  auth kind (`Authorization: Bearer …` or the named header). The plaintext
  exists in memory for the duration of one outbound request.
- Uninstall cascades secrets away with the installation.

## 5. The call

Isolate surface: `ctx.http.request(connection, {method, path, query?, body?})`
— `GET|POST|PUT|DELETE`, path must start with `/`, JSON body ≤ 32 KB, no
custom headers in v1 (`content-type: application/json` is set for bodies).
Bridged like ctx.data to `/internal/app-runtime/v1/egress/:connection`,
run-token authenticated.

The CRM gate, in order: connection declared by the accepted version → secret
present → URL composed from the declared origin + app path (the app cannot
change the host) → **SSRF wall**: resolve the host and refuse private,
loopback, link-local and metadata ranges; https only; redirects not followed
→ outbound with 15 s timeout → response streamed back capped at **256 KB**,
JSON parsed when the content-type says so, else text.

Returned to the app: `{status, body}`. Failures are catchable, with English
reasons; a supplier 500 is the app's problem to handle, not a crashed run.

## 6. Budgets

Egress calls are their own meter: `egress_calls_made` on app_runs
(migration 238), **≤ 5 per run**, **≤ 500 per installation per day**. Breach
refuses the call, not the run. Usage shows in run history like every other
number.

## 7. Sandbox

Dry runs perform **no real egress, ever** — the sandbox would otherwise be an
exfiltration path that skips moderation. `ctx.http.request` in a dry run
returns a synthetic echo — `{status: 200, body: {sandbox_echo: {connection,
method, path}}}` — so code paths execute and the report shows what the draft
would have called. Documented honestly in the builder contract.

## 8. Verification contract

1. Happy path: declared connection + set secret → outbound request carries the
   injected auth header, response returns to the app; the secret never appears
   in the response envelope, logs, or run history.
2. Undeclared connection → refused before any network; missing secret →
   refused with a reason naming the settings screen.
3. SSRF: base_url declaring a private/loopback host is rejected at version
   validation; a public host resolving to a private address is refused at call
   time; redirects are not followed.
4. Caps: 6th egress call in a run refused; 501st in a day refused; 33 KB body
   refused; >256 KB response truncated to a refusal, not a partial body.
5. Secrets API: value write-only (GET shows set/not set), tenant-admin only,
   T-blast across companies, uninstall cascades.
6. Dry run: echo shape, zero sockets opened (assert the fetch impl is the stub).
7. Sabotage: drop the "connection ⊆ declared" check → red; restore.
