# CALL-BLACKLIST-001 — Inbound call blacklist

## Status

Approved for implementation.

## Goal

Allow an authorized company user to maintain a company-scoped list of phone
numbers whose inbound voice calls are rejected before group routing. Rejected
calls remain visible in Pulse as `blocked`, while producing no unread state,
Action Required item, or task.

## Product behavior

### Telephony settings

Add **Blacklist** under Telephony settings.

- The page lists blocked phone numbers newest first.
- **Add number** opens a right-side panel drawer.
- The drawer uses the canonical floating `PhoneInput` field.
- Accepted values are US/Canada phone numbers containing ten national digits.
- A duplicate number is rejected with: “This number is already on the
  blacklist.”
- An invalid number is rejected with: “Enter a complete 10-digit phone number.”
- Removing a number requires a short confirmation dialog.
- The empty state explains that blocked inbound calls will appear in Pulse and
  offers the same **Add number** action.
- The settings copy makes clear that the rule applies to calls only; contacts
  and text messages are unchanged.

Blacklist records contain the canonical phone number and audit ownership only.
They do not reference contacts.

### Inbound caller experience

For a matching inbound caller, return Twilio `<Reject reason="busy"/>` before
answering or dialing any member. The response builder remains isolated so the
caller treatment can be changed without changing blacklist matching or
persistence.

### Pulse

A successfully rejected call is persisted with call status `blocked` and
direction `inbound`.

- Pulse renders a distinct blocked-call icon and the label **Blocked**.
- If the phone number matches a contact, the contact name remains the primary
  label; **Blocked** is supporting call-state information.
- A blocked call is not represented as `missed`.
- A blocked call creates no unread state, Action Required item, or task.

## Inbound flow and failure policy

The blacklist lookup runs after the webhook has resolved the owning company and
strictly before wallet checks or group routing.

1. Validate the Twilio webhook and identify inbound versus outbound handling.
2. Resolve the inbound company from the Twilio account or destination number.
3. Look up `(company_id, caller_phone)` in the blacklist.
4. On a match, persist the blocked call snapshot synchronously.
5. Only after persistence succeeds, return the isolated busy-reject TwiML.
6. Otherwise, enqueue the normal inbound event and continue through the
   existing wallet and group-routing flow.

The lookup and blocked-call persistence are both fail-open. Any exception is
logged and the call continues through normal routing. Telephony routing must not
depend on blacklist availability. In particular, the normal `call.inbound`
inbox event is not enqueued for a successfully blocked call, preventing the
ordinary inbound worker from creating unread/Action Required/task work.
If Twilio later emits a status callback for the same call SID, the worker sees
the existing terminal `blocked` snapshot and ignores the event before timeline,
unread, Action Required, task, or status mutations.

## Data model

`telephony_blacklist_numbers`

| Column | Type | Rules |
|---|---|---|
| `id` | `bigserial` | Primary key |
| `company_id` | `uuid` | Required, FK to `companies`, cascade delete |
| `phone_e164` | `text` | Required, canonical `+1` plus ten digits |
| `created_by` | `uuid` | Nullable FK to `crm_users`, set null on user delete |
| `created_at` | `timestamptz` | Required, defaults to `now()` |

The unique key is `(company_id, phone_e164)`. All reads and mutations include
`company_id`.

The `calls.status` column already stores string states and receives the new
terminal value `blocked`; no contact relationship is added to the blacklist
table. Existing timeline/contact resolution is reused when persisting the call,
so a known caller keeps the existing contact association.

## API

All endpoints inherit `authenticate`, `requirePermission('tenant.telephony.manage')`,
and `requireCompanyAccess`. The company is read only from
`req.companyFilter.company_id`.

- `GET /api/telephony/numbers/blacklist` — list the current company's rows.
- `POST /api/telephony/numbers/blacklist` with `{ phone_number }` — normalize and
  add a number. Returns `400 INVALID_PHONE_NUMBER` or
  `409 PHONE_ALREADY_BLACKLISTED` when applicable.
- `DELETE /api/telephony/numbers/blacklist/:id` — remove the current company's
  row. A missing or foreign-company row returns `404`.

## Permissions

Reuse `tenant.telephony.manage`, matching the surrounding Telephony settings
surface. No new permission or role is introduced.

## Verification requirements

- Service tests prove every blacklist query includes `company_id` and that a
  foreign-company delete cannot remove a row.
- Route tests cover authorization, validation, duplicate handling, and 404s.
- Webhook tests prove a match is persisted and rejected before group routing.
- A dedicated fail-open test forces the blacklist lookup to throw and asserts
  that group routing still starts and returns its normal TwiML.
- Pulse helper/component tests prove `blocked` is distinct from `missed` and a
  known contact name remains visible.
