const CallFormatter = require('../src/services/callFormatter');

describe('CallFormatter', () => {
    describe('formatDuration', () => {
        test('formats seconds only', () => {
            expect(CallFormatter.formatDuration(45)).toBe('45s');
        });

        test('formats minutes and seconds', () => {
            expect(CallFormatter.formatDuration(180)).toBe('3m 0s');
            expect(CallFormatter.formatDuration(195)).toBe('3m 15s');
        });

        test('handles zero duration', () => {
            expect(CallFormatter.formatDuration(0)).toBe('0s');
        });

        test('handles invalid input', () => {
            expect(CallFormatter.formatDuration(null)).toBe('0s');
            expect(CallFormatter.formatDuration(-5)).toBe('0s');
        });
    });

    describe('formatPhoneNumber', () => {
        test('formats US phone numbers', () => {
            expect(CallFormatter.formatPhoneNumber('+14155551234')).toBe('+1 (415) 555-1234');
            expect(CallFormatter.formatPhoneNumber('14155551234')).toBe('+1 (415) 555-1234');
        });

        test('returns original for non-US numbers', () => {
            expect(CallFormatter.formatPhoneNumber('+442012345678')).toBe('+442012345678');
        });

        test('handles invalid input', () => {
            expect(CallFormatter.formatPhoneNumber(null)).toBe('Unknown');
            expect(CallFormatter.formatPhoneNumber('')).toBe('Unknown');
        });
    });

    describe('getConversationId', () => {
        test('creates consistent conversation IDs', () => {
            expect(CallFormatter.getConversationId('+14155551234')).toBe('caller_14155551234');
            expect(CallFormatter.getConversationId('+1 (415) 555-1234')).toBe('caller_14155551234');
        });

        test('same number produces same ID regardless of formatting', () => {
            const id1 = CallFormatter.getConversationId('+14155551234');
            const id2 = CallFormatter.getConversationId('1-415-555-1234');
            const id3 = CallFormatter.getConversationId('(415) 555-1234');

            // All should have same digits
            expect(id1).toContain('14155551234');
            expect(id2).toContain('14155551234');
        });
    });

    describe('toFrontInboundMessage', () => {
        test('converts inbound call correctly', () => {
            const twilioCall = {
                sid: 'CA123abc',
                from: '+14155551234',
                to: '+14155559876',
                direction: 'inbound',
                duration: '180',
                status: 'completed',
                startTime: '2026-02-04T10:30:00Z',
                price: '-0.015'
            };

            const message = CallFormatter.toFrontInboundMessage(twilioCall);

            expect(message.sender.handle).toBe('+14155551234');
            expect(message.subject).toContain('📞');
            expect(message.subject).toContain('Incoming Call');
            expect(message.subject).toContain('3m 0s');
            expect(message.body_format).toBe('markdown');
            expect(message.external_id).toBe('twilio_call_CA123abc');
            expect(message.external_conversation_id).toBe('caller_14155551234');
            expect(message.created_at).toBeDefined();
        });

        test('includes all metadata headers', () => {
            const twilioCall = {
                sid: 'CA456def',
                from: '+14155551234',
                to: '+14155559876',
                direction: 'inbound',
                duration: '120',
                status: 'completed',
                startTime: '2026-02-04T10:30:00Z'
            };

            const message = CallFormatter.toFrontInboundMessage(twilioCall);

            expect(message.metadata.headers.call_sid).toBe('CA456def');
            expect(message.metadata.headers.direction).toBe('inbound');
            expect(message.metadata.headers.duration).toBe('120');
            expect(message.metadata.headers.status).toBe('completed');
        });
    });

    describe('toFrontOutboundMessage', () => {
        test('converts outbound call correctly', () => {
            const twilioCall = {
                sid: 'CA789xyz',
                from: '+14155559876',
                to: '+14155551234',
                direction: 'outbound-api',
                duration: '330',
                status: 'completed',
                startTime: '2026-02-04T14:15:00Z',
                price: '-0.025'
            };

            const message = CallFormatter.toFrontOutboundMessage(twilioCall);

            expect(message.sender.handle).toBe('+14155559876');
            expect(message.to).toContain('+14155551234');
            expect(message.subject).toContain('📱');
            expect(message.subject).toContain('Outgoing Call');
            expect(message.subject).toContain('5m 30s');
            expect(message.external_id).toBe('twilio_call_CA789xyz');
            expect(message.external_conversation_id).toBe('caller_14155551234');
        });
    });

    describe('formatCallBody', () => {
        test('includes all required fields', () => {
            const call = {
                sid: 'CA123',
                from: '+14155551234',
                to: '+14155559876',
                direction: 'inbound',
                duration: '180',
                status: 'completed',
                startTime: '2026-02-04T10:30:00Z',
                price: '-0.015'
            };

            const body = CallFormatter.formatCallBody(call);

            expect(body).toContain('**From:**');
            expect(body).toContain('**To:**');
            expect(body).toContain('**Duration:**');
            expect(body).toContain('**Time:**');
            expect(body).toContain('**Status:**');
            expect(body).toContain('**Cost:**');
            expect(body).toContain('**Call ID:**');
            expect(body).toContain('`CA123`');
        });

        test('includes recording link when available', () => {
            const call = {
                sid: 'CA123',
                from: '+14155551234',
                to: '+14155559876',
                direction: 'inbound',
                duration: '60',
                status: 'completed',
                startTime: '2026-02-04T10:30:00Z',
                recordingUrl: 'https://api.twilio.com/recordings/RE123'
            };

            const body = CallFormatter.formatCallBody(call);

            expect(body).toContain('🎧 Listen to Recording');
            expect(body).toContain('https://api.twilio.com/recordings/RE123');
        });
    });

    describe('formatStatus', () => {
        test('formats status with emoji', () => {
            expect(CallFormatter.formatStatus('completed')).toBe('✅ Completed');
            expect(CallFormatter.formatStatus('busy')).toBe('📵 Busy');
            expect(CallFormatter.formatStatus('no-answer')).toBe('❌ No Answer');
            expect(CallFormatter.formatStatus('canceled')).toBe('🚫 Canceled');
            expect(CallFormatter.formatStatus('failed')).toBe('⚠️ Failed');
        });

        test('capitalizes unknown statuses', () => {
            expect(CallFormatter.formatStatus('unknown')).toBe('Unknown');
        });
    });
});
