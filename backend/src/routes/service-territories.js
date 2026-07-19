/**
 * Service Territories API routes
 * CRUD + bulk import/export for per-company zip code management.
 * Mounted at /api/settings/service-territories
 */
const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const stQueries = require('../db/serviceTerritoryQueries');
const radiusQueries = require('../db/territoryRadiusQueries');
const territoryGeoService = require('../services/territoryGeoService');
const technicianServiceAreaService = require('../services/technicianServiceAreaService');
const { normalizeZip } = require('../utils/zip');

const LAZY_GEOGRAPHY_RESOLUTION_LIMIT = 10;

function getCompanyId(req) {
    return req.companyFilter?.company_id;
}

function sendServiceAreaError(res, error, context) {
    console.error(`[ServiceTerritories] ${context} error:`, error.message);
    res.status(error.httpStatus || 500).json({
        ok: false,
        error: { code: error.code || 'INTERNAL', message: error.message },
    });
}

async function getCompanyZip(companyId) {
    const { rows } = await db.query(
        `SELECT zip
         FROM companies
         WHERE id = $1`,
        [companyId]
    );
    return rows[0]?.zip || null;
}

async function getListZipGeographies(companyId) {
    const { rows } = await db.query(
        `SELECT st.zip, st.area, z.lat, z.lon, z.google_place_id, z.place_id_resolved_at
         FROM service_territories st
         LEFT JOIN zip_geocache z ON z.zip = st.zip
         WHERE st.company_id = $1
         ORDER BY st.zip ASC`,
        [companyId]
    );
    return rows;
}

function splitListZipGeographies(rows) {
    const areaNames = Array.from(new Set(
        rows.map(row => (typeof row.area === 'string' ? row.area : ''))
    )).sort();
    const unique = new Map();
    for (const row of rows) {
        const current = unique.get(row.zip);
        if (!current || (current.lat == null && row.lat != null && row.lon != null)) {
            unique.set(row.zip, row);
        }
    }

    const listCentroids = [];
    const missingCentroidCandidates = [];
    const placeIdResolutionCandidates = [];
    for (const row of unique.values()) {
        if (row.lat != null && row.lon != null) {
            const centroid = {
                zip: row.zip,
                area: typeof row.area === 'string' ? row.area : '',
                lat: row.lat,
                lon: row.lon,
            };
            const placeId = typeof row.google_place_id === 'string'
                ? row.google_place_id.trim()
                : '';
            if (placeId) centroid.place_id = placeId;
            listCentroids.push(centroid);

            if (!placeId || !territoryGeoService.isPlaceIdFresh(row.place_id_resolved_at)) {
                placeIdResolutionCandidates.push(row.zip);
            }
        } else {
            missingCentroidCandidates.push(row.zip);
        }
    }

    // Preserve SERVICE-TERR-002's original centroid priority and cap. Place-ID
    // resolution gets only the remaining budget, so a config view can never fan
    // out into one Google request per ZIP.
    const missingZips = missingCentroidCandidates.slice(
        0,
        LAZY_GEOGRAPHY_RESOLUTION_LIMIT
    );
    const missingPlaceIdZips = placeIdResolutionCandidates.slice(
        0,
        LAZY_GEOGRAPHY_RESOLUTION_LIMIT - missingZips.length
    );
    return { areaNames, listCentroids, missingZips, missingPlaceIdZips };
}

function seedListCentroids(zips) {
    if (zips.length === 0) return;
    setImmediate(async () => {
        const results = await Promise.allSettled(
            zips.map(zip => territoryGeoService.geocodeZip(zip))
        );
        for (const result of results) {
            if (result.status === 'rejected') {
                console.warn(
                    '[ServiceTerritories] lazy centroid seed failed (non-fatal):',
                    result.reason?.message || String(result.reason)
                );
            }
        }
    });
}

function seedListPlaceIds(zips) {
    if (zips.length === 0) return;
    setImmediate(async () => {
        const results = await Promise.allSettled(
            zips.map(zip => territoryGeoService.resolveZipPlaceId(zip))
        );
        for (const result of results) {
            if (result.status === 'rejected') {
                console.warn(
                    '[ServiceTerritories] lazy ZIP place ID seed failed (non-fatal):',
                    result.reason?.message || String(result.reason)
                );
            }
        }
    });
}

