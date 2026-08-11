const fs = require('fs');
const path = require('path');
const {
  parseSCXML,
  validateSCXML,
  resolveTransition,
  getAvailableActions,
  getAllStates,
  graphCache,
} = require('../../backend/src/services/fsmService');
const { ALLOWED_TRANSITIONS } = require('../../backend/src/services/jobWorkflowFallback');

const JOB_SCXML = fs.readFileSync(path.resolve(__dirname, '../../fsm/job.scxml'), 'utf8');
const LEAD_SCXML = fs.readFileSync(path.resolve(__dirname, '../../fsm/lead.scxml'), 'utf8');

// ---------------------------------------------------------------------------
// parseSCXML
// ---------------------------------------------------------------------------
describe('parseSCXML', () => {
  // TC-FSM-001: Valid SCXML produces correct graph
  describe('TC-FSM-001: valid SCXML produces correct graph', () => {
    test('parses job.scxml with 8 states and correct transitions', () => {
      const graph = parseSCXML(JOB_SCXML);

      expect(graph.initialState).toBe('Submitted');
      expect(graph.states.size).toBe(8);
      expect(graph.finalStates).toContain('Canceled');
      expect(graph.finalStates).toContain('Job_is_Done');
      expect(graph.finalStates).toHaveLength(2);

      // metadata
      expect(graph.metadata.machine).toBe('job');
      expect(graph.metadata.title).toBe('Job Workflow');

      // Submitted has 4 outgoing transitions (ONWAY-001 added TO_ON_THE_WAY)
      const submitted = graph.states.get('Submitted');
      expect(submitted.transitions).toHaveLength(4);
      expect(submitted.system).toBe('start');

      expect(graph.states.get('On_the_way')).toMatchObject({
        system: 'on_the_way', op: 'arrival_eta',
      });
      expect(graph.states.get('Visit_completed').system).toBe('visit_completed');
      expect(graph.states.get('Job_is_Done').system).toBe('job_done');

      const toOnTheWay = submitted.transitions.find(t => t.event === 'TO_ON_THE_WAY');
      expect(toOnTheWay).toBeDefined();
      expect(toOnTheWay.target).toBe('On_the_way');
      expect(toOnTheWay).toMatchObject({ system: 'on_the_way', op: 'arrival_eta' });

      const toFollowUp = submitted.transitions.find(t => t.event === 'TO_FOLLOW_UP');
      expect(toFollowUp).toBeDefined();
      expect(toFollowUp.target).toBe('Follow_Up_with_Client');
      expect(toFollowUp.label).toBe('Follow up');
      expect(toFollowUp.action).toBe(true);

      const toWaiting = submitted.transitions.find(t => t.event === 'TO_WAITING_PARTS');
      expect(toWaiting).toBeDefined();
      expect(toWaiting.target).toBe('Waiting_for_parts');

      const toCancel = submitted.transitions.find(t => t.event === 'TO_CANCELED');
      expect(toCancel).toBeDefined();
      expect(toCancel.target).toBe('Canceled');
    });

    test('parses lead.scxml with 8 states', () => {
      const graph = parseSCXML(LEAD_SCXML);

      expect(graph.initialState).toBe('Submitted');
      expect(graph.states.size).toBe(8);
      expect(graph.finalStates).toContain('Lost');
      expect(graph.finalStates).toContain('Converted');
      expect(graph.finalStates).toHaveLength(2);

      expect(graph.metadata.machine).toBe('lead');
      expect(graph.metadata.title).toBe('Lead Workflow');

      // Negotiation -> Converted and Lost
      const negotiation = graph.states.get('Negotiation');
      expect(negotiation.transitions).toHaveLength(2);
      expect(negotiation.transitions.map(t => t.event)).toEqual(
        expect.arrayContaining(['TO_CONVERTED', 'TO_LOST']),
      );
    });

    test('all state IDs in job.scxml match expected set', () => {
      const graph = parseSCXML(JOB_SCXML);
      const ids = [...graph.states.keys()].sort();
      expect(ids).toEqual([
        'Canceled',
        'Follow_Up_with_Client',
        'Job_is_Done',
        'On_the_way',
        'Rescheduled',
        'Submitted',
        'Visit_completed',
        'Waiting_for_parts',
      ]);
    });

    test('final states have isFinal=true', () => {
      const graph = parseSCXML(JOB_SCXML);
      expect(graph.states.get('Canceled').isFinal).toBe(true);
      expect(graph.states.get('Job_is_Done').isFinal).toBe(true);
      expect(graph.states.get('Submitted').isFinal).toBe(false);
    });

    test('targetStatusName is resolved for transitions', () => {
      const graph = parseSCXML(JOB_SCXML);
      const submitted = graph.states.get('Submitted');
      const toFollowUp = submitted.transitions.find(t => t.event === 'TO_FOLLOW_UP');
      // Follow_Up_with_Client has blanc:statusName="Follow Up with Client"
      expect(toFollowUp.targetStatusName).toBe('Follow Up with Client');
    });
  });

  // TC-FSM-004: Blanc namespace attributes extracted correctly
  describe('TC-FSM-004: blanc namespace attributes extracted', () => {
    test('extracts blanc:label, blanc:confirm, blanc:order from transitions', () => {
      const graph = parseSCXML(JOB_SCXML);
      const submitted = graph.states.get('Submitted');

      const toCancel = submitted.transitions.find(t => t.target === 'Canceled');
      expect(toCancel.confirm).toBe(true);
      expect(toCancel.confirmText).toBe('Are you sure you want to cancel this job?');
      expect(typeof toCancel.order).toBe('number');
      expect(toCancel.order).toBe(3);
      expect(toCancel.label).toBe('Cancel');
      expect(toCancel.action).toBe(true);
    });

    test('extracts blanc:statusName from states', () => {
      const graph = parseSCXML(JOB_SCXML);
      const waiting = graph.states.get('Waiting_for_parts');
      expect(waiting.statusName).toBe('Waiting for parts');
      expect(waiting.label).toBe('Waiting for parts');
    });

    test('non-confirm transitions have confirm=false', () => {
      const graph = parseSCXML(JOB_SCXML);
      const submitted = graph.states.get('Submitted');
      const toFollowUp = submitted.transitions.find(t => t.event === 'TO_FOLLOW_UP');
      expect(toFollowUp.confirm).toBe(false);
      expect(toFollowUp.confirmText).toBeNull();
    });

    test('order is extracted as number', () => {
      const graph = parseSCXML(JOB_SCXML);
      const submitted = graph.states.get('Submitted');
      submitted.transitions.forEach(tr => {
        expect(typeof tr.order).toBe('number');
      });
    });

    test('roles are parsed as array from comma-separated string', () => {
      // Build a test SCXML with roles
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       initial="A" blanc:machine="test" blanc:title="Test">
  <state id="A">
    <transition event="GO" target="B" blanc:action="true" blanc:label="Go" blanc:roles="agent, admin" blanc:order="1"/>
  </state>
  <state id="B"/>
</scxml>`;
      const graph = parseSCXML(xml);
      const tr = graph.states.get('A').transitions[0];
      expect(tr.roles).toEqual(['agent', 'admin']);
    });

    test('keeps button/variant on edges and gets op/system from the target state', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml" xmlns:blanc="https://blanc.app/fsm" initial="A">
  <state id="A">
    <transition event="PROMOTE" target="B" blanc:action="true" blanc:button="false" blanc:variant="neutral" blanc:op="legacy_edge_op"/>
    <transition event="DEFAULTS" target="C" blanc:action="true"/>
  </state>
  <state id="B" blanc:system="on_the_way" blanc:op="arrival_eta"/>
  <state id="C"/>
</scxml>`;
      const transitions = parseSCXML(xml).states.get('A').transitions;

      expect(transitions[0]).toMatchObject({
        button: false,
        variant: 'neutral',
        system: 'on_the_way',
        op: 'arrival_eta',
      });
      expect(transitions[1]).toMatchObject({
        button: null, variant: null, system: null, op: null,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// validateSCXML
// ---------------------------------------------------------------------------
describe('validateSCXML', () => {
  // TC-FSM-002: Forbidden elements rejected
  describe('TC-FSM-002: forbidden elements rejected', () => {
    const forbidden = ['script', 'invoke', 'send', 'onentry', 'onexit', 'parallel', 'history', 'datamodel'];

    test.each(forbidden)('rejects SCXML with <%s> element inside state', (tag) => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"><${tag}>x</${tag}></state>
</scxml>`;
      const result = validateSCXML(xml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.match(new RegExp(`forbidden.*${tag}|${tag}`, 'i')))).toBe(true);
    });

    test.each(forbidden)('rejects SCXML with <%s> element at root level', (tag) => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"/>
  <${tag}>x</${tag}>
</scxml>`;
      const result = validateSCXML(xml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.match(new RegExp(`forbidden.*${tag}|${tag}`, 'i')))).toBe(true);
    });
  });

  // TC-FSM-003: Missing initial state
  describe('TC-FSM-003: missing initial state', () => {
    test('returns error when initial attribute missing', () => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml"><state id="A"/></scxml>`;
      const result = validateSCXML(xml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.match(/initial/i))).toBe(true);
    });

    test('returns error when initial references non-existent state', () => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="Ghost"><state id="A"/></scxml>`;
      const result = validateSCXML(xml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.match(/Ghost/i))).toBe(true);
    });
  });

  // TC-FSM-030: Malformed XML
  describe('TC-FSM-030: malformed XML', () => {
    test('returns error for malformed XML', () => {
      const result = validateSCXML('<not valid xml>>>');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('returns error for completely empty input', () => {
      const result = validateSCXML('');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('returns error for non-scxml root element', () => {
      const result = validateSCXML('<html><body>hi</body></html>');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.match(/scxml/i))).toBe(true);
    });
  });

  // TC-FSM-020: Unreachable states warning
  describe('TC-FSM-020: unreachable states warning', () => {
    test('warns about unreachable states', () => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"><transition event="GO" target="B"/></state>
  <state id="B"/>
  <state id="Orphan"/>
</scxml>`;
      const result = validateSCXML(xml);
      expect(result.warnings.some(w => w.message.match(/unreachable|Orphan/i))).toBe(true);
    });

    test('initial state is not flagged as unreachable', () => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"><transition event="GO" target="B"/></state>
  <state id="B"/>
</scxml>`;
      const result = validateSCXML(xml);
      expect(result.warnings.some(w => w.message.match(/\bA\b/))).toBe(false);
    });
  });

  // TC-FSM-021: Duplicate events in same state
  describe('TC-FSM-021: duplicate events in same state', () => {
    test('warns about duplicate events in same state', () => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A">
    <transition event="GO" target="B"/>
    <transition event="GO" target="C"/>
  </state>
  <state id="B"/><state id="C"/>
</scxml>`;
      const result = validateSCXML(xml);
      expect(result.warnings.some(w => w.message.match(/duplicate/i))).toBe(true);
    });
  });

  // Transition target validation
  describe('transition target validation', () => {
    test('returns error when transition target does not exist', () => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"><transition event="GO" target="NonExistent"/></state>
</scxml>`;
      const result = validateSCXML(xml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.match(/target|NonExistent/i))).toBe(true);
    });
  });

  // Duplicate state IDs
  describe('duplicate state IDs', () => {
    test('returns error for duplicate state IDs', () => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"><transition event="GO" target="B"/></state>
  <state id="A"/>
  <state id="B"/>
</scxml>`;
      const result = validateSCXML(xml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.match(/duplicate.*A/i))).toBe(true);
    });
  });

  // Valid SCXML passes validation
  describe('valid SCXML passes', () => {
    test('job.scxml passes validation', () => {
      const result = validateSCXML(JOB_SCXML);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('lead.scxml passes validation', () => {
      const result = validateSCXML(LEAD_SCXML);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // Non-final state without outgoing transitions
  describe('non-final state without outgoing transitions', () => {
    test('warns about non-final state with no transitions', () => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"><transition event="GO" target="B"/></state>
  <state id="B"/>
</scxml>`;
      const result = validateSCXML(xml);
      expect(result.warnings.some(w => w.message.match(/no outgoing|B/i))).toBe(true);
    });

    test('final states with no transitions do not trigger warning', () => {
      const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"><transition event="GO" target="Done"/></state>
  <final id="Done"/>
</scxml>`;
      const result = validateSCXML(xml);
      expect(result.warnings.some(w => w.message.match(/Done/))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveTransition
// ---------------------------------------------------------------------------
describe('resolveTransition', () => {
  const COMPANY = 'test-company';
  const MACHINE = 'job';

  beforeEach(() => {
    const graph = parseSCXML(JOB_SCXML);
    graphCache.set(`${COMPANY}:${MACHINE}`, graph);
  });

  afterEach(() => {
    graphCache.clear();
  });

  // TC-FSM-005: Valid transition applied correctly
  test('TC-FSM-005: resolves valid transition by event', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'Submitted', 'TO_FOLLOW_UP');
    expect(result.valid).toBe(true);
    expect(result.targetState).toBe('Follow Up with Client');
    expect(result.event).toBe('TO_FOLLOW_UP');
  });

  test('returns the target state operation and system identity', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'Submitted', 'TO_ON_THE_WAY');
    expect(result).toMatchObject({ op: 'arrival_eta', system: 'on_the_way' });
    expect(result.transition).toMatchObject({
      button: true,
      op: 'arrival_eta',
      system: 'on_the_way',
    });
  });

  test('resolves transition by target statusName', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'Submitted', 'Follow Up with Client');
    expect(result.valid).toBe(true);
    expect(result.targetState).toBe('Follow Up with Client');
  });

  test('resolves transition by target state id', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'Submitted', 'Follow_Up_with_Client');
    expect(result.valid).toBe(true);
    expect(result.targetState).toBe('Follow Up with Client');
  });

  // TC-FSM-006: Invalid transition rejected
  test('TC-FSM-006: rejects invalid transition from final state', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'Canceled', 'TO_FOLLOW_UP');
    expect(result.valid).toBe(false);
  });

  test('rejects event that does not exist on source state', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'Submitted', 'TO_JOB_DONE');
    expect(result.valid).toBe(false);
  });

  test('returns error when current state does not exist', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'NonExistent', 'TO_FOLLOW_UP');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  // TC-FSM-018: Fallback when no published FSM
  test('TC-FSM-018: returns fallback when no published graph', async () => {
    graphCache.clear();
    // No DB mock, so getPublishedGraph will call getActiveVersion which calls db.query.
    // We need to mock db for this case.
    const db = require('../../backend/src/db/connection');
    const originalQuery = db.query;
    db.query = jest.fn().mockResolvedValue({ rows: [] });

    try {
      const result = await resolveTransition('no-fsm-company', MACHINE, 'Submitted', 'TO_FOLLOW_UP');
      expect(result.fallback).toBe(true);
      expect(result.valid).toBeNull();
    } finally {
      db.query = originalQuery;
    }
  });

  test('resolves transition using statusName as currentState', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'Waiting for parts', 'TO_SUBMITTED');
    expect(result.valid).toBe(true);
    expect(result.targetState).toBe('Submitted');
  });

  // Same-state transition should be a no-op success, not an error
  test('treats same-state transition as no-op success (by statusName)', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'Follow Up with Client', 'Follow Up with Client');
    expect(result.valid).toBe(true);
    expect(result.event).toBe('__NOOP__');
    expect(result.targetState).toBe('Follow Up with Client');
  });

  test('treats same-state transition as no-op success (id vs statusName)', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'Follow Up with Client', 'Follow_Up_with_Client');
    expect(result.valid).toBe(true);
    expect(result.event).toBe('__NOOP__');
  });

  // Reset to initial state must work from ANY state — even when no explicit
  // transition is defined in the schema.
  test('allows reset to initial state from any state via statusName', async () => {
    const result = await resolveTransition(COMPANY, MACHINE, 'Follow Up with Client', 'Submitted');
    expect(result.valid).toBe(true);
    expect(result.targetState).toBe('Submitted');
  });

  test('allows reset to initial state from terminal state', async () => {
    // Canceled is a final state with no outgoing transitions in the seed schema.
    // Reset back to initial should still be allowed.
    const result = await resolveTransition(COMPANY, MACHINE, 'Canceled', 'Submitted');
    expect(result.valid).toBe(true);
    expect(result.event).toBe('__RESET__');
    expect(result.targetState).toBe('Submitted');
  });
});

