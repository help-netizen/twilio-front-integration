'use strict';

/**
 * routes/agentSkillsMcp — authenticated JSON-RPC transport for the service-CRM
 * (`svc.*`) MCP surface. AGENT-SKILLS-001, AR-3 / spec §8 / architecture §4.
 *
 * MIRRORS `routes/crmMcp.js`. Mounted (in src/server.js) with the SAME chain as
 * `/api/crm/mcp`: `authenticate, requireCompanyAccess` — so `req.companyFilter`,
 * `req.user`, and `req.authz` are established by the shared middleware, and the
 * executor reads the tenant from `req.companyFilter.company_id` (never client).
 *
 * Reuses `crmMcpResponse` (shared, generic) for the sanitized error envelope;
 * points at the `svc.*` registry/executor/protocol. The sales route
 * (`crmMcp.js`) is UNTOUCHED — additive only.
 */

const express = require('express');

const registry = require('../services/agentSkillsMcpRegistry');
const executor = require('../services/agentSkillsMcpExecutor');
const mcpResponse = require('../services/crmMcpResponse');
const protocol = require('../services/agentSkillsMcpProtocolService');

const router = express.Router();

function requestMeta(req) {
    return {
        requestId: req.requestId || req.traceId || null,
    };
}

function sendMcpError(res, toolName, err, req) {
    const body = mcpResponse.error(toolName, err, requestMeta(req));
    return res.status(mcpResponse.httpStatusFor(body)).json(body);
}

function ensureCompanyContext(req) {
    if (!req.companyFilter?.company_id) {
        throw mcpResponse.mcpError('access_denied', 'Company context required', {
            reason: 'TENANT_CONTEXT_REQUIRED',
        });
    }
}

router.get('/tools', (req, res) => {
    try {
        ensureCompanyContext(req);
        res.json(mcpResponse.toolList(registry.listTools({ kind: req.query.kind }), requestMeta(req)));
    } catch (err) {
        sendMcpError(res, null, err, req);
    }
});

router.post('/call', async (req, res) => {
    const toolName = req.body?.tool || req.body?.name || null;
    try {
        ensureCompanyContext(req);
        if (!toolName) {
            throw mcpResponse.mcpError('invalid_request', 'tool is required', { field: 'tool' });
        }
        const result = await executor.execute(
            req,
            toolName,
            req.body?.arguments || {},
            req.body?.confirmation || null,
        );
        res.json(mcpResponse.success(toolName, result, requestMeta(req)));
    } catch (err) {
        sendMcpError(res, toolName, err, req);
    }
});

router.post('/jsonrpc', async (req, res) => {
    try {
        ensureCompanyContext(req);
        const response = await protocol.handleJsonRpc(req, req.body);
        if (response === null) return res.status(202).end();
        return res.json(response);
    } catch (err) {
        sendMcpError(res, req.body?.params?.name || req.body?.params?.tool || null, err, req);
    }
});

module.exports = router;
