/**
 * OUTBOUND-LEAD-CALL-001 (OLC-T2) — TC-OLC-001/002: settings service unit tests.
 * normalizeSource/isSourceEnabled matrix + coerceStored per-key overlay +
 * get/resolve safe-fail. db is mocked (pure-unit; no PG).
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const svc = require('../backend/src/services/outboundLeadCallSettingsService');

afterEach(() => jest.clearAllMocks());

describe('TC-OLC-001: normalizeSource matrix', () => {
    const CANON = 'proreferral';
    it.each([
        ['Pro Referral', CANON],
        ['ProReferral', CANON],
        ['pro referral', CANON],
        ['  pro   referral ', CANON],
        ['PRO REFERRAL', CANON],
        ['', ''],
        [null, ''],
        [undefined, ''],
        [42, '42'],
    ])('normalizeSource(%j) → %j', (input, expected) => {
        expect(svc.normalizeSource(input)).toBe(expected);
    });

    it('isSourceEnabled matches every display variant BOTH directions', () => {
        const variants = ['Pro Referral', 'ProReferral', 'pro referral', 'PRO REFERRAL'];
        for (const stored of variants) {
            for (const raw of variants) {
                expect(svc.isSourceEnabled({ enabled_sources: [stored] }, raw)).toBe(true);
            }
        }
    });

    it('isSourceEnabled is false for empty raw source, empty list, non-matching source', () => {
        expect(svc.isSourceEnabled({ enabled_sources: ['ProReferral'] }, '')).toBe(false);
        expect(svc.isSourceEnabled({ enabled_sources: ['ProReferral'] }, null)).toBe(false);
        expect(svc.isSourceEnabled({ enabled_sources: [] }, 'ProReferral')).toBe(false);
        expect(svc.isSourceEnabled({ enabled_sources: ['Google'] }, 'ProReferral')).toBe(false);
        expect(svc.isSourceEnabled(undefined, 'ProReferral')).toBe(false);
    });
});

describe('TC-OLC-002: coerceStored per-key overlay + get/resolve safe-fail', () => {
    it('non-array enabled_sources falls back to DEFAULTS key; valid siblings kept', () => {
        const out = svc.coerceStored({ enabled_sources: 'oops', max_attempts: 5 });
        expect(out.enabled_sources).toEqual(['ProReferral']);
        expect(out.max_attempts).toBe(5);
    });

    it('junk source entries are String()-coerced and empties dropped', () => {
        const out = svc.coerceStored({ enabled_sources: [1, '', ' Google ', null] });
        expect(out.enabled_sources).toEqual(['1', 'Google']);
    });

    it.each([[0], [-1], [2.5], ['3']])('max_attempts=%j falls back to default 3', (bad) => {
        expect(svc.coerceStored({ max_attempts: bad }).max_attempts).toBe(3);
    });

    it('empty/null backoff_schedule falls back to the default ladder', () => {
        expect(svc.coerceStored({ backoff_schedule: [] }).backoff_schedule)
            .toEqual(['immediate', '+30m', '+2h']);
        expect(svc.coerceStored({ backoff_schedule: null }).backoff_schedule)
            .toEqual(['immediate', '+30m', '+2h']);
    });

    it('fully valid row passes through complete and typed', () => {
        const out = svc.coerceStored({
            enabled_sources: ['ProReferral', 'Google'],
            max_attempts: 2,
            backoff_schedule: ['immediate', '+1h'],
        });
        expect(out).toMatchObject({
            enabled_sources: ['ProReferral', 'Google'],
            max_attempts: 2,
            backoff_schedule: ['immediate', '+1h'],
        });
    });

    it('get: no row → a COPY of DEFAULTS (not the reference)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const out = await svc.get('co-1');
        expect(out).toEqual(svc.DEFAULTS);
        expect(out).not.toBe(svc.DEFAULTS);
    });

    it('get: hard DB error propagates', async () => {
        db.query.mockRejectedValueOnce(new Error('boom'));
        await expect(svc.get('co-1')).rejects.toThrow('boom');
    });

    it('resolve: NEVER throws — logs and returns DEFAULTS on any error', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        db.query.mockRejectedValueOnce(new Error('table missing'));
        const out = await svc.resolve('co-1');
        expect(out).toEqual(svc.DEFAULTS);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('[OutboundLeadCallSettings] resolve failed'),
            'table missing'
        );
        warn.mockRestore();
    });

    it('saveSources upserts and returns the coerced row', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ enabled_sources: ['Pro Referral'], max_attempts: 3, backoff_schedule: ['immediate', '+30m', '+2h'] }],
        });
        const out = await svc.saveSources('co-1', ['Pro Referral']);
        expect(db.query.mock.calls[0][0]).toMatch(/ON CONFLICT \(company_id\) DO UPDATE/);
        expect(db.query.mock.calls[0][1]).toEqual(['co-1', JSON.stringify(['Pro Referral'])]);
        expect(out.enabled_sources).toEqual(['Pro Referral']);
    });
});
