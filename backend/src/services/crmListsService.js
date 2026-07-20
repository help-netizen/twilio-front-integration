'use strict';

const accountsService = require('./crmAccountsService');
const contactsService = require('./crmContactsService');
const dealsService = require('./crmDealsService');
const tasksService = require('./crmTasksService');
const { badRequest } = require('./crmErrors');
const { dateInTZ } = require('../utils/companyTime');

const DEFAULT_TIMEZONE = 'America/New_York';

const SALES_WORKFLOWS = Object.freeze([
    {
        key: 'my_open_deals',
        tool: 'crm.list_my_open_deals',
        description: 'Open deals owned by the current user.',
        default_args: { limit: 100 },
    },
    {
        key: 'deals_closing_this_month',
        tool: 'crm.find_deals_closing_this_month',
        description: 'Open deals with close_date in the current calendar month.',
        default_args: {},
    },
    {
        key: 'deals_closing_this_quarter',
        tool: 'crm.find_deals_closing_this_quarter',
        description: 'Open deals with close_date in the current calendar quarter.',
        default_args: {},
    },
    {
        key: 'deals_without_activity',
        tool: 'crm.find_deals_without_activity',
        description: 'Open deals without CRM activity for the configured inactivity window.',
        default_args: { days: 14 },
    },
    {
        key: 'deals_without_next_step',
        tool: 'crm.find_deals_without_next_step',
        description: 'Open deals with no next_step value.',
        default_args: {},
    },
    {
        key: 'risky_deals',
        tool: 'crm.find_risky_deals',
        description: 'Open deals with a risk or blocker summary.',
        default_args: { limit: 100 },
    },
    {
        key: 'top_accounts_by_pipeline',
        tool: 'crm.top_accounts_by_pipeline',
        description: 'Accounts ranked by open pipeline amount.',
        default_args: { limit: 10 },
    },
    {
        key: 'accounts_needing_follow_up',
        tool: 'crm.accounts_needing_follow_up',
        description: 'Accounts without recent CRM activity for the configured inactivity window.',
        default_args: { days: 14, limit: 100 },
    },
    {
        key: 'contacts_missing_role_title_email',
        tool: 'crm.contacts_missing_role_title_email',
        description: 'Contacts missing a deal role, title, or email.',
        default_args: {},
    },
    {
        key: 'tasks_due_this_week',
        tool: 'crm.tasks_due_this_week',
        description: 'Open CRM tasks due during the current calendar week.',
        default_args: {},
    },
]);

const SUPPORTED_LIST_KEYS = new Set(SALES_WORKFLOWS.map(workflow => workflow.key));

function localDateParts(date = new Date(), timezone = DEFAULT_TIMEZONE) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone || DEFAULT_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
    }).formatToParts(date);
    const value = type => parts.find(part => part.type === type)?.value;
    return {
        year: Number(value('year')),
        month: Number(value('month')),
        day: Number(value('day')),
        weekday: value('weekday'),
    };
}

function localDateString(year, month, day) {
    return [
        String(year).padStart(4, '0'),
        String(month).padStart(2, '0'),
        String(day).padStart(2, '0'),
    ].join('-');
}

function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthWindow(date = new Date(), timezone = DEFAULT_TIMEZONE) {
    const { year, month } = localDateParts(date, timezone);
    return {
        start: localDateString(year, month, 1),
        end: localDateString(year, month, daysInMonth(year, month)),
    };
}

function quarterWindow(date = new Date(), timezone = DEFAULT_TIMEZONE) {
    const { year, month } = localDateParts(date, timezone);
    const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
        start: localDateString(year, startMonth, 1),
        end: localDateString(year, endMonth, daysInMonth(year, endMonth)),
    };
}

function weekWindow(date = new Date(), timezone = DEFAULT_TIMEZONE) {
    const { year, month, day, weekday } = localDateParts(date, timezone);
    const dayIndex = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekday] || 1;
    const startLocal = new Date(Date.UTC(year, month - 1, day - (dayIndex - 1)));
    const endLocal = new Date(Date.UTC(
        startLocal.getUTCFullYear(),
        startLocal.getUTCMonth(),
        startLocal.getUTCDate() + 6
    ));
    const start = dateInTZ(startLocal.getUTCFullYear(), startLocal.getUTCMonth() + 1, startLocal.getUTCDate(), 0, 0, timezone);
    const nextWeekStart = dateInTZ(endLocal.getUTCFullYear(), endLocal.getUTCMonth() + 1, endLocal.getUTCDate() + 1, 0, 0, timezone);
    const end = new Date(nextWeekStart.getTime() - 1);
    return { start, end };
}

function workflowTimezone(context = {}) {
    return context.companyTimezone || DEFAULT_TIMEZONE;
}

function listWorkflows() {
    return SALES_WORKFLOWS.map(workflow => ({ ...workflow, default_args: { ...workflow.default_args } }));
}

async function getList(companyId, listKey, filters = {}, context = {}) {
    if (!SUPPORTED_LIST_KEYS.has(listKey)) {
        throw badRequest(`Unsupported CRM list: ${listKey}`, { allowed_values: Array.from(SUPPORTED_LIST_KEYS) });
    }

    switch (listKey) {
        case 'my_open_deals': {
            const ownerUserId = context.actorId;
            if (!ownerUserId) {
                throw badRequest('Current CRM user is required for my_open_deals', { field: 'owner_user_id' });
            }
            if (filters.owner_user_id && filters.owner_user_id !== ownerUserId) {
                throw badRequest('my_open_deals cannot be scoped to another owner', { field: 'owner_user_id' });
            }
            return dealsService.getOpenDeals(companyId, { owner_user_id: ownerUserId, limit: filters.limit || 100 });
        }
        case 'deals_closing_this_month': {
            const window = monthWindow(new Date(), workflowTimezone(context));
            return dealsService.getDealsClosingBetween(companyId, window.start, window.end);
        }
        case 'deals_closing_this_quarter': {
            const window = quarterWindow(new Date(), workflowTimezone(context));
            return dealsService.getDealsClosingBetween(companyId, window.start, window.end);
        }
        case 'deals_without_activity':
            return dealsService.getDealsWithoutActivity(companyId, Number(filters.days === undefined ? 14 : filters.days));
        case 'deals_without_next_step':
            return dealsService.getDealsWithoutNextStep(companyId);
        case 'risky_deals': {
            const openDeals = await dealsService.getOpenDeals(companyId, { limit: filters.limit || 100 });
            return openDeals.filter(deal => Boolean(deal.risk_summary || deal.blocker_summary));
        }
        case 'top_accounts_by_pipeline':
            return accountsService.getTopAccountsByPipeline(companyId, filters);
        case 'accounts_needing_follow_up':
            return accountsService.getStaleAccounts(companyId, Number(filters.days === undefined ? 14 : filters.days), filters);
        case 'contacts_missing_role_title_email':
            return contactsService.getContactsMissingFields(companyId);
        case 'tasks_due_this_week': {
            const window = weekWindow(new Date(), workflowTimezone(context));
            return tasksService.listTasks(companyId, {
                status: 'open',
                due_from: window.start.toISOString(),
                due_to: window.end.toISOString(),
                limit: 100,
            });
        }
        default:
            throw badRequest(`Unsupported CRM list: ${listKey}`, { allowed_values: Array.from(SUPPORTED_LIST_KEYS) });
    }
}

module.exports = {
    SALES_WORKFLOWS,
    listWorkflows,
    getList,
};
