/**
 * Renderer registry mapping document_type -> adapter.
 *
 * Adapter contract:
 *   render(entity, descriptor) -> Buffer (PDF bytes)
 *   renderHtml?(entity, descriptor) -> serializable preview model (optional)
 *
 * Adding a new document type = registering an adapter; nothing else here changes.
 */

'use strict';

const adapters = new Map();

function register(documentType, adapter) {
    if (!adapter || typeof adapter.render !== 'function') {
        throw new Error(`renderer adapter for "${documentType}" must implement render(entity, descriptor)`);
    }
    adapters.set(documentType, adapter);
}

function get(documentType) {
    return adapters.get(documentType) || null;
}

function listRegistered() {
    return Array.from(adapters.keys());
}

module.exports = {
    register,
    get,
    listRegistered,
};
