'use strict';

const MAX_SUBSCRIPTIONS = 5;
const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;

const APP_EVENT_CATALOG = Object.freeze([
    Object.freeze({
        type: 'estimate.approved',
        description: 'An estimate was approved by a user or accepted by the client.',
        payload_schema: Object.freeze({
            estimate_id: 'record id',
            estimate_number: 'display number or null',
            public_code: 'durable global estimate code or null',
            job_id: 'related job id or null',
            contact_id: 'related contact id or null',
            order_list_count: 'number of order-list entries',
        }),
    }),
    Object.freeze({
        type: 'job.status_changed',
        description: 'A job moved from one workflow status to another.',
        payload_schema: Object.freeze({
            job_id: 'record id',
            job_number: 'legacy Zenbooker number or null',
            job_seq: 'per-company display number or null',
            public_code: 'durable global job code or null',
            old_status: 'previous status or null',
            new_status: 'current status',
        }),
    }),
    Object.freeze({
        type: 'lead.created',
        description: 'A lead was created in Albusto.',
        payload_schema: Object.freeze({
            lead_id: 'record id',
            serial_id: 'display serial id or null',
            source: 'lead source or null',
        }),
    }),
    Object.freeze({
        type: 'payment.recorded',
        description: 'A completed payment was recorded in the ledger.',
        payload_schema: Object.freeze({
            payment_id: 'record id',
            job_id: 'related job id or null',
            invoice_id: 'related invoice id or null',
            amount: 'payment amount',
        }),
    }),
    Object.freeze({
        type: 'invoice.sent',
        description: 'An invoice was successfully sent to a client.',
        payload_schema: Object.freeze({
            invoice_id: 'record id',
            invoice_number: 'display number or null',
            public_code: 'durable global invoice code or null',
            job_id: 'related job id or null',
            total: 'invoice total',
        }),
    }),
]);

const APP_EVENT_TYPES = Object.freeze(APP_EVENT_CATALOG.map(event => event.type));
const catalogByType = new Map(APP_EVENT_CATALOG.map(event => [event.type, event]));

class AppEventValidationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AppEventValidationError';
        this.code = code;
        this.httpStatus = 422;
    }
}

function invalidSubscriptions(message) {
    throw new AppEventValidationError('APP_EVENT_SUBSCRIPTIONS_INVALID', message);
}

function validateSubscriptions(value) {
    if (!Array.isArray(value)) invalidSubscriptions('subscribes must be an array.');
    if (value.length > MAX_SUBSCRIPTIONS) {
        invalidSubscriptions(`subscribes must contain no more than ${MAX_SUBSCRIPTIONS} events.`);
    }
    const seen = new Set();
    return value.map((eventType, index) => {
        if (typeof eventType !== 'string' || !catalogByType.has(eventType)) {
            invalidSubscriptions(`subscribes[${index}] is not a supported app event.`);
        }
        if (seen.has(eventType)) {
            invalidSubscriptions(`subscribes[${index}] must be unique.`);
        }
        seen.add(eventType);
        return eventType;
    });
}

function invalidSyntheticEvent(message) {
    throw new AppEventValidationError('APP_EVENT_INPUT_INVALID', message);
}

function validateSyntheticEvent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalidSyntheticEvent('event must be an object.');
    }
    if (Object.keys(value).length !== 2
        || !Object.prototype.hasOwnProperty.call(value, 'type')
        || !Object.prototype.hasOwnProperty.call(value, 'payload')) {
        invalidSyntheticEvent('event must contain exactly type and payload.');
    }
    if (typeof value.type !== 'string' || !catalogByType.has(value.type)) {
        invalidSyntheticEvent('event.type is not a supported app event.');
    }
    if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
        invalidSyntheticEvent('event.payload must be an object.');
    }
    let encoded;
    try {
        encoded = JSON.stringify(value.payload);
    } catch (_error) {
        invalidSyntheticEvent('event.payload must be JSON-serializable.');
    }
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
        invalidSyntheticEvent(`event.payload must not exceed ${MAX_EVENT_PAYLOAD_BYTES} bytes.`);
    }
    return { type: value.type, payload: value.payload };
}

function projectAppEventPayload(eventType, payload) {
    const definition = catalogByType.get(eventType);
    if (!definition || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }
    return Object.keys(definition.payload_schema).reduce((projected, key) => {
        if (Object.prototype.hasOwnProperty.call(payload, key)) projected[key] = payload[key];
        return projected;
    }, {});
}

function renderAppEventCatalogContract() {
    const events = APP_EVENT_CATALOG.flatMap(event => [
        `- ${event.type}: ${event.description}`,
        `  payload: {${Object.entries(event.payload_schema)
            .map(([field, description]) => `${field}: ${description}`)
            .join(', ')}}`,
    ]);
    return [
        'APP EVENT SUBSCRIPTIONS CONTRACT:',
        'Declare event subscriptions next to actions and data_collections, for example:',
        '"subscribes":["estimate.approved"]',
        `Use only the closed catalog below, at most ${MAX_SUBSCRIPTIONS} unique events. Use [] when no subscription is needed.`,
        'When a subscribed event starts the app, read ctx.input.event as {type, payload}.',
        'The event payload is intentionally PII-lean; load current CRM state through declared read tools when needed.',
        ...events,
    ].join('\n');
}

module.exports = {
    APP_EVENT_CATALOG,
    APP_EVENT_TYPES,
    MAX_EVENT_PAYLOAD_BYTES,
    MAX_SUBSCRIPTIONS,
    AppEventValidationError,
    projectAppEventPayload,
    renderAppEventCatalogContract,
    validateSubscriptions,
    validateSyntheticEvent,
};
