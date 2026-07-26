'use strict';

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

function storageHost() {
    try {
        return new URL(process.env.AWS_ENDPOINT_URL_S3 || '').hostname.toLowerCase();
    } catch {
        return '';
    }
}

function isAllowedStorageUrl(value) {
    try {
        const url = new URL(value);
        const allowedHost = storageHost();
        const hostname = url.hostname.toLowerCase();
        return url.protocol === 'https:'
            && Boolean(allowedHost)
            && (hostname === allowedHost || hostname.endsWith(`.${allowedHost}`));
    } catch {
        return false;
    }
}

function imageFormat(buffer) {
    if (
        buffer.length >= 8
        && buffer[0] === 0x89
        && buffer[1] === 0x50
        && buffer[2] === 0x4e
        && buffer[3] === 0x47
        && buffer[4] === 0x0d
        && buffer[5] === 0x0a
        && buffer[6] === 0x1a
        && buffer[7] === 0x0a
    ) {
        return 'png';
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'jpg';
    }
    return null;
}

function decodeInlineLogo(value) {
    const match = /^data:image\/(?:png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
    if (!match) return null;

    const buffer = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
    if (buffer.length === 0 || buffer.length > MAX_LOGO_BYTES) return null;
    const format = imageFormat(buffer);
    return format ? { data: buffer, format } : null;
}

/**
 * Resolve a tenant logo before React-PDF renders it. Inline PNG/JPEG logos are
 * decoded locally. Remote logos are restricted to the configured S3/Tigris
 * endpoint: template descriptors are tenant-editable, so following arbitrary
 * URLs here would create an SSRF primitive.
 */
async function fetchPdfLogo(logoUrl, {
    fetchImpl = global.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    if (typeof logoUrl === 'string' && logoUrl.startsWith('data:')) {
        return decodeInlineLogo(logoUrl);
    }
    if (!logoUrl || !isAllowedStorageUrl(logoUrl) || typeof fetchImpl !== 'function') return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(logoUrl, {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
        });
        if (!response.ok) return null;

        const declaredLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGO_BYTES) return null;

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0 || buffer.length > MAX_LOGO_BYTES) return null;
        const format = imageFormat(buffer);
        return format ? { data: buffer, format } : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Return a render-only descriptor clone. A failed logo fetch removes the remote
 * URL so React-PDF cannot retry it without our timeout; the normal brand-name
 * header remains the fallback.
 */
async function preparePdfDescriptor(descriptor, options) {
    if (!descriptor?.brand?.logo_url) return descriptor;
    const logo = await fetchPdfLogo(descriptor.brand.logo_url, options);
    return {
        ...descriptor,
        brand: {
            ...descriptor.brand,
            logo_url: logo,
        },
    };
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    MAX_LOGO_BYTES,
    fetchPdfLogo,
    preparePdfDescriptor,
};
