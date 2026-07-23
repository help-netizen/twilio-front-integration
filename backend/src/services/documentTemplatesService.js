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
const companyProfileService = require('./companyProfileService');

/**
 * Merge the company-profile brand overlay onto a template's brand. Profile
 * NON-EMPTY values win; the nested `ach` object is merged field-by-field so
 * template values survive where the profile is empty. Returns a NEW object —
 * never mutates `base` (the factory brand/ach are Object.freeze'd).
 */
function deepMergeBrand(base, overlay) {
    const baseBrand = base && typeof base === 'object' ? base : {};
    const overlayBrand = overlay && typeof overlay === 'object' ? overlay : {};
    const merged = { ...baseBrand };
    for (const [key, value] of Object.entries(overlayBrand)) {
        if (key === 'ach') continue; // merged separately below
        if (value !== undefined && value !== null && value !== '') merged[key] = value;
    }
    if (overlayBrand.ach && typeof overlayBrand.ach === 'object') {
        const mergedAch = { ...(baseBrand.ach && typeof baseBrand.ach === 'object' ? baseBrand.ach : {}) };
        for (const [key, value] of Object.entries(overlayBrand.ach)) {
            if (value !== undefined && value !== null && value !== '') mergedAch[key] = value;
        }
        merged.ach = mergedAch;
    }
    return merged;
}

/**
 * Overlay the company-profile brand onto a resolved descriptor. Always returns
 * a usable descriptor; safe-fails to the un-overlaid descriptor on any error so
 * resolveTemplate never throws.
 */
async function overlayCompanyBrand(companyId, descriptor) {
    try {
        if (!descriptor || typeof descriptor !== 'object') return descriptor;
        const profileBrand = await companyProfileService.buildBrand(companyId);
        if (!profileBrand || Object.keys(profileBrand).length === 0) return descriptor;
        // Shallow-clone the descriptor and replace `brand` with a merged clone so
        // the (possibly frozen) source brand/ach objects are never mutated.
        return { ...descriptor, brand: deepMergeBrand(descriptor.brand, profileBrand) };
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[document-templates] company brand overlay failed; using base descriptor', err);
        return descriptor;
    }
}

/**
 * OB-34 companion to overlayCompanyBrand with the roles swapped: the profile
 * brand sits UNDER the descriptor's brand. Non-empty template fields keep
 * winning (deliberate per-document customization, e.g. a docs-only DBA name),
 * while empty template fields inherit the Company Profile value (logo uploaded
 * after the template was first saved, a later-filled phone, etc.). Safe-fails
 * to the un-overlaid descriptor; never throws.
 */
async function overlayCompanyBrandUnder(companyId, descriptor) {
    try {
        if (!descriptor || typeof descriptor !== 'object') return descriptor;
        const profileBrand = await companyProfileService.buildBrand(companyId);
        if (!profileBrand || Object.keys(profileBrand).length === 0) return descriptor;
        return { ...descriptor, brand: deepMergeBrand(profileBrand, descriptor.brand) };
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[document-templates] company brand underlay failed; using base descriptor', err);
        return descriptor;
    }
}

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
async function resolveTemplate(companyId, documentType, client = null) {
    let descriptor = null;
    try {
        ensureType(documentType);
        const row = await queries.getDefaultByType(companyId, documentType, client);
        if (row && row.content && row.content.schema_version === 1) {
            const result = validateDescriptor(row.content);
            if (result.valid) {
                descriptor = row.content;
            } else {
                // stored row corrupt; fall through to factory
                // eslint-disable-next-line no-console
                console.warn('[document-templates] stored descriptor invalid; falling back to factory', {
                    companyId, documentType, errors: result.errors,
                });
            }
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[document-templates] resolveTemplate failed; falling back to factory', err);
    }
    if (descriptor) {
        // A tenant-customized template exists → its NON-EMPTY brand fields WIN
        // ("templates can override the Company Profile" — e.g. a DBA on documents
        // that differs from the company's SMS/display name: Boston Masters docs
        // say "ABC Homes"). OB-34: fields the template leaves EMPTY are filled
        // from the Company Profile — a template saved before the tenant uploaded
        // a logo must not pin "no logo" forever. Same deepMergeBrand, roles
        // swapped: profile is the base, template overlays where non-empty.
        return overlayCompanyBrandUnder(companyId, descriptor);
    }
    // No stored template: start from the factory and overlay the tenant's Company
    // Profile brand (COMPANY-PROFILE-001) so documents use the tenant's real brand
    // instead of the factory placeholder. Safe-fails to the factory; never throws.
    const base = factory.getFactory(documentType);
    if (!base) return base; // unknown/unregistered document_type → null; nothing to overlay
    return overlayCompanyBrand(companyId, base);
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
