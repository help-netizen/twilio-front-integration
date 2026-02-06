const JWTService = require('../src/services/jwtService');

describe('JWTService', () => {
    let jwtService;
    const mockAppUid = 'test_app_uid_123';
    const mockAppSecret = 'test_app_secret_456';

    beforeEach(() => {
        jwtService = new JWTService(mockAppUid, mockAppSecret);
    });

    describe('constructor', () => {
        test('creates instance with valid credentials', () => {
            expect(jwtService.appUid).toBe(mockAppUid);
            expect(jwtService.appSecret).toBe(mockAppSecret);
        });

        test('throws error without appUid', () => {
            expect(() => new JWTService(null, mockAppSecret)).toThrow('JWTService requires appUid and appSecret');
        });

        test('throws error without appSecret', () => {
            expect(() => new JWTService(mockAppUid, null)).toThrow('JWTService requires appUid and appSecret');
        });
    });

    describe('generateChannelToken', () => {
        test('generates valid JWT token', () => {
            const channelId = 'cha_test123';
            const token = jwtService.generateChannelToken(channelId);

            expect(token).toBeDefined();
            expect(typeof token).toBe('string');
            expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
        });

        test('throws error without channelId', () => {
            expect(() => jwtService.generateChannelToken(null)).toThrow('channelId is required');
        });

        test('token contains correct claims', () => {
            const channelId = 'cha_test123';
            const token = jwtService.generateChannelToken(channelId);
            const decoded = jwtService.verifyToken(token);

            expect(decoded.iss).toBe(mockAppUid);
            expect(decoded.sub).toBe(channelId);
            expect(decoded.jti).toBeDefined();
            expect(decoded.exp).toBeDefined();
            expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
        });

        test('respects custom expiration time', () => {
            const channelId = 'cha_test123';
            const customExpiry = 600; // 10 minutes
            const token = jwtService.generateChannelToken(channelId, customExpiry);
            const decoded = jwtService.verifyToken(token);

            const expectedExpTime = Math.floor(Date.now() / 1000) + customExpiry;
            expect(decoded.exp).toBeGreaterThanOrEqual(expectedExpTime - 2); // Allow 2s tolerance
            expect(decoded.exp).toBeLessThanOrEqual(expectedExpTime + 2);
        });

        test('each token has unique jti', () => {
            const channelId = 'cha_test123';
            const token1 = jwtService.generateChannelToken(channelId);
            const token2 = jwtService.generateChannelToken(channelId);

            const decoded1 = jwtService.verifyToken(token1);
            const decoded2 = jwtService.verifyToken(token2);

            expect(decoded1.jti).not.toBe(decoded2.jti);
        });
    });

    describe('verifyToken', () => {
        test('verifies valid token', () => {
            const channelId = 'cha_test123';
            const token = jwtService.generateChannelToken(channelId);
            const decoded = jwtService.verifyToken(token);

            expect(decoded).toBeDefined();
            expect(decoded.sub).toBe(channelId);
        });

        test('throws error for invalid token', () => {
            const invalidToken = 'invalid.jwt.token';
            expect(() => jwtService.verifyToken(invalidToken)).toThrow('Invalid token');
        });

        test('throws error for token with wrong secret', () => {
            const otherService = new JWTService(mockAppUid, 'different_secret');
            const token = otherService.generateChannelToken('cha_test123');

            expect(() => jwtService.verifyToken(token)).toThrow('Invalid token');
        });
    });
});
