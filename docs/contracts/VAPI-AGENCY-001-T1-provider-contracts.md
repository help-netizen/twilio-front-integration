# VAPI-AGENCY-001 T1 — provider contracts

Status: implemented contract boundary; webhook types observed live, raw bodies pending
Date: 2026-08-16
Contract/fixture version: 1

## Accepted inputs

The adapter accepts raw JSON text only. This preserves every provider numeric lexeme
before JavaScript can coerce it to IEEE-754. Unknown additional object fields are
ignored. Missing required fields, unknown message/call/status discriminators, wrong
wire types, negative costs, and disagreeing totals raise `VapiContractError`.

| Input | Required identity/lifecycle | Cost treatment |
|---|---|---|
| `assistant-request` | `message.type`, `message.call.id`, `orgId`, known `type`; assistant may not exist yet | None assumed |
| `status-update` | Above plus `assistantId`, known matching `message.status` and `call.status` | None assumed |
| `end-of-call-report` | Above plus `status=ended`, exact timestamps and non-empty, matching `endedReason` when present in `call` | T3 accepts `message.call.cost` as the single provisional total and requires matching `message.call.costBreakdown.total`; any other placement is quarantined while its allowlisted shape is captured |
| `GET /call/:id` ended object | `id`, `orgId`, `assistantId`, known `type`, `status=ended`, timestamps, `endedReason` | `call.cost` is canonical; `costBreakdown.total` must equal it |

The adapter never adds components, `costBreakdown.total`, or `costs[]` to derive the
supplier total. It normalizes money to canonical non-negative decimal strings suitable
for PostgreSQL `NUMERIC`; token/character counters are canonical integer strings.

## Evidence and deliberate gaps

Three `GET /call/:id` fixtures are sanitized projections of real production calls: two
inbound SIP calls and one owner-authorized outbound PSTN call. The outbound object was
read twice, four minutes apart, with identical `cost=0.0565` and `updatedAt`; its
analysis breakdown was present. The outbound object did not contain `twilioCallSid`.

The live outbound call delivered two authenticated `status-update` messages and one
authenticated `end-of-call-report` to the repaired deployed endpoint. Only their types,
authentication and call id were logged; raw bodies were not captured. Consequently the
webhook body fixtures remain documentation-derived and make no claim about live field
placement. T3 deliberately accepts only the documented call-level candidate and stores
all exact money as decimal strings/NUMERIC. A different live placement is quarantined,
not guessed; the sanitizer retains allowlisted identity/lifecycle/cost placement while
dropping transcripts, recordings, phone/customer data, names and provider snapshots.

The following evidence still needs one controlled provider observation:

1. Raw `status-update` requests for at least `in-progress` and `ended`, including the
   exact headers and whether `call.status` always mirrors `message.status`.
2. A raw `end-of-call-report`, with the exact placement/timing of `cost`,
   `costBreakdown`, `analysis`, `artifact`, and any provider event identifier/version.
3. A `GET /call/:id` pair in which analysis changes between observations. The live
   outbound pair proves stability handling, but not a changing `updatedAt`/cost pair.
4. A real `assistant-request` from an unbound inbound resource; fixed-assistant SIP is
   also expected to prove the negative case that no assistant request occurs.

A controlled web call is protocol-shape evidence for items 1–3 without dialing a
telephone, if it uses one of the repaired assistants and configured server messages.
It is not automatically persisted by T3: an uncorrelated `webCall` correctly produces
no session/observation/usage. Therefore a production-path fixture needs either an
owner-authorized correlated inbound/outbound call, or a separately authorized test
session bound to that web call before callback delivery. A web call is not evidence
for item 4 or for SIP/Twilio-specific fields and routing; precise server-payload parity
remains part of the observation rather than an assumption.

Sources:

- <https://docs.vapi.ai/server-url/events>
- <https://docs.vapi.ai/api-reference/calls/get/>
- <https://docs.vapi.ai/quickstart/web>

## Secret readback asymmetry

An assistant's `server.secret` is write-only: assistant readback exposes only
`isServerUrlSecretSet`. Tool secrets at `model.tools[].server.secret` remain readable.
Assistant secret provisioning/readback must therefore verify the boolean flag and must
never treat an absent secret value as failed persistence.
