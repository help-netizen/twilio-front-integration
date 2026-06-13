/**
 * VAPI Tool Call Handler — public endpoint, secured by x-vapi-secret header
 *
 * POST /api/vapi-tools
 *
 * VAPI sends:
 *   { message: { type: "tool-calls", toolCallList: [{ id, function: { name, arguments } }], call: { ... } } }
 *
 * Tools handled:
 *   - checkServiceArea({ zip })              — check zip against service_territories DB
 *   - validateAddress({ street, apt, ... })  — Google Maps Geocoding (uses GOOGLE_GEOCODING_KEY)
 *   - checkAvailability({ zip, unitType })   — Blanc scheduleService.getAvailableSlots (dispatch_settings + booked items)
 *   - createLead({ ... })                    — create qualified lead in CRM
 *
 * Response format (VAPI expects):
 *   { results: [{ toolCallId, result }] }
 */
const express = require('express');
const router = express.Router();
const https = require('https');
const stQueries = require('../db/serviceTerritoryQueries');
const leadsService = require('../services/leadsService');
const scheduleService = require('../services/scheduleService');
const jobsService = require('../services/jobsService');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const AVAILABILITY_DAYS = 5;
const APPOINTMENT_DURATION_MIN = 120;
const MAX_SLOTS = 3;

// ─── Auth middleware ──────────────────────────────────────────────────────────

