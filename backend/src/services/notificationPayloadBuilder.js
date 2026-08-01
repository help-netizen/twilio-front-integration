'use strict';

const { getNotificationCatalogEntry } = require('./notificationEventCatalog');

const GENERIC_BODY = 'Open Albusto to view this update.';
const PRE_CHANGE_GENERIC_TITLE = 'Assignment updated';

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
function buildNotificationPayload({
    eventType,
    deliveryId,
    recordType,
    recordId,
    isPreChangeRecipient = false,
}) {
    const entry = getNotificationCatalogEntry(eventType);
    if (!entry || !entry.producer_available || !deliveryId) return null;

    const base = {
        title: isPreChangeRecipient ? PRE_CHANGE_GENERIC_TITLE : entry.label,
        body: GENERIC_BODY,
        tag: `notification-${deliveryId}`,
        event_type: entry.event_type,
        category_key: entry.category_key,
        category_label: entry.category_label,
    };
    if (isPreChangeRecipient) return base;

    const normalizedRecordRef = normalizeRecordRef(recordType, recordId);
    const recordRef = entry.category_key === 'finance'
        && normalizedRecordRef
        && !['job', 'contact', 'lead'].includes(normalizedRecordRef.type)
        ? null
        : normalizedRecordRef;
    const deepLink = deepLinkFor(recordRef);
    return {
        ...base,
        deep_link_kind: deepLink.kind,
        record_ref: recordRef,
        url: deepLink.url,
    };
}

module.exports = {
    GENERIC_BODY,
    PRE_CHANGE_GENERIC_TITLE,
    buildNotificationPayload,
};
