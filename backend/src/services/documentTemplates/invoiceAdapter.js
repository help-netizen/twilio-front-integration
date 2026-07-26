/**
 * Renderer adapter for document_type='invoice'.
 * Wraps the invoice PDF Document builder to satisfy the registry contract.
 */

'use strict';

const React = require('react');
const { stripInternalOrderList } = require('../../utils/orderList');

let cachedReactPdf = null;
async function getReactPdf() {
    if (!cachedReactPdf) cachedReactPdf = await import('@react-pdf/renderer');
    return cachedReactPdf;
}

module.exports = {
    documentType: 'invoice',
    /**
     * @param {object} invoice - full invoice row (with items[])
     * @param {object} descriptor - resolved template descriptor (v1)
     * @returns {Promise<Buffer>}
     */
    async render(invoice, descriptor) {
        const reactPdf = await getReactPdf();
        const { buildInvoicePdfElement } = require('./invoicePdfDocument');
        const element = buildInvoicePdfElement({
            invoice: stripInternalOrderList(invoice),
            descriptor,
        }, reactPdf);
        return await reactPdf.renderToBuffer(element);
    },
    renderHtml(invoice, descriptor) {
        return { invoice: stripInternalOrderList(invoice), descriptor };
    },
};
