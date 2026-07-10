/**
 * vapiCallTimelineService.test.js — OUTBOUND-CALL-TIMELINE-001, CT-01 unit slice.
 *
 * Binding: Docs/test-cases/OUTBOUND-CALL-TIMELINE-001.md
 *   TC-CT-001 (placement live row), TC-CT-002 (placement non-fatal),
 *   TC-CT-004 (endedReason→status table), TC-CT-005 (finalize call+transcript+
 *   recording+SSE, children ONLY after re-key), TC-CT-006 (re-key merge + 23505
 *   retry), TC-CT-007 (no providerId → finalize under synthetic sid),
 *   TC-CT-011 (applyStatusUpdate maps + re-keys early), TC-CT-019 (company
 *   isolation), TC-CT-020 (transcript/summary absent), TC-CT-021 (summary-only),
 *   TC-CT-022 (dialedNumber fallback), TC-CT-023 (timeline-resolve fail → row
 *   still created) + resolveFinalSid happy/no-op re-key.
 *
 * All DB + realtime seams mocked (no real DB, no SSE). A mocked jest here proves
 * the DISPATCH: which SQL string ran, which upsert fired, with what company_id,
 * and the re-key-before-children ordering — never that a row actually moved.
 */
'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: (...a) => mockQuery(...a) }));

const mockFindOrCreateTimeline = jest.fn();
const mockUpsertCall = jest.fn();
const mockGetCallByCallSid = jest.fn();
const mockUpsertTranscript = jest.fn();
const mockUpsertRecording = jest.fn();
jest.mock('../backend/src/db/queries', () => ({
    findOrCreateTimeline: (...a) => mockFindOrCreateTimeline(...a),
    upsertCall: (...a) => mockUpsertCall(...a),
    getCallByCallSid: (...a) => mockGetCallByCallSid(...a),
    upsertTranscript: (...a) => mockUpsertTranscript(...a),
    upsertRecording: (...a) => mockUpsertRecording(...a),
}));

const mockPublish = jest.fn();
jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: (...a) => mockPublish(...a),
}));

const svc = require('../backend/src/services/vapiCallTimelineService');

// mockQuery router state (reset per test)
let existingRealRows;   // rows returned by the real-sid existence SELECT
let synthMergeRow;      // row returned by the synth-merge SELECT
let rekeyRaceOnce;      // when true, the first `UPDATE calls SET call_sid` rejects 23505

const dbCall = (needle) => mockQuery.mock.calls.find(([sql]) => String(sql).includes(needle));
const dbCallIndex = (needle) => mockQuery.mock.calls.findIndex(([sql]) => String(sql).includes(needle));

let warnSpy;

