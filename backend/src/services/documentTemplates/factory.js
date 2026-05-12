/**
 * Factory descriptors per document_type.
 *
 * The factory descriptor is the canonical, hardcoded baseline used when:
 *   - seeding a new tenant in migration 084,
 *   - the renderer cannot find a stored template (defensive fallback),
 *   - the user clicks "Reset to default" in the editor.
 *
 * Mirrors the legacy hardcoded constants in estimatePdfService.js byte-for-byte.
 */

'use strict';

const DEFAULT_TERMS_AND_WARRANTY = `TERMS: Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.

WARRANTY:
- 90-day labor warranty covering workmanship and the completed repair, starting from the date the repair is finished.
- OEM parts warranty is extended to a minimum of 90 days, even if the manufacturer's standard warranty is shorter.
- A service visit during the warranty period is provided at no additional charge if the issue is related to the repaired component or workmanship.
- Warranty does not cover misuse, physical damage, power issues, water damage, improper installation, or failures unrelated to the replaced component.`;

const ESTIMATE_FACTORY = Object.freeze({
    schema_version: 1,
    brand: Object.freeze({
        name: 'ABC Homes',
        address: '2502 Village Rd W, Norwood, MA 02062, USA',
        email: 'help@bostonmasters.com',
        phone: '(508) 290-4442',
        logo_url: null,
        ach: Object.freeze({
            bank: 'Bank Of America',
            routing_number: '011000138',
            account_number: '466020155621',
        }),
    }),
    theme: Object.freeze({
        ink: '#172033',
        muted: '#5f7085',
        faint: '#eef3f8',
        surface: '#fbfcfe',
        border: '#d8e0ea',
        accent: '#2563eb',
        danger: '#be123c',
    }),
    sections: Object.freeze([
        Object.freeze({ key: 'logo', visible: true, width: 'third', glue_with_next: true }),
        Object.freeze({ key: 'header', visible: true, width: 'third' }),
        Object.freeze({ key: 'document_meta', visible: true, width: 'third' }),
        Object.freeze({ key: 'ach', visible: true, width: 'full' }),
        Object.freeze({ key: 'client_addresses', visible: true, width: 'full' }),
        Object.freeze({ key: 'summary', visible: true, width: 'full' }),
        Object.freeze({ key: 'items', visible: true, width: 'full' }),
        Object.freeze({ key: 'totals', visible: true, width: 'full' }),
        Object.freeze({ key: 'terms', visible: true, body_md: DEFAULT_TERMS_AND_WARRANTY, width: 'full' }),
    ]),
    footer: Object.freeze({ show_page_number: true, text_md: null }),
});

// Invoices share the same Terms & Warranty body as estimates per product spec.
const DEFAULT_INVOICE_TERMS = DEFAULT_TERMS_AND_WARRANTY;

const INVOICE_FACTORY = Object.freeze({
    schema_version: 1,
    brand: Object.freeze({
        name: 'ABC Homes',
        address: '2502 Village Rd W, Norwood, MA 02062, USA',
        email: 'help@bostonmasters.com',
        phone: '(508) 290-4442',
        logo_url: null,
        ach: Object.freeze({
            bank: 'Bank Of America',
            routing_number: '011000138',
            account_number: '466020155621',
        }),
    }),
    theme: Object.freeze({
        ink: '#172033',
        muted: '#5f7085',
        faint: '#eef3f8',
        surface: '#fbfcfe',
        border: '#d8e0ea',
        // Teal accent — visually distinguishes invoices from estimates (blue).
        accent: '#0f766e',
        danger: '#be123c',
    }),
    sections: Object.freeze([
        Object.freeze({ key: 'logo', visible: true, width: 'third', glue_with_next: true }),
        Object.freeze({ key: 'header', visible: true, width: 'third' }),
        Object.freeze({ key: 'document_meta', visible: true, width: 'third' }),
        Object.freeze({ key: 'ach', visible: true, width: 'full' }),
        Object.freeze({ key: 'client_addresses', visible: true, width: 'full' }),
        Object.freeze({ key: 'summary', visible: true, width: 'full' }),
        Object.freeze({ key: 'items', visible: true, width: 'full' }),
        Object.freeze({ key: 'totals', visible: true, width: 'full' }),
        Object.freeze({ key: 'terms', visible: true, body_md: DEFAULT_INVOICE_TERMS, width: 'full' }),
    ]),
    footer: Object.freeze({ show_page_number: true, text_md: null }),
    // Invoice-only defaults. `default_due_days` drives auto-population of due_date
    // on newly created invoices when the caller doesn't supply one. 14 = "Net 14".
    invoice_settings: Object.freeze({ default_due_days: 14 }),
});

const FACTORIES = Object.freeze({
    estimate: ESTIMATE_FACTORY,
    invoice: INVOICE_FACTORY,
});

function getFactory(documentType) {
    const factory = FACTORIES[documentType];
    if (!factory) return null;
    // Return a deep clone so callers can mutate freely without breaking the frozen object.
    return JSON.parse(JSON.stringify(factory));
}

function listDocumentTypes() {
    return Object.keys(FACTORIES);
}

module.exports = {
    getFactory,
    listDocumentTypes,
    DEFAULT_TERMS_AND_WARRANTY,
    ESTIMATE_FACTORY,
};
