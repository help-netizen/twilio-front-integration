'use strict';

const express = require('express');

const accountsService = require('../services/crmAccountsService');
const contactsService = require('../services/crmContactsService');
const dealsService = require('../services/crmDealsService');
const pipelineService = require('../services/crmPipelineService');
const activitiesService = require('../services/crmActivitiesService');
const tasksService = require('../services/crmTasksService');
const notesService = require('../services/crmNotesService');
const metadataService = require('../services/crmMetadataService');
const listsService = require('../services/crmListsService');
const { CrmServiceError } = require('../services/crmErrors');
const { requirePermission } = require('../middleware/authorization');

const router = express.Router();

function getCompanyId(req) {
    return req.companyFilter?.company_id || null;
}

function actorContext(req) {
    return {
        actorId: req.user?.crmUser?.id || null,
        actorEmail: req.user?.email || null,
        actorIp: req.ip || null,
        requestId: req.requestId || req.traceId || null,
        source: 'Codex/Sales MCP',
        createdBy: req.user ? 'user' : 'system',
    };
}

function writePayload(req) {
    const { source, ...payload } = req.body || {};
    return payload;
}

function ok(res, data, req) {
    res.json({
        ok: true,
        data,
        meta: {
            request_id: req.requestId || req.traceId || null,
            timestamp: new Date().toISOString(),
        },
    });
}

function sendError(res, err, req) {
    if (err instanceof CrmServiceError) {
        return res.status(err.httpStatus).json({
            ok: false,
            error: {
                code: err.code,
                message: err.message,
                details: err.details || undefined,
                correlation_id: req.requestId || req.traceId || null,
            },
        });
    }
    if (err?.code === 'COMPANY_ID_REQUIRED') {
        return res.status(403).json({
            ok: false,
            error: {
                code: 'TENANT_CONTEXT_REQUIRED',
                message: 'Company context required',
                correlation_id: req.requestId || req.traceId || null,
            },
        });
    }
    console.error('[CRM API] unexpected error:', err);
    return res.status(500).json({
        ok: false,
        error: {
            code: 'INTERNAL_ERROR',
            message: 'Unexpected CRM error',
            correlation_id: req.requestId || req.traceId || null,
        },
    });
}

function numberParam(value, name) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        const err = new CrmServiceError('INVALID_ID', `${name} must be a positive integer`, 400);
        throw err;
    }
    return parsed;
}

function handler(fn) {
    return async (req, res) => {
        try {
            const companyId = getCompanyId(req);
            if (!companyId) {
                throw new CrmServiceError('TENANT_CONTEXT_REQUIRED', 'Company context required', 403);
            }
            const data = await fn(req, companyId);
            ok(res, data, req);
        } catch (err) {
            sendError(res, err, req);
        }
    };
}

// Accounts
router.get('/accounts/stale', requirePermission('contacts.view'), handler(async (req, companyId) => (
    accountsService.getStaleAccounts(companyId, req.query.days, req.query)
)));

router.get('/accounts/:id/key-contacts', requirePermission('contacts.view'), handler(async (req, companyId) => (
    contactsService.getKeyContactsByAccount(companyId, numberParam(req.params.id, 'account id'))
)));

router.get('/accounts/:id', requirePermission('contacts.view'), handler(async (req, companyId) => (
    accountsService.getAccountCard(companyId, numberParam(req.params.id, 'account id'))
)));

router.get('/accounts', requirePermission('contacts.view'), handler(async (req, companyId) => (
    accountsService.listAccounts(companyId, req.query)
)));

// Contacts
router.get('/contacts/:id', requirePermission('contacts.view'), handler(async (req, companyId) => (
    contactsService.getContactCard(companyId, numberParam(req.params.id, 'contact id'), req.query)
)));

router.get('/contacts', requirePermission('contacts.view'), handler(async (req, companyId) => (
    contactsService.listContacts(companyId, req.query)
)));

// Deals
router.get('/deals/attention', requirePermission('leads.view'), handler(async (req, companyId) => (
    dealsService.getAttentionDeals(companyId)
)));

router.patch('/deals/:id', requirePermission('sales.crm.write'), handler(async (req, companyId) => (
    dealsService.updateDeal(companyId, numberParam(req.params.id, 'deal id'), writePayload(req), actorContext(req))
)));

router.get('/deals/:id', requirePermission('leads.view'), handler(async (req, companyId) => (
    dealsService.getDealCard(companyId, numberParam(req.params.id, 'deal id'))
)));

router.get('/deals', requirePermission('leads.view'), handler(async (req, companyId) => (
    dealsService.listDeals(companyId, req.query)
)));

// Pipeline and activity
router.get('/pipeline', requirePermission('leads.view'), handler(async (req, companyId) => (
    pipelineService.getPipeline(companyId, req.query)
)));

router.get('/activities', requirePermission('contacts.view'), handler(async (req, companyId) => (
    activitiesService.listActivities(companyId, req.query)
)));

// Tasks
router.patch('/tasks/:id', requirePermission('sales.crm.write'), handler(async (req, companyId) => (
    tasksService.updateTaskStatus(companyId, numberParam(req.params.id, 'task id'), writePayload(req).status, actorContext(req))
)));

router.post('/tasks', requirePermission('sales.crm.write'), handler(async (req, companyId) => (
    tasksService.createTask(companyId, writePayload(req), actorContext(req))
)));

router.get('/tasks', requirePermission('tasks.view'), handler(async (req, companyId) => (
    tasksService.listTasks(companyId, req.query)
)));

// Notes
router.post('/notes', requirePermission('sales.crm.write'), handler(async (req, companyId) => (
    notesService.createNote(companyId, req.body || {}, actorContext(req))
)));

router.get('/notes', requirePermission('contacts.view'), handler(async (req, companyId) => (
    notesService.listNotes(companyId, req.query)
)));

// Metadata and ready-made lists
router.get('/metadata', requirePermission('contacts.view'), handler(async (req, companyId) => (
    metadataService.getMetadata(companyId)
)));

router.get('/lists/:listKey', requirePermission('contacts.view'), handler(async (req, companyId) => (
    listsService.getList(companyId, req.params.listKey, req.query, actorContext(req))
)));

module.exports = router;
