/**
 * ARM-001 — faithful AR-config → rules migration + create_task SLA support.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/arConfigHelper', () => ({
    DEFAULT_CONFIG: {
        enabled: true,
        triggers: {
            inbound_sms: { enabled: true, create_task: true, task_priority: 'p1', task_sla_minutes: 10 },
            missed_call: { enabled: false, create_task: true, task_priority: 'p2', task_sla_minutes: 30 },
            voicemail: { enabled: false, create_task: true, task_priority: 'p2', task_sla_minutes: 60 },
        },
    },
    getARConfig: jest.fn(),
}));
jest.mock('../backend/src/db/queries', () => ({ createTask: jest.fn().mockResolvedValue({ id: 7 }) }));

const db = require('../backend/src/db/connection');
const arConfig = require('../backend/src/services/arConfigHelper');
const rulesSeed = require('../backend/src/services/rulesSeed');

const COMPANY = '11111111-1111-1111-1111-111111111111';

beforeEach(() => { db.query.mockReset(); arConfig.getARConfig.mockReset(); });

describe('buildRulesFromConfig', () => {
    it('carries custom priority/SLA and enabled flags from the company config', () => {
        const rules = rulesSeed.buildRulesFromConfig({
            enabled: true,
            triggers: {
                inbound_sms: { enabled: true, create_task: true, task_priority: 'p0', task_sla_minutes: 5 },
                missed_call: { enabled: true, create_task: true, task_priority: 'p1', task_sla_minutes: 20 },
            },
        });
        const sms = rules.find(r => r.event_type === 'sms.inbound');
        const call = rules.find(r => r.event_type === 'call.missed');
        const smsTask = sms.actions.find(a => a.type === 'create_task');
        expect(smsTask.params.priority).toBe('p0');
        expect(smsTask.params.sla_minutes).toBe(5);
        expect(sms.enabled).toBe(true);
        expect(call.enabled).toBe(true);
        expect(call.actions[0].params.priority).toBe('p1');
    });

    it('AR disabled at top level → both rules disabled', () => {
        const rules = rulesSeed.buildRulesFromConfig({ enabled: false, triggers: {} });
        expect(rules.every(r => r.enabled === false)).toBe(true);
    });

    it('default config → missed_call rule disabled (matches legacy default)', () => {
        const rules = rulesSeed.buildRulesFromConfig(); // DEFAULT_CONFIG
        expect(rules.find(r => r.event_type === 'sms.inbound').enabled).toBe(true);
        expect(rules.find(r => r.event_type === 'call.missed').enabled).toBe(false);
    });
});

describe('migrateCompanyARConfig', () => {
    it('reads the real config and upserts with DO UPDATE (authoritative)', async () => {
        arConfig.getARConfig.mockResolvedValueOnce({
            enabled: true,
            triggers: { inbound_sms: { enabled: true, create_task: true, task_priority: 'p2', task_sla_minutes: 15 } },
        });
        db.query.mockResolvedValue({ rowCount: 1 });
        const out = await rulesSeed.migrateCompanyARConfig(COMPANY);
        expect(arConfig.getARConfig).toHaveBeenCalledWith(COMPANY);
        expect(out.affected).toBe(2);
        for (const call of db.query.mock.calls) {
            expect(call[0]).toContain('is_system');
            expect(call[0]).toContain('ON CONFLICT');
            expect(call[0]).toContain('DO UPDATE');
            expect(call[1][0]).toBe(COMPANY);
        }
    });
});

describe('seedDefaultRules', () => {
    it('uses DO NOTHING so it never clobbers admin edits', async () => {
        db.query.mockResolvedValue({ rowCount: 1 });
        const n = await rulesSeed.seedDefaultRules(COMPANY);
        expect(n).toBe(2);
        for (const call of db.query.mock.calls) expect(call[0]).toContain('DO NOTHING');
    });
});

describe('create_task action — sla_minutes', () => {
    const ruleActions = require('../backend/src/services/ruleActions');
    const queries = require('../backend/src/db/queries');

    it('computes a relative dueAt from sla_minutes', async () => {
        queries.createTask.mockClear();
        const before = Date.now();
        await ruleActions.execute(
            { type: 'create_task', params: { title: 'x', priority: 'p1', sla_minutes: 10 } },
            { context: { contact_id: 'c1', timeline_id: 5 }, companyId: COMPANY }
        );
        const arg = queries.createTask.mock.calls[0][0];
        expect(arg.dueAt).toBeTruthy();
        const due = new Date(arg.dueAt).getTime();
        expect(due).toBeGreaterThanOrEqual(before + 9 * 60000);
        expect(due).toBeLessThanOrEqual(Date.now() + 11 * 60000);
    });

    it('explicit due_at wins over sla_minutes', async () => {
        queries.createTask.mockClear();
        await ruleActions.execute(
            { type: 'create_task', params: { title: 'x', due_at: '2030-01-01T00:00:00.000Z', sla_minutes: 10 } },
            { context: {}, companyId: COMPANY }
        );
        expect(queries.createTask.mock.calls[0][0].dueAt).toBe('2030-01-01T00:00:00.000Z');
    });

    it('no sla_minutes and no due_at → dueAt null', async () => {
        queries.createTask.mockClear();
        await ruleActions.execute(
            { type: 'create_task', params: { title: 'x' } },
            { context: {}, companyId: COMPANY }
        );
        expect(queries.createTask.mock.calls[0][0].dueAt).toBeNull();
    });
});
