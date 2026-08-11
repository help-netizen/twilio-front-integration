/**
 * FSM Routes
 *
 * /api/fsm — Read & write endpoints for FSM machines, versions, and actions
 */

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const fsmService = require('../services/fsmService');
const jobsService = require('../services/jobsService');
const eventService = require('../services/eventService');
const realtimeService = require('../services/realtimeService');
const { userActor } = require('../services/jobActivityService');
const { getProviderScope } = require('../middleware/providerScope');
const { closePermissionError } = require('../services/jobTransitionPerms');
const { withTransaction } = require('../services/transactionService');
const { resolveFallbackJobTransition } = require('../services/jobWorkflowFallback');

/**
 * Server-derived roles for FSM action filtering (PF007-HARDENING-001):
 * client-supplied role hints are ignored; roles come from req.authz/req.user.
 */
function getServerRoles(req) {
    const roles = new Set(req.user?.roles || []);
    const roleKey = req.authz?.membership?.role_key;
    if (roleKey) {
        roles.add(roleKey);
        const legacy = {
            tenant_admin: 'company_admin',
            manager: 'company_admin',
            dispatcher: 'company_member',
            provider: 'company_member',
        }[roleKey];
        if (legacy) roles.add(legacy);
    }
    if (req.user?._devMode) {
        roles.add('company_admin');
        roles.add('company_member');
    }
    return [...roles];
}

const CANCEL_REASON_MAX_LENGTH = 1000;

function normalizeCancelReason(input) {
    const reason = typeof input === 'string' ? input.trim() : '';
    if (!reason) return { error: 'cancel reason is required' };
    if (reason.length > CANCEL_REASON_MAX_LENGTH) {
        return { error: `cancel reason must be ${CANCEL_REASON_MAX_LENGTH} characters or less` };
    }
    return { reason };
}

function applyError(status, message, code = null) {
    return Object.assign(new Error(message), {
        httpStatus: status,
        statusCode: status,
        ...(code ? { code } : {}),
    });
}

// Feature flags — default to true (enabled) during development
const FSM_EDITOR_ENABLED = process.env.FSM_EDITOR_ENABLED !== 'false';
const FSM_PUBLISHING_ENABLED = process.env.FSM_PUBLISHING_ENABLED !== 'false';

function requireEditorEnabled(req, res, next) {
  if (!FSM_EDITOR_ENABLED) {
    return res.status(403).json({ ok: false, error: 'FSM editor is disabled' });
  }
  next();
}

function requirePublishingEnabled(req, res, next) {
  if (!FSM_PUBLISHING_ENABLED) {
    return res.status(403).json({ ok: false, error: 'FSM publishing is disabled' });
  }
  next();
}

// ─── List machines ──────────────────────────────────────────────────────────────

