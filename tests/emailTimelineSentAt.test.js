'use strict';

// EMAIL-TS-ORDER-001: outbound feed items are timed by our own insert moment
// (the send time we control); provider dates on agent-path outbound mail have
// shown hour-scale timezone skew that reordered threads. Inbound keeps the
// provider date, which is accurate and predates ingest lag.
const { projectEmailTimelineItem } = require('../backend/src/services/email/emailTimelineItem');

const GIA = '2026-07-15T06:02:51.000Z';
const CREATED = '2026-07-15T15:02:54.000Z';

test('outbound sent_at uses created_at over the skewed provider date', () => {
    const item = projectEmailTimelineItem({
        id: 1, direction: 'outbound', gmail_internal_at: GIA, created_at: CREATED,
    });
    expect(item.sent_at).toBe(CREATED);
});

test('outbound without created_at falls back to the provider date', () => {
    const item = projectEmailTimelineItem({
        id: 2, direction: 'outbound', gmail_internal_at: GIA,
    });
    expect(item.sent_at).toBe(GIA);
});

test('inbound sent_at keeps the provider date', () => {
    const item = projectEmailTimelineItem({
        id: 3, direction: 'inbound', gmail_internal_at: GIA, created_at: CREATED,
    });
    expect(item.sent_at).toBe(GIA);
});

test('inbound without a provider date falls back to created_at', () => {
    const item = projectEmailTimelineItem({
        id: 4, direction: 'inbound', gmail_internal_at: null, created_at: CREATED,
    });
    expect(item.sent_at).toBe(CREATED);
});
