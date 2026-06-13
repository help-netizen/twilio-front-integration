/**
 * AUTO-001 — agent worker, handlers, route guards, AR seed.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const http = require('http');
const express = require('express');
const db = require('../backend/src/db/connection');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';

beforeEach(() => db.query.mockReset());

// ── Agent worker ─────────────────────────────────────────────────────────────

describe('agentWorker.processBatch', () => {
    const agentWorker = require('../backend/src/services/agentWorker');

    it('claims a queued task, runs noop, marks succeeded, emits success', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, company_id: COMPANY, agent_type: 'noop', agent_input: { x: 1 } }] }) // claim
            .mockResolvedValueOnce({ rows: [] }) // success update
            .mockResolvedValueOnce({ rows: [{ id: 9, created_at: 'now' }] }); // eventBus emit insert
        const n = await agentWorker.processBatch();
        expect(n).toBe(1);
        const claim = db.query.mock.calls[0][0];
        expect(claim).toContain("agent_status = 'running'");
        expect(claim).toContain('FOR UPDATE SKIP LOCKED');
        const succ = db.query.mock.calls[1][0];
        expect(succ).toContain("agent_status = 'succeeded'");
    });

    it('unknown agent_type → failed, no throw', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 2, company_id: COMPANY, agent_type: 'does_not_exist', agent_input: {} }] })
            .mockResolvedValueOnce({ rows: [] }) // failure update
            .mockResolvedValueOnce({ rows: [{ id: 10, created_at: 'now' }] });
        await expect(agentWorker.processBatch()).resolves.toBe(1);
        const fail = db.query.mock.calls[1];
        expect(fail[0]).toContain("agent_status = 'failed'");
        expect(fail[1][1]).toContain('Unknown agent_type');
    });

    it('no queued tasks → 0 processed', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        expect(await agentWorker.processBatch()).toBe(0);
    });
});

describe('agentHandlers.mcp_tool', () => {
    const handlers = require('../backend/src/services/agentHandlers');

    it('builds a tenant-scoped synthetic context for the executor', async () => {
        const executor = require('../backend/src/services/crmMcpToolExecutor');
        const spy = jest.spyOn(executor, 'execute').mockResolvedValue({ ok: true });
        const out = await handlers.run({ company_id: COMPANY, agent_type: 'mcp_tool', agent_input: { tool: 'crm.search_accounts', args: {} } });
        expect(spy).toHaveBeenCalled();
        const reqArg = spy.mock.calls[0][0];
        expect(reqArg.companyFilter.company_id).toBe(COMPANY);
        expect(out.tool).toBe('crm.search_accounts');
        spy.mockRestore();
    });

    it('mcp_tool without tool → throws', async () => {
        await expect(handlers.run({ company_id: COMPANY, agent_type: 'mcp_tool', agent_input: {} }))
            .rejects.toThrow('input.tool');
    });
});

describe('rulesSeed', () => {
    const rulesSeed = require('../backend/src/services/rulesSeed');
    it('inserts both system rules, idempotent via ON CONFLICT', async () => {
        db.query.mockResolvedValue({ rowCount: 1 });
        const n = await rulesSeed.seedDefaultRules(COMPANY);
        expect(n).toBe(2);
        for (const call of db.query.mock.calls) {
            expect(call[0]).toContain('is_system');
            expect(call[0]).toContain('ON CONFLICT');
            expect(call[1][0]).toBe(COMPANY);
        }
    });
});

// ── Route guards + isolation ─────────────────────────────────────────────────

function request(app, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const payload = body ? JSON.stringify(body) : null;
            const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
                headers: { 'Content-Type': 'application/json' } }, (res) => {
                let data = ''; res.on('data', c => (data += c));
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
            });
            req.on('error', e => { server.close(); reject(e); });
            if (payload) req.write(payload); req.end();
        });
    });
}

function app({ company = COMPANY } = {}) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
        req.user = { crmUser: { id: 'u1' }, email: 'a@x.com' };
        req.companyFilter = { company_id: company };
        req.authz = { permissions: ['tenant.company.manage'] };
        next();
    });
    a.use('/', require('../backend/src/routes/automationRules'));
    return a;
}

describe('automation routes', () => {
    it('GET /catalog returns event/action/agent types', async () => {
        const res = await request(app(), 'GET', '/catalog');
        expect(res.status).toBe(200);
        expect(res.body.event_types.length).toBeGreaterThan(5);
        expect(res.body.agent_types.map(a => a.type)).toContain('mcp_tool');
    });

    it('POST /rules with unknown action → 422', async () => {
        const res = await request(app(), 'POST', '/rules', { name: 'x', trigger_kind: 'event', event_type: 'sms.inbound', actions: [{ type: 'nope' }] });
        expect(res.status).toBe(422);
    });

    it('POST /rules with run_agent_task + unknown agent_type → 422', async () => {
        const res = await request(app(), 'POST', '/rules', {
            name: 'x', trigger_kind: 'event', event_type: 'sms.inbound',
            actions: [{ type: 'run_agent_task', params: { agent_type: 'ghost' } }],
        });
        expect(res.status).toBe(422);
    });

    it('POST /rules unknown event_type → 422', async () => {
        const res = await request(app(), 'POST', '/rules', { name: 'x', trigger_kind: 'event', event_type: 'made.up' });
        expect(res.status).toBe(422);
    });

    it('rule runs query is company-scoped (404 contract via join)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const res = await request(app({ company: COMPANY_B }), 'GET', '/rules/5/runs');
        expect(res.status).toBe(200);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('ar.company_id = $2');
        expect(params[1]).toBe(COMPANY_B);
    });

    it('retry of a running agent task → 409', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ agent_status: 'running' }] });
        const res = await request(app(), 'POST', '/agent-tasks/3/retry');
        expect(res.status).toBe(409);
    });

    it('retry of a foreign/missing agent task → 404', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        const res = await request(app(), 'POST', '/agent-tasks/3/retry');
        expect(res.status).toBe(404);
    });
});