beforeEach(() => {
    jest.clearAllMocks();
    existingRealRows = [];
    synthMergeRow = { timeline_id: null, contact_id: null, answered_by: null };
    rekeyRaceOnce = false;

    mockQuery.mockImplementation((sql) => {
        const s = String(sql);
        if (/SELECT call_sid FROM calls/i.test(s)) return Promise.resolve({ rows: existingRealRows });
        if (/SELECT timeline_id, contact_id, answered_by/i.test(s)) {
            return Promise.resolve({ rows: synthMergeRow ? [synthMergeRow] : [] });
        }
        if (/UPDATE calls SET call_sid/i.test(s)) {
            if (rekeyRaceOnce) {
                rekeyRaceOnce = false;
                const e = new Error('duplicate key'); e.code = '23505';
                return Promise.reject(e);
            }
            return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
    });

    mockFindOrCreateTimeline.mockResolvedValue({ id: 71, contact_id: 5 });
    mockUpsertCall.mockImplementation(async (d) => ({ call_sid: d.callSid, ...d }));
    mockGetCallByCallSid.mockImplementation(async (sid, cid) => ({
        call_sid: sid, company_id: cid, status: 'x', is_final: false,
        from_number: '+16175006181', to_number: '+16175550100',
        direction: 'outbound', timeline_id: 71, contact_id: 5, answered_by: 'ai',
    }));
    mockUpsertTranscript.mockResolvedValue({});
    mockUpsertRecording.mockResolvedValue({});

    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => warnSpy.mockRestore());

// =============================================================================
// TC-CT-004 — endedReason → calls.status mapping table
// =============================================================================
describe('mapVapiEndedReasonToCallStatus (TC-CT-004)', () => {
    it.each([
        ['voicemail', 999, 'voicemail_left'],                 // voicemail wins over duration
        ['assistant-detected-voicemail', 0, 'voicemail_left'],
        ['customer-did-not-answer', 12, 'no-answer'],
        ['no-answer', 0, 'no-answer'],
        ['customer-busy', 3, 'busy'],
        ['customer-ended-call', 95, 'completed'],
        ['assistant-ended-call', 40, 'completed'],
        ['assistant-forwarded-call', 30, 'completed'],
        ['customer-declined', 60, 'completed'],               // decline w/ talk-time = completed
        ['twilio-failed-to-connect-call', 0, 'failed'],
        ['customer-declined', 0, 'failed'],                   // decline, zero duration = failed
        ['', 0, 'failed'],
        [null, 0, 'failed'],
        [undefined, 5, 'completed'],                          // unknown reason + duration>0
    ])('reason=%p dur=%p → %s', (reason, dur, expected) => {
        expect(svc.mapVapiEndedReasonToCallStatus(reason, dur)).toBe(expected);
    });

    it('is case-insensitive', () => {
        expect(svc.mapVapiEndedReasonToCallStatus('Voicemail', 0)).toBe('voicemail_left');
        expect(svc.mapVapiEndedReasonToCallStatus('CUSTOMER-BUSY', 0)).toBe('busy');
    });

    it('duration=0 with a talk-implying reason still fails (no fabricated completed)', () => {
        expect(svc.mapVapiEndedReasonToCallStatus('customer-ended-call', 0)).toBe('failed');
    });
});

// =============================================================================
// resolveFinalSid — re-key / merge (TC-CT-006 + S4/S6 no-op)
// =============================================================================
describe('resolveFinalSid re-key/merge (S4)', () => {
    it('no realSid → returns the synthetic sid, touches no rows (S6/TC-CT-011)', async () => {
        const out = await svc.resolveFinalSid({ companyId: 'co-1', syntheticSid: 'vapi:v-1', realSid: null });
        expect(out).toBe('vapi:v-1');
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('accepts phoneCallProviderId as the realSid alias', async () => {
        const out = await svc.resolveFinalSid({ companyId: 'co-1', syntheticSid: 'vapi:v-1', phoneCallProviderId: 'CA1' });
        expect(out).toBe('CA1');
    });

    it('happy re-key: no existing real row → UPDATE call_sid, company-scoped, returns real', async () => {
        existingRealRows = [];
        const out = await svc.resolveFinalSid({ companyId: 'co-1', syntheticSid: 'vapi:v-1', realSid: 'CA1' });
        expect(out).toBe('CA1');
        const rekey = dbCall('UPDATE calls SET call_sid');
        expect(rekey).toBeTruthy();
        expect(rekey[0]).toMatch(/company_id/);
        expect(rekey[1]).toEqual(['CA1', 'vapi:v-1', 'co-1']);
        expect(dbCall('DELETE FROM calls')).toBeFalsy();
    });

    it('merge when a real-sid row already exists (TC-CT-006): COALESCE UPDATE + DELETE synth', async () => {
        existingRealRows = [{ call_sid: 'CA999' }];
        synthMergeRow = { timeline_id: 71, contact_id: 5, answered_by: 'ai' };
        const out = await svc.resolveFinalSid({ companyId: 'co-1', syntheticSid: 'vapi:v-123', realSid: 'CA999' });
        expect(out).toBe('CA999');
        // never renamed via plain UPDATE
        expect(dbCall('UPDATE calls SET call_sid')).toBeFalsy();
        const mergeUpd = dbCall('COALESCE(timeline_id');
        expect(mergeUpd).toBeTruthy();
        expect(mergeUpd[0]).toMatch(/company_id/);
        expect(mergeUpd[1][0]).toBe('CA999');       // update the REAL row
        const del = dbCall('DELETE FROM calls');
        expect(del).toBeTruthy();
        expect(del[1]).toEqual(['vapi:v-123', 'co-1']);  // drop the synthetic
    });

    it('23505 race on the rename → merge branch retried once (TC-CT-006)', async () => {
        existingRealRows = [];        // not present at SELECT time
        rekeyRaceOnce = true;         // …but the rename UPDATE hits a concurrent insert
        synthMergeRow = { timeline_id: 71, contact_id: 5, answered_by: 'ai' };
        const out = await svc.resolveFinalSid({ companyId: 'co-1', syntheticSid: 'vapi:v-123', realSid: 'CA999' });
        expect(out).toBe('CA999');
        expect(dbCall('COALESCE(timeline_id')).toBeTruthy(); // merged after the race
        expect(dbCall('DELETE FROM calls')).toBeTruthy();
    });
});

// =============================================================================
// TC-CT-001 / 019 / 022 / 023 — recordPlacement
// =============================================================================
describe('recordPlacement (S1)', () => {
    const baseAttempt = { company_id: 'co-1', phone: '+16175550100', id: 9, job_id: 42 };

    it('TC-CT-001: creates the synthetic-sid live row + answered_by UPDATE + SSE', async () => {
        await svc.recordPlacement({
            attempt: baseAttempt, vapiCallId: 'v-123',
            dialedNumber: '+16175550100', callerId: '+16175006181',
        });

        expect(mockFindOrCreateTimeline).toHaveBeenCalledWith('+16175550100', 'co-1');
        expect(mockUpsertCall).toHaveBeenCalledWith(expect.objectContaining({
            callSid: 'vapi:v-123', parentCallSid: null, direction: 'outbound',
            status: 'initiated', isFinal: false, timelineId: 71, contactId: 5,
            companyId: 'co-1', fromNumber: '+16175006181', toNumber: '+16175550100',
        }));
        // guarded AI marker
        const marker = dbCall("SET answered_by");
        expect(marker).toBeTruthy();
        expect(marker[0]).toMatch(/answered_by IS NULL/);
        expect(marker[0]).toMatch(/company_id/);
        expect(marker[1]).toEqual(['vapi:v-123', 'co-1', 'ai']);
        // full re-read row over SSE
        expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'call.updated', call_sid: 'vapi:v-123',
        }));
    });

    it('TC-CT-019: company isolation — timeline + upsert + marker all carry attempt company', async () => {
        await svc.recordPlacement({
            attempt: { company_id: 'co-B', phone: '+16175550100' },
            vapiCallId: 'v-9', dialedNumber: '+16175550100', callerId: '+1',
        });
        expect(mockFindOrCreateTimeline).toHaveBeenCalledWith('+16175550100', 'co-B');
        expect(mockUpsertCall.mock.calls[0][0].companyId).toBe('co-B');
        expect(dbCall('SET answered_by')[1]).toEqual(['vapi:v-9', 'co-B', 'ai']);
        // never the default company
        expect(mockFindOrCreateTimeline).not.toHaveBeenCalledWith('+16175550100', '00000000-0000-0000-0000-000000000001');
    });

    it('TC-CT-022: attempt.phone NULL → resolves timeline on the passed dialedNumber (job.customer_phone)', async () => {
        await svc.recordPlacement({
            attempt: { company_id: 'co-1', phone: null },
            vapiCallId: 'v-5', dialedNumber: '+16179999999', callerId: '+1',
        });
        expect(mockFindOrCreateTimeline).toHaveBeenCalledWith('+16179999999', 'co-1');
        expect(mockUpsertCall.mock.calls[0][0].toNumber).toBe('+16179999999');
    });

    it('TC-CT-023: timeline resolution throws → row still created without timeline, SSE still fires', async () => {
        mockFindOrCreateTimeline.mockRejectedValueOnce(new Error('timeline DB down'));
        await svc.recordPlacement({
            attempt: baseAttempt, vapiCallId: 'v-123',
            dialedNumber: '+16175550100', callerId: '+1',
        });
        expect(mockUpsertCall).toHaveBeenCalledWith(expect.objectContaining({
            callSid: 'vapi:v-123', timelineId: null, contactId: null,
        }));
        expect(mockPublish).toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
    });

    it('TC-CT-002: NON-FATAL — upsertCall throws → resolves (no throw), warns, no SSE', async () => {
        mockUpsertCall.mockRejectedValueOnce(new Error('DB down'));
        const out = await svc.recordPlacement({
            attempt: baseAttempt, vapiCallId: 'v-123', dialedNumber: '+16175550100', callerId: '+1',
        });
        expect(out).toBeNull();
        expect(mockPublish).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-fatal'));
    });

    it('missing vapiCallId → warns + returns null, no upsert', async () => {
        const out = await svc.recordPlacement({ attempt: baseAttempt });
        expect(out).toBeNull();
        expect(mockUpsertCall).not.toHaveBeenCalled();
    });
});

// =============================================================================
// TC-CT-011 — applyStatusUpdate
// =============================================================================
describe('applyStatusUpdate (S2 / TC-CT-011)', () => {
    it('in-progress with providerId → re-keys early + upsert(in-progress, answeredAt) on real sid + SSE', async () => {
        await svc.applyStatusUpdate({
            attempt: { company_id: 'co-1' },
            message: { type: 'status-update', status: 'in-progress', call: { id: 'v-123', phoneCallProviderId: 'CA999' } },
        });
        expect(dbCall('UPDATE calls SET call_sid')).toBeTruthy(); // re-key happened
        const up = mockUpsertCall.mock.calls[0][0];
        expect(up.callSid).toBe('CA999');
        expect(up.status).toBe('in-progress');
        expect(up.isFinal).toBe(false);
        expect(up.answeredAt).toBeInstanceOf(Date);
        expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({ call_sid: 'CA999' }));
    });

    it('ringing → maps to ringing (answeredAt null)', async () => {
        await svc.applyStatusUpdate({
            attempt: { company_id: 'co-1' },
            message: { status: 'ringing', call: { id: 'v-123', phoneCallProviderId: 'CA999' } },
        });
        const up = mockUpsertCall.mock.calls[0][0];
        expect(up.status).toBe('ringing');
        expect(up.answeredAt).toBeNull();
    });

    it('status "ended" → NO status upsert (finalize owns the terminal row)', async () => {
        const out = await svc.applyStatusUpdate({
            attempt: { company_id: 'co-1' },
            message: { status: 'ended', call: { id: 'v-123' } },
        });
        expect(mockUpsertCall).not.toHaveBeenCalled();
        expect(out).toBe('vapi:v-123');
    });

    it('no providerId → keeps the synthetic sid on the upsert', async () => {
        await svc.applyStatusUpdate({
            attempt: { company_id: 'co-1' },
            message: { status: 'ringing', call: { id: 'v-123' } },
        });
        expect(dbCall('UPDATE calls SET call_sid')).toBeFalsy(); // no re-key
        expect(mockUpsertCall.mock.calls[0][0].callSid).toBe('vapi:v-123');
    });
});

