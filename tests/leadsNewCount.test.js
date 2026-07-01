/**
 * LEADS-NEW-BADGE-001 — countNewLeads + lead.* SSE emit (unit).
 * DB + realtimeService are mocked; no live infra required.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/fsmService', () => ({}));
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: jest.fn() }));

const db = require('../backend/src/db/connection');
const realtimeService = require('../backend/src/services/realtimeService');
const leadsService = require('../backend/src/services/leadsService');

beforeEach(() => {
    db.query.mockReset();
    realtimeService.broadcast.mockReset();
});

describe('NEW_LEAD_STATUSES', () => {
    test('is the pre-contact set', () => {
        expect(leadsService.NEW_LEAD_STATUSES).toEqual(['Submitted', 'New', 'Review']);
    });
});

describe('countNewLeads', () => {
    test('scopes by company_id + NEW_LEAD_STATUSES + excludes lost, returns count', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: 7 }] });

        const n = await leadsService.countNewLeads('company-1');

        expect(n).toBe(7);
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/company_id\s*=\s*\$1/);
        expect(sql).toMatch(/lead_lost\s*=\s*false/);
        expect(sql).toMatch(/status\s*=\s*ANY/);
        expect(params).toEqual(['company-1', ['Submitted', 'New', 'Review']]);
    });

    test('returns 0 and does not query when companyId is missing (no cross-tenant default)', async () => {
        const n = await leadsService.countNewLeads(null);
        expect(n).toBe(0);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('returns 0 when the row count is null/absent', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: null }] });
        expect(await leadsService.countNewLeads('c1')).toBe(0);
    });
});

describe('lead.* SSE emit', () => {
    test('markLost broadcasts lead.updated with a MINIMAL, PII-free payload', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ uuid: 'AB12CD' }] });

        await leadsService.markLost('AB12CD', 'company-9');

        expect(realtimeService.broadcast).toHaveBeenCalledTimes(1);
        const [eventType, payload] = realtimeService.broadcast.mock.calls[0];
        expect(eventType).toBe('lead.updated');
        expect(payload.company_id).toBe('company-9');
        expect(payload.status).toBe('Lost');
        // No PII leaks over the global broadcast channel.
        expect(payload).not.toHaveProperty('phone');
        expect(payload).not.toHaveProperty('first_name');
        expect(payload).not.toHaveProperty('last_name');
        expect(payload).not.toHaveProperty('email');
        expect(Object.keys(payload).sort()).toEqual(['company_id', 'lead_id', 'status']);
    });

    test('a broadcast failure never breaks the lead write (best-effort)', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ uuid: 'AB12CD' }] });
        realtimeService.broadcast.mockImplementationOnce(() => { throw new Error('SSE down'); });

        await expect(leadsService.activateLead('AB12CD', 'company-9')).resolves.toEqual({ message: 'Lead activated' });
    });

    test('does not broadcast when companyId is missing', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ uuid: 'AB12CD' }] });
        await leadsService.markLost('AB12CD', null);
        expect(realtimeService.broadcast).not.toHaveBeenCalled();
    });
});
