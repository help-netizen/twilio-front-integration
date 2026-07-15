/**
 * OLC-CALLBACK-001 — cancelLeadChainsForInboundCallback: a lead we're robo-calling
 * calls back → cancel its pending/dialing lead_call attempts + trace the lead.
 * Phone-keyed (company from the matched row), idempotent, safe-fail. db mocked.
 */

'use strict';

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../backend/src/services/eventService', () => ({ logEvent: jest.fn() }));

const db = require('../backend/src/db/connection');
const eventService = require('../backend/src/services/eventService');
const svc = require('../backend/src/services/outboundLeadCallService');

const CO = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const cancelUpdates = () => mockQuery.mock.calls.filter(([sql]) => /SET status = 'canceled', reason = 'inbound_callback'/.test(sql));
const noteUpdates = () => mockQuery.mock.calls.filter(([sql]) => /UPDATE leads\s+SET comments/.test(sql));

describe('TC-OLC-060: cancel on inbound callback', () => {
    it('active attempts to the caller number → canceled + one trace + event per lead', async () => {
        mockQuery.mockImplementation(async (sql) => {
            if (/SET status = 'canceled', reason = 'inbound_callback'/.test(sql)) {
                return { rows: [{ id: 11, company_id: CO, lead_uuid: 'LD-1' }] };
            }
            return { rows: [], rowCount: 1 };
        });
        const out = await svc.cancelLeadChainsForInboundCallback('+16175551234');
        expect(out).toEqual({ canceled: 1 });

        // Cancel query is phone + scenario + active-status scoped (no company param).
        const cancel = cancelUpdates()[0];
        expect(cancel[0]).toMatch(/scenario = 'lead_call' AND phone = \$1 AND status IN \('pending', 'dialing'\)/);
        expect(cancel[1]).toEqual(['+16175551234']);

        // Trace appended to the affected lead, company-scoped from the row.
        const note = noteUpdates()[0];
        expect(note[1][0]).toBe('LD-1');
        expect(note[1][1]).toMatch(/called us back/i);
        expect(note[1][2]).toBe(CO);

        expect(eventService.logEvent).toHaveBeenCalledWith(
            CO, 'lead', 'LD-1', 'outbound_lead_call_canceled_inbound', expect.anything(), 'system');
    });

    it('no active attempts → {canceled:0}; no note, no event', async () => {
        mockQuery.mockResolvedValue({ rows: [] });
        const out = await svc.cancelLeadChainsForInboundCallback('+16175551234');
        expect(out).toEqual({ canceled: 0 });
        expect(noteUpdates()).toHaveLength(0);
        expect(eventService.logEvent).not.toHaveBeenCalled();
    });

    it('normalizes the phone; un-dialable caller → no DB touch at all', async () => {
        const out = await svc.cancelLeadChainsForInboundCallback('anonymous');
        expect(out).toEqual({ canceled: 0 });
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('10-digit caller is normalized to E.164 before matching', async () => {
        mockQuery.mockResolvedValue({ rows: [] });
        await svc.cancelLeadChainsForInboundCallback('6175551234');
        expect(cancelUpdates()[0][1]).toEqual(['+16175551234']);
    });

    it('two attempts for the SAME lead → exactly one trace (deduped)', async () => {
        mockQuery.mockImplementation(async (sql) => {
            if (/SET status = 'canceled', reason = 'inbound_callback'/.test(sql)) {
                return { rows: [
                    { id: 11, company_id: CO, lead_uuid: 'LD-1' },
                    { id: 12, company_id: CO, lead_uuid: 'LD-1' },
                ] };
            }
            return { rows: [], rowCount: 1 };
        });
        const out = await svc.cancelLeadChainsForInboundCallback('+16175551234');
        expect(out).toEqual({ canceled: 2 });     // both rows canceled
        expect(noteUpdates()).toHaveLength(1);     // but one trace
        expect(eventService.logEvent).toHaveBeenCalledTimes(1);
    });

    it('SAFE-FAIL: a DB error resolves to {canceled:0}, never throws', async () => {
        mockQuery.mockRejectedValue(new Error('db down'));
        await expect(svc.cancelLeadChainsForInboundCallback('+16175551234')).resolves.toEqual({ canceled: 0 });
    });

    it('a failed note UPDATE does not abort the cancel result', async () => {
        let call = 0;
        mockQuery.mockImplementation(async (sql) => {
            if (/SET status = 'canceled', reason = 'inbound_callback'/.test(sql)) {
                return { rows: [{ id: 11, company_id: CO, lead_uuid: 'LD-1' }] };
            }
            if (/UPDATE leads\s+SET comments/.test(sql)) { call++; throw new Error('note fail'); }
            return { rows: [], rowCount: 1 };
        });
        const out = await svc.cancelLeadChainsForInboundCallback('+16175551234');
        expect(out).toEqual({ canceled: 1 });
        expect(call).toBe(1);
    });
});
