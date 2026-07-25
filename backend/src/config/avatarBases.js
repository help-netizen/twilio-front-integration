'use strict';

const CLIENT_ENV_BY_BASE = Object.freeze({
    chatgpt: 'CHATGPT_MCP_CLIENT_ID',
    claude: 'CLAUDE_MCP_CLIENT_ID',
});

const SUPPORTED_BASES = Object.freeze(Object.keys(CLIENT_ENV_BY_BASE));

function clientEnvName(base) {
    return CLIENT_ENV_BY_BASE[base] || null;
}

function isSupportedBase(base) {
    return typeof base === 'string'
        && Object.prototype.hasOwnProperty.call(CLIENT_ENV_BY_BASE, base);
}

function clientIdForBase(base) {
    const envName = clientEnvName(base);
    if (!envName) return null;
    return String(process.env[envName] || '').trim() || null;
}

function configuredClients() {
    return SUPPORTED_BASES
        .map((base) => [clientIdForBase(base), base])
        .filter(([clientId]) => Boolean(clientId));
}

function connectorClientIds() {
    return [...new Set(configuredClients().map(([clientId]) => clientId))];
}

function baseForClientId(clientId) {
    const normalized = String(clientId || '').trim();
    if (!normalized) return null;
    const matches = configuredClients()
        .filter(([configuredId]) => configuredId === normalized);
    return matches.length === 1 ? matches[0][1] : null;
}

module.exports = {
    CLIENT_ENV_BY_BASE,
    SUPPORTED_BASES,
    baseForClientId,
    clientEnvName,
    clientIdForBase,
    configuredClients,
    connectorClientIds,
    isSupportedBase,
};