router.get('/machines', requirePermission('fsm.viewer'), async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const machines = await fsmService.listMachines(companyId);
    res.json({ ok: true, data: machines });
  } catch (err) {
    console.error('[FSM] listMachines error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── Get active (published) version ─────────────────────────────────────────────

router.get('/:machineKey/active', requirePermission('fsm.viewer'), async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;
    const version = await fsmService.getActiveVersion(companyId, machineKey);
    if (!version) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    res.json({ ok: true, data: version });
  } catch (err) {
    console.error('[FSM] getActiveVersion error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── Get draft version ──────────────────────────────────────────────────────────

router.get('/:machineKey/draft', requireEditorEnabled, requirePermission('fsm.editor'), async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;
    const draft = await fsmService.getDraft(companyId, machineKey);
    res.json({ ok: true, data: draft });
  } catch (err) {
    console.error('[FSM] getDraft error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── List versions ──────────────────────────────────────────────────────────────

router.get('/:machineKey/versions', requireEditorEnabled, requirePermission('fsm.viewer'), async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;
    const versions = await fsmService.listVersions(companyId, machineKey);
    res.json({ ok: true, data: versions });
  } catch (err) {
    console.error('[FSM] listVersions error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── Save draft ────────────────────────────────────────────────────────────────

router.put('/:machineKey/draft', requireEditorEnabled, requirePermission('fsm.editor'), async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;
    const { scxml_source } = req.body || {};
    const userId = req.user?.crmUser?.id || req.user?.sub;
    const userEmail = req.user?.email;

    if (!scxml_source) {
      return res.status(400).json({ ok: false, error: 'scxml_source is required' });
    }

    const result = await fsmService.saveDraft(companyId, machineKey, scxml_source, userId, userEmail);
    if (!result.ok) {
      return res.status(400).json({ ok: false, errors: result.errors, error: result.error });
    }

    res.json({ ok: true, data: result.draft });
  } catch (err) {
    console.error('[FSM] saveDraft error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── Validate SCXML ────────────────────────────────────────────────────────────

router.post('/:machineKey/validate', requireEditorEnabled, requirePermission('fsm.editor'), async (req, res) => {
  try {
    const { scxml_source } = req.body || {};

    if (!scxml_source) {
      return res.status(400).json({ ok: false, error: 'scxml_source is required' });
    }

    const result = fsmService.validateSCXML(scxml_source);
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('[FSM] validateSCXML error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── Publish draft ─────────────────────────────────────────────────────────────

router.post('/:machineKey/publish', requireEditorEnabled, requirePublishingEnabled, requirePermission('fsm.publisher'), async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;
    const { change_note } = req.body || {};
    const userId = req.user?.crmUser?.id || req.user?.sub;
    const userEmail = req.user?.email;

    const result = await fsmService.publishDraft(companyId, machineKey, change_note, userId, userEmail);
    if (!result.ok) {
      const status = result.error === 'No draft to publish' ? 404 : 400;
      return res.status(status).json({ ok: false, error: result.error, errors: result.errors });
    }

    res.json({ ok: true, data: result.version });
  } catch (err) {
    console.error('[FSM] publishDraft error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── Restore version as draft ──────────────────────────────────────────────────

router.post('/:machineKey/versions/:versionId/restore', requireEditorEnabled, requirePermission('fsm.editor'), async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey, versionId } = req.params;
    const userId = req.user?.crmUser?.id || req.user?.sub;
    const userEmail = req.user?.email;

    const result = await fsmService.restoreVersion(companyId, machineKey, Number(versionId), userId, userEmail);
    if (!result.ok) {
      return res.status(404).json({ ok: false, error: result.error });
    }

    res.json({ ok: true, data: result.draft });
  } catch (err) {
    console.error('[FSM] restoreVersion error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── Apply transition ──────────────────────────────────────────────────────────

async function applyTransitionHandler(req, res) {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;
    const { entityId, event, reason } = req.body || {};

    if (!entityId || !event) {
      return res.status(400).json({ ok: false, error: 'entityId and event are required' });
    }

    if (machineKey !== 'job') {
      return res.status(400).json({ ok: false, error: `Unsupported machine: ${machineKey}` });
    }

    const applied = await withTransaction(async client => {
      // Lock and re-read inside the transaction so the resolved edge and update use
      // the same source state. Provider scope remains part of the tenant-owned read.
      const currentJob = await jobsService.getJobById(
        entityId,
        companyId,
        getProviderScope(req),
        { client, forUpdate: true }
      );
      if (!currentJob) throw applyError(404, `Job #${entityId} not found`);

      let result = await fsmService.resolveTransition(
        companyId,
        machineKey,
        currentJob.blanc_status,
        event,
        { queryable: client }
      );
      if (result.valid === null && result.fallback) {
        result = resolveFallbackJobTransition(currentJob.blanc_status, event);
      }
      if (!result.valid || !result.transition || result.transition.action !== true) {
        throw applyError(400, result.error || 'Transition not allowed');
      }

      const serverRoles = getServerRoles(req);
      const transitionRoles = result.transition.roles || [];
      if (transitionRoles.length > 0 && !transitionRoles.some(role => serverRoles.includes(role))) {
        throw applyError(403, 'Transition not permitted for this role', 'ACCESS_DENIED');
      }

      // Closing/terminal transitions use the same source of truth as PATCH
      // /jobs/:id/status, including the Visit completed gate.
      if (!req.user?._devMode) {
        const permErr = closePermissionError(req.authz?.permissions || [], result.targetState);
        if (permErr) throw applyError(permErr.status, permErr.error, 'ACCESS_DENIED');
      }

      let cancelReason = null;
      if (result.targetState === 'Canceled') {
        const parsedReason = normalizeCancelReason(reason);
        if (parsedReason.error) throw applyError(400, parsedReason.error);
        cancelReason = parsedReason.reason;
      }

      const actor = userActor(req.user?.crmUser?.id || null);
      await jobsService.updateBlancStatus(
        parseInt(entityId, 10),
        result.targetState,
        companyId,
        actor,
        { client, job: currentJob, resolvedTransition: result }
      );

      return {
        currentState: currentJob.blanc_status,
        result,
        cancelReason,
      };
    });

    const eventData = {
      from: applied.currentState,
      to: applied.result.targetState,
      actor_name: eventService.actorName(req),
      reason: applied.cancelReason,
    };
    eventService.logEvent(
      companyId,
      'job',
      entityId,
      applied.result.targetState === 'Canceled' ? 'canceled' : 'status_changed',
      eventData,
      'user',
      req.user?.sub
    );

    res.json({ ok: true, data: {
      previousState: applied.currentState,
      newState: applied.result.targetState,
      targetState: applied.result.targetState,
      entityId: Number(entityId),
      event: applied.result.event,
      op: applied.result.op || null,
      fallback: Boolean(applied.result.fallback),
    } });

    // Broadcast the status change over SSE so EVERY open client refreshes without a
    // reload — the FSM apply path otherwise never emitted 'job.updated' (only PATCH
    // /jobs/:id/status did), so button-driven transitions went unseen until refresh.
    // Fire-and-forget, after the response (mirrors the reschedule route).
    if (machineKey === 'job') {
      realtimeService.publishJobUpdate({ company_id: companyId });
    }
  } catch (err) {
    const status = err.httpStatus || err.statusCode || 500;
    if (status >= 500) console.error('[FSM] apply error:', err);
    res.status(status).json({
      ok: false,
      ...(err.code ? { code: err.code } : {}),
      error: err.message || 'Internal error',
      ...(err.code && err.code !== 'ACCESS_DENIED' ? { message: err.message } : {}),
    });
  }
}

router.post(
  '/:machineKey/apply',
  requirePermission('jobs.edit', 'jobs.done_pending_approval'),
  applyTransitionHandler
);

// ─── Override status (placeholder) ─────────────────────────────────────────────

router.post('/:machineKey/override', requirePermission('fsm.override'), async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;
    const { entityId, targetState, reason } = req.body || {};

    if (!entityId) {
      return res.status(400).json({ ok: false, error: 'entityId is required' });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ ok: false, error: 'reason is required' });
    }
    if (!targetState) {
      return res.status(400).json({ ok: false, error: 'targetState is required' });
    }

    // Validate that targetState exists in the published SCXML
    const allStates = await fsmService.getAllStates(companyId, machineKey);
    if (!allStates) {
      return res.status(404).json({ ok: false, error: 'No published workflow found' });
    }
    if (!allStates.includes(targetState)) {
      return res.status(400).json({ ok: false, error: `State "${targetState}" does not exist in published workflow` });
    }

    // Placeholder: full entity update in TASK-024/025
    res.json({ ok: true });
  } catch (err) {
    console.error('[FSM] override error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ─── Get available actions for a state ──────────────────────────────────────────

router.get('/:machineKey/actions', requirePermission('jobs.view', 'fsm.viewer'), async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;
    const { state } = req.query;

    if (!state) {
      return res.status(400).json({ ok: false, error: 'state query parameter is required' });
    }

    const userRoles = getServerRoles(req);
    const result = await fsmService.getAvailableActions(companyId, machineKey, state, userRoles);
    let actions = result.actions;

    // ROLE-JOB-CLOSE-PERMS-001: also drop closing/terminal actions the caller can't
    // perform, so the picker never offers a Visit-completed / Job-is-Done / Cancel button
    // that the /apply gate would then 403. Same source of truth as the gate itself.
    if (machineKey === 'job' && !req.user?._devMode) {
      const perms = req.authz?.permissions || [];
      actions = actions.filter(a => !closePermissionError(perms, a.target));
    }

    res.json({ ok: true, data: actions });
  } catch (err) {
    console.error('[FSM] getActions error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ── GET /:machineKey/states — all state names from published workflow ────────
router.get('/:machineKey/states', requirePermission('jobs.view', 'fsm.viewer'), async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;

    const graph = await fsmService.getPublishedGraph(companyId, machineKey);
    if (!graph) {
      return res.json({ ok: true, data: [], initialState: null });
    }

    const states = [];
    for (const state of graph.states.values()) {
      states.push(state.statusName);
    }

    // Resolve initialState statusName
    const initialNode = graph.states.get(graph.initialState);
    const initialState = initialNode ? initialNode.statusName : graph.initialState;

    res.json({ ok: true, data: states, initialState });
  } catch (err) {
    console.error('[FSM] getStates error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

module.exports = router;
module.exports.applyTransitionHandler = applyTransitionHandler;
