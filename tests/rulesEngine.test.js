/**
 * ADR-001 — event bus + rules engine + actions.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const db = require('../backend/src/db/connection');
const eventBus = require('../backend/src/services/eventBus');
const rulesEngine = require('../backend/src/services/rulesEngine');
const ruleActions = require('../backend/src/services/ruleActions');

const COMPANY = '11111111-1111-1111-1111-111111111111';

beforeEach(() => db.query.mockReset());

describe('eventBus', () => {
    it('persists to domain_events and returns the row', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 42, created_at: 'now' }] });
        const ev = await eventBus.emit(COMPANY, 'job.status_changed', { id: 5 }, { dispatch: false });
        expect(ev.id).toBe(42);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO domain_events');
        expect(params[0]).toBe(COMPANY);
        expect(params[3]).toBe('job.status_changed');
    });

    it('dispatches to a matching subscriber and survives subscriber errors', async () => {
        const calls = [];
        eventBus.subscribe('test-ok', 'x.happened', async () => { calls.push('ok'); });
        eventBus.subscribe('test-boom', 'x.happened', async () => { throw new Error('boom'); });
        db.query.mockResolvedValue({ rows: [{ id: 1, created_at: 'now' }] });
        await eventBus.emit(COMPANY, 'x.happened', {}, { dispatch: true });
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        expect(calls).toContain('ok'); // ok ran despite boom throwing
    });
});

describe('rulesEngine condition evaluation', () => {
    const ctx = { to: 'Job is Done', amount: 150, contact: { name: 'Jane' } };
    it('all-clauses require every match', () => {
        expect(rulesEngine.evaluateConditions({ all: [{ field: 'to', op: 'eq', value: 'Job is Done' }] }, ctx)).toBe(true);
        expect(rulesEngine.evaluateConditions({ all: [{ field: 'to', op: 'eq', value: 'Canceled' }] }, ctx)).toBe(false);
    });
    it('any-clauses require one match', () => {
        expect(rulesEngine.evaluateConditions({ any: [
            { field: 'to', op: 'eq', value: 'X' }, { field: 'amount', op: 'gt', value: 100 },
        ] }, ctx)).toBe(true);
    });
    it('empty conditions always pass', () => {
        expect(rulesEngine.evaluateConditions({}, ctx)).toBe(true);
    });
    it('nested path + contains', () => {
        expect(rulesEngine.evaluateConditions({ all: [{ field: 'contact.name', op: 'contains', value: 'jan' }] }, ctx)).toBe(true);
    });
});

describe('ruleActions template rendering', () => {
    it('interpolates {{path}} against context', () => {
        const out = ruleActions.renderParams(
            { body: 'Hi {{contact.name}}, job is {{to}}' },
            { to: 'done', contact: { name: 'Jane' } }
        );
        expect(out.body).toBe('Hi Jane, job is done');
    });
    it('missing path renders empty', () => {
        expect(ruleActions.render('x={{nope}}', {})).toBe('x=');
    });
    it('rejects unknown action type', async () => {
        await expect(ruleActions.execute({ type: 'nope' }, { context: {}, companyId: COMPANY }))
            .rejects.toThrow('Unknown action type');
    });
    it('run_agent_task enqueues a queued agent task', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
        const out = await ruleActions.execute(
            { type: 'run_agent_task', params: { agent_type: 'summarize' } },
            { context: { timeline_id: 9 }, companyId: COMPANY, rule: { id: 1 } }
        );
        expect(out.agent_task_id).toBe(7);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain("'agent'");
        expect(sql).toContain("'queued'");
        expect(params[1]).toBe('summarize');
    });
});

describe('rulesEngine.onEvent', () => {
    it('runs an event-rule whose conditions pass', async () => {
        const event = { id: 100, company_id: COMPANY, event_type: 'job.status_changed',
            payload: { to: 'Job is Done', contact_id: 3 }, actor_type: 'user', created_at: 'now' };
        db.query
            // load rules
            .mockResolvedValueOnce({ rows: [{
                id: 1, company_id: COMPANY, trigger_kind: 'event', event_type: 'job.status_changed',
                conditions: { all: [{ field: 'to', op: 'eq', value: 'Job is Done' }] },
                actions: [], // no-op actions keep the test pure
            }] })
            // insert run row
            .mockResolvedValueOnce({ rows: [{ id: 55 }] })
            // update run row
            .mockResolvedValueOnce({ rows: [] });
        await rulesEngine.onEvent(event);
        const insertCall = db.query.mock.calls.find(c => c[0].includes('INSERT INTO automation_rule_runs'));
        expect(insertCall).toBeTruthy();
    });

    it('skips an event-rule whose conditions fail', async () => {
        const event = { id: 101, company_id: COMPANY, event_type: 'job.status_changed',
            payload: { to: 'Submitted' }, actor_type: 'user', created_at: 'now' };
        db.query.mockResolvedValueOnce({ rows: [{
            id: 1, company_id: COMPANY, trigger_kind: 'event', event_type: 'job.status_changed',
            conditions: { all: [{ field: 'to', op: 'eq', value: 'Job is Done' }] }, actions: [],
        }] });
        await rulesEngine.onEvent(event);
        const insertCall = db.query.mock.calls.find(c => c[0].includes('INSERT INTO automation_rule_runs'));
        expect(insertCall).toBeFalsy(); // never created a run
    });
});
