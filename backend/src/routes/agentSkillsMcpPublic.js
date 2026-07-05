'use strict';

/**
 * routes/agentSkillsMcpPublic — token-gated PUBLIC JSON-RPC/SSE transport for the
 * service-CRM (`svc.*`) MCP surface. AGENT-SKILLS-001, AR-3 / spec §8 /
 * architecture §4. MIRRORS `routes/crmMcpPublic.js`.
 *
 * Auth + tenant context come from `agentSkillsMcpPublicAuth` (env-bound company,
 * bearer-token gated, DISABLED unless `SVC_MCP_PUBLIC_ENABLED === 'true'`, WRITES
 * OFF unless `SVC_MCP_PUBLIC_WRITE_ENABLED === 'true'`). The company is bound from
 * env — never the client payload. Points at the `svc.*` protocol service.
 *
 * Mounted (in src/server.js) at `/mcp/agent-skills` with NO `authenticate`
 * (its own token gate applies). The sales public route (`crmMcpPublic.js`) is
 * UNTOUCHED — additive only.
 */

const crypto = require('crypto');
const express = require('express');

const protocol = require('../services/agentSkillsMcpProtocolService');
const publicAuth = require('../services/agentSkillsMcpPublicAuth');

const router = express.Router();
const sseSessions = new Map();

function sendPublicError(res, err, id = null) {
    const code = err.code === 'MCP_PUBLIC_UNAUTHORIZED' ? 401 : 403;
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

function publicContextMiddleware(req, res, next) {
    try {
        publicAuth.applyContext(req, publicAuth.requirePublicRequest(req));
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
    res.write(`data: ${JSON.stringify({ endpoint: `/mcp/agent-skills/messages?session_id=${sessionId}` })}\n\n`);
    sseSessions.set(sessionId, {
        res,
        context: {
            companyFilter: req.companyFilter,
            user: req.user,
            authz: req.authz,
            ip: req.ip,
        },
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
    const mcpReq = {
        ...req,
        companyFilter: session.context.companyFilter,
        user: session.context.user,
        authz: session.context.authz,
        ip: session.context.ip,
    };
    const response = await protocol.handleJsonRpc(mcpReq, req.body);
    if (response !== null) {
        session.res.write(`event: message\n`);
        session.res.write(`data: ${JSON.stringify(response)}\n\n`);
    }
    return res.status(202).json({ ok: true });
});

module.exports = router;
