'use strict';

const { Readable } = require('stream');
const conversationsService = require('../services/conversationsService');
const { verifyMediaAccessToken } = require('../services/smsMediaAccessService');

function notFound(res) {
    return res.status(404).json({ error: 'Media not found' });
}

function setMediaHeaders(res, contentType) {
    res.set('Content-Type', contentType || 'application/octet-stream');
    res.set('Cache-Control', 'private, no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
}

function pipeBody(upstream, res) {
    if (!upstream.body) return false;
    Readable.fromWeb(upstream.body).pipe(res);
    return true;
}

async function mediaTemporaryUrlHandler(req, res) {
    let claims;
    try {
        claims = verifyMediaAccessToken(req.query?.cap, req.params.mediaId);
    } catch (error) {
        // A missing signing secret is indistinguishable from a bad capability on
        // this public surface. The authenticated mint endpoint exposes the 503.
        return notFound(res);
    }
    if (!claims) return notFound(res);

    try {
        const result = await conversationsService.getMediaTemporaryUrl(
            req.params.mediaId,
            claims.company_id
        );
        if (!result.url) return notFound(res);

        let upstream = await fetch(result.url);
        let contentType = result.contentType;
        if (!upstream.ok) {
            const fresh = await conversationsService.getMediaTemporaryUrl(
                req.params.mediaId,
                claims.company_id,
                true
            );
            if (!fresh.url) return notFound(res);
            upstream = await fetch(fresh.url);
            contentType = fresh.contentType;
            if (!upstream.ok) {
                return res.status(502).json({ error: 'Upstream media fetch failed' });
            }
        }

        setMediaHeaders(res, contentType || upstream.headers.get('content-type'));
        if (!pipeBody(upstream, res)) {
            return res.status(502).json({ error: 'Upstream media fetch failed' });
        }
        return undefined;
    } catch (error) {
        if (String(error?.message || '').includes('not found')) return notFound(res);
        console.error('[Media] proxy error:', error?.message || 'unknown error');
        return res.status(500).json({ error: 'Media proxy failed' });
    }
}

module.exports = { mediaTemporaryUrlHandler };
