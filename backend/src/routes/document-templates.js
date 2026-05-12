/**
 * /api/document-templates routes (F015)
 *
 * Mount in `src/server.js`:
 *   app.use('/api/document-templates',
 *       authenticate,
 *       requirePermission('tenant.documents.manage'),
 *       requireCompanyAccess,
 *       documentTemplatesRouter);
 *
 * Every handler scopes by `req.companyFilter?.company_id || req.user?.company_id`.
 */

'use strict';

const express = require('express');

const documentTemplatesService = require('../services/documentTemplatesService');
const { DocumentTemplateServiceError } = documentTemplatesService;

const router = express.Router();

function getCompanyId(req) {
    return req.companyFilter?.company_id || req.user?.company_id || null;
}

function sendServiceError(res, err) {
    if (err instanceof DocumentTemplateServiceError) {
        return res.status(err.httpStatus).json({
            error: err.code,
            message: err.message,
            details: err.details || undefined,
        });
    }
    // eslint-disable-next-line no-console
    console.error('[document-templates] unexpected error', err);
    return res.status(500).json({ error: 'internal_error', message: 'Unexpected error' });
}

router.get('/', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: 'forbidden' });
    try {
        const documentType = req.query.document_type || null;
        const items = await documentTemplatesService.listTemplates(companyId, { documentType });
        res.json({ items });
    } catch (err) {
        sendServiceError(res, err);
    }
});

router.get('/factory/:document_type', async (req, res) => {
    try {
        const factoryDescriptor = documentTemplatesService.getFactoryDescriptor(req.params.document_type);
        res.json(factoryDescriptor);
    } catch (err) {
        sendServiceError(res, err);
    }
});

router.get('/:id', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: 'forbidden' });
    try {
        const template = await documentTemplatesService.getTemplate(companyId, Number(req.params.id));
        res.json(template);
    } catch (err) {
        sendServiceError(res, err);
    }
});

router.put('/:id', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: 'forbidden' });
    try {
        const { name, content } = req.body || {};
        const updated = await documentTemplatesService.updateTemplate(companyId, Number(req.params.id), {
            name,
            content,
            updatedBy: req.user?.id || null,
        });
        res.json(updated);
    } catch (err) {
        sendServiceError(res, err);
    }
});

router.post('/:id/reset', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: 'forbidden' });
    try {
        const updated = await documentTemplatesService.resetTemplate(companyId, Number(req.params.id), {
            updatedBy: req.user?.id || null,
        });
        res.json(updated);
    } catch (err) {
        sendServiceError(res, err);
    }
});

router.post('/:id/preview', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: 'forbidden' });
    try {
        const template = await documentTemplatesService.getTemplate(companyId, Number(req.params.id));
        const overrideContent = req.body && req.body.content !== undefined ? req.body.content : null;
        // Validation only when override is provided.
        if (overrideContent !== null) {
            const { validateDescriptor } = require('../services/documentTemplates/validator');
            const result = validateDescriptor(overrideContent);
            if (!result.valid) {
                return res.status(422).json({
                    error: 'validation_failed',
                    message: 'Override descriptor invalid',
                    details: result.errors,
                });
            }
        }
        res.json({
            descriptor: overrideContent || template.content,
            template_id: template.id,
            document_type: template.document_type,
            rendered_at: new Date().toISOString(),
        });
    } catch (err) {
        sendServiceError(res, err);
    }
});

module.exports = router;
