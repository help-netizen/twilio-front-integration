/**
 * agentSkillsMcp.test.js — AGENT-SKILLS-001 T9 (Group I — svc.* MCP triplet)
 *
 * Mocked-unit / integration proof of the service-CRM MCP surface (registry +
 * executor + protocol + authed route + public route), mirroring the crmMcp trio.
 * The rule (spec §8): reuse the generic crmMcp framework; the parallel triplet
 * points at the SAME skill layer, so the framework write/confirmation/permission
 * gate composes as an OUTER gate on top of the skill-layer INNER L2.
 *
 * Covers:
 *   - ASK-MCP-01/02: tools/list — 9 svc.* tools, correct kind/requiresConfirmation
 *     + per-tool requiredLevel projection.
 *   - ASK-MCP-03/11: tenant from req.companyFilter.company_id (client company_id ignored).
 *   - ASK-MCP-04/05/12: OUTER framework write-gate (permission + confirmation)
 *     composes with INNER L2; missing permission/confirmation → access_denied,
 *     skill never runs; public writes disabled by default.
 *   - ASK-MCP-06/07: reused schema validator rejects bad args; snake_case passthrough.
 *   - ASK-MCP-08: identify + reads NOT gated on a marketplace app.
 *   - ASK-MCP-09/10/13: public 401/403; distinct serverInfo 'albusto-service-crm-mcp'.
 *   - ASK-MCP-14: errors go through crmMcpResponse.sanitizeDetails (sql/token dropped).
 *   - ASK-MCP-16: sales crmMcp* suites are untouched (run separately — see report).
 *
 * `agentSkills.runSkill` (the façade the executor dispatches into) is mocked so
 * these assertions isolate the TRANSPORT contract (tenant threading + the outer
 * gate composition). The skill layer itself is proven in the other T9 suites.
 */

'use strict';

const express = require('express');
const request = require('supertest');

// Mock the skill-layer façade so we observe dispatch (tenant + args) and can inject
// throws for sanitization, without exercising the real skills here.
jest.mock('../backend/src/services/agentSkills', () => ({ runSkill: jest.fn(async () => ({ ok: true, speak: 'ok' })) }));
jest.mock('../backend/src/services/chatgptMcpReadService', () => ({ execute: jest.fn(async () => ({ ok: true, id: 7 })) }));
jest.mock('../backend/src/services/chatgptMcpIdentityService', () => ({
    resolveFixedBearerContext: jest.fn(async ({ companyId, agentUserId }) => ({
        binding_id: 'binding-1',
        installation_id: 1,
        company_id: companyId,
        authorized_by_user_id: 'authorizer-1',
        ai_user_id: agentUserId,
        ai_email: 'svc-mcp@local',
        ai_full_name: 'Service MCP Agent',
        company_name: 'Test Company',
        company_timezone: 'America/New_York',
        permissions: [
            'contacts.view', 'jobs.view', 'estimates.view', 'invoices.view',
            'mcp.tool.svc.get_job',
            ...(process.env.SVC_MCP_PUBLIC_WRITE_ENABLED === 'true'
                ? ['service.crm.write', 'jobs.edit', 'jobs.close', 'leads.edit', 'leads.create']
                : []),
        ],
    })),
    recordInvocation: jest.fn(async () => {}),
}));
const agentSkills = require('../backend/src/services/agentSkills');
const chatgptMcpReadService = require('../backend/src/services/chatgptMcpReadService');

const registry = require('../backend/src/services/agentSkillsMcpRegistry');
const mcpResponse = require('../backend/src/services/crmMcpResponse');
const agentSkillsMcpRouter = require('../backend/src/routes/agentSkillsMcp');
const agentSkillsMcpPublicRouter = require('../backend/src/routes/agentSkillsMcpPublic');

const WRITE_PERM = 'service.crm.write';
const READ_PERMISSIONS = ['contacts.view', 'jobs.view', 'estimates.view', 'invoices.view'];
const ALL_PERMISSIONS = [
    ...READ_PERMISSIONS,
    WRITE_PERM,
    'jobs.edit',
    'jobs.close',
    'leads.edit',
    'leads.create',
];

/** Authenticated app — middleware sets companyFilter/user/authz (mirrors crmMcp.test.js). */
function makeApp({ companyId = 'company-1', permissions = READ_PERMISSIONS } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'req-svc-test';
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        req.user = { sub: 'sub-1', email: 'agent@test.local', crmUser: { id: 'user-1' } };
        req.authz = { permissions, company: { id: companyId || 'company-1', status: 'active', timezone: 'America/New_York' } };
        next();
    });
    app.use('/api/agent-skills/mcp', agentSkillsMcpRouter);
    return app;
}

