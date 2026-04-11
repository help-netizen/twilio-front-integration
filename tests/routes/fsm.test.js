/**
 * FSM Service Integration Tests
 *
 * Tests FSM service functions end-to-end (CRUD, publish, restore, validation)
 * by mocking only the database layer.
 *
 * Covers: TC-FSM-007 (partial), TC-FSM-008, TC-FSM-009, TC-FSM-010,
 *         TC-FSM-011, TC-FSM-012, TC-FSM-015, TC-FSM-016, TC-FSM-017,
 *         TC-FSM-019
 */

const fs = require('fs');
const path = require('path');

// Mock the database before requiring fsmService
jest.mock('../../backend/src/db/connection', () => ({
  query: jest.fn(),
}));

const fsmService = require('../../backend/src/services/fsmService');
const db = require('../../backend/src/db/connection');

const JOB_SCXML = fs.readFileSync(path.resolve(__dirname, '../../fsm/job.scxml'), 'utf8');
const LEAD_SCXML = fs.readFileSync(path.resolve(__dirname, '../../fsm/lead.scxml'), 'utf8');

// A valid minimal SCXML for testing
const VALID_SCXML = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://blanc.app/fsm"
       initial="A" blanc:machine="test" blanc:title="Test Workflow">
  <state id="A" blanc:statusName="State A">
    <transition event="GO" target="B" blanc:action="true" blanc:label="Go to B" blanc:order="1"/>
  </state>
  <state id="B" blanc:statusName="State B">
    <transition event="FINISH" target="Done" blanc:action="true" blanc:label="Finish" blanc:order="1"/>
  </state>
  <final id="Done" blanc:statusName="Done"/>
</scxml>`;

// Invalid SCXML: missing initial attribute
const BAD_SCXML_NO_INITIAL = `<scxml xmlns="http://www.w3.org/2005/07/scxml">
  <state id="A"/>
</scxml>`;

// Invalid SCXML: transition target references non-existent state
const BAD_SCXML_BAD_TARGET = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A">
    <transition event="GO" target="NonExistent"/>
  </state>
</scxml>`;

