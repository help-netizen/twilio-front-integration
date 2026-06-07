'use strict';

const db = require('../db/connection');
const dealsQueries = require('../db/crmDealsQueries');
const activitiesQueries = require('../db/crmActivitiesQueries');
const tasksQueries = require('../db/crmTasksQueries');
const notesQueries = require('../db/crmNotesQueries');
const metadataService = require('./crmMetadataService');
const writeAuditService = require('./crmWriteAuditService');
const { badRequest, notFound } = require('./crmErrors');

const ALLOWED_DEAL_UPDATE_FIELDS = new Set([
    'next_step',
    'stage',
    'forecast_category',
    'close_date',
    'amount',
    'risk_summary',
    'competitor',
]);

function isoDate(date) {
    return date.toISOString().slice(0, 10);
}

function isIsoCalendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function startOfWeek(date = new Date()) {
    const start = new Date(date);
    const day = start.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + diff);
    start.setHours(0, 0, 0, 0);
    return start;
}

function endOfWeek(date = new Date()) {
    const end = startOfWeek(date);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return end;
}

async function listDeals(companyId, filters = {}) {
    return dealsQueries.listDeals(companyId, filters);
}

async function getDealCard(companyId, dealId) {
    const deal = await dealsQueries.getDealById(companyId, dealId);
    if (!deal) throw notFound('Deal not found');
    const [contacts, activities, tasks, notes, history] = await Promise.all([
        dealsQueries.getDealContacts(companyId, dealId),
        activitiesQueries.listActivities(companyId, { deal_id: dealId, limit: 30 }),
        tasksQueries.listTasks(companyId, { deal_id: dealId, limit: 50 }),
        notesQueries.listNotes(companyId, { entity_type: 'deal', entity_id: dealId, limit: 50 }),
        dealsQueries.getDealHistory(companyId, dealId),
    ]);
    return { deal, contacts, activities, tasks, notes, history };
}

async function getDealHistory(companyId, dealId) {
    const deal = await dealsQueries.getDealById(companyId, dealId);
    if (!deal) throw notFound('Deal not found');
    return dealsQueries.getDealHistory(companyId, dealId);
}

function normalizeSingleFieldPatch(body) {
    const keys = Object.keys(body || {}).filter(key => body[key] !== undefined);
    const allowedKeys = keys.filter(key => ALLOWED_DEAL_UPDATE_FIELDS.has(key));
    const disallowedKeys = keys.filter(key => !ALLOWED_DEAL_UPDATE_FIELDS.has(key));
    if (disallowedKeys.length > 0) {
        throw badRequest(`Fields are not allowed: ${disallowedKeys.join(', ')}`, { disallowed_fields: disallowedKeys });
    }
    if (allowedKeys.length !== 1) {
        throw badRequest('Exactly one allowed deal field must be updated at a time', {
            allowed_fields: Array.from(ALLOWED_DEAL_UPDATE_FIELDS),
        });
    }
    const field = allowedKeys[0];
    const rawValue = body[field];
    const emptyStringClearsFields = new Set(['amount', 'close_date', 'forecast_category']);
    const value = emptyStringClearsFields.has(field) && rawValue === '' ? null : rawValue;
    return { field, value };
}

async function validateDealValue(companyId, field, value) {
    if (field === 'stage') {
        const metadata = await metadataService.getMetadata(companyId);
        const valid = metadata.pipeline_stages.some(stage => stage.stage_key === value);
        if (!valid) throw badRequest(`Invalid deal stage: ${value}`);
    }
    if (field === 'forecast_category' && value) {
        const metadata = await metadataService.getMetadata(companyId);
        const valid = metadata.forecast_categories.some(cat => cat.category_key === value);
        if (!valid) throw badRequest(`Invalid forecast category: ${value}`);
    }
    if (field === 'amount' && value !== null && value !== '') {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric < 0) throw badRequest('amount must be a non-negative number');
    }
    if (field === 'close_date' && value !== null && value !== '') {
        if (!isIsoCalendarDate(value)) throw badRequest('close_date must be a valid YYYY-MM-DD date');
    }
}

async function updateDeal(companyId, dealId, body, context = {}) {
    const { field, value } = normalizeSingleFieldPatch(body);
    await validateDealValue(companyId, field, value);

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const result = await dealsQueries.updateDealField(
            companyId,
            dealId,
            field,
            value,
            context.actorId,
            context.source || 'Codex/Sales MCP',
            context.requestId,
            client
        );
        if (!result) {
            await client.query('ROLLBACK');
            throw notFound('Deal not found');
        }
        await writeAuditService.logFieldUpdate({
            companyId,
            actorId: context.actorId,
            actorEmail: context.actorEmail,
            actorIp: context.actorIp,
            entityType: 'deal',
            entityId: dealId,
            field: `deal.${field}`,
            before: result.before,
            after: result.after,
            source: context.source || 'Codex/Sales MCP',
            requestId: context.requestId,
            confirmation: context.confirmation || null,
            client,
        });
        await client.query('COMMIT');
        return { deal: result.row, field, before: result.before, after: result.after };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

async function getDealsWithoutNextStep(companyId) {
    return dealsQueries.getDealsWithoutNextStep(companyId);
}

async function getOverdueCloseDateDeals(companyId) {
    return dealsQueries.getOverdueCloseDateDeals(companyId);
}

async function getDealsWithoutActivity(companyId, days) {
    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1) throw badRequest('days must be a positive integer');
    return dealsQueries.getDealsWithoutActivity(companyId, parsed);
}

async function getDealsClosingBetween(companyId, fromDate, toDate) {
    if (!fromDate || !toDate) throw badRequest('from and to dates are required');
    return dealsQueries.getDealsClosingBetween(companyId, fromDate, toDate);
}

async function getOpenDeals(companyId, filters = {}) {
    return dealsQueries.getOpenDeals(companyId, filters);
}

async function getAttentionDeals(companyId) {
    const weekStart = isoDate(startOfWeek());
    const weekEnd = isoDate(endOfWeek());
    const [withoutNextStep, overdueCloseDate, stale, closingThisWeek] = await Promise.all([
        getDealsWithoutNextStep(companyId),
        getOverdueCloseDateDeals(companyId),
        getDealsWithoutActivity(companyId, 7),
        getDealsClosingBetween(companyId, weekStart, weekEnd),
    ]);
    return {
        week_start: weekStart,
        week_end: weekEnd,
        closing_this_week: closingThisWeek,
        without_next_step: withoutNextStep,
        overdue_close_date: overdueCloseDate,
        without_activity: stale,
    };
}

module.exports = {
    ALLOWED_DEAL_UPDATE_FIELDS,
    listDeals,
    getDealCard,
    getDealHistory,
    updateDeal,
    getDealsWithoutNextStep,
    getOverdueCloseDateDeals,
    getDealsWithoutActivity,
    getDealsClosingBetween,
    getOpenDeals,
    getAttentionDeals,
};
