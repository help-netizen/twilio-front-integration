'use strict';

const LIMITS = Object.freeze({
    memoryMb: 32,
    cpuTimeoutMs: 100,
    gatewayCallLimit: 10,
    dataCallLimit: 10,
    // Matches the view-document ceiling the CRM validates against (APP-VIEW-001 §2.2).
    // A table of the 500 rows that spec allows runs past 64 KB, so the older, lower
    // ceiling would have killed a report the product explicitly permits.
    maxOutputBytes: 256 * 1024,
    gatewayRequestTimeoutMs: 5000,
    // APP-DATA-001 permits 500 listed rows at up to 8 KB each. The host must
    // be able to receive that bounded page even though final view output stays 256 KB.
    maxGatewayResponseBytes: 5 * 1024 * 1024,
});

const GATEWAY_TOOLS = Object.freeze([
    'svc.list_jobs',
    'svc.get_job',
    'svc.list_tasks',
    'svc.list_estimates',
    'svc.get_estimate',
]);

module.exports = {
    LIMITS,
    GATEWAY_TOOLS,
};