// Invalid SCXML with forbidden element
const BAD_SCXML_FORBIDDEN = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"><script>alert(1)</script></state>
</scxml>`;

beforeEach(() => {
  jest.clearAllMocks();
  fsmService.graphCache.clear();
});

// =============================================================================
// TC-FSM-009: Save and load draft
// =============================================================================
describe('FSM Service CRUD', () => {
  describe('TC-FSM-009: Save draft, load draft, load active version', () => {
    test('saveDraft validates SCXML, stores a new draft, and returns it', async () => {
      // Mock: find machine
      // Mock: no existing draft
      // Mock: max version_number
      // Mock: INSERT new draft
      // Mock: audit log INSERT
      const draftRow = {
        id: 'ver-2',
        machine_id: 'machine-1',
        company_id: 'comp-1',
        version_number: 2,
        status: 'draft',
        scxml_source: JOB_SCXML,
        created_by: 'user@test.com',
      };

      db.query
        .mockResolvedValueOnce({ rows: [{ id: 'machine-1' }] })          // SELECT fsm_machines
        .mockResolvedValueOnce({ rows: [] })                               // SELECT draft
        .mockResolvedValueOnce({ rows: [{ max_ver: 1 }] })               // MAX version_number
        .mockResolvedValueOnce({ rows: [draftRow] })                       // INSERT fsm_versions
        .mockResolvedValueOnce({ rows: [] });                              // INSERT fsm_audit_log

      const result = await fsmService.saveDraft('comp-1', 'job', JOB_SCXML, 'user-1', 'user@test.com');

      expect(result.ok).toBe(true);
      expect(result.draft).toBeDefined();
      expect(result.draft.version_number).toBe(2);
      expect(result.draft.status).toBe('draft');

      // Verify audit log was written
      expect(db.query).toHaveBeenCalledTimes(5);
      const auditCall = db.query.mock.calls[4];
      expect(auditCall[0]).toContain('fsm_audit_log');
      expect(auditCall[1]).toContain('save_draft');
    });

    test('saveDraft updates existing draft instead of creating new one', async () => {
      const updatedDraft = {
        id: 'ver-existing',
        machine_id: 'machine-1',
        company_id: 'comp-1',
        version_number: 1,
        status: 'draft',
        scxml_source: JOB_SCXML,
        created_by: 'user@test.com',
      };

      db.query
        .mockResolvedValueOnce({ rows: [{ id: 'machine-1' }] })          // SELECT fsm_machines
        .mockResolvedValueOnce({ rows: [{ id: 'ver-existing' }] })       // SELECT existing draft
        .mockResolvedValueOnce({ rows: [updatedDraft] })                   // UPDATE fsm_versions
        .mockResolvedValueOnce({ rows: [] });                              // INSERT fsm_audit_log

      const result = await fsmService.saveDraft('comp-1', 'job', JOB_SCXML, 'user-1', 'user@test.com');

      expect(result.ok).toBe(true);
      expect(result.draft.id).toBe('ver-existing');
      // Should UPDATE, not INSERT a new version
      const updateCall = db.query.mock.calls[2];
      expect(updateCall[0]).toContain('UPDATE fsm_versions');
    });

    test('saveDraft returns machine-not-found error for unknown machine', async () => {
      db.query.mockResolvedValueOnce({ rows: [] }); // no machine found

      const result = await fsmService.saveDraft('comp-1', 'unknown', JOB_SCXML, 'user-1', 'user@test.com');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    test('getDraft queries for draft status version', async () => {
      const draftRow = { id: 'ver-1', status: 'draft', scxml_source: JOB_SCXML };
      db.query.mockResolvedValueOnce({ rows: [draftRow] });

      const draft = await fsmService.getDraft('comp-1', 'job');

      expect(draft).toEqual(draftRow);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('draft'),
        ['comp-1', 'job'],
      );
    });

    test('getDraft returns null when no draft exists', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      const draft = await fsmService.getDraft('comp-1', 'job');
      expect(draft).toBeNull();
    });

    test('getActiveVersion returns published version without affecting draft', async () => {
      const activeRow = { id: 'ver-pub', status: 'published', scxml_source: JOB_SCXML };
      db.query.mockResolvedValueOnce({ rows: [activeRow] });

      const active = await fsmService.getActiveVersion('comp-1', 'job');

      expect(active).toEqual(activeRow);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('active_version_id'),
        ['comp-1', 'job'],
      );
    });
  });

  // ===========================================================================
  // TC-FSM-011: Publish blocked with errors
  // ===========================================================================
  describe('TC-FSM-011: Publish blocked when validation errors exist', () => {
    test('saveDraft rejects when SCXML is missing initial attribute', async () => {
      const result = await fsmService.saveDraft('comp-1', 'job', BAD_SCXML_NO_INITIAL, 'user-1', 'user@test.com');

      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.message.match(/initial/i))).toBe(true);
      // No DB calls should have been made
      expect(db.query).not.toHaveBeenCalled();
    });

    test('saveDraft rejects when SCXML has broken transition target', async () => {
      const result = await fsmService.saveDraft('comp-1', 'job', BAD_SCXML_BAD_TARGET, 'user-1', 'user@test.com');

      expect(result.ok).toBe(false);
      expect(result.errors.some(e => e.message.match(/NonExistent/i))).toBe(true);
      expect(db.query).not.toHaveBeenCalled();
    });

    test('saveDraft rejects when SCXML has forbidden elements', async () => {
      const result = await fsmService.saveDraft('comp-1', 'job', BAD_SCXML_FORBIDDEN, 'user-1', 'user@test.com');

      expect(result.ok).toBe(false);
      expect(result.errors.some(e => e.message.match(/forbidden.*script/i))).toBe(true);
      expect(db.query).not.toHaveBeenCalled();
    });

    test('publishDraft rejects when stored draft SCXML fails re-validation', async () => {
      // Draft stored with bad SCXML (simulating a draft saved before validation was tightened)
      db.query
        .mockResolvedValueOnce({ rows: [{ id: 'machine-1' }] })          // SELECT fsm_machines
        .mockResolvedValueOnce({ rows: [{                                  // SELECT draft
          id: 'ver-draft',
          scxml_source: BAD_SCXML_BAD_TARGET,
        }] });

      const result = await fsmService.publishDraft('comp-1', 'job', 'Trying to publish', 'user-1', 'user@test.com');

      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // TC-FSM-010: Publish draft
  // ===========================================================================
  describe('TC-FSM-010: Publish draft promotes draft to published', () => {
    test('publishDraft archives old version, promotes draft, updates machine', async () => {
      const publishedVersion = {
        id: 'ver-new',
        version_number: 13,
        status: 'published',
        scxml_source: JOB_SCXML,
        published_by: 'user@test.com',
      };

      db.query
        .mockResolvedValueOnce({ rows: [{ id: 'machine-1' }] })          // SELECT fsm_machines
        .mockResolvedValueOnce({ rows: [{                                  // SELECT draft
          id: 'ver-draft',
          scxml_source: JOB_SCXML,
        }] })
        .mockResolvedValueOnce({ rows: [] })                               // BEGIN
        .mockResolvedValueOnce({ rows: [] })                               // UPDATE archived
        .mockResolvedValueOnce({ rows: [publishedVersion] })               // UPDATE draft -> published
        .mockResolvedValueOnce({ rows: [] })                               // UPDATE fsm_machines.active_version_id
        .mockResolvedValueOnce({ rows: [] })                               // COMMIT
        .mockResolvedValueOnce({ rows: [] });                              // INSERT fsm_audit_log

      const result = await fsmService.publishDraft('comp-1', 'job', 'Added InReview state', 'user-1', 'user@test.com');

      expect(result.ok).toBe(true);
      expect(result.version.version_number).toBe(13);
      expect(result.version.status).toBe('published');

      // Verify transaction flow
      const calls = db.query.mock.calls;
      expect(calls[2][0]).toBe('BEGIN');
      // Archive old published
      expect(calls[3][0]).toContain("status = 'archived'");
      // Promote draft
      expect(calls[4][0]).toContain("status = 'published'");
      // Update active_version_id
      expect(calls[5][0]).toContain('active_version_id');
      expect(calls[6][0]).toBe('COMMIT');
      // Audit log
      expect(calls[7][0]).toContain('fsm_audit_log');
      expect(calls[7][1]).toContain('publish');
    });

    test('publishDraft returns error when no draft exists', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{ id: 'machine-1' }] })          // SELECT fsm_machines
        .mockResolvedValueOnce({ rows: [] });                              // SELECT draft (empty)

      const result = await fsmService.publishDraft('comp-1', 'job', 'note', 'user-1', 'user@test.com');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('No draft to publish');
    });

    test('publishDraft requires a change note', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{ id: 'machine-1' }] })
        .mockResolvedValueOnce({ rows: [{
          id: 'ver-draft',
          scxml_source: JOB_SCXML,
        }] });

      const result = await fsmService.publishDraft('comp-1', 'job', '', 'user-1', 'user@test.com');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/change note/i);
    });

    test('publishDraft rolls back on DB error', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{ id: 'machine-1' }] })
        .mockResolvedValueOnce({ rows: [{
          id: 'ver-draft',
          scxml_source: JOB_SCXML,
        }] })
        .mockResolvedValueOnce({ rows: [] })                               // BEGIN
        .mockResolvedValueOnce({ rows: [] })                               // UPDATE archived
        .mockRejectedValueOnce(new Error('DB write failure'))              // UPDATE draft -> published (fails)
        .mockResolvedValueOnce({ rows: [] });                              // ROLLBACK

      await expect(
        fsmService.publishDraft('comp-1', 'job', 'note', 'user-1', 'user@test.com'),
      ).rejects.toThrow('DB write failure');

      // Verify ROLLBACK was called
      const lastCall = db.query.mock.calls[db.query.mock.calls.length - 1];
      expect(lastCall[0]).toBe('ROLLBACK');
    });

    test('publishDraft invalidates graph cache after successful publish', async () => {
      // Pre-populate cache
      const graph = fsmService.parseSCXML(JOB_SCXML);
      fsmService.graphCache.set('comp-1:job', graph);

      const publishedVersion = {
        id: 'ver-new',
        version_number: 2,
        status: 'published',
        scxml_source: JOB_SCXML,
      };

      db.query
        .mockResolvedValueOnce({ rows: [{ id: 'machine-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'ver-draft', scxml_source: JOB_SCXML }] })
        .mockResolvedValueOnce({ rows: [] })                               // BEGIN
        .mockResolvedValueOnce({ rows: [] })                               // archive
        .mockResolvedValueOnce({ rows: [publishedVersion] })               // promote
        .mockResolvedValueOnce({ rows: [] })                               // update machine
        .mockResolvedValueOnce({ rows: [] })                               // COMMIT
        .mockResolvedValueOnce({ rows: [] });                              // audit

      await fsmService.publishDraft('comp-1', 'job', 'note', 'user-1', 'user@test.com');

      expect(fsmService.graphCache.has('comp-1:job')).toBe(false);
    });
  });

  // ===========================================================================
  // TC-FSM-012: List versions returns versions in order
  // ===========================================================================
  describe('TC-FSM-012: List versions returns versions in order', () => {
    test('listVersions returns all versions for a machine', async () => {
      const versions = [
        { id: 'v3', version_number: 3, status: 'published' },
        { id: 'v2', version_number: 2, status: 'archived' },
        { id: 'v1', version_number: 1, status: 'archived' },
      ];
      db.query.mockResolvedValueOnce({ rows: versions });

      const result = await fsmService.listVersions('comp-1', 'job');

      expect(result).toHaveLength(3);
      expect(result[0].version_number).toBe(3);
      expect(result[2].version_number).toBe(1);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY'),
        ['comp-1', 'job'],
      );
    });
  });

  // ===========================================================================
  // Restore version
  // ===========================================================================
  describe('Restore version as draft', () => {
    test('restoreVersion creates a draft from a previous version SCXML', async () => {
      const sourceVersion = {
        id: 'ver-old',
        version_number: 5,
        scxml_source: JOB_SCXML,
        company_id: 'comp-1',
      };
      const newDraft = {
        id: 'ver-new-draft',
        version_number: 8,
        status: 'draft',
        scxml_source: JOB_SCXML,
      };

      db.query
        // restoreVersion: find source version
        .mockResolvedValueOnce({ rows: [sourceVersion] })
        // saveDraft: find machine
        .mockResolvedValueOnce({ rows: [{ id: 'machine-1' }] })
        // saveDraft: check existing draft
        .mockResolvedValueOnce({ rows: [] })
        // saveDraft: max version
        .mockResolvedValueOnce({ rows: [{ max_ver: 7 }] })
        // saveDraft: INSERT draft
        .mockResolvedValueOnce({ rows: [newDraft] })
        // saveDraft: audit log (save_draft)
        .mockResolvedValueOnce({ rows: [] })
        // restoreVersion: audit log (restore)
        .mockResolvedValueOnce({ rows: [] });

      const result = await fsmService.restoreVersion('comp-1', 'job', 'ver-old', 'user-1', 'user@test.com');

      expect(result.ok).toBe(true);
      expect(result.draft.version_number).toBe(8);

      // Verify restore audit log was written
      const restoreAuditCall = db.query.mock.calls[6];
      expect(restoreAuditCall[0]).toContain('fsm_audit_log');
      expect(restoreAuditCall[1]).toContain('restore');
    });

    test('restoreVersion returns error for non-existent version', async () => {
      db.query.mockResolvedValueOnce({ rows: [] }); // version not found

      const result = await fsmService.restoreVersion('comp-1', 'job', 999, 'user-1', 'user@test.com');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });
  });
});

// =============================================================================
// TC-FSM-008: Company data isolation
// =============================================================================
describe('FSM Data Isolation', () => {
  test('TC-FSM-008: listMachines includes company_id filter in SQL', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ machine_key: 'job', company_id: 'comp-1' }],
    });

    const machines = await fsmService.listMachines('comp-1');

    expect(machines).toHaveLength(1);
    expect(machines[0].company_id).toBe('comp-1');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('company_id'),
      ['comp-1'],
    );
  });

  test('getActiveVersion includes company_id filter in SQL', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'ver-1', status: 'published' }],
    });

    await fsmService.getActiveVersion('comp-1', 'job');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('company_id'),
      ['comp-1', 'job'],
    );
  });

  test('getDraft includes company_id filter in SQL', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await fsmService.getDraft('comp-1', 'job');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('company_id'),
      ['comp-1', 'job'],
    );
  });

  test('listVersions includes company_id filter in SQL', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await fsmService.listVersions('comp-1', 'job');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('company_id'),
      ['comp-1', 'job'],
    );
  });

  test('saveDraft scopes machine lookup to company_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // machine not found for this company

    const result = await fsmService.saveDraft('comp-2', 'job', JOB_SCXML, 'user-1', 'user@test.com');

    expect(result.ok).toBe(false);
    // The SQL must filter by company_id
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('company_id'),
      ['comp-2', 'job'],
    );
  });

  test('publishDraft scopes machine lookup to company_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // machine not found

    const result = await fsmService.publishDraft('comp-2', 'job', 'note', 'user-1', 'user@test.com');

    expect(result.ok).toBe(false);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('company_id'),
      ['comp-2', 'job'],
    );
  });

  test('restoreVersion checks version belongs to company', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // version not found for this company

    const result = await fsmService.restoreVersion('comp-2', 'job', 100, 'user-1', 'user@test.com');

    expect(result.ok).toBe(false);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('company_id'),
      [100, 'comp-2'],
    );
  });
});

// =============================================================================
// Validation endpoint behavior
// =============================================================================
describe('Validation endpoint behavior', () => {
  test('validateSCXML returns errors for forbidden elements', () => {
    const result = fsmService.validateSCXML(BAD_SCXML_FORBIDDEN);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.match(/forbidden.*script/i))).toBe(true);
  });

  test('validateSCXML returns valid for well-formed job.scxml', () => {
    const result = fsmService.validateSCXML(JOB_SCXML);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('validateSCXML returns valid for well-formed lead.scxml', () => {
    const result = fsmService.validateSCXML(LEAD_SCXML);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('validateSCXML returns errors for missing initial', () => {
    const result = fsmService.validateSCXML(BAD_SCXML_NO_INITIAL);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.match(/initial/i))).toBe(true);
  });

  test('validateSCXML returns errors for non-existent transition target', () => {
    const result = fsmService.validateSCXML(BAD_SCXML_BAD_TARGET);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.match(/NonExistent/i))).toBe(true);
  });

  test('validateSCXML returns errors for malformed XML', () => {
    const result = fsmService.validateSCXML('<not valid xml>>>');

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('validateSCXML returns warnings for unreachable states but valid=true', () => {
    const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"><transition event="GO" target="B"/></state>
  <state id="B"/>
  <state id="Orphan"/>
</scxml>`;
    const result = fsmService.validateSCXML(xml);

    // Unreachable is a warning, not an error
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.message.match(/unreachable|Orphan/i))).toBe(true);
  });

  test('validateSCXML detects duplicate state IDs as error', () => {
    const xml = `<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="A">
  <state id="A"><transition event="GO" target="B"/></state>
  <state id="A"/>
  <state id="B"/>
</scxml>`;
    const result = fsmService.validateSCXML(xml);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.match(/duplicate.*A/i))).toBe(true);
  });
});

