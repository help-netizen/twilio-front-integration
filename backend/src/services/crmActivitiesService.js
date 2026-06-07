'use strict';

const activitiesQueries = require('../db/crmActivitiesQueries');
const { badRequest } = require('./crmErrors');

const ACTIVITY_TYPES = new Set(['email', 'call', 'meeting', 'note', 'task', 'stage_change']);

function validateActivityType(type) {
    if (type && !ACTIVITY_TYPES.has(type)) {
        throw badRequest(`Unsupported activity type: ${type}`);
    }
}

async function listActivities(companyId, filters = {}) {
    validateActivityType(filters.type);
    return activitiesQueries.listActivities(companyId, filters);
}

async function getLastCustomerFacing(companyId, filters = {}) {
    return activitiesQueries.getLastCustomerFacing(companyId, filters);
}

async function createActivity(companyId, payload) {
    validateActivityType(payload.type);
    if (!payload.type) throw badRequest('type is required');
    return activitiesQueries.createActivity(companyId, payload);
}

module.exports = {
    ACTIVITY_TYPES,
    listActivities,
    getLastCustomerFacing,
    createActivity,
};
