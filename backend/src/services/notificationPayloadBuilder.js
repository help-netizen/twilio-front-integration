'use strict';

const { getNotificationCatalogEntry } = require('./notificationEventCatalog');

const GENERIC_BODY = 'Open Albusto to view this update.';

const DEEP_LINKS = Object.freeze({
    job: id => `/jobs/${encodeURIComponent(id)}`,
    lead: id => `/leads/${encodeURIComponent(id)}`,
    task: () => '/tasks',
    contact: id => `/pulse/contact/${encodeURIComponent(id)}`,
    timeline: id => `/pulse/timeline/${encodeURIComponent(id)}`,
    call: () => '/calls',
    sms_conversation: () => '/messages',
    sms_message: () => '/messages',
    email_message: () => '/email',
    email_thread: () => '/email',
    yelp_conversation: () => '/leads',
    estimate: () => '/estimates',
    invoice: () => '/invoices',
    payment: id => `/payments/${encodeURIComponent(id)}`,
    review: () => '/jobs',
});

function normalizeRecordRef(recordType, recordId) {
    if (!recordType || recordId === undefined || recordId === null) return null;
    return { type: String(recordType), id: String(recordId) };
}

function deepLinkFor(recordRef) {
    if (!recordRef) return { kind: 'home', url: '/' };
    const builder = DEEP_LINKS[recordRef.type];
    if (!builder) return { kind: 'home', url: '/' };
    return { kind: recordRef.type, url: builder(recordRef.id) };
}

/**
 * Build the entire lock-screen payload from catalog and delivery-ledger data.
 * Event payload data is intentionally not accepted: message bodies, amounts,
 * contact details, and integration summaries cannot cross this boundary.
 */
function buildNotificationPayload({ eventType, deliveryId, recordType, recordId }) {
    const entry = getNotificationCatalogEntry(eventType);
    if (!entry || !entry.producer_available || !deliveryId) return null;

    const recordRef = normalizeRecordRef(recordType, recordId);
    const deepLink = deepLinkFor(recordRef);
    return {
        title: entry.label,
        body: GENERIC_BODY,
        tag: `notification-${deliveryId}`,
        event_type: entry.event_type,
        category_key: entry.category_key,
        category_label: entry.category_label,
        deep_link_kind: deepLink.kind,
        record_ref: recordRef,
        url: deepLink.url,
    };
}

module.exports = {
    GENERIC_BODY,
    buildNotificationPayload,
};
