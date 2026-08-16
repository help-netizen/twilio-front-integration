# VAPI-AGENCY-001 T1 fixtures

These fixtures pin version 1 of the provider boundary; they are not
application-domain test data. `manifest.v1.json` records provenance and whether each
shape was observed live.

| Fixture | Provenance | Live capture? |
|---|---|---:|
| `get-call.inbound-analysis.production-sanitized.json` | Read-only `GET /call/:id` on 2026-08-16 | Yes |
| `get-call.inbound-short.production-sanitized.json` | Read-only `GET /call/:id` on 2026-08-16 | Yes |
| `assistant-request.docs.json` | Vapi Server events documentation | No |
| `status-update.docs.json` | Vapi Server events documentation | No |
| `end-of-call-report.docs-composed.json` | Vapi Server events shape plus fields observed in `GET /call` | No |

The production captures retain provider field names and exact cost lexemes. Provider,
organization, assistant, and call identifiers are synthetic. Timestamps were shifted.
The following data was removed rather than replaced: customer and phone objects, caller
and destination numbers, Twilio/SIP identifiers, assistant snapshots and overrides,
messages, transcript, recording and log URLs, artifacts, analysis text, and any server
or tool configuration. No API key or webhook secret was captured.

Documentation source: <https://docs.vapi.ai/server-url/events> and
<https://docs.vapi.ai/api-reference/calls/get/>.

The webhook fixtures deliberately exclude unobserved cost placement. Until a live
`end-of-call-report` is captured, only `GET /call/:id` is an accepted authoritative
cost input for this adapter.
