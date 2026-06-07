'use strict';

const accountsQueries = require('../db/crmAccountsQueries');
const activitiesQueries = require('../db/crmActivitiesQueries');
const tasksQueries = require('../db/crmTasksQueries');
const { badRequest, notFound } = require('./crmErrors');

function requirePositiveDays(days) {
    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw badRequest('days must be a positive integer');
    }
    return parsed;
}

async function listAccounts(companyId, filters = {}) {
    return accountsQueries.listAccounts(companyId, filters);
}

async function getAccountCard(companyId, accountId) {
    const account = await accountsQueries.getAccountById(companyId, accountId);
    if (!account) throw notFound('Account not found');
    const [contacts, deals, activities, tasks, lastCustomerFacingActivity] = await Promise.all([
        accountsQueries.getAccountContacts(companyId, accountId),
        accountsQueries.getAccountDeals(companyId, accountId),
        activitiesQueries.listActivities(companyId, { account_id: accountId, limit: 20 }),
        tasksQueries.listTasks(companyId, { account_id: accountId, status: 'open', limit: 50 }),
        activitiesQueries.getLastCustomerFacing(companyId, { account_id: accountId }),
    ]);
    return { account, contacts, deals, activities, tasks, last_customer_facing_activity: lastCustomerFacingActivity };
}

async function getStaleAccounts(companyId, days, filters = {}) {
    return accountsQueries.getStaleAccounts(companyId, requirePositiveDays(days), filters);
}

async function getTopAccountsByPipeline(companyId, filters = {}) {
    return accountsQueries.topAccountsByPipeline(companyId, filters);
}

module.exports = {
    listAccounts,
    getAccountCard,
    getStaleAccounts,
    getTopAccountsByPipeline,
};
