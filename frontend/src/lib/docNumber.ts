/**
 * Stored document numbers carry the word inside them: "INVOICE 1668-2",
 * "ESTIMATE L1042-1" (backend `invoicesQueries.invoiceNumberPrefix`). Any surface that
 * says the word itself must print the SHORT number, or it reads doubled — "Remove
 * invoice INVOICE 1668-2?", "Open invoice #INVOICE 1668-2".
 *
 * Mirrors backend/src/utils/docNumber.js. Two runtimes, one rule.
 */
export function shortDocNumber(value: string | null | undefined): string {
    return String(value || '').replace(/^(?:INVOICE|ESTIMATE)\s+/i, '').trim();
}
