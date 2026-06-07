'use strict';

const contactsQueries = require('../db/crmContactsQueries');
const activitiesQueries = require('../db/crmActivitiesQueries');
const { notFound } = require('./crmErrors');

async function listContacts(companyId, filters = {}) {
    return contactsQueries.listContacts(companyId, filters);
}

async function getContactCard(companyId, contactId, filters = {}) {
    const contact = await contactsQueries.getContactById(companyId, contactId);
    if (!contact) throw notFound('Contact not found');
    const [accounts, dealRoles, activities, lastCustomerFacingActivity] = await Promise.all([
        contactsQueries.getContactAccounts(companyId, contactId),
        contactsQueries.getContactDealRoles(companyId, contactId, filters),
        activitiesQueries.listActivities(companyId, { contact_id: contactId, limit: 30 }),
        activitiesQueries.getLastCustomerFacing(companyId, { contact_id: contactId }),
    ]);
    return { contact, accounts, deal_roles: dealRoles, activities, last_customer_facing_activity: lastCustomerFacingActivity };
}

async function getKeyContactsByAccount(companyId, accountId) {
    return contactsQueries.getKeyContactsByAccount(companyId, accountId);
}

async function getContactsMissingFields(companyId) {
    return contactsQueries.contactsMissingFields(companyId);
}

module.exports = {
    listContacts,
    getContactCard,
    getKeyContactsByAccount,
    getContactsMissingFields,
};