// GET /config — radius/list configuration and map data
router.get('/config', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const [settings, radii, listZipCount, companyZip, listZipGeographies] = await Promise.all([
            radiusQueries.getSettings(companyId),
            radiusQueries.listRadii(companyId),
            radiusQueries.countListZips(companyId),
            getCompanyZip(companyId),
            getListZipGeographies(companyId),
        ]);
        const {
            areaNames,
            listCentroids,
            missingZips,
            missingPlaceIdZips,
        } = splitListZipGeographies(listZipGeographies);
        seedListCentroids(missingZips);
        seedListPlaceIds(missingPlaceIdZips);

        res.json({
            config: {
                active_mode: settings.active_mode,
                radii,
                counts: { list_zips: listZipCount, radii: radii.length },
                company_zip: companyZip,
                area_names: areaNames,
                list_centroids: listCentroids,
            },
        });
    } catch (err) {
        console.error('[ServiceTerritories] GET /config error:', err);
        res.status(500).json({ error: 'Failed to load service territory config' });
    }
});

// PUT /mode — switch the active territory mode without deleting either dataset
router.put('/mode', async (req, res) => {
    try {
        const { active_mode: activeMode } = req.body || {};
        if (activeMode !== 'list' && activeMode !== 'radius') {
            return res.status(400).json({ error: 'active_mode must be list or radius' });
        }
        const config = await radiusQueries.setMode(getCompanyId(req), activeMode);
        res.json({ config: { active_mode: config.active_mode } });
    } catch (err) {
        console.error('[ServiceTerritories] PUT /mode error:', err);
        res.status(500).json({ error: 'Failed to update service territory mode' });
    }
});

// GET /assignments — active roster plus both independent assignment maps.
router.get('/assignments', async (req, res) => {
    try {
        const state = await technicianServiceAreaService.getAssignmentState(getCompanyId(req));
        res.json({ ok: true, data: technicianServiceAreaService.publicState(state) });
    } catch (error) {
        sendServiceAreaError(res, error, 'GET /assignments');
    }
});

// PUT /district-assignments — reverse edit for one Albusto district.
router.put('/district-assignments', async (req, res) => {
    try {
        const data = await technicianServiceAreaService.replaceDistrictTechnicians(
            getCompanyId(req),
            req.body?.district_name,
            req.body?.technician_ids,
            req.user?.crmUser?.id || null
        );
        res.json({ ok: true, data });
    } catch (error) {
        sendServiceAreaError(res, error, 'PUT /district-assignments');
    }
});

// PUT /radii/:radiusId/technicians — reverse edit for one Albusto radius.
router.put('/radii/:radiusId/technicians', async (req, res) => {
    try {
        const data = await technicianServiceAreaService.replaceRadiusTechnicians(
            getCompanyId(req),
            req.params.radiusId,
            req.body?.technician_ids,
            req.user?.crmUser?.id || null
        );
        res.json({ ok: true, data });
    } catch (error) {
        sendServiceAreaError(res, error, 'PUT /radii/:radiusId/technicians');
    }
});

// POST /radii — add one ZIP center + radius pair
router.post('/radii', async (req, res) => {
    try {
        const { zip, radius_miles: radiusMiles } = req.body || {};
        const inputDigits = zip == null ? '' : String(zip).replace(/\D/g, '');
        const normalizedZip = normalizeZip(zip);
        if (inputDigits.length < 4 || !/^\d{5}$/.test(normalizedZip)) {
            return res.status(400).json({ error: 'zip must be 5 digits' });
        }
        if (typeof radiusMiles !== 'number' || !Number.isFinite(radiusMiles)
            || radiusMiles <= 0 || radiusMiles > 200) {
            return res.status(400).json({ error: 'radius_miles must be between 0 and 200' });
        }

        const geo = await territoryGeoService.geocodeZip(normalizedZip);
        if (!geo) return res.status(422).json({ error: 'ZIP_NOT_FOUND' });

        const companyId = getCompanyId(req);
        const existingRadii = await radiusQueries.listRadii(companyId);
        const maxPosition = existingRadii.reduce((max, radius) => {
            const position = Number(radius.position);
            return Number.isFinite(position) ? Math.max(max, position) : max;
        }, -1);
        const radius = await radiusQueries.createRadius(companyId, {
            zip: normalizedZip,
            lat: geo.lat,
            lon: geo.lon,
            radius_miles: radiusMiles,
            position: maxPosition + 1,
        });

        res.status(201).json({
            radius: {
                ...radius,
                city: geo.city ?? null,
                state: geo.state ?? null,
            },
        });
    } catch (err) {
        console.error('[ServiceTerritories] POST /radii error:', err);
        res.status(500).json({ error: 'Failed to add territory radius' });
    }
});

