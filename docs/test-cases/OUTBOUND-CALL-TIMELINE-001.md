# Тест-кейсы: OUTBOUND-CALL-TIMELINE-001 — robot calls in the Pulse timeline

**Binding:** spec `Docs/specs/OUTBOUND-CALL-TIMELINE-001.md` (S1–S11); architecture §1–§9. Jest pattern: mocked `db/connection` + module mocks, supertest for the webhook/route (reuse the harness of `tests/vapiCallStatusWebhook.test.js` and `tests/outboundCallWorker.test.js`). Worktree runs: `--testPathIgnorePatterns "/node_modules/"`.

### Покрытие
- Всего: 26 (unit 18, integration/supertest 5, frontend build/logic-review 3)
- P0: 11 | P1: 9 | P2: 4 | P3: 2

**Files:** `tests/vapiCallTimelineService.test.js` (NEW), `tests/outboundCallWorker.test.js` (extend), `tests/vapiCallStatusWebhook.test.js` (extend), `tests/reconcileStale.test.js` (NEW), `tests/callsRecordingProxy.test.js` (NEW, supertest with mocked `db/queries` + global.fetch).

---

### TC-CT-001: placement hook creates the live row — P0, Unit (S1/AC-1)
- **Моки:** db, `findOrCreateTimeline`→`{id:71, contact_id:5}`, `upsertCall`→row, realtimeService.
- **Шаги:** `recordPlacement({attempt:{company_id:'co-1', phone:'+16175550100', …}, vapiCallId:'v-123', dialedNumber:'+16175550100', callerId:'+16175006181'})`.
- **Ожидаемо:** `upsertCall` called with `callSid:'vapi:v-123'`, `direction:'outbound'`, `status:'initiated'`, `isFinal:false`, `timelineId:71`, `contactId:5`, `companyId:'co-1'`, from/to as given; then guarded `UPDATE … SET answered_by='ai' … AND answered_by IS NULL`; then `publishCallUpdate` with the full re-read row (`eventType:'call.updated'`).

### TC-CT-002: placement hook is NON-FATAL — P0, Unit (S1/AC-5)
- **Моки:** `upsertCall` throws (DB down).
- **Ожидаемо:** `recordPlacement` resolves (no throw), warn logged, no `publishCallUpdate`.

### TC-CT-003: worker wiring — hook after vapi_call_id stamp, dial unaffected — P0, Unit in `outboundCallWorker.test.js` (S1)
- **Моки:** existing worker harness; `vapiCallTimelineService.recordPlacement` mocked (a) resolving, (b) rejecting/throwing.
- **Ожидаемо:** placeCall ok → attempt UPDATE with `vapi_call_id` happens FIRST, then recordPlacement called once with `{vapiCallId, dialedNumber, callerId}`; in (b) `processAttempt` still resolves and the attempt stays `dialing` (no failed-attempt insert) — timeline errors never feed the retry loop.

### TC-CT-004: endedReason → calls.status mapping table — P0, Unit (S3)
- Cases: `voicemail`→`voicemail_left`; `customer-did-not-answer`→`no-answer`; `twilio-failed-to-connect-call` +dur 0→`failed`; `customer-busy`→`busy`; `customer-ended-call` +dur 95→`completed`; `assistant-ended-call` +dur 40→`completed`; `assistant-forwarded-call` +dur 30→`completed`; `customer-declined` +dur 60→`completed` (decline is an ATTEMPT outcome, not a call status); `''`/null +dur 0→`failed`; ordering: `voicemail` wins over duration.

### TC-CT-005: finalize writes call+transcript+recording+SSE — P0, Unit (S3/AC-2)
- **Входные:** message `{type:'end-of-call-report', call:{id:'v-123', phoneCallProviderId:'CA999'}, endedReason:'customer-ended-call', startedAt, endedAt, durationSeconds:95, summary:'Booked Tue 9-11', transcript:'AI: …', recordingUrl:'https://storage.vapi.ai/rec.wav'}`; attempt `{company_id:'co-1'}`; synthetic row exists, no `CA999` row.
- **Ожидаемо:** re-key UPDATE `vapi:v-123`→`CA999`; `upsertCall(callSid:'CA999', status:'completed', isFinal:true, durationSec:95, answeredAt=startedAt)`; `upsertTranscript(transcriptionSid:'vapi_v-123', callSid:'CA999', status:'completed', text, rawPayload.gemini_summary='Booked Tue 9-11', companyId:'co-1')`; `upsertRecording(recordingSid:'vapi_v-123', callSid:'CA999', recordingUrl, source:'vapi', companyId:'co-1')`; `publishCallUpdate` last. Transcript/recording written ONLY after sid resolution (call order asserted).

