/**
 * contactPropagationService.test.js — JOB-CONTACT-SYNC-001.
 *
 * Unit (mocked db + seams): pins the fill-empty-only / never-steal decision
 * tree of `propagateContactDetails` and the follow-up re-link calls
 * (mergeOrphanTimelines after a phone lands, linkInboxMessages after an
 * email lands). NO real DB — branch dispatch only, per the house pattern.
 */

'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockMergeOrphanTimelines = jest.fn(async () => {});
jest.mock('../backend/src/services/timelineMergeService', () => ({
    mergeOrphanTimelines: mockMergeOrphanTimelines,
}));

const mockLinkInboxMessages = jest.fn(async () => 0);
jest.mock('../backend/src/services/contactEmailMergeService', () => ({
    linkInboxMessages: mockLinkInboxMessages,
}));

const mockLogEvent = jest.fn();
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: mockLogEvent,
}));

const { propagateContactDetails, phoneDigits } = require('../backend/src/services/contactPropagationService');

const COMPANY = '00000000-0000-0000-0000-000000000001';

/** Route mocked SQL: contact read, other-owner lookups, UPDATEs. */
function primeDb({ contact, phoneOwner = null, emailOwner = null }) {
    mockQuery.mockImplementation(async (sql) => {
        if (/SELECT id, phone_e164, secondary_phone, email FROM contacts/.test(sql)) {
            return { rows: contact ? [contact] : [] };
        }
        if (/REGEXP_REPLACE\(COALESCE\(phone_e164/.test(sql)) {
            return { rows: phoneOwner ? [{ id: phoneOwner }] : [] };
        }
        if (/FROM contact_emails/.test(sql)) {
            return { rows: emailOwner ? [{ id: emailOwner }] : [] };
        }
        if (/^UPDATE contacts SET/m.test(sql.trim())) {
            return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
    });
}

function updateCalls() {
    return mockQuery.mock.calls.filter(([sql]) => sql.trim().startsWith('UPDATE contacts'));
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('phoneDigits', () => {
    test('normalizes to last 10 digits, rejects short values', () => {
        expect(phoneDigits('+1 (617) 417-9104')).toBe('6174179104');
        expect(phoneDigits('6174179104')).toBe('6174179104');
        expect(phoneDigits('12345')).toBeNull();
        expect(phoneDigits('')).toBeNull();
    });
});

describe('propagateContactDetails — phone', () => {
    test('fills empty phone_e164 and merges orphan timelines (the Leslie Beale case)', async () => {
        primeDb({ contact: { id: 4214, phone_e164: '', secondary_phone: '', email: '' } });

        const res = await propagateContactDetails(COMPANY, 4214, { phone: '6174179104' }, { source: 'test' });

        expect(res.phone).toBe('added_primary');
        const updates = updateCalls();
        expect(updates).toHaveLength(1);
        expect(updates[0][0]).toContain('phone_e164');
        expect(updates[0][1][0]).toBe('+16174179104'); // toE164 applied
        expect(mockMergeOrphanTimelines).toHaveBeenCalledWith(4214, ['+16174179104'], expect.any(String));
        expect(mockLogEvent).toHaveBeenCalled();
    });

    test('falls to secondary_phone when primary holds a DIFFERENT number', async () => {
        primeDb({ contact: { id: 7, phone_e164: '+16175550000', secondary_phone: '', email: '' } });

        const res = await propagateContactDetails(COMPANY, 7, { phone: '(617) 417-9104' }, {});

        expect(res.phone).toBe('added_secondary');
        expect(updateCalls()[0][0]).toContain('secondary_phone');
    });

    test("reports 'already' on a formatting-only difference — no write, no merge", async () => {
        primeDb({ contact: { id: 7, phone_e164: '6174179104', secondary_phone: '', email: '' } });

        const res = await propagateContactDetails(COMPANY, 7, { phone: '+1 617-417-9104' }, {});

        expect(res.phone).toBe('already');
        expect(updateCalls()).toHaveLength(0);
        expect(mockMergeOrphanTimelines).not.toHaveBeenCalled();
    });

    test('never steals a number owned by ANOTHER contact', async () => {
        primeDb({
            contact: { id: 7, phone_e164: '', secondary_phone: '', email: '' },
            phoneOwner: 999,
        });

        const res = await propagateContactDetails(COMPANY, 7, { phone: '6174179104' }, {});

        expect(res.phone).toBe('conflict');
        expect(updateCalls()).toHaveLength(0);
        expect(mockMergeOrphanTimelines).not.toHaveBeenCalled();
    });

    test("reports 'no_slot' when both slots hold other numbers", async () => {
        primeDb({ contact: { id: 7, phone_e164: '+16175550000', secondary_phone: '+16175550001', email: '' } });

        const res = await propagateContactDetails(COMPANY, 7, { phone: '6174179104' }, {});

        expect(res.phone).toBe('no_slot');
        expect(updateCalls()).toHaveLength(0);
    });

    test('skips a short/invalid phone without touching the DB', async () => {
        const res = await propagateContactDetails(COMPANY, 7, { phone: '911' }, {});

        expect(res.phone).toBe('skipped');
        expect(mockQuery).not.toHaveBeenCalled();
    });
});

describe('propagateContactDetails — email', () => {
    test('fills empty email and re-links inbox messages', async () => {
        primeDb({ contact: { id: 7, phone_e164: '+16175550000', secondary_phone: '', email: '' } });

        const res = await propagateContactDetails(COMPANY, 7, { email: 'Leslie@Example.com' }, {});

        expect(res.email).toBe('added');
        const emailUpdate = updateCalls().find(([sql]) => sql.includes('email'));
        expect(emailUpdate[1][0]).toBe('leslie@example.com'); // normalized
        expect(mockLinkInboxMessages).toHaveBeenCalledWith(7, 'leslie@example.com', COMPANY);
    });

    test('never steals an email owned by another contact', async () => {
        primeDb({
            contact: { id: 7, phone_e164: '', secondary_phone: '', email: '' },
            emailOwner: 999,
        });

        const res = await propagateContactDetails(COMPANY, 7, { email: 'x@y.com' }, {});

        expect(res.email).toBe('conflict');
        expect(updateCalls()).toHaveLength(0);
        expect(mockLinkInboxMessages).not.toHaveBeenCalled();
    });

    test("keeps a DIFFERENT existing email untouched ('no_slot')", async () => {
        primeDb({ contact: { id: 7, phone_e164: '', secondary_phone: '', email: 'old@x.com' } });

        const res = await propagateContactDetails(COMPANY, 7, { email: 'new@x.com' }, {});

        expect(res.email).toBe('no_slot');
        expect(updateCalls()).toHaveLength(0);
    });
});

describe('propagateContactDetails — guards', () => {
    test('no companyId / no contactId / foreign contact → silent skip', async () => {
        expect(await propagateContactDetails(null, 7, { phone: '6174179104' }, {}))
            .toEqual({ phone: 'skipped', email: 'skipped' });
        expect(await propagateContactDetails(COMPANY, null, { phone: '6174179104' }, {}))
            .toEqual({ phone: 'skipped', email: 'skipped' });

        primeDb({ contact: null }); // company-scoped read finds nothing (foreign tenant)
        expect(await propagateContactDetails(COMPANY, 12345, { phone: '6174179104' }, {}))
            .toEqual({ phone: 'skipped', email: 'skipped' });
        expect(updateCalls()).toHaveLength(0);
    });
});
