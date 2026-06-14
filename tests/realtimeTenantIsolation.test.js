/**
 * Tenant isolation for the SSE realtime broadcast (PF007).
 * Regression test for the cross-tenant leak: broadcast() must deliver an event
 * ONLY to clients of the matching company, and fail-closed (drop) when no
 * company can be determined.
 */

const realtimeService = require('../backend/src/services/realtimeService');

function fakeClient(companyId) {
    const writes = [];
    const res = { writeHead() {}, write(s) { writes.push(s); }, end() {} };
    const req = { companyFilter: { company_id: companyId }, ip: '1.2.3.4', on() {} };
    realtimeService.addClient(req, res);
    writes.length = 0; // drop the initial 'connected' event
    return { writes, got: (t) => writes.join('').includes(`event: ${t}`) };
}

describe('realtimeService SSE tenant isolation', () => {
    it('delivers an event only to same-company clients', () => {
        const a = fakeClient('company-A');
        const b = fakeClient('company-B');
        realtimeService.broadcast('call.created', { call_sid: 'x' }, 'company-A');
        expect(a.got('call.created')).toBe(true);   // A's company → delivered
        expect(b.got('call.created')).toBe(false);  // B's company → NOT delivered
    });

    it('infers company from payload (data.company_id) when 3rd arg omitted', () => {
        const a = fakeClient('company-A');
        const b = fakeClient('company-B');
        realtimeService.broadcast('job.updated', { job: { company_id: 'company-B' } });
        expect(a.got('job.updated')).toBe(false);
        expect(b.got('job.updated')).toBe(true);
    });

    it('fails closed — drops events with no resolvable company (no leak)', () => {
        const a = fakeClient('company-A');
        const b = fakeClient('company-B');
        const res = realtimeService.broadcast('thread.unsnoozed', { timelineId: 5 });
        expect(res.dropped).toBe(true);
        expect(a.got('thread.unsnoozed')).toBe(false);
        expect(b.got('thread.unsnoozed')).toBe(false);
    });
});