// =============================================================================
// TC-CT-005 / 007 / 020 / 021 — finalizeFromEndOfCallReport
// =============================================================================
describe('finalizeFromEndOfCallReport (S3)', () => {
    const fullMsg = {
        type: 'end-of-call-report',
        call: { id: 'v-123', phoneCallProviderId: 'CA999' },
        endedReason: 'customer-ended-call',
        startedAt: '2026-07-09T10:00:00.000Z',
        endedAt: '2026-07-09T10:01:35.000Z',
        durationSeconds: 95,
        summary: 'Booked Tue 9-11',
        transcript: 'AI: hello … Customer: yes',
        recordingUrl: 'https://storage.vapi.ai/rec.wav',
    };

    it('TC-CT-005: re-key → final call, transcript(gemini_summary), recording; children ONLY after re-key; SSE last', async () => {
        await svc.finalizeFromEndOfCallReport({ attempt: { company_id: 'co-1' }, message: fullMsg });

        // re-key vapi:v-123 → CA999
        const rekeyIdx = dbCallIndex('UPDATE calls SET call_sid');
        expect(rekeyIdx).toBeGreaterThanOrEqual(0);

        // final calls row on the REAL sid
        expect(mockUpsertCall).toHaveBeenCalledWith(expect.objectContaining({
            callSid: 'CA999', status: 'completed', isFinal: true, durationSec: 95,
            answeredAt: '2026-07-09T10:00:00.000Z', companyId: 'co-1',
        }));

        // transcript: synthetic transcription sid, REAL call sid, summary in raw_payload
        expect(mockUpsertTranscript).toHaveBeenCalledWith(expect.objectContaining({
            transcriptionSid: 'vapi_v-123', callSid: 'CA999', status: 'completed',
            text: 'AI: hello … Customer: yes', companyId: 'co-1',
        }));
        expect(mockUpsertTranscript.mock.calls[0][0].rawPayload.gemini_summary).toBe('Booked Tue 9-11');

        // recording
        expect(mockUpsertRecording).toHaveBeenCalledWith(expect.objectContaining({
            recordingSid: 'vapi_v-123', callSid: 'CA999', source: 'vapi',
            recordingUrl: 'https://storage.vapi.ai/rec.wav', companyId: 'co-1',
        }));

        // ORDER: re-key strictly before both child writes (invariant: no child under an unresolved sid)
        const rekeyOrder = mockQuery.mock.invocationCallOrder[rekeyIdx];
        expect(rekeyOrder).toBeLessThan(mockUpsertTranscript.mock.invocationCallOrder[0]);
        expect(rekeyOrder).toBeLessThan(mockUpsertRecording.mock.invocationCallOrder[0]);
        // no child was ever keyed to the synthetic sid
        expect(mockUpsertTranscript.mock.calls[0][0].callSid.startsWith('vapi:')).toBe(false);
        expect(mockUpsertRecording.mock.calls[0][0].callSid.startsWith('vapi:')).toBe(false);

        // SSE published with the final sid
        expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'call.updated', call_sid: 'CA999',
        }));
    });

    it('TC-CT-007: no phoneCallProviderId → no re-key; everything keyed to the synthetic sid', async () => {
        const msg = { ...fullMsg, call: { id: 'v-123' } }; // no phoneCallProviderId
        const out = await svc.finalizeFromEndOfCallReport({ attempt: { company_id: 'co-1' }, message: msg });
        expect(out).toBe('vapi:v-123');
        expect(dbCall('UPDATE calls SET call_sid')).toBeFalsy(); // never re-keyed
        expect(mockUpsertCall.mock.calls[0][0].callSid).toBe('vapi:v-123');
        expect(mockUpsertTranscript.mock.calls[0][0].callSid).toBe('vapi:v-123');
        expect(mockUpsertRecording.mock.calls[0][0].callSid).toBe('vapi:v-123');
    });

    it('TC-CT-020: no summary/transcript/recording → call still finalizes, no child rows, SSE fires', async () => {
        const msg = {
            type: 'end-of-call-report', call: { id: 'v-123', phoneCallProviderId: 'CA999' },
            endedReason: 'customer-did-not-answer', durationSeconds: 0,
        };
        await svc.finalizeFromEndOfCallReport({ attempt: { company_id: 'co-1' }, message: msg });
        expect(mockUpsertCall).toHaveBeenCalledWith(expect.objectContaining({
            callSid: 'CA999', status: 'no-answer', isFinal: true,
        }));
        expect(mockUpsertTranscript).not.toHaveBeenCalled();
        expect(mockUpsertRecording).not.toHaveBeenCalled();
        expect(mockPublish).toHaveBeenCalled();
    });

    it('TC-CT-021: summary-only (no transcript text) → transcript row with text:null + gemini_summary set; no recording', async () => {
        const msg = {
            type: 'end-of-call-report', call: { id: 'v-123', phoneCallProviderId: 'CA999' },
            endedReason: 'customer-ended-call', durationSeconds: 30, summary: 'Left a message',
        };
        await svc.finalizeFromEndOfCallReport({ attempt: { company_id: 'co-1' }, message: msg });
        const t = mockUpsertTranscript.mock.calls[0][0];
        expect(t.text).toBeNull();
        expect(t.rawPayload.gemini_summary).toBe('Left a message');
        expect(mockUpsertRecording).not.toHaveBeenCalled();
    });

    it('finalize is NON-FATAL — a re-key DB error resolves to null, no child rows written', async () => {
        mockQuery.mockImplementation((sql) => {
            if (/UPDATE calls SET call_sid/i.test(String(sql))) return Promise.reject(new Error('DB down'));
            if (/SELECT call_sid FROM calls/i.test(String(sql))) return Promise.resolve({ rows: [] });
            return Promise.resolve({ rowCount: 1, rows: [] });
        });
        const out = await svc.finalizeFromEndOfCallReport({ attempt: { company_id: 'co-1' }, message: fullMsg });
        expect(out).toBeNull();
        expect(mockUpsertTranscript).not.toHaveBeenCalled(); // never write a child under an unresolved sid
        expect(mockUpsertRecording).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-fatal'));
    });

    it('exposes a `finalize` alias for the same function', () => {
        expect(svc.finalize).toBe(svc.finalizeFromEndOfCallReport);
    });
});

// =============================================================================
// Company scoping — every raw SQL statement carries company_id
// =============================================================================
describe('company scoping in raw SQL', () => {
    it('every db.query across placement + finalize is company-scoped', async () => {
        await svc.recordPlacement({
            attempt: { company_id: 'co-1', phone: '+1' }, vapiCallId: 'v-1', dialedNumber: '+1', callerId: '+2',
        });
        await svc.finalizeFromEndOfCallReport({
            attempt: { company_id: 'co-1' },
            message: { call: { id: 'v-1', phoneCallProviderId: 'CA1' }, endedReason: 'customer-ended-call', durationSeconds: 10 },
        });
        expect(mockQuery.mock.calls.length).toBeGreaterThan(0);
        for (const [sql] of mockQuery.mock.calls) {
            expect(String(sql)).toMatch(/company_id/);
        }
    });
});
