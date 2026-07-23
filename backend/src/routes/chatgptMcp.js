'use strict';

const express = require('express');
const protocol = require('../services/agentSkillsMcpProtocolService');
const { authenticateChatgptMcp } = require('../middleware/chatgptMcpAuth');
const { authenticatedLimiter } = require('../middleware/chatgptMcpRateLimit');

const router = express.Router();

router.use(authenticateChatgptMcp);
router.use(authenticatedLimiter);

router.post('/', async (req, res) => {
    const response = await protocol.handleJsonRpc(req, req.body);
    if (response === null) return res.status(202).end();
    return res.type('application/json').json(response);
});

router.get('/', (_req, res) => {
    res.set('Allow', 'POST');
    return res.status(405).json({
        jsonrpc: '2.0',
        id: null,
        error: {
            code: -32601,
            message: 'This connector uses stateless Streamable HTTP POST.',
            data: { code: 'method_not_allowed' },
        },
    });
});

module.exports = router;
