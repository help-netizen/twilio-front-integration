'use strict';

const crypto = require('node:crypto');
const db = require('../db/connection');
const { appRuntimeError } = require('./appRuntimeErrors');
const { validateConnections } = require('./appConnectionValidator');

function encryptionKey() {
    const configured = String(process.env.APP_SECRETS_KEY || '');
    if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
        throw appRuntimeError(
            'APP_SECRETS_NOT_CONFIGURED',
            'App connection secrets are not configured.',
            503
        );
    }
    return Buffer.from(configured, 'hex');
}

function encryptSecret(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptSecret(envelope) {
    try {
        const parts = String(envelope || '').split(':');
        if (parts.length !== 3
            || !/^[0-9a-f]{24}$/i.test(parts[0])
            || !/^[0-9a-f]{32}$/i.test(parts[1])
            || !/^[0-9a-f]+$/i.test(parts[2])
            || parts[2].length % 2 !== 0) {
            throw new Error('invalid envelope');
        }
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            encryptionKey(),
            Buffer.from(parts[0], 'hex')
        );
        decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
        return Buffer.concat([
            decipher.update(Buffer.from(parts[2], 'hex')),
            decipher.final(),
        ]).toString('utf8');
    } catch (error) {
        if (error?.code === 'APP_SECRETS_NOT_CONFIGURED') throw error;
        throw appRuntimeError(
            'APP_SECRET_UNAVAILABLE',
            'App connection secret is unavailable.',
            503
        );
    }
}

function requireInput({ companyId, installationId, actorId = null }) {
    if (!companyId || (actorId !== null && !actorId)) {
        throw appRuntimeError('TENANT_CONTEXT_REQUIRED', 'Company access is required.', 403);
    }
    if (!/^[1-9]\d*$/.test(String(installationId || ''))) {
        throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
    }
}

function normalizedAcceptedConnections(row) {
    try {
        return validateConnections(row?.connections || []);
    } catch (_error) {
        throw appRuntimeError(
            'APP_CONNECTION_CONFIGURATION_INVALID',
            'Accepted app connection configuration is invalid.',
            503
        );
    }
}

async function loadAcceptedConnections(client, companyId, installationId, { forUpdate = false } = {}) {
    const { rows } = await client.query(
        `SELECT COALESCE(version.scanner_report->'connections', '[]'::jsonb) AS connections
         FROM marketplace_installations installation
         JOIN app_versions version
           ON version.app_id = installation.app_id
          AND version.id::text = installation.metadata->'app_runtime'->>'version_id'
          AND version.status = 'published'
         WHERE installation.company_id = $1
           AND installation.id = $2
           AND installation.status = 'connected'
         ${forUpdate ? 'FOR UPDATE OF installation' : ''}`,
        [companyId, installationId]
    );
    if (!rows[0]) {
        throw appRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
    }
    return normalizedAcceptedConnections(rows[0]);
}

function requireDeclaredConnection(connections, connectionName) {
    const connection = connections.find(item => item.name === connectionName);
    if (!connection) {
        throw appRuntimeError('NOT_FOUND', 'App connection was not found.', 404);
    }
    return connection;
}

function createAppInstallationSecretService({ database = db } = {}) {
    async function withTransaction(work) {
        const client = await database.getClient();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async function setSecret({ companyId, installationId, connectionName, actorId, value }) {
        requireInput({ companyId, installationId, actorId });
        if (typeof value !== 'string' || value.length === 0) {
            throw appRuntimeError('INVALID_REQUEST', 'Secret value is required.', 400);
        }
        return withTransaction(async client => {
            const connections = await loadAcceptedConnections(
                client,
                companyId,
                installationId,
                { forUpdate: true }
            );
            requireDeclaredConnection(connections, connectionName);
            const ciphertext = encryptSecret(value);
            const { rows } = await client.query(
                `INSERT INTO app_installation_secrets
                    (company_id, installation_id, connection_name, ciphertext, set_by, set_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (company_id, installation_id, connection_name) DO UPDATE
                 SET ciphertext = EXCLUDED.ciphertext,
                     set_by = EXCLUDED.set_by,
                     set_at = NOW()
                 WHERE app_installation_secrets.company_id = $1
                   AND app_installation_secrets.installation_id = $2
                   AND app_installation_secrets.connection_name = $3
                 RETURNING connection_name, set_at`,
                [companyId, installationId, connectionName, ciphertext, actorId]
            );
            if (!rows[0]) throw appRuntimeError('NOT_FOUND', 'App connection was not found.', 404);
            return {
                connection: rows[0].connection_name,
                status: 'set',
                set_at: rows[0].set_at,
            };
        });
    }

    async function listSecrets({ companyId, installationId, actorId }) {
        requireInput({ companyId, installationId, actorId });
        return withTransaction(async client => {
            const connections = await loadAcceptedConnections(client, companyId, installationId);
            const names = connections.map(connection => connection.name);
            const { rows } = names.length === 0
                ? { rows: [] }
                : await client.query(
                    `SELECT secret.connection_name
                     FROM app_installation_secrets secret
                     WHERE secret.company_id = $1
                       AND secret.installation_id = $2
                       AND secret.connection_name = ANY($3::text[])
                     ORDER BY secret.connection_name`,
                    [companyId, installationId, names]
                );
            const setNames = new Set(rows.map(row => row.connection_name));
            return connections.map(connection => ({
                connection: connection.name,
                status: setNames.has(connection.name) ? 'set' : 'not_set',
            }));
        });
    }

    return { setSecret, listSecrets };
}

const service = createAppInstallationSecretService();

module.exports = {
    ...service,
    createAppInstallationSecretService,
    encryptionKey,
    encryptSecret,
    decryptSecret,
    loadAcceptedConnections,
    requireDeclaredConnection,
};
