'use strict';

const db = require('../db/connection');
const elocalQueries = require('../db/elocalQueries');

function requireCompanyId(companyId) {
    if (!companyId) {
        const error = new Error('A company context is required.');
        error.code = 'COMPANY_CONTEXT_REQUIRED';
        throw error;
    }
}

function normalizeCampaignIds(value) {
    if (!Array.isArray(value)) {
        const error = new Error('At least one eLocal campaign id is required.');
        error.code = 'ELOCAL_CAMPAIGNS_REQUIRED';
        throw error;
    }
    const ids = Array.from(new Set(value
        .map(id => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)));
    if (ids.length === 0) {
        const error = new Error('At least one eLocal campaign id is required.');
        error.code = 'ELOCAL_CAMPAIGNS_REQUIRED';
        throw error;
    }
    return ids;
}

function normalizeKeyReference(value = 'ELOCAL_API_KEY') {
    if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value)) {
        const error = new Error('The eLocal API key reference is invalid.');
        error.code = 'ELOCAL_KEY_REFERENCE_INVALID';
        throw error;
    }
    return value;
}

async function configureCompany({
    companyId,
    campaignIds,
    apiKeyReference = 'ELOCAL_API_KEY',
}, dependencies = {}) {
    requireCompanyId(companyId);
    const queries = dependencies.queries || elocalQueries;
    const database = dependencies.db || db;
    const client = await database.pool.connect();
    try {
        await client.query('BEGIN');
        const channel = await queries.ensureElocalChannel(companyId, client);
        const connection = await queries.upsertConnection({
            companyId,
            channelId: channel.id,
            campaignIds: normalizeCampaignIds(campaignIds),
            apiKeyReference: normalizeKeyReference(apiKeyReference),
        }, client);
        await client.query('COMMIT');
        return connection;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    configureCompany,
    _normalizeCampaignIds: normalizeCampaignIds,
    _normalizeKeyReference: normalizeKeyReference,
};
