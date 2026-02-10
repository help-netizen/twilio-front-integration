const axios = require('axios');

// =============================================================================
// Zenbooker API Client — creates jobs via POST /v1/jobs
// =============================================================================

const ZENBOOKER_API_KEY = process.env.ZENBOOKER_API_KEY;
const ZENBOOKER_API_BASE_URL = process.env.ZENBOOKER_API_BASE_URL || 'https://api.zenbooker.com/v1';

let client = null;

function getClient() {
    if (client) return client;
    if (!ZENBOOKER_API_KEY) {
        throw new Error('ZENBOOKER_API_KEY is not configured');
    }
    client = axios.create({
        baseURL: ZENBOOKER_API_BASE_URL,
        timeout: 15000,
        headers: {
            'Authorization': `Bearer ${ZENBOOKER_API_KEY}`,
            'Content-Type': 'application/json',
        },
    });
    return client;
}

// ─── Territories cache ────────────────────────────────────────────────────────
let territoriesCache = null;
let territoriesCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

/**
 * Fetch territories from Zenbooker and cache them.
 * Returns array of { id, name, postal_codes[] }
 */
async function getTerritories() {
    if (territoriesCache && Date.now() - territoriesCacheTime < CACHE_TTL) {
        return territoriesCache;
    }
    const res = await retryRequest(() => getClient().get('/territories'));
    const territories = (res.data.results || res.data.territories || [])
        .filter(t => t.enabled)
        .map(t => ({
            id: t.id,
            name: t.name,
            postal_codes: t.service_area?.postal_codes || [],
        }));
    territoriesCache = territories;
    territoriesCacheTime = Date.now();
    return territories;
}

/**
 * Find a territory that covers the given postal code.
 * Falls back to first available territory if no match.
 */
async function findTerritoryByPostalCode(postalCode) {
    const territories = await getTerritories();
    if (postalCode) {
        const zip = postalCode.trim();
        const match = territories.find(t => t.postal_codes.includes(zip));
        if (match) return match.id;
    }
    // Fallback — first territory
    if (territories.length > 0) return territories[0].id;
    throw new Error('No Zenbooker territories found');
}

// ─── Create Job ───────────────────────────────────────────────────────────────

/**
 * Create a job in Zenbooker from lead data.
 *
 * @param {Object} lead - Lead object from DB (camelCase)
 * @returns {Object} - Zenbooker job response { job_id, status, ... }
 */
async function createJobFromLead(lead) {
    const territoryId = await findTerritoryByPostalCode(lead.PostalCode);

    // Build timeslot — use lead's scheduled time if set, otherwise next day 8am–12pm
    let timeslot;
    if (lead.LeadDateTime) {
        const start = new Date(lead.LeadDateTime);
        const end = lead.LeadEndDateTime
            ? new Date(lead.LeadEndDateTime)
            : new Date(start.getTime() + 4 * 60 * 60 * 1000); // +4h default window
        timeslot = {
            type: 'arrival_window',
            start: start.toISOString(),
            end: end.toISOString(),
        };
    } else {
        // Default: tomorrow 8am-12pm ET
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(8, 0, 0, 0);
        const end = new Date(tomorrow.getTime() + 4 * 60 * 60 * 1000);
        timeslot = {
            type: 'arrival_window',
            start: tomorrow.toISOString(),
            end: end.toISOString(),
        };
    }

    const payload = {
        territory_id: territoryId,
        timeslot,
        customer: {
            name: [lead.FirstName, lead.LastName].filter(Boolean).join(' ') || 'Unknown',
            phone: lead.Phone || undefined,
            email: lead.Email || undefined,
        },
        address: {
            line1: lead.Address || undefined,
            line2: lead.Unit || undefined,
            city: lead.City || undefined,
            state: lead.State || undefined,
            postal_code: lead.PostalCode || undefined,
            country: lead.Country || 'US',
        },
        services: [
            {
                custom_service: {
                    name: lead.JobType || 'General Service',
                    description: lead.LeadNotes || lead.Comments || '',
                    price: 0,
                    duration: 60,
                    taxable: false,
                },
            },
        ],
    };

    // Strip undefined values from nested objects
    for (const key of ['customer', 'address']) {
        for (const k of Object.keys(payload[key])) {
            if (payload[key][k] === undefined) delete payload[key][k];
        }
    }

    console.log('[Zenbooker] Creating job:', JSON.stringify(payload, null, 2));

    const res = await retryRequest(() => getClient().post('/jobs', payload));
    console.log('[Zenbooker] Job created:', res.data.job_id);
    return res.data;
}

// ─── Scheduling methods (for custom booking flow) ─────────────────────────────

/**
 * Check if a postal code is in a service area.
 * Returns { in_service_area, service_territory, customer_location }
 */
async function checkServiceArea(postalCode) {
    const res = await retryRequest(() =>
        getClient().get('/scheduling/service_area_check', { params: { postal_code: postalCode } })
    );
    return res.data;
}

/**
 * Get available timeslots for a territory.
 * @param {Object} params - { territory, date, duration, days?, lat?, lng? }
 */
async function getTimeslots(params) {
    const res = await retryRequest(() =>
        getClient().get('/scheduling/timeslots', { params })
    );
    return res.data;
}

/**
 * Get service catalog.
 */
async function getServices() {
    const res = await retryRequest(() =>
        getClient().get('/services', { params: { is_visible: true } })
    );
    return res.data;
}

/**
 * Create a job with a direct payload (from booking dialog).
 * Unlike createJobFromLead, this takes a pre-built Zenbooker payload.
 */
async function createJob(payload) {
    console.log('[Zenbooker] Creating job (direct):', JSON.stringify(payload, null, 2));
    const res = await retryRequest(() => getClient().post('/jobs', payload));
    console.log('[Zenbooker] Job created:', res.data.job_id);
    return res.data;
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function retryRequest(requestFn, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await requestFn();
        } catch (error) {
            lastError = error;
            // Don't retry 4xx (except 429)
            if (error.response?.status >= 400 && error.response?.status < 500 && error.response.status !== 429) {
                throw error;
            }
            if (attempt < maxRetries - 1) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
                console.log(`[Zenbooker] Retry attempt ${attempt + 1} after ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

module.exports = {
    createJobFromLead,
    createJob,
    getTerritories,
    findTerritoryByPostalCode,
    checkServiceArea,
    getTimeslots,
    getServices,
};

