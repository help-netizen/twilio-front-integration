const {
    normalizeVoiceEvent,
    normalizeRecordingEvent,
    isFinalStatus,
    upsertMessage,
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
                call_sid: 'CA1234567890abcdef',
                event_type: 'call.status_changed',
                event_status: 'completed',
                from_number: '+15551234567',
                to_number: '+15559876543',
                direction: 'outbound-api',
                duration: 120,
                parent_call_sid: 'CA0987654321fedcba'
            });

            expect(normalized.event_time).toBeInstanceOf(Date);
            expect(normalized.metadata.answered_by).toBe('human');
            expect(normalized.metadata.queue_time).toBe('5');
            expect(normalized.metadata.price).toBe('-0.0200');
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
            expect(normalized.duration).toBe(0);
            expect(normalized.parent_call_sid).toBeNull();
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
                call_sid: 'CA1234567890abcdef',
                event_type: 'recording.status_changed',
                event_status: 'completed'
            });

            expect(normalized.metadata.recording_sid).toBe('RE1234567890abcdef');
            expect(normalized.metadata.recording_duration).toBe('120');
            expect(normalized.metadata.recording_url).toBe('https://api.twilio.com/recordings/RE123');
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

    describe('upsertMessage', () => {
        let mockDb;

        beforeEach(() => {
            mockDb = {
                query: jest.fn()
            };
            // Mock the db module
            jest.mock('../src/db/connection', () => mockDb);
        });

        afterEach(() => {
            jest.clearAllMocks();
        });

        it('should insert new message', async () => {
            const normalized = {
                call_sid: 'CA123',
                event_status: 'ringing',
                event_time: new Date(),
                from_number: '+15551234567',
                to_number: '+15559876543',
                direction: 'outbound-api',
                duration: 0,
                parent_call_sid: null,
                metadata: {}
            };

            mockDb.query.mockResolvedValue({
                rows: [{ id: 1, twilio_sid: 'CA123', status: 'ringing' }]
            });

            const result = await upsertMessage(normalized);

            expect(result.id).toBe(1);
            expect(mockDb.query).toHaveBeenCalled();

            // Verify SQL includes last_event_time guard
            const sql = mockDb.query.mock.calls[0][0];
            expect(sql).toContain('last_event_time');
            expect(sql).toContain('ON CONFLICT');
        });

        it('should set is_final for completed status', async () => {
            const normalized = {
                call_sid: 'CA123',
                event_status: 'completed',
                event_time: new Date(),
                from_number: '+15551234567',
                to_number: '+15559876543',
                direction: 'outbound-api',
                duration: 120,
                parent_call_sid: null,
                metadata: {}
            };

            mockDb.query.mockResolvedValue({
                rows: [{ id: 1, twilio_sid: 'CA123', status: 'completed' }]
            });

            await upsertMessage(normalized);

            // Verify is_final parameter is true
            const params = mockDb.query.mock.calls[0][1];
            expect(params[10]).toBe(true); // is_final parameter
        });
    });

    describe('processEvent', () => {
        let mockDb;

        beforeEach(() => {
            mockDb = {
                query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] })
            };
            jest.mock('../src/db/connection', () => mockDb);
        });

        it('should process voice event successfully', async () => {
            const inboxEvent = {
                id: 123,
                source: 'twilio_voice',
                event_type: 'call-status',
                payload: {
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
            expect(mockDb.query).toHaveBeenCalled();
        });

        it('should handle unknown event source', async () => {
            const inboxEvent = {
                id: 123,
                source: 'unknown_source',
                event_type: 'unknown',
                payload: {}
            };

            await expect(processEvent(inboxEvent)).rejects.toThrow('Unknown event source');
        });
    });
});
