# TWILIO-TENANT-FIX-001 — Twilio callback and media tenant isolation

**Status:** Implementation specification  
**Date:** 2026-08-01  
**Scope:** Backend code fix only; no production number transfer in this cycle.

## 1. Resolution contract

Albusto uses one Twilio master account for ABC Homes and one subaccount per
other tenant.

- `DEFAULT_COMPANY_ID = 00000000-0000-0000-0000-000000000001` is ABC Homes.
- `AccountSid === TWILIO_ACCOUNT_SID` resolves explicitly to the default company.
- A connected `company_telephony.twilio_subaccount_sid` resolves to that row's
  `company_id`.
- Missing, unknown, suspended, or lookup-failed AccountSid is unresolved.
- Every path uses `telephonyTenantService.resolveCompanyByAccountSid`; `To`,
  phone number, caller input, and an omitted company are never fallback tenant
  bindings.
- Unresolved events fail before persistence. The security log is redacted and
  emits the log-based `twilio_tenant_unresolved_total` metric; it contains no
  AccountSid, CallSid, phone number, token, headers, or raw payload.

Master provider credentials do not grant ABC Homes application visibility into
subaccount data. Cross-tenant administration requires a separate explicit
platform surface and is not part of this feature.

## 2. Fixes

### 2.1 Authenticated media streams

When signed TwiML issues `<Start><Stream>`, it resolves the request AccountSid
and mints a short-lived HMAC token with:

`{ v, company_id, call_sid, account_sid, direction, iat, exp, jti }`.

The token is passed as `<Parameter name="streamToken">`; it is never placed in
the URL or logged. Configuration:

- `TWILIO_MEDIA_STREAM_TOKEN_SECRET` — required, at least 32 bytes, to enable
  realtime streaming.
- `TWILIO_MEDIA_STREAM_TOKEN_TTL_SECONDS` — optional, default 60, maximum 300.

Twilio custom parameters arrive only in the WebSocket `start` frame, after the
HTTP 101 response. Therefore the server quarantines each upgraded socket: no
transcription session or media is accepted before `start` authentication. It
closes missing, forged, expired, mismatched, or late starts with policy code
1008. At authenticated start it:

1. verifies HMAC and expiry;
2. requires Twilio `start.callSid` and `start.accountSid` to match token claims;
3. re-runs `resolveCompanyByAccountSid(start.accountSid)` and requires the same
   token company;
4. requires the existing Twilio signature helper to validate the upgrade using
   the exact canonical WSS URL emitted in TwiML and the resolved account's auth
   token;
5. atomically claims `jti` in `twilio_media_stream_token_claims`. A previously
   claimed token is rejected, even while it remains within its TTL.

The AccountSid needed to select the signature token arrives only in `start`, so
both HMAC and Twilio signature validation complete during quarantine after the
HTTP 101 and before a session or audio is accepted. Both are hard gates.
After every awaited validation and the atomic claim, the handler rechecks the
socket rejection/close state. A validation that completes after the five-second
authentication timeout cannot create a session or route audio.

Caller-supplied `companyId` and `callSid` custom parameters are ignored. Active
sessions and every create/audio/stop/finalize operation are keyed by
`(company_id, callSid)`. Realtime transcript persistence conflicts on
`(company_id, transcription_sid)` and SSE payloads contain only company scope.

If the HMAC secret is absent, TwiML omits `<Start><Stream>` and the live call
continues without realtime transcription.

### 2.2 Transcription callback

`processTranscriptionEvent` resolves `payload.AccountSid` using the shared
resolver before any write. It passes the resolved company to transcript and
call-event persistence. Unknown bindings throw `TWILIO_TENANT_UNRESOLVED`.
Transcript upsert uses `ON CONFLICT (company_id, transcription_sid)`.

### 2.3 Raw webhook inbox

`ingestToInbox` resolves `payload.AccountSid` itself and requires the resulting
company in `insertInboxEvent`. Unknown bindings write neither raw PII nor a
tenant dead-letter row. Inbox dedup uses
`ON CONFLICT (company_id, event_key) DO NOTHING`.

The softphone TwiML ingress uses the same ingestion helper; it does not maintain
an independent unscoped insert.

### 2.4 Deterministic replay protection

When `I-Twilio-Idempotency-Token` exists, the event key hashes source, event
type, AccountSid, and the token. Otherwise it hashes a fixed JSON field set:
AccountSid, event type, call/parent/recording/transcription SIDs, callback
statuses, sequence, and Twilio timestamp. Wall-clock receipt time is never part
of the key. An exact signed replay therefore selects the same tenant-paired
inbox key.

### 2.5 Required company context

`upsertCall`, `upsertRecording`, `upsertTranscript`, `appendCallEvent`, and
`insertInboxEvent` reject absent company context instead of selecting the
default company. Master callers pass the default UUID explicitly only after
master AccountSid resolution or an explicitly master-only reconciliation feed.
Manual recent/today sync requires an explicit company and selects that
company's master/subaccount client; omitted context throws
`TWILIO_TENANT_UNRESOLVED`. The legacy historical sync is allowed only when the
explicit company resolves in master mode.

### 2.6 Call persistence and live routing