/** Public app — no auth middleware; its own token gate applies (mirrors crmMcpPublic.test.js). */
function makePublicApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.requestId = 'req-svc-public'; next(); });
    app.use('/mcp/agent-skills', agentSkillsMcpPublicRouter);
    return app;
}

function setPublicEnv({ enabled = true, write = false } = {}) {
    process.env.SVC_MCP_PUBLIC_ENABLED = enabled ? 'true' : 'false';
    process.env.SVC_MCP_PUBLIC_TOKEN = 'svc-token';
    process.env.SVC_MCP_PUBLIC_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
    process.env.SVC_MCP_PUBLIC_AGENT_USER_ID = '00000000-0000-0000-0000-000000000099';
    process.env.SVC_MCP_PUBLIC_WRITE_ENABLED = write ? 'true' : 'false';
}
function clearPublicEnv() {
    for (const k of ['SVC_MCP_PUBLIC_ENABLED', 'SVC_MCP_PUBLIC_TOKEN', 'SVC_MCP_PUBLIC_COMPANY_ID', 'SVC_MCP_PUBLIC_AGENT_USER_ID', 'SVC_MCP_PUBLIC_WRITE_ENABLED']) delete process.env[k];
}

beforeEach(() => jest.clearAllMocks());

// ════════════════════════════════════════════════════════════════════════════
// Registry / tools-list (ASK-MCP-01 / 02)
// ════════════════════════════════════════════════════════════════════════════

