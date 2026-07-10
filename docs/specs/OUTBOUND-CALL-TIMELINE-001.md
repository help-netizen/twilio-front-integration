# Спецификация: OUTBOUND-CALL-TIMELINE-001 — outbound robot calls in the Pulse timeline (live row + finalize with recording/transcript/summary)

**Requirements:** `Docs/requirements.md` → `## OUTBOUND-CALL-TIMELINE-001` (FR-1…9, AC-1…10).
**Architecture:** `Docs/architecture.md` → `## OUTBOUND-CALL-TIMELINE-001` (§1–§9, Decisions A–F).
**Extends:** OUTBOUND-PARTS-CALL-001 (placement worker + `/api/vapi/call-status` webhook). Does NOT change the retry state machine.

### Общее описание
Outbound VAPI robot calls (part-arrived scheduling) today leave nothing in Pulse: VAPI originates its own Twilio leg with ITS OWN statusCallback (`outboundCallService.js:96-134`), so our webhooks never fire; `vapiCallStatus.js` only drives `outbound_call_attempts`. This feature makes a robot call appear in the customer's timeline exactly like a softphone call (`routes/voice.js:344-385` gold model): a live `calls` row at placement, finalized on the end-of-call webhook with status/duration, plus a transcripts row (VAPI summary → `raw_payload.gemini_summary`) and a recordings row (VAPI `recordingUrl`) streamed through the extended playback proxy. All rendering reuses the existing Pulse read paths — zero required frontend changes.

### Ключевые инварианты (all scenarios)
- **NON-FATAL:** every timeline write is wrapped; a failure never blocks the dial (placement) and never disturbs the attempt classification/retry inserts or the webhook's 200 (finalize).
- **Company-scoped:** `companyId` always from the `outbound_call_attempts` row (placement: the claimed row; webhook: the row correlated by `message.call.id` — anti-spoof S10 of OPC1 preserved). Timeline via `findOrCreateTimeline(phone, companyId)` (`timelinesQueries.js:116`).
- **SID:** synthetic `vapi:<vapiCallId>` at placement; re-keyed to the real Twilio CallSid (`phoneCallProviderId`) as soon as it is learned (status-update or end-of-call). Deterministic — derivable from `message.call.id`, no new column.
- **No child rows under a synthetic sid.** `recordings.call_sid` / `transcripts.call_sid` have FKs `REFERENCES calls(call_sid)` (`backend/db/v3_schema.sql:93,117`) with no ON UPDATE CASCADE — writing them before re-key would make the re-key UPDATE fail. Transcript/recording are written only at finalize, AFTER sid resolution.

---

### Сценарий S1: Placement → live row in Pulse (happy path)
- **Предусловия:** dispatcher (or retry scheduler) enqueued an attempt; `outboundCallWorker.processAttempt` claimed it; `placeCall` returned `{ok:true, vapiCallId}` (`outboundCallWorker.js:266-276`).
- **Шаги:**
  1. Worker stamps `vapi_call_id` on the attempt (existing, unchanged).
  2. Worker calls `vapiCallTimelineService.recordPlacement({attempt, vapiCallId, dialedNumber, callerId})` — `dialedNumber` = the same `attempt.phone || job.customer_phone` given to placeCall; `callerId` = `process.env.VAPI_OUTBOUND_TWILIO_NUMBER || process.env.OUTBOUND_CALLER_ID || null`.
  3. Service resolves `findOrCreateTimeline(dialedNumber, attempt.company_id)` → `{timelineId, contactId}`. Inner guard: a timeline-resolution failure downgrades to `timelineId:null, contactId:null` and the row is still created (call history keeps it; the Pulse thread misses it until finalize self-heals) — see гранично-5.
  4. `queries.upsertCall({callSid:'vapi:'+vapiCallId, parentCallSid:null, contactId, timelineId, companyId:attempt.company_id, direction:'outbound', fromNumber:callerId, toNumber:dialedNumber, status:'initiated', isFinal:false, startedAt:now, lastEventTime:now, rawLastPayload:{source:'vapi-placement', vapi_call_id, attempt_id, job_id}})`.
  5. `UPDATE calls SET answered_by='ai' WHERE call_sid=$1 AND answered_by IS NULL` (upsertCall has no answered_by column — `callsQueries.js:15-63`).
  6. Re-read `getCallByCallSid` → `realtimeService.publishCallUpdate({eventType:'call.updated', ...row})` (full row so `timeline_id`/`contact_id` reach the SSE gate in `usePulsePage.ts:41`).
