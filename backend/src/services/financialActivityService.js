'use strict';

const { logActivity } = require('./activityLogService');
const { withTransaction } = require('./transactionService');

function userActor(id, source = 'crm') {
    return { id: id || null, type: 'user', label: null, source };
}

function nonUserActor(type, label, source) {
    return { id: null, type, label, source };
}

function aiActor(label = 'Avatar', source = 'mcp') {
    return nonUserActor('ai', label, source);
}

function clientActor(label = 'Client', source = 'portal') {
    return nonUserActor('client', label, source);
}

function stripeActor(source = 'webhook') {
    return nonUserActor('system', 'Stripe', source);
}

function zenbookerActor(source = 'sync') {
    return nonUserActor('integration', 'Zenbooker', source);
}

async function loadEstimate(client, companyId, estimateId) {
    if (!estimateId) return null;
    const { rows } = await client.query(
        `SELECT id, job_id, lead_id, contact_id
         FROM estimates
         WHERE id = $1 AND company_id = $2`,
        [estimateId, companyId]
    );
    return rows[0] || null;
}

async function loadInvoice(client, companyId, invoiceId) {
    if (!invoiceId) return null;
    const { rows } = await client.query(
        `SELECT id, job_id, lead_id, contact_id, estimate_id
         FROM invoices
         WHERE id = $1 AND company_id = $2`,
        [invoiceId, companyId]
    );
    return rows[0] || null;
}

function firstValue(...values) {
    return values.find(value => value !== null && value !== undefined && value !== '') ?? null;
}

function parentPair(type, id) {
    return id === null || id === undefined
        ? { parent_type: null, parent_id: null }
        : { parent_type: type, parent_id: String(id) };
}

async function resolveEstimateParent(entity) {
    if (entity.job_id) return parentPair('job', entity.job_id);
    if (entity.lead_id) return parentPair('lead', entity.lead_id);
    return parentPair('contact', entity.contact_id);
}

async function resolveInvoiceParent(client, companyId, entity) {
    const estimate = await loadEstimate(client, companyId, entity.estimate_id);
    const jobId = firstValue(entity.job_id, estimate?.job_id);
    if (jobId) return parentPair('job', jobId);
    const leadId = firstValue(entity.lead_id, estimate?.lead_id);
    if (leadId) return parentPair('lead', leadId);
    return parentPair('contact', firstValue(entity.contact_id, estimate?.contact_id));
}

async function resolvePaymentParent(client, companyId, entity) {
    const invoice = await loadInvoice(client, companyId, entity.invoice_id);
    const directEstimate = await loadEstimate(client, companyId, entity.estimate_id);
    const invoiceEstimate = await loadEstimate(client, companyId, invoice?.estimate_id);

    const jobId = firstValue(
        entity.job_id,
        invoice?.job_id,
        directEstimate?.job_id,
        invoiceEstimate?.job_id
    );
    if (jobId) return parentPair('job', jobId);

    const leadId = firstValue(
        invoice?.lead_id,
        directEstimate?.lead_id,
        invoiceEstimate?.lead_id
    );
    if (leadId) return parentPair('lead', leadId);

    return parentPair('contact', firstValue(
        entity.contact_id,
        invoice?.contact_id,
        directEstimate?.contact_id,
        invoiceEstimate?.contact_id
    ));
}

async function resolveParent(client, companyId, entityType, entity) {
    if (entityType === 'estimate') return resolveEstimateParent(entity);
    if (entityType === 'invoice') return resolveInvoiceParent(client, companyId, entity);
    if (entityType === 'payment') return resolvePaymentParent(client, companyId, entity);
    throw new Error(`[FinancialActivity] Unsupported entity type: ${entityType}`);
}

async function logWithClient({
    companyId,
    entityType,
    action,
    entity,
    actor,
    summary,
}, client) {
    if (!client?.query) {
        throw new Error('[FinancialActivity] transaction client is required');
    }
    if (!entity?.id) {
        throw new Error(`[FinancialActivity] ${entityType} target id is required`);
    }
    if (!actor?.type) {
        throw new Error('[FinancialActivity] actor is required');
    }

    const parent = await resolveParent(client, companyId, entityType, entity);
    return logActivity({
        action,
        target_type: entityType,
        target_id: String(entity.id),
        company_id: companyId,
        actor_id: actor.type === 'user' ? actor.id : null,
        details: {
            actor_type: actor.type,
            actor_label: actor.type === 'user' ? null : actor.label,
            source: actor.source,
            ...parent,
            ...(summary && Object.keys(summary).length > 0 ? { summary } : {}),
        },
    }, { client });
}

async function logFinancialActivity(event, { client } = {}) {
    if (client) return logWithClient(event, client);
    return withTransaction(tx => logWithClient(event, tx));
}

module.exports = {
    aiActor,
    clientActor,
    logFinancialActivity,
    nonUserActor,
    stripeActor,
    userActor,
    zenbookerActor,
};
