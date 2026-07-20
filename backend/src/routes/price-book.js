/**
 * /api/price-book — PRICEBOOK-001 management API (Categories / Groups / Items).
 * Reads gated by `price_book.view`, writes by `price_book.manage`. Company-scoped.
 * Items delegate to estimateItemPresetsService (the inline picker keeps its own
 * /api/estimate-item-presets route). Mount in src/server.js:
 *   app.use('/api/price-book', authenticate, requireCompanyAccess, priceBookRouter);
 */

'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const priceBook = require('../services/priceBookService');
const presets = require('../services/estimateItemPresetsService');

const router = express.Router();

const companyId = (req) => req.companyFilter?.company_id || null;
const actorId = (req) => req.user?.crmUser?.id || null;
const bool = (v) => v === 'true' || v === '1' || v === true;

function sendErr(res, err) {
    if (err instanceof priceBook.PriceBookError || err instanceof presets.EstimateItemPresetError) {
        const body = { error: err.code, message: err.message };
        if (err.details) body.details = err.details;
        return res.status(err.httpStatus).json(body);
    }
    // eslint-disable-next-line no-console
    console.error('[price-book] unexpected error', err);
    return res.status(500).json({ error: 'internal_error', message: 'Unexpected error' });
}

const VIEW = requirePermission('price_book.view');
const MANAGE = requirePermission('price_book.manage');

// ── Categories ───────────────────────────────────────────────────────────────
router.get('/categories', VIEW, async (req, res) => {
    try { res.json({ categories: await priceBook.listCategories(companyId(req), { includeArchived: bool(req.query.includeArchived) }) }); }
    catch (e) { sendErr(res, e); }
});
router.get('/categories/tree', VIEW, async (req, res) => {
    try { res.json({ categories: await priceBook.listCategoryTree(companyId(req)) }); }
    catch (e) { sendErr(res, e); }
});
router.post('/categories', MANAGE, async (req, res) => {
    try { res.status(201).json(await priceBook.createCategory(companyId(req), req.body || {}, { createdBy: actorId(req) })); }
    catch (e) { sendErr(res, e); }
});
router.patch('/categories/:id', MANAGE, async (req, res) => {
    try { res.json(await priceBook.updateCategory(companyId(req), Number(req.params.id), req.body || {})); }
    catch (e) { sendErr(res, e); }
});
router.delete('/categories/:id', MANAGE, async (req, res) => {
    try { res.json(await priceBook.archiveCategory(companyId(req), Number(req.params.id))); }
    catch (e) { sendErr(res, e); }
});

// ── Groups ───────────────────────────────────────────────────────────────────
router.get('/groups', VIEW, async (req, res) => {
    try {
        const search = typeof req.query.search === 'string' ? req.query.search : '';
        res.json({ groups: await priceBook.listGroups(companyId(req), {
            includeArchived: bool(req.query.includeArchived),
            search,
            category_id: req.query.category_id != null && req.query.category_id !== '' ? Number(req.query.category_id) : null,
            uncategorized: bool(req.query.uncategorized),
        }) });
    } catch (e) { sendErr(res, e); }
});
router.get('/groups/:id', VIEW, async (req, res) => {
    try { res.json(await priceBook.getGroup(companyId(req), Number(req.params.id))); }
    catch (e) { sendErr(res, e); }
});
// Expansion for adding a group to an estimate/invoice (line-item shaped).
router.get('/groups/:id/expand', VIEW, async (req, res) => {
    try { res.json({ items: await priceBook.getGroupExpansion(companyId(req), Number(req.params.id)) }); }
    catch (e) { sendErr(res, e); }
});
router.post('/groups', MANAGE, async (req, res) => {
    try { res.status(201).json(await priceBook.createGroup(companyId(req), req.body || {}, { createdBy: actorId(req) })); }
    catch (e) { sendErr(res, e); }
});
router.patch('/groups/:id', MANAGE, async (req, res) => {
    try { res.json(await priceBook.updateGroup(companyId(req), Number(req.params.id), req.body || {})); }
    catch (e) { sendErr(res, e); }
});
router.delete('/groups/:id', MANAGE, async (req, res) => {
    try { res.json(await priceBook.archiveGroup(companyId(req), Number(req.params.id))); }
    catch (e) { sendErr(res, e); }
});

// ── Items (delegate to the presets catalog) ──────────────────────────────────
router.get('/items', VIEW, async (req, res) => {
    try {
        const items = await presets.listForManage(companyId(req), {
            search: typeof req.query.search === 'string' ? req.query.search : '',
            category_id: req.query.category_id != null && req.query.category_id !== '' ? Number(req.query.category_id) : null,
            uncategorized: bool(req.query.uncategorized),
            includeArchived: bool(req.query.includeArchived),
            limit: req.query.limit ? Number(req.query.limit) : 50,
            offset: req.query.offset ? Number(req.query.offset) : 0,
        });
        res.json({ items });
    } catch (e) { sendErr(res, e); }
});
router.post('/items', MANAGE, async (req, res) => {
    try { res.status(201).json(await presets.create(companyId(req), req.body || {}, { createdBy: actorId(req) })); }
    catch (e) { sendErr(res, e); }
});
// PRICEBOOK-002: atomic bulk save (creates/updates/deletes) for the Items grid.
router.put('/items/bulk', MANAGE, async (req, res) => {
    try { res.json(await presets.bulkSaveItems(companyId(req), req.body || {}, { actorId: actorId(req) })); }
    catch (e) { sendErr(res, e); }
});
router.patch('/items/:id', MANAGE, async (req, res) => {
    try { res.json(await presets.update(companyId(req), Number(req.params.id), req.body || {})); }
    catch (e) { sendErr(res, e); }
});
router.delete('/items/:id', MANAGE, async (req, res) => {
    try { res.json(await presets.archive(companyId(req), Number(req.params.id))); }
    catch (e) { sendErr(res, e); }
});

// ── Import / Export (CSV) ────────────────────────────────────────────────────
router.get('/template', VIEW, (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="price-book-template.csv"');
    res.send(priceBook.templateCsv());
});
router.get('/export', VIEW, async (req, res) => {
    try {
        const csv = await priceBook.exportCsv(companyId(req));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="price-book.csv"');
        res.send(csv);
    } catch (e) { sendErr(res, e); }
});
router.post('/import', MANAGE, async (req, res) => {
    try {
        const csv = typeof req.body === 'string' ? req.body : (req.body?.csv || '');
        const summary = await priceBook.importCsv(companyId(req), csv, { createdBy: actorId(req) });
        res.json(summary);
    } catch (e) { sendErr(res, e); }
});

module.exports = router;
