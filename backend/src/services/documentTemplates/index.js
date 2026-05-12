/**
 * Bootstrap: registers all known renderer adapters with the registry.
 * Import this once (from `src/server.js` startup) to ensure the registry is populated.
 */

'use strict';

const rendererRegistry = require('./rendererRegistry');
const estimateAdapter = require('./estimateAdapter');
const invoiceAdapter = require('./invoiceAdapter');

for (const adapter of [estimateAdapter, invoiceAdapter]) {
    if (!rendererRegistry.get(adapter.documentType)) {
        rendererRegistry.register(adapter.documentType, adapter);
    }
}

module.exports = rendererRegistry;