// ---------------------------------------------------------------------------
// getAvailableActions
// ---------------------------------------------------------------------------
describe('getAvailableActions', () => {
  const COMPANY = 'test-company';
  const MACHINE = 'job';

  beforeEach(() => {
    const graph = parseSCXML(JOB_SCXML);
    graphCache.set(`${COMPANY}:${MACHINE}`, graph);
  });

  afterEach(() => {
    graphCache.clear();
  });

  test('returns action buttons for Submitted state', async () => {
    const result = await getAvailableActions(COMPANY, MACHINE, 'Submitted', []);
    expect(result.fallback).toBe(false);
    expect(result.actions.length).toBe(4);
    expect(result.actions.map(a => a.event)).toEqual(
      expect.arrayContaining(['TO_ON_THE_WAY', 'TO_FOLLOW_UP', 'TO_WAITING_PARTS', 'TO_CANCELED']),
    );
  });

  test('actions are sorted by order', async () => {
    const result = await getAvailableActions(COMPANY, MACHINE, 'Submitted', []);
    const orders = result.actions.map(a => a.order);
    expect(orders).toEqual([0, 1, 2, 3]);
  });

  test('computes effective button and variant defaults after role filtering and sorting', async () => {
    const result = await getAvailableActions(COMPANY, MACHINE, 'Submitted', []);
    const byEvent = Object.fromEntries(result.actions.map(action => [action.event, action]));

    expect(byEvent.TO_ON_THE_WAY).toMatchObject({
      button: true,
      variant: 'primary',
      op: 'arrival_eta',
      system: 'on_the_way',
    });
    expect(byEvent.TO_FOLLOW_UP).toMatchObject({ button: true, variant: 'secondary', op: null });
    expect(byEvent.TO_WAITING_PARTS).toMatchObject({ button: true, variant: 'secondary' });
    expect(byEvent.TO_CANCELED).toMatchObject({ button: true, variant: 'danger' });
  });

  test('final targets default to success and explicit button/variant values win', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml" xmlns:blanc="https://blanc.app/fsm" initial="A">
  <state id="A">
    <transition event="FINISH" target="Done" blanc:action="true" blanc:order="1"/>
    <transition event="CANCEL" target="Canceled" blanc:action="true" blanc:button="false" blanc:variant="neutral" blanc:order="2"/>
  </state>
  <final id="Done" blanc:statusName="Job is Done"/>
  <final id="Canceled"/>
</scxml>`;
    graphCache.set('defaults:test', parseSCXML(xml));

    const result = await getAvailableActions('defaults', 'test', 'A', []);
    expect(result.actions[0]).toMatchObject({ event: 'FINISH', button: true, variant: 'success' });
    expect(result.actions[1]).toMatchObject({ event: 'CANCEL', button: false, variant: 'neutral' });
  });

  // TC-FSM-023: Confirm metadata returned
  test('TC-FSM-023: includes confirm metadata in actions', async () => {
    const result = await getAvailableActions(COMPANY, MACHINE, 'Submitted', []);
    const cancelAction = result.actions.find(a => a.event === 'TO_CANCELED');
    expect(cancelAction).toBeDefined();
    expect(cancelAction.confirm).toBe(true);
    expect(cancelAction.confirmText).toBe('Are you sure you want to cancel this job?');

    // Non-confirm actions
    const followUpAction = result.actions.find(a => a.event === 'TO_FOLLOW_UP');
    expect(followUpAction.confirm).toBe(false);
    expect(followUpAction.confirmText).toBeNull();
  });

  // TC-FSM-022: Actions filtered by role
  test('TC-FSM-022: filters actions by user roles', async () => {
    // Build SCXML with role-restricted transitions
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       initial="A" blanc:machine="test" blanc:title="Test">
  <state id="A">
    <transition event="ADMIN_ONLY" target="B" blanc:action="true" blanc:label="Admin action" blanc:roles="admin" blanc:order="1"/>
    <transition event="ALL_ROLES" target="C" blanc:action="true" blanc:label="Everyone" blanc:order="2"/>
    <transition event="MULTI_ROLE" target="D" blanc:action="true" blanc:label="Agent or Admin" blanc:roles="agent, admin" blanc:order="3"/>
  </state>
  <state id="B"/>
  <state id="C"/>
  <state id="D"/>
</scxml>`;
    const graph = parseSCXML(xml);
    graphCache.set('role-test:test', graph);

    // Agent user: should see ALL_ROLES and MULTI_ROLE, not ADMIN_ONLY
    const agentResult = await getAvailableActions('role-test', 'test', 'A', ['agent']);
    expect(agentResult.actions.map(a => a.event)).toEqual(['ALL_ROLES', 'MULTI_ROLE']);

    // Admin user: should see all three
    const adminResult = await getAvailableActions('role-test', 'test', 'A', ['admin']);
    expect(adminResult.actions.map(a => a.event)).toEqual(['ADMIN_ONLY', 'ALL_ROLES', 'MULTI_ROLE']);

    // No roles: should see only ALL_ROLES
    const noRolesResult = await getAvailableActions('role-test', 'test', 'A', []);
    expect(noRolesResult.actions.map(a => a.event)).toEqual(['ALL_ROLES']);
  });

  test('returns empty actions for final state', async () => {
    const result = await getAvailableActions(COMPANY, MACHINE, 'Canceled', []);
    expect(result.actions).toEqual([]);
    expect(result.fallback).toBe(false);
  });

  test('returns empty actions for unknown state', async () => {
    const result = await getAvailableActions(COMPANY, MACHINE, 'NonExistent', []);
    expect(result.actions).toEqual([]);
    expect(result.fallback).toBe(false);
  });

  test('uses neutral hardcoded actions when a published job state has no actionable edges', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml" xmlns:blanc="https://blanc.app/fsm" initial="Submitted">
  <state id="Submitted">
    <transition event="HIDDEN" target="Canceled"/>
  </state>
  <final id="Canceled"/>
</scxml>`;
    graphCache.set('no-actions:job', parseSCXML(xml));

    const result = await getAvailableActions('no-actions', 'job', 'Submitted', []);
    expect(result.fallback).toBe(true);
    expect(result.actions.map(action => action.targetStatusName)).toEqual(ALLOWED_TRANSITIONS.Submitted);
    expect(result.actions.every(action => action.variant === 'neutral' && action.button === true)).toBe(true);
  });

  // TC-FSM-031: Fallback actions when no published graph
  test('TC-FSM-031: returns fallback flag when no published graph', async () => {
    graphCache.clear();
    const db = require('../../backend/src/db/connection');
    const originalQuery = db.query;
    db.query = jest.fn().mockResolvedValue({ rows: [] });

    try {
      const result = await getAvailableActions('no-fsm-company', MACHINE, 'Submitted', []);
      expect(result.fallback).toBe(true);
      expect(result.actions.length).toBeGreaterThan(0);
      expect(result.actions.every(action => action.button === true && action.variant === 'neutral')).toBe(true);
      expect(result.actions.every(action => action.op === null)).toBe(true);
      expect(result.actions.every(action => action.system === null)).toBe(true);
    } finally {
      db.query = originalQuery;
    }
  });

  test('actions include label and icon', async () => {
    const result = await getAvailableActions(COMPANY, MACHINE, 'Submitted', []);
    const followUp = result.actions.find(a => a.event === 'TO_FOLLOW_UP');
    expect(followUp.label).toBe('Follow up');
    expect(followUp.targetStatusName).toBe('Follow Up with Client');
  });

  test('surfaces arrival_eta from every inbound edge, including an arbitrary source', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       initial="Custom_source" blanc:machine="job">
  <state id="Custom_source" blanc:label="Custom source">
    <transition event="ENTER_ON_THE_WAY" target="On_the_way"
                blanc:action="true" blanc:button="false" blanc:variant="neutral"
                blanc:label="On the way"/>
  </state>
  <state id="On_the_way" blanc:label="On the way" blanc:statusName="On the way"
         blanc:system="on_the_way" blanc:op="arrival_eta"/>
</scxml>`;
    graphCache.set('any-source:job', parseSCXML(xml));

    const result = await getAvailableActions('any-source', 'job', 'Custom source', []);

    expect(result.actions).toEqual([
      expect.objectContaining({
        event: 'ENTER_ON_THE_WAY',
        targetStatusName: 'On the way',
        button: false,
        variant: 'neutral',
        system: 'on_the_way',
        op: 'arrival_eta',
      }),
    ]);
    graphCache.delete('any-source:job');
  });
});

