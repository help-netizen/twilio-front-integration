const { XMLParser } = require('fast-xml-parser');
const db = require('../db/connection');

/**
 * Parse SCXML XML string into a structured graph.
 * @param {string} xmlString - Raw SCXML XML content
 * @returns {{ initialState: string, states: Map, finalStates: string[], metadata: object }}
 */
function parseSCXML(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
  });

  const doc = parser.parse(xmlString);
  const scxml = doc.scxml;

  const initialState = scxml['@_initial'];
  const metadata = {
    machine: scxml['@_blanc:machine'] || null,
    title: scxml['@_blanc:title'] || null,
  };

  const states = new Map();
  const finalStates = [];

  // Collect <state> elements
  const stateNodes = normalizeToArray(scxml.state);
  for (const node of stateNodes) {
    const state = parseStateNode(node, false);
    states.set(state.id, state);
  }

  // Collect <final> elements
  const finalNodes = normalizeToArray(scxml.final);
  for (const node of finalNodes) {
    const state = parseStateNode(node, true);
    states.set(state.id, state);
    finalStates.push(state.id);
  }

  // Resolve targetStatusName for transitions
  for (const state of states.values()) {
    for (const tr of state.transitions) {
      const targetState = states.get(tr.target);
      tr.targetStatusName = targetState ? targetState.statusName : tr.target;
    }
  }

  return { initialState, states, finalStates, metadata };
}

/**
 * Parse a single <state> or <final> node into a state object.
 */
function parseStateNode(node, isFinal) {
  const id = node['@_id'];
  const label = node['@_blanc:label'] || id.replace(/_/g, ' ');
  const statusName = node['@_blanc:statusName'] || label;

  const transitions = [];
  const transitionNodes = normalizeToArray(node.transition);
  for (const tr of transitionNodes) {
    transitions.push({
      event: tr['@_event'] || null,
      target: tr['@_target'] || null,
      targetStatusName: null, // resolved later
      action: parseBool(tr['@_blanc:action']),
      label: tr['@_blanc:label'] || null,
      icon: tr['@_blanc:icon'] || null,
      confirm: parseBool(tr['@_blanc:confirm']),
      confirmText: tr['@_blanc:confirmText'] || null,
      roles: tr['@_blanc:roles'] ? tr['@_blanc:roles'].split(',').map(s => s.trim()) : [],
      order: tr['@_blanc:order'] != null ? Number(tr['@_blanc:order']) : null,
      hotkey: tr['@_blanc:hotkey'] || null,
    });
  }

  return { id, statusName, label, isFinal, transitions };
}

/**
 * Validate SCXML and return errors/warnings.
 * @param {string} xmlString - Raw SCXML XML content
 * @returns {{ valid: boolean, errors: Array, warnings: Array }}
 */