// DELETE /radii/:id — foreign and unknown ids share the same 404
router.delete('/radii/:id', async (req, res) => {
    try {
        const deleted = await radiusQueries.deleteRadius(getCompanyId(req), req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Radius not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[ServiceTerritories] DELETE /radii/:id error:', err);
        res.status(500).json({ error: 'Failed to remove territory radius' });
    }
});

// GET / — list all zip codes for company
router.get('/', async (req, res) => {
    try {
        const rows = await stQueries.getAll(getCompanyId(req));
        res.json({ territories: rows });
    } catch (err) {
        console.error('[ServiceTerritories] GET / error:', err);
        res.status(500).json({ error: 'Failed to load service territories' });
    }
});

// GET /areas — list distinct area names
router.get('/areas', async (req, res) => {
    try {
        const areas = await stQueries.getAreas(getCompanyId(req));
        res.json({ areas });
    } catch (err) {
        console.error('[ServiceTerritories] GET /areas error:', err);
        res.status(500).json({ error: 'Failed to load areas' });
    }
});

// GET /export — CSV download
router.get('/export', async (req, res) => {
    try {
        const rows = await stQueries.getAll(getCompanyId(req));
        const header = 'ZIP,Area,City,State,County';
        const csvRows = rows.map(r =>
            [r.zip, r.area, r.city || '', r.state || '', r.county || '']
                .map(v => `"${String(v).replace(/"/g, '""')}"`)
                .join(',')
        );
        const csv = [header, ...csvRows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="service-territories.csv"');
        res.send(csv);
    } catch (err) {
        console.error('[ServiceTerritories] GET /export error:', err);
        res.status(500).json({ error: 'Failed to export' });
    }
});

// POST / — add one zip code
router.post('/', async (req, res) => {
    try {
        const { zip, area, city, state, county } = req.body;
        if (!zip) {
            return res.status(400).json({ error: 'zip is required' });
        }
        const normalized = zip.replace(/\D/g, '').slice(0, 5).padStart(5, '0');
        if (normalized.length !== 5) {
            return res.status(400).json({ error: 'zip must be 5 digits' });
        }
        const row = await stQueries.create(getCompanyId(req), {
            zip: normalized, area, city, state, county,
        });
        if (!row) {
            return res.status(409).json({ error: 'Zip code already exists' });
        }
        res.status(201).json({ territory: row });
    } catch (err) {
        console.error('[ServiceTerritories] POST / error:', err);
        res.status(500).json({ error: 'Failed to add zip code' });
    }
});

// POST /bulk-import — replace all zip codes
router.post('/bulk-import', async (req, res) => {
    try {
        const { rows } = req.body;
        if (!Array.isArray(rows)) {
            return res.status(400).json({ error: 'rows array is required' });
        }
        const normalized = rows
            .filter(r => r.zip)
            .map(r => ({
                zip: String(r.zip).replace(/\D/g, '').slice(0, 5).padStart(5, '0'),
                area: r.area || '',
                city: r.city || null,
                state: r.state || null,
                county: r.county || null,
            }));
        await stQueries.bulkReplace(getCompanyId(req), normalized);
        const territories = await stQueries.getAll(getCompanyId(req));
        res.json({ territories, imported: normalized.length });
    } catch (err) {
        console.error('[ServiceTerritories] POST /bulk-import error:', err);
        res.status(500).json({ error: 'Failed to import' });
    }
});

// DELETE /:zip — remove one zip code
router.delete('/:zip', async (req, res) => {
    try {
        const deleted = await stQueries.remove(getCompanyId(req), req.params.zip);
        if (!deleted) return res.status(404).json({ error: 'Zip code not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[ServiceTerritories] DELETE /:zip error:', err);
        res.status(500).json({ error: 'Failed to remove zip code' });
    }
});

module.exports = router;