- **Ожидаемый результат:** the row is instantly visible: Pulse sidebar (lateral `WHERE c2.timeline_id = tl.id AND parent_call_sid IS NULL`, `timelinesQueries.js:527-531`) shows the thread with the **Bot icon** (`answered_by='ai'` matches `AI_ANSWERED_BY_MARKERS=['ai','vapi','bot','assistant']`, `PulseContactItem.tsx:46,74-77,183`); the open thread feed shows a call tile with the **Ringing** pill (`initiated`→`ringing` in `callToCallData`, `pulseHelpers.ts:14`; pill colors `PulseCallListItem.tsx:17-27`); `hasActiveCall` (`usePulsePage.ts:71`) disables the ContactCard Call button (`ContactCard.tsx:58`).
- **Побочные эффекты:** none on the attempt row. No `call_events` append (mirror of the softphone path, which doesn't append either — `voice.js:344-385`).

### Сценарий S2: Mid-call status-update → live transitions + early re-key
- **Предусловия:** the OUTBOUND assistant's `serverMessages` includes `status-update` (ops step CT-07); a `status-update` POST arrives at `/api/vapi/call-status` (today dropped at `vapiCallStatus.js:114`).
- **Шаги:**
  1. Route: `message.type === 'status-update'` → correlate `outbound_call_attempts` by `message.call.id` (same SELECT as end-of-call). Unknown id → 200 no-op.
  2. `vapiCallTimelineService.applyStatusUpdate({attempt, message})`:
     - resolve sid: if `message.call.phoneCallProviderId` present → **re-key** (S4 algorithm);
     - map `message.status`: `queued`→`queued`, `ringing`→`ringing`, `in-progress`→`in-progress`, `ended`/anything else → no status write (finalize owns terminal);
     - `upsertCall` (non-final, `lastEventTime:new Date()`, `answeredAt: status==='in-progress' ? now : null`) + re-read + `publishCallUpdate`.
  3. Route answers 200. The attempt row is NEVER touched by this branch.
- **Ожидаемый результат:** the tile's pill moves Ringing → In Progress live. If the assistant config lacks `status-update`, nothing arrives and the row simply stays `initiated` until finalize — silent degradation, no error.

### Сценарий S3: End-of-call-report → finalize with duration/summary/transcript/recording
- **Предусловия:** `end-of-call-report` correlated to an attempt (existing code path, `vapiCallStatus.js:127-138`).
- **Шаги:**
  1. AFTER the existing correlation (and regardless of the attempt's classification branch), the route calls `vapiCallTimelineService.finalizeFromEndOfCallReport({attempt, message})` inside its own try/catch. Ordering: run finalize BEFORE the attempt state-machine writes so a state-machine throw can't starve the timeline; both are independently guarded either way.
  2. Service resolves the final sid (S4), then:
     - `status = mapVapiEndedReasonToCallStatus(endedReason, durationSec)` (table below);
     - `startedAt = message.startedAt || message.call.startedAt || existing.started_at`; `endedAt = message.endedAt || now`; `durationSec = message.durationSeconds ?? round((endedAt-startedAt)/1000) ?? null`;
     - `upsertCall({callSid:finalSid, status, isFinal:true, startedAt, endedAt, durationSec, answeredAt: status==='completed' ? startedAt : null, timelineId/contactId/companyId from the existing row (or re-resolve by phone+company if the placement row is missing — self-healing), lastEventTime:new Date(), rawLastPayload:{source:'vapi-end-of-call', endedReason, vapi_call_id}})`;
     - `answered_by='ai'` backfill (same guarded UPDATE as S1).
  3. Transcript: `text = message.transcript || message.artifact?.transcript || null`; `summary = message.summary || message.analysis?.summary || null`. If text or summary → `upsertTranscript({transcriptionSid:'vapi_'+vapiCallId, callSid:finalSid, mode:'post-call', status:'completed', text, isFinal:true, companyId, rawPayload:{source:'vapi', vapi_call_id, gemini_summary: summary}})` — synthetic-sid precedent `aai_<jobId>` (`transcriptionService.js:180-203`); `gemini_summary` renders for free via `formatCall` (`pulse.js:388-397`).
  4. Recording: `recUrl = message.recordingUrl || message.artifact?.recordingUrl || message.stereoRecordingUrl || null`. If present → `upsertRecording({recordingSid:'vapi_'+vapiCallId, callSid:finalSid, status:'completed', recordingUrl:recUrl, durationSec, source:'vapi', startedAt, completedAt:endedAt, companyId})`.
  5. Re-read `getCallByCallSid(finalSid)` → `publishCallUpdate({eventType:'call.updated', ...row})`.
- **Ожидаемый результат:** the tile flips to its terminal pill with duration; expanding it shows the audio player (`recording.playback_url = /api/calls/<finalSid>/recording.mp3`, `pulse.js:385`), the AI summary (Summary tab reads `transcript.gemini_summary`) and the transcript text. The attempt state machine (booked/declined/retry/exhaust) behaves byte-identically to today.

#### endedReason → calls.status mapping (`mapVapiEndedReasonToCallStatus`)
Ordered, case-insensitive substring checks on `endedReason` (independent of `classifyEndedReason`, which stays the attempt-retry classifier — different vocabularies, do NOT merge):
1. contains `voicemail` → `voicemail_left`
2. contains `did-not-answer` or `no-answer` → `no-answer`
3. contains `busy` → `busy`
4. else if `durationSec > 0` → `completed` (covers customer-ended-call / assistant-ended-call / assistant-forwarded-call / customer-declined — a conversation happened; "declined" is an attempt outcome, not a call status)
5. else → `failed` (pipeline/provider errors, zero-duration ends)
All five outputs are existing UI vocabulary (`stateMachine.js FINAL_STATUSES`; pills in `PulseCallListItem.tsx:17-38`).

### Сценарий S4: SID resolution (re-key / merge) — exact algorithm
`resolveFinalSid({syntheticSid:'vapi:'+vapiCallId, realSid: message.call.phoneCallProviderId || null})`:
1. `realSid` falsy → return `syntheticSid` (no re-key; S6 covers this row's lifecycle).
2. `SELECT` row with `call_sid = realSid`:
   - **exists** (coldReconcile created it in the window — `reconcileService.js:201-254` is on-demand, so rare but must be handled): **merge** — `UPDATE calls SET timeline_id=COALESCE(real.timeline_id, synth.timeline_id), contact_id=COALESCE(real.contact_id, synth.contact_id), answered_by=COALESCE(real.answered_by, synth.answered_by, 'ai') WHERE call_sid=realSid`; `DELETE FROM calls WHERE call_sid=syntheticSid` (safe: no FK children by invariant). Return `realSid`.
   - **not exists:** `UPDATE calls SET call_sid=realSid WHERE call_sid=syntheticSid`; on unique-violation `23505` (race with a concurrent insert of realSid) → retry the merge branch once. Return `realSid`. If the synthetic row is also missing (placement hook had failed) → return `realSid` (finalize's upsertCall will create the row from scratch with attempt-derived timeline/company — self-healing).
3. Never rename in the other direction; never touch `outbound_call_attempts`.

### Сценарий S5: Reconciler safety (the fork the trace missed) — synthetic sids must be invisible to Twilio pollers
- **Проблема:** `reconcileStaleCalls` runs every 5 min from the inbox worker (`inboxWorker.js:16,917-920`), picks ALL non-final calls older than 3 min (`reconcileStale.js:20-26`) and fetches them from Twilio; a Twilio 404 marks the row `failed/is_final=true` (`reconcileStale.js:185-191`). A live robot call still keyed `vapi:<id>` would be **killed mid-call ~3–8 minutes in**. `hotReconcile` (CLI `cli/reconcileHot.js`) → `getNonFinalCalls` (`callsQueries.js:314-323`) has the same 404-log noise.
- **Поведение:**
  1. Both selectors gain a Twilio-sid guard: `AND call_sid LIKE 'CA%'` (`reconcileStale.js:24` SELECT; `callsQueries.js getNonFinalCalls`). Every genuine Twilio CallSid starts with `CA`; all existing rows come from Twilio webhooks/API, so behavior for them is byte-identical.
  2. **Synthetic sweeper (safety net):** in `reconcileStaleCalls`, a second cheap query: non-final rows `call_sid LIKE 'vapi:%'` with `started_at < now() - interval '15 minutes'` → `UPDATE ... SET status='failed', is_final=true, ended_at=COALESCE(ended_at, now())` + `publishCallUpdate`. Covers "VAPI never sent end-of-call AND no status-update re-key happened" so `hasActiveCall` can't wedge a contact's Call button forever. 15 min ≫ any parts call; finalize can still overwrite later (`upsertCall` allows final→final).
  3. Once re-keyed to a real `CA…` sid, the row IS polled by the stale reconciler — desired: if VAPI's end-of-call webhook is lost, Twilio truth finalizes status/duration (S7).

### Сценарий S6: No `phoneCallProviderId` ever learned
- Call fails instantly on VAPI's side (or provider id absent from every message): finalize (S3) runs entirely under `vapi:<id>` — terminal status (usually `failed`/`no-answer`), transcript/recording rows keyed to the synthetic sid are fine (FK target exists; created after resolution). The playback proxy branch (S8) works because it keys off `recording_sid`/`recording_url`, not the call sid. No Twilio poller ever sees the row (S5 guard) and it is final anyway.

### Сценарий S7: Webhook lost → reconciler finalizes (degraded)
- Re-key happened (S2) but the end-of-call-report never arrives: the row sits non-final with a real `CA…` sid → `reconcileStaleCalls` (≥3 min) fetches Twilio and writes the terminal status/duration/`is_final` + SSE (`reconcileStale.js:110-182`). **Degradation:** no transcript/summary/recording rows (those only come from the VAPI payload) — acceptable; the attempt row is separately terminal-guarded by OPC1's own logic (out of scope here).
- No re-key AND no webhook → S5.2 sweeper (`failed` after 15 min).

### Сценарий S8: Playback of a VAPI recording (proxy extension)
- `GET /api/calls/:callSid/recording.mp3` (`calls.js:526-567`; mounted behind `authenticate, requireCompanyAccess` — `src/server.js:122`):
  1. `getCallMedia` resolves the newest completed recording (unchanged).
  2. **New branch:** if NOT `/^RE/i.test(recording.recording_sid)` → require `recording.recording_url`; `fetch(recording.recording_url)` (no auth header — VAPI URLs are self-authorizing), on `!ok` → 502; pipe body with `Content-Type` from the upstream response (fallback `audio/wav`), `Accept-Ranges`/`Content-Length` passthrough as today.
  3. `RE…` sids keep the existing Twilio REST path byte-identically.
- `GET /api/calls/:callSid/media` needs no change (playbackUrl already points at the proxy — `calls.js:585`).

### Сценарий S9: Retries → one row per attempt
- Each attempt places its own VAPI call → distinct `vapiCallId` → distinct row (`vapi:<id>` → own real sid). A customer called 3× shows 3 tiles, mirroring 3 softphone attempts. The `(job_id)` active-attempt guard already serializes attempts, so rows never interleave.

### Сценарий S10: Company scoping / isolation
- Placement + finalize derive `companyId` ONLY from the attempt row; `findOrCreateTimeline(phone, attempt.company_id)` never crosses tenants (PF007-HARDENING-001). A webhook with an unknown/foreign `call.id` remains a 200 no-op (existing). `upsertCall` never updates `company_id` on conflict (`callsQueries.js:32-50` — not in the SET list), so later Twilio-side reconciles can't re-tenant the row. Known pre-existing limitation (unchanged): `reconcileCall` resolves timelines without a company (`reconcileService.js:85`) — affects all calls equally, not worsened here.

### Сценарий S11: Sara inbound unaffected
- No changes to `callFlowRuntime.renderVapiNode` (`:443-480`), inbound webhooks, `inboxWorker.processVoiceEvent`, or child-leg `answered_by` propagation (`inboxWorker.js:436-448`). The S5 `CA%` guards are no-ops for Sara's rows (real Twilio sids). Inbound Sara's AI marker keeps coming from the SIP-username propagation; outbound robots now set `answered_by='ai'` explicitly — both hit the same `isAiAnsweredBy` markers.

### Граничные случаи
1. Placement hook throws (timeline DB down) → logged warn, dial proceeds, attempt flow untouched; finalize later self-heals the row from scratch (S4.2 "missing synthetic").
2. `end-of-call-report` for an attempt already terminal (`status !== 'dialing'`) → the route's idempotence no-op happens AFTER finalize ran once; a REPEAT webhook re-runs finalize idempotently (same sid, same terminal upsert — monotonic guard `last_event_time` + final→final allowed) but must NOT re-publish attempt-side effects (it can't — that branch returns early). Duplicate transcript/recording upserts hit `ON CONFLICT` keys `transcription_sid`/`recording_sid` → idempotent.
3. `message.summary`/`transcript`/`recordingUrl` all absent → calls row still finalizes; no transcript/recording rows; feed shows the tile without a player (audioUrl absent → `PulseCallAudioPlayer` returns null, `:115`).
4. Attempt row has `phone` NULL and job lookup already provided the dialed number — hook receives `dialedNumber` from the worker's scope, never re-derives.
5. Anonymous/invalid dialed number → `findOrCreateTimeline` sentinel path; if timeline resolution fails, upsert WITHOUT `timelineId` (row exists in /calls history, absent from Pulse thread) — still non-fatal.
6. `status-update` arriving AFTER finalize → `upsertCall` monotonic/is_final guard (`callsQueries.js:49-50`) rejects the non-final overwrite → no-op.
7. coldReconcile run AFTER finalize re-upserts the real sid with Twilio data → guard `(NOT calls.is_final OR EXCLUDED.is_final)`: Twilio reports final `completed` → allowed, harmlessly refreshes price/duration; non-final Twilio states are rejected.

### Обработка ошибок
1. Any service-internal error → `console.warn('[vapiCallTimeline] … (non-fatal)')`, function returns null; callers never branch on it.
2. Webhook handler keeps its existing safe-fail 200 envelope (`vapiCallStatus.js:262-266`).
3. Proxy upstream failure → 502 `{error:'Failed to fetch recording'}` (mirrors Twilio branch).

### Взаимодействие компонентов
- `outboundCallWorker.processAttempt` → `vapiCallTimelineService.recordPlacement` → `timelinesQueries.findOrCreateTimeline` + `callsQueries.upsertCall` → SSE `call.updated` → `sseManager.ts` namedEvents (`:91-110`, no new event names) → `usePulsePage.onCallUpdate` refetch.
- VAPI → `POST /api/vapi/call-status` (secret auth, `webhookSecretAuth`) → correlation → `vapiCallTimelineService.applyStatusUpdate` / `finalizeFromEndOfCallReport` → same SSE.
- Frontend playback → `GET /api/calls/:sid/recording.mp3` → Twilio REST (RE…) | `recording_url` stream (vapi_…).

### API-контракты
- No new endpoints. `/api/vapi/call-status` (shared-secret, machine) gains a `status-update` branch — response envelope unchanged (`{ok:true}` always). `/api/calls/:callSid/recording.mp3` — contract unchanged (audio stream | 404 | 502); auth unchanged (`authenticate, requireCompanyAccess`, company data isolation as today).

### Безопасность и изоляция данных
- Webhook: fail-closed secret (503/401), correlation-only trust, company from the row — all existing, extended branches inherit it.
- No client-supplied companyId anywhere; SQL writes carry `attempt.company_id`.
- Recording URLs are stored server-side and streamed through the authed proxy — the VAPI URL is never handed to the browser.
