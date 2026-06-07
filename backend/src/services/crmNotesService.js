'use strict';

const notesQueries = require('../db/crmNotesQueries');
const accountsQueries = require('../db/crmAccountsQueries');
const dealsQueries = require('../db/crmDealsQueries');
const contactsQueries = require('../db/crmContactsQueries');
const activitiesQueries = require('../db/crmActivitiesQueries');
const writeAuditService = require('./crmWriteAuditService');
const { badRequest, notFound } = require('./crmErrors');

const NOTE_SOURCES = new Set(['manual', 'meeting_follow_up', 'forecast_review', 'deal_strategy']);
const ENTITY_TYPES = new Set(['account', 'deal', 'contact']);

async function validateEntity(companyId, entityType, entityId) {
    if (!ENTITY_TYPES.has(entityType)) throw badRequest(`Unsupported note entity_type: ${entityType}`);
    if (!entityId) throw badRequest('entity_id is required');
    if (entityType === 'account' && !await accountsQueries.getAccountById(companyId, entityId)) throw notFound('Account not found');
    if (entityType === 'deal' && !await dealsQueries.getDealById(companyId, entityId)) throw notFound('Deal not found');
    if (entityType === 'contact' && !await contactsQueries.getContactById(companyId, entityId)) throw notFound('Contact not found');
}

async function listNotes(companyId, filters = {}) {
    return notesQueries.listNotes(companyId, filters);
}

async function createNote(companyId, payload, context = {}) {
    if (!payload.text || !String(payload.text).trim()) throw badRequest('text is required');
    if (!NOTE_SOURCES.has(payload.source)) throw badRequest(`Unsupported note source: ${payload.source}`);
    await validateEntity(companyId, payload.entity_type, payload.entity_id);
    const note = await notesQueries.createNote(companyId, {
        ...payload,
        created_by: context.actorId || null,
    });
    await activitiesQueries.createActivity(companyId, {
        account_id: payload.entity_type === 'account' ? payload.entity_id : null,
        deal_id: payload.entity_type === 'deal' ? payload.entity_id : null,
        contact_id: payload.entity_type === 'contact' ? payload.entity_id : null,
        owner_user_id: context.actorId || null,
        type: 'note',
        summary: String(payload.text).slice(0, 240),
        body: payload.text,
        customer_facing: false,
        source_entity_type: 'crm_note',
        source_entity_id: String(note.id),
    });
    await writeAuditService.logWriteAction({
        companyId,
        actorId: context.actorId,
        actorEmail: context.actorEmail,
        actorIp: context.actorIp,
        action: 'crm_note_created',
        entityType: 'crm_note',
        entityId: note.id,
        details: {
            entity_type: payload.entity_type,
            entity_id: payload.entity_id,
            source: payload.source,
        },
        source: context.source || 'Codex/Sales MCP',
        requestId: context.requestId,
        confirmation: context.confirmation || null,
    });
    return { note, field: 'crm_note', before: null, after: note };
}

module.exports = {
    NOTE_SOURCES,
    listNotes,
    createNote,
};