describe('svc.* registry — tool defs + requiredLevel projection (ASK-MCP-01/02)', () => {
    // Tools whose MCP requiredLevel projection is UNAMBIGUOUSLY correct today:
    // identify (L0), the three always-L1 reads, and the new book_on_lead write (L1).
    const EXPECTED_STABLE = {
        'svc.identify_caller': { kind: 'read', requiresConfirmation: false, requiredLevel: 'L0' },
        'svc.get_customer_overview': { kind: 'read', requiresConfirmation: false, requiredLevel: 'L1' },
        'svc.get_job_status': { kind: 'read', requiresConfirmation: false, requiredLevel: 'L1' },
        'svc.get_appointments': { kind: 'read', requiresConfirmation: false, requiredLevel: 'L1' },
        // AGENT-SKILLS-002 §3.4.5 — new write tool (book a slot as a HOLD on the open lead).
        'svc.book_on_lead': { kind: 'write', requiresConfirmation: true, requiredLevel: 'L1' },
    };
    // The five skills AGENT-SKILLS-002 §2.1 relaxed L2→L1 in the skill registry. The MCP
    // registry projection SHOULD mirror that (AC-10 parity: the svc.* surface must match
    // the VAPI/skill surface). Their INTENDED requiredLevel is L1.
    const RELAXED_TO_L1 = ['svc.get_job_history', 'svc.get_estimate_summary', 'svc.get_invoice_summary', 'svc.reschedule_appointment', 'svc.cancel_appointment'];

    test('all 10 svc.* tools present; stable-level tools + book_on_lead have correct kind / confirmation / requiredLevel', () => {
        const tools = registry.listTools();
        expect(tools).toHaveLength(10); // 9 (AGENT-SKILLS-001) + svc.book_on_lead
        for (const [name, meta] of Object.entries(EXPECTED_STABLE)) {
            const t = tools.find((x) => x.name === name);
            expect(t).toBeDefined();
            expect(t.kind).toBe(meta.kind);
            expect(t.requiresConfirmation).toBe(meta.requiresConfirmation);
            expect(t.requiredLevel).toBe(meta.requiredLevel);
        }
        // The five relaxed tools still exist as writes/reads with confirmation-as-expected
        // (kind/confirmation are correct regardless of the level-annotation drift below).
        expect(registry.getTool('svc.reschedule_appointment').kind).toBe('write');
        expect(registry.getTool('svc.get_job_history').kind).toBe('read');
        expect(registry.getTool('svc.reschedule_appointment')).toMatchObject({
            requiredPermission: 'jobs.edit',
            frameworkWritePermission: WRITE_PERM,
        });
        expect(registry.getTool('svc.book_on_lead').requiredPermissions).toEqual(['leads.edit', 'leads.create']);
        expect(registry.getTool('svc.get_job_status').requiredPermission).toBe('jobs.view');
        expect(tools.every((tool) => tool.requiredPermissions.length > 0)).toBe(true);
    });

    // AC-10 parity: the five relaxed tools' MCP requiredLevel now matches the skill
    // registry's L1. AGENT-SKILLS-002 corrected the MCP registry's hand-maintained
    // requiredLevel projections from L2→L1 (agentSkillsMcpRegistry.js), closing the
    // advertisement drift vs. the skill registry. Now a plain passing `test` (was
    // `test.failing` while the projections still said L2). The paired ASK-MCP-01-current
    // block (which asserted the OLD L2 drift) was REMOVED — this test covers the contract.
    test('ASK-MCP-01: the five relaxed svc.* tools advertise requiredLevel L1 (AC-10 parity)', () => {
        for (const name of RELAXED_TO_L1) {
            expect(registry.getTool(name).requiredLevel).toBe('L1');
        }
    });

    test('svc.book_on_lead maps to the bookOnLead skill and exposes chosen_slot (required) + identity/fallback fields', () => {
        expect(registry.skillFor('svc.book_on_lead')).toBe('bookOnLead');
        const t = registry.getTool('svc.book_on_lead');
        const props = Object.keys(t.inputSchema.properties);
        // identity block + the chosen slot + the no-lead fallback booking fields
        expect(props).toEqual(expect.arrayContaining(['phone', 'name', 'zip', 'street', 'contact_id', 'chosen_slot', 'lat', 'lng', 'first_name', 'last_name', 'email']));
        expect(t.inputSchema.required).toContain('chosen_slot');
        // no card field ever exposed on a write tool
        for (const bad of ['card', 'pan', 'cvv', 'card_number']) expect(props).not.toContain(bad);
    });

    test('no delete/bulk tools (mirror crmMcp guard)', () => {
        const names = registry.listTools().map((t) => t.name);
        expect(names.some((n) => /delete|remove|archive|bulk|destroy/i.test(n))).toBe(false);
    });

    test('skillFor maps snake_case MCP name → camelCase skill name', () => {
        expect(registry.skillFor('svc.get_customer_overview')).toBe('getCustomerOverview');
        expect(registry.skillFor('svc.reschedule_appointment')).toBe('rescheduleAppointment');
        expect(registry.skillFor('svc.bogus')).toBeNull();
    });

    test('authed GET /tools?kind=read returns only the 7 reads', async () => {
        const res = await request(makeApp()).get('/api/agent-skills/mcp/tools?kind=read');
        expect(res.status).toBe(200);
        expect(res.body.data.tools.every((t) => t.kind === 'read')).toBe(true);
        expect(res.body.data.tools.map((t) => t.name)).not.toContain('svc.reschedule_appointment');
    });

    test('authed GET /tools filters discovery to the caller permissions', async () => {
        const res = await request(makeApp({ permissions: ['jobs.view'] }))
            .get('/api/agent-skills/mcp/tools');
        const names = res.body.data.tools.map((tool) => tool.name);

        expect(names).toEqual(expect.arrayContaining([
            'svc.get_job_status',
            'svc.get_appointments',
            'svc.get_job_history',
        ]));
        expect(names).not.toContain('svc.identify_caller');
        expect(names).not.toContain('svc.get_invoice_summary');
        expect(names).not.toContain('svc.reschedule_appointment');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Tenant-from-context + read dispatch (ASK-MCP-03 / 08)
// ════════════════════════════════════════════════════════════════════════════

describe('svc.* executor — tenant from context, reads ungated (ASK-MCP-03/08)', () => {
    test('ASK-MCP-03: read uses req.companyFilter.company_id; client company_id IGNORED', async () => {
        agentSkills.runSkill.mockResolvedValue({ ok: true, openJobsCount: 0, speak: 'x' });
        const res = await request(makeApp({ companyId: 'company-1' }))
            .post('/api/agent-skills/mcp/call')
            .send({ tool: 'svc.get_customer_overview', arguments: { contact_id: '501', company_id: 'company-2', phone: '+16175551212' } });

        expect(res.status).toBe(200);
        // runSkill(skill, companyId, ctx, args): companyId is 'company-1' (context), NEVER 'company-2'
        expect(agentSkills.runSkill).toHaveBeenCalledWith('getCustomerOverview', 'company-1', expect.any(Object), expect.objectContaining({ contact_id: '501' }));
        expect(agentSkills.runSkill.mock.calls[0][1]).toBe('company-1');
        expect(agentSkills.runSkill.mock.calls[0][3]).not.toHaveProperty('company_id');
    });

    test('ASK-MCP-07: snake_case identity block + skill fields pass THROUGH to the skill layer', async () => {
        agentSkills.runSkill.mockResolvedValue({ ok: true, speak: 'x' });
        await request(makeApp({ companyId: 'company-1', permissions: [WRITE_PERM, 'jobs.edit'] }))
            .post('/api/agent-skills/mcp/call')
            .send({
                tool: 'svc.reschedule_appointment',
                arguments: { contact_id: '501', job_id: '7', new_preferred_slot: { date: '2026-07-10', start: '10:00', end: '12:00' }, phone: '+16175551212', name: 'Jane', zip: '02101' },
                confirmation: { confirmed: true, confirmation_id: 'c-1' },
            });
        const args = agentSkills.runSkill.mock.calls[0][3];
        expect(args).toMatchObject({ contact_id: '501', job_id: '7', phone: '+16175551212', name: 'Jane', zip: '02101' });
        expect(args.new_preferred_slot).toEqual({ date: '2026-07-10', start: '10:00', end: '12:00' });
    });

    test('ASK-MCP-08: identify + reads are NOT gated on a marketplace app (no isAppConnected short-circuit)', async () => {
        agentSkills.runSkill.mockResolvedValue({ ok: true, matchType: 'new', speak: 'x' });
        const res = await request(makeApp())
            .post('/api/agent-skills/mcp/call')
            .send({ tool: 'svc.identify_caller', arguments: { phone: '+16175551212' } });
        expect(res.status).toBe(200);
        expect(agentSkills.runSkill).toHaveBeenCalledWith('identifyCaller', 'company-1', expect.any(Object), expect.any(Object));
    });

    test('no company context → access_denied', async () => {
        const res = await request(makeApp({ companyId: null }))
            .post('/api/agent-skills/mcp/call')
            .send({ tool: 'svc.get_appointments', arguments: { contact_id: '501' } });
        expect(res.body.error.code).toBe('access_denied');
        expect(agentSkills.runSkill).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// OUTER framework write-gate composes with INNER L2 (ASK-MCP-04 / 05 / 06)
// ════════════════════════════════════════════════════════════════════════════

describe('svc.* write-gate — permission + confirmation OUTER gate (ASK-MCP-04/05/06)', () => {
    test('ASK-MCP-04: write WITHOUT confirmation → confirmation_required, skill NEVER runs', async () => {
        const res = await request(makeApp({ permissions: [WRITE_PERM, 'jobs.edit'] }))
            .post('/api/agent-skills/mcp/call')
            .send({ tool: 'svc.reschedule_appointment', arguments: { contact_id: '501', job_id: '7', new_preferred_slot: { date: '2026-07-10', start: '10:00', end: '12:00' } } });
        expect(res.body.error.code).toBe('confirmation_required');
        expect(agentSkills.runSkill).not.toHaveBeenCalled();
    });

    test('ASK-MCP-05: write permission ABSENT → access_denied, skill NEVER runs', async () => {
        const res = await request(makeApp({ permissions: ['jobs.close'] }))
            .post('/api/agent-skills/mcp/call')
            .send({ tool: 'svc.cancel_appointment', arguments: { contact_id: '501', job_id: '7', reason: 'price', retention_attempted: true }, confirmation: { confirmed: true, confirmation_id: 'c-1' } });
        expect(res.body.error.code).toBe('access_denied');
        expect(agentSkills.runSkill).not.toHaveBeenCalled();
    });

    test('ASK-MCP-04: WITH permission + confirmation → dispatches to skill layer (INNER L2 then enforced there)', async () => {
        agentSkills.runSkill.mockResolvedValue({ ok: false, needsVerification: true, speak: 'verify' });
        const res = await request(makeApp({ permissions: [WRITE_PERM, 'jobs.edit'] }))
            .post('/api/agent-skills/mcp/call')
            .send({ tool: 'svc.reschedule_appointment', arguments: { contact_id: '501', job_id: '7', new_preferred_slot: { date: '2026-07-10', start: '10:00', end: '12:00' } }, confirmation: { confirmed: true, confirmation_id: 'c-1' } });
        // Outer gate passed → the skill layer ran (and here returned its own L2 refusal).
        expect(res.status).toBe(200);
        expect(agentSkills.runSkill).toHaveBeenCalledWith('rescheduleAppointment', 'company-1', expect.any(Object), expect.any(Object));
        expect(res.body.structuredContent).toMatchObject({ needsVerification: true });
    });

    test('caller with a read permission cannot invoke a write tool', async () => {
        const res = await request(makeApp({ permissions: [WRITE_PERM, 'jobs.view'] }))
            .post('/api/agent-skills/mcp/call')
            .send({
                tool: 'svc.reschedule_appointment',
                arguments: { contact_id: '501', job_id: '7', new_preferred_slot: { date: '2026-07-10', start: '10:00', end: '12:00' } },
                confirmation: { confirmed: true, confirmation_id: 'c-read-only' },
            });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('access_denied');
        expect(agentSkills.runSkill).not.toHaveBeenCalled();
    });

    test('unmapped tool fails closed before skill dispatch', async () => {
        const spy = jest.spyOn(registry, 'getTool').mockReturnValueOnce({
            name: 'svc.unmapped',
            skill: 'identifyCaller',
            kind: 'read',
            inputSchema: { type: 'object', properties: {}, required: [] },
        });
        try {
            const res = await request(makeApp())
                .post('/api/agent-skills/mcp/call')
                .send({ tool: 'svc.unmapped', arguments: {} });

            expect(res.status).toBe(403);
            expect(res.body.error.details.reason).toBe('TOOL_PERMISSION_UNMAPPED');
            expect(agentSkills.runSkill).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    test('ASK-MCP-06: reused schema validator rejects a missing required arg BEFORE dispatch', async () => {
        const res = await request(makeApp())
            .post('/api/agent-skills/mcp/call')
            .send({ tool: 'svc.get_job_status', arguments: { phone: '+16175551212' } }); // missing contact_id
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
        expect(res.body.error.details.field).toBe('contact_id');
        expect(agentSkills.runSkill).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// JSON-RPC protocol (initialize / tools/list / tools/call) + sanitized errors
// ════════════════════════════════════════════════════════════════════════════

describe('svc.* JSON-RPC protocol (ASK-MCP-13 / 14)', () => {
    test('ASK-MCP-13: initialize → serverInfo.name === albusto-service-crm-mcp (distinct from sales)', async () => {
        const res = await request(makeApp())
            .post('/api/agent-skills/mcp/jsonrpc')
            .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        expect(res.status).toBe(200);
        expect(res.body.result.serverInfo.name).toBe('albusto-service-crm-mcp');
        expect(res.body.result.serverInfo.name).not.toBe('blanc-sales-crm-mcp');
    });

    test('tools/list over JSON-RPC surfaces requiredLevel in annotations', async () => {
        const res = await request(makeApp({ permissions: ALL_PERMISSIONS }))
            .post('/api/agent-skills/mcp/jsonrpc')
            .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const reschedule = res.body.result.tools.find((t) => t.name === 'svc.reschedule_appointment');
        // kind/confirmation/permission are correct; requiredLevel is now L1 (AGENT-SKILLS-002
        // corrected the MCP projection to match the skill registry — see ASK-MCP-01).
        expect(reschedule.annotations).toMatchObject({
            kind: 'write',
            requiresConfirmation: true,
            requiredLevel: 'L1',
            requiredPermission: 'jobs.edit',
            frameworkWritePermission: WRITE_PERM,
        });
        // The new book_on_lead write tool is present with the correct L1 + confirmation annotations.
        const bookOnLead = res.body.result.tools.find((t) => t.name === 'svc.book_on_lead');
        expect(bookOnLead).toBeDefined();
        expect(bookOnLead.annotations).toMatchObject({
            kind: 'write',
            requiresConfirmation: true,
            requiredLevel: 'L1',
            requiredPermissions: ['leads.edit', 'leads.create'],
            frameworkWritePermission: WRITE_PERM,
        });
    });

    test('tools/call read over JSON-RPC returns structuredContent from the skill layer', async () => {
        agentSkills.runSkill.mockResolvedValue({ ok: true, appointments: [], speak: 'nothing scheduled' });
        const res = await request(makeApp())
            .post('/api/agent-skills/mcp/jsonrpc')
            .send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'svc.get_appointments', arguments: { contact_id: '501' } } });
        expect(res.body.result.structuredContent).toMatchObject({ ok: true, appointments: [] });
    });

    test('ASK-MCP-14: an error carrying { sql, token } details is sanitized (keys dropped) on the transport', async () => {
        // Force the executor's dispatch to throw an mcpError carrying sensitive detail
        // keys; the reused crmMcpResponse.mapError → sanitizeDetails must strip them.
        agentSkills.runSkill.mockImplementation(() => {
            throw mcpResponse.mcpError('invalid_request', 'bad', { field: 'contact_id', sql: 'SELECT * FROM secrets', token: 'abc123', stack: 'at foo()' });
        });
        const res = await request(makeApp())
            .post('/api/agent-skills/mcp/jsonrpc')
            .send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'svc.get_customer_overview', arguments: { contact_id: '501' } } });
        const details = res.body.error.data.details;
        expect(details.field).toBe('contact_id'); // safe key kept
        expect(details).not.toHaveProperty('sql');
        expect(details).not.toHaveProperty('token');
        expect(details).not.toHaveProperty('stack');
        expect(JSON.stringify(res.body)).not.toMatch(/SELECT \* FROM secrets|abc123/);
    });

    test('unknown method → JSON-RPC error, sanitized', async () => {
        const res = await request(makeApp())
            .post('/api/agent-skills/mcp/jsonrpc')
            .send({ jsonrpc: '2.0', id: 5, method: 'frobnicate', params: {} });
        expect(res.body.error).toBeDefined();
        expect(res.body.error.data.code).toBe('unsupported_tool');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Public transport (ASK-MCP-09 / 10 / 11 / 12)
// ════════════════════════════════════════════════════════════════════════════

describe('svc.* public transport — token/env gates (ASK-MCP-09/10/11/12)', () => {
    beforeEach(() => setPublicEnv());
    afterEach(() => clearPublicEnv());

    test('ASK-MCP-09: missing bearer token → 401 MCP_PUBLIC_UNAUTHORIZED', async () => {
        const res = await request(makePublicApp())
            .post('/mcp/agent-skills')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(401);
        expect(res.body.error.data.code).toBe('MCP_PUBLIC_UNAUTHORIZED');
    });

    test('ASK-MCP-10: disabled transport → 403 MCP_PUBLIC_DISABLED', async () => {
        process.env.SVC_MCP_PUBLIC_ENABLED = 'false';
        const res = await request(makePublicApp())
            .post('/mcp/agent-skills')
            .set('Authorization', 'Bearer svc-token')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(403);
        expect(res.body.error.data.code).toBe('MCP_PUBLIC_DISABLED');
    });

    test('ASK-MCP-11: fixed-bearer S1 read is DB-bound company; client company_id ignored', async () => {
        const res = await request(makePublicApp())
            .post('/mcp/agent-skills')
            .set('Authorization', 'Bearer svc-token')
            .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'svc.get_job', arguments: { job_id: 7, company_id: 'company-999' } } });
        expect(res.status).toBe(200);
        expect(chatgptMcpReadService.execute).toHaveBeenCalledWith(
            'getJob', '00000000-0000-0000-0000-000000000001', { job_id: 7 }
        );
    });

    test('ASK-MCP-12: public WRITE disabled by default → access_denied, skill NEVER runs', async () => {
        const res = await request(makePublicApp())
            .post('/mcp/agent-skills')
            .set('Authorization', 'Bearer svc-token')
            .send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'svc.reschedule_appointment', arguments: { contact_id: '501', job_id: '7', new_preferred_slot: { date: '2026-07-10', start: '10:00', end: '12:00' } }, confirmation: { confirmed: true, confirmation_id: 'c-1' } } });
        expect(res.body.error.data.code).toBe('access_denied');
        expect(agentSkills.runSkill).not.toHaveBeenCalled();
    });

    test('ASK-MCP-12 (S1): legacy write flag cannot expose an S2 or legacy write', async () => {
        setPublicEnv({ write: true });
        const res = await request(makePublicApp())
            .post('/mcp/agent-skills')
            .set('Authorization', 'Bearer svc-token')
            .send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'svc.reschedule_appointment', arguments: { contact_id: '501', job_id: '7', new_preferred_slot: { date: '2026-07-10', start: '10:00', end: '12:00' } }, confirmation: { confirmed: true, confirmation_id: 'c-1' } } });
        expect(res.body.error.data.code).toBe('access_denied');
        expect(agentSkills.runSkill).not.toHaveBeenCalled();
    });

    test('public initialize → distinct serverInfo albusto-service-crm-mcp', async () => {
        const res = await request(makePublicApp())
            .post('/mcp/agent-skills')
            .set('Authorization', 'Bearer svc-token')
            .send({ jsonrpc: '2.0', id: 5, method: 'initialize', params: {} });
        expect(res.body.result.serverInfo.name).toBe('albusto-service-crm-mcp');
    });
});
