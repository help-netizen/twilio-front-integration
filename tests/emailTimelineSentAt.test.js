'use strict';

// EMAIL-OCCURRED-AT-001: every feed item reads the canonical stored event time.
const { projectEmailTimelineItem } = require('../backend/src/services/email/emailTimelineItem');

const GIA = '2026-07-15T06:02:51.000Z';
const CREATED = '2026-07-15T15:02:54.000Z';

test('outbound sent_at uses occurred_at', () => {
    const item = projectEmailTimelineItem({
        id: 1, direction: 'outbound', gmail_internal_at: GIA, created_at: CREATED, occurred_at: CREATED,
    });
    expect(item.sent_at).toBe(CREATED);
});

test('outbound does not reconstruct a time from raw columns', () => {
    const item = projectEmailTimelineItem({
        id: 2, direction: 'outbound', gmail_internal_at: GIA, created_at: CREATED, occurred_at: GIA,
    });
    expect(item.sent_at).toBe(GIA);
});

test('inbound sent_at uses occurred_at', () => {
    const item = projectEmailTimelineItem({
        id: 3, direction: 'inbound', gmail_internal_at: GIA, created_at: CREATED, occurred_at: GIA,
    });
    expect(item.sent_at).toBe(GIA);
});

test('missing occurred_at remains missing instead of creating another convention', () => {
    const item = projectEmailTimelineItem({
        id: 4, direction: 'inbound', gmail_internal_at: null, created_at: CREATED,
    });
    expect(item.sent_at).toBeUndefined();
});