function validateSCXML(xmlString) {
  const errors = [];
  const warnings = [];

  // E01: XML parse error
  let doc;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      allowBooleanAttributes: true,
    });
    doc = parser.parse(xmlString);
  } catch (e) {
    errors.push({ message: `XML parse error: ${e.message}`, line: 1, col: 1, severity: 'error' });
    return { valid: false, errors, warnings };
  }

  // E02: Root element is not <scxml>
  if (!doc.scxml) {
    errors.push({ message: 'Root element is not <scxml>', line: 1, col: 1, severity: 'error' });
    return { valid: false, errors, warnings };
  }

  const scxml = doc.scxml;

  // E03: Missing initial attribute
  if (!scxml['@_initial']) {
    errors.push({ message: 'Missing initial attribute on <scxml>', line: 1, col: 1, severity: 'error' });
  }

  // Collect all state/final IDs
  const stateNodes = normalizeToArray(scxml.state);
  const finalNodes = normalizeToArray(scxml.final);
  const allNodes = [...stateNodes, ...finalNodes];

  const stateIds = new Set();
  const duplicateIds = new Set();

  for (const node of allNodes) {
    const id = node['@_id'];
    if (stateIds.has(id)) {
      duplicateIds.add(id);
    }
    stateIds.add(id);
  }

  // E05: Duplicate state IDs
  for (const id of duplicateIds) {
    errors.push({ message: `Duplicate state ID: ${id}`, line: 1, col: 1, severity: 'error' });
  }

  // E04: initial state does not exist
  const initial = scxml['@_initial'];
  if (initial && !stateIds.has(initial)) {
    errors.push({ message: `Initial state "${initial}" does not exist`, line: 1, col: 1, severity: 'error' });
  }

  // E07: Forbidden elements
  const forbidden = ['script', 'invoke', 'send', 'onentry', 'onexit', 'parallel', 'history', 'datamodel'];
  for (const tag of forbidden) {
    if (scxml[tag] !== undefined) {
      errors.push({ message: `Forbidden element: <${tag}>`, line: 1, col: 1, severity: 'error' });
    }
    // Also check inside states
    for (const node of allNodes) {
      if (node[tag] !== undefined) {
        errors.push({ message: `Forbidden element: <${tag}> inside state "${node['@_id']}"`, line: 1, col: 1, severity: 'error' });
      }
    }
  }

  // Collect transitions for E06, W01, W02, W03
  const incomingCount = new Map();
  for (const id of stateIds) {
    incomingCount.set(id, 0);
  }

  for (const node of allNodes) {
    const transitions = normalizeToArray(node.transition);
    const eventsInState = new Set();

    for (const tr of transitions) {
      const target = tr['@_target'];
      const event = tr['@_event'];

      // E06: target references non-existent state
      if (target && !stateIds.has(target)) {
        errors.push({ message: `Transition target "${target}" does not exist (from state "${node['@_id']}")`, line: 1, col: 1, severity: 'error' });
      }

      // Track incoming transitions
      if (target && incomingCount.has(target)) {
        incomingCount.set(target, incomingCount.get(target) + 1);
      }

      // W03: Duplicate event names within same state
      if (event) {
        if (eventsInState.has(event)) {
          warnings.push({ message: `Duplicate event "${event}" in state "${node['@_id']}"`, severity: 'warning' });
        }
        eventsInState.add(event);
      }
    }
  }

  // W01: Unreachable states (no incoming transitions except initial)
  for (const [id, count] of incomingCount) {
    if (count === 0 && id !== initial) {
      warnings.push({ message: `Unreachable state: ${id}`, severity: 'warning' });
    }
  }

  // W02: Non-final states without outgoing transitions
  const finalIds = new Set(finalNodes.map(n => n['@_id']));
  for (const node of stateNodes) {
    const transitions = normalizeToArray(node.transition);
    if (transitions.length === 0 && !finalIds.has(node['@_id'])) {
      warnings.push({ message: `Non-final state "${node['@_id']}" has no outgoing transitions`, severity: 'warning' });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Normalize undefined/single/array to array */
function normalizeToArray(val) {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

/** Parse boolean-ish attribute value */
function parseBool(val) {
  if (val === true || val === 'true') return true;
  return false;
}

// =============================================================================
// Cache
// =============================================================================

/** Module-level graph cache: key = "companyId:machineKey" */
const graphCache = new Map();

/**
 * Invalidate the cached graph for a given company + machine.
 * @param {number} companyId
 * @param {string} machineKey
 */
function invalidateCache(companyId, machineKey) {
  graphCache.delete(`${companyId}:${machineKey}`);
}

// =============================================================================
// Audit Logging
// =============================================================================

/**
 * Log an FSM audit event.
 * @param {number} companyId
 * @param {string} machineKey
 * @param {number|null} versionId
 * @param {number|null} actorId
 * @param {string|null} actorEmail
 * @param {string} action
 * @param {object|null} payload
 */
async function logAudit(companyId, machineKey, versionId, actorId, actorEmail, action, payload) {
  const sql = `
    INSERT INTO fsm_audit_log (company_id, machine_key, version_id, actor_id, actor_email, action, payload_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `;
  await db.query(sql, [
    companyId,
    machineKey,
    versionId,
    actorId,
    actorEmail,
    action,
    payload ? JSON.stringify(payload) : null,
  ]);
}

// =============================================================================
// Write / Mutation Functions
// =============================================================================

/**
 * Save (upsert) a draft version for a machine.
 * @param {number} companyId
 * @param {string} machineKey
 * @param {string} scxmlSource
 * @param {number} userId
 * @param {string} userEmail
 * @returns {Promise<{ ok: boolean, errors?: Array, draft?: object }>}
 */
async function saveDraft(companyId, machineKey, scxmlSource, userId, userEmail) {
  // Validate SCXML first
  const validation = validateSCXML(scxmlSource);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }

  // Find the machine
  const machineRes = await db.query(
    'SELECT id FROM fsm_machines WHERE company_id = $1 AND machine_key = $2',
    [companyId, machineKey],
  );
  if (machineRes.rows.length === 0) {
    return { ok: false, error: `Machine '${machineKey}' not found for company ${companyId}` };
  }
  const machineId = machineRes.rows[0].id;

  // Check if a draft already exists
  const draftRes = await db.query(
    'SELECT id FROM fsm_versions WHERE machine_id = $1 AND status = $2',
    [machineId, 'draft'],
  );

  let draft;
  if (draftRes.rows.length > 0) {
    // Update existing draft
    const updateRes = await db.query(
      `UPDATE fsm_versions
       SET scxml_source = $1, created_by = $2, created_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [scxmlSource, userEmail, draftRes.rows[0].id],
    );
    draft = updateRes.rows[0];
  } else {
    // Determine next version number
    const maxRes = await db.query(
      'SELECT COALESCE(MAX(version_number), 0) AS max_ver FROM fsm_versions WHERE machine_id = $1',
      [machineId],
    );
    const nextVersion = maxRes.rows[0].max_ver + 1;

    const insertRes = await db.query(
      `INSERT INTO fsm_versions (machine_id, company_id, version_number, status, scxml_source, created_by, created_at)
       VALUES ($1, $2, $3, 'draft', $4, $5, NOW())
       RETURNING *`,
      [machineId, companyId, nextVersion, scxmlSource, userEmail],
    );
    draft = insertRes.rows[0];
  }

  // Log audit
  await logAudit(companyId, machineKey, draft.id, userId, userEmail, 'save_draft', null);

  return { ok: true, draft };
}

/**
 * Publish the current draft version for a machine.
 * @param {number} companyId
 * @param {string} machineKey
 * @param {string} changeNote
 * @param {number} userId
 * @param {string} userEmail
 * @returns {Promise<{ ok: boolean, error?: string, errors?: Array, version?: object }>}
 */
async function publishDraft(companyId, machineKey, changeNote, userId, userEmail) {
  // Find the machine
  const machineRes = await db.query(
    'SELECT id FROM fsm_machines WHERE company_id = $1 AND machine_key = $2',
    [companyId, machineKey],
  );
  if (machineRes.rows.length === 0) {
    return { ok: false, error: `Machine '${machineKey}' not found for company ${companyId}` };
  }
  const machineId = machineRes.rows[0].id;

  // Find the draft
  const draftRes = await db.query(
    'SELECT * FROM fsm_versions WHERE machine_id = $1 AND status = $2',
    [machineId, 'draft'],
  );
  if (draftRes.rows.length === 0) {
    return { ok: false, error: 'No draft to publish' };
  }
  const draft = draftRes.rows[0];

  // Re-validate the draft SCXML
  const validation = validateSCXML(draft.scxml_source);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }

  // Change note is required
  if (!changeNote || !changeNote.trim()) {
    return { ok: false, error: 'Change note required' };
  }

  try {
    await db.query('BEGIN');

    // 1. Archive current published version(s)
    await db.query(
      `UPDATE fsm_versions SET status = 'archived' WHERE machine_id = $1 AND status = 'published'`,
      [machineId],
    );

    // 2. Promote the draft to published
    const promoteRes = await db.query(
      `UPDATE fsm_versions
       SET status = 'published', published_by = $1, published_at = NOW(), change_note = $2
       WHERE id = $3
       RETURNING *`,
      [userEmail, changeNote.trim(), draft.id],
    );
    const publishedVersion = promoteRes.rows[0];

    // 3. Update fsm_machines.active_version_id
    await db.query(
      'UPDATE fsm_machines SET active_version_id = $1, updated_at = NOW() WHERE id = $2',
      [publishedVersion.id, machineId],
    );

    await db.query('COMMIT');

    // 4. Invalidate cache
    invalidateCache(companyId, machineKey);

    // 5. Log audit
    await logAudit(companyId, machineKey, publishedVersion.id, userId, userEmail, 'publish', {
      change_note: changeNote.trim(),
      version_number: publishedVersion.version_number,
    });

    return { ok: true, version: publishedVersion };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

/**
 * Restore a previous version's SCXML into a new/existing draft.
 * @param {number} companyId
 * @param {string} machineKey
 * @param {number} versionId
 * @param {number} userId
 * @param {string} userEmail
 * @returns {Promise<{ ok: boolean, error?: string, draft?: object }>}
 */
async function restoreVersion(companyId, machineKey, versionId, userId, userEmail) {
  // Find the specified version, ensuring it belongs to this company
  const versionRes = await db.query(
    'SELECT * FROM fsm_versions WHERE id = $1 AND company_id = $2',
    [versionId, companyId],
  );
  if (versionRes.rows.length === 0) {
    return { ok: false, error: 'Version not found' };
  }
  const sourceVersion = versionRes.rows[0];

  // Use saveDraft to create or overwrite the draft with the restored SCXML
  const result = await saveDraft(companyId, machineKey, sourceVersion.scxml_source, userId, userEmail);
  if (!result.ok) {
    return result;
  }

  // Log audit for the restore action
  await logAudit(companyId, machineKey, result.draft.id, userId, userEmail, 'restore', {
    restored_from_version_id: sourceVersion.id,
    restored_from_version_number: sourceVersion.version_number,
  });

  return { ok: true, draft: result.draft };
}

// =============================================================================
// CRUD Read Functions
// =============================================================================

/**
 * List all FSM machines for a company.
 * @param {number} companyId
 * @returns {Promise<Array>}
 */
async function listMachines(companyId) {
  const sql = `
    SELECT m.id, m.machine_key, m.title, m.description, m.active_version_id,
           m.created_at, m.updated_at,
           v.version_number AS active_version_number,
           v.published_at AS active_published_at,
           v.published_by AS active_published_by,
           (SELECT COUNT(*) FROM fsm_versions WHERE machine_id = m.id AND status = 'draft') > 0 AS has_draft
    FROM fsm_machines m
    LEFT JOIN fsm_versions v ON v.id = m.active_version_id
    WHERE m.company_id = $1
    ORDER BY m.machine_key
  `;
  const { rows } = await db.query(sql, [companyId]);
  return rows;
}

/**
 * Get the active (published) version for a machine.
 * @param {number} companyId
 * @param {string} machineKey
 * @returns {Promise<object|null>}
 */
async function getActiveVersion(companyId, machineKey) {
  const sql = `
    SELECT v.* FROM fsm_versions v
    JOIN fsm_machines m ON m.id = v.machine_id
    WHERE m.company_id = $1 AND m.machine_key = $2 AND v.id = m.active_version_id
  `;
  const { rows } = await db.query(sql, [companyId, machineKey]);
  return rows[0] || null;
}

/**
 * Get the draft version for a machine.
 * @param {number} companyId
 * @param {string} machineKey
 * @returns {Promise<object|null>}
 */
async function getDraft(companyId, machineKey) {
  const sql = `
    SELECT v.* FROM fsm_versions v
    JOIN fsm_machines m ON m.id = v.machine_id
    WHERE m.company_id = $1 AND m.machine_key = $2 AND v.status = 'draft'
  `;
  const { rows } = await db.query(sql, [companyId, machineKey]);
  return rows[0] || null;
}

/**
 * List all versions for a machine, newest first.
 * @param {number} companyId
 * @param {string} machineKey
 * @returns {Promise<Array>}
 */
async function listVersions(companyId, machineKey) {
  const sql = `
    SELECT v.* FROM fsm_versions v
    JOIN fsm_machines m ON m.id = v.machine_id
    WHERE m.company_id = $1 AND m.machine_key = $2
    ORDER BY v.version_number DESC
  `;
  const { rows } = await db.query(sql, [companyId, machineKey]);
  return rows;
}

// =============================================================================
// Runtime Functions
// =============================================================================

/**
 * Get the published (active) parsed graph for a company + machine.
 * Uses graphCache; loads from DB on cache miss.
 * @param {number} companyId
 * @param {string} machineKey
 * @returns {Promise<object|null>} ParsedGraph or null if no published version
 */
async function getPublishedGraph(companyId, machineKey) {
  const cacheKey = `${companyId}:${machineKey}`;

  if (graphCache.has(cacheKey)) {
    return graphCache.get(cacheKey);
  }

  const activeVersion = await getActiveVersion(companyId, machineKey);
  if (!activeVersion) {
    return null;
  }

  const parsed = parseSCXML(activeVersion.scxml_source);
  graphCache.set(cacheKey, parsed);
  return parsed;
}

/**
 * Find a state in the parsed graph by statusName or id.
 * Handles both underscore IDs (e.g. "Follow_Up_with_Client") and
 * display names (e.g. "Follow Up with Client").
 * @param {Map} states - The states Map from ParsedGraph
 * @param {string} stateRef - statusName or id to look up
 * @returns {object|null} The state object or null
 */
function findState(states, stateRef) {
  // 1. Direct lookup by id
  if (states.has(stateRef)) {
    return states.get(stateRef);
  }

  // 2. Lookup by statusName
  for (const state of states.values()) {
    if (state.statusName === stateRef) {
      return state;
    }
  }

  // 3. Normalize: replace spaces with underscores and try by id
  const normalized = stateRef.replace(/ /g, '_');
  if (states.has(normalized)) {
    return states.get(normalized);
  }

  // 4. Normalize: replace underscores with spaces and try by statusName
  const denormalized = stateRef.replace(/_/g, ' ');
  for (const state of states.values()) {
    if (state.statusName === denormalized) {
      return state;
    }
  }

  return null;
}

/**
 * Resolve whether a transition is valid from currentState given an event or target.
 * @param {number} companyId
 * @param {string} machineKey
 * @param {string} currentState - Current state statusName or id
 * @param {string} eventOrTarget - Event name or target state name/id
 * @returns {Promise<{ valid: boolean|null, fallback?: boolean, targetState?: string, event?: string, error?: string }>}
 */
async function resolveTransition(companyId, machineKey, currentState, eventOrTarget) {
  const graph = await getPublishedGraph(companyId, machineKey);
  if (!graph) {
    return { valid: null, fallback: true };
  }

  const state = findState(graph.states, currentState);
  if (!state) {
    return { valid: false, error: `State '${currentState}' not found in published workflow` };
  }

  // a. Try matching by event
  let transition = state.transitions.find(tr => tr.event && tr.event === eventOrTarget);

  // b. Try matching by targetStatusName (backward compat — callers may pass target name)
  if (!transition) {
    transition = state.transitions.find(tr => tr.targetStatusName === eventOrTarget);
  }

  // c. Try matching by target state id
  if (!transition) {
    transition = state.transitions.find(tr => tr.target === eventOrTarget);
  }

  if (transition) {
    return {
      valid: true,
      targetState: transition.targetStatusName || transition.target,
      event: transition.event,
    };
  }

  return { valid: false, error: 'Transition not allowed' };
}

/**
 * Get available action buttons for a state, filtered by user roles.
 * @param {number} companyId
 * @param {string} machineKey
 * @param {string} currentState - Current state statusName or id
 * @param {string[]} userRoles - Roles of the current user
 * @returns {Promise<{ actions: Array, fallback: boolean }>}
 */
async function getAvailableActions(companyId, machineKey, currentState, userRoles) {
  const graph = await getPublishedGraph(companyId, machineKey);
  if (!graph) {
    return { actions: [], fallback: true };
  }

  const state = findState(graph.states, currentState);
  if (!state) {
    return { actions: [], fallback: false };
  }

  const roles = userRoles || [];

  const actions = state.transitions
    .filter(tr => tr.action === true)
    .filter(tr => {
      if (!tr.roles || tr.roles.length === 0) return true;
      return tr.roles.some(r => roles.includes(r));
    })
    .sort((a, b) => {
      const orderA = a.order != null ? a.order : Infinity;
      const orderB = b.order != null ? b.order : Infinity;
      return orderA - orderB;
    })
    .map(tr => ({
      event: tr.event,
      label: tr.label,
      icon: tr.icon,
      confirm: tr.confirm,
      confirmText: tr.confirmText,
      order: tr.order,
      targetStatusName: tr.targetStatusName,
    }));

  return { actions, fallback: false };
}

/**
 * Get all state statusNames from the published graph (for override dropdown).
 * @param {number} companyId
 * @param {string} machineKey
 * @returns {Promise<string[]|null>} Array of statusNames or null if no published version
 */
async function getAllStates(companyId, machineKey) {
  const graph = await getPublishedGraph(companyId, machineKey);
  if (!graph) {
    return null;
  }

  const statusNames = [];
  for (const state of graph.states.values()) {
    statusNames.push(state.statusName);
  }
  return statusNames;
}

module.exports = {
  parseSCXML,
  validateSCXML,
  listMachines,
  getActiveVersion,
  getDraft,
  listVersions,
  saveDraft,
  publishDraft,
  restoreVersion,
  logAudit,
  invalidateCache,
  graphCache,
  getPublishedGraph,
  findState,
  resolveTransition,
  getAvailableActions,
  getAllStates,
};
