/**
 * slotEngineService.js — builds a live snapshot (new job geo, technician roster +
 * base locations, scheduled jobs) and proxies it to the standalone slot engine
 * (SLOT-ENGINE-001 Phase 2). The engine is stateless: we push everything it needs
 * and it returns ranked arrival time-frame + technician recommendations.
 *
 * SAFE-FAILURE: any engine fault (non-2xx, network error, timeout, or missing
 * SLOT_ENGINE_URL) degrades to an empty, clearly-flagged result — never a throw,
 * never a fabricated slot.
 */
const db = require('../db/connection');
const queries = require('../db/technicianBaseLocationQueries');
const zenbookerClient = require('./zenbookerClient');
const googlePlacesService = require('./googlePlacesService');
const jobsService = require('./jobsService');
const scheduleService = require('./scheduleService');
const slotEngineSettingsService = require('./slotEngineSettingsService');
const { dateInTZ } = require('../utils/companyTime');

const DEFAULT_TZ = 'America/New_York';
const DEFAULT_DURATION_MINUTES = 75;
const ENGINE_TIMEOUT_MS = 4000;

function isFiniteNum(n) {
    return typeof n === 'number' && Number.isFinite(n);
}

// ─── Company-timezone helpers (kept local + small so they're testable) ──────────

/** 'YYYY-MM-DD' for `d` in the company timezone (en-CA gives ISO-ordered date). */
function localDate(d, tz) {
    return new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
}

/** 'HH:MM' (24h) for `d` in the company timezone. */
function localHHMM(d, tz) {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(d));
}

/** Whole minutes between two ISO/date values (>= 0), or null if not computable. */
function minutesBetween(start, end) {
    if (!start || !end) return null;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    return Math.round(ms / 60000);
}

