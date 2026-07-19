const express = require('express');
const router = express.Router();
const twilioSync = require('../services/twilioSync');
const syncQueries = require('../db/syncQueries');
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope } = require('../middleware/providerScope');

const SYNC_JOBS_DEFAULT_LIMIT = 200;
const SYNC_JOBS_MAX_LIMIT = 500;
const SYNC_JOBS_DEFAULT_WINDOW_DAYS = 30;

/**
 * POST /api/sync/today
 * Sync all calls from today (00:00 EST to now)
 */
router.post('/today', requirePermission('reports.calls.view'), async (req, res) => {
    try {
        console.log('🔄 Manual sync triggered: Today\'s calls');
        const result = await twilioSync.syncTodayCalls(req.companyFilter?.company_id);

        res.json({
            success: true,
            message: `Synced ${result.synced} new calls from last 3 days`,
            synced: result.synced,
            skipped: result.skipped,
            total: result.total
        });
    } catch (error) {
        console.error('Error in /api/sync/today:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to sync today\'s calls',
            message: error.message
        });
    }
});

/**
 * POST /api/sync/recent
 * Sync recent calls (last hour)
 */
router.post('/recent', requirePermission('reports.calls.view'), async (req, res) => {
    try {
        console.log('🔄 Manual sync triggered: Recent calls');
        const synced = await twilioSync.syncRecentCalls(req.companyFilter?.company_id);

        res.json({
            success: true,
            message: `Synced ${synced} recent calls`,
            synced
        });
    } catch (error) {
        console.error('Error in /api/sync/recent:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to sync recent calls',
            message: error.message
        });
    }
});

/**
 * GET /api/sync/jobs — MOBILE-TECH-APP-001 / MTECH-T1
 *
 * Provider-scoped delta for the native mobile read-only cache (spec §2.1–§2.4,
 * §4.1). Mounted under `/api/sync` with `authenticate, requireCompanyAccess`
 * (src/server.js); this handler additionally gates `jobs.view` and applies the
 * provider assigned-only scope.
 *
 * Query:
 *   since?        cursor "{ISO8601}|{jobId}" — absent/empty → initial full sync
 *   limit?        page size (default 200, max 500)
 *   window_days?  full-sync schedule window ± from now (default 30; ignored when
 *                 `since` is present — incremental is unbounded in time)
 *
 * Isolation: company_id ONLY from req.authz.company.id (with the
 * requireCompanyAccess-set req.companyFilter.company_id as the mirror the other
 * job routes read); scope from getProviderScope → crm_users.id via `@>`. No
 * resolved crm_users.id (deny-by-default) ⇒ 200 with empty arrays +
 * scope_empty:true, next_cursor echoing the input `since` (client does not move).
 *
 * `unassigned`/`tombstones` are returned ONLY on the LAST page (has_more:false)
 * so a paginated initial pull never deletes cached rows prematurely (spec §2.3).
 *
 * Errors: 400 (malformed since), 401 (upstream), 403 (upstream / no jobs.view).
 * Never 404 — an empty scope is not an error.
 */
router.get('/jobs', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.authz?.company?.id || req.companyFilter?.company_id || null;
        if (!companyId) {
            // requireCompanyAccess should have set this; belt-and-suspenders.
            return res.status(403).json({ ok: false, error: 'Tenant context required' });
        }

        const sinceRaw = req.query.since;

        // Parse limit / window_days with sane clamps.
        let limit = SYNC_JOBS_DEFAULT_LIMIT;
        if (req.query.limit !== undefined) {
            const parsed = parseInt(req.query.limit, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                limit = Math.min(parsed, SYNC_JOBS_MAX_LIMIT);
            }
        }
        let windowDays = SYNC_JOBS_DEFAULT_WINDOW_DAYS;
        if (req.query.window_days !== undefined) {
            const parsed = parseInt(req.query.window_days, 10);
            if (Number.isFinite(parsed) && parsed > 0) windowDays = parsed;
        }

        // Parse the cursor first — a malformed `since` is a 400 (never a silent
        // full re-sync).
        let cursor;
        try {
            cursor = syncQueries.parseCursor(sinceRaw);
        } catch (e) {
            return res.status(400).json({ ok: false, error: e.message });
        }

        const scope = getProviderScope(req);
        const serverTime = new Date().toISOString();

        // Deny-by-default: assigned_only without a resolved crm_users.id sees
        // NOTHING — but that is scope_empty, not an error, and the client must
        // NOT advance its cursor (echo the input since; null when full sync).
        if (scope.assignedOnly && !scope.userId) {
            return res.json({
                ok: true,
                data: {
                    changed: [],
                    unassigned: [],
                    tombstones: [],
                    next_cursor: sinceRaw || null,
                    has_more: false,
                    scope_empty: true,
                    server_time: serverTime,
                },
            });
        }

        // A tenant-wide viewer (job_visibility='all') has no single crm_user to
        // scope `@>` against; the mobile delta is inherently per-provider, so a
        // non-provider caller resolves to their own crm_users.id when present,
        // else scope_empty. (In practice the mobile app runs as a provider.)
        const crmUserId = scope.userId || (req.user?.crmUser?.id ? String(req.user.crmUser.id) : null);
        if (!crmUserId) {
            return res.json({
                ok: true,
                data: {
                    changed: [],
                    unassigned: [],
                    tombstones: [],
                    next_cursor: sinceRaw || null,
                    has_more: false,
                    scope_empty: true,
                    server_time: serverTime,
                },
            });
        }

        const { jobs, hasMore, nextCursor } = await syncQueries.getChangedJobs({
            companyId,
            crmUserId,
            cursor,
            limit,
            windowDays,
        });

        // Deletions (unassigned + tombstones) ONLY on the last page (spec §2.3),
        // keyed on the SAME since_ts as the cursor so nothing is missed once the
        // client advances. Empty page → echo the input since (don't move cursor).
        let unassigned = [];
        let tombstones = [];
        if (!hasMore) {
            [unassigned, tombstones] = await Promise.all([
                syncQueries.getUnassignedJobIds({ companyId, crmUserId, cursor }),
                syncQueries.getTombstoneJobIds({ companyId, cursor }),
            ]);
        }

        const outCursor = nextCursor || sinceRaw || null;

        res.json({
            ok: true,
            data: {
                changed: jobs,
                unassigned,
                tombstones,
                next_cursor: outCursor,
                has_more: hasMore,
                scope_empty: false,
                server_time: serverTime,
            },
        });
    } catch (err) {
        console.error('[Sync API] GET /jobs error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
