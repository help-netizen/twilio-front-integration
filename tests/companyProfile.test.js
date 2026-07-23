'use strict';

/**
 * COMPANY-PROFILE-001 — companyProfileService + resolveTemplate brand overlay.
 *
 * Covers:
 *  - updateProfile whitelists (accepts name/contact/payment; rejects status/company_id/slug/...).
 *  - updateProfile rejects an empty name (422).
 *  - getProfile maps payment_* → payment.* and presigns the logo.
 *  - buildBrand omits empty fields and maps payment_* → ach.* (exact factory ach names).
 *  - resolveTemplate overlays the profile brand over the factory default (name replaces
 *    'ABC Homes', ach.account_number replaces the factory placeholder) and SAFE-FAILS
 *    (never throws) when the profile fetch blows up.
 *
 * Strategy mirrors technicianBaseLocations/slotEngineSettings: db.query +
 * storageService are jest.mocked; companyQueries.updateCompany is spied; the real
 * services run over the mocks.
 *
 * Run:
 *   node ./node_modules/.bin/jest tests/companyProfile.test.js \
 *     --testPathIgnorePatterns "/node_modules/" --runInBand --forceExit
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/storageService', () => ({
    generateStorageKey: jest.fn(() => 'company-logos/co-a/logo.png'),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    getPresignedUrl: jest.fn().mockResolvedValue('https://signed.example/logo.png'),
    deleteFile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/db/companyQueries', () => ({
    updateCompany: jest.fn().mockResolvedValue({}),
}));
// Keep document-templates' renderer bootstrap and stored-row lookup inert.
jest.mock('../backend/src/db/documentTemplatesQueries', () => ({
    getDefaultByType: jest.fn().mockResolvedValue(null),
}));

const db = require('../backend/src/db/connection');
const storageService = require('../backend/src/services/storageService');
const companyQueries = require('../backend/src/db/companyQueries');
const docTplQueries = require('../backend/src/db/documentTemplatesQueries');

const svc = require('../backend/src/services/companyProfileService');
const documentTemplatesService = require('../backend/src/services/documentTemplatesService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';

/** Make db.query (the company SELECT) return a given companies row. */
function mockCompanyRow(row) {
    db.query.mockResolvedValue({ rows: row ? [row] : [] });
}

const FULL_ROW = {
    id: COMPANY_A,
    name: 'Acme Plumbing',
    contact_email: 'hi@acme.test',
    contact_phone: '(555) 111-2222',
    billing_email: 'billing@acme.test',
    city: 'Boston',
    state: 'MA',
    zip: '02118',
    lat: 42.3,
    lng: -71.0,
    logo_storage_key: 'company-logos/co-a/logo.png',
    payment_bank_name: 'Acme Credit Union',
    payment_account_name: 'Acme Plumbing LLC',
    payment_account_number: '999888777',
    payment_routing_number: '011000000',
    payment_swift: 'ACMEUS33',
    payment_instructions: 'Reference your invoice number.',
};

beforeEach(() => {
    db.query.mockReset();
    companyQueries.updateCompany.mockReset().mockResolvedValue({});
    docTplQueries.getDefaultByType.mockReset().mockResolvedValue(null);
    storageService.generateStorageKey.mockClear();
    storageService.uploadFile.mockClear().mockResolvedValue(undefined);
    storageService.getPresignedUrl.mockReset().mockResolvedValue('https://signed.example/logo.png');
    storageService.deleteFile.mockClear().mockResolvedValue(undefined);
});

describe('updateProfile — whitelist', () => {
    it('accepts name/contact/payment fields and forwards only those to updateCompany', async () => {
        mockCompanyRow(FULL_ROW); // getProfile re-read at the end
        await svc.updateProfile(COMPANY_A, {
            name: '  New Co  ',
            contact_email: 'new@co.test',
            contact_phone: '(555) 000-0000',
            billing_email: 'bill@co.test',
            payment_bank_name: 'Chase',
            payment_account_name: 'New Co LLC',
            payment_account_number: '12345',
            payment_routing_number: '021000021',
            payment_swift: 'CHASUS33',
            payment_instructions: 'Net 14',
        });
        expect(companyQueries.updateCompany).toHaveBeenCalledTimes(1);
        const [cid, fields] = companyQueries.updateCompany.mock.calls[0];
        expect(cid).toBe(COMPANY_A);
        expect(fields.name).toBe('New Co'); // trimmed
        expect(fields.contact_email).toBe('new@co.test');
        expect(fields.payment_bank_name).toBe('Chase');
        expect(fields.payment_account_number).toBe('12345');
        expect(fields.payment_swift).toBe('CHASUS33');
    });

    it('drops status/company_id/slug/zenbooker_api_key/timezone (never forwarded)', async () => {
        mockCompanyRow(FULL_ROW);
        await svc.updateProfile(COMPANY_A, {
            name: 'Acme',
            status: 'suspended',
            company_id: 'evil',
            slug: 'hacked',
            zenbooker_api_key: 'leak',
            timezone: 'UTC',
            locale: 'fr-FR',
        });
        const [, fields] = companyQueries.updateCompany.mock.calls[0];
        expect(fields).toEqual({ name: 'Acme' });
        expect(fields).not.toHaveProperty('status');
        expect(fields).not.toHaveProperty('company_id');
        expect(fields).not.toHaveProperty('slug');
        expect(fields).not.toHaveProperty('zenbooker_api_key');
        expect(fields).not.toHaveProperty('timezone');
    });

    it('rejects an empty name with a 422 and writes nothing', async () => {
        await expect(svc.updateProfile(COMPANY_A, { name: '   ' }))
            .rejects.toMatchObject({ httpStatus: 422, code: 'INVALID_NAME' });
        expect(companyQueries.updateCompany).not.toHaveBeenCalled();
    });
});

