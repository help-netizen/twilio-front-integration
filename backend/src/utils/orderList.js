'use strict';

const MAX_ORDER_LIST_ROWS = 60;
const MAX_PART_NUMBER_CHARS = 100;
const MAX_PART_NAME_CHARS = 200;

class OrderListValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OrderListValidationError';
        this.code = 'VALIDATION';
        this.httpStatus = 400;
    }
}

function cleanString(value, maxLength) {
    return typeof value === 'string'
        ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
        : '';
}

function normalizeOrderList(value) {
    if (!Array.isArray(value)) {
        throw new OrderListValidationError('order_list must be an array');
    }
    if (value.length > MAX_ORDER_LIST_ROWS) {
        throw new OrderListValidationError(
            `order_list cannot contain more than ${MAX_ORDER_LIST_ROWS} rows`
        );
    }

    return value.map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new OrderListValidationError(`order_list row ${index + 1} must be an object`);
        }

        const partNumber = cleanString(row.part_number, MAX_PART_NUMBER_CHARS);
        const partName = cleanString(row.part_name, MAX_PART_NAME_CHARS);
        const quantity = Number(row.quantity);

        if (!partNumber) {
            throw new OrderListValidationError(
                `order_list row ${index + 1} requires part_number`
            );
        }
        if (!partName) {
            throw new OrderListValidationError(
                `order_list row ${index + 1} requires part_name`
            );
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new OrderListValidationError(
                `order_list row ${index + 1} quantity must be a positive number`
            );
        }

        return {
            part_number: partNumber,
            part_name: partName,
            quantity,
        };
    });
}

/**
 * Remove the internal order list from a customer-facing payload, including
 * nested revision/snapshot JSON. Preserve Date/Buffer and other non-plain
 * objects instead of attempting to clone them.
 */
function stripInternalOrderList(value) {
    if (Array.isArray(value)) return value.map(stripInternalOrderList);
    if (!value || typeof value !== 'object') return value;

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;

    const safe = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === 'order_list') continue;
        safe[key] = stripInternalOrderList(child);
    }
    return safe;
}

module.exports = {
    MAX_ORDER_LIST_ROWS,
    MAX_PART_NAME_CHARS,
    MAX_PART_NUMBER_CHARS,
    OrderListValidationError,
    cleanString,
    normalizeOrderList,
    stripInternalOrderList,
};
