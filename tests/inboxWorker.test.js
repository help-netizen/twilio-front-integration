// db/connection must be mocked at MODULE scope: a jest.mock() inside beforeEach
// never applies, because inboxWorker below is required (and captures the real db
// handle) before any hook runs. `mockDbQuery` carries the `mock` prefix so the
// factory is allowed to close over it.
const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));
const mockResolveCompanyByAccountSid = jest.fn();
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    resolveCompanyByAccountSid: (...args) => mockResolveCompanyByAccountSid(...args),
}));

const {
    normalizeVoiceEvent,
    normalizeRecordingEvent,
    isFinalStatus,
    processEvent
} = require('../backend/src/services/inboxWorker');

describe('Inbox Worker', () => {
    describe('normalizeVoiceEvent', () => {
        it('should normalize Twilio voice webhook payload', () => {
            const payload = {
                CallSid: 'CA1234567890abcdef',
                CallStatus: 'completed',
                Timestamp: '1675000000',
                From: '+15551234567',
                To: '+15559876543',
                Direction: 'outbound-api',
                Duration: '120',
                ParentCallSid: 'CA0987654321fedcba',
                AnsweredBy: 'human',
                QueueTime: '5',
                Price: '-0.0200',
                PriceUnit: 'USD'
            };

            const normalized = normalizeVoiceEvent(payload);

            expect(normalized).toMatchObject({
                callSid: 'CA1234567890abcdef',
                eventType: 'call.status_changed',
                eventStatus: 'completed',
                fromNumber: '+15551234567',
                toNumber: '+15559876543',
                // Twilio's 'outbound-api' is normalized to the internal 'outbound'
                direction: 'outbound',
                durationSec: 120,
                parentCallSid: 'CA0987654321fedcba'
            });

            expect(normalized.eventTime).toBeInstanceOf(Date);
            expect(normalized.metadata.answered_by).toBe('human');
            expect(normalized.metadata.queue_time).toBe('5');
            // price is parsed out of Twilio's string into a real number
            expect(normalized.price).toBe(-0.02);
            expect(normalized.priceUnit).toBe('USD');
        });

        it('should handle missing optional fields', () => {
            const payload = {
                CallSid: 'CA123',
                CallStatus: 'ringing',
                Timestamp: '1675000000',
                From: '+15551234567',
                To: '+15559876543'
            };

            const normalized = normalizeVoiceEvent(payload);

            expect(normalized.direction).toBe('external');
            expect(normalized.durationSec).toBe(0);
            expect(normalized.parentCallSid).toBeNull();
        });
    });

    describe('normalizeRecordingEvent', () => {
        it('should normalize Twilio recording webhook payload', () => {
            const payload = {
                RecordingSid: 'RE1234567890abcdef',
                CallSid: 'CA1234567890abcdef',
                RecordingStatus: 'completed',
                RecordingDuration: '120',
                RecordingUrl: 'https://api.twilio.com/recordings/RE123',
                Timestamp: '1675000000'
            };

            const normalized = normalizeRecordingEvent(payload);

            expect(normalized).toMatchObject({
                callSid: 'CA1234567890abcdef',
                recordingSid: 'RE1234567890abcdef',
                status: 'completed'
            });

            expect(normalized.eventTime).toBeInstanceOf(Date);
            expect(normalized.recordingUrl).toBe('https://api.twilio.com/recordings/RE123');
            // duration is parsed into a number, no longer a raw Twilio string
            expect(normalized.durationSec).toBe(120);
        });
    });

    describe('isFinalStatus', () => {
        it('should return true for final statuses', () => {
            expect(isFinalStatus('completed')).toBe(true);
            expect(isFinalStatus('busy')).toBe(true);
            expect(isFinalStatus('no-answer')).toBe(true);
            expect(isFinalStatus('canceled')).toBe(true);
            expect(isFinalStatus('failed')).toBe(true);
            expect(isFinalStatus('COMPLETED')).toBe(true); // Case insensitive
        });

        it('should return false for non-final statuses', () => {
            expect(isFinalStatus('queued')).toBe(false);
            expect(isFinalStatus('ringing')).toBe(false);
            expect(isFinalStatus('in-progress')).toBe(false);
            expect(isFinalStatus('initiated')).toBe(false);
        });
    });

    // NOTE: the `upsertMessage` suite was removed here, not repaired. That helper
    // ceased to exist in the v3 calls-first migration (0a6c7d0); inboxWorker now
    // persists through `queries.upsertCall`, which owns its own coverage. The two
    // tests asserted against an undefined import, so there was nothing left to assert.

    describe('processEvent', () => {
        let mockDb;

        beforeEach(() => {
            mockDbQuery.mockReset();
            mockDbQuery.mockResolvedValue({ rows: [{ id: 1 }] });
            mockResolveCompanyByAccountSid.mockReset();
            mockResolveCompanyByAccountSid.mockResolvedValue('00000000-0000-0000-0000-00000000000a');
            mockDb = { query: mockDbQuery };
        });

        it('should process voice event successfully', async () => {
            const inboxEvent = {
                id: 123,
                source: 'voice',
                event_type: 'call-status',
                payload: {
                    AccountSid: 'AC-company-a',
                    CallSid: 'CA123',
                    CallStatus: 'completed',
                    Timestamp: '1675000000',
                    From: '+15551234567',
                    To: '+15559876543',
                    Duration: '120'
                }
            };

            const result = await processEvent(inboxEvent);

            expect(result.success).toBe(true);
            expect(mockResolveCompanyByAccountSid).toHaveBeenCalledWith('AC-company-a');
            expect(mockDb.query).toHaveBeenCalled();
        });

        it('T-foreign/T-blast: unmapped AccountSid is quarantined before any write', async () => {
            mockResolveCompanyByAccountSid.mockResolvedValue(null);
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const foreignBefore = { company_id: '00000000-0000-0000-0000-00000000000b', calls: 3 };
            const inboxEvent = {
                id: 124,
                source: 'voice',
                event_type: 'call-status',
                payload: {
                    AccountSid: 'AC-unmapped',
                    CallSid: 'CA-foreign',
                    CallStatus: 'ringing',
                    From: '+15551234567',
                    To: '+15559876543',
                },
            };

            await expect(processEvent(inboxEvent)).rejects.toMatchObject({
                code: 'TWILIO_TENANT_UNRESOLVED',
            });
            expect(mockDb.query).not.toHaveBeenCalled();
            expect(foreignBefore).toEqual({
                company_id: '00000000-0000-0000-0000-00000000000b',
                calls: 3,
            });
            const securityPayload = warn.mock.calls.find(([label]) => label === '[TwilioSecurity]')?.[1];
            expect(securityPayload).toMatchObject({
                event: 'twilio.tenant_unresolved',
                surface: 'inbox_worker',
                reason: 'unbound_account_sid',
                metric: 'twilio_tenant_unresolved_total',
            });
            expect(JSON.stringify(warn.mock.calls)).not.toContain('AC-unmapped');
            warn.mockRestore();
        });

        it('lookup failure retries instead of writing to the default company', async () => {
            mockResolveCompanyByAccountSid.mockRejectedValue(new Error('telephony binding DB unavailable'));
            const inboxEvent = {
                id: 125,
                source: 'voice',
                event_type: 'call-status',
                payload: {
                    AccountSid: 'AC-company-a',
                    CallSid: 'CA-retry',
                    CallStatus: 'ringing',
                    From: '+15551234567',
                    To: '+15559876543',
                },
            };

            await expect(processEvent(inboxEvent)).rejects.toMatchObject({
                code: 'TWILIO_TENANT_UNRESOLVED',
            });
            expect(mockDb.query).not.toHaveBeenCalled();
        });

        it('T-own transcription: resolves AccountSid and tenant-pairs every write', async () => {
            const companyId = '00000000-0000-0000-0000-00000000000a';
            mockResolveCompanyByAccountSid.mockResolvedValue(companyId);
            mockDbQuery
                .mockResolvedValueOnce({ rows: [{ transcription_sid: 'TR-shared', status: 'completed' }] })
                .mockResolvedValueOnce({ rows: [{ id: 99 }] });

            await expect(processEvent({
                id: 126,
                source: 'transcription',
                event_type: 'transcript.updated',
                payload: {
                    AccountSid: 'AC-company-a',
                    CallSid: 'CA-shared',
                    RecordingSid: 'RE-shared',
                    TranscriptionSid: 'TR-shared',
                    TranscriptionStatus: 'completed',
                    TranscriptionText: 'tenant A text',
                },
            })).resolves.toEqual({ success: true });

            expect(mockResolveCompanyByAccountSid).toHaveBeenCalledWith('AC-company-a');
            expect(mockDbQuery.mock.calls[0][0])
                .toContain('ON CONFLICT (company_id, transcription_sid)');
            expect(mockDbQuery.mock.calls[0][1][11]).toBe(companyId);
            expect(mockDbQuery.mock.calls[1][0]).toContain('INSERT INTO call_events');
            expect(mockDbQuery.mock.calls[1][1][5]).toBe(companyId);
        });

        it('SAB-TW-RESOLUTION T-blast: same transcript SID stays isolated by resolved company', async () => {
            const companyA = '00000000-0000-0000-0000-000000000001';
            const companyB = '00000000-0000-0000-0000-00000000000b';
            const rows = new Map();
            mockResolveCompanyByAccountSid.mockImplementation(async accountSid => (
                accountSid === 'AC-master' ? companyA : companyB
            ));
            mockDbQuery.mockImplementation(async (sql, params) => {
                if (String(sql).includes('INSERT INTO transcripts')) {
                    const key = `${params[11]}:${params[0]}`;
                    const row = {
                        company_id: params[11],
                        transcription_sid: params[0],
                        call_sid: params[1],
                        status: params[4],
                        text: params[7],
                    };
                    rows.set(key, row);
                    return { rows: [row] };
                }
                return { rows: [{ id: 1 }] };
            });

            const event = (accountSid, text) => ({
                id: text === 'master' ? 127 : 128,
                source: 'transcription',
                event_type: 'transcript.updated',
                payload: {
                    AccountSid: accountSid,
                    CallSid: 'CA-collision',
                    TranscriptionSid: 'TR-collision',
                    TranscriptionStatus: 'completed',
                    TranscriptionText: text,
                },
            });

            await processEvent(event('AC-master', 'master'));
            const beforeMaster = JSON.stringify(rows.get(`${companyA}:TR-collision`));
            await processEvent(event('AC-sub-b', 'tenant B'));

            expect(JSON.stringify(rows.get(`${companyA}:TR-collision`))).toBe(beforeMaster);
            expect(rows.get(`${companyB}:TR-collision`)).toMatchObject({
                company_id: companyB,
                text: 'tenant B',
            });
        });

        it('T-foreign transcription: unmapped AccountSid writes nothing', async () => {
            mockResolveCompanyByAccountSid.mockResolvedValue(null);
            await expect(processEvent({
                id: 129,
                source: 'transcription',
                event_type: 'transcript.updated',
                payload: {
                    AccountSid: 'AC-foreign',
                    CallSid: 'CA-collision',
                    TranscriptionSid: 'TR-collision',
                    TranscriptionStatus: 'completed',
                },
            })).rejects.toMatchObject({ code: 'TWILIO_TENANT_UNRESOLVED' });
            expect(mockDbQuery).not.toHaveBeenCalled();
        });

        it('should handle unknown event source', async () => {
            const inboxEvent = {
                id: 123,
                source: 'unknown_source',
                event_type: 'unknown',
                payload: {}
            };

            await expect(processEvent(inboxEvent)).rejects.toThrow(/^Unknown source: unknown_source$/);
        });
    });
});
