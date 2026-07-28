'use strict';

const crypto = require('crypto');

const ENVELOPE_VERSION = 'v1';
const SENSITIVE_KEY = /(authorization|token|secret|cipher|customer.?id)/i;

class GoogleAdsCredentialsError extends Error {
    constructor(message, code = 'GOOGLE_ADS_CREDENTIALS_INVALID') {
        super(message);
        this.name = 'GoogleAdsCredentialsError';
        this.code = code;
    }
}

function getEncryptionKey() {
    const value = process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY;
    if (!value) {
        throw new GoogleAdsCredentialsError(
            'GOOGLE_ADS_TOKEN_ENCRYPTION_KEY is not configured.',
            'GOOGLE_ADS_ENCRYPTION_KEY_MISSING'
        );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(value)) {
        throw new GoogleAdsCredentialsError(
            'GOOGLE_ADS_TOKEN_ENCRYPTION_KEY must be exactly 32 bytes encoded as hex.',
            'GOOGLE_ADS_ENCRYPTION_KEY_INVALID'
        );
    }
    return Buffer.from(value, 'hex');
}

function encryptRefreshToken(plaintext) {
    if (typeof plaintext !== 'string' || !plaintext) {
        throw new GoogleAdsCredentialsError(
            'A Google Ads refresh token is required.',
            'GOOGLE_ADS_REFRESH_TOKEN_REQUIRED'
        );
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    return [
        ENVELOPE_VERSION,
        iv.toString('hex'),
        cipher.getAuthTag().toString('hex'),
        ciphertext.toString('hex'),
    ].join(':');
}

function decryptRefreshToken(envelope) {
    if (typeof envelope !== 'string') {
        throw new GoogleAdsCredentialsError(
            'Google Ads token envelope is invalid.',
            'GOOGLE_ADS_TOKEN_ENVELOPE_INVALID'
        );
    }
    const [version, ivHex, tagHex, ciphertextHex, ...extra] = envelope.split(':');
    if (version !== ENVELOPE_VERSION
        || !/^[0-9a-f]{24}$/i.test(ivHex || '')
        || !/^[0-9a-f]{32}$/i.test(tagHex || '')
        || !/^[0-9a-f]+$/i.test(ciphertextHex || '')
        || ciphertextHex.length % 2 !== 0
        || extra.length > 0) {
        throw new GoogleAdsCredentialsError(
            'Google Ads token envelope is invalid.',
            'GOOGLE_ADS_TOKEN_ENVELOPE_INVALID'
        );
    }

    try {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            getEncryptionKey(),
            Buffer.from(ivHex, 'hex')
        );
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        return Buffer.concat([
            decipher.update(Buffer.from(ciphertextHex, 'hex')),
            decipher.final(),
        ]).toString('utf8');
    } catch (error) {
        if (error instanceof GoogleAdsCredentialsError
            && error.code.startsWith('GOOGLE_ADS_ENCRYPTION_KEY_')) {
            throw error;
        }
        throw new GoogleAdsCredentialsError(
            'Google Ads token envelope could not be decrypted.',
            'GOOGLE_ADS_TOKEN_DECRYPT_FAILED'
        );
    }
}

function normalizeCustomerId(value) {
    if (typeof value !== 'string') {
        throw new GoogleAdsCredentialsError(
            'Google Ads customer id is required.',
            'GOOGLE_ADS_CUSTOMER_ID_INVALID'
        );
    }
    const trimmed = value.trim();
    if (!trimmed || !/^[0-9 -]+$/.test(trimmed)) {
        throw new GoogleAdsCredentialsError(
            'Google Ads customer id must contain only digits, spaces, or hyphens.',
            'GOOGLE_ADS_CUSTOMER_ID_INVALID'
        );
    }
    const normalized = trimmed.replace(/[^0-9]/g, '');
    if (!normalized) {
        throw new GoogleAdsCredentialsError(
            'Google Ads customer id is required.',
            'GOOGLE_ADS_CUSTOMER_ID_INVALID'
        );
    }
    return normalized;
}

function serializeConnectionStatus(row) {
    if (!row) {
        return {
            connected: false,
            status: 'disconnected',
            customer_id_masked: null,
            currency_code: null,
            account_timezone: null,
            synced_from_date: null,
            synced_through_date: null,
            last_sync_status: null,
            last_synced_at: null,
            last_error_code: null,
        };
    }
    return {
        connected: row.status === 'connected',
        status: row.status,
        customer_id_masked: row.customer_id
            ? String(row.customer_id).slice(-4)
            : null,
        currency_code: row.currency_code || null,
        account_timezone: row.account_timezone || null,
        synced_from_date: row.synced_from_date || null,
        synced_through_date: row.synced_through_date || null,
        last_sync_status: row.last_sync_status || null,
        last_synced_at: row.last_synced_at || null,
        last_error_code: row.last_error_code || null,
    };
}

function redactString(value) {
    return value
        .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
        .replace(/((?:refresh_token|client_secret)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/(customers\/)[0-9]+/gi, '$1[REDACTED]');
}

function redactForLog(value) {
    if (Array.isArray(value)) return value.map(redactForLog);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [
            key,
            SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactForLog(child),
        ]));
    }
    return typeof value === 'string' ? redactString(value) : value;
}

module.exports = {
    GoogleAdsCredentialsError,
    decryptRefreshToken,
    encryptRefreshToken,
    normalizeCustomerId,
    redactForLog,
    serializeConnectionStatus,
};
