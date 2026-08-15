'use strict';

const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('../db/connection');
const { encryptSecret, encryptionKey } = require('./appInstallationSecretService');
const machineCredentials = require('./machineCredentialService');

const VAPI_ORG_URL = 'https://api.vapi.ai/org';

class VapiOrgProvisioningError extends Error {
    constructor(code, status = 500) {
        super(code);
        this.name = 'VapiOrgProvisioningError';
        this.code = code;
        this.status = status;
    }
}

function validateInput({ companyId, environment }) {
    if (!companyId) throw new VapiOrgProvisioningError('VAPI_COMPANY_REQUIRED', 400);
    if (!/^[a-z0-9_-]{1,32}$/i.test(environment)) {
        throw new VapiOrgProvisioningError('VAPI_ENVIRONMENT_INVALID', 400);
    }
}

function validateLocalSecretConfig() {
    encryptionKey();
    if (!process.env.BLANC_SERVER_PEPPER) {
        throw new VapiOrgProvisioningError('VAPI_MACHINE_SECRET_CONFIG_REQUIRED', 503);
    }
}

function validateCreateOrgResponse(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new VapiOrgProvisioningError('VAPI_ORG_RESPONSE_INVALID', 502);
    }
    if (typeof payload.id !== 'string' || payload.id.length < 8) {
        throw new VapiOrgProvisioningError('VAPI_ORG_RESPONSE_INVALID', 502);
    }
    if (typeof payload.privateKey !== 'string' || payload.privateKey.length < 20) {
        throw new VapiOrgProvisioningError('VAPI_ORG_RESPONSE_INVALID', 502);
    }
    return { orgId: payload.id, apiKey: payload.privateKey };
}

function createService({
    database = db,
    fetchImpl = fetch,
    encrypt = encryptSecret,
    validateSecrets = validateLocalSecretConfig,
    credentialService = machineCredentials,
} = {}) {
    async function createRemoteOrg({ companyId, companyName, environment }) {
        const masterKey = process.env.VAPI_API_KEY;
        if (!masterKey) {
            throw new VapiOrgProvisioningError('VAPI_MASTER_KEY_REQUIRED', 503);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let response;
        try {
            response = await fetchImpl(VAPI_ORG_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${masterKey}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': `albusto-vapi-org:${companyId}:${environment}`,
                },
                body: JSON.stringify({ name: companyName }),
                signal: controller.signal,
            });
        } catch (_error) {
            throw new VapiOrgProvisioningError('VAPI_ORG_REQUEST_FAILED', 502);
        } finally {
            clearTimeout(timeout);
        }
        if (!response?.ok) {
            throw new VapiOrgProvisioningError('VAPI_ORG_REQUEST_REJECTED', 502);
        }

        let payload;
        try {
            payload = await response.json();
        } catch (_error) {
            throw new VapiOrgProvisioningError('VAPI_ORG_RESPONSE_INVALID', 502);
        }
        return validateCreateOrgResponse(payload);
    }

    async function findActiveToolCredential(client, companyId) {
        const result = await client.query(
            `SELECT id
             FROM api_integrations
             WHERE company_id = $1
               AND machine_surface = 'vapi_tools'
               AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > now())
               AND jsonb_typeof(scopes) = 'array'
               AND scopes @> '["vapi_tools:invoke"]'::jsonb
             ORDER BY id
             LIMIT 2`,
            [companyId]
        );
        if (result.rows.length > 1) {
            throw new VapiOrgProvisioningError('VAPI_TOOL_CREDENTIAL_AMBIGUOUS', 409);
        }
        return result.rows[0] || null;
    }

    async function ensureToolCredential(client, companyId, toolsSecret) {
        const existing = await findActiveToolCredential(client, companyId);
        if (existing) {
            return { id: String(existing.id), secret: null, created: false };
        }
        return credentialService.provisionCredential({
            companyId,
            surface: credentialService.SURFACES.VAPI_TOOLS,
            scopes: [credentialService.ACCESS_SCOPES.VAPI_TOOLS],
            secret: toolsSecret,
            client,
        });
    }

    async function provision({ companyId, environment = 'prod', toolsSecret = null }) {
        validateInput({ companyId, environment });
        if (toolsSecret !== null && (typeof toolsSecret !== 'string' || toolsSecret.length < 32)) {
            throw new VapiOrgProvisioningError('VAPI_TOOLS_SECRET_INVALID', 400);
        }
        const client = await database.getClient();
        try {
            await client.query('BEGIN');
            await client.query(
                `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
                [`vapi-org:${companyId}:${environment}`]
            );
            const companyResult = await client.query(
                `SELECT id, name
                 FROM companies
                 WHERE id = $1 AND status = 'active'
                 FOR SHARE`,
                [companyId]
            );
            if (companyResult.rows.length !== 1) {
                throw new VapiOrgProvisioningError('VAPI_COMPANY_INVALID', 400);
            }

            const connectionResult = await client.query(
                `SELECT id, provider_org_id, status, encrypted_credentials_json
                 FROM provider_connections
                 WHERE company_id = $1 AND provider = 'vapi' AND environment = $2
                 FOR UPDATE`,
                [companyId, environment]
            );
            if (connectionResult.rows.length > 1) {
                throw new VapiOrgProvisioningError('VAPI_CONNECTION_AMBIGUOUS', 409);
            }
            const existingConnection = connectionResult.rows[0] || null;
            if (
                existingConnection?.provider_org_id
                && existingConnection.encrypted_credentials_json
                && existingConnection.status === 'active'
            ) {
                const credential = await ensureToolCredential(client, companyId, toolsSecret);
                await client.query('COMMIT');
                return {
                    companyId,
                    environment,
                    connectionId: existingConnection.id,
                    providerOrgId: existingConnection.provider_org_id,
                    organizationCreated: false,
                    credential,
                };
            }

            // Validate both local at-rest encryption and machine-secret hashing
            // before the non-transactional provider-side create.
            validateSecrets();
            const remote = await createRemoteOrg({
                companyId,
                companyName: companyResult.rows[0].name,
                environment,
            });
            const encryptedCredentials = encrypt(JSON.stringify({ api_key: remote.apiKey }));
            const connectionId = existingConnection?.id
                || `conn_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

            if (existingConnection) {
                await client.query(
                    `UPDATE provider_connections
                     SET tenant_id = $1,
                         provider_org_id = $2,
                         encrypted_credentials_json = $3,
                         status = 'active',
                         display_name = 'VAPI AI',
                         updated_at = now()
                     WHERE id = $4 AND company_id = $1
                       AND provider = 'vapi' AND environment = $5`,
                    [companyId, remote.orgId, encryptedCredentials, connectionId, environment]
                );
            } else {
                await client.query(
                    `INSERT INTO provider_connections
                        (id, tenant_id, company_id, provider, environment, status,
                         provider_org_id, encrypted_credentials_json, display_name)
                     VALUES ($1, $2, $2, 'vapi', $3, 'active', $4, $5, 'VAPI AI')`,
                    [connectionId, companyId, environment, remote.orgId, encryptedCredentials]
                );
            }

            const credential = await ensureToolCredential(client, companyId, toolsSecret);
            await client.query('COMMIT');
            return {
                companyId,
                environment,
                connectionId,
                providerOrgId: remote.orgId,
                organizationCreated: true,
                credential,
            };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    return { provision, createRemoteOrg };
}

const service = createService();

module.exports = {
    ...service,
    VAPI_ORG_URL,
    VapiOrgProvisioningError,
    validateCreateOrgResponse,
    createService,
};
