/**
 * Service Territories API routes
 * CRUD + bulk import/export for per-company zip code management.
 * Mounted at /api/settings/service-territories
 */
const express = require('express');
const router = express.Router();
const stQueries = require('../db/serviceTerritoryQueries');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

function getCompanyId(req) {
    return req.user?.company_id
        || req.companyFilter?.company_id
        || DEFAULT_COMPANY_ID;
}

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