// ---------------------------------------------------------------------------
// getAllStates
// ---------------------------------------------------------------------------
describe('getAllStates', () => {
  const COMPANY = 'test-company';
  const MACHINE = 'job';

  beforeEach(() => {
    const graph = parseSCXML(JOB_SCXML);
    graphCache.set(`${COMPANY}:${MACHINE}`, graph);
  });

  afterEach(() => {
    graphCache.clear();
  });

  test('returns all state statusNames from published graph', async () => {
    const states = await getAllStates(COMPANY, MACHINE);
    expect(states).toHaveLength(8);
    expect(states).toContain('Submitted');
    expect(states).toContain('On the way');
    expect(states).toContain('Waiting for parts');
    expect(states).toContain('Follow Up with Client');
    expect(states).toContain('Visit completed');
    expect(states).toContain('Rescheduled');
    expect(states).toContain('Job is Done');
    expect(states).toContain('Canceled');
  });

  test('returns null when no published graph', async () => {
    graphCache.clear();
    const db = require('../../backend/src/db/connection');
    const originalQuery = db.query;
    db.query = jest.fn().mockResolvedValue({ rows: [] });

    try {
      const states = await getAllStates('no-fsm-company', MACHINE);
      expect(states).toBeNull();
    } finally {
      db.query = originalQuery;
    }
  });
});