Call and recording upserts use `(company_id, call_sid)` and
`(company_id, recording_sid)`. Outbound softphone TwiML resolves `AccountSid`
before caller-ID validation or persistence. A `From` softphone identity from a
different tenant is rejected and can never select the timeline/call tenant.

Inbound group resolution requires the already-resolved company and filters
`phone_number_settings` by both company and `To`. Call-flow creation, lookup,
state mutation, and callbacks require the resolved company and key executions
by `(company_id, call_sid)`. Caller-controlled `To`, `From`, and CallSid alone
never select another tenant's routing graph or execution.

## 3. Migration 226

`226_twilio_tenant_natural_keys.sql` runs in one locked transaction. It:

1. locks calls, recordings, transcripts, inbox, call-flow executions, and the
   binding table, and fails if company scope is NULL or a subaccount SID has
   ambiguous bindings;
2. removes the historical/re-apply key constraints inside that transaction;
3. re-homes historical default-company rows only when raw `AccountSid` exactly
   matches a persisted subaccount binding; master/unknown rows are not guessed;
4. reports duplicate counts and the remaining default rows whose raw AccountSid
   must be interpreted as master-or-unbound during deployment review;
5. deterministically retains the most complete call, recording, transcript,
   inbox row, and active/latest flow execution for duplicate tenant-pairs;
6. fails preflight on cross-tenant/orphan call-media relationships rather than
   guessing ownership;
7. adds tenant-paired unique keys for call, recording, transcript, inbox, and
   call-flow execution, converts media foreign keys to tenant pairs, and creates
   the short-TTL media-token claim ledger.

Rollback is also locked and transactional. It refuses with
`ROLLBACK_226_BLOCKED` if cross-company duplicate SIDs/keys now exist; it never
deletes one tenant's row merely to restore a global key.

## 4. Number placement and deferred transfer

Production has the ABC Homes master account and two tenant subaccounts. No mass
number move is included in this release. The optional internal-transfer tool
and its owner-gated inventory/test-number/batch runbook remain deferred. The
code fix does not infer tenant ownership from a master-account phone number.

## 5. Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| Twilio HTTP callbacks | resolved payload `AccountSid` | `(company_id,event_key)` | provider signature; no CRM role | signed bound account ✓; missing/foreign/unknown ✗ | raw callback PII and global replay key |
| Inbox voice/recording/transcription workers | resolved payload `AccountSid` | company + Twilio SID | internal worker | bound account ✓; unresolved ✗ | async write to default/foreign tenant |
| `/ws/twilio-media` | HMAC claim rechecked against start `AccountSid` | `(company_id,callSid)` | HMAC and Twilio WS signature hard gates | verified Twilio stream ✓; missing/forged/mismatched ✗ | live audio, transcript DB rows, SSE |
| Inbound group/call-flow callbacks | resolved payload `AccountSid` | `(company_id,callSid)` | provider signature; no CRM role | bound account ✓; unresolved/mismatched ✗ | foreign group execution and tenant-derived TwiML |
| Outbound softphone TwiML persistence | resolved payload `AccountSid` | `(company_id,callSid)` | provider signature + matching tenant identity | matching bound identity ✓; cross-tenant `From` ✗ | foreign timeline/call persistence |
| Realtime transcript persistence/SSE | authenticated session company | `(company_id,transcription_sid)` | internal session | authenticated session ✓ | same CallSid session capture or foreign broadcast |
| Softphone TwiML inbox ingress | resolved payload `AccountSid` | `(company_id,event_key)` | Twilio signature | bound account ✓; unresolved ✗ | bypass of shared inbox isolation |

Provider callbacks have no CRM entity-id authorization lookup, so canonical
`T-foreign` is a rejected provider request with byte-unchanged tenant rows, not
an internal-route 404. CRM RBAC is not applicable to public provider callbacks.

## 6. Verification contract

- `T-own`: master resolves to ABC Homes; each subaccount resolves to its company.
- `T-foreign`: unknown/mismatched AccountSid is rejected before persistence.
- `T-blast`: master and subaccount share CallSid, transcription SID, and event
  key; both rows/sessions remain isolated and the other tenant snapshot is
  byte-unchanged.
- Media: missing/forged/expired/replayed token, call mismatch, account mismatch,
  late validation, and cross-company token binding are rejected before session
  creation/audio.
- Replay: identical callback without the optional idempotency header inserts
  one tenant inbox event.
- Master regression: ABC Homes callbacks and media tokens resolve to the
  default company and continue normally.

Sabotage minimum:

- Remove AccountSid resolution → `SAB-TW-RESOLUTION` makes T-foreign/T-blast red.
- Skip HMAC verification → `SAB-TW-WS-HMAC` makes forged-session test red.
- Restore `Date.now()` → `SAB-TW-REPLAY` makes replay test red.
- Restore default fallback → `SAB-TW-DEFAULT` makes foreign-webhook test red.
- Remove the atomic `jti` claim → `SAB-TW-WS-REPLAY` accepts the second stream.
- Remove post-await rejection checks → `SAB-TW-WS-TIMEOUT` creates a late session.
- Drop resolved-company routing scope → `SAB-TW-GROUP`/`SAB-TW-FLOW-TBLAST`
  expose the foreign group or execution.
