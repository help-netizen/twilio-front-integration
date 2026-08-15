'use strict';

const crypto = require('crypto');
const express = require('express');

const protocol = require('../services/crmMcpProtocolService');
const publicAuth = require('../services/crmMcpPublicAuth');

const router = express.Router();
const sseSessions = new Map();

function sendPublicError(res, err, id = null) {
    const code = err.status || (err.code === 'MCP_PUBLIC_UNAUTHORIZED' ? 401 : 403);
    res.status(code).json({
        jsonrpc: '2.0',
        id,
        error: {
            code: -32001,
            message: err.message,
            data: { code: err.code || 'access_denied' },
        },
    });
}

async function publicContextMiddleware(req, res, next) {
    try {
        publicAuth.applyContext(req, await publicAuth.requirePublicRequest(req));
        next();
    } catch (err) {
        sendPublicError(res, err, req.body?.id ?? null);
    }
}

router.post('/', publicContextMiddleware, async (req, res) => {
    const response = await protocol.handleJsonRpc(req, req.body);
    if (response === null) return res.status(202).end();
    res.type('application/json').json(response);
});

router.get('/sse', publicContextMiddleware, (req, res) => {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
    });
    res.write(`event: endpoint\n`);
    res.write(`data: ${JSON.stringify({ endpoint: `/mcp/crm/messages?session_id=${sessionId}` })}\n\n`);
    sseSessions.set(sessionId, {
        res,
        credentialId: req.machineCredential.id,
        companyId: req.companyFilter.company_id,
    });
    req.on('close', () => {
        sseSessions.delete(sessionId);
    });
});

router.post('/messages', publicContextMiddleware, async (req, res) => {
    const sessionId = req.query.session_id;
    const session = sseSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({
            jsonrpc: '2.0',
            id: req.body?.id ?? null,
            error: {
                code: -32004,
                message: 'SSE session not found',
                data: { code: 'not_found' },
            },
        });
    }
    if (
        session.credentialId !== req.machineCredential.id
        || session.companyId !== req.companyFilter.company_id
    ) {
        return res.status(403).json({
            jsonrpc: '2.0',
            id: req.body?.id ?? null,
            error: {
                code: -32001,
                message: 'SSE session credential does not match this request',
                data: { code: 'MCP_SSE_CREDENTIAL_MISMATCH' },
            },
        });
    }
    // Use the freshly authenticated request context so membership revocation and
    // RBAC changes take effect on every message, never the stale SSE-open context.
    const response = await protocol.handleJsonRpc(req, req.body);
    if (response !== null) {
        session.res.write(`event: message\n`);
        session.res.write(`data: ${JSON.stringify(response)}\n\n`);
    }
    return res.status(202).json({ ok: true });
});

module.exports = router;