// =============================================================================
// TC-FSM-017: Override -- missing reason rejected (service-level)
// =============================================================================
describe('Override validation (service-level)', () => {
  test('TC-FSM-017: getAllStates returns null when no published version exists', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no active version

    const states = await fsmService.getAllStates('comp-1', 'job');
    expect(states).toBeNull();
  });

  test('getAllStates returns state statusNames from published graph', async () => {
    // Pre-populate cache
    const graph = fsmService.parseSCXML(JOB_SCXML);
    fsmService.graphCache.set('comp-1:job', graph);

    const states = await fsmService.getAllStates('comp-1', 'job');

    expect(states).toContain('Submitted');
    expect(states).toContain('Follow Up with Client');
    expect(states).toContain('Waiting for parts');
    expect(states).toContain('Canceled');
    expect(states).toContain('Job is Done');
  });

  test('resolveTransition returns fallback when no published graph exists', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no active version

    const result = await fsmService.resolveTransition('comp-new', 'job', 'Submitted', 'TO_FOLLOW_UP');

    expect(result.valid).toBeNull();
    expect(result.fallback).toBe(true);
  });
});

// =============================================================================
// Audit logging
// =============================================================================
describe('Audit logging', () => {
  test('logAudit inserts correct data into fsm_audit_log', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await fsmService.logAudit('comp-1', 'job', 'ver-1', 'user-1', 'user@test.com', 'save_draft', { foo: 'bar' });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('fsm_audit_log');
    expect(params[0]).toBe('comp-1');
    expect(params[1]).toBe('job');
    expect(params[2]).toBe('ver-1');
    expect(params[3]).toBe('user-1');
    expect(params[4]).toBe('user@test.com');
    expect(params[5]).toBe('save_draft');
    expect(params[6]).toBe(JSON.stringify({ foo: 'bar' }));
  });

  test('logAudit handles null payload', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await fsmService.logAudit('comp-1', 'job', 'ver-1', 'user-1', 'user@test.com', 'test', null);

    const [, params] = db.query.mock.calls[0];
    expect(params[6]).toBeNull();
  });
});

// =============================================================================
// Cache behavior
// =============================================================================
describe('Graph cache', () => {
  test('getPublishedGraph caches parsed graph and returns from cache on second call', async () => {
    const activeRow = { id: 'ver-1', scxml_source: JOB_SCXML };
    db.query.mockResolvedValueOnce({ rows: [activeRow] });

    const graph1 = await fsmService.getPublishedGraph('comp-1', 'job');
    const graph2 = await fsmService.getPublishedGraph('comp-1', 'job');

    // Only one DB call -- second comes from cache
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(graph1).toBe(graph2); // same reference
    expect(graph1.initialState).toBe('Submitted');
  });

  test('invalidateCache removes the cached graph', async () => {
    const graph = fsmService.parseSCXML(JOB_SCXML);
    fsmService.graphCache.set('comp-1:job', graph);

    fsmService.invalidateCache('comp-1', 'job');

    expect(fsmService.graphCache.has('comp-1:job')).toBe(false);
  });
});
