/**
 * Document Templates orchestration layer.
 *
 * - resolveTemplate(companyId, documentType): used by renderers to get the active
 *   default descriptor for a tenant; falls back to the factory if no row exists.
 * - CRUD orchestration for the /api/document-templates routes.
 *
 * Validation uses the inline JSON-Schema validator in
 * `services/documentTemplates/validator.js` (no Ajv dependency).
 */

'use strict';

const queries = require('../db/documentTemplatesQueries');
const factory = require('./documentTemplates/factory');
const { validateDescriptor } = require('./documentTemplates/validator');
const rendererRegistry = require('./documentTemplates/rendererRegistry');

class DocumentTemplateServiceError extends Error {
    constructor(code, httpStatus, message, details = null) {
        super(message);
        this.name = 'DocumentTemplateServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }
}

function ensureType(documentType) {
    if (!factory.listDocumentTypes().includes(documentType)) {
        throw new DocumentTemplateServiceError(
            'unknown_document_type',
            400,
            `Unknown document_type: ${documentType}`,
        );
    }
}

function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        company_id: row.company_id,
        document_type: row.document_type,
        name: row.name,
        slug: row.slug,
        is_default: row.is_default,
        schema_version: row.schema_version,
        content: row.content,
        archived_at: row.archived_at,
        created_by: row.created_by,
        updated_by: row.updated_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

async function listTemplates(companyId, { documentType = null } = {}) {
    if (documentType) ensureType(documentType);
    const rows = await queries.listForCompany(companyId, { documentType });
    return rows.map(mapRow);
}

async function getTemplate(companyId, id) {
    const row = await queries.getByIdScoped(companyId, id);
    if (!row) {
        throw new DocumentTemplateServiceError('template_not_found', 404, `Template ${id} not found`);
    }
    return mapRow(row);
}

async function updateTemplate(companyId, id, { name, content, updatedBy = null }) {
    const existing = await queries.getByIdScoped(companyId, id);
    if (!existing) {
        throw new DocumentTemplateServiceError('template_not_found', 404, `Template ${id} not found`);
    }
    if (content !== undefined) {
        const result = validateDescriptor(content);
        if (!result.valid) {
            throw new DocumentTemplateServiceError(
                'validation_failed',
                422,
                'Template descriptor failed schema validation',
                result.errors,
            );
        }
    }
    const updated = await queries.updateContentScoped(companyId, id, {
        name: name ?? null,
        content: content !== undefined ? JSON.stringify(content) : null,
        updatedBy,
    });
    return mapRow(updated);
}

async function resetTemplate(companyId, id, { updatedBy = null } = {}) {
    const existing = await queries.getByIdScoped(companyId, id);
    if (!existing) {
        throw new DocumentTemplateServiceError('template_not_found', 404, `Template ${id} not found`);
    }
    const factoryDescriptor = factory.getFactory(existing.document_type);
    if (!factoryDescriptor) {
        throw new DocumentTemplateServiceError(
            'unknown_document_type',
            400,
            `No factory for document_type ${existing.document_type}`,
        );
    }
    const updated = await queries.updateContentScoped(companyId, id, {
        content: JSON.stringify(factoryDescriptor),
        updatedBy,
    });
    return mapRow(updated);
}

/**
 * Used by renderers (e.g., estimatesService.generatePdf) to get the descriptor
 * to pass to the renderer adapter. Always returns a valid descriptor; never throws.
 */
async function resolveTemplate(companyId, documentType) {
    try {
        ensureType(documentType);
        const row = await queries.getDefaultByType(companyId, documentType);
        if (row && row.content && row.content.schema_version === 1) {
            const result = validateDescriptor(row.content);
            if (result.valid) return row.content;
            // stored row corrupt; fall through to factory
            // eslint-disable-next-line no-console
            console.warn('[document-templates] stored descriptor invalid; falling back to factory', {
                companyId, documentType, errors: result.errors,
            });
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[document-templates] resolveTemplate failed; falling back to factory', err);
    }
    return factory.getFactory(documentType);
}

function getFactoryDescriptor(documentType) {
    ensureType(documentType);
    return {
        document_type: documentType,
        schema_version: 1,
        content: factory.getFactory(documentType),
    };
}

function getRegisteredAdapter(documentType) {
    return rendererRegistry.get(documentType);
}

module.exports = {
    DocumentTemplateServiceError,
    listTemplates,
    getTemplate,
    updateTemplate,
    resetTemplate,
    resolveTemplate,
    getFactoryDescriptor,
    getRegisteredAdapter,
    listDocumentTypes: factory.listDocumentTypes,
};
