'use strict';

const express = require('express');
const avatarsService = require('../services/avatarsService');

const router = express.Router();

function companyId(req) {
    return req.companyFilter?.company_id || null;
}

function actorId(req) {
    return req.user?.crmUser?.id || null;
}

function handleError(err, res) {
    if (err instanceof avatarsService.AvatarsServiceError) {
        return res.status(err.httpStatus || 400).json({
            code: err.code,
            message: err.message,
        });
    }
    console.error('[Avatars] Error:', err.message);
    return res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
    });
}

function requireEmptyBody(req, res) {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
    if (Object.keys(body).length > 0) {
        res.status(400).json({
            code: 'INVALID_REQUEST',
            message: 'Request body must be empty.',
        });
        return false;
    }
    return true;
}

function enabledValue(req, res) {
    const body = req.body;
    if (!body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).length !== 1
        || typeof body.enabled !== 'boolean') {
        res.status(400).json({
            code: 'INVALID_REQUEST',
            message: 'Request body must be exactly { enabled: boolean }.',
        });
        return null;
    }
    return body.enabled;
}

function connectBase(req, res) {
    const body = req.body;
    if (body === undefined || body === null) return 'chatgpt';
    if (typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({
            code: 'INVALID_REQUEST',
            message: 'Request body must be { base: "chatgpt" | "claude" }.',
        });
        return null;
    }
    const keys = Object.keys(body);
    if (keys.length === 0) return 'chatgpt';
    if (keys.length !== 1
        || keys[0] !== 'base'
        || !['chatgpt', 'claude'].includes(body.base)) {
        res.status(400).json({
            code: 'AVATAR_BASE_UNSUPPORTED',
            message: 'Avatar base must be chatgpt or claude.',
        });
        return null;
    }
    return body.base;
}

// tenant-safety-allow R-route-permission: active company membership intentionally grants the allowlisted roster read
router.get('/', async (req, res) => {
    try {
        res.json(await avatarsService.getOverview(companyId(req), actorId(req)));
    } catch (err) {
        handleError(err, res);
    }
});

// tenant-safety-allow R-route-permission: member self-provision targets only the authenticated actor and cannot enable the company app
router.post('/me/connect', async (req, res) => {
    const base = connectBase(req, res);
    if (base === null) return;
    try {
        res.json(await avatarsService.connectSelf(companyId(req), actorId(req), base));
    } catch (err) {
        handleError(err, res);
    }
});

// tenant-safety-allow R-route-permission: owner self-consent targets only the authenticated actor's company binding
router.post('/me/writes', async (req, res) => {
    const enabled = enabledValue(req, res);
    if (enabled === null) return;
    try {
        res.json(await avatarsService.setWrites(
            companyId(req),
            actorId(req),
            enabled,
            { requestId: req.requestId }
        ));
    } catch (err) {
        handleError(err, res);
    }
});

// tenant-safety-allow R-route-permission: owner self-consent targets only the authenticated actor's company binding
router.post('/me/sends', async (req, res) => {
    const enabled = enabledValue(req, res);
    if (enabled === null) return;
    try {
        res.json(await avatarsService.setSends(
            companyId(req),
            actorId(req),
            enabled,
            { requestId: req.requestId }
        ));
    } catch (err) {
        handleError(err, res);
    }
});

// tenant-safety-allow R-route-permission: member self-revoke targets only the authenticated actor's company binding
router.post('/me/disconnect', async (req, res) => {
    if (!requireEmptyBody(req, res)) return;
    try {
        res.json(await avatarsService.disconnectSelf(companyId(req), actorId(req)));
    } catch (err) {
        handleError(err, res);
    }
});

module.exports = router;
