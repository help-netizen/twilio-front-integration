'use strict';

const express = require('express');
const machineCredentials = require('../services/machineCredentialService');
const vapiCallIdentityService = require('../services/vapiCallIdentityService');
const { parseVapiServerMessageJson, VapiContractError } = require('../services/vapiProviderContracts');

const router = express.Router();

async function assistantRequestCredentialAuth(req, res, next) {
    try {
        const credential = await machineCredentials.resolveCredential(
            req.headers['x-vapi-secret'],
            {
                surface: machineCredentials.SURFACES.VAPI_ASSISTANT_REQUEST,
                requiredScope: machineCredentials.ACCESS_SCOPES.VAPI_ASSISTANT_REQUEST,
            },
        );
        req.machineCredential = credential;
        next();
    } catch (error) {
        const status = error instanceof machineCredentials.MachineCredentialError
            ? error.status
            : 503;
        return res.status(status).json({
            error: status === 403
                ? 'Forbidden'
                : (status === 503 ? 'Authentication unavailable' : 'Unauthorized'),
            code: error.code || 'MACHINE_CREDENTIAL_UNAVAILABLE',
        });
    }
}

function extractCorrelationToken(message) {
    const call = message?.call || {};
    const containers = [
        call.sipHeaders,
        call.phoneCallProviderDetails?.sipHeaders,
        call.headers,
    ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
    const values = [];
    for (const headers of containers) {
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === vapiCallIdentityService.TOKEN_HEADER) {
                if (typeof value !== 'string' || value.trim() === '') {
                    throw new vapiCallIdentityService.VapiIdentityError(
                        'VAPI_IDENTITY_TOKEN_REQUIRED',
                        400,
                    );
                }
                values.push(value.trim());
            }
        }
    }
    const unique = [...new Set(values)];
    if (unique.length !== 1) {
        throw new vapiCallIdentityService.VapiIdentityError(
            unique.length === 0
                ? 'VAPI_IDENTITY_TOKEN_REQUIRED'
                : 'VAPI_IDENTITY_TOKEN_AMBIGUOUS',
            400,
        );
    }
    return unique[0];
}

function hasProviderSelectionClaims(message) {
    const call = message?.call || {};
    const phoneNumber = message?.phoneNumber || {};
    return [
        message?.assistantId,
        message?.assistant,
        message?.assistantOverrides,
        message?.squadId,
        message?.squad,
        message?.destination,
        message?.model,
        message?.voice,
        message?.tools,
        message?.server,
        message?.serverUrl,
        call.assistantId,
        call.assistant,
        call.assistantOverrides,
        call.squadId,
        call.squad,
        call.destination,
        phoneNumber.assistantId,
        phoneNumber.squadId,
    ].some((value) => value !== undefined && value !== null);
}

router.post('/', assistantRequestCredentialAuth, async (req, res) => {
    try {
        const parsed = parseVapiServerMessageJson(JSON.stringify(req.body));
        if (parsed.kind !== 'assistant-request') {
            return res.status(400).json({
                error: 'Unsupported Vapi message',
                code: 'VAPI_ASSISTANT_REQUEST_MESSAGE_REQUIRED',
            });
        }

        const message = req.body.message;
        if (hasProviderSelectionClaims(message)) {
            return res.status(400).json({
                error: 'Provider selection fields are not accepted',
                code: 'VAPI_ASSISTANT_REQUEST_SELECTION_FORBIDDEN',
            });
        }

        const correlationToken = extractCorrelationToken(message);
        const bound = await vapiCallIdentityService.bindInboundCall({
            companyId: req.machineCredential.companyId,
            credentialId: req.machineCredential.id,
            correlationToken,
            providerCallId: parsed.call.id,
            source: 'assistant_request',
        });

        return res.json({ assistantId: bound.assistantId });
    } catch (error) {
        if (error instanceof VapiContractError) {
            return res.status(400).json({
                error: 'Invalid Vapi message',
                code: 'VAPI_ASSISTANT_REQUEST_CONTRACT_INVALID',
            });
        }
        if (error instanceof vapiCallIdentityService.VapiIdentityError) {
            return res.status(error.status).json({
                error: 'Unable to bind Vapi call',
                code: error.code,
            });
        }
        console.error('[vapiAssistantRequest] handler unavailable');
        return res.status(503).json({
            error: 'Assistant request unavailable',
            code: 'VAPI_ASSISTANT_REQUEST_UNAVAILABLE',
        });
    }
});

module.exports = router;
module.exports.extractCorrelationToken = extractCorrelationToken;
module.exports.hasProviderSelectionClaims = hasProviderSelectionClaims;
