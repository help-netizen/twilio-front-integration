'use strict';

const MAX_SPOKEN_ITEMS = 5;

function toAmount(value) {
    const number = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(number) ? number : 0;
}

function cleanItemName(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/\s+/g, ' ')
        .split(' ')
        // Do not speak code-like tokens (SKU / part-number fragments). A token
        // needs both a letter and a digit to be treated as a code; ordinary item
        // words and quantities remain intact.
        .filter((token) => !(token.length >= 4 && /[a-z]/i.test(token) && /\d/.test(token)))
        .join(' ')
        .replace(/\b(?:sku|part number|item code)\s*[:#-]?\s*$/i, '')
        .trim()
        .slice(0, 120);
}

function sanitizeLineItems(items) {
    const customerItems = (Array.isArray(items) ? items : [])
        .map((item) => ({
            name: cleanItemName(item && item.name),
            quantity: toAmount(item && item.quantity),
            amount: toAmount(item && item.amount),
        }))
        .filter((item) => item.name.length > 0);
    return {
        itemCount: customerItems.length,
        lineItems: customerItems.slice(0, MAX_SPOKEN_ITEMS),
        remainingItemCount: Math.max(0, customerItems.length - MAX_SPOKEN_ITEMS),
    };
}

function money(value) {
    return `$${toAmount(value).toFixed(2)}`;
}

function itemSpeech(lineItems) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) return '';
    return lineItems
        .map((item) => `${item.name}, quantity ${item.quantity}, ${money(item.amount)}`)
        .join('; ');
}

function totalsFrom(document) {
    return {
        subtotal: toAmount(document && document.subtotal),
        discount: toAmount(document && document.discount_amount),
        tax: toAmount(document && document.tax_amount),
        total: toAmount(document && document.total),
    };
}

function totalsSpeech(totals) {
    const parts = [`The subtotal is ${money(totals.subtotal)}`];
    if (totals.discount > 0) parts.push(`the discount is ${money(totals.discount)}`);
    if (totals.tax > 0) parts.push(`tax is ${money(totals.tax)}`);
    parts.push(`the total is ${money(totals.total)}`);
    return `${parts.join(', ')}.`;
}

function writtenDocumentOffer(remainingItemCount) {
    if (remainingItemCount > 0) {
        return ` There ${remainingItemCount === 1 ? 'is' : 'are'} ${remainingItemCount} more ${remainingItemCount === 1 ? 'item' : 'items'}; I can send the complete written document.`;
    }
    return ' I can send the written document if you would like it.';
}

module.exports = {
    MAX_SPOKEN_ITEMS,
    itemSpeech,
    money,
    sanitizeLineItems,
    toAmount,
    totalsFrom,
    totalsSpeech,
    writtenDocumentOffer,
};