function vapiSecretAuth(req, res, next) {
    const secret = process.env.VAPI_TOOLS_SECRET;
    if (!secret) {
        console.warn('[vapi-tools] VAPI_TOOLS_SECRET not set — skipping auth (dev mode)');
        return next();
    }
    const header = req.headers['x-vapi-secret'];
    if (header !== secret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Tool: checkServiceArea ───────────────────────────────────────────────────

async function handleCheckServiceArea({ zip }) {
    if (!zip) return { inServiceArea: false, error: 'zip is required' };

    const row = await stQueries.search(DEFAULT_COMPANY_ID, String(zip).trim());
    if (!row) return { inServiceArea: false };

    return {
        inServiceArea: true,
        area: row.area || '',
        city: row.city || '',
        state: row.state || '',
        zip: row.zip || zip,
    };
}

// ─── Tool: validateAddress ────────────────────────────────────────────────────

async function handleValidateAddress({ street, apt, city, state, zip }) {
    // Dedicated server-side Geocoding key (IP-restricted). Falls back to the
    // frontend Maps key for back-compat if the dedicated one isn't set.
    const apiKey = process.env.GOOGLE_GEOCODING_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        console.warn('[vapi-tools] GOOGLE_GEOCODING_KEY not set — address validation skipped');
        return { valid: false, error: 'GOOGLE_GEOCODING_KEY not configured' };
    }

    try {
        const parts = [street, apt, city, state, zip].filter(Boolean);
        const addressQuery = parts.join(', ');
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressQuery)}&key=${apiKey}`;

        const data = await new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(new Error('Invalid JSON from Geocoding API')); }
                });
            }).on('error', reject);
        });

        if (!data.results || data.results.length === 0 || data.status === 'ZERO_RESULTS') {
            return { valid: false };
        }

        const result = data.results[0];
        const components = result.address_components || [];

        const postalComponent = components.find(c => c.types.includes('postal_code'));
        const correctedZip = postalComponent?.short_name || zip || '';

        // Strip ", USA" from formatted address for cleaner speech output
        const standardized = (result.formatted_address || '').replace(/, USA$/, '').trim();

        return {
            valid: true,
            standardized,
            correctedZip,
            lat: result.geometry?.location?.lat ?? null,
            lng: result.geometry?.location?.lng ?? null,
        };
    } catch (err) {
        console.error('[vapi-tools] validateAddress error:', err.message);
        return { valid: false };
    }
}

// ─── Tool: checkAvailability ──────────────────────────────────────────────────

async function handleCheckAvailability({ zip, unitType, days }) {
    try {
        return await scheduleService.getAvailableSlots(DEFAULT_COMPANY_ID, {
            days: days || AVAILABILITY_DAYS,
            slotDurationMin: APPOINTMENT_DURATION_MIN,
            maxSlots: MAX_SLOTS,
        });
    } catch (err) {
        console.error('[vapi-tools] checkAvailability error:', err.message);
        return { slots: [], error: err.message };
    }
}

// ─── Tool: createLead ─────────────────────────────────────────────────────────

function buildCallSummary({ unitType, brand, unitAge, problemDescription, preferredSlot, addressValidated, escalationRequested }) {
    const parts = [
        unitType          && `Unit: ${unitType}`,
        brand             && `Brand: ${brand}`,
        `Age: ${unitAge || 'unknown'}`,
        problemDescription && `Problem: ${problemDescription}`,
        'Fee agreed: Yes',
        `Slot: ${preferredSlot || 'pending callback'}`,
        `Address validated: ${addressValidated ? 'yes' : 'no'}`,
        escalationRequested && 'escalation_requested: true',
    ].filter(Boolean);
    return parts.join(' | ');
}

async function handleCreateLead(args) {
    const {
        firstName, lastName, phone, email,
        street, apt, zip, city, state,
        unitType, brand, unitAge, problemDescription,
        preferredSlot, addressValidated, escalationRequested,
        disqualified, disqualReason,
        callerName,
    } = args;

    // Disqualified leads (out-of-area / unsupported appliance) are logged for
    // lead-gen refund tracking even without full contact details — the call
    // transcript is the evidence. Valid leads still require a phone number.
    if (!disqualified && (!phone || phone.length < 5)) {
        return { success: false, error: 'Phone number is required to create lead' };
    }

    const summary = buildCallSummary({ unitType, brand, unitAge, problemDescription, preferredSlot, addressValidated, escalationRequested });
    const body = {
        FirstName: firstName || callerName?.split(' ')[0] || 'Unknown',
        LastName:  lastName  || callerName?.split(' ').slice(1).join(' ') || 'Caller',
        Phone:     phone || '',
        ...(email && { Email: email }),
        Status:    'Review',
        JobType:   unitType ? `${unitType} Repair` : 'Appliance Repair',
        JobSource: disqualified ? 'AI Phone (Invalid)' : 'AI Phone',
        Comments:  disqualified
            ? `INVALID LEAD — ${disqualReason || 'disqualified'}. ${summary}`.trim()
            : summary,
        ...(street && { Address: street }),
        ...(apt && { Unit: apt }),
        City:      city || '',
        State:     state || '',
        PostalCode: zip || '',
    };

    // Attempt with 1 retry on failure
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const lead = await leadsService.createLead(body, DEFAULT_COMPANY_ID);
            return { success: true, leadId: lead?.UUID || lead?.uuid || lead?.id || null };
        } catch (err) {
            console.error(`[vapi-tools] createLead attempt ${attempt} failed:`, err.message);
            if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
        }
    }
    return { success: false, error: 'Lead creation failed after retry' };
}

// ─── Tool: identifyCaller (v3 P1 — read-only) ─────────────────────────────────

// Internal blanc_status → caller-friendly phrase. The bot must never read raw codes.
const JOB_STATUS_PHRASE = {
    'Submitted': "we've got your request and are getting it scheduled",
    'Review': "our team is reviewing the details and will confirm shortly",
    'Scheduled': "you're scheduled — a technician is set for your window",
    'Enroute': "your technician is on the way",
    'In Progress': "the technician is working on it now",
    'Waiting for parts': "we're waiting on a part to finish the repair",
    'Job is Done': "the job is complete",
    'Canceled': "that appointment is canceled",
};
function jobStatusPhrase(s) { return JOB_STATUS_PHRASE[s] || 'in progress'; }

/**
 * Identify the caller as a NEW or EXISTING customer so the assistant can greet
 * them by name and route the conversation. Soft (phone-only) match — writes in
 * later phases require a second factor. Never throws; returns a safe summary.
 */
async function handleIdentifyCaller(args, call) {
    const phone = (args?.phone || call?.customer?.number || '').trim();

    let lead = null;
    if (phone) {
        try { lead = await leadsService.getLeadByPhone(phone, DEFAULT_COMPANY_ID); }
        catch (e) { console.error('[vapi-tools] identifyCaller lead lookup:', e.message); }
    }

    let jobs = [];
    if (phone) {
        try {
            const r = await jobsService.listJobs({ companyId: DEFAULT_COMPANY_ID, search: phone, onlyOpen: true, limit: 10 });
            jobs = r?.results || [];
        } catch (e) { console.error('[vapi-tools] identifyCaller jobs lookup:', e.message); }
    }

    if (!lead && jobs.length === 0) {
        return { matchType: 'new' };
    }

    const fullName = lead
        ? [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim()
        : (jobs[0]?.customer_name || '');
    const firstName = (fullName || '').split(' ')[0] || null;

    // nearest upcoming job by start_date
    const dated = jobs.filter(j => j.start_date).sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
    const nextJob = dated[0] || jobs[0] || null;

    return {
        matchType: 'existing',
        customerName: fullName || null,
        firstName,
        openJobsCount: jobs.length,
        nextAppointment: nextJob ? {
            service: nextJob.service_name || null,
            statusLabel: jobStatusPhrase(nextJob.blanc_status),
            date: nextJob.start_date || null,
        } : null,
        verified: false, // phone-only soft match; verify name/ZIP before any writes (P2)
    };
}

// ─── Router ───────────────────────────────────────────────────────────────────

router.post('/', vapiSecretAuth, async (req, res) => {
    try {
        const message = req.body?.message;
        if (!message || message.type !== 'tool-calls') {
            return res.json({});
        }

        const toolCallList = message.toolCallList || [];
        const results = [];

        for (const toolCall of toolCallList) {
            const name = toolCall.function?.name;
            const args = (() => {
                try {
                    return typeof toolCall.function?.arguments === 'string'
                        ? JSON.parse(toolCall.function.arguments)
                        : (toolCall.function?.arguments || {});
                } catch {
                    return {};
                }
            })();

            let result;
            try {
                if (name === 'identifyCaller') {
                    result = await handleIdentifyCaller(args, message.call);
                } else if (name === 'checkServiceArea') {
                    result = await handleCheckServiceArea(args);
                } else if (name === 'validateAddress') {
                    result = await handleValidateAddress(args);
                } else if (name === 'checkAvailability') {
                    result = await handleCheckAvailability(args);
                } else if (name === 'createLead') {
                    result = await handleCreateLead(args);
                } else {
                    result = { error: `Unknown tool: ${name}` };
                }
            } catch (err) {
                console.error(`[vapi-tools] Tool "${name}" unhandled error:`, err.message);
                result = { error: err.message };
            }

            results.push({
                toolCallId: toolCall.id,
                result: JSON.stringify(result),
            });
        }

        res.json({ results });
    } catch (err) {
        console.error('[vapi-tools] Handler error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