### TC-CT-006: re-key duplicate window → merge — P0, Unit (S4/AC-4)
- **Предусловия:** rows exist for BOTH `vapi:v-123` (timeline 71, answered_by 'ai') and `CA999` (coldReconcile artifact, timeline NULL).
- **Ожидаемо:** merge UPDATE on `CA999` (timeline_id→71, answered_by→'ai' via COALESCE), DELETE `vapi:v-123`, finalize proceeds on `CA999`; no unique-violation escapes; on a simulated `23505` from the rename path the merge branch is retried once.

### TC-CT-007: no phoneCallProviderId → finalize under synthetic sid — P1, Unit (S6)
- **Ожидаемо:** no re-key attempted; `upsertCall('vapi:v-123', …, isFinal:true)`; transcript/recording keyed to `vapi:v-123`; resolves ok.

### TC-CT-008: webhook wiring — finalize runs, state machine byte-identical — P0, Integration/supertest in `vapiCallStatusWebhook.test.js` (S3/AC-3,AC-5)
- **Моки:** existing harness + `vapiCallTimelineService` mocked.
- **Шаги:** POST end-of-call (`customer-did-not-answer`, attempt dialing, attempt_no 1 < max 3).
- **Ожидаемо:** `finalizeFromEndOfCallReport` called once with the correlated attempt + message; THEN the existing writes: attempt→`no_answer`, next-attempt INSERT, note, 200 `{ok:true}`. With `finalizeFromEndOfCallReport` mocked to THROW: identical attempt writes + 200 (finalize failure never disturbs the retry).

### TC-CT-009: webhook idempotence + unknown call.id unaffected — P1, Integration (S10, гранично-2)
- Repeat end-of-call for a non-`dialing` attempt → 200 no-op AND `finalizeFromEndOfCallReport` still invoked (re-finalize is idempotent by upsert keys) — assert no attempt writes. Unknown `call.id` → 200, finalize NOT called (no row = no company = no write; anti-spoof preserved). Wrong/missing secret → 401/503 (existing tests keep passing — regression gate).

### TC-CT-010: status-update branch — P1, Integration (S2)
- POST `{message:{type:'status-update', status:'in-progress', call:{id:'v-123', phoneCallProviderId:'CA999'}}}` with a correlated dialing attempt → 200; `applyStatusUpdate` called; NO attempt-table writes (assert mockQuery never saw UPDATE outbound_call_attempts). Unknown call.id → 200 no-op.

### TC-CT-011: applyStatusUpdate maps + re-keys early — P1, Unit (S2)
- `status:'ringing'` → upsertCall(`status:'ringing'`, isFinal:false) on the re-keyed sid + SSE; `status:'ended'` → NO status upsert (finalize owns terminal); provider id absent → keeps synthetic sid.

### TC-CT-012: reconcileStale skips synthetic sids — P0, Unit `tests/reconcileStale.test.js` (S5/AC-6)
- **Моки:** db returns a mix of stale rows; twilio client fetch spy.
- **Ожидаемо:** SELECT carries `call_sid LIKE 'CA%'` (or: `vapi:` rows never reach `fetchAndUpdateFromTwilio`); the Twilio 404→failed path still works for a `CA…` row (regression).

### TC-CT-013: 15-min synthetic sweeper — P0, Unit (S5.2/AC-6)
- Non-final `vapi:x` row `started_at` 20 min ago → UPDATE to `failed`/`is_final=true` + `publishCallUpdate`; a 5-min-old row is untouched.

### TC-CT-014: getNonFinalCalls CA-guard — P1, Unit
- Rows `CA1` + `vapi:z` non-final → only `CA1` returned (hot-reconcile CLI safe).