/** today + n days as 'YYYY-MM-DD' in the company timezone. */
function addDaysLocal(baseDateStr, n) {
    const base = new Date(`${baseDateStr}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + n);
    return base.toISOString().slice(0, 10);
}

/**
 * Combine a wall-clock date + time in company `tz` into a UTC ISO string.
 * The inverse of localDate/localHHMM. Thin adapter over the canonical
 * companyTime.dateInTZ — the single source of the DST offset math (itself
 * mirrored from frontend companyTime.ts). DST-aware: an EDT date resolves
 * UTC−4, an EST date UTC−5.
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} hhmm    'HH:MM' (24h)
 * @param {string} tz      IANA timezone name
 * @returns {string} ISO 8601 UTC string, e.g. '2026-07-08T14:00:00.000Z'
 */
function tzCombine(dateStr, hhmm, tz) {
    const [y, mo, d] = String(dateStr).split('-').map(Number);
    const [hh, mm] = String(hhmm).split(':').map(Number);
    return dateInTZ(y, mo, d, hh, mm, tz).toISOString();
}

async function resolveTimezone(companyId) {
    try {
        const settings = await scheduleService.getDispatchSettings(companyId);
        return settings?.timezone || DEFAULT_TZ;
    } catch {
        return DEFAULT_TZ;
    }
}

// ─── Snapshot pieces ────────────────────────────────────────────────────────────

async function resolveNewJobPoint(newJob) {
    if (isFiniteNum(newJob.lat) && isFiniteNum(newJob.lng)) {
        return { lat: newJob.lat, lng: newJob.lng };
    }
    if (newJob.address && String(newJob.address).trim()) {
        const g = await googlePlacesService.geocodeAddress(newJob.address);
        if (g.status !== 'failed' && isFiniteNum(g.lat) && isFiniteNum(g.lng)) {
            return { lat: g.lat, lng: g.lng };
        }
    }
    const err = new Error('Provide a location (lat/lng or a geocodable address) for the new job.');
    err.httpStatus = 422;
    err.code = 'NEW_JOB_LOCATION_REQUIRED';
    throw err;
}

async function buildTechnicians(companyId) {
    const stored = await queries.listByCompany(companyId);
    const byId = new Map(stored.map(r => [String(r.tech_id), r]));

    let members = [];
    try {
        members = await zenbookerClient.getTeamMembers(
            { service_provider: true, deactivated: false },
            companyId
        );
    } catch (err) {
        console.warn('[SlotEngine] roster unavailable:', err.message);
        members = [];
    }

    return (Array.isArray(members) ? members : []).map(m => {
        const techId = String(m.id);
        const base = byId.get(techId);
        const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.name || techId;
        return {
            id: techId,
            name,
            active: m.deactivated === true ? false : true,
            base: base && isFiniteNum(base.lat) && isFiniteNum(base.lng)
                ? { lat: base.lat, lng: base.lng }
                : null,
        };
    });
}

async function buildScheduledJobs(companyId, startDate, endDate, tz, excludeJobId) {
    const jobs = await jobsService.listJobs({ companyId, startDate, endDate, limit: 500 });
    const list = Array.isArray(jobs) ? jobs : (jobs?.jobs || jobs?.data || []);
    const out = [];
    for (const j of list) {
        // Reschedule: drop the job being moved so its current slot isn't treated as occupied.
        if (excludeJobId != null && String(j.id) === String(excludeJobId)) continue;
        const lat = j.lat;
        const lng = j.lng;
        if (!isFiniteNum(lat) || !isFiniteNum(lng)) continue;
        if (j.blanc_status === 'Canceled' || j.blanc_status === 'Visit completed') continue;
        if (!j.start_date) continue;

        const endRef = j.end_date || j.start_date;
        out.push({
            id: String(j.id),
            date: localDate(j.start_date, tz),
            status: 'scheduled',
            job_type: j.job_type || 'unknown',
            window_start: localHHMM(j.start_date, tz),
            window_end: localHHMM(endRef, tz),
            lat,
            lng,
            duration_minutes: minutesBetween(j.start_date, j.end_date) || DEFAULT_DURATION_MINUTES,
            assigned_technicians: (Array.isArray(j.assigned_techs) ? j.assigned_techs : [])
                .map(t => String(t.id))
                .filter(id => id && id !== 'undefined' && id !== 'null'),
        });
    }

    // VAPI-SLOT-ENGINE-001 (FR-5, Decision A): append OPEN HELD LEADS as area
    // occupancy so a caller's held window isn't re-offered near the same place.
    // Filter mirrors the leads-in-Schedule UNION verbatim (scheduleQueries.js:136)
    // — case-INSENSITIVE terminal-status (LOWER) so a capitalized 'Converted'/'Lost'
    // (as written by convertLead/markLost) actually drops the hold. Company-scoped,
    // date-windowed, coords-required (a coord-less hold can't block routing — the
    // engine's own skip-guard would drop it anyway; accepted v1). Same occupancy
    // shape as a job (reusing localDate/localHHMM/minutesBetween); assigned_technicians:[]
    // = the engine treats it as an area block for ANY tech, not one tech's route.
    const leadsSql = `
        SELECT id, lead_date_time, lead_end_date_time, latitude, longitude, job_type
        FROM leads
        WHERE company_id = $1
          AND LOWER(status) NOT IN ('converted','lost','spam')
          AND lead_date_time IS NOT NULL
          AND latitude IS NOT NULL AND longitude IS NOT NULL
          AND lead_date_time >= ($2::date::timestamp AT TIME ZONE $4)
          AND lead_date_time <  (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE $4)
    `;
    const { rows: heldLeads } = await db.query(leadsSql, [companyId, startDate, endDate, tz]);
    for (const l of heldLeads) {
        out.push({
            id: `lead:${l.id}`,
            date: localDate(l.lead_date_time, tz),
            status: 'scheduled',
            job_type: l.job_type || 'unknown',
            window_start: localHHMM(l.lead_date_time, tz),
            window_end: localHHMM(l.lead_end_date_time || l.lead_date_time, tz),
            lat: Number(l.latitude),
            lng: Number(l.longitude),
            duration_minutes: minutesBetween(l.lead_date_time, l.lead_end_date_time) || DEFAULT_DURATION_MINUTES,
            assigned_technicians: [],
        });
    }

    return out;
}

// ─── Public entrypoint ──────────────────────────────────────────────────────────

/**
 * Build the snapshot and proxy it to the slot engine.
 * @param {string} companyId
 * @param {{ new_job: { lat?, lng?, address?, job_type?, duration_minutes?, territory_id?, earliest_allowed_date?, latest_allowed_date? } }} input
 * @returns {{ recommendations, summary, engine_status: 'ok' | 'unavailable' }}
 */
async function getRecommendations(companyId, input = {}) {
    const newJob = input.new_job || {};
    const tz = await resolveTimezone(companyId);

    // 1. New-job point (may throw NEW_JOB_LOCATION_REQUIRED — a real client error).
    const point = await resolveNewJobPoint(newJob);

    // Per-company recommendation settings (never throws; safe-fails to DEFAULTS).
    const settings = await slotEngineSettingsService.resolve(companyId);

    // Horizon: explicit window, else today..today + settings.horizon_days (company-local).
    const today = localDate(new Date(), tz);
    const earliest = newJob.earliest_allowed_date || today;
    const latest = newJob.latest_allowed_date || addDaysLocal(today, settings.horizon_days);

    // 2 + 3. Technicians and scheduled jobs.
    const [technicians, scheduledJobs] = await Promise.all([
        buildTechnicians(companyId),
        buildScheduledJobs(companyId, earliest, latest, tz, newJob.exclude_job_id),
    ]);

    // Base coverage — surfaced to the UI so the dispatcher knows recommendations may
    // be incomplete when some technicians have no base set (the engine can't place a
    // based-less technician on a day they have no other jobs).
    const activeTechs = technicians.filter(t => t.active);
    const coverage = {
        technicians_total: activeTechs.length,
        technicians_with_base: activeTechs.filter(t => t.base).length,
    };

    // 4. Engine request body (per slot-engine/README.md contract).
    const requestId = `alb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const body = {
        request_id: requestId,
        requested_at: new Date().toISOString(),
        new_request: {
            id: 'new',
            lat: point.lat,
            lng: point.lng,
            job_type: newJob.job_type || 'unknown',
            duration_minutes: isFiniteNum(newJob.duration_minutes) ? newJob.duration_minutes : null,
            required_technician_count: 1,
            earliest_allowed_date: earliest,
            latest_allowed_date: latest,
        },
        technicians,
        scheduled_jobs: scheduledJobs,
        // Per-company tuning (distance/overlap/buffer/horizon/top_n) + the fixed
        // empty-day + utilization values, mapped to the engine's config shape.
        config_override: slotEngineSettingsService.buildConfigOverride(settings),
    };

    // 5. Proxy with a short timeout. Any engine fault → safe-failure.
    const baseUrl = process.env.SLOT_ENGINE_URL;
    if (!baseUrl) {
        return { recommendations: [], summary: null, engine_status: 'unavailable', coverage };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl}/api/v1/slot-recommendations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!res.ok) {
            console.warn('[SlotEngine] non-2xx response:', res.status);
            return { recommendations: [], summary: null, engine_status: 'unavailable', coverage };
        }
        const json = await res.json();
        // 6. Success.
        return {
            recommendations: Array.isArray(json?.recommendations) ? json.recommendations : [],
            summary: json?.summary ?? null,
            engine_status: 'ok',
            coverage,
        };
    } catch (err) {
        console.warn('[SlotEngine] engine unavailable:', err.message);
        return { recommendations: [], summary: null, engine_status: 'unavailable', coverage };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    getRecommendations,
    // VAPI-SLOT-ENGINE-001: wall-clock→ISO combine + company-tz resolve, imported
    // by the vapi-tools recommendSlots/createLead slot-persist path (T2).
    tzCombine,
    resolveTimezone,
    // exported for unit tests
    _localDate: localDate,
    _localHHMM: localHHMM,
    _minutesBetween: minutesBetween,
    _buildScheduledJobs: buildScheduledJobs,
    _buildTechnicians: buildTechnicians,
};
