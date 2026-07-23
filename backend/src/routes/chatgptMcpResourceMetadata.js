'use strict';

const express = require('express');
const { READ_SCOPE } = require('../services/chatgptMcpPermissions');
const identityService = require('../services/chatgptMcpIdentityService');
const chatgptMcpAuth = require('../middleware/chatgptMcpAuth');

const router = express.Router();

function metadata(_req, res) {
    try {
        return res.json({
            resource: chatgptMcpAuth.resourceUri(),
            authorization_servers: [identityService.configuredIssuer()],
            scopes_supported: [READ_SCOPE, 'albusto.mcp.write', 'albusto.mcp.send'],
            bearer_methods_supported: ['header'],
            resource_documentation: 'https://docs.albusto.com/integrations/chatgpt-crm-mcp',
        });
    } catch {
        return res.status(503).json({ code: 'MCP_AUTH_MISCONFIGURED', message: 'Connector authorization is not configured.' });
    }
}

router.get('/', metadata);
router.get('/mcp/chatgpt', metadata);

module.exports = router;