describe('getProfile — mapping + presign', () => {
    it('maps payment_* → payment.* and presigns the logo', async () => {
        mockCompanyRow(FULL_ROW);
        const profile = await svc.getProfile(COMPANY_A);
        expect(profile.name).toBe('Acme Plumbing');
        expect(profile.contact_email).toBe('hi@acme.test');
        expect(profile.city).toBe('Boston');
        expect(profile.logo_url).toBe('https://signed.example/logo.png');
        expect(storageService.getPresignedUrl).toHaveBeenCalledWith('company-logos/co-a/logo.png');
        expect(profile.payment).toEqual({
            bank_name: 'Acme Credit Union',
            account_name: 'Acme Plumbing LLC',
            account_number: '999888777',
            routing_number: '011000000',
            swift: 'ACMEUS33',
            instructions: 'Reference your invoice number.',
        });
    });

    it('logo_url is null when there is no stored key (no presign attempted)', async () => {
        mockCompanyRow({ ...FULL_ROW, logo_storage_key: null });
        const profile = await svc.getProfile(COMPANY_A);
        expect(profile.logo_url).toBeNull();
        expect(storageService.getPresignedUrl).not.toHaveBeenCalled();
    });
});

describe('buildBrand — overlay shape', () => {
    it('omits empty fields and maps payment_* → ach.* (factory ach names)', async () => {
        mockCompanyRow({
            id: COMPANY_A,
            name: 'Acme Plumbing',
            contact_email: '   ', // empty after trim → omitted
            contact_phone: null,
            billing_email: null,
            city: 'Boston',
            state: 'MA',
            zip: '02118',
            logo_storage_key: null, // → no logo_url key
            payment_bank_name: 'Acme Credit Union',
            payment_account_number: '999888777',
            payment_routing_number: null, // omitted
            payment_account_name: null,
            payment_swift: null,
            payment_instructions: null,
        });
        const brand = await svc.buildBrand(COMPANY_A);
        expect(brand.name).toBe('Acme Plumbing');
        expect(brand.address).toBe('Boston, MA 02118');
        expect(brand).not.toHaveProperty('email'); // whitespace-only → omitted
        expect(brand).not.toHaveProperty('phone');
        expect(brand).not.toHaveProperty('logo_url');
        // ach mapped with EXACT factory field names; empty fields omitted.
        expect(brand.ach).toEqual({ bank: 'Acme Credit Union', account_number: '999888777' });
        expect(brand.ach).not.toHaveProperty('routing_number');
    });

    it('returns {} (no ach) when nothing is set', async () => {
        mockCompanyRow({ id: COMPANY_A, name: null });
        const brand = await svc.buildBrand(COMPANY_A);
        expect(brand).toEqual({});
    });
});

describe('uploadLogo', () => {
    it('uploads, sets logo_storage_key, deletes the previous object, returns presigned url', async () => {
        // First read (prev row) has an OLD key; generateStorageKey returns a NEW one.
        mockCompanyRow({ ...FULL_ROW, logo_storage_key: 'company-logos/co-a/old.png' });
        storageService.generateStorageKey.mockReturnValueOnce('company-logos/co-a/new.png');
        const out = await svc.uploadLogo(COMPANY_A, {
            buffer: Buffer.from('img'), mimetype: 'image/png', originalname: 'logo.png',
        });
        expect(storageService.uploadFile).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', 'company-logos/co-a/new.png');
        expect(companyQueries.updateCompany).toHaveBeenCalledWith(COMPANY_A, { logo_storage_key: 'company-logos/co-a/new.png' });
        expect(storageService.deleteFile).toHaveBeenCalledWith('company-logos/co-a/old.png');
        expect(out.logo_url).toBe('https://signed.example/logo.png');
    });

    it('400s when no file buffer is supplied', async () => {
        await expect(svc.uploadLogo(COMPANY_A, null))
            .rejects.toMatchObject({ httpStatus: 400, code: 'NO_FILE' });
    });
});

