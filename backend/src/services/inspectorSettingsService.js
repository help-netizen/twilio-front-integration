'use strict';

const inspectorQueries = require('../db/inspectorQueries');
const fsmService = require('./fsmService');

const SETTINGS_KEYS = Object.freeze([
    'enabled',
    'ignored_job_statuses',
    'ignored_lead_statuses',
    'instruction',
]);

class InspectorSettingsError extends Error {
    constructor(message, code = 'INVALID_INSPECTOR_SETTINGS') {
        super(message);
        this.name = 'InspectorSettingsError';
        this.code = code;
        this.httpStatus = 400;
    }
}

async function statusCatalog(companyId, machineKey) {
    const graph = await fsmService.getPublishedGraph(companyId, machineKey);
    if (!graph) return [];
    return [...graph.states.values()].map(state => state.statusName);
}

async function getCatalogs(companyId) {
    if (!companyId) throw new InspectorSettingsError('companyId is required', 'COMPANY_ID_REQUIRED');
    const [jobStatuses, leadStatuses] = await Promise.all([
        statusCatalog(companyId, 'job'),
        statusCatalog(companyId, 'lead'),
    ]);
    return { job_statuses: jobStatuses, lead_statuses: leadStatuses };
}

function validateStatusList(value, catalog, label) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new InspectorSettingsError(`${label} must be an array of workflow status names.`);
    }
    const unique = [...new Set(value)];
    const unknown = unique.find(status => !catalog.includes(status));
    if (unknown) {
        throw new InspectorSettingsError(`${label} contains an unknown workflow status: ${unknown}.`);
    }
    return unique;
}

async function validateInput(companyId, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new InspectorSettingsError('Settings must be an object.');
    }
    const keys = Object.keys(body);
    const unexpected = keys.find(key => !SETTINGS_KEYS.includes(key));
    if (unexpected) {
        throw new InspectorSettingsError(`Unexpected Inspector setting: ${unexpected}.`);
    }
    const missing = SETTINGS_KEYS.find(key => !Object.prototype.hasOwnProperty.call(body, key));
    if (missing) {
        throw new InspectorSettingsError(`Missing Inspector setting: ${missing}.`);
    }
    if (typeof body.enabled !== 'boolean') {
        throw new InspectorSettingsError('Enabled must be a boolean.');
    }
    if (typeof body.instruction !== 'string') {
        throw new InspectorSettingsError('Agent instruction must be text.');
    }
    const instruction = body.instruction.trim();
    if (!instruction || instruction.length > 12000) {
        throw new InspectorSettingsError('Agent instruction must contain 1 to 12,000 characters.');
    }
    const catalogs = await getCatalogs(companyId);
    return {
        enabled: body.enabled,
        ignored_job_statuses: validateStatusList(
            body.ignored_job_statuses,
            catalogs.job_statuses,
            'Ignored Job statuses'
        ),
        ignored_lead_statuses: validateStatusList(
            body.ignored_lead_statuses,
            catalogs.lead_statuses,
            'Ignored Lead statuses'
        ),
        instruction,
    };
}

async function save(companyId, settings, actorId) {
    return inspectorQueries.saveSettings(companyId, settings, actorId);
}

async function buildResponse(companyId, appKey, installation, _metadata, savedSettings = null) {
    const [rawSettings, catalogs, timezone] = await Promise.all([
        savedSettings ? Promise.resolve(savedSettings) : inspectorQueries.getSettings(companyId),
        getCatalogs(companyId),
        inspectorQueries.getCompanyTimezone(companyId),
    ]);
    const virtual = rawSettings.updated_at == null;
    const settings = {
        enabled: rawSettings.enabled,
        ignored_job_statuses: virtual
            ? rawSettings.ignored_job_statuses.filter(status => catalogs.job_statuses.includes(status))
            : rawSettings.ignored_job_statuses,
        ignored_lead_statuses: virtual
            ? rawSettings.ignored_lead_statuses.filter(status => catalogs.lead_statuses.includes(status))
            : rawSettings.ignored_lead_statuses,
        instruction: rawSettings.instruction,
    };
    return {
        app_key: appKey,
        installation_id: installation.id,
        settings,
        catalogs,
        schedule: {
            frequency: 'daily',
            after_local_time: '12:00',
            timezone,
        },
    };
}

function buildEventPayload(settings) {
    return {
        app_key: 'inspector',
        enabled: settings.enabled,
        ignored_job_status_count: settings.ignored_job_statuses.length,
        ignored_lead_status_count: settings.ignored_lead_statuses.length,
        has_instruction: settings.instruction.length > 0,
    };
}

module.exports = {
    InspectorSettingsError,
    SETTINGS_KEYS,
    buildEventPayload,
    buildResponse,
    getCatalogs,
    save,
    validateInput,
    validateStatusList,
};
