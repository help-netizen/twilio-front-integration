/**
 * technicians.js — settings API for technician display profiles (photo + name)
 * used on the public payment page.
 *
 * Mounted: app.use('/api/settings/technicians', authenticate,
 *   requirePermission('tenant.company.manage'), requireCompanyAccess, router)
 */
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const profileService = require('../services/technicianProfilesService');
const rosterService = require('../services/technicianRosterService');
const workScheduleService = require('../services/technicianWorkScheduleService');
const serviceAreaService = require('../services/technicianServiceAreaService');
const baseLocationQueries = require('../db/technicianBaseLocationQueries');

const directoryService = require('../services/technicianDirectoryService');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

function companyId(req) { return req.companyFilter?.company_id; }

// ── ZB-DECOUPLE Phase C3 — native-directory maintenance (spec deferred #4) ────
// The native plane stops being import-only: admins can list (incl. inactive),
// create, rename, and (de)activate native technicians. Mounted under the same
// tenant.company.manage gate as the rest of this router.

// GET /api/settings/technicians/native — full native directory
router.get('/native', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const technicians = await directoryService.listDirectory(companyId(req));
        res.json({ ok: true, data: technicians });
    } catch (err) {
        sendError(res, err, 'GET /native');
    }
});

// POST /api/settings/technicians/native — create {display_name, crm_user_id?, zenbooker_external_id?}
router.post('/native', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const technician = await directoryService.createNativeTechnician(companyId(req), req.body || {});
        res.status(201).json({ ok: true, data: technician });
    } catch (err) {
        sendError(res, err, 'POST /native');
    }
});

// PATCH /api/settings/technicians/native/:technicianUuid — {display_name?, active?}
router.patch('/native/:technicianUuid', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const technician = await directoryService.updateNativeTechnician(
            companyId(req),
            req.params.technicianUuid,
            req.body || {}
        );
        res.json({ ok: true, data: technician });
    } catch (err) {
        sendError(res, err, 'PATCH /native');
    }
});

function sendError(res, err, context) {
    console.error(`[Technicians] ${context} error:`, err.message);
    res.status(err.httpStatus || 500).json({
        ok: false,
        error: { code: err.code || 'INTERNAL', message: err.message },
    });
}

// GET /api/settings/technicians — active native roster + effective schedule.
router.get('/', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const tenantId = companyId(req);
        const roster = await rosterService.listActive(tenantId);
        const ids = roster.map(technician => technician.id);
        const [profiles, bases, schedules, serviceAreas] = await Promise.all([
            profileService.listProfiles(tenantId, ids),
            baseLocationQueries.listByCompany(tenantId),
            workScheduleService.listEffective(tenantId, roster),
            serviceAreaService.getAssignmentState(tenantId, roster),
        ]);
        const profileById = new Map(profiles.map(profile => [String(profile.tech_id), profile]));
        const baseById = new Map(bases.map(base => [String(base.tech_id), base]));
        const scheduleById = new Map(schedules.technicians.map(schedule => [String(schedule.technician_id), schedule]));
        const data = roster.map(technician => {
            const profile = profileById.get(technician.id);
            const schedule = scheduleById.get(technician.id);
            const base = baseById.get(technician.id);
            return {
                tech_id: technician.id,
                name: profile?.name || technician.name,
                zenbooker: technician.zenbooker || null,
                has_photo: Boolean(profile?.has_photo),
                base: base || null,
                inherits_company_schedule: schedule?.inherits_company_schedule ?? true,
                effective_schedule: schedule?.effective_week || [],
                schedule_summary: schedule?.schedule_summary || '',
                exceeds_company_hours: Boolean(schedule?.exceeds_company_hours),
                degraded_to_company_schedule: Boolean(schedule?.degraded_to_company_schedule),
                service_area_mode: serviceAreas.active_mode,
                service_area_summary: serviceAreaService.activeSummary(serviceAreas, technician.id),
                service_area_wildcard: Boolean(
                    serviceAreas._assignment_by_tech.get(technician.id)?.wildcard_in_active_mode
                ),
            };
        });
        res.json({ ok: true, data });
    } catch (err) {
        sendError(res, err, 'list');
    }
});

// GET /api/settings/technicians/:techId/settings — panel schedule state.
router.get('/:techId/settings', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const tenantId = companyId(req);
        const technician = await rosterService.requireActive(tenantId, req.params.techId);
        const [schedule, serviceAreas] = await Promise.all([
            workScheduleService.getSettings(tenantId, technician),
            serviceAreaService.getTechnicianSettings(tenantId, technician),
        ]);
        const data = { ...schedule, service_areas: serviceAreas };
        res.json({ ok: true, data });
    } catch (err) {
        sendError(res, err, 'settings read');
    }
});

// PUT /api/settings/technicians/:techId/serves-all-territory — the explicit
// company-wide mark (ZONE-STRICT-001). Empty assignments no longer imply it, so
// working everywhere has to be stated here.
router.put('/:techId/serves-all-territory', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const tenantId = companyId(req);
        const updatedBy = req.user?.crmUser?.id || null;
        const data = await serviceAreaService.setTechnicianServesAllTerritory(
            tenantId,
            req.params.techId,
            req.body?.serves_all_territory,
            updatedBy
        );
        res.json({ ok: true, data });
    } catch (err) {
        sendError(res, err, 'serves-all-territory update');
    }
});

// PUT /api/settings/technicians/:techId/service-areas/:mode — replace only
// this technician's selected district or radius map. Empty means NOT offered
// (ZONE-STRICT-001) unless the technician is marked company-wide above.
router.put('/:techId/service-areas/:mode', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const tenantId = companyId(req);
        const updatedBy = req.user?.crmUser?.id || null;
        const data = await serviceAreaService.replaceTechnicianAssignments(
            tenantId,
            req.params.techId,
            req.params.mode,
            req.body?.assignments,
            updatedBy
        );
        res.json({ ok: true, data });
    } catch (err) {
        sendError(res, err, 'service-area update');
    }
});

// PUT /api/settings/technicians/:techId/work-schedule — replace/retain schedule.
router.put('/:techId/work-schedule', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const tenantId = companyId(req);
        const technician = await rosterService.requireActive(tenantId, req.params.techId);
        const updatedBy = req.user?.crmUser?.id || null;
        const data = await workScheduleService.save(tenantId, technician, req.body || {}, updatedBy);
        res.json({ ok: true, data });
    } catch (err) {
        sendError(res, err, 'schedule update');
    }
});

// POST /api/settings/technicians/:techId/photo — upload/replace a photo (multipart).
router.post('/:techId/photo', requirePermission('tenant.company.manage'), upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, error: { code: 'NO_FILE', message: 'Image file required' } });
        const data = await profileService.uploadPhoto(companyId(req), req.params.techId, { name: req.body?.name, file: req.file });
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[Technicians] upload error:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
