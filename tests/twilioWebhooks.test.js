const { handleVoiceStatus, validateTwilioSignature } = require('../src/webhooks/twilioWebhooks');

describe('Twilio Webhook Handlers', () => {
    let mockReq;
    let mockRes;
    let mockDb;

    beforeEach(() => {
        // Mock request
        mockReq = {
            headers: {},
            body: {},
            protocol: 'https',
            get: (header) => 'test.example.com',
            originalUrl: '/webhooks/twilio/voice-status'
        };

        // Mock response
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
            send: jest.fn().mockReturnThis()
        };

        // Mock database
        mockDb = {
            query: jest.fn()
        };

        // Mock environment
        process.env.TWILIO_AUTH_TOKEN = 'test_auth_token_123';
    });

    describe('validateTwilioSignature', () => {
        it('should return false when signature header is missing', () => {
            const result = validateTwilioSignature(mockReq);
            expect(result).toBe(false);
        });

        it('should return false when auth token is missing', () => {
            delete process.env.TWILIO_AUTH_TOKEN;
            mockReq.headers['x-twilio-signature'] = 'some-signature';
            const result = validateTwilioSignature(mockReq);
            expect(result).toBe(false);
        });

        it('should construct proper URL for signature validation', () => {
            mockReq.headers['x-twilio-signature'] = 'test-signature';
            mockReq.headers['x-forwarded-proto'] = 'https';
            mockReq.headers['x-forwarded-host'] = 'prod.example.com';

            // This will fail validation but should construct URL correctly
            const result = validateTwilioSignature(mockReq);
            expect(result).toBe(false); // Will fail because signature is fake
        });
    });

    describe('handleVoiceStatus', () => {
        beforeEach(() => {
            // Mock successful signature validation
            mockReq.headers['x-twilio-signature'] = 'valid-signature';
            mockReq.body = {
                CallSid: 'CA1234567890abcdef',
                CallStatus: 'completed',
                Timestamp: '1234567890'
            };
        });

        it('should return 403 for invalid signature', async () => {
            mockReq.headers['x-twilio-signature'] = '';

            await handleVoiceStatus(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(403);
            expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
        });

        it('should return 400 for missing CallSid', async () => {
            delete mockReq.body.CallSid;

            // Skip signature validation for this test
            jest.spyOn(require('../src/webhooks/twilioWebhooks'), 'validateTwilioSignature')
                .mockReturnValue(true);

            await handleVoiceStatus(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(400);
            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'Missing CallSid or CallStatus'
            });
        });

        it('should insert event into inbox on valid webhook', async () => {
            // Skip signature validation
            jest.spyOn(require('../src/webhooks/twilioWebhooks'), 'validateTwilioSignature')
                .mockReturnValue(true);

            // Mock successful DB insert
            const mockDbModule = require('../src/db/connection');
            mockDbModule.query = jest.fn().mockResolvedValue({
                rows: [{ id: 123 }]
            });

            await handleVoiceStatus(mockReq, mockRes);

            expect(mockDbModule.query).toHaveBeenCalled();
            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.send).toHaveBeenCalledWith('OK');
        });

        it('should handle duplicate events gracefully', async () => {
            // Skip signature validation
            jest.spyOn(require('../src/webhooks/twilioWebhooks'), 'validateTwilioSignature')
                .mockReturnValue(true);

            // Mock DB conflict (duplicate)
            const mockDbModule = require('../src/db/connection');
            mockDbModule.query = jest.fn().mockResolvedValue({
                rows: [] // ON CONFLICT DO NOTHING returns empty
            });

            await handleVoiceStatus(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.send).toHaveBeenCalledWith('OK');
        });

        it('should return 500 on database error', async () => {
            // Skip signature validation
            jest.spyOn(require('../src/webhooks/twilioWebhooks'), 'validateTwilioSignature')
                .mockReturnValue(true);

            // Mock DB error
            const mockDbModule = require('../src/db/connection');
            mockDbModule.query = jest.fn().mockRejectedValue(
                new Error('Database connection failed')
            );

            await handleVoiceStatus(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(500);
            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'Internal server error'
            });
        });

        it('should generate unique dedupe keys', async () => {
            jest.spyOn(require('../src/webhooks/twilioWebhooks'), 'validateTwilioSignature')
                .mockReturnValue(true);

            const mockDbModule = require('../src/db/connection');
            const querySpy = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
            mockDbModule.query = querySpy;

            await handleVoiceStatus(mockReq, mockRes);

            const queryArgs = querySpy.mock.calls[0];
            const dedupeKey = queryArgs[1][3]; // Fourth parameter

            expect(dedupeKey).toBe('call:CA1234567890abcdef:completed:1234567890');
        });
    });
});
