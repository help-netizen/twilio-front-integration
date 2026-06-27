/**
 * Unit tests for documentTemplatesService and the inline validator (F015).
 */

'use strict';

jest.mock('../../backend/src/db/connection', () => ({
    pool: {},
    query: jest.fn(),
}));

jest.mock('../../backend/src/db/documentTemplatesQueries', () => ({
    listForCompany: jest.fn(),
    getByIdScoped: jest.fn(),
    getDefaultByType: jest.fn(),
    updateContentScoped: jest.fn(),
    insertSeed: jest.fn(),
}));

const queries = require('../../backend/src/db/documentTemplatesQueries');
const factory = require('../../backend/src/services/documentTemplates/factory');
const { validateDescriptor } = require('../../backend/src/services/documentTemplates/validator');
const service = require('../../backend/src/services/documentTemplatesService');

const COMPANY = '00000000-0000-0000-0000-000000000001';

afterEach(() => jest.clearAllMocks());

describe('validator (schema v1)', () => {
    test('factory descriptor is valid', () => {
        const result = validateDescriptor(factory.getFactory('estimate'));
        expect(result.valid).toBe(true);
    });

    test('rejects missing brand.name', () => {
        const d = factory.getFactory('estimate');
        delete d.brand.name;
        const result = validateDescriptor(d);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.path.includes('/brand/name'))).toBe(true);
    });

    test('rejects invalid hex color', () => {
        const d = factory.getFactory('estimate');
        d.theme.accent = '#zzz';
        const result = validateDescriptor(d);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.path.includes('/theme/accent'))).toBe(true);
    });

    test('rejects unknown section key', () => {
        const d = factory.getFactory('estimate');
        d.sections.push({ key: 'malicious', visible: true });
        const result = validateDescriptor(d);
        expect(result.valid).toBe(false);
    });

    test('rejects schema_version != 1', () => {
        const d = factory.getFactory('estimate');
        d.schema_version = 2;
        const result = validateDescriptor(d);
        expect(result.valid).toBe(false);
    });

    test('rejects empty sections array', () => {
        const d = factory.getFactory('estimate');
        d.sections = [];
        const result = validateDescriptor(d);
        expect(result.valid).toBe(false);
    });
});

describe('service.resolveTemplate', () => {
    test('returns stored content when valid', async () => {
        const stored = factory.getFactory('estimate');
        stored.brand.name = 'Custom Co.';
        queries.getDefaultByType.mockResolvedValueOnce({ content: stored });
        const out = await service.resolveTemplate(COMPANY, 'estimate');
        expect(out.brand.name).toBe('Custom Co.');
        expect(queries.getDefaultByType).toHaveBeenCalledWith(COMPANY, 'estimate');
    });

    test('falls back to factory when no row', async () => {
        queries.getDefaultByType.mockResolvedValueOnce(null);
        const out = await service.resolveTemplate(COMPANY, 'estimate');
        expect(out.brand.name).toBe(factory.getFactory('estimate').brand.name);
    });

    test('falls back to factory when stored content is corrupt', async () => {
        queries.getDefaultByType.mockResolvedValueOnce({ content: { schema_version: 1, broken: true } });
        const out = await service.resolveTemplate(COMPANY, 'estimate');
        expect(out.brand).toBeDefined();
        expect(out.brand.name).toBe(factory.getFactory('estimate').brand.name);
    });

    test('falls back to factory on unknown document_type', async () => {
        // NOTE: 'invoice' became a registered type via SEND-DOC-001; use a truly
        // unregistered type so this asserts the real "unknown → null" contract.
        const out = await service.resolveTemplate(COMPANY, 'not_a_real_document_type');
        expect(out).toBeNull(); // factory.getFactory returns null for unregistered types
    });
});

describe('service.updateTemplate', () => {
    test('rejects invalid descriptor with 422', async () => {
        queries.getByIdScoped.mockResolvedValueOnce({ id: 1, document_type: 'estimate' });
        const bad = factory.getFactory('estimate');
        bad.theme.accent = 'not-a-hex';
        await expect(
            service.updateTemplate(COMPANY, 1, { content: bad }),
        ).rejects.toMatchObject({ code: 'validation_failed', httpStatus: 422 });
    });

    test('persists valid descriptor', async () => {
        queries.getByIdScoped.mockResolvedValueOnce({ id: 1, document_type: 'estimate' });
        queries.updateContentScoped.mockResolvedValueOnce({
            id: 1,
            company_id: COMPANY,
            document_type: 'estimate',
            name: 'Default',
            slug: 'default',
            is_default: true,
            schema_version: 1,
            content: factory.getFactory('estimate'),
            archived_at: null,
            created_at: 'x', updated_at: 'x',
        });
        const out = await service.updateTemplate(COMPANY, 1, { content: factory.getFactory('estimate') });
        expect(out.id).toBe(1);
        expect(queries.updateContentScoped).toHaveBeenCalled();
    });

    test('throws template_not_found for cross-company id', async () => {
        queries.getByIdScoped.mockResolvedValueOnce(null);
        await expect(
            service.updateTemplate(COMPANY, 999, { content: factory.getFactory('estimate') }),
        ).rejects.toMatchObject({ code: 'template_not_found', httpStatus: 404 });
    });
});

describe('service.resetTemplate', () => {
    test('overwrites with factory descriptor', async () => {
        queries.getByIdScoped.mockResolvedValueOnce({ id: 1, document_type: 'estimate' });
        queries.updateContentScoped.mockResolvedValueOnce({
            id: 1,
            company_id: COMPANY,
            document_type: 'estimate',
            name: 'Default',
            slug: 'default',
            is_default: true,
            schema_version: 1,
            content: factory.getFactory('estimate'),
            archived_at: null,
            created_at: 'x', updated_at: 'x',
        });
        const out = await service.resetTemplate(COMPANY, 1);
        expect(out.content.brand.name).toBe(factory.getFactory('estimate').brand.name);
    });
});