### TC-CT-015: recording proxy — vapi branch streams recording_url — P0, Integration/supertest `tests/callsRecordingProxy.test.js` (S8/AC-8)
- **Моки:** `queries.getCallMedia`→recording `{recording_sid:'vapi_v-123', status:'completed', recording_url:'https://storage.vapi.ai/rec.wav'}`; `global.fetch`→200 stream, `content-type:audio/wav`.
- **Ожидаемо:** 200, Content-Type audio/wav, body piped; fetch called WITHOUT Authorization header; Twilio REST URL never fetched.

### TC-CT-016: recording proxy — Twilio branch unchanged + negatives — P1, Integration
- `RE…` sid → fetch to `api.twilio.com…/Recordings/RE….mp3` WITH Basic auth (regression); `vapi_…` sid with NULL recording_url → 404; upstream !ok → 502; non-completed recording → 404 (existing).

### TC-CT-017: upsertCall guard interplay — P2, Unit (гранично-6/7)
- After finalize (`is_final=true`), a late `applyStatusUpdate('in-progress')` upsert → row unchanged (`(NOT calls.is_final OR EXCLUDED.is_final)`); a later final Twilio reconcile-style upsert (final→final) → allowed. (Real query semantics — use the fixture DB harness if available, else assert the built WHERE.)

### TC-CT-018: retries → one row per attempt — P2, Unit (S9/AC-7)
- Two attempts, vapiCallIds v-1/v-2 → two `upsertCall`s with `vapi:v-1`/`vapi:v-2`; no cross-contamination of timeline ids (same phone → same timeline both).

### TC-CT-019: company isolation of timeline resolution — P0, Unit (S10/AC-9)
- `recordPlacement` with `attempt.company_id='co-B'` → `findOrCreateTimeline(phone, 'co-B')` exactly; никогда default-company; `upsertCall.companyId='co-B'`. Combined with TC-CT-009's foreign-call.id no-op this is the isolation pair (webhook has no session — middleware 401/403 cases N/A by design; secret tests cover authz).

### TC-CT-020: transcript/summary absent → call still finalizes — P2, Unit (гранично-3)
- Message without summary/transcript/recordingUrl → upsertCall final; upsertTranscript/upsertRecording NOT called; SSE fired.

### TC-CT-021: summary-only (no transcript text) → transcripts row with gemini_summary — P2, Unit (FR-5)
- `summary` present, `transcript` absent → upsertTranscript called with `text:null`, `rawPayload.gemini_summary` set (feed Summary tab works; Transcription tab empty).

### TC-CT-022: dialedNumber fallback — P3, Unit
- attempt.phone NULL → hook receives job.customer_phone (worker passes the same expression as placeCall); timeline resolved on it.

### TC-CT-023: timeline resolution fails → row still created without timeline — P3, Unit (S1 inner guard / гранично-5)
- `findOrCreateTimeline` throws → inner guard downgrades: `upsertCall` still called with `timelineId:null, contactId:null` (row lands in call history; Pulse thread misses it until finalize self-heals), warn logged, SSE still fired.

### TC-CT-024: FE — thread feed renders live/final robot tiles — P1, logic-review + `npm run build`
- Verify (code-read): `callToCallData` maps `initiated`→ringing pill, `voicemail_left` label exists; player appears once `recording.playback_url` set; Summary tab shows `gemini_summary`. No code change expected — build green is the gate.

### TC-CT-025: FE — sidebar Bot marker for answered_by='ai' — P1, logic-review
- `isAiAnsweredBy('ai')===true` (marker list `PulseContactItem.tsx:46`); marker renders for latest-call rows (`:174-183`). If CT-08 chip lands: `PulseCallListItem` shows the Bot glyph only when `answeredBy` matches; build green.

### TC-CT-026: Sara inbound regression — P1, logic-review + existing suites
- `tests/callFlowRuntime.vapi.test.js` + inbound webhook suites stay green; no diff to `callFlowRuntime.js`/`inboxWorker.js` except none (assert via git diff scope in review).

**Моки внешних API (общие):** VAPI — только payload-фикстуры (никаких live вызовов); Twilio — client spy (никаких live); SSE — realtimeService mock; DB — mockQuery / db/queries module mock.
