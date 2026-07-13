/**
 * Tenant Twilio Port-In API — TELEPHONY-WIZARD-UX-001 (T2).
 * Mounted at /api/telephony/port-in with tenant.telephony.manage.
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const portInService = require('../services/portInService');
const telephonyTenantService = require('../services/telephonyTenantService');

const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(null, true);
        const err = new Error('Utility bill must be a PDF, JPEG, or PNG');
        err.httpStatus = 422;
        err.code = 'VALIDATION';
        cb(err);
    },
});

function companyId(req) {
    return req.companyFilter?.company_id;
}

function fail(res, err, fallback) {
    if (err.httpStatus) {
        return res.status(err.httpStatus).json({
            ok: false,
            code: err.code || 'ERROR',
            error: err.message,
        });
    }
    console.error(`[TelephonyPortIn] ${fallback}:`, err.message);
    return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: fallback });
}

function validationError(message, code = 'VALIDATION') {
    const err = new Error(message);
    err.httpStatus = 422;
    err.code = code;
    return err;
}

function handleUtilityBill(req, res, next) {
    upload.single('utility_bill')(req, res, err => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
            return fail(res, validationError('Utility bill must be 10 MB or smaller'), 'Invalid utility bill');
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return fail(res, validationError('Upload the utility bill in the utility_bill field'), 'Invalid utility bill');
        }
        return fail(res, err.httpStatus ? err : validationError('Invalid utility bill upload'), 'Invalid utility bill');
    });
}

function requiredString(body, key) {
    const value = body?.[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw validationError(`${key} is required`);
    }
    return value.trim();
}

function optionalString(body, key) {
    const value = body?.[key];
    if (value == null || value === '') return undefined;
    if (typeof value !== 'string') {
        throw validationError(`${key} must be a string`);
    }
    return value.trim() || undefined;
}

function localDateString(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateString, days) {
    const date = new Date(`${dateString}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function validateTargetDate(value, timeZone) {
    if (!value) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw validationError('target_port_in_date must be an ISO date (YYYY-MM-DD)');
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw validationError('target_port_in_date must be a valid date');
    }
    const today = localDateString(new Date(), timeZone || 'America/New_York');
    if (value < addDays(today, 7)) {
        throw validationError(
            'target_port_in_date must be at least 7 days in the future',
            'TARGET_DATE_TOO_SOON'
        );
    }
    return value;
}

function validatePhoneNumber(value) {
    if (!/^\+1\d{10}$/.test(String(value || ''))) {
        throw validationError('phone_number must be E.164 (+1XXXXXXXXXX)');
    }
    return value;
}

function validateCreateInput(req) {
    if (!req.file) throw validationError('utility_bill is required');
    const body = req.body || {};
    const customerType = requiredString(body, 'customer_type');
    if (!['Individual', 'Business'].includes(customerType)) {
        throw validationError("customer_type must be 'Individual' or 'Business'");
    }
    const email = requiredString(body, 'authorized_representative_email');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw validationError('authorized_representative_email must be a valid email');
    }

    return {
        phone_number: validatePhoneNumber(requiredString(body, 'phone_number')),
        customer_name: requiredString(body, 'customer_name'),
        customer_type: customerType,
        account_number: optionalString(body, 'account_number'),
        pin: optionalString(body, 'pin'),
        account_telephone_number: optionalString(body, 'account_telephone_number'),
        authorized_representative: requiredString(body, 'authorized_representative'),
        authorized_representative_email: email,
        address_street: requiredString(body, 'address_street'),
        address_street2: optionalString(body, 'address_street2'),
        address_city: requiredString(body, 'address_city'),
        address_state: requiredString(body, 'address_state'),
        address_zip: requiredString(body, 'address_zip'),
        address_country: optionalString(body, 'address_country') || 'USA',
        target_port_in_date: validateTargetDate(
            optionalString(body, 'target_port_in_date'),
            req.authz?.company?.timezone || 'America/New_York'
        ),
    };
}

function ensureRequestId(req) {
    if (!UUID_RE.test(req.params.id || '')) {
        const err = new Error('Transfer request not found');
        err.httpStatus = 404;
        err.code = 'NOT_FOUND';
        throw err;
    }
}

// POST /api/telephony/port-in/check — portability preflight
router.post('/check', async (req, res) => {
    try {
        const phoneNumber = validatePhoneNumber(req.body?.phone_number);
        const id = companyId(req);
        await telephonyTenantService.connectTelephony(id, {
            actorId: req.user?.crmUser?.id,
            companyName: req.authz?.company?.name,
        });
        const result = await portInService.checkPortability(id, phoneNumber);
        res.json({
            ok: true,
            portable: result.portable,
            number_type: result.number_type,
            reason: result.reason,
        });
    } catch (err) {
        fail(res, err, 'Portability check failed');
    }
});

// POST /api/telephony/port-in — create a transfer request
router.post('/', handleUtilityBill, async (req, res) => {
    try {
        const input = validateCreateInput(req);
        const id = companyId(req);
        await telephonyTenantService.connectTelephony(id, {
            actorId: req.user?.crmUser?.id,
            companyName: req.authz?.company?.name,
        });
        const request = await portInService.createPortIn(id, input, req.file, {
            actorId: req.user?.crmUser?.id,
        });
        res.status(201).json({ ok: true, request });
    } catch (err) {
        fail(res, err, 'Failed to start number transfer');
    }
});

// GET /api/telephony/port-in — tenant requests, live-refreshing active rows
router.get('/', async (req, res) => {
    try {
        const requests = await portInService.listPortIns(companyId(req));
        res.json({ ok: true, requests });
    } catch (err) {
        fail(res, err, 'Failed to load number transfers');
    }
});

// GET /api/telephony/port-in/:id — one tenant-owned request
router.get('/:id', async (req, res) => {
    try {
        ensureRequestId(req);
        const request = await portInService.getPortIn(companyId(req), req.params.id);
        res.json({ ok: true, request });
    } catch (err) {
        fail(res, err, 'Failed to load number transfer');
    }
});

// DELETE /api/telephony/port-in/:id — remote cancel, or local-only without SID
router.delete('/:id', async (req, res) => {
    try {
        ensureRequestId(req);
        const request = await portInService.cancelPortIn(companyId(req), req.params.id);
        res.json({ ok: true, request });
    } catch (err) {
        fail(res, err, 'Failed to cancel number transfer');
    }
});

module.exports = router;
