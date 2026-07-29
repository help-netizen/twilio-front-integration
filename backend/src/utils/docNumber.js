'use strict';

/**
 * Stored document numbers carry the doc word inside ("INVOICE L-1439-1",
 * "ESTIMATE L-53-5"). Any surface that says the word itself ("Invoice …",
 * "Estimate …", "Invoice-….pdf") must use the SHORT number, or it reads
 * doubled: "Invoice #INVOICE L-1439-1".
 */
function shortDocNumber(value) {
    return String(value || '').replace(/^(?:INVOICE|ESTIMATE)\s+/i, '').trim();
}

module.exports = { shortDocNumber };
