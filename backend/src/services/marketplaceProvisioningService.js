const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = Number(process.env.MARKETPLACE_PROVISIONING_TIMEOUT_MS || 9000);

class MarketplaceProvisioningError extends Error {
    constructor(message, code = 'PROVISIONING_FAILED') {
        super(message);
        this.name = 'MarketplaceProvisioningError';
        this.code = code;
    }
}

function sanitizeErrorMessage(message) {
    if (!message) return 'Provisioning failed';
    return String(message)
        .replace(/(secret["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1[redacted]')
        .replace(/(X-BLANC-API-SECRET\s*[:=]\s*)[^\s,]+/gi, '$1[redacted]')
        .slice(0, 500);
}

function signPayload(secret, timestamp, rawBody) {
    return crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
}

function buildApiBaseUrl(req) {
    const configured = process.env.PUBLIC_API_BASE_URL || process.env.APP_BASE_URL;
    if (configured) {
        return `${configured.replace(/\/$/, '')}/api/v1/integrations`;
    }
    const proto = req?.headers?.['x-forwarded-proto'] || req?.protocol || 'https';
    const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'localhost:3000';
    return `${proto}://${host}/api/v1/integrations`;
}

async function pushCredentials({ app, installation, credential, companyId, requestId, req }) {
    if (app.provisioning_mode !== 'push_credentials') {
        return { ok: true, external_installation_id: null, skipped: true };
    }
    if (!app.provisioning_url || !String(app.provisioning_url).startsWith('https://')) {
        throw new MarketplaceProvisioningError('Provisioning URL must be HTTPS', 'PROVISIONING_URL_INVALID');
    }

    const hmacSecret = process.env.MARKETPLACE_PROVISIONING_HMAC_SECRET;
    if (!hmacSecret) {
        throw new MarketplaceProvisioningError('Marketplace provisioning HMAC secret is not configured', 'PROVISIONING_SECRET_MISSING');
    }

    const payload = {
        event: 'app.install',
        app_key: app.app_key,
        installation_id: String(installation.id),
        company_id: companyId,
        api_base_url: buildApiBaseUrl(req),
        credentials: {
            key_id: credential.key_id,
            secret: credential.secret,
        },
        scopes: app.requested_scopes || [],
        issued_at: new Date().toISOString(),
    };

    const rawBody = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signPayload(hmacSecret, timestamp, rawBody);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
        const response = await fetch(app.provisioning_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Blanc-Signature': `sha256=${signature}`,
                'X-Blanc-Timestamp': timestamp,
                'X-Blanc-Request-Id': requestId || '',
            },
            body: rawBody,
            signal: controller.signal,
        });

        const text = await response.text();
        let parsed = {};
        if (text) {
            try {
                parsed = JSON.parse(text);
            } catch {
                if (response.ok) parsed = {};
            }
        }

        if (!response.ok || parsed.ok === false) {
            const detail = parsed.message || parsed.error || `HTTP ${response.status}`;
            throw new MarketplaceProvisioningError(sanitizeErrorMessage(detail));
        }

        return {
            ok: true,
            external_installation_id: parsed.external_installation_id || null,
        };
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new MarketplaceProvisioningError('Provisioning request timed out', 'PROVISIONING_TIMEOUT');
        }
        if (err instanceof MarketplaceProvisioningError) {
            throw err;
        }
        throw new MarketplaceProvisioningError(sanitizeErrorMessage(err.message));
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    MarketplaceProvisioningError,
    sanitizeErrorMessage,
    signPayload,
    buildApiBaseUrl,
    pushCredentials,
};
