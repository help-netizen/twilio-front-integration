/**
 * Renderer adapter for document_type='estimate'.
 * Wraps `estimatePdfService.renderEstimatePdf` to satisfy the registry contract.
 */

'use strict';

const { renderEstimatePdf } = require('../estimatePdfService');

module.exports = {
    documentType: 'estimate',
    render(estimate, descriptor) {
        return renderEstimatePdf(estimate, descriptor);
    },
    /**
     * Returns a serializable preview model for the HTML preview.
     * Frontend consumes (estimate, descriptor) directly to render React,
     * so this stays a passthrough — the contract exists for symmetry.
     */
    renderHtml(estimate, descriptor) {
        return { estimate, descriptor };
    },
};
