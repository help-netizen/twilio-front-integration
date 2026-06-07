'use strict';

const registry = require('./crmMcpToolRegistry');
const executor = require('./crmMcpToolExecutor');
const mcpResponse = require('./crmMcpResponse');

const PROTOCOL_VERSION = '2025-06-18';

function protocolError(code, message, data = {}) {
    const err = new Error(message);
    err.jsonRpcCode = code;
    err.jsonRpcData = data;
    return err;
}

async function handleJsonRpc(req, message) {
    if (Array.isArray(message)) {
        const responses = [];
        for (const item of message) {
            const response = await handleSingle(req, item);
            if (response) responses.push(response);
        }
        return responses;
    }
    return handleSingle(req, message);
}

async function handleSingle(req, message) {
    if (!message || message.jsonrpc !== '2.0') {
        return errorEnvelope(null, -32600, 'Invalid JSON-RPC request', { code: 'invalid_request' });
    }
    if (!message.id && String(message.method || '').startsWith('notifications/')) {
        return null;
    }
    const id = message.id ?? null;
    try {
        const result = await dispatch(req, message.method, message.params || {});
        return { jsonrpc: '2.0', id, result };
    } catch (err) {
        return errorEnvelope(id, jsonRpcCode(err), errorMessage(err), errorData(err, req));
    }
}

async function dispatch(req, method, params) {
    switch (method) {
        case 'initialize':
            return {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {
                    tools: { listChanged: false },
                },
                serverInfo: {
                    name: 'blanc-sales-crm-mcp',
                    version: '1.0.0',
                },
            };
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: registry.listTools({ kind: params.kind }).map(toProtocolTool) };
        case 'tools/call': {
            const toolName = params.name || params.tool;
            if (!toolName) {
                throw protocolError(-32602, 'params.name is required', {
                    code: 'invalid_request',
                    details: { field: 'params.name' },
                });
            }
            const result = await executor.execute(
                req,
                toolName,
                params.arguments || {},
                params.confirmation || null
            );
            return toolResult(result);
        }
        default:
            throw protocolError(-32601, `Unsupported MCP method: ${method || '(missing)'}`, {
                code: 'unsupported_tool',
                details: { method: method || null },
            });
    }
}

function toProtocolTool(tool) {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
            kind: tool.kind,
            destructiveHint: tool.kind === 'write',
            readOnlyHint: tool.kind === 'read',
            requiresConfirmation: tool.requiresConfirmation,
            requiredPermission: tool.requiredPermission,
        },
    };
}

function toolResult(data) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(data, null, 2),
            },
        ],
        structuredContent: data,
    };
}

function jsonRpcCode(err) {
    if (err?.jsonRpcCode) return err.jsonRpcCode;
    const mapped = mcpResponse.mapError(err);
    if (mapped.code === 'invalid_request') return -32602;
    if (mapped.code === 'unsupported_tool') return -32601;
    if (mapped.code === 'access_denied') return -32001;
    if (mapped.code === 'not_found') return -32004;
    if (mapped.code === 'confirmation_required') return -32009;
    return -32603;
}

function errorMessage(err) {
    if (err?.jsonRpcCode) return err.message;
    return mcpResponse.mapError(err).message;
}

function errorData(err, req = {}) {
    if (err?.jsonRpcData) return err.jsonRpcData;
    const mapped = mcpResponse.mapError(err);
    return {
        code: mapped.code,
        details: mapped.details,
        meta: {
            request_id: req.requestId || req.traceId || null,
        },
    };
}

function errorEnvelope(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id,
        error: {
            code,
            message,
            data,
        },
    };
}

module.exports = {
    PROTOCOL_VERSION,
    handleJsonRpc,
    toProtocolTool,
    toolResult,
};