describe('resolveTemplate — company brand overlay', () => {
    it('overlays profile brand over the factory default (name + ach.account_number win)', async () => {
        docTplQueries.getDefaultByType.mockResolvedValue(null); // → factory fallback
        // Profile read used by buildBrand.
        mockCompanyRow({
            id: COMPANY_A,
            name: 'Overlay Co',
            contact_email: 'overlay@co.test',
            contact_phone: null,
            city: 'Boston', state: 'MA', zip: '02118',
            logo_storage_key: null,
            payment_bank_name: null, // empty → keep factory bank
            payment_account_number: '111222333', // wins over factory placeholder
            payment_routing_number: null,
        });
        const descriptor = await documentTemplatesService.resolveTemplate(COMPANY_A, 'invoice');
        // Profile non-empty values win.
        expect(descriptor.brand.name).toBe('Overlay Co');
        expect(descriptor.brand.name).not.toBe('ABC Homes');
        expect(descriptor.brand.email).toBe('overlay@co.test');
        expect(descriptor.brand.ach.account_number).toBe('111222333');
        // Empty profile fields keep the factory values (field-by-field ach merge).
        expect(descriptor.brand.ach.bank).toBe('Bank Of America');
        expect(descriptor.brand.ach.routing_number).toBe('011000138');
        // Non-brand parts of the descriptor are intact.
        expect(descriptor.schema_version).toBe(1);
        expect(Array.isArray(descriptor.sections)).toBe(true);
    });

    it('does NOT mutate the frozen factory brand', async () => {
        const factory = require('../backend/src/services/documentTemplates/factory');
        docTplQueries.getDefaultByType.mockResolvedValue(null);
        mockCompanyRow({ id: COMPANY_A, name: 'Mutator Co', payment_account_number: 'ZZZ' });
        await documentTemplatesService.resolveTemplate(COMPANY_A, 'estimate');
        // The canonical frozen factory is untouched.
        expect(factory.ESTIMATE_FACTORY.brand.name).toBe('ABC Homes');
        expect(factory.ESTIMATE_FACTORY.brand.ach.account_number).toBe('466020155621');
    });

    it('keeps non-empty template brand fields when a tenant template exists (template wins — DBA on docs preserved)', async () => {
        // Real prod case: company name is "Boston Masters" (SMS) but the stored
        // invoice template brand is the DBA "ABC Homes". The profile must NOT
        // clobber the customized template brand ("templates can override").
        const factory = require('../backend/src/services/documentTemplates/factory');
        const stored = JSON.parse(JSON.stringify(factory.getFactory('invoice')));
        stored.brand.name = 'ABC Homes';
        docTplQueries.getDefaultByType.mockResolvedValue({ content: stored });
        mockCompanyRow({ id: COMPANY_A, name: 'Boston Masters', payment_account_number: '111222333' });
        const descriptor = await documentTemplatesService.resolveTemplate(COMPANY_A, 'invoice');
        expect(descriptor.brand.name).toBe('ABC Homes');           // template DBA preserved
        expect(descriptor.brand.name).not.toBe('Boston Masters');  // profile did NOT override
        expect(descriptor.brand.ach.account_number).toBe('466020155621'); // template ach kept
    });

    it('OB-34: fills EMPTY stored-template brand fields from the profile (logo saved after the template)', async () => {
        // The stored template predates the tenant's logo upload: its brand has no
        // logo_url. The profile underlay must supply the logo (and any other
        // empty field) WITHOUT touching the template's deliberate non-empty
        // values — otherwise "No logo" is pinned forever on documents.
        const factory = require('../backend/src/services/documentTemplates/factory');
        const stored = JSON.parse(JSON.stringify(factory.getFactory('invoice')));
        stored.brand.name = 'ABC Homes';
        delete stored.brand.logo_url;
        stored.brand.phone = '';
        docTplQueries.getDefaultByType.mockResolvedValue({ content: stored });
        mockCompanyRow({
            id: COMPANY_A,
            name: 'Boston Masters',
            contact_phone: '+15082904442',
            logo_storage_key: 'company-logos/co-a/logo.png',
        });
        const descriptor = await documentTemplatesService.resolveTemplate(COMPANY_A, 'invoice');
        expect(descriptor.brand.logo_url).toBe('https://signed.example/logo.png'); // profile fills the gap
        expect(descriptor.brand.phone).toBe('+15082904442');                       // empty template phone filled
        expect(descriptor.brand.name).toBe('ABC Homes');                           // non-empty template still wins
    });

    it('safe-fails to the un-overlaid factory descriptor when the profile fetch throws', async () => {
        docTplQueries.getDefaultByType.mockResolvedValue(null);
        db.query.mockRejectedValue(new Error('db down')); // buildBrand's company read explodes
        let descriptor;
        await expect((async () => { descriptor = await documentTemplatesService.resolveTemplate(COMPANY_A, 'invoice'); })())
            .resolves.toBeUndefined(); // i.e. it did NOT throw
        expect(descriptor).toBeTruthy();
        expect(descriptor.brand.name).toBe('ABC Homes'); // un-overlaid factory
        expect(descriptor.schema_version).toBe(1);
    });
});
