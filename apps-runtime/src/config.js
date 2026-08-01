'use strict';

const LIMITS = Object.freeze({
    memoryMb: 32,
    cpuTimeoutMs: 100,
    gatewayCallLimit: 5,
    maxOutputBytes: 64 * 1024,
    gatewayRequestTimeoutMs: 5000,
    maxGatewayResponseBytes: 256 * 1024,
});

const GATEWAY_TOOLS = Object.freeze([
    'svc.list_jobs',
    'svc.get_job',
    'svc.list_tasks',
]);

module.exports = {
    LIMITS,
    GATEWAY_TOOLS,
};
