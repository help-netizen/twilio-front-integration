/**
 * FSM Routes
 *
 * /api/fsm — Read & write endpoints for FSM machines, versions, and actions
 */

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const fsmService = require('../services/fsmService');

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

// ─── Apply transition (placeholder) ────────────────────────────────────────────

router.post('/:machineKey/apply', async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;
    const { entityId, event } = req.body || {};

    if (!entityId || !event) {
      return res.status(400).json({ ok: false, error: 'entityId and event are required' });
    }

    // Placeholder: validate transition only. Full entity update in TASK-024/025.
    // For now we pass event as currentState placeholder — the real implementation
    // will load the entity's current state from jobsService/leadsService.
    const result = await fsmService.resolveTransition(companyId, machineKey, null, event);

    // If no published graph exists, allow as fallback
    if (result.valid === null && result.fallback) {
      return res.json({ ok: true, data: { targetState: null, event, fallback: true } });
    }

    if (!result.valid) {
      return res.status(400).json({ ok: false, error: result.error || 'Transition not allowed' });
    }

    res.json({ ok: true, data: { targetState: result.targetState, event: result.event } });
  } catch (err) {
    console.error('[FSM] apply error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

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

router.get('/:machineKey/actions', async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;
    const { state, roles } = req.query;

    if (!state) {
      return res.status(400).json({ ok: false, error: 'state query parameter is required' });
    }

    // Load the active version
    const version = await fsmService.getActiveVersion(companyId, machineKey);
    if (!version) {
      return res.json({ ok: true, data: [] });
    }

    // Parse SCXML and find transitions for the given state
    const graph = await fsmService.getPublishedGraph(companyId, machineKey);
    if (!graph) {
      return res.json({ ok: true, data: [] });
    }
    const stateNode = fsmService.findState(graph.states, state);
    if (!stateNode) {
      return res.json({ ok: true, data: [] });
    }

    // Filter transitions that are marked as actions
    let actions = stateNode.transitions
      .filter(tr => tr.action)
      .map(tr => ({
        event: tr.event,
        target: tr.targetStatusName,
        label: tr.label,
        icon: tr.icon,
        confirm: tr.confirm,
        confirmText: tr.confirmText,
        order: tr.order,
        roles: tr.roles.length > 0 ? tr.roles : null,
      }));

    // Filter by roles if provided
    if (roles) {
      const userRoles = roles.split(',').map(r => r.trim());
      actions = actions.filter(a => {
        if (!a.roles) return true; // no role restriction
        return a.roles.some(r => userRoles.includes(r));
      });
    }

    // Sort by order
    actions.sort((a, b) => {
      const oa = a.order != null ? a.order : Infinity;
      const ob = b.order != null ? b.order : Infinity;
      return oa - ob;
    });

    res.json({ ok: true, data: actions });
  } catch (err) {
    console.error('[FSM] getActions error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ── GET /:machineKey/states — all state names from published workflow ────────
router.get('/:machineKey/states', async (req, res) => {
  try {
    const companyId = req.companyFilter?.company_id;
    const { machineKey } = req.params;

    const states = await fsmService.getAllStates(companyId, machineKey);
    if (!states) {
      return res.json({ ok: true, data: [] });
    }

    res.json({ ok: true, data: states });
  } catch (err) {
    console.error('[FSM] getStates error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

module.exports = router;
