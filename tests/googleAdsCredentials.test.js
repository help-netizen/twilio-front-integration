'use strict';

const {
    decryptRefreshToken,
    encryptRefreshToken,
    normalizeCustomerId,
    redactForLog,
    serializeConnectionStatus,
} = require('../backend/src/services/googleAdsCredentials');

const ENV_KEY = 'GOOGLE_ADS_TOKEN_ENCRYPTION_KEY';
const REFRESH_TOKEN = 'refresh-token-must-never-leak';

let savedKey;

beforeEach(() => {
    savedKey = process.env[ENV_KEY];
    process.env[ENV_KEY] = 'a'.repeat(64);
});

afterEach(() => {
    if (savedKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedKey;
});

describe('Google Ads credential boundary', () => {
    test('AES-256-GCM v1 envelope round-trips without plaintext storage', () => {
        const encrypted = encryptRefreshToken(REFRESH_TOKEN);

        expect(encrypted).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
        expect(encrypted).not.toContain(REFRESH_TOKEN);
        expect(decryptRefreshToken(encrypted)).toBe(REFRESH_TOKEN);
    });

    test('missing encryption key fails closed for encrypt and decrypt', () => {
        const encrypted = encryptRefreshToken(REFRESH_TOKEN);
        delete process.env[ENV_KEY];

        expect(() => encryptRefreshToken(REFRESH_TOKEN)).toThrow(
            expect.objectContaining({ code: 'GOOGLE_ADS_ENCRYPTION_KEY_MISSING' })
        );
        expect(() => decryptRefreshToken(encrypted)).toThrow(
            expect.objectContaining({ code: 'GOOGLE_ADS_ENCRYPTION_KEY_MISSING' })
        );
    });

    test('status serializer exposes last four only and omits token/ciphertext/customer id', () => {
        const response = serializeConnectionStatus({
            id: 'connection-private',
            company_id: 'company-private',
            customer_id: '1234567890',
            refresh_token_encrypted: `v1:iv:tag:${REFRESH_TOKEN}`,
            status: 'connected',
            currency_code: 'USD',
            account_timezone: 'America/New_York',
            synced_from_date: '2024-07-27',
            synced_through_date: '2026-07-27',
            last_sync_status: 'ok',
            last_synced_at: '2026-07-27T12:00:00.000Z',
            last_error_code: null,
            last_error: REFRESH_TOKEN,
        });

        expect(response).toEqual({
            connected: true,
            status: 'connected',
            customer_id_masked: '7890',
            currency_code: 'USD',
            account_timezone: 'America/New_York',
            synced_from_date: '2024-07-27',
            synced_through_date: '2026-07-27',
            last_sync_status: 'ok',
            last_synced_at: '2026-07-27T12:00:00.000Z',
            last_error_code: null,
        });
        const serialized = JSON.stringify(response);
        expect(serialized).not.toContain('1234567890');
        expect(serialized).not.toContain(REFRESH_TOKEN);
        expect(serialized).not.toMatch(/encrypted|ciphertext|refresh_token/i);
    });

    test('log redaction covers headers, form bodies, customer ids, and nested secrets', () => {
        const redacted = redactForLog({
            headers: {
                Authorization: 'Bearer access-token-private',
                'developer-token': 'developer-private',
            },
            form: 'client_secret=client-private&refresh_token=refresh-private',
            url: 'https://googleads.googleapis.com/v23/customers/1234567890/googleAds:search',
            customerId: '1234567890',
            nested: { ciphertext: 'cipher-private' },
        });
        const serialized = JSON.stringify(redacted);

        for (const forbidden of [
            'access-token-private',
            'developer-private',
            'client-private',
            'refresh-private',
            '1234567890',
            'cipher-private',
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    test('customer ids are normalized to digits and malformed values are rejected', () => {
        expect(normalizeCustomerId('123-456-7890')).toBe('1234567890');
        expect(normalizeCustomerId(' 123 456 7890 ')).toBe('1234567890');
        expect(() => normalizeCustomerId('123abc')).toThrow(
            expect.objectContaining({ code: 'GOOGLE_ADS_CUSTOMER_ID_INVALID' })
        );
    });
});
