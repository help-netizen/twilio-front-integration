'use strict';

const REDACTIONS = Object.freeze({
    bearer: '[REDACTED_BEARER_TOKEN]',
    apiKey: '[REDACTED_API_KEY]',
    password: '[REDACTED_PASSWORD]',
    base64: '[REDACTED_BASE64_SECRET]',
});

function scrubSecrets(value) {
    let text = String(value == null ? '' : value);

    text = text.replace(
        /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
        `Bearer ${REDACTIONS.bearer}`
    );
    text = text.replace(
        /\b(api[-_ ]?key|x-api-key)\b(\s*[:=]\s*)(["']?)[^\s,"';]{8,}\3/gi,
        (_match, label, separator) => `${label}${separator}${REDACTIONS.apiKey}`
    );
    text = text.replace(
        /\b(password|passwd|pwd)\b(\s*[:=]\s*)(["']?)[^\s,"';]{4,}\3/gi,
        (_match, label, separator) => `${label}${separator}${REDACTIONS.password}`
    );
    text = text.replace(
        /(?<![A-Za-z0-9+/_-])(?:[A-Za-z0-9+/]{64,}={0,2}|[A-Za-z0-9_-]{64,})(?![A-Za-z0-9+/_-])/g,
        REDACTIONS.base64
    );

    return text;
}

module.exports = {
    REDACTIONS,
    scrubSecrets,
};
